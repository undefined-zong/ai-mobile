import type { ChoreItem } from '../housework.ts';
import type { HealthDayPlan } from '../health.ts';
import type { Character } from './character.ts';
import type { HHMM, ISODate } from './common.ts';
import type { FitTimeOfDay } from './life.ts';
import type { PlannerDayPlan } from './planner.ts';
import type { Preset } from './preset.ts';
import type { NotificationPreview } from './proactive.ts';
import type { EnvironmentSettings } from './settings.ts';
import type { SocialDay } from './social.ts';

/**
 * 平行时空（设计文档 §9.16）：她今天的节律和你今天的安排一左一右排在同一条时间线上。
 * - 你的那一边来自日程计划（日程系统）、家务、健康计划，加上你在这里自己记的事；能加、删、改、勾掉；
 * - 你可以给她留言、请她改今天的日程（她可能不答应）；她也会给你留言：云端每天在随机的时间留（App 关着也留），
 *   没连云端时 App 开着按同一套时间留。
 * 提示词全在"平行时空"预设里，调"平行时空"的 API。
 */

/** 留言里"你"的 id（其余的是角色 id） */
export const PARALLEL_USER = 'user';

/** 一件事下面的清单（买菜的单子、出门前要带的） */
export interface ParallelCheck {
  id: string;
  text: string;
  done: boolean;
}

/** 你在平行时空里自己记的一件事 */
export interface ParallelItem {
  id: string;
  /** "15:00"；不定时为空 */
  time: string;
  /** 大概多久（分钟）；0 = 没写 */
  minutes: number;
  title: string;
  note: string;
  checklist: ParallelCheck[];
  done: boolean;
  createdAt: number;
  /** 同步进 Google 日历的那一条（记的时候开着"同步到 Google 日历"才有）：之后改时间、名字、删掉时跟着改 */
  calendar?: ParallelCalendarLink;
}

/** 平行时空里记的一件事在 Google 日历里的那一条（只记我们自己建的） */
export interface ParallelCalendarLink {
  /** 人设日程系统里接的那台 Google 日历服务器 */
  serverId: string;
  calendarId: string;
  eventId: string;
  at: number;
}

/**
 * 来源里的事（家务、健康计划、待办）在平行时空里改过的地方。日程计划的时间线直接改在计划上（她在聊天里也知道），不在这里。
 * 家务做没做仍以"共同的家"里的记录为准（这里勾也是勾那里）
 */
export interface ParallelOverride {
  /** 改了时间（空 = 改成不定时） */
  time?: string;
  title?: string;
  note?: string;
  /** 从今天拿掉（只是平行时空里不显示） */
  hidden?: boolean;
  /** 健康计划的吃饭、健身没有自己的完成记录：勾在这里 */
  done?: boolean;
  /** 清单里勾掉的（按文字：重新排了顺序也对得上） */
  checks?: string[];
}

/** 你在平行时空里的一天（按人设、节律日） */
export interface ParallelDay {
  personaId: string;
  date: ISODate;
  items: ParallelItem[];
  overrides: Record<string, ParallelOverride>;
}

export type ParallelSide = 'her' | 'me';

/** 时间线上的一项是什么：她的作息、日程计划、家务、健身、吃饭、待办、你自己记的、整理好的计划里的一项 */
export type ParallelEntryKind = 'slot' | 'plan' | 'chore' | 'workout' | 'meal' | 'todo' | 'item' | 'merged';

export interface ParallelEntryCheck {
  /** 勾的时候记的（按文字） */
  key: string;
  text: string;
  done: boolean;
}

/** 时间线上的一项（她的、你的都是这个样子；界面和提示词都用它） */
export interface ParallelEntry {
  /** 稳定的 key：slot:07:00、chore:…、health:workout、plan:…、item:… */
  key: string;
  side: ParallelSide;
  kind: ParallelEntryKind;
  /** 开始、结束：节律日里的第几分钟（凌晨 4 点前的算前一天，加 1440）；不定时的为 null */
  start: number | null;
  end: number | null;
  /** 显示的时间："09:30"、"15:00–17:00"、"上午"；不定时为空 */
  time: string;
  title: string;
  /** 补一句：在哪、从哪来、备注 */
  sub: string;
  /** 从哪来（给模型看）：日程系统、家务、健康计划、自己记的 */
  source: string;
  done?: boolean;
  checklist?: ParallelEntryCheck[];
  /** 定死的（她作息里固定的事、日程里定死的会） */
  fixed?: boolean;
  /** 她此刻在做的 */
  now?: boolean;
  /** 过了时间还没做（家务） */
  overdue?: boolean;
  /** 你在平行时空里改过 */
  edited?: boolean;
  /** 日程计划时间线的第几项（和家务、健康对上时也带着，勾的时候一起勾） */
  planIndex?: number;
  /** 家务的记录 key */
  choreKey?: string;
  /** 她的作息里这一段在哪：地点名、地点 id（改日程时给模型看） */
  place?: string;
  placeId?: string;
  /** 时间线上那个圆圈里的图标（没有时按 kind 配） */
  icon?: string;
  /** 整理好的计划里的一项（kind = merged）：是从哪几项合成的（来源那几项的 key，勾的时候一起勾） */
  parts?: string[];
  /** 整理好的计划里的一项主要是哪一类（配图标） */
  via?: ParallelEntryKind;
}

/** 留言说的是哪一项 */
export interface ParallelRef {
  side: ParallelSide;
  key: string;
  /** 给人看的："15:00–17:00 写论文" */
  label: string;
}

export interface ParallelReply {
  id: string;
  /** PARALLEL_USER 或角色 id */
  authorId: string;
  text: string;
  at: number;
}

/** 你请她改日程，她的决定 */
export interface ParallelRequestResult {
  status: 'accepted' | 'declined';
  /** 改了哪几段（"15:00–17:00 写论文 · 图书馆 → 陪你逛夜市 · 夜市"） */
  changes: string[];
  /** 检查时改回去的（固定的事不能挪……） */
  fixes?: string[];
}

/** 平行时空里的一条留言：她留的（定时、你让她留的）、你留的（留言、请她改日程）；下面是来回的回复 */
export interface ParallelNote {
  id: string;
  characterId: string;
  /** 哪一天的平行时空（节律日） */
  date: ISODate;
  /** PARALLEL_USER 或角色 id */
  authorId: string;
  text: string;
  /** request：你请她改今天的日程 */
  kind: 'note' | 'request';
  about?: ParallelRef;
  replies: ParallelReply[];
  request?: ParallelRequestResult;
  at: number;
  updatedAt: number;
  /** hub 云端定时留的；device 手机上留的；user 你写的 */
  source: 'hub' | 'device' | 'user';
  model?: string;
  /** 你还没看过 */
  unread?: boolean;
  /** 写进她记忆的那一条（来回多了改同一条） */
  memoryId?: string;
}

/** 一个角色会不会自己给你留言、每天最多几条 */
export interface ParallelCharacterSettings {
  enabled: boolean;
  /** 每天最多几条（1–PARALLEL_PER_DAY_MAX）：每天实际 1 到这么多条，时间随机，落在她醒着的时段里 */
  perDay: number;
}

export interface ParallelSettings {
  /** 你在平行时空里自己记的事、拿掉的事写进聊天、通话、主动消息的提示词 */
  inChat: boolean;
  /** 每天几点把日程计划、家务、健康计划整理成平行时空里你的一份计划（你所在的时区；在日程计划排好之后） */
  planAt: HHMM;
  characters: Record<string, ParallelCharacterSettings>;
  /** 新记的事（自己填的、AI 记的）同步写进 Google 日历（人设的日程系统里接了 Google 日历时才有用） */
  calendarSync: boolean;
}

export const PARALLEL_PER_DAY_MAX = 4;
export const DEFAULT_PARALLEL_CHARACTER: ParallelCharacterSettings = { enabled: true, perDay: 2 };
export const DEFAULT_PARALLEL_SETTINGS: ParallelSettings = { inChat: true, planAt: '05:00', characters: {}, calendarSync: true };

// —— 你的一份计划：每天到点（planAt）用"平行时空 · 整理你的一天"预设，把日程计划、家务、健康计划（有几份用几份）整理成一份 ——

/** 整理好的计划里的一项 */
export interface ParallelPlanItem {
  id: string;
  /** "09:30"；不定时为空 */
  time: string;
  minutes: number;
  title: string;
  note: string;
  /** 从哪几项合成的：来源那几项的 key（日程计划的 plan:…、家务的 chore:…、健康的 health:…、待办的 todo:…） */
  from: string[];
}

/** 你某一天整理好的计划（按人设、节律日） */
export interface ParallelPlan {
  personaId: string;
  date: ISODate;
  items: ParallelPlanItem[];
  /** 整理时几份计划的样子（parallelSourcesBasis）：之后来源变了（重排了、改了）能看出来 */
  basis: string;
  model: string;
  at: number;
  via: 'hub' | 'device';
}

/** 整理一天要的材料：那天的日程计划、家务、健康计划（没有的为空） */
export interface ParallelPlanDay {
  date: ISODate;
  plan: PlannerDayPlan | null;
  chores: ChoreItem[];
  health: HealthDayPlan | null;
}

/**
 * 云端每天到点替你整理要的东西（按人设上传，/v1/parallel/plan-contexts）：家务和健康计划在手机上，手机把今天、明天的传上去；
 * 日程计划云端有自己排的（planner_jobs），排好了就用云端那份
 */
export interface ParallelPlanContext {
  persona: { id: string; name: string };
  timezone: string;
  planAt: HHMM;
  env: ParallelEnv;
  /** 健身一般什么时候练 */
  fitTime: FitTimeOfDay | null;
  days: ParallelPlanDay[];
  preset: Preset | null;
}

/** 云端整理好的（/v1/parallel/plans） */
export interface HubParallelPlans {
  plans: { doneAt: number; plan: ParallelPlan }[];
  errors: { personaId: string; date: string; reason: string }[];
}

/** 排时间用的作息（"环境与作息"里的起床、睡觉和三餐） */
export type ParallelEnv = Pick<EnvironmentSettings, 'wakeTime' | 'sleepTime' | 'meals'>;

/**
 * 云端给你留言要的东西（按角色上传，/v1/parallel/contexts）：角色卡、你的一天、记忆和最近的聊天都是手机拼好的。
 * 她今天的节律云端有自己排的（rhythm_days），手机上改过的（你请她改了日程）以手机的为准
 */
export interface ParallelContext {
  character: Pick<Character, 'id' | 'name' | 'pronoun' | 'card'>;
  persona: { id: string; name: string };
  timezone: string;
  settings: ParallelCharacterSettings;
  /** 她醒着的时段（HH:mm）：只在这段时间里留言 */
  awake: { from: string; to: string };
  env: ParallelEnv;
  /** 手机上她今天的节律（地点换成了名字） */
  her: SocialDay | null;
  /** 手机上你今天的安排；日期不是今天时云端用自己排的日程计划 */
  mine: { date: ISODate; entries: ParallelEntry[] } | null;
  memories: string;
  recent: string;
  /** 最近的留言（今天、昨天的） */
  notes: string;
  preset: Preset | null;
  preview: NotificationPreview;
}

/** 云端留的言（/v1/parallel/notes） */
export interface HubParallelNotes {
  notes: { doneAt: number; note: ParallelNote }[];
  errors: { characterId: string; date: string; reason: string }[];
}
