import { buildSocialMessages, errorText, isAbortError, samplerRequest, socialCharacterFill, socialNowFill, socialPostInput } from '@app/ai';
import {
  AGENT_META, getLocation, hubMomentId, MOMENT_USER, momentDueTimes, momentMemory, momentText, parseMomentDraft, parseMomentReaction, shiftDate, socialDayOf, socialDayText, socialPerDay, zonedDateKey,
  textFn, type Character, type Moment, type MomentImage, type Preset, type SocialContext, type SocialDay, type TextFn,
} from '@app/shared';
import { onRemote } from '@/db/idb';
import { putAsset } from './assets';
import { memoryBlocks } from './memoryBlocks';
import { describePhoto } from './photos';
import { MissingPresetError, personaOf } from './prompt';
import { services } from '@/services';
import { DEMO_REACTIONS, demoMoments } from '@/mock/moments';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useCommunityStore } from '@/stores/community';
import { useEnvironmentStore } from '@/stores/environment';
import { useGalleryStore } from '@/stores/gallery';
import { useHubStore } from '@/stores/hub';
import { textsFor, useLibraryStore, withTexts } from '@/stores/library';
import { useMemoryStore } from '@/stores/memory';
import { usePersonaStore } from '@/stores/personas';
import { useRhythmStore } from '@/stores/rhythm';
import { useSocialStore } from '@/stores/social';
import { pick, sleep, uid } from '@/utils/id';

/**
 * 朋友圈要调模型的事（"社媒"的 API + "社媒 · 朋友圈"预设）：
 * - 让她发一条（云端每天在随机的时间发，这里是你在朋友圈页里点"让她发一条"时在手机上发）；
 * - 你发了朋友圈：看得到的角色各自点赞、评论；你在评论里跟她说话，她回你；
 * - 要配的图交给生图画（画好存进本机素材库）；你发的照片先交给识图看一遍，她们才知道照片里有什么；
 * - 每条朋友圈写进记忆：她自己发的、你发的她看得到的，各记成一条"事件"，互动多了改同一条。
 */

// —— 名字、文字 ——

/** 朋友圈里你用的人设：默认人设（朋友圈不属于哪一条聊天） */
export function socialPersona() {
  return usePersonaStore().defaultPersona;
}

/** 这个角色眼里你的名字：按和她那条聊天选的人设 */
export function userNameFor(characterId: string): string {
  const chat = useChatStore().chatOfCharacter(characterId);
  return chat ? personaOf(chat).name : socialPersona().name;
}

/** id → 名字（MOMENT_USER 是你） */
export function momentNames(characterId?: string): (id: string) => string {
  const user = characterId ? userNameFor(characterId) : socialPersona().name;
  const chars = useCharacterStore();
  return (id) => (id === MOMENT_USER ? user : (chars.byId(id)?.name ?? '已删除的角色'));
}

/** 这个角色看得到的最近几条朋友圈，写成文字（进提示词）；except：这一条不算（正要回应的那条） */
export function feedText(characterId: string, t: TextFn, n = 6, except?: string): string {
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = momentNames(characterId);
  return useSocialStore()
    .visibleTo(characterId)
    .filter((m) => m.id !== except)
    .slice(-n)
    .map((m) => momentText(m, names, t, { timeZone, comments: 4 }))
    .join('\n');
}

/** 最近三天的朋友圈候选（最多 4 条），由记忆拼装器按相关性和总预算选择。 */
export function recentMomentsLines(character: Character, t: TextFn): { text: string; at: number }[] {
  const since = Date.now() - 3 * 86_400_000;
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = momentNames(character.id);
  const list = useSocialStore().visibleTo(character.id).filter((m) => m.createdAt >= since).slice(-4);
  return list.map((m) => ({ text: momentText(m, names, t, { timeZone, comments: 4 }), at: m.createdAt }));
}

// —— 发朋友圈要的输入 ——

/** 她今天的节律（地点换成名字）；没有节律（没建世界）时为空 */
export function dayOf(characterId: string): SocialDay | null {
  const day = useRhythmStore().todayOf(characterId);
  return day ? socialDayOf(day, (id) => getLocation(id)?.name ?? id) : null;
}

/** 她醒着的时段：节律里今天第一件不是睡觉的事开始，到最后一件结束；没有节律按你的作息 */
export function awakeOf(day: SocialDay | null): { from: string; to: string } {
  const env = useEnvironmentStore().settings;
  const up = (day?.schedule ?? []).filter((s) => !/睡|sleep/i.test(s.status) && s.from >= '04:00');
  if (!up.length) return { from: env.wakeTime, to: env.sleepTime };
  const from = up.reduce((a, s) => (s.from < a ? s.from : a), '23:59');
  // 过了半夜才结束的（to 比 from 小）算到 23:59
  const to = up.some((s) => s.to <= s.from) ? '23:59' : up.reduce((a, s) => (s.to > a ? s.to : a), '00:00');
  return { from, to };
}

/** 她记得的关于你的事：画像卡 + 关系 + 置顶的和最重要的记忆（不带"最近的朋友圈"和社群，那两块单独给） */
export function memoriesText(c: Character, t: TextFn): string {
  const timeZone = useEnvironmentStore().settings.timezone;
  const blocks = memoryBlocks(undefined, c, Date.now(), timeZone, { proactive: true, moments: false, t });
  return [blocks.summary.content, blocks.memory.content].filter(Boolean).join('\n\n');
}

/**
 * 发一条朋友圈要的输入（按角色）：角色卡、今天的节律、记得的事、最近的聊天和朋友圈。
 * 她在社群里发帖、回应时也用这一份（只用角色、节律、记忆、聊天那几项）
 */
export function socialContextOf(c: Character, raw: Preset | null, opts: { /** 自己发不发朋友圈（上传云端的那份按设置；手动让她发时不看） */ enabled?: boolean } = {}): SocialContext {
  // 预设带上合好的程序文字：这里拼的几块、云端拼的都按它写
  const preset = withTexts(raw);
  const t = textFn(preset?.texts ?? textsFor(null));
  const chat = useChatStore().chatOfCharacter(c.id);
  const userName = userNameFor(c.id);
  const day = dayOf(c.id);
  return {
    character: { id: c.id, name: c.name, pronoun: c.pronoun, card: c.card },
    userName,
    timezone: useEnvironmentStore().settings.timezone,
    settings: { enabled: opts.enabled ?? true, perDay: socialPerDay(useSocialStore().characterSettings(c.id)) },
    awake: awakeOf(day),
    day,
    memories: memoriesText(c, t),
    recent: chat ? useChatStore().recentLines(chat.id, 12).join('\n') : '',
    feed: feedText(c.id, t),
    preset,
    preview: useHubStore().config.preview,
  };
}

/**
 * 上传云端的那份（按角色）。两种情况要传：她自己发朋友圈（没有朋友圈预设时不发）；
 * 她在你加入的社群里、会自己发帖（云端替她在社群发帖时用这一份里的角色卡、节律、记忆和聊天）。都不是时为空
 */
export function socialCloudContext(characterId: string): SocialContext | null {
  const c = useCharacterStore().byId(characterId);
  const social = useSocialStore();
  const community = useCommunityStore();
  if (!c || !social.ready) return null;
  const preset = momentsPreset(c) ?? null;
  const posting = social.characterSettings(characterId).enabled && !!preset;
  // 旧版 Worker 不会替她在社群发帖，也不收没有朋友圈预设的上下文
  const inCommunity = useHubStore().supportsCommunity && community.ready && community.settings.memberPerDay > 0 && community.communitiesOf(characterId).length > 0;
  return posting || inCommunity ? socialContextOf(c, preset, { enabled: posting }) : null;
}

// —— 写进记忆 ——

/**
 * 把一条朋友圈记进这个角色的记忆（事件）：第一次写一条新的，之后互动多了改同一条。
 * 你在记忆本里删掉、归档过这一条就不再动它
 */
export function rememberMoment(momentId: string, characterId: string) {
  const mem = useMemoryStore();
  const m = useSocialStore().byId(momentId);
  if (!m || !mem.ready || !useCharacterStore().byId(characterId)) return;
  const c = useCharacterStore().byId(characterId);
  const content = momentMemory(m, characterId, momentNames(characterId), textFn(textsFor(momentsPreset(c))), useEnvironmentStore().settings.timezone);
  const known = m.memoryIds?.[characterId];
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
    importance: m.authorId === MOMENT_USER ? 4 : 3,
    pinned: false, status: 'active', dueAt: null, sourceMessageIds: [], happenedAt: m.createdAt, vector: null, lastRecalledAt: null, recallCount: 0,
    createdAt: now, updatedAt: now,
  });
  m.memoryIds = { ...(m.memoryIds ?? {}), [characterId]: id };
}

// —— 配图 ——

/** 这台设备这次打开以来自动画过的图（`image:朋友圈:第几张`） */
const autoTried = new Set<string>();

/**
 * 画这条朋友圈的第 index 张图（她发的：模型写了画面，这里交给生图）。
 * auto：收到云端发的、她刚发完时自动画，守着"自动画"的规矩（NovelAI 只在不花点的设置下画）；user：你点的。
 * redo：已经画好的再画一张换掉（新的画好之前旧的留着；拍的照片不重画）
 */
export async function drawMomentImage(momentId: string, index = 0, priority: 'user' | 'auto' = 'user', opts: { redo?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const social = useSocialStore();
  const key = `image:${momentId}:${index}`;
  const m = social.byId(momentId);
  const img = m?.images[index];
  if (!m || !img) return { ok: false, reason: '找不到这张图了' };
  if (img.photo) return { ok: false, reason: '拍的照片不能重画' };
  if (social.busy[key]) return { ok: false, reason: '正在画这张' };
  if ((img.assetKey || img.url) && !opts.redo) return { ok: true };
  const c = useCharacterStore().byId(m.authorId);
  if (!c) return { ok: false, reason: '找不到发这条的角色' };
  if (priority === 'auto') {
    if (!social.settings.autoImage) return { ok: false, reason: '自动画关着' };
    // 每张图这台设备只自动画一次：两台设备都画不出来时，失败结果互相同步过去也不会来回重画
    if (autoTried.has(key)) return { ok: false, reason: '这台设备已经自动画过这张' };
    autoTried.add(key);
    const check = useGalleryStore().autoCheck({ ignoreSwitch: true });
    if (!check.ok) {
      img.error = check.reason;
      return { ok: false, reason: check.reason };
    }
  }
  social.busy[key] = true;
  delete img.error;
  try {
    const out = await services.image.illustrate(
      // 朋友圈的配图始终参考节律里的衣着（不看服装参考开关）
      { characterId: c.id, caption: img.caption, use: 'image', place: m.location, outfitRef: true, recent: m.text ? [textFn(textsFor(useLibraryStore().presetForUse('image', c)))('image.recent.moment', { char: c.name, text: m.text })] : undefined },
      { priority },
    );
    // await 之后按 id 重新取（期间这条可能被删、被替换）
    const now = social.byId(momentId)?.images[index];
    if (now) {
      Object.assign(now, { assetKey: out.assetKey }, { error: undefined });
      if (out.url) now.url = out.url;
      else delete now.url;
    }
    return { ok: true };
  } catch (e) {
    const reason = isAbortError(e) ? '取消了' : errorText(e);
    // 重画失败：原来那张还在，不在图上记错误
    const now = social.byId(momentId)?.images[index];
    if (now && !isAbortError(e) && !opts.redo) now.error = reason;
    return { ok: false, reason };
  } finally {
    delete social.busy[key];
  }
}

// —— 她发一条 ——

export type SocialResult = { ok: true; moment: Moment } | { ok: false; reason: string };

/** 使用"朋友圈"用途选中的预设。 */
export function momentsPreset(character?: Character): Preset | undefined {
  const lib = useLibraryStore();
  return lib.withLorebooks(lib.presetForUse('social', character), character);
}

/** "社媒"的 API 能不能调；不能时说明原因（朋友圈和社群共用这个 API） */
export function socialApiStatus(): { ok: true } | { ok: false; reason: string } {
  const s = useAiStore().status('social');
  return s.live ? { ok: true } : { ok: false, reason: `「${AGENT_META.social.label}」的 API 还没接通：${s.reason}` };
}

/** 朋友圈能不能调模型（API 接通了、有朋友圈预设）；不能时说明原因 */
export function socialStatus(character?: Character): { ok: true } | { ok: false; reason: string } {
  const api = socialApiStatus();
  if (!api.ok) return api;
  if (!momentsPreset(character)) return { ok: false, reason: new MissingPresetError('社媒 · 朋友圈').message };
  return { ok: true };
}

/** 让她现在发一条朋友圈（在手机上生成）：按今天的节律、记得的事、最近的聊天和最近的朋友圈 */
export async function postMoment(characterId: string, opts: { /** 按排好的时间发的那一条：id 和云端的算法一样，两边不会各发一条 */ id?: string } = {}): Promise<SocialResult> {
  const social = useSocialStore();
  const c = useCharacterStore().byId(characterId);
  if (!c) return { ok: false, reason: '找不到这个角色' };
  const status = socialStatus(c);
  if (!status.ok) return status;
  const key = `post:${characterId}`;
  if (social.busy[key]) return { ok: false, reason: `${c.name}正在发` };
  const preset = momentsPreset(c)!;
  // 关了"自动发朋友圈"的角色也可以手动让她发一条
  const context = socialContextOf(c, preset);
  social.busy[key] = true;
  delete social.failures[key];
  try {
    const now = Date.now();
    const { value, result } = await useAiStore().system.json(
      'social',
      { messages: buildSocialMessages(socialPostInput(context, now), preset), ...samplerRequest(preset.sampler) },
      parseMomentDraft,
    );
    if (!useCharacterStore().byId(characterId)) return { ok: false, reason: '找不到这个角色' };
    const moment = social.add({
      id: opts.id ?? uid('moment'), authorId: c.id, text: value.text,
      images: value.image ? [{ caption: value.image, assetKey: null }] : [],
      ...(value.html ? { html: value.html, htmlTitle: value.htmlTitle || '单据' } : {}),
      ...(value.location ? { location: value.location } : {}),
      visibleTo: null, likes: [], comments: [], createdAt: now, updatedAt: now, source: 'device', model: result.model,
      // 排好的时间自己发的算没看过；你点的那条就在眼前
      ...(opts.id ? { unread: true } : {}),
    });
    rememberMoment(moment.id, c.id);
    if (moment.images.length) void drawMomentImage(moment.id, 0, 'auto');
    return { ok: true, moment };
  } catch (e) {
    const reason = errorText(e);
    social.failures[key] = reason;
    return { ok: false, reason };
  } finally {
    delete social.busy[key];
  }
}

/**
 * 云端没接通（或者 Worker 是旧版）时，App 开着也替她们发：和云端同一套随机时间（momentDueTimes），
 * 到点、还在 3 小时补发窗口里、这一条还没发过就发。云端接通后这里什么都不做，交给云端
 */
async function localTick() {
  const hub = useHubStore();
  const social = useSocialStore();
  if (!social.ready || (hub.connected && (hub.supportsSocial || !hub.status))) return;
  if (!useAiStore().isLive('social')) return;
  const now = Date.now();
  const timezone = useEnvironmentStore().settings.timezone;
  const today = zonedDateKey(now, timezone);
  for (const c of useCharacterStore().list) {
    const settings = social.characterSettings(c.id);
    if (!settings.enabled) continue;
    const awake = awakeOf(dayOf(c.id));
    for (const date of [shiftDate(today, -1), today]) {
      const due = momentDueTimes({ characterId: c.id, date, perDay: settings.perDay, awake, timezone });
      for (const [slot, at] of due.entries()) {
        const id = hubMomentId(c.id, date, slot);
        if (at > now || now - at >= 3 * 3_600_000 || social.byId(id) || social.removed.includes(id) || localTried.has(id)) continue;
        // 一条只试一次：失败了不在这里反复重试（朋友圈页里可以点"让她发一条"）
        localTried.add(id);
        await postMoment(c.id, { id });
      }
    }
  }
}
const localTried = new Set<string>();
let scheduleStarted = false;

export function startSocialSchedule() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  // 第一次：放几条演示动态（只放演示角色还在的那几条），朋友圈不至于空着
  const social = useSocialStore();
  if (social.ready && !social.seeded) {
    social.seeded = true;
    for (const m of demoMoments()) if (useCharacterStore().byId(m.authorId) && !social.byId(m.id)) social.add(m);
  }
  // Key 只存在各自的设备上，朋友圈连同配图的失败原因却会多设备同步：别的设备自动画失败的图，这台设备用自己的生图 API 再自动画一次
  onRemote('moments', (changes) => {
    for (const c of changes) {
      const m = c.deleted ? undefined : social.byId(c.key);
      if (m?.images[0]?.error) void drawMomentImage(m.id, 0, 'auto');
    }
  });
  // 等云端状态同步回来再看要不要自己发
  setTimeout(() => void localTick(), 30_000);
  setInterval(() => void localTick(), 5 * 60_000);
}

/** 云端发来的朋友圈：放进来、记进记忆、把要配的图画出来 */
export function receiveHubMoments(list: Moment[]): Moment[] {
  const added = useSocialStore().ingest(list);
  for (const m of added) {
    rememberMoment(m.id, m.authorId);
    if (m.images.some((i) => !i.assetKey && !i.photo)) void drawMomentImage(m.id, 0, 'auto');
  }
  return added;
}

// —— 她回应 ——

/**
 * 让这个角色回应一条朋友圈：
 * - new：你刚发的，她点赞、评论；
 * - reply：你在评论里跟她说了话（或者在她的朋友圈下评论），她回你。
 */
export async function reactToMoment(momentId: string, characterId: string, kind: 'new' | 'reply'): Promise<void> {
  const social = useSocialStore();
  const c = useCharacterStore().byId(characterId);
  const m = social.byId(momentId);
  if (!c || !m) return;
  const key = `react:${momentId}:${characterId}`;
  if (social.busy[key]) return;
  const status = socialStatus(c);
  if (!status.ok) {
    // 没接通：演示角色用占位台词回应（同别处的演示数据）；导入的角色不回应，朋友圈页顶上有一行提示
    const demo = DEMO_REACTIONS[characterId];
    if (!demo) return;
    social.busy[key] = true;
    await sleep(900 + Math.random() * 1500).catch(() => undefined);
    delete social.busy[key];
    if (!useCharacterStore().byId(characterId) || !social.byId(momentId)) return;
    if (kind === 'new') social.setLike(momentId, characterId, true);
    social.comment(momentId, characterId, pick(kind === 'new' ? demo.comment : demo.reply), kind === 'reply' ? MOMENT_USER : undefined);
    rememberMoment(momentId, characterId);
    return;
  }
  const preset = momentsPreset(c)!;
  const userName = userNameFor(characterId);
  const names = momentNames(characterId);
  const timeZone = useEnvironmentStore().settings.timezone;
  const chat = useChatStore().chatOfCharacter(characterId);
  const day = dayOf(characterId);
  const t = textFn(preset.texts);
  const at = socialNowFill(Date.now(), timeZone, t);
  const mine = m.authorId === characterId;
  const lastUser = [...m.comments].reverse().find((x) => x.authorId === MOMENT_USER);
  const ask = kind === 'new'
    ? t('social.ask.react', { user: userName, char: c.name })
    : t('social.ask.reply', { user: userName, char: c.name, mine, said: lastUser?.text ?? '' });
  const before = feedText(characterId, t, 4, momentId);
  social.busy[key] = true;
  delete social.failures[key];
  try {
    const { value } = await useAiStore().system.json(
      'social',
      {
        messages: buildSocialMessages({
          task: 'react', characterName: c.name, pronoun: c.pronoun, userName, now: new Date(), timeZone,
          fills: {
            socialCharacter: socialCharacterFill({ id: c.id, name: c.name, pronoun: c.pronoun, card: c.card }, userName, t),
            socialLife: day ? socialDayText(day, at.minute, t) : '',
            socialNow: at.text,
            socialMemories: memoriesText(c, t),
            socialRecent: chat ? t('social.recent', { recent: useChatStore().recentLines(chat.id, 8).join('\n') }) : '',
            socialFeed: before ? t('social.feedBefore', { feed: before }) : '',
            socialPost: t('social.post', { post: momentText(m, names, t, { timeZone, comments: 12 }) }),
            socialAsk: ask,
          },
        }, preset),
        ...samplerRequest(preset.sampler),
        maxTokens: Math.min(preset.sampler.maxTokens, 600),
      },
      parseMomentReaction,
    );
    if (!useCharacterStore().byId(characterId) || !social.byId(momentId)) return;
    if (kind === 'new' && value.like) social.setLike(momentId, characterId, true);
    // 直接评论你的朋友圈不写"回复"；接你评论里的话才是回复你
    if (value.comment) social.comment(momentId, characterId, value.comment, kind === 'reply' ? MOMENT_USER : undefined);
    const now = social.byId(momentId);
    if (now) now.unread = now.unread || !!value.comment;
    rememberMoment(momentId, characterId);
  } catch (e) {
    if (!isAbortError(e)) social.failures[key] = errorText(e);
  } finally {
    delete social.busy[key];
  }
}

// —— 你发、你评论 ——

export interface UserMomentInput {
  text: string;
  /** 压缩好的照片 */
  photos: { bytes: Uint8Array<ArrayBuffer>; mime: string }[];
  /** 哪些角色看得到；null = 都看得到 */
  visibleTo: string[] | null;
  location?: string;
}

/** 这条朋友圈哪些角色看得到（还在的角色） */
export function audienceOf(m: Pick<Moment, 'authorId' | 'visibleTo'>): string[] {
  const chars = useCharacterStore().list.map((c) => c.id);
  if (m.authorId !== MOMENT_USER) return chars.includes(m.authorId) ? [m.authorId] : [];
  return m.visibleTo === null ? chars : m.visibleTo.filter((id) => chars.includes(id));
}

/**
 * 你发一条朋友圈：照片存进本机素材库 → 发出来 → 识图把照片看一遍（接通了的话）→ 看得到的角色各自点赞、评论。
 * 发出来就返回；识图和她们的回应在后面慢慢来
 */
export async function publishUserMoment(input: UserMomentInput): Promise<Moment> {
  const social = useSocialStore();
  const keys = await Promise.all(input.photos.map((p) => putAsset(p.bytes, p.mime)));
  const now = Date.now();
  const images: MomentImage[] = keys.map((assetKey) => ({ caption: '', assetKey, photo: true }));
  const moment = social.add({
    id: uid('moment'), authorId: MOMENT_USER, text: input.text.trim(), images,
    ...(input.location?.trim() ? { location: input.location.trim() } : {}),
    visibleTo: input.visibleTo, likes: [], comments: [], createdAt: now, updatedAt: now, source: 'user',
  });
  void afterUserMoment(moment.id);
  return moment;
}

async function afterUserMoment(momentId: string) {
  const social = useSocialStore();
  const m = social.byId(momentId);
  if (!m) return;
  const audience = audienceOf(m);
  // 照片先看一遍：她们才知道照片里有什么（识图没接通就只知道"发了一张照片"）
  if (useAiStore().isLive('vision')) {
    const looker = useCharacterStore().byId(audience[0]);
    await Promise.allSettled(m.images.map(async (img, i) => {
      if (!img.photo || !img.assetKey) return;
      const seen = (await describePhoto(img.assetKey, looker)).text;
      const now = social.byId(momentId)?.images[i];
      if (now) now.seen = seen.slice(0, 600);
    }));
  }
  for (const id of audience) rememberMoment(momentId, id);
  await Promise.allSettled(audience.map((id) => reactToMoment(momentId, id, 'new')));
}

/**
 * 你点评论：写进去，然后该回的那个角色回你——
 * 在她的朋友圈下：她回；在你自己的朋友圈下回复某个角色：那个角色回；直接评论自己的朋友圈：不触发谁
 */
export function userComment(momentId: string, text: string, replyTo?: string) {
  const social = useSocialStore();
  const m = social.byId(momentId);
  if (!m || !social.comment(momentId, MOMENT_USER, text, replyTo)) return;
  const target = m.authorId !== MOMENT_USER ? m.authorId : replyTo && replyTo !== MOMENT_USER ? replyTo : null;
  for (const id of audienceOf(m)) rememberMoment(momentId, id);
  if (target && audienceOf(m).includes(target)) void reactToMoment(momentId, target, 'reply');
}

/** 你给她的朋友圈点赞 / 取消 */
export function userLike(momentId: string) {
  const social = useSocialStore();
  const m = social.byId(momentId);
  if (!m) return;
  social.setLike(momentId, MOMENT_USER, !m.likes.includes(MOMENT_USER));
  for (const id of audienceOf(m)) rememberMoment(momentId, id);
}
