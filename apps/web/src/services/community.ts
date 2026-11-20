import { characterPronoun } from '@app/shared';
import { buildCommunityMessages, communityFeedInput, communityMemberPostInput, communityMembersFill, errorText, isAbortError, samplerRequest, socialCharacterFill, socialNowFill, type CommunityPromptInput } from '@app/ai';
import {
  commentsFromDrafts, COMMUNITY_CATCH_UP_MS, communityFromDraft, communityInfoText, communityJobs, communityPostMemory, communityPostText, isNetizen, MOMENT_USER, netizenName,
  parseCommunityBatch, parseCommunityDraft, parseCommunityReaction, parseMemberReaction, postsFromDrafts, shiftDate, socialDayText, zonedDateKey,
  type Character, type Community, type CommunityContext, type CommunityImageMoment, type CommunityPost, type MomentImage, type Preset,
} from '@app/shared';
import { onRemote } from '@/db/idb';
import { putAsset } from './assets';
import { describePhoto } from './photos';
import { MissingPresetError } from './prompt';
import { awakeOf, dayOf, memoriesText, momentNames, socialApiStatus, socialContextOf, socialPersona, userNameFor } from './social';
import { services } from '@/services';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useCommunityStore } from '@/stores/community';
import { useEnvironmentStore } from '@/stores/environment';
import { useGalleryStore } from '@/stores/gallery';
import { useHubStore } from '@/stores/hub';
import { useLibraryStore } from '@/stores/library';
import { useMemoryStore } from '@/stores/memory';
import { uid } from '@/utils/id';

/**
 * 社群要调模型的事（"社媒"的 API + "社媒 · 社群"预设）：
 * - 搜不到社群时按关键字建一个；
 * - 网友发一批帖子（云端每天在随机的时间发，这里是你点"看看新帖"、或者云端没接通时 App 开着替它发）；
 * - 你发了帖、回了话：网友点赞、顶帖、回复，你邀请进来的角色也各自回应；
 * - 你邀请进来的角色自己发帖；
 * - 帖子要配的图交给生图画；你发的照片先交给识图看一遍；
 * - 邀请角色进社群、她在社群里发的帖、你发的帖，都写进她的记忆。
 */

// —— 名字 ——

/** id → 名字（你、角色、网友）；characterId：按这个角色眼里你的名字 */
export function communityNames(characterId?: string): (id: string) => string {
  const known = momentNames(characterId);
  return (id) => (isNetizen(id) ? netizenName(id) : known(id));
}

/** 社群里还在的角色（你邀请进来的） */
export function membersOf(c: Pick<Community, 'members'>): Character[] {
  const chars = useCharacterStore();
  return c.members.flatMap((id) => chars.byId(id) ?? []);
}

/**
 * 你和角色的名字 → id：模型不能替这些人发帖、回复，网友也不能用这些名字。
 * 所有角色都算（还没进这个社群的也不能被冒名），你的名字按默认人设和每个角色眼里的都算上
 */
function knownNames(): Record<string, string> {
  const chars = useCharacterStore().list;
  return {
    ...Object.fromEntries(chars.map((m) => [m.name, m.id])),
    ...Object.fromEntries([socialPersona().name, ...chars.map((m) => userNameFor(m.id))].map((name) => [name, MOMENT_USER])),
  };
}

/** 云端只知道这个社群里的人：网友用了别的角色、你别的人设的名字的帖子和回复，收到时丢掉 */
function withoutImpostors(list: CommunityPost[]): CommunityPost[] {
  const known = knownNames();
  const fake = (id: string) => isNetizen(id) && !!known[netizenName(id)];
  return list.filter((p) => !fake(p.authorId)).map((p) => ({ ...p, comments: (p.comments ?? []).filter((c) => !fake(c.authorId)) }));
}

/**
 * 这个社群最近的几帖写成文字（进提示词），几帖按设置里的"给模型看最近几帖"。
 * except：这一帖不算（正要回应的那帖）；characterId：按这个角色眼里你的名字
 */
export function communityFeedText(communityId: string, opts: { except?: string; characterId?: string } = {}): string {
  const store = useCommunityStore();
  const n = store.settings.contextPosts;
  if (!n) return '';
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = communityNames(opts.characterId);
  return store
    .timelineOf(communityId)
    .filter((p) => p.id !== opts.except)
    .slice(-n)
    .map((p) => communityPostText(p, names, { timeZone, comments: 2, textMax: 200 }))
    .join('\n');
}

/**
 * 社群记忆候选：她在哪些社群里（和你互关），
 * 和每个社群最近三天的几帖（几帖按设置里的"聊天时带最近几帖"）——由记忆拼装器按相关性和总预算选择
 */
export function communityMemoryLines(character: Character): { text: string; at: number | null }[] {
  const store = useCommunityStore();
  const mine = store.communitiesOf(character.id);
  if (!mine.length) return [];
  const since = Date.now() - 3 * 86_400_000;
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = communityNames(character.id);
  const max = store.settings.chatPosts;
  return mine.flatMap((c) => {
    const recent = max ? store.timelineOf(c.id).filter((p) => p.createdAt >= since) : [];
    // 你和她的帖优先（带回复）；不够这个数，用网友最新的补（只带一行）
    const ours = recent.filter((p) => !isNetizen(p.authorId)).slice(-max);
    const others = ours.length < max ? recent.filter((p) => isNetizen(p.authorId)).slice(ours.length - max) : [];
    const lines = [...others, ...ours]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((p) => ({ text: `「${c.name}」：${communityPostText(p, names, isNetizen(p.authorId) ? { timeZone, comments: 0, textMax: 80 } : { timeZone, comments: 4, textMax: 300 })}`, at: p.createdAt }));
    return [{ text: `「${c.name}」：${c.description}`, at: null }, ...lines];
  });
}

// —— 能不能调 ——

/** 使用"社群"用途选中的预设。 */
export function communityPreset(): Preset | undefined {
  return useLibraryStore().presetForUse('community');
}

/** 社群能不能调模型（"社媒"的 API 接通了、有社群预设）；不能时说明原因 */
export function communityStatus(): { ok: true } | { ok: false; reason: string } {
  const api = socialApiStatus();
  if (!api.ok) return api;
  if (!communityPreset()) return { ok: false, reason: new MissingPresetError('社媒 · 社群').message };
  return { ok: true };
}

type Result<T> = ({ ok: true } & T) | { ok: false; reason: string };

/** 调一次"社媒"的 API：按社群预设拼这一次的任务（采样参数、输出上限都按预设），按 parse 读 JSON */
async function ask<T>(input: CommunityPromptInput, preset: Preset, parse: (value: unknown) => T | null) {
  return useAiStore().system.json('social', { messages: buildCommunityMessages(input, preset), ...samplerRequest(preset.sampler) }, parse);
}

/** 一件事同时只做一次：做的时候 busy[key] 为真，没做成的原因记在 failures[key] */
async function guarded<T>(key: string, work: () => Promise<Result<T>>, busyReason: string): Promise<Result<T>> {
  const store = useCommunityStore();
  if (store.busy[key]) return { ok: false, reason: busyReason };
  store.busy[key] = true;
  delete store.failures[key];
  try {
    const out = await work();
    if (!out.ok) store.failures[key] = out.reason;
    return out;
  } catch (e) {
    const reason = errorText(e);
    if (!isAbortError(e)) store.failures[key] = reason;
    return { ok: false, reason };
  } finally {
    delete store.busy[key];
  }
}

// —— 建社群 ——

/** 搜不到时按关键字建一个社群（名字、简介、风气、标签、图标），放进列表；还没加入 */
export function createCommunity(keyword: string): Promise<Result<{ community: Community }>> {
  const word = keyword.trim();
  return guarded('create', async () => {
    const status = communityStatus();
    if (!status.ok) return status;
    if (!word) return { ok: false, reason: '先写一个关键字' };
    const store = useCommunityStore();
    const preset = communityPreset()!;
    const timeZone = useEnvironmentStore().settings.timezone;
    const userName = socialPersona().name;
    const existing = store.communities.map((c) => c.name).join('、');
    const now = Date.now();
    const { value, result } = await ask({
      task: 'community-create', characterName: '', userName, communityName: '', now: new Date(now), timeZone,
      fills: {
        socialNow: socialNowFill(now, timeZone).text,
        socialAsk: `这一次：${userName}搜了「${word}」，没有对应的社群。按这个关键字建一个。${existing ? `\n已有的社群（名字不要重复）：${existing}` : ''}`,
      },
    }, preset, parseCommunityDraft);
    return { ok: true, community: store.addCommunity(communityFromDraft(value, { id: uid('community'), now, source: 'generated', joined: false, keyword: word, model: result.model })) };
  }, '正在建上一个社群');
}

// —— 网友发帖、角色发帖 ——

/** 发帖要的输入（按社群）：社群的介绍、设置、你邀请进来的角色、最近的帖子 */
function contextOf(c: Community, preset: Preset | null): CommunityContext {
  const store = useCommunityStore();
  const env = useEnvironmentStore().settings;
  const { perDay, batchSize, memberPerDay, notify } = store.settings;
  return {
    community: { id: c.id, name: c.name, description: c.description, vibe: c.vibe, tags: c.tags, memberCount: c.memberCount },
    userName: socialPersona().name,
    timezone: env.timezone,
    settings: { perDay, batchSize, memberPerDay, notify },
    awake: { from: env.wakeTime, to: env.sleepTime },
    members: membersOf(c).map((m) => ({ id: m.id, name: m.name })),
    feed: communityFeedText(c.id),
    preset,
    preview: useHubStore().config.preview,
  };
}

/** 上传云端的那份（按社群）；没加入、没有社群预设时为空 */
export function communityCloudContext(communityId: string): CommunityContext | null {
  const store = useCommunityStore();
  const c = store.byId(communityId);
  if (!c?.joined || !store.ready) return null;
  const preset = communityPreset();
  return preset ? contextOf(c, preset) : null;
}

/** 新放进来的帖子：角色发的记进她的记忆，要配的图画出来 */
function afterAdded(list: CommunityPost[]) {
  const chars = useCharacterStore();
  for (const p of list) {
    if (chars.byId(p.authorId)) rememberPost(p.id, p.authorId);
    if (p.images.some((i) => !i.assetKey && !i.photo)) void drawPostImage(p.id, 0, 'auto');
  }
}

/**
 * 让网友现在发一批帖子（在手机上生成）。opts.id：按排好的时间发的那一批，id 和云端的算法一样，两边不会各发一份
 */
export function refreshCommunity(communityId: string, opts: { id?: string } = {}): Promise<Result<{ posts: CommunityPost[] }>> {
  return guarded(`feed:${communityId}`, async () => {
    const store = useCommunityStore();
    const c = store.byId(communityId);
    if (!c) return { ok: false, reason: '找不到这个社群' };
    const status = communityStatus();
    if (!status.ok) return status;
    const preset = communityPreset()!;
    const context = contextOf(c, preset);
    const now = Date.now();
    const { value, result } = await ask(communityFeedInput(context, now), preset, parseCommunityBatch);
    const posts = store.addPosts(postsFromDrafts(value.slice(0, context.settings.batchSize), {
      communityId, batchId: opts.id ?? uid('cpost'), now, source: 'device', model: result.model, known: knownNames(),
      // 排好的时间自己发的算没看过；你点的那批就在眼前
      unread: !!opts.id,
    }));
    if (!posts.length) return { ok: false, reason: '模型没有写出能用的帖子，再试一次' };
    afterAdded(posts);
    return { ok: true, posts };
  }, '正在刷新');
}

/** 让这个角色在社群里发一帖（在手机上生成）：按她今天的节律、记得的事、最近的聊天和社群最近的帖子 */
export function memberPost(communityId: string, characterId: string, opts: { id?: string } = {}): Promise<Result<{ post: CommunityPost }>> {
  return guarded(`member:${communityId}:${characterId}`, async () => {
    const store = useCommunityStore();
    const c = store.byId(communityId);
    const ch = useCharacterStore().byId(characterId);
    if (!c || !ch || !c.members.includes(characterId)) return { ok: false, reason: `${characterPronoun(ch)}不在这个社群里` };
    const status = communityStatus();
    if (!status.ok) return status;
    const preset = communityPreset()!;
    const now = Date.now();
    const { value, result } = await ask(communityMemberPostInput({ ...contextOf(c, preset), feed: communityFeedText(c.id, { characterId: ch.id }) }, socialContextOf(ch, null), now), preset, parseCommunityBatch);
    const [post] = store.addPosts(postsFromDrafts(value.slice(0, 1), {
      communityId, batchId: opts.id ?? uid('cpost'), now, source: 'device', model: result.model, known: knownNames(), authorId: ch.id, unread: !!opts.id,
    }));
    if (!post) return { ok: false, reason: '模型没有写出能用的帖子，再试一次' };
    afterAdded([post]);
    return { ok: true, post };
  }, `${characterPronoun(useCharacterStore().byId(characterId))}正在发`);
}

/**
 * 云端没接通（或者 Worker 是旧版）时，App 开着也替网友和角色发：和云端同一套随机时间（communityJobs），
 * 到点、还在补发窗口里（COMMUNITY_CATCH_UP_MS）、这一格还没发过就发。云端接通后这里什么都不做，交给云端
 */
async function localTick() {
  const hub = useHubStore();
  const store = useCommunityStore();
  if (!store.ready || (hub.connected && (hub.supportsCommunity || !hub.status))) return;
  if (!communityStatus().ok) return;
  const now = Date.now();
  const env = useEnvironmentStore().settings;
  const today = zonedDateKey(now, env.timezone);
  for (const c of store.joined) {
    const members = membersOf(c).map((m) => ({ id: m.id, awake: awakeOf(dayOf(m.id)) }));
    for (const date of [shiftDate(today, -1), today]) {
      for (const job of communityJobs({ communityId: c.id, date, timezone: env.timezone, settings: store.settings, awake: { from: env.wakeTime, to: env.sleepTime }, members })) {
        // 帖子的 id 是这一格的 id 加上第几帖：发过、删过第一帖就算这一格做过了
        const first = `${job.id}:0`;
        if (job.dueAt > now || now - job.dueAt >= COMMUNITY_CATCH_UP_MS || store.postById(first) || store.removed.includes(first) || localTried.has(job.id)) continue;
        // 一格只试一次：失败了不在这里反复重试（社群页里可以点"看看新帖"）
        localTried.add(job.id);
        if (job.kind === 'feed') await refreshCommunity(c.id, { id: job.id });
        else if (job.characterId) await memberPost(c.id, job.characterId, { id: job.id });
      }
    }
  }
}
const localTried = new Set<string>();
let scheduleStarted = false;

export function startCommunitySchedule() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  // Key 只存在各自的设备上，帖子连同配图的失败原因却会多设备同步：别的设备自动画失败的图，这台设备用自己的生图 API 再自动画一次
  const store = useCommunityStore();
  onRemote('communityPosts', (changes) => {
    for (const c of changes) {
      const p = c.deleted ? undefined : store.postById(c.key);
      if (p?.images[0]?.error) void drawPostImage(p.id, 0, 'auto');
    }
  });
  // 等云端状态同步回来再看要不要自己发
  setTimeout(() => void localTick(), 45_000);
  setInterval(() => void localTick(), 5 * 60_000);
}

/** 云端发来的帖子：放进来、角色发的记进记忆、把要配的图画出来 */
export function receiveHubPosts(list: CommunityPost[]): CommunityPost[] {
  const added = useCommunityStore().addPosts(withoutImpostors(list).map((p) => ({ ...p, liked: p.liked ?? [], bumped: p.bumped ?? [], images: p.images ?? [], unread: true })));
  afterAdded(added);
  return added;
}

// —— 配图 ——

/** 这台设备这次打开以来自动画过的图（`image:帖子:第几张`） */
const autoTried = new Set<string>();

/**
 * 画这一帖的第 index 张图（发帖时模型写了画面，这里交给生图）：用"社群配图"的生图预设。
 * 角色发的帖按她的长相画；网友发的不属于哪个角色，自由画。
 * auto：收到云端发的、刚生成完时自动画，守着"自动画"的规矩（NovelAI 只在不花点的设置下画）；user：你点的
 */
export async function drawPostImage(postId: string, index = 0, priority: 'user' | 'auto' = 'user', opts: { redo?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const store = useCommunityStore();
  const key = `image:${postId}:${index}`;
  const p = store.postById(postId);
  const img = p?.images[index];
  if (!p || !img) return { ok: false, reason: '找不到这张图了' };
  if (img.photo) return { ok: false, reason: '拍的照片不能重画' };
  if (store.busy[key]) return { ok: false, reason: '正在画这张' };
  if ((img.assetKey || img.url) && !opts.redo) return { ok: true };
  if (priority === 'auto') {
    if (!store.settings.autoImage) return { ok: false, reason: '自动画关着' };
    // 每张图这台设备只自动画一次：两台设备都画不出来时，失败结果互相同步过去也不会来回重画
    if (autoTried.has(key)) return { ok: false, reason: '这台设备已经自动画过这张' };
    autoTried.add(key);
    const check = useGalleryStore().autoCheck({ ignoreSwitch: true });
    if (!check.ok) {
      img.error = check.reason;
      return { ok: false, reason: check.reason };
    }
  }
  const author = useCharacterStore().byId(p.authorId);
  const moment: CommunityImageMoment = author ? 'community-member' : 'community-netizen';
  const recent = [p.title, p.text].filter(Boolean).join('：');
  store.busy[key] = true;
  delete img.error;
  try {
    const out = await services.image.illustrate(
      {
        // 社群的配图始终参考节律里的衣着（不看服装参考开关）
        characterId: author?.id ?? '', caption: img.caption, use: 'community-image', moment, outfitRef: true,
        ...(author ? {} : { free: true, authorName: communityNames()(p.authorId) }),
        ...(recent ? { recent: [`这一帖：${recent.slice(0, 300)}`] } : {}),
      },
      { priority },
    );
    // await 之后按 id 重新取（期间这一帖可能被删）
    const now = store.postById(postId)?.images[index];
    if (now) {
      Object.assign(now, { assetKey: out.assetKey }, { error: undefined });
      if (out.url) now.url = out.url;
      else delete now.url;
    }
    return { ok: true };
  } catch (e) {
    const reason = isAbortError(e) ? '取消了' : errorText(e);
    // 重画失败：原来那张还在，不在图上记错误
    const now = store.postById(postId)?.images[index];
    if (now && !isAbortError(e) && !opts.redo) now.error = reason;
    return { ok: false, reason };
  } finally {
    delete store.busy[key];
  }
}

// —— 回应 ——

/** 回应时都要的那几块：社群、认识的人、现在、别的帖子、这一帖 */
function reactFills(c: Community, p: CommunityPost, userName: string, characterId?: string) {
  const timeZone = useEnvironmentStore().settings.timezone;
  const others = communityFeedText(c.id, { except: p.id, characterId });
  return {
    communityInfo: communityInfoText(c),
    communityMembers: communityMembersFill(userName, membersOf(c)),
    socialNow: socialNowFill(Date.now(), timeZone).text,
    communityFeed: others ? `社群里别的帖子：\n${others}` : '',
    communityPost: `这一帖和下面的回复：\n${communityPostText(p, communityNames(characterId), { timeZone, comments: 12 })}`,
  };
}

/**
 * 网友回应一帖：
 * - new：你刚发的帖，网友点赞、顶帖、回复；
 * - reply：你在一帖下面回了话（target 是你回复的那个网友，没有就是直接回帖），那个人和别的网友接着说。
 */
export function netizensReact(postId: string, kind: 'new' | 'reply', target?: string): Promise<Result<object>> {
  return guarded(`react:${postId}`, async () => {
    const store = useCommunityStore();
    const p = store.postById(postId);
    const c = store.byId(p?.communityId);
    if (!p || !c) return { ok: false, reason: '这一帖不在了' };
    const status = communityStatus();
    if (!status.ok) return status;
    const preset = communityPreset()!;
    const userName = socialPersona().name;
    const names = communityNames();
    const said = [...p.comments].reverse().find((x) => x.authorId === MOMENT_USER)?.text ?? '';
    const { value } = await ask({
      task: 'community-react', characterName: '', userName, communityName: c.name, now: new Date(), timeZone: useEnvironmentStore().settings.timezone,
      fills: {
        ...reactFills(c, p, userName),
        socialAsk: kind === 'new'
          ? `这一次：${userName}刚发了这一帖。写网友们的回应：新增的赞和顶，还有回复。`
          : `这一次：${userName}在这一帖下面${target ? `回复了 ${names(target)}` : '回了帖'}：「${said}」。写${target ? `${names(target)}（别的网友也可以插一句）` : '网友们'}接下来的回复；likes、bumps 写 0。`,
      },
    }, preset, parseCommunityReaction);
    if (!store.postById(postId)) return { ok: true };
    if (kind === 'new') store.addCounts(postId, value);
    const comments = commentsFromDrafts(value.comments, { known: knownNames(), at: () => Date.now(), idPrefix: `${uid('cc')}:` });
    store.addComments(postId, comments);
    const now = store.postById(postId);
    if (now && comments.length) now.unread = true;
    return { ok: true };
  }, '网友正在看');
}

/**
 * 你邀请进来的角色回应一帖：
 * - new：你刚发的帖，她点赞、顶帖、回复；
 * - reply：你回了她的话（或者在她的帖子下面回帖），她回你。
 */
export function memberReact(postId: string, characterId: string, kind: 'new' | 'reply'): Promise<Result<object>> {
  return guarded(`react:${postId}:${characterId}`, async () => {
    const store = useCommunityStore();
    const p = store.postById(postId);
    const c = store.byId(p?.communityId);
    const ch = useCharacterStore().byId(characterId);
    if (!p || !c || !ch) return { ok: false, reason: '这一帖不在了' };
    const status = communityStatus();
    if (!status.ok) return status;
    const preset = communityPreset()!;
    const userName = userNameFor(characterId);
    const timeZone = useEnvironmentStore().settings.timezone;
    const chat = useChatStore().chatOfCharacter(characterId);
    const day = dayOf(characterId);
    const at = socialNowFill(Date.now(), timeZone);
    const mine = p.authorId === characterId;
    const said = [...p.comments].reverse().find((x) => x.authorId === MOMENT_USER)?.text ?? '';
    const { value } = await ask({
      task: 'community-member-react', characterName: ch.name, pronoun: ch.pronoun, userName, communityName: c.name, now: new Date(), timeZone,
      fills: {
        ...reactFills(c, p, userName, characterId),
        socialCharacter: socialCharacterFill({ id: ch.id, name: ch.name, pronoun: ch.pronoun, card: ch.card }, userName),
        socialLife: day ? socialDayText(day, at.minute) : '',
        socialMemories: memoriesText(ch, userName),
        socialRecent: chat ? `最近的聊天：\n${useChatStore().recentLines(chat.id, 8).join('\n')}` : '',
        socialAsk: kind === 'new'
          ? `这一次：${userName}刚在社群里发了这一帖，${ch.name}刷到了。决定点不点赞、要不要顶帖、要不要回复。`
          : `这一次：${userName}在${mine ? `${ch.name}的这一帖` : '这一帖'}下面对${ch.name}说了「${said}」，${ch.name}回复这一句（like、bump 写 false）。`,
      },
    }, preset, parseMemberReaction);
    if (!store.postById(postId)) return { ok: true };
    if (kind === 'new') {
      if (value.like) store.setLiked(postId, characterId, true);
      if (value.bump) store.setBumped(postId, characterId, true);
    }
    // 直接回你的帖不写"回复"；接你回复里的话才是回复你
    if (value.comment) store.comment(postId, characterId, value.comment, kind === 'reply' ? MOMENT_USER : undefined);
    const now = store.postById(postId);
    if (now && value.comment) now.unread = true;
    rememberPost(postId, characterId);
    return { ok: true };
  }, `${useCharacterStore().byId(characterId)?.name ?? 'Ta'}正在看`);
}

// —— 写进记忆 ——

/**
 * 把一帖记进这个角色的记忆（事件）：她自己发的、你发的才记（网友的帖子太多，只在聊天时带最新的一两帖）。
 * 第一次写一条新的，之后互动多了改同一条；你在记忆本里删掉、归档过这一条就不再动它
 */
export function rememberPost(postId: string, characterId: string) {
  const mem = useMemoryStore();
  const store = useCommunityStore();
  const p = store.postById(postId);
  const c = store.byId(p?.communityId);
  if (!p || !c || !mem.ready || !useCharacterStore().byId(characterId) || !c.members.includes(characterId)) return;
  if (p.authorId !== characterId && p.authorId !== MOMENT_USER) return;
  const content = communityPostMemory(p, c.name, characterId, communityNames(characterId), useEnvironmentStore().settings.timezone);
  const known = p.memoryIds?.[characterId];
  if (known) {
    const old = mem.memoryById(known);
    if (old && !old.deleted && old.status === 'active' && old.content !== content) mem.updateMemory(known, { content, vector: null });
    return;
  }
  const now = Date.now();
  const id = uid('mem');
  mem.addMemory({
    id, characterId, chatId: useChatStore().chatOfCharacter(characterId)?.id, type: 'event', content,
    // 你发的、有来有往的更值得记
    importance: p.authorId === MOMENT_USER ? 4 : 3,
    pinned: false, status: 'active', dueAt: null, sourceMessageIds: [], happenedAt: p.createdAt, vector: null, lastRecalledAt: null, recallCount: 0,
    createdAt: now, updatedAt: now,
  });
  p.memoryIds = { ...(p.memoryIds ?? {}), [characterId]: id };
}

/** 邀请这件事对她来说要记住的一句话；left：后来退出了 */
function membershipMemory(c: Community, ch: Character, joinedAt: number, left: boolean): string {
  const user = userNameFor(ch.id);
  const day = new Intl.DateTimeFormat('zh-CN', { timeZone: useEnvironmentStore().settings.timezone, month: 'numeric', day: 'numeric' }).format(new Date(joinedAt));
  const base = `${day} ${user}邀请${ch.name}加入了社群「${c.name}」（${c.description}）`;
  return left ? `${base}；后来${ch.name}退出了这个社群` : `${base}。${ch.name}和${user}在这个社群里互相关注，${ch.name}也会在里面发帖、回${user}的帖`;
}

/** 邀请一个角色加入社群：她成了成员（和你互关，会自己发帖、回应你），这件事写进她的记忆 */
export function inviteMember(communityId: string, characterId: string) {
  const store = useCommunityStore();
  const mem = useMemoryStore();
  const c = store.byId(communityId);
  const ch = useCharacterStore().byId(characterId);
  if (!c || !ch || c.members.includes(characterId)) return;
  store.setMember(communityId, characterId, true);
  if (!mem.ready) return;
  const now = Date.now();
  const id = uid('mem');
  mem.addMemory({
    id, characterId, chatId: useChatStore().chatOfCharacter(characterId)?.id, type: 'event', content: membershipMemory(c, ch, now, false),
    importance: 5, pinned: false, status: 'active', dueAt: null, sourceMessageIds: [], happenedAt: now, vector: null, lastRecalledAt: null, recallCount: 0,
    createdAt: now, updatedAt: now,
  });
  store.patchCommunity(communityId, { memoryIds: { ...(c.memoryIds ?? {}), [characterId]: id } });
}

/** 把一个角色请出社群：她不再在里面发帖、回应；记忆里那一条改成"后来退出了" */
export function removeMember(communityId: string, characterId: string) {
  const store = useCommunityStore();
  const mem = useMemoryStore();
  const c = store.byId(communityId);
  const ch = useCharacterStore().byId(characterId);
  if (!c || !c.members.includes(characterId)) return;
  store.setMember(communityId, characterId, false);
  const known = c.memoryIds?.[characterId];
  const old = known && mem.ready ? mem.memoryById(known) : undefined;
  if (ch && old && !old.deleted && old.status === 'active') mem.updateMemory(old.id, { content: membershipMemory(c, ch, old.happenedAt ?? old.createdAt, true), vector: null });
  const { [characterId]: _gone, ...rest } = c.memoryIds ?? {};
  store.patchCommunity(communityId, { memoryIds: rest });
}

// —— 你发帖、回帖、点赞、顶帖 ——

export interface UserPostInput {
  communityId: string;
  title: string;
  text: string;
  /** 压缩好的照片 */
  photos: { bytes: Uint8Array<ArrayBuffer>; mime: string }[];
}

/**
 * 你在社群里发一帖：照片存进本机素材库 → 发出来 → 识图把照片看一遍（接通了的话）→ 网友点赞、顶帖、回复，
 * 你邀请进来的角色也各自回应。发出来就返回；识图和回应在后面慢慢来
 */
export async function publishUserPost(input: UserPostInput): Promise<CommunityPost | undefined> {
  const store = useCommunityStore();
  const keys = await Promise.all(input.photos.map((p) => putAsset(p.bytes, p.mime)));
  const now = Date.now();
  const images: MomentImage[] = keys.map((assetKey) => ({ caption: '', assetKey, photo: true }));
  const title = input.title.trim();
  const [post] = store.addPosts([{
    id: uid('cpost'), communityId: input.communityId, authorId: MOMENT_USER, ...(title ? { title } : {}), text: input.text.trim(), images,
    likes: 0, liked: [], bumps: 0, bumped: [], comments: [], createdAt: now, updatedAt: now, bumpedAt: now, source: 'user',
  }]);
  if (post) void afterUserPost(post.id);
  return post;
}

async function afterUserPost(postId: string) {
  const store = useCommunityStore();
  const p = store.postById(postId);
  const c = store.byId(p?.communityId);
  if (!p || !c) return;
  const members = membersOf(c);
  // 照片先看一遍：网友和她们才知道照片里有什么（识图没接通就只知道"发了一张照片"）
  if (useAiStore().isLive('vision')) {
    await Promise.allSettled(p.images.map(async (img, i) => {
      if (!img.photo || !img.assetKey) return;
      const seen = (await describePhoto(img.assetKey, members[0])).text;
      const now = store.postById(postId)?.images[i];
      if (now) now.seen = seen.slice(0, 600);
    }));
  }
  for (const m of members) rememberPost(postId, m.id);
  await Promise.allSettled([netizensReact(postId, 'new'), ...members.map((m) => memberReact(postId, m.id, 'new'))]);
}

/**
 * 你回帖：写进去，然后该回的人回你——
 * 回复的是角色（或者在她的帖子下面直接回帖）：她回；回复的是网友（或者在网友的帖子下面直接回帖）：那个网友和别人接着说；
 * 在自己的帖子下面直接回帖：不触发谁
 */
export function userReply(postId: string, text: string, replyTo?: string) {
  const store = useCommunityStore();
  const p = store.postById(postId);
  const c = store.byId(p?.communityId);
  if (!p || !c || !store.comment(postId, MOMENT_USER, text, replyTo)) return;
  const target = replyTo && replyTo !== MOMENT_USER ? replyTo : p.authorId !== MOMENT_USER ? p.authorId : null;
  for (const m of membersOf(c)) rememberPost(postId, m.id);
  if (!target) return;
  if (isNetizen(target)) void netizensReact(postId, 'reply', replyTo && isNetizen(replyTo) ? replyTo : undefined);
  else if (c.members.includes(target)) void memberReact(postId, target, 'reply');
}

/** 你点赞 / 取消 */
export function userLikePost(postId: string) {
  const store = useCommunityStore();
  const p = store.postById(postId);
  const c = store.byId(p?.communityId);
  if (!p || !c) return;
  store.setLiked(postId, MOMENT_USER, !p.liked.includes(MOMENT_USER));
  for (const m of membersOf(c)) rememberPost(postId, m.id);
}

/** 你顶帖 / 取消：顶了就把这一帖顶到最上面（按"最近顶起"排时） */
export function userBumpPost(postId: string) {
  const store = useCommunityStore();
  const p = store.postById(postId);
  const c = store.byId(p?.communityId);
  if (!p || !c) return;
  store.setBumped(postId, MOMENT_USER, !p.bumped.includes(MOMENT_USER));
  for (const m of membersOf(c)) rememberPost(postId, m.id);
}
