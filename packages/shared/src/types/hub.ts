import type { AgentRoute } from './api.ts';
import type { Character, Persona } from './character.ts';
import type { Chat, Message } from './chat.ts';
import type { Lorebook } from './lorebook.ts';
import type { Preset } from './preset.ts';
import type { ProactiveRule, Touchpoint, NotificationPreview } from './proactive.ts';
import type { EnvironmentSettings } from './settings.ts';
import type { World } from '../locations.ts';
import type { RhythmDay, RhythmPerson, RhythmSettings, RhythmTemplate } from './rhythm.ts';

/** Saved independently of proactive messaging, including characters without a chat. */
export interface RhythmContext {
  character: Pick<Character, 'id' | 'name' | 'pronoun' | 'card'>;
  userName: string;
  timezone: string;
  settings: RhythmSettings;
  template: RhythmTemplate;
  world: World;
  people: RhythmPerson[];
  preset: Preset | null;
  promises: string;
}

export interface HubRhythms {
  days: RhythmDay[];
  errors: { characterId: string; date: string; reason: string }[];
}

/** Only the context needed by the proactive agent. API credentials use /v1/secrets separately. */
export interface ProactiveContext {
  character: Character;
  chat: Chat;
  persona: Persona;
  preset: Preset | null;
  lorebooks: Lorebook[];
  history: Message[];
  /** 截取上传历史之前的有效消息总数，供世界书计时。旧客户端未提供时用 history.length。 */
  chatLength?: number;
  /** 待跟进（排期用）、置顶的和最重要的几十条；不传全部记忆 */
  memories: { id: string; content: string; dueAt?: number; type: string }[];
  /**
   * 手机拼好的几块：画像卡 + 时间线、每次都带的 + 最重要的 30 条（主动消息不搜）；
   * home：你开了家务、健康系统时今天的情况（手机上传那一刻的，写着"截至几点"）
   */
  memoryBlocks?: { summary: string; memory: string; home?: string };
  /** 你人设里开着的系统（housework、health）：预设里触发条件写了它们的块只在开着时发送 */
  flags?: string[];
  environment: EnvironmentSettings;
  rules: ProactiveRule[];
  /** An active study/sleep session is refreshed by the client and expires if it disappears. */
  busyUntil: number;
  preview: NotificationPreview;
}

/** Stored encrypted; never returned by a read/sync endpoint. */
export interface ProactiveCredentials {
  routes: AgentRoute[];
  keys: Record<string, string>;
  outputFilters: string[];
}

export interface HubTouchpoint extends Touchpoint {
  lastError?: string;
  pushError?: string;
}

export interface HubInbox {
  messages: { seq: number; characterId: string; message: Message }[];
  next: number;
  more: boolean;
  touchpoints: HubTouchpoint[];
}

export interface HubStatus {
  enabled: boolean;
  lastCronAt: number | null;
  lastError: string | null;
  configured: boolean;
  /** Absent on Workers predating daily rhythm support. */
  rhythmConfigured?: boolean;
  lastRhythmError?: string | null;
  /** 云端记忆整理的 API 已上传 */
  memoryConfigured?: boolean;
  lastMemoryError?: string | null;
  /** 云端朋友圈的 API 已上传；旧版 Worker 没有这个字段 */
  socialConfigured?: boolean;
  lastSocialError?: string | null;
  /** 云端社群上一轮的错误（没有为 null）；旧版 Worker 没有这个字段（不会替网友发帖） */
  lastCommunityError?: string | null;
  /** 云端日程计划的 API 已上传；旧版 Worker 没有这个字段（不会在云端排计划） */
  plannerConfigured?: boolean;
  lastPlannerError?: string | null;
  /** 云端存了密钥的 MCP 服务器（id） */
  plannerMcp?: string[];
  /** 云端平行时空的 API 已上传；旧版 Worker 没有这个字段（不会在云端替她留言） */
  parallelConfigured?: boolean;
  lastParallelError?: string | null;
  /** 云端健康计划的 API 已上传；旧版 Worker 没有这个字段（不会在云端排健康计划，手机开着时自己排） */
  healthConfigured?: boolean;
  lastHealthError?: string | null;
  /** 云端存了给它用的 Google 地图 Key（排健康计划时自己查家附近的店） */
  mapsConfigured?: boolean;
  /** 云端整理你的一天上一次的问题（没有为 null）；旧版 Worker 没有这个字段（不会在云端整理，手机开着时自己整理） */
  lastParallelPlanError?: string | null;
  /** 有内置的微信读书 MCP（/v1/weread/mcp）；旧版 Worker 没有这个字段 */
  weread?: boolean;
  /** 能用云端存的登录信息调日历 MCP 的单个工具（/v1/planner/mcp/:id/call：平行时空把记的事同步进 Google 日历）；旧版 Worker 没有这个字段 */
  mcpCall?: boolean;
  /** 有多设备同步（/v1/sync/*）；旧版 Worker 没有这个字段 */
  sync?: boolean;
  /** 同步的大文件存在哪：r2（绑了 SYNC_BUCKET）/ d1（base64 分块，免费版整个数据库 500 MB） */
  syncBlobs?: import('./sync.ts').SyncBlobStore;
  /** 存在 D1 里的同步大文件最多占多少字节（绑了 R2 时没有） */
  syncBlobQuota?: number | null;
  vapidPublicKey: string | null;
  channels: { id: string; kind: 'webpush' | 'webhook'; label: string; lastOkAt: number | null }[];
}

export interface HubNotification {
  title: string;
  body: string;
  tag: string;
  route: string;
}

/** 云端记忆整理的结果（/v1/memory/results） */
export interface HubMemoryResults {
  results: { doneAt: number; result: import('./memory.ts').MemoryJobResult }[];
  errors: { characterId: string; date: string; reason: string }[];
}

/** 按片名搜到的 B 站视频（/v1/video/search，一起观影的邀请卡片用） */
export interface VideoHit {
  bvid: string;
  title: string;
  author: string;
  /** "12:34" */
  duration: string;
  cover: string;
  plays: number;
  url: string;
}
