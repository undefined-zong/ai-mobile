import { cleanHtml, count, hash32, nullable, shortDay, shortStamp, str } from './modelText.ts';
import { commentText, dailySlots, momentExtras } from './social.ts';
import type { TextFn } from './programText.ts';
import { zonedInstant } from './timezone.ts';
import {
  COMMUNITY_LAYOUTS, COMMUNITY_LIMITS, COMMUNITY_SORTS, DEFAULT_COMMUNITY_SETTINGS, netizenId,
  type Community, type CommunityComment, type CommunityPost, type CommunitySettings,
} from './types/community.ts';
import { MOMENT_USER } from './types/social.ts';

/**
 * 社群在手机和云端共用的部分：设置的范围、每天什么时候发（随机但可重复，两边算的一样）、
 * 读模型的输出和社群文件、把帖子写成文字（进提示词、进记忆）。
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

// —— 设置 ——

/** 把存下来的 / 上传的设置收进允许的范围（COMMUNITY_LIMITS），缺的用默认值 */
export function communitySettingsOf(raw?: Partial<CommunitySettings> | null): CommunitySettings {
  const out = { ...DEFAULT_COMMUNITY_SETTINGS };
  for (const key of Object.keys(COMMUNITY_LIMITS) as (keyof typeof COMMUNITY_LIMITS)[]) {
    const { min, max } = COMMUNITY_LIMITS[key];
    const v = raw?.[key];
    if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.min(max, Math.max(min, Math.round(v)));
  }
  if (typeof raw?.autoImage === 'boolean') out.autoImage = raw.autoImage;
  if (typeof raw?.notify === 'boolean') out.notify = raw.notify;
  if (raw?.sort && raw.sort in COMMUNITY_SORTS) out.sort = raw.sort;
  if (raw?.layout && raw.layout in COMMUNITY_LAYOUTS) out.layout = raw.layout;
  return out;
}

/** 设置里的数是不是都在范围里（云端收到上传的设置时检查） */
export function communitySettingsValid(raw: Partial<CommunitySettings> | undefined, keys: (keyof typeof COMMUNITY_LIMITS)[]): boolean {
  return keys.every((key) => {
    const v = raw?.[key];
    return Number.isInteger(v) && (v as number) >= COMMUNITY_LIMITS[key].min && (v as number) <= COMMUNITY_LIMITS[key].max;
  });
}

// —— 每天什么时候发 ——

export interface CommunityJob {
  /** feed 网友的一批帖子；member 这个角色的一帖 */
  kind: 'feed' | 'member';
  characterId?: string;
  date: string;
  /** 这一天里的格子："feed:0"、"member:角色 id:0" */
  slot: string;
  dueAt: number;
  /** 这一批的 id（帖子的 id 是它加上第几帖）：手机和云端算的一样，不会各发一份 */
  id: string;
}

type Awake = { from: string; to: string };

/**
 * 这个社群这一天要发的：网友的几批（1 到"每天最多更新几次"，落在你醒着的时段里），
 * 和每个加入的角色的几帖（0 到"每天最多几帖"，落在她醒着的时段里）。
 */
export function communityJobs(input: {
  communityId: string;
  date: string;
  timezone: string;
  settings: Pick<CommunitySettings, 'perDay' | 'memberPerDay'>;
  awake: Awake;
  members: { id: string; awake: Awake }[];
}): CommunityJob[] {
  const { communityId, date, timezone } = input;
  const settings = communitySettingsOf(input.settings);
  const job = (kind: CommunityJob['kind'], slot: string, minute: number, characterId?: string): CommunityJob => ({
    kind, date, slot, dueAt: zonedInstant(date, minute, timezone), id: `cpost:${communityId}:${date}:${slot}`, ...(characterId ? { characterId } : {}),
  });
  return [
    ...dailySlots({ key: `${communityId}:feed`, date, min: 1, max: settings.perDay, awake: input.awake }).map((minute, i) => job('feed', `feed:${i}`, minute)),
    ...input.members.flatMap((m) =>
      dailySlots({ key: `${communityId}:member:${m.id}`, date, min: 0, max: settings.memberPerDay, awake: m.awake }).map((minute, i) => job('member', `member:${m.id}:${i}`, minute, m.id)),
    ),
  ];
}

// —— 读模型的输出 ——

/** 按关键字建的社群（社群预设 community-create 的输出，社群文件里也是这几项） */
export interface CommunityDraft {
  name: string;
  description: string;
  vibe: string;
  tags: string[];
  icon: string;
  color: string;
  memberCount: number;
}

/** 图标只留一个字（emoji 可能由好几个码点拼成，按"看起来的一个字"切） */
function firstGlyph(text: string): string {
  if (!text) return '';
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter) for (const s of new Segmenter(undefined, { granularity: 'grapheme' }).segment(text)) return s.segment;
  return Array.from(text)[0] ?? '';
}

function tagList(v: unknown): string[] {
  const list = Array.isArray(v) ? v.map(str) : str(v).split(/[,，、\s]+/);
  return [...new Set(list.map((t) => t.replace(/^#/, '').slice(0, 20)).filter(Boolean))].slice(0, 12);
}

export function parseCommunityDraft(value: unknown): CommunityDraft | null {
  if (!isObj(value)) return null;
  const name = str(value.name).slice(0, 30);
  const description = str(value.description).slice(0, 300);
  if (!name || !description) return null;
  const color = str(value.color);
  return {
    name, description,
    vibe: str(value.vibe).slice(0, 800),
    tags: tagList(value.tags),
    icon: firstGlyph(str(value.icon)),
    color: /^#[0-9a-f]{6}$/i.test(color) ? color : '',
    memberCount: count(value.memberCount),
  };
}

/** 按名字算一个颜色（同一个名字总是同一个颜色）：没写主题色的社群、网友的头像用。色相、饱和度、明度各取哈希的一段，名字不同颜色就分得开 */
export function nameColor(name: string): string {
  const h = hash32(name);
  return `hsl(${h % 360} ${48 + ((h >>> 9) % 20)}% ${44 + ((h >>> 15) % 14)}%)`;
}

export interface CommunityCommentDraft {
  author: string;
  text: string;
  /** 回复谁（网名、你的名字、角色的名字）；直接回这一帖为 null */
  replyTo: string | null;
}

/** 一帖（社群预设 community-feed / community-member-post 的输出里 posts 的一项，社群文件里的帖子也是） */
export interface CommunityPostDraft {
  author: string;
  title: string;
  text: string;
  /** 要配的图的画面；不配图为 null */
  image: string | null;
  html: string | null;
  htmlTitle: string;
  likes: number;
  bumps: number;
  comments: CommunityCommentDraft[];
  /** 社群文件里的帖子：多少分钟前发的 */
  minutesAgo?: number;
}

function commentDrafts(v: unknown): CommunityCommentDraft[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c): CommunityCommentDraft[] => {
    if (!isObj(c)) return [];
    const text = str(c.text).slice(0, 500);
    const author = str(c.author).slice(0, 30);
    return text && author ? [{ author, text, replyTo: nullable(c.replyTo)?.slice(0, 30) ?? null }] : [];
  }).slice(0, 30);
}

function postDraft(v: unknown): CommunityPostDraft | null {
  if (!isObj(v)) return null;
  const title = str(v.title).slice(0, 60);
  const text = str(v.text).slice(0, 3000);
  const html = cleanHtml(v.html);
  const image = nullable(v.image);
  // 只有标题、只有图、只有一页 HTML 也算一帖；什么都没有不算
  if (!title && !text && !html && !image) return null;
  return {
    author: str(v.author).slice(0, 30), title, text, image: image ? image.slice(0, 300) : null, html, htmlTitle: str(v.htmlTitle).slice(0, 30),
    likes: count(v.likes), bumps: count(v.bumps), comments: commentDrafts(v.comments),
    ...(typeof v.minutesAgo === 'number' && Number.isFinite(v.minutesAgo) ? { minutesAgo: Math.max(0, v.minutesAgo) } : {}),
  };
}

/** {"posts": [...]}；模型直接写了数组、或者只写了一帖也认 */
export function parseCommunityBatch(value: unknown): CommunityPostDraft[] | null {
  const list = Array.isArray(value) ? value : isObj(value) && Array.isArray(value.posts) ? value.posts : isObj(value) ? [value] : null;
  if (!list) return null;
  const posts = list.flatMap((p) => postDraft(p) ?? []);
  return posts.length ? posts : null;
}

/** 网友对一帖的回应（community-react 的输出）：新增的赞、顶和回复 */
export interface CommunityReaction {
  likes: number;
  bumps: number;
  comments: CommunityCommentDraft[];
}

export function parseCommunityReaction(value: unknown): CommunityReaction | null {
  if (!isObj(value)) return null;
  return { likes: count(value.likes), bumps: count(value.bumps), comments: commentDrafts(value.comments) };
}

/** 加入社群的角色对你的帖子、回复的回应（community-member-react 的输出） */
export interface MemberReaction {
  like: boolean;
  bump: boolean;
  comment: string | null;
}

const yes = (v: unknown) => v === true || v === 'true';

export function parseMemberReaction(value: unknown): MemberReaction | null {
  if (!isObj(value)) return null;
  const comment = nullable(value.comment);
  return { like: yes(value.like), bump: yes(value.bump), comment: comment ? comment.slice(0, 500) : null };
}

// —— 草稿 → 存下来的社群和帖子 ——

export function communityFromDraft(
  draft: CommunityDraft,
  opts: { id: string; now: number; source: Community['source']; joined: boolean } & Pick<Community, 'seedFile' | 'keyword' | 'model'>,
): Community {
  const { id, now, source, joined, ...rest } = opts;
  return {
    id, ...draft, color: draft.color || nameColor(draft.name), joined, members: [], createdAt: now, updatedAt: now, source,
    ...Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined)),
  };
}

/**
 * 名字 → 作者 id。known 是你和角色的名字：模型不能替这些人发帖、回复（写了就丢掉），但可以回复他们；其余的名字都是网友
 */
export function commentsFromDrafts(drafts: CommunityCommentDraft[], opts: { known: Record<string, string>; at: (i: number) => number; idPrefix: string }): CommunityComment[] {
  return drafts.flatMap((c, i): CommunityComment[] => {
    if (opts.known[c.author]) return [];
    const replyTo = c.replyTo ? (opts.known[c.replyTo] ?? netizenId(c.replyTo)) : undefined;
    return [{ id: `${opts.idPrefix}${i}`, authorId: netizenId(c.author), text: c.text, ...(replyTo ? { replyTo } : {}), at: opts.at(i) }];
  });
}

export function postsFromDrafts(drafts: CommunityPostDraft[], opts: {
  communityId: string;
  /** 这一批的 id：帖子的 id 是它加上第几帖 */
  batchId: string;
  now: number;
  source: CommunityPost['source'];
  model?: string;
  /** 你和角色的名字 → id */
  known: Record<string, string>;
  /** 这一批都是这个作者发的（角色发帖）；不给 = 网友发的，按草稿里写的网名 */
  authorId?: string;
  unread?: boolean;
}): CommunityPost[] {
  // 先去掉不能用的（没写网名、冒用了你或角色的名字），再编号：帖子的 id 是这一批的 id 加上它在留下来的里面排第几，
  // 所以只要这一批发出来了，第 0 帖一定在（手机按它判断这一格发没发过）
  const kept = drafts.flatMap((d) => {
    const authorId = opts.authorId ?? (d.author && !opts.known[d.author] ? netizenId(d.author) : null);
    return authorId ? [{ d, authorId }] : [];
  });
  return kept.map(({ d, authorId }, i): CommunityPost => {
    const id = `${opts.batchId}:${i}`;
    // 同一批里按写的顺序排（后写的更新）；社群文件里的帖子按它写的"多少分钟前"
    const createdAt = d.minutesAgo !== undefined ? opts.now - d.minutesAgo * 60_000 : opts.now - (kept.length - 1 - i);
    return {
      id, communityId: opts.communityId, authorId, ...(d.title ? { title: d.title } : {}), text: d.text,
      images: d.image ? [{ caption: d.image, assetKey: null }] : [],
      ...(d.html ? { html: d.html, htmlTitle: d.htmlTitle } : {}),
      likes: d.likes, liked: [], bumps: d.bumps, bumped: [],
      comments: commentsFromDrafts(d.comments, { known: opts.known, at: (j) => Math.min(opts.now, createdAt + (j + 1) * 60_000), idPrefix: `${id}:c` }),
      createdAt, updatedAt: createdAt, bumpedAt: createdAt, source: opts.source,
      ...(opts.model ? { model: opts.model } : {}), ...(opts.unread ? { unread: true } : {}),
    };
  });
}

// —— 社群文件 ——

/**
 * 社群文件（App 自己的格式，.json）。自带的社群就是 apps/web/src/communities/ 里的这种文件：
 * 第一次打开时放进社群列表，之后和搜出来的一样能加入、能退出、能删；往那个文件夹里加一个 .json 就多一个自带社群。
 * community 的字段和模型建社群的输出一样，posts 和模型发帖的输出一样（多一个 minutesAgo）。
 */
export const COMMUNITY_FILE_FORMAT = 'ai-mobile-community';

export interface ParsedCommunityFile {
  id?: string;
  /** 放进来时就算加入了 */
  joined: boolean;
  draft: CommunityDraft;
  posts: CommunityPostDraft[];
}

export function parseCommunityFile(json: unknown, fileName = ''): ParsedCommunityFile {
  if (!isObj(json) || json.format !== COMMUNITY_FILE_FORMAT) throw new Error(`${fileName || '这个文件'}不是 App 的社群文件`);
  const draft = parseCommunityDraft(json.community);
  if (!draft) throw new Error(`${fileName || '社群文件'}里的社群缺名字或简介`);
  return { ...(str(json.id) ? { id: str(json.id) } : {}), joined: json.joined === true, draft, posts: parseCommunityBatch(json.posts) ?? [] };
}

// —— 搜索 ——

/** 关键字（空格分开的每一个词）都能在名字、简介、标签、建它时搜的关键字里找到 */
export function matchCommunity(c: Pick<Community, 'name' | 'description' | 'tags' | 'keyword'>, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [c.name, c.description, c.keyword ?? '', ...c.tags].join('\n').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// —— 写成文字 ——

/** 社群的介绍（进提示词） */
export function communityInfoText(c: Pick<Community, 'name' | 'description' | 'vibe' | 'tags' | 'memberCount'>, t: TextFn): string {
  return t('community.info', { name: c.name, description: c.description, vibe: c.vibe, tags: c.tags, members: c.memberCount || null });
}

type PostText = Pick<CommunityPost, 'authorId' | 'title' | 'text' | 'images' | 'html' | 'htmlTitle' | 'likes' | 'liked' | 'bumps' | 'bumped' | 'comments' | 'createdAt'>;

function postHead(p: PostText, names: (id: string) => string, t: TextFn): string {
  return t('community.postHead', { author: names(p.authorId), title: p.title, text: p.text, extras: momentExtras(p, t, 'community.htmlFallback') });
}

/**
 * 一帖写成几行字（进提示词）：谁、什么时候、发了什么、多少赞多少顶（你和角色点的写出名字）、下面的回复。
 * names：id → 名字（你、角色、网友）
 */
export function communityPostText(p: PostText, names: (id: string) => string, t: TextFn, opts: { timeZone?: string; comments?: number; textMax?: number } = {}): string {
  const short = opts.textMax && p.text.length > opts.textMax ? { ...p, text: `${p.text.slice(0, opts.textMax)}…` } : p;
  const likes = p.likes + p.liked.length;
  const bumps = p.bumps + p.bumped.length;
  const stats = likes || bumps ? t('community.postStats', { likes, liked: p.liked.map(names), bumps, bumped: p.bumped.map(names) }) : '';
  const comments = p.comments.slice(-(opts.comments ?? 8)).map((c) => commentText(c, names, t));
  return [t('community.post', { stamp: shortStamp(p.createdAt, opts.timeZone), head: postHead(short, names, t) }), stats, ...comments].filter(Boolean).join('\n');
}

/** 一帖对这个角色来说要记住的一句话（写进记忆）：她自己发的、你发的，只带她和你的互动 */
export function communityPostMemory(p: PostText, communityName: string, characterId: string, names: (id: string) => string, t: TextFn, timeZone?: string): string {
  const mine = p.authorId === characterId;
  const other = mine ? MOMENT_USER : characterId;
  const did = [p.liked.includes(other) ? t('community.memory.liked') : '', p.bumped.includes(other) ? t('community.memory.bumped') : ''].filter(Boolean);
  const talk = p.comments.filter((c) => c.authorId === characterId || c.authorId === MOMENT_USER).slice(-4);
  return t('moment.memory', {
    parts: [
      t('community.memory.head', { day: shortDay(p.createdAt, timeZone), community: communityName, head: postHead({ ...p, text: p.text.slice(0, 200) }, names, t) }),
      did.length ? t('community.memory.did', { name: names(other), did }) : '',
      talk.length ? t('community.memory.talk', { items: talk.map((c) => t('moment.memory.talkItem', { name: names(c.authorId), text: c.text.slice(0, 80) })) }) : '',
    ].filter(Boolean),
  });
}
