import type { HHMM, ISODate } from './common.ts';
import type { Preset } from './preset.ts';

/**
 * 日程系统（人设生活模块的第三套，设计文档 §9.15）：接上你的邮箱（Gmail MCP）和日程软件（日历 MCP，可以不接），
 * 每天到点（默认凌晨 4 点，你所在的时区）由云端的「日程计划」按「计划」预设看一遍新邮件、这周的日程、
 * 家务和健康计划，排出这周和今天的计划。PWA 关着也会跑；没连云端时在 App 里"立即生成"。
 * 设置挂在人设上（Persona.planner）；Token、Client Secret 不在这里，单独存在本机的 secrets 表（见 McpServerSecret）。
 */

/** MCP 服务器怎么登录：不用登录 / 请求头里带 Token（或 API Key）/ OAuth 登录（Gmail、Google 日历的官方 MCP 用这个） */
export type McpAuthMode = 'none' | 'header' | 'oauth';

/** 这台服务器是什么（只用来配图标和默认名字；AI 看的是工具本身的说明） */
export type McpServerKind = 'mail' | 'calendar' | 'other';

/** 列出来的一个工具（tools/list） */
export interface McpToolInfo {
  name: string;
  title?: string;
  description: string;
  /** 参数的 JSON Schema（原样） */
  inputSchema: unknown;
  /** 服务器标了只读（annotations.readOnlyHint） */
  readOnly?: boolean;
  /** 服务器标了会删改东西（annotations.destructiveHint） */
  destructive?: boolean;
}

/** 每次排计划前都先调的一个工具（参数是 JSON，可以写 {{today}} 这类变量，见 PLANNER_MACROS） */
export interface McpFixedCall {
  id: string;
  tool: string;
  args: string;
}

/** OAuth 登录的设置（不含 Token、Client Secret） */
export interface McpOAuthConfig {
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** 授权服务器支持自动注册时有 */
  registrationEndpoint?: string;
  /** 自己在 Google Cloud 之类的地方建的 Client ID；授权服务器支持自动注册时可以留空，登录时自动注册 */
  clientId: string;
  /** clientId 是 App 自动注册来的 */
  registered?: boolean;
  /** 要的权限（空格隔开） */
  scope: string;
  /** 额外的授权参数（"access_type=offline&prompt=consent"：Google 要这两个才给 refresh token） */
  extraParams: string;
  /** 带上 resource 参数（RFC 8707，MCP 规范要求；个别授权服务器不认时关掉） */
  resource: boolean;
  /** 换 Token 时 Client Secret 怎么带：表单里 / Basic 头 / 没有 Secret */
  authMethod: 'post' | 'basic' | 'none';
}

export interface McpServerConfig {
  id: string;
  name: string;
  kind: McpServerKind;
  enabled: boolean;
  /** MCP 地址（Streamable HTTP） */
  url: string;
  auth: McpAuthMode;
  /** auth = header 时的请求头名（值在本机 secrets 里） */
  headerName: string;
  oauth: McpOAuthConfig | null;
  /** 授权在哪：本机（没连云端时登录的）/ 云端（连了云端时 Token 只存在你的 Worker 里）；没授权为空 */
  authorized?: { via: 'device' | 'hub'; at: number } | null;
  /** 上次列出来的工具（选 AI 能用哪些、编辑"每次都查"用） */
  tools: McpToolInfo[];
  toolsAt: number | null;
  /** AI 能调的工具（默认全勾；邮箱只能勾只读的） */
  allowed: string[];
  /** 每次都先查的 */
  fixed: McpFixedCall[];
}

/** 这周的计划什么时候排：一周开始那天排一次 / 每天跟今天的一起重排 */
export type PlannerWeekRefresh = 'start' | 'daily';

export interface PlannerSettings {
  enabled: boolean;
  servers: McpServerConfig[];
  /** 谁帮你排（预设里的 {{char}}），可以不选 */
  characterId: string | null;
  /** 你的情况：上班上课的时间、这阵子的目标、排计划的偏好 */
  note: string;
  /** 每天几点排（你所在的时区） */
  runAt: HHMM;
  /** 一周从星期几开始（0 周日 … 6 周六） */
  weekStart: number;
  weekRefresh: PlannerWeekRefresh;
  /** AI 自己查：最多几轮（0 = 只查"每次都查"的），每轮最多调几个工具 */
  maxRounds: number;
  maxCalls: number;
  /** 每个工具的结果最多留多少字（太长的截断） */
  resultChars: number;
  /** 今天的计划写进聊天、通话、主动消息的提示词（她知道你今天的安排） */
  inChat: boolean;
}

/** 一台 MCP 服务器的密钥：存在本机的 secrets 表（mcp:服务器 id）；上传云端时加密存在你的 Worker 里，读不回来 */
export interface McpServerSecret {
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthToken;
}

export interface McpOAuthToken {
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  authMethod: McpOAuthConfig['authMethod'];
  /** 换 Token、刷新时带的 resource（关了 resource 参数时没有） */
  resource?: string;
  accessToken: string;
  refreshToken?: string;
  /** 毫秒；不知道时为空（遇到 401 再刷新） */
  expiresAt?: number;
}

// —— 计划（「计划」预设按这个格式写，@app/shared 的 parsePlannerDay / parsePlannerWeek 读回来）——

/** 今天时间线上的一件事 */
export interface PlannerItem {
  /** "09:30"，或者"上午""晚上"（不定时的写大概） */
  time: string;
  minutes: number;
  title: string;
  /** 自己写的分类（工作、学习、生活……），随模型写 */
  tag: string;
  note: string;
  /** 从哪来：邮件、日程、家务、健康、你写的情况……（随模型写） */
  source: string;
  /** 日程里定死的（不能挪） */
  fixed: boolean;
}

/** 一封要紧的邮件的摘要 */
export interface PlannerMail {
  from: string;
  subject: string;
  gist: string;
  /** 要做什么（回复、交材料……）；不用管写空 */
  action: string;
  due: string;
  important: boolean;
}

export interface PlannerEvent {
  time: string;
  title: string;
  where: string;
  note: string;
}

export type PlannerPriority = 'high' | 'mid' | 'low';

export interface PlannerTodo {
  title: string;
  due: string;
  priority: PlannerPriority;
  source: string;
}

export interface PlannerDayPlan {
  personaId: string;
  date: ISODate;
  summary: string;
  items: PlannerItem[];
  events: PlannerEvent[];
  mail: PlannerMail[];
  todos: PlannerTodo[];
  /** 一句提醒（选了陪你的角色时是她的口吻） */
  note: string;
  model: string;
  at: number;
  via: 'hub' | 'device';
}

export interface PlannerWeekDay {
  /** 0 周日 … 6 周六 */
  weekday: number;
  date: ISODate;
  focus: string;
  events: string[];
  todos: string[];
}

export interface PlannerDeadline {
  date: string;
  title: string;
  source: string;
}

export interface PlannerWeekPlan {
  personaId: string;
  weekStart: ISODate;
  focus: string;
  days: PlannerWeekDay[];
  deadlines: PlannerDeadline[];
  goals: string[];
  tips: string[];
  model: string;
  at: number;
  via: 'hub' | 'device';
}

/** 排计划时查过的一次（显示"查了什么"） */
export interface PlannerSource {
  server: string;
  tool: string;
  args: string;
  ok: boolean;
  chars: number;
  error?: string;
  /** 0 = 每次都查的；1… = AI 第几轮查的 */
  round: number;
}

/** 一次排计划的结果（云端存进 D1，手机拉回来） */
export interface PlannerRunResult {
  personaId: string;
  date: ISODate;
  week?: PlannerWeekPlan;
  day?: PlannerDayPlan;
  sources: PlannerSource[];
  /** 没连上的服务器、没排出来的那一份 */
  errors: string[];
  at: number;
}

/** 上传云端的那份（Token 不在这里，单独加密上传） */
export interface PlannerContext {
  persona: { id: string; name: string; description: string };
  character: { name: string; description: string } | null;
  timezone: string;
  /** 服务器去掉了工具清单（云端每次现列） */
  settings: PlannerSettings;
  preset: Preset | null;
  /** 家务和健康（手机上拼好的，写着"截至几点"） */
  life: string;
  /** 最近几天的计划和勾了哪些 */
  recent: string;
}

/** 云端排好的计划（/v1/planner/results） */
export interface HubPlannerResults {
  results: { doneAt: number; result: PlannerRunResult }[];
  errors: { personaId: string; date: string; reason: string }[];
}
