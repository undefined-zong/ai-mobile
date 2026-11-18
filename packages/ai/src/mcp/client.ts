import type { McpOAuthToken, McpServerSecret, McpToolInfo } from '@app/shared';
import { refreshOAuthToken } from './oauth.ts';

/**
 * MCP 客户端（Streamable HTTP，规范 2025-06-18 起的传输方式）：日程系统用它连你的 Gmail、日历这类 MCP 服务器，
 * 只用到 initialize、tools/list、tools/call。只用 fetch 和 ReadableStream：浏览器、Cloudflare Worker 都能跑
 * （浏览器直连时对方要允许跨域；连了云端时都由你的 Worker 去连）。
 * 不实现服务器反过来要的东西（sampling、elicitation……）：流里夹着的请求和通知都跳过。
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';

export type McpErrorCode = 'auth' | 'http' | 'network' | 'protocol' | 'timeout';

export class McpError extends Error {
  readonly code: McpErrorCode;
  readonly status?: number;
  /** 401 时服务器给的 WWW-Authenticate（OAuth 发现用） */
  readonly wwwAuthenticate?: string;
  constructor(code: McpErrorCode, message: string, extra: { status?: number; wwwAuthenticate?: string } = {}) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.status = extra.status;
    this.wwwAuthenticate = extra.wwwAuthenticate;
  }
}

type FetchLike = typeof fetch;

/**
 * 一台服务器的登录信息：请求头里的 Token，或者 OAuth 的 Access Token（快过期、遇到 401 时用 Refresh Token 换新的，
 * 换到的新 Token 交给 onUpdate 存起来——本机存进 secrets 表，云端加密存回 D1）
 */
export class McpCredentials {
  private secret: McpServerSecret;
  private refreshing: Promise<boolean> | null = null;
  constructor(
    secret: McpServerSecret,
    private readonly opts: { fetch?: FetchLike; onUpdate?: (secret: McpServerSecret) => Promise<void> | void } = {},
  ) {
    this.secret = secret;
  }

  get url(): string {
    return this.secret.url;
  }

  async headers(): Promise<Record<string, string>> {
    const o = this.secret.oauth;
    if (o?.refreshToken && o.expiresAt && o.expiresAt - Date.now() < 60_000) await this.refresh();
    const token = this.secret.oauth?.accessToken;
    return { ...(this.secret.headers ?? {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }

  /** 用 Refresh Token 换新的 Access Token；没有 Refresh Token 或换不到时返回 false */
  refresh(): Promise<boolean> {
    const o = this.secret.oauth;
    if (!o?.refreshToken) return Promise.resolve(false);
    this.refreshing ??= (async () => {
      try {
        const next: McpOAuthToken = await refreshOAuthToken(o, { fetch: this.opts.fetch });
        this.secret = { ...this.secret, oauth: next };
        await this.opts.onUpdate?.(this.secret);
        return true;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export interface McpCallResult {
  text: string;
  isError: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 工具返回的内容写成文字：文字原样，资源取文字，图片音频只写一句；没有文字时用 structuredContent */
export function toolResultText(result: unknown): McpCallResult {
  if (!isObj(result)) return { text: '', isError: false };
  const parts: string[] = [];
  for (const c of Array.isArray(result.content) ? result.content : []) {
    if (!isObj(c)) continue;
    if (c.type === 'text' && typeof c.text === 'string') parts.push(c.text);
    else if (c.type === 'resource' && isObj(c.resource)) parts.push(typeof c.resource.text === 'string' ? c.resource.text : `[资源] ${String(c.resource.uri ?? '')}`);
    else if (c.type === 'resource_link') parts.push(`[链接] ${String(c.name ?? '')} ${String(c.uri ?? '')}`.trim());
    else if (c.type === 'image') parts.push('[图片]');
    else if (c.type === 'audio') parts.push('[音频]');
  }
  if (!parts.length && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent));
  return { text: parts.join('\n'), isError: result.isError === true };
}

function withTimeout(ms: number, outer?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return outer && typeof AbortSignal.any === 'function' ? AbortSignal.any([t, outer]) : t;
}

export interface McpClientOptions {
  url: string;
  credentials?: McpCredentials;
  fetch?: FetchLike;
  /** 每个请求最多等多久（毫秒） */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class McpClient {
  private sessionId: string | null = null;
  private protocol = MCP_PROTOCOL_VERSION;
  private nextId = 1;
  private ready = false;
  private readonly fetchImpl: FetchLike;
  serverInfo: { name?: string; version?: string } = {};

  constructor(private readonly opts: McpClientOptions) {
    // 不绑 this 的 fetch 在 Worker / 浏览器里会报 Illegal invocation
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  private async post(body: unknown, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(this.ready ? { 'MCP-Protocol-Version': this.protocol } : {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
      ...((await this.opts.credentials?.headers()) ?? {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.opts.url, { method: 'POST', headers, body: JSON.stringify(body), signal: withTimeout(this.opts.timeoutMs ?? 60_000, this.opts.signal) });
    } catch (e) {
      if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new McpError('timeout', '连接 MCP 服务器超时');
      throw new McpError('network', `连不上 MCP 服务器（${e instanceof Error ? e.message : String(e)}）。浏览器直连时多半是对方不允许跨域，连上云端后由 Worker 去连`);
    }
    if (res.status === 401) {
      const www = res.headers.get('WWW-Authenticate') ?? undefined;
      if (!retried && (await this.opts.credentials?.refresh().catch(() => false))) return this.post(body, true);
      throw new McpError('auth', this.opts.credentials ? '登录过期或者没有权限（401），请重新授权' : '这台服务器要登录（401）', { status: 401, wwwAuthenticate: www });
    }
    if (res.status === 403) throw new McpError('auth', `没有权限（403）：${(await res.text().catch(() => '')).slice(0, 200)}`, { status: 403 });
    // 会话过期：重新握手一次
    if (res.status === 404 && this.sessionId && !retried) {
      this.sessionId = null;
      this.ready = false;
      await this.connect();
      return this.post(body, true);
    }
    if (!res.ok && res.status !== 202) throw new McpError('http', `MCP 服务器返回 HTTP ${res.status}：${(await res.text().catch(() => '')).slice(0, 300)}`, { status: res.status });
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;
    return res;
  }

  /** 发一个请求，等对应 id 的回复（JSON 或 SSE 流里的那一条） */
  private async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    const type = res.headers.get('Content-Type') ?? '';
    const msg = type.includes('text/event-stream') ? await readSse(res, id) : ((await res.json().catch(() => null)) as JsonRpcResponse | JsonRpcResponse[] | null);
    const one = Array.isArray(msg) ? msg.find((m) => m.id === id) : msg;
    if (!one) throw new McpError('protocol', `MCP 服务器没有回 ${method}`);
    if (one.error) throw new McpError('protocol', `${method} 出错：${one.error.message}（${one.error.code}）`);
    return one.result;
  }

  private async notify(method: string): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method });
    await res.body?.cancel().catch(() => undefined);
  }

  async connect(): Promise<void> {
    const result = (await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ai-mobile', version: '1.0.0' },
    })) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string } } | null;
    if (result?.protocolVersion) this.protocol = result.protocolVersion;
    this.serverInfo = result?.serverInfo ?? {};
    this.ready = true;
    await this.notify('notifications/initialized');
  }

  async listTools(): Promise<McpToolInfo[]> {
    if (!this.ready) await this.connect();
    const out: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = (await this.request('tools/list', cursor ? { cursor } : {})) as { tools?: unknown[]; nextCursor?: string } | null;
      for (const t of r?.tools ?? []) {
        if (!isObj(t) || typeof t.name !== 'string') continue;
        const ann = isObj(t.annotations) ? t.annotations : {};
        out.push({
          name: t.name,
          ...(typeof t.title === 'string' ? { title: t.title } : typeof ann.title === 'string' ? { title: ann.title } : {}),
          description: typeof t.description === 'string' ? t.description : '',
          inputSchema: isObj(t.inputSchema) ? t.inputSchema : {},
          ...(ann.readOnlyHint === true ? { readOnly: true } : {}),
          ...(ann.destructiveHint === true && ann.readOnlyHint !== true ? { destructive: true } : {}),
        });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!this.ready) await this.connect();
    return toolResultText(await this.request('tools/call', { name, arguments: args }));
  }

  /** 结束会话（尽量，失败不管） */
  async close(): Promise<void> {
    if (!this.sessionId) return;
    try {
      await this.fetchImpl(this.opts.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': this.sessionId, 'MCP-Protocol-Version': this.protocol, ...((await this.opts.credentials?.headers()) ?? {}) },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // 不支持关会话的服务器会自己过期
    }
    this.sessionId = null;
  }
}

/** 读 SSE 流，找到 id 对应的回复就停（流里先来的通知、服务器的请求跳过） */
async function readSse(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buffer = '';
  const take = (block: string): JsonRpcResponse | null => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data) return null;
    try {
      const msg = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
      const list = Array.isArray(msg) ? msg : [msg];
      return list.find((m) => m.id === id && (m.result !== undefined || m.error)) ?? null;
    } catch {
      return null;
    }
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      let cut: RegExpExecArray | null;
      while ((cut = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, cut.index);
        buffer = buffer.slice(cut.index + cut[0].length);
        const found = take(block);
        if (found) return found;
      }
      if (done) return take(buffer);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
