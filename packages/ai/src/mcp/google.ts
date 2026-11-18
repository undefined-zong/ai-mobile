import type { McpServerConfig, McpToolInfo } from '@app/shared';
import type { PlannerSession } from '../agents/planner.ts';
import { McpCredentials, McpError } from './client.ts';

/** Google 的 MCP 仍需开发者预览资格；日程计划查邮件、查和改日历用已开放的 REST API，沿用同一份 OAuth。邮件只读。 */
const GOOGLE_SERVICES: Record<string, 'gmail' | 'calendar'> = {
  'https://gmailmcp.googleapis.com/mcp/v1': 'gmail',
  'https://calendarmcp.googleapis.com/mcp/v1': 'calendar',
};
const string = (description: string) => ({ type: 'string', description });
const page = {
  pageSize: { type: 'integer', description: '每页最多条数，默认 20' },
  pageToken: string('上一页返回的 nextPageToken；第一页不填'),
};
const calendar = { calendarId: string('日历 ID，默认 primary；list_calendars 可列出日历') };
const eventQuery = {
  ...calendar,
  ...page,
  startTime: string('开始时间，RFC3339，必须带时区偏移或 Z；默认现在'),
  endTime: string('结束时间，RFC3339，必须带时区偏移或 Z；默认开始时间后 7 天'),
  timeZone: string('返回日程使用的 IANA 时区，例如 America/Indiana/Indianapolis'),
  fullText: string('匹配日程标题、说明、地点或参加者的关键词'),
};
function tool(name: string, title: string, description: string, properties: Record<string, unknown>, required: string[] = [], write?: 'add' | 'change'): McpToolInfo {
  const mode = !write ? { readOnly: true } : write === 'change' ? { destructive: true } : {};
  return { name, title, description, ...mode, inputSchema: { type: 'object', properties, required } };
}
/** 建、改日程时日程的内容 */
const eventBody = {
  summary: string('标题'),
  description: string('说明'),
  location: string('地点'),
  start: string('开始时间，RFC3339（带时区偏移或 Z）；全天的写 YYYY-MM-DD'),
  end: string('结束时间，RFC3339（带时区偏移或 Z）；全天的写 YYYY-MM-DD（不含这一天）'),
  timeZone: string('IANA 时区，例如 America/Indiana/Indianapolis'),
};
const TOOLS: Record<'gmail' | 'calendar', McpToolInfo[]> = {
  gmail: [
    tool('search_threads', '搜索邮件会话', '按 Gmail 搜索语法查询会话，返回邮件摘要、发件人、主题和时间；需要正文时用 get_thread。', { ...page, query: string('Gmail 搜索语法，例如 newer_than:7d is:unread'), includeTrash: { type: 'boolean' } }),
    tool('get_thread', '读取邮件会话', '读取指定会话内的邮件和正文。', { threadId: string('search_threads 返回的会话 ID') }, ['threadId']),
    tool('get_message', '读取邮件', '读取一封邮件及其正文。', { messageId: string('邮件 ID') }, ['messageId']),
    tool('list_drafts', '列出草稿', '查询草稿，返回草稿 ID 和邮件 ID；用 get_draft 读取内容。', { ...page, query: string('Gmail 搜索语法') }),
    tool('get_draft', '读取草稿', '读取一份已有草稿，不修改或发送。', { draftId: string('草稿 ID') }, ['draftId']),
    tool('list_labels', '列出邮件标签', '列出 Gmail 的系统标签和自定义标签。', {}),
  ],
  calendar: [
    tool('list_events', '列出日程', '读取指定时间段的日程，包含重复日程的每次安排，按开始时间排序。', eventQuery),
    tool('get_event', '读取日程', '读取一个日程的详情。', { ...calendar, eventId: string('日程 ID') }, ['eventId']),
    tool('list_calendars', '列出日历', '列出当前账户可见的日历。', page),
    tool('search_events', '搜索日程', '在指定日历中按关键词搜索日程；默认 primary，未指定时间时搜索全部时间。', { ...eventQuery, query: string('匹配日程的关键词') }, ['query']),
    tool('create_event', '新建日程', '在指定日历里新建一个日程。', { ...calendar, ...eventBody }, ['summary', 'start', 'end'], 'add'),
    tool('update_event', '修改日程', '修改一个日程：只写要改的字段。', { ...calendar, eventId: string('日程 ID'), ...eventBody }, ['eventId'], 'change'),
    tool('delete_event', '删除日程', '删除一个日程。', { ...calendar, eventId: string('日程 ID') }, ['eventId'], 'change'),
  ],
};

interface MailPart {
  mimeType?: string;
  body?: { data?: string };
  headers?: { name: string; value: string }[];
  parts?: MailPart[];
}
interface MailMessage {
  id: string;
  threadId: string;
  snippet?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: MailPart;
}
interface MailThread { id: string; snippet?: string; messages?: MailMessage[] }

function bodyText(part: MailPart, mime: string): string {
  const own = part.mimeType === mime && part.body?.data
    ? new TextDecoder().decode(Uint8Array.from(atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))
    : '';
  return [own, ...(part.parts ?? []).map((p) => bodyText(p, mime))].filter(Boolean).join('\n');
}
function mail(message: MailMessage) {
  const header = (name: string) => message.payload?.headers?.find((h) => h.name.toLowerCase() === name)?.value;
  const plain = message.payload ? bodyText(message.payload, 'text/plain') : '';
  const html = !plain && message.payload ? bodyText(message.payload, 'text/html') : '';
  return {
    id: message.id, threadId: message.threadId, subject: header('subject'), sender: header('from'),
    to: header('to'), date: header('date'), snippet: message.snippet, labelIds: message.labelIds,
    ...(plain ? { plaintextBody: plain } : html ? { htmlBody: html } : {}),
  };
}

/** 建、改日程的请求体：只带写了的字段；只写日期的是全天日程 */
function eventOf(args: Record<string, unknown>): Record<string, unknown> {
  const when = (v: unknown) => {
    if (typeof v !== 'string' || !v.trim()) return undefined;
    const t = v.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(t) ? { date: t } : { dateTime: t, ...(typeof args.timeZone === 'string' && args.timeZone ? { timeZone: args.timeZone } : {}) };
  };
  const out: Record<string, unknown> = {};
  for (const k of ['summary', 'description', 'location'] as const) if (typeof args[k] === 'string') out[k] = args[k];
  const start = when(args.start);
  const end = when(args.end);
  if (start) out.start = start;
  if (end) out.end = end;
  return out;
}

/** 只匹配内置 Google 地址，其它 MCP 服务器仍走 Streamable HTTP。 */
export function openGoogleSession(
  server: McpServerConfig,
  url: string,
  credentials: McpCredentials | undefined,
  opts: { fetch?: typeof fetch; signal?: AbortSignal },
): PlannerSession | null {
  const service = GOOGLE_SERVICES[url.replace(/\/$/, '')];
  if (!service) return null;
  const fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  const base = service === 'gmail' ? 'https://gmail.googleapis.com/gmail/v1/users/me/' : 'https://www.googleapis.com/calendar/v3/';

  async function send<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, params: Record<string, unknown> = {}, body?: unknown, retried = false): Promise<T> {
    const target = new URL(path, base);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') target.searchParams.set(key, String(value));
    const timeout = AbortSignal.timeout(60_000);
    const headers = { ...(await credentials?.headers()), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) };
    const response = await fetchImpl(target, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout });
    if (response.status === 401 && !retried && await credentials?.refresh().catch(() => false)) {
      await response.body?.cancel();
      return send<T>(method, path, params, body, true);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => null) as { error?: { message?: string } } | null;
      throw new McpError(response.status === 401 || response.status === 403 ? 'auth' : 'http', `Google API ${response.status}：${error?.error?.message ?? response.statusText}`, { status: response.status });
    }
    // 删除成功时没有内容
    return (response.status === 204 ? { ok: true } : await response.json()) as T;
  }
  const get = <T>(path: string, params: Record<string, unknown> = {}) => send<T>('GET', path, params);
  async function callGmail(name: string, args: Record<string, unknown>): Promise<unknown> {
    const list = { q: args.query, maxResults: args.pageSize ?? 20, pageToken: args.pageToken };
    switch (name) {
      case 'search_threads': {
        const result = await get<{ threads?: MailThread[]; nextPageToken?: string; resultSizeEstimate?: number }>('threads', { ...list, includeSpamTrash: args.includeTrash ?? false });
        const threads = await Promise.all((result.threads ?? []).map(async (t) => {
          const full = await get<MailThread>(`threads/${encodeURIComponent(t.id)}`, { format: 'metadata' });
          return { id: full.id, messages: full.messages?.map(mail) };
        }));
        return { ...result, threads };
      }
      case 'get_thread': {
        const result = await get<MailThread>(`threads/${encodeURIComponent(String(args.threadId))}`, { format: 'full' });
        return { id: result.id, messages: result.messages?.map(mail) };
      }
      case 'get_message': return mail(await get<MailMessage>(`messages/${encodeURIComponent(String(args.messageId))}`, { format: 'full' }));
      case 'list_drafts': return get('drafts', list);
      case 'get_draft': {
        const result = await get<{ id: string; message: MailMessage }>(`drafts/${encodeURIComponent(String(args.draftId))}`, { format: 'full' });
        return { id: result.id, message: mail(result.message) };
      }
      case 'list_labels': return get('labels');
      default: throw new McpError('protocol', `Gmail 工具不存在：${name}`);
    }
  }
  async function callCalendar(name: string, args: Record<string, unknown>): Promise<unknown> {
    const path = `calendars/${encodeURIComponent(String(args.calendarId || 'primary'))}/events`;
    const list = { maxResults: args.pageSize ?? 20, pageToken: args.pageToken };
    switch (name) {
      case 'list_calendars': return get('users/me/calendarList', list);
      case 'get_event': return get(`${path}/${encodeURIComponent(String(args.eventId))}`);
      case 'list_events':
      case 'search_events': {
        const start = args.startTime ?? (name === 'list_events' ? new Date().toISOString() : undefined);
        const end = args.endTime ?? (name === 'list_events' ? new Date(Date.parse(String(start)) + 7 * 86_400_000).toISOString() : undefined);
        return get(path, { ...list, timeMin: start, timeMax: end, timeZone: args.timeZone, q: args.query ?? args.fullText, singleEvents: true, orderBy: 'startTime' });
      }
      case 'create_event': return send('POST', path, {}, eventOf(args));
      case 'update_event': return send('PATCH', `${path}/${encodeURIComponent(String(args.eventId))}`, {}, eventOf(args));
      case 'delete_event': return send('DELETE', `${path}/${encodeURIComponent(String(args.eventId))}`);
      default: throw new McpError('protocol', `Google 日历工具不存在：${name}`);
    }
  }
  return {
    server,
    tools: TOOLS[service],
    call: async (name, args) => ({ text: JSON.stringify(await (service === 'gmail' ? callGmail(name, args) : callCalendar(name, args))), isError: false }),
    close: async () => {},
  };
}
