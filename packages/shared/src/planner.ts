import type { TextFn } from './programText.ts';
import { toMinutes } from './rhythm.ts';
import { shiftDate, zonedDateKey, zonedInstant, zonedParts } from './timezone.ts';
import type { ISODate } from './types/common.ts';
import type {
  McpAuthMode,
  McpFixedCall,
  McpOAuthConfig,
  McpServerConfig,
  McpServerKind,
  McpToolInfo,
  PlannerDayPlan,
  PlannerDeadline,
  PlannerEvent,
  PlannerItem,
  PlannerMail,
  PlannerPriority,
  PlannerSettings,
  PlannerTodo,
  PlannerWeekDay,
  PlannerWeekPlan,
} from './types/planner.ts';

/**
 * 日程系统（设计文档 §9.15）：协议（计划的 JSON 怎么读、AI 要查什么怎么读）、默认值和变量。
 * 提示词在预设文件 apps/web/src/presets/planner.json 里；MCP 客户端和排计划的流程在 @app/ai（agents/planner.ts）。
 */

export const DEFAULT_PLANNER: PlannerSettings = {
  enabled: false,
  servers: [],
  characterId: null,
  note: '',
  runAt: '04:00',
  weekStart: 1,
  weekRefresh: 'start',
  maxRounds: 3,
  maxCalls: 6,
  resultChars: 6000,
  inChat: true,
};

/** 设置里各项的范围（界面和读取共用） */
export const PLANNER_LIMITS = {
  maxRounds: [0, 6],
  maxCalls: [1, 12],
  resultChars: [500, 30000],
} as const;

export const MCP_KIND_LABEL: Record<McpServerKind, { label: string; icon: string }> = {
  mail: { label: '邮箱', icon: 'i-lucide-mail' },
  calendar: { label: '日程', icon: 'i-lucide-calendar-days' },
  other: { label: '其他', icon: 'i-lucide-plug' },
};

export const MCP_AUTH_LABEL: Record<McpAuthMode, string> = { none: '不用登录', header: '请求头（Token / API Key）', oauth: 'OAuth 登录' };

export const PRIORITY_LABEL: Record<PlannerPriority, string> = { high: '要紧', mid: '一般', low: '不急' };

/**
 * 新加服务器时可以先填上的（都能改）：Google 官方的 Gmail、Google 日历 MCP（OAuth，要自己在 Google Cloud 建 Client ID），
 * 别的日程软件（Todoist、Notion、滴答清单……）填它们自己的 MCP 地址。
 * 这里只是起点：地址、权限、额外参数在服务器设置里都能改。
 */
export interface McpTemplate {
  key: string;
  name: string;
  kind: McpServerKind;
  url: string;
  auth: McpAuthMode;
  scope?: string;
  extraParams?: string;
  hint: string;
}
export const MCP_TEMPLATES: McpTemplate[] = [
  {
    key: 'gmail',
    name: 'Gmail',
    kind: 'mail',
    url: 'https://gmailmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    extraParams: 'access_type=offline&prompt=consent',
    hint: 'Google 官方的 Gmail MCP（预览版）：在 Google Cloud 里启用 Gmail MCP API，建一个"Web 应用"的 OAuth Client，把下面的回调地址加进去，填上 Client ID 和 Secret',
  },
  {
    key: 'gcal',
    name: 'Google 日历',
    kind: 'calendar',
    url: 'https://calendarmcp.googleapis.com/mcp/v1',
    auth: 'oauth',
    scope: 'https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    extraParams: 'access_type=offline&prompt=consent',
    hint: 'Google 官方的日历 MCP：在 Google Cloud 里启用 Calendar MCP API，可以和 Gmail 用同一个 OAuth Client',
  },
  { key: 'calendar', name: '日程', kind: 'calendar', url: '', auth: 'oauth', hint: '填日程软件的 MCP 地址（Streamable HTTP）；支持自动注册的（Notion、Todoist 这类）Client ID 可以留空' },
  { key: 'other', name: '其他', kind: 'other', url: '', auth: 'none', hint: '任意 MCP 服务器（Streamable HTTP）' },
];

/**
 * 工具参数里能写的变量（每次都查的参数、AI 查的时候也知道这些值）：都按你所在的时区算，
 * 带"At"的是带时区偏移的 ISO 时间（日历 API 常要），不带的是日期
 */
export const PLANNER_MACROS: Record<string, string> = {
  now: '现在（ISO 时间）',
  today: '今天（YYYY-MM-DD）',
  yesterday: '昨天',
  tomorrow: '明天',
  todayAt: '今天 0 点（ISO 时间）',
  tomorrowAt: '明天 0 点（ISO 时间）',
  weekStart: '这周第一天',
  weekEnd: '这周最后一天',
  weekStartAt: '这周第一天 0 点（ISO 时间）',
  weekEndAt: '下周第一天 0 点（ISO 时间）',
  lastRunAt: '上次排计划的时间（ISO 时间；第一次排是 24 小时前）',
  lastRunDate: '上次排计划的日期',
  timezone: '时区（IANA）',
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max = 400): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');
const intIn = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeTool(raw: unknown): McpToolInfo | null {
  if (!isObj(raw)) return null;
  const name = str(raw.name, 120);
  if (!name) return null;
  return {
    name,
    ...(str(raw.title, 120) ? { title: str(raw.title, 120) } : {}),
    description: str(raw.description, 2000),
    inputSchema: isObj(raw.inputSchema) ? raw.inputSchema : {},
    ...(raw.readOnly === true ? { readOnly: true } : {}),
    ...(raw.destructive === true ? { destructive: true } : {}),
  };
}

function normalizeOAuth(raw: unknown): McpOAuthConfig | null {
  if (!isObj(raw)) return null;
  const authorizationEndpoint = str(raw.authorizationEndpoint, 500);
  const tokenEndpoint = str(raw.tokenEndpoint, 500);
  return {
    ...(str(raw.issuer, 500) ? { issuer: str(raw.issuer, 500) } : {}),
    authorizationEndpoint,
    tokenEndpoint,
    ...(str(raw.registrationEndpoint, 500) ? { registrationEndpoint: str(raw.registrationEndpoint, 500) } : {}),
    clientId: str(raw.clientId, 500),
    ...(raw.registered === true ? { registered: true } : {}),
    scope: str(raw.scope, 2000),
    extraParams: str(raw.extraParams, 1000),
    resource: raw.resource !== false,
    authMethod: raw.authMethod === 'basic' || raw.authMethod === 'none' ? raw.authMethod : 'post',
  };
}

export function normalizeMcpServer(raw: unknown, fallbackId: string): McpServerConfig | null {
  if (!isObj(raw)) return null;
  const kind: McpServerKind = raw.kind === 'mail' || raw.kind === 'calendar' ? raw.kind : 'other';
  const auth: McpAuthMode = raw.auth === 'header' || raw.auth === 'oauth' ? raw.auth : 'none';
  const tools = (Array.isArray(raw.tools) ? raw.tools : []).map(normalizeTool).filter((t): t is McpToolInfo => !!t).slice(0, 200);
  const fixed = (Array.isArray(raw.fixed) ? raw.fixed : [])
    .filter(isObj)
    .map((f, i): McpFixedCall => ({ id: str(f.id, 60) || `fx-${i}`, tool: str(f.tool, 120), args: typeof f.args === 'string' ? f.args.slice(0, 4000) : '{}' }))
    .slice(0, 20);
  const a = isObj(raw.authorized) ? raw.authorized : null;
  const authorized: McpServerConfig['authorized'] = a && (a.via === 'hub' || a.via === 'device') && typeof a.at === 'number' ? { via: a.via, at: a.at } : null;
  return {
    id: str(raw.id, 60) || fallbackId,
    name: str(raw.name, 40) || MCP_KIND_LABEL[kind].label,
    kind,
    enabled: raw.enabled !== false,
    url: str(raw.url, 1000),
    auth,
    headerName: str(raw.headerName, 100) || 'Authorization',
    oauth: normalizeOAuth(raw.oauth),
    authorized,
    tools,
    toolsAt: typeof raw.toolsAt === 'number' ? raw.toolsAt : null,
    allowed: (Array.isArray(raw.allowed) ? raw.allowed : []).filter((x): x is string => typeof x === 'string').slice(0, 200),
    fixed,
  };
}

export function normalizePlanner(raw: unknown): PlannerSettings {
  const d = DEFAULT_PLANNER;
  if (!isObj(raw)) return JSON.parse(JSON.stringify(d)) as PlannerSettings;
  const runAt = typeof raw.runAt === 'string' && HHMM_RE.test(raw.runAt) ? raw.runAt : d.runAt;
  return {
    enabled: raw.enabled === true,
    servers: (Array.isArray(raw.servers) ? raw.servers : []).map((s, i) => normalizeMcpServer(s, `mcp-${i}`)).filter((s): s is McpServerConfig => !!s).slice(0, 12),
    characterId: typeof raw.characterId === 'string' && raw.characterId ? raw.characterId : null,
    note: str(raw.note, 2000),
    runAt,
    weekStart: intIn(raw.weekStart, 0, 6, d.weekStart),
    weekRefresh: raw.weekRefresh === 'daily' ? 'daily' : 'start',
    maxRounds: intIn(raw.maxRounds, PLANNER_LIMITS.maxRounds[0], PLANNER_LIMITS.maxRounds[1], d.maxRounds),
    maxCalls: intIn(raw.maxCalls, PLANNER_LIMITS.maxCalls[0], PLANNER_LIMITS.maxCalls[1], d.maxCalls),
    resultChars: intIn(raw.resultChars, PLANNER_LIMITS.resultChars[0], PLANNER_LIMITS.resultChars[1], d.resultChars),
    inChat: raw.inChat !== false,
  };
}

// —— 日子怎么算 ——

/**
 * 现在算哪一天的计划：到了每天排的时间（runAt）就是今天，没到还是昨天（runAt 是 04:00 时同节律、家务日）
 */
export function plannerDate(at: number, timeZone: string, runAt: string): ISODate {
  const date = zonedDateKey(at, timeZone);
  const p = zonedParts(at, timeZone);
  const start = toMinutes(runAt) ?? 0;
  return p.hour * 60 + p.minute < start ? shiftDate(date, -1) : date;
}

/** 这一天所在的那周从哪天开始（weekStart：0 周日 … 6 周六） */
export function weekStartOn(date: ISODate, weekStart: number): ISODate {
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  return shiftDate(date, -((wd - weekStart + 7) % 7));
}

/** 带时区偏移的 ISO 时间（"2026-11-15T04:00:00+08:00"） */
export function isoInZone(at: number, timeZone: string): string {
  const p = zonedParts(at, timeZone);
  const offset = Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000) / 60_000);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** 这一次的变量值（PLANNER_MACROS） */
export function plannerVars(input: { at: number; timeZone: string; date: ISODate; weekStart: number; lastRunAt?: number | null }): Record<string, string> {
  const { at, timeZone: tz, date } = input;
  const ws = weekStartOn(date, input.weekStart);
  const last = input.lastRunAt && input.lastRunAt < at ? input.lastRunAt : at - 86_400_000;
  const midnight = (d: ISODate) => isoInZone(zonedInstant(d, 0, tz), tz);
  return {
    now: isoInZone(at, tz),
    today: date,
    yesterday: shiftDate(date, -1),
    tomorrow: shiftDate(date, 1),
    todayAt: midnight(date),
    tomorrowAt: midnight(shiftDate(date, 1)),
    weekStart: ws,
    weekEnd: shiftDate(ws, 6),
    weekStartAt: midnight(ws),
    weekEndAt: midnight(shiftDate(ws, 7)),
    lastRunAt: isoInZone(last, tz),
    lastRunDate: zonedDateKey(last, tz),
    timezone: tz,
  };
}

/** 把 {{变量}} 换成这一次的值（不认识的原样留着） */
export function expandPlannerMacros(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, k: string) => vars[k] ?? all);
}

/** 读"每次都查"的参数：先换变量再读 JSON；不是对象时报错 */
export function fixedCallArgs(call: Pick<McpFixedCall, 'args'>, vars: Record<string, string>): Record<string, unknown> {
  const text = expandPlannerMacros(call.args.trim() || '{}', vars);
  const v = JSON.parse(text) as unknown;
  if (!isObj(v)) throw new Error('参数要是一个 JSON 对象');
  return v;
}

/** 按参数的 JSON Schema 填一份"每次都查"的参数草稿：必填的参数按类型给个空值，像日期时间的给变量 */
export function argsDraft(schema: unknown): string {
  const s = isObj(schema) ? schema : {};
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : []);
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(props)) {
    if (!required.has(k)) continue;
    const p = isObj(raw) ? raw : {};
    const type = Array.isArray(p.type) ? p.type[0] : p.type;
    const hint = `${k} ${str(p.description, 200)} ${str(p.format, 40)}`.toLowerCase();
    if (p.default !== undefined) out[k] = p.default;
    else if (type === 'number' || type === 'integer') out[k] = 10;
    else if (type === 'boolean') out[k] = false;
    else if (type === 'array') out[k] = [];
    else if (type === 'object') out[k] = {};
    else if (/date-time|time_?min|start|from|after|since/.test(hint)) out[k] = '{{todayAt}}';
    else if (/time_?max|end|until|before|to\b/.test(hint)) out[k] = '{{weekEndAt}}';
    else out[k] = '';
  }
  return JSON.stringify(out, null, 2);
}

/** 工具的参数写成一行（给模型看）："query: string（搜索条件）*必填" */
export function toolParamsText(schema: unknown, t: TextFn, max = 600): string {
  const s = isObj(schema) ? schema : {};
  const props = isObj(s.properties) ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? s.required.filter((x): x is string => typeof x === 'string') : []);
  const parts = Object.entries(props).map(([k, raw]) => {
    const p = isObj(raw) ? raw : {};
    const type = Array.isArray(p.type) ? p.type.join('|') : str(p.type, 40) || (Array.isArray(p.enum) ? 'enum' : 'any');
    const values = Array.isArray(p.enum) ? p.enum.slice(0, 8).map((x) => JSON.stringify(x)) : null;
    return t('planner.param', { name: k, type, desc: str(p.description, 160), values, required: required.has(k) });
  });
  const text = parts.length ? t('planner.params', { parts }) : t('planner.params.none');
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// —— AI 要查什么（「计划」预设 planner-gather 的输出）——

export interface PlannerCall {
  server: string;
  tool: string;
  args: Record<string, unknown>;
  why: string;
}

/** 读"要查什么"：{"calls": [...], "done": bool}；不像样时返回 null（会让模型重写一次） */
export function parsePlannerGather(v: unknown): { calls: PlannerCall[]; done: boolean } | null {
  if (!isObj(v)) return null;
  const list = Array.isArray(v.calls) ? v.calls : [];
  const calls: PlannerCall[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const tool = str(raw.tool ?? raw.name, 120);
    if (!tool) continue;
    calls.push({ server: str(raw.server, 120), tool, args: isObj(raw.args) ? raw.args : isObj(raw.arguments) ? raw.arguments : {}, why: str(raw.why, 200) });
  }
  return { calls, done: v.done === true || !calls.length };
}

// —— 计划（「计划」预设 planner-week / planner-day 的输出）——

function lines(v: unknown, max = 12, each = 200): string[] {
  if (typeof v === 'string') return v.split(/\n+/).map((x) => x.replace(/^\s*(\d+[.、)]|[-•·])\s*/, '').trim().slice(0, each)).filter(Boolean).slice(0, max);
  return (Array.isArray(v) ? v : []).map((x) => str(x, each)).filter(Boolean).slice(0, max);
}

const WEEKDAY_WORDS: Record<string, number> = { 周日: 0, 周天: 0, 星期日: 0, 星期天: 0, 周一: 1, 星期一: 1, 周二: 2, 星期二: 2, 周三: 3, 星期三: 3, 周四: 4, 星期四: 4, 周五: 5, 星期五: 5, 周六: 6, 星期六: 6 };
function weekdayFrom(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v === 7 ? 0 : v >= 0 && v <= 6 ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t in WEEKDAY_WORDS) return WEEKDAY_WORDS[t] ?? null;
    if (/^\d$/.test(t)) return weekdayFrom(Number(t));
  }
  return null;
}

function itemFrom(v: unknown): PlannerItem | null {
  if (typeof v === 'string' && v.trim()) return { time: '', minutes: 0, title: v.trim().slice(0, 80), tag: '', note: '', source: '', fixed: false };
  if (!isObj(v)) return null;
  const title = str(v.title ?? v.name, 80);
  if (!title) return null;
  return {
    time: str(v.time ?? v.at, 20),
    minutes: intIn(v.minutes, 0, 24 * 60, 0),
    title,
    tag: str(v.tag ?? v.kind, 12),
    note: str(v.note, 240),
    source: str(v.source, 20),
    fixed: v.fixed === true,
  };
}

function mailFrom(v: unknown): PlannerMail | null {
  if (!isObj(v)) return null;
  const subject = str(v.subject ?? v.title, 120);
  const gist = str(v.gist ?? v.summary, 300);
  if (!subject && !gist) return null;
  return { from: str(v.from, 80), subject, gist, action: str(v.action, 200), due: str(v.due, 40), important: v.important === true };
}

function eventFrom(v: unknown): PlannerEvent | null {
  if (typeof v === 'string' && v.trim()) return { time: '', title: v.trim().slice(0, 100), where: '', note: '' };
  if (!isObj(v)) return null;
  const title = str(v.title ?? v.name, 100);
  if (!title) return null;
  return { time: str(v.time, 40), title, where: str(v.where ?? v.location, 80), note: str(v.note, 200) };
}

function todoFrom(v: unknown): PlannerTodo | null {
  if (typeof v === 'string' && v.trim()) return { title: v.trim().slice(0, 100), due: '', priority: 'mid', source: '' };
  if (!isObj(v)) return null;
  const title = str(v.title ?? v.name, 100);
  if (!title) return null;
  const p = str(v.priority, 10).toLowerCase();
  const priority: PlannerPriority = p === 'high' || p === '要紧' || p === '高' ? 'high' : p === 'low' || p === '不急' || p === '低' ? 'low' : 'mid';
  return { title, due: str(v.due, 40), priority, source: str(v.source, 20) };
}

function listOf<T>(v: unknown, read: (x: unknown) => T | null, max: number): T[] {
  return (Array.isArray(v) ? v : []).map(read).filter((x): x is T => !!x).slice(0, max);
}

/** 读「计划」写回来的今天的计划；不像样时返回 null */
export function parsePlannerDay(v: unknown): Omit<PlannerDayPlan, 'personaId' | 'date' | 'model' | 'at' | 'via'> | null {
  if (!isObj(v)) return null;
  const items = listOf(v.items ?? v.timeline, itemFrom, 40);
  const events = listOf(v.events, eventFrom, 30);
  const mail = listOf(v.mail ?? v.inbox, mailFrom, 30);
  const todos = listOf(v.todos, todoFrom, 30);
  const summary = str(v.summary, 400);
  if (!items.length && !todos.length && !summary) return null;
  return { summary, items, events, mail, todos, note: str(v.note ?? v.tips, 400) };
}

/** 读「计划」写回来的这周的计划；不像样时返回 null。没写星期几的按顺序从一周的第一天排 */
export function parsePlannerWeek(v: unknown, weekStart: ISODate): Omit<PlannerWeekPlan, 'personaId' | 'weekStart' | 'model' | 'at' | 'via'> | null {
  if (!isObj(v) || !Array.isArray(v.days)) return null;
  const first = new Date(`${weekStart}T12:00:00Z`).getUTCDay();
  const byDay = new Map<number, PlannerWeekDay>();
  v.days.forEach((raw, i) => {
    if (!isObj(raw)) return;
    const weekday = weekdayFrom(raw.weekday ?? raw.day) ?? (first + i) % 7;
    if (byDay.has(weekday)) return;
    const offset = (weekday - first + 7) % 7;
    byDay.set(weekday, { weekday, date: shiftDate(weekStart, offset), focus: str(raw.focus ?? raw.summary, 200), events: lines(raw.events, 10, 120), todos: lines(raw.todos, 10, 120) });
  });
  if (!byDay.size) return null;
  const days = Array.from({ length: 7 }, (_, i) => (first + i) % 7).map((wd, i) => byDay.get(wd) ?? { weekday: wd, date: shiftDate(weekStart, i), focus: '', events: [], todos: [] });
  const deadlines = (Array.isArray(v.deadlines) ? v.deadlines : [])
    .filter(isObj)
    .map((d): PlannerDeadline => ({ date: str(d.date ?? d.due, 40), title: str(d.title ?? d.name, 120), source: str(d.source, 20) }))
    .filter((d) => d.title)
    .slice(0, 20);
  return { focus: str(v.focus, 300), days, deadlines, goals: lines(v.goals, 10), tips: lines(v.tips, 8) };
}

// —— 写成文字（排今天时给模型看这周的、聊天里她知道你今天的安排、最近几天的完成情况）——

const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function plannerWeekText(plan: PlannerWeekPlan | null | undefined, t: TextFn, today?: ISODate): string {
  if (!plan) return '';
  const rows = plan.days.map((d) => {
    const parts = [d.focus, d.events.length ? t('planner.week.events', { items: d.events }) : '', d.todos.length ? t('planner.week.todos', { items: d.todos }) : ''].filter(Boolean);
    return t('planner.week.day', { weekday: WEEKDAY_NAMES[d.weekday], date: d.date.slice(5), parts, today: d.date === today });
  });
  return t('planner.week', {
    weekStart: plan.weekStart,
    focus: plan.focus,
    days: rows,
    deadlines: plan.deadlines.map((d) => t('planner.week.deadline', { date: d.date, title: d.title })),
    goals: plan.goals,
  });
}

/** 今天的计划写成几行；done：勾了的项（按下标） */
export function plannerDayText(plan: PlannerDayPlan | null | undefined, t: TextFn, done?: Set<number>): string {
  if (!plan) return '';
  return t('planner.day', {
    summary: plan.summary,
    items: plan.items.map((it, i) => t('planner.day.item', { label: [it.time, it.title].filter(Boolean).join(' '), minutes: it.minutes || null, done: !!done?.has(i) })),
    todos: plan.todos.map((x) => t('planner.day.todo', { title: x.title, due: x.due })),
  });
}
