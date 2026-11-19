import type { Preset } from './preset.ts';
import type { NotificationPreview } from './proactive.ts';
import type { MomentImage } from './social.ts';

/**
 * 社群（社媒里的另一半，和朋友圈并排）：按话题聚在一起的网友。
 * - 搜关键字找社群；没有对应的就让模型按关键字建一个（名字、简介、风气、标签、图标）；
 * - 你加入的社群，云端每天在随机的时间替网友发几批帖子（App 关着也发），帖子可以配图（交给生图）、附一小页 HTML；
 * - 你也能发帖：网友点赞、顶帖、回复；
 * - 你可以邀请角色加入：她记得这件事，在社群里和你显示为互关，也会自己发帖、回应你的帖子。
 * 提示词全在"社媒 · 社群"预设里；自带的社群是 apps/web/src/communities/ 里的社群文件。
 */

/** 网友的作者 id：前缀 + 网名（你是 MOMENT_USER，角色是角色 id） */
export const NETIZEN_PREFIX = 'net:';

export function netizenId(name: string): string {
  return `${NETIZEN_PREFIX}${name}`;
}

export function isNetizen(authorId: string): boolean {
  return authorId.startsWith(NETIZEN_PREFIX);
}

export function netizenName(authorId: string): string {
  return authorId.slice(NETIZEN_PREFIX.length);
}

export interface Community {
  id: string;
  name: string;
  /** 简介（列表和社群页顶上显示） */
  description: string;
  /** 风气：聊什么、怎么说话、常见的帖子（发帖时发给模型，界面上也能改） */
  vibe: string;
  /** 搜索用的关键字 */
  tags: string[];
  /** 图标：一个 emoji */
  icon: string;
  /** 主题色（#rrggbb） */
  color: string;
  /** 显示的成员数（网友有多少：模型编的，或者社群文件里写的） */
  memberCount: number;
  /** 你加入了：每天替网友发帖，你能发帖、邀请角色 */
  joined: boolean;
  /** 你邀请进来的角色 id */
  members: string[];
  /** 邀请这件事写进记忆的那一条：角色 id → 记忆 id */
  memoryIds?: Record<string, string>;
  createdAt: number;
  updatedAt: number;
  /** seed 自带的（社群文件）；generated 搜不到时模型建的 */
  source: 'seed' | 'generated';
  seedFile?: string;
  /** 建的时候搜的关键字 */
  keyword?: string;
  model?: string;
}

export interface CommunityComment {
  id: string;
  /** MOMENT_USER、角色 id 或网友 id */
  authorId: string;
  text: string;
  /** 回复谁；不写 = 直接回这一帖 */
  replyTo?: string;
  at: number;
}

export interface CommunityPost {
  id: string;
  communityId: string;
  /** MOMENT_USER、角色 id 或网友 id */
  authorId: string;
  title?: string;
  text: string;
  images: MomentImage[];
  /** 一小页 HTML（菜谱卡、投票、对比表……），放在沙盒小窗里显示 */
  html?: string;
  htmlTitle?: string;
  /** 网友点的赞（数）；你和角色点的记在 liked 里 */
  likes: number;
  liked: string[];
  /** 网友顶的次数；你和角色顶的记在 bumped 里 */
  bumps: number;
  bumped: string[];
  comments: CommunityComment[];
  createdAt: number;
  updatedAt: number;
  /** 最后一次被顶的时间（没被顶过 = 发帖时间）："最近顶起"按它排 */
  bumpedAt: number;
  /** hub 云端定时发的；device 在手机上生成的；user 你发的；seed 社群文件里带的 */
  source: 'hub' | 'device' | 'user' | 'seed';
  model?: string;
  unread?: boolean;
  /** 写进记忆的那一条：角色 id → 记忆 id */
  memoryIds?: Record<string, string>;
}

/** 帖子怎么排：active 最近顶起（顶帖把帖子顶上来）；new 最新发布 */
export const COMMUNITY_SORTS = { active: '最近顶起', new: '最新发布' } as const;
export type CommunitySort = keyof typeof COMMUNITY_SORTS;

/** 社群列表怎么摆：list 一行一个（带简介）；grid 一行两个（社群多了一屏看得更多） */
export const COMMUNITY_LAYOUTS = { list: '一行一个', grid: '一行两个' } as const;
export type CommunityLayout = keyof typeof COMMUNITY_LAYOUTS;

export interface CommunitySettings {
  /** 加入的社群每天最多更新几次：每天实际 1 到这么多次，时间随机 */
  perDay: number;
  /** 每次网友发几帖 */
  batchSize: number;
  /** 加入社群的角色每天在每个社群最多发几帖（实际 0 到这么多）；0 = 不自己发 */
  memberPerDay: number;
  /** 帖子要配图时自动画（要接通生图） */
  autoImage: boolean;
  /** 每个社群本机保留最近多少帖（更早的删掉；她们记住的还在） */
  keep: number;
  /** 发帖、回应时给模型看这个社群最近几帖（避免重复、能接着聊）；0 = 不给 */
  contextPosts: number;
  /** 和她聊天时每个她所在的社群带最近几帖（最近三天里你和她的帖优先，不够用网友最新的补）；0 = 只带她在哪些社群 */
  chatPosts: number;
  /** 有新帖时云端发通知 */
  notify: boolean;
  sort: CommunitySort;
  /** 社群列表一行一个还是一行两个 */
  layout: CommunityLayout;
}

/** 各项设置能填的范围（界面的步进器、读本机设置、云端校验用同一份） */
export const COMMUNITY_LIMITS = {
  perDay: { min: 1, max: 6 },
  batchSize: { min: 1, max: 8 },
  memberPerDay: { min: 0, max: 3 },
  keep: { min: 20, max: 2000 },
  contextPosts: { min: 0, max: 30 },
  chatPosts: { min: 0, max: 10 },
} as const satisfies Partial<Record<keyof CommunitySettings, { min: number; max: number }>>;

export const DEFAULT_COMMUNITY_SETTINGS: CommunitySettings = { perDay: 2, batchSize: 3, memberPerDay: 1, autoImage: true, keep: 200, contextPosts: 8, chatPosts: 3, notify: false, sort: 'active', layout: 'list' };

/** 到点以后多久之内还补发（超过的不补）：手机和云端用同一个 */
export const COMMUNITY_CATCH_UP_MS = 3 * 3_600_000;

/** 社群预设里的任务（块的触发条件写这几个名字） */
export const COMMUNITY_TASKS = {
  'community-create': '按关键字建一个社群',
  'community-feed': '网友发帖',
  'community-react': '网友回应你的帖子和回复',
  'community-member-post': '加入社群的角色发帖',
  'community-member-react': '加入社群的角色回应你',
} as const;

export type CommunityTask = keyof typeof COMMUNITY_TASKS;

/**
 * 社群配图的生图预设里按"谁发的"发送的块（块的触发条件写这两个名字）：
 * 网友的帖子程序不加任何人的长相；角色的帖子程序会把她的长相加在最前面
 */
export const COMMUNITY_IMAGE_MOMENTS = { 'community-netizen': '网友的帖子', 'community-member': 'Ta的帖子' } as const;
export type CommunityImageMoment = keyof typeof COMMUNITY_IMAGE_MOMENTS;

/**
 * 云端替网友发帖要的东西（按社群上传，/v1/community/contexts）：社群的介绍、设置、最近的帖子都是手机拼好的文字。
 * 角色的帖子用她自己上传的朋友圈上下文（/v1/social/contexts：角色卡、节律、记忆、最近的聊天）
 */
export interface CommunityContext {
  community: Pick<Community, 'id' | 'name' | 'description' | 'vibe' | 'tags' | 'memberCount'>;
  userName: string;
  timezone: string;
  settings: Pick<CommunitySettings, 'perDay' | 'batchSize' | 'memberPerDay' | 'notify'>;
  /** 你醒着的时段（HH:mm）：网友的帖子落在这段时间里 */
  awake: { from: string; to: string };
  /** 你邀请进来的角色 */
  members: { id: string; name: string }[];
  /** 最近的帖子（文字）：避免重复，也能接着聊 */
  feed: string;
  preset: Preset | null;
  preview: NotificationPreview;
}

/** 云端发的帖子（/v1/community/posts）：图由手机收到后再画 */
export interface HubCommunityPosts {
  batches: { doneAt: number; posts: CommunityPost[] }[];
  errors: { communityId: string; date: string; reason: string }[];
}
