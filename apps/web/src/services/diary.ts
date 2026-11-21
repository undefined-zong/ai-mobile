import { buildDiaryMessages, diaryInput, errorText, isAbortError, samplerRequest } from '@app/ai';
import {
  AGENT_META, diaryEnabled, diaryId, diaryImageOn, diaryLine, dueDiaryDates, getLocation, packDiaryContext, parseDiaryDraft, rhythmDate, shiftDate, socialDayOf,
  type Character, type DiaryContext, type DiaryEntry, type Preset,
} from '@app/shared';
import { onRemote } from '@/db/idb';
import { services } from '@/services';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useDiaryStore } from '@/stores/diary';
import { useEnvironmentStore } from '@/stores/environment';
import { useGalleryStore } from '@/stores/gallery';
import { useHubStore } from '@/stores/hub';
import { useLibraryStore } from '@/stores/library';
import { useRhythmStore } from '@/stores/rhythm';
import { useWeatherStore } from '@/stores/weather';
import { withUserText } from './myDay';
import { MissingPresetError } from './prompt';
import { memoriesText, userNameFor } from './social';

/**
 * 日记要调模型的事（"日记"的 API + "日记"预设）：
 * - 开了"主动写日记"的角色每晚 22:00 写当天的日记：连了云端时云端写（App 关着也写，手机拉下来再画配图），
 *   没连时 App 开着到点写；22:00 时 App 没开，第二天中午前打开 App 时补写昨天的；
 * - 回忆 → 日记里让Ta现在写一篇（写今天的，写过了就重写）；
 * - 要配的图交给"生图"画（用"配图"的生图预设，参考节律里今天穿的那身），画好存进本机素材库；
 * - 最近几天的日记进聊天的记忆拼装（按话题挑，"相关的日记"），Ta记得自己写过什么。
 */

export type DiaryResult = { ok: true; entry: DiaryEntry } | { ok: false; reason: string };

/** "日记"用途选中的预设（带上角色绑定的世界书） */
export function diaryPreset(character?: Character): Preset | undefined {
  const lib = useLibraryStore();
  return lib.withLorebooks(lib.presetForUse('diary', character), character);
}

/** 日记能不能调模型（API 接通了、有日记预设）；不能时说明原因 */
export function diaryStatus(character?: Character): { ok: true } | { ok: false; reason: string } {
  const s = useAiStore().status('diary');
  if (!s.live) return { ok: false, reason: `「${AGENT_META.diary.label}」的 API 还没接通：${s.reason}` };
  if (!diaryPreset(character)) return { ok: false, reason: new MissingPresetError('日记').message };
  return { ok: true };
}

/** 最近几篇日记写成几行（进提示词：不要重复） */
function previousText(c: Character, before: string, n = 3): string {
  return useDiaryStore()
    .of(c.id)
    .filter((e) => e.date < before)
    .slice(0, n)
    .reverse()
    .map((e) => diaryLine(e, c.name, 220))
    .join('\n');
}

/** 写一篇日记要的输入（按角色）：角色卡、今天的节律、今天和你、记得的事、最近几篇日记、天气 */
export function diaryContextOf(c: Character, preset: Preset | null, date = rhythmDate(new Date(), useEnvironmentStore().settings.timezone)): DiaryContext {
  const userName = userNameFor(c.id);
  const weather = useWeatherStore();
  const w = weather.forCharacter(c);
  // 那一天的节律（补写昨天的时是昨天那份；地点换成名字）
  const rhythm = useRhythmStore().dayOf(c.id, date);
  return {
    character: { id: c.id, name: c.name, pronoun: c.pronoun, card: c.card },
    userName,
    timezone: useEnvironmentStore().settings.timezone,
    settings: { enabled: diaryEnabled(c), image: diaryImageOn(c) },
    day: rhythm ? socialDayOf(rhythm, (id) => getLocation(id)?.name ?? id) : null,
    date,
    withUser: withUserText(c.id, date, userName),
    memories: memoriesText(c, userName),
    previous: previousText(c, date),
    weather: w ? weather.short(w) : '',
    preset,
    preview: useHubStore().config.preview,
  };
}

/** 上传云端的那份（按角色）：开着"主动写日记"、有日记预设时才传 */
export function diaryCloudContext(characterId: string): DiaryContext | null {
  const c = useCharacterStore().byId(characterId);
  if (!c || !diaryEnabled(c) || !useDiaryStore().ready) return null;
  const preset = diaryPreset(c);
  return preset ? packDiaryContext(diaryContextOf(c, preset)) : null;
}

// —— 写一篇 ——

/**
 * 让Ta写一篇日记（在手机上生成）：date 不给写今天的。同一天已经有一篇时换掉（你点"重写"时）
 * auto：到点自己写的（写成未读；你删过的那天不再写）
 */
export async function writeDiary(characterId: string, opts: { date?: string; auto?: boolean } = {}): Promise<DiaryResult> {
  const store = useDiaryStore();
  const c = useCharacterStore().byId(characterId);
  if (!c) return { ok: false, reason: '找不到这个角色' };
  const status = diaryStatus(c);
  if (!status.ok) return status;
  const key = `write:${characterId}`;
  if (store.busy[key]) return { ok: false, reason: `${c.name}正在写` };
  const timezone = useEnvironmentStore().settings.timezone;
  const date = opts.date ?? rhythmDate(new Date(), timezone);
  const id = diaryId(c.id, date);
  if (opts.auto && (store.byId(id) || store.removed.includes(id))) return { ok: false, reason: '这一天写过了' };
  const preset = diaryPreset(c)!;
  const context = diaryContextOf(c, preset, date);
  store.busy[key] = true;
  delete store.failures[key];
  try {
    const now = Date.now();
    const { value, result } = await useAiStore().system.json(
      'diary',
      { messages: buildDiaryMessages(diaryInput(context, now, date), preset), ...samplerRequest(preset.sampler) },
      parseDiaryDraft,
    );
    if (!useCharacterStore().byId(characterId)) return { ok: false, reason: '找不到这个角色' };
    const old = store.byId(id);
    const entry = store.put({
      id, characterId: c.id, date, title: value.title, weather: value.weather, mood: value.mood, text: value.text, highlights: value.highlights,
      images: value.image && context.settings.image ? [{ caption: value.image, assetKey: null }] : [],
      source: 'device', model: result.model, createdAt: old?.createdAt ?? now, updatedAt: now,
      ...(opts.auto ? { unread: true } : {}),
    });
    // 重写：你删掉过这一天又让她写，就不再算删掉
    if (store.removed.includes(id)) store.removed = store.removed.filter((x) => x !== id);
    if (entry.images?.length) void drawDiaryImage(entry.id, 0, 'auto');
    return { ok: true, entry };
  } catch (e) {
    const reason = errorText(e);
    store.failures[key] = reason;
    return { ok: false, reason };
  } finally {
    delete store.busy[key];
  }
}

// —— 配图 ——

/** 这台设备这次打开以来自动画过的（每张只自动画一次） */
const autoTried = new Set<string>();

/**
 * 画这篇日记的第 index 张图（模型写了画面，这里交给生图）。
 * auto：写好、收到云端写的时自动画，守着"自动画"的规矩（NovelAI 只在不花点的设置下画）；user：你点的。
 * redo：已经画好的再画一张换掉：同样的 tags 换个种子（同 NovelAI 的重新生成），不再让模型重写 tags；以前的图没存出图请求时从头画
 */
export async function drawDiaryImage(entryId: string, index = 0, priority: 'user' | 'auto' = 'user', opts: { redo?: boolean } = {}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const store = useDiaryStore();
  const key = `image:${entryId}:${index}`;
  const e = store.byId(entryId);
  const img = e?.images?.[index];
  if (!e || !img) return { ok: false, reason: '找不到这张图了' };
  if (store.busy[key]) return { ok: false, reason: '正在画这张' };
  if ((img.assetKey || img.url) && !opts.redo) return { ok: true };
  const c = useCharacterStore().byId(e.characterId);
  if (!c) return { ok: false, reason: '找不到写这篇的角色' };
  if (priority === 'auto') {
    if (autoTried.has(key)) return { ok: false, reason: '这台设备已经自动画过这张' };
    autoTried.add(key);
    const check = useGalleryStore().autoCheck({ ignoreSwitch: true });
    if (!check.ok) {
      img.error = check.reason;
      return { ok: false, reason: check.reason };
    }
  }
  store.busy[key] = true;
  delete img.error;
  try {
    const again = opts.redo && img.requestKey ? await services.image.redraw(img.requestKey, { priority }) : null;
    const out = again ?? await services.image.illustrate(
      // 日记的配图参考节律里今天的衣着（同朋友圈）
      // 日记正文给宏 {{diary_text}}，怎么写在配图预设里（触发条件 diary）
      { characterId: c.id, caption: img.caption, use: 'image', outfitRef: true, vars: { diary_text: e.text.slice(0, 300) }, types: ['diary'] },
      { priority },
    );
    const now = useDiaryStore().byId(entryId)?.images?.[index];
    if (now) {
      Object.assign(now, { assetKey: out.assetKey, title: out.caption || now.title }, { error: undefined });
      delete now.error;
      if (out.url) now.url = out.url;
      else delete now.url;
      if (out.requestKey) now.requestKey = out.requestKey;
      else delete now.requestKey;
    }
    return { ok: true };
  } catch (err) {
    const reason = isAbortError(err) ? '取消了' : errorText(err);
    const now = useDiaryStore().byId(entryId)?.images?.[index];
    if (now && !isAbortError(err) && !opts.redo) now.error = reason;
    return { ok: false, reason };
  } finally {
    delete store.busy[key];
  }
}

// —— 云端写的 ——

/** 云端写好的日记：放进来、把要配的图画出来 */
export function receiveHubDiaries(list: DiaryEntry[]): DiaryEntry[] {
  const added = useDiaryStore().ingest(list);
  for (const e of added) if (e.images?.some((i) => !i.assetKey && !i.url)) void drawDiaryImage(e.id, 0, 'auto');
  return added;
}

// —— 记忆拼装 ——

/** 最近三天的日记（最多 3 篇），由记忆拼装器按相关性挑（"相关的日记"） */
export function recentDiaryLines(character: Character): { text: string; at: number }[] {
  const since = shiftDate(rhythmDate(new Date(), useEnvironmentStore().settings.timezone), -3);
  return useDiaryStore()
    .of(character.id)
    .filter((e) => e.date >= since)
    .slice(0, 3)
    .map((e) => ({ text: `- ${diaryLine(e, character.name, 200)}`, at: e.updatedAt }));
}

// —— 到点写 ——

/**
 * 云端没接通（或者 Worker 是旧版）时，App 开着也替她们写：每晚 22:00 到点、还在补写窗口里、这一天还没写过就写。
 * 云端接通后这里什么都不做，交给云端
 */
async function localTick() {
  const hub = useHubStore();
  const store = useDiaryStore();
  if (!store.ready || (hub.connected && (hub.supportsDiary || !hub.status))) return;
  if (!useAiStore().isLive('diary')) return;
  const timezone = useEnvironmentStore().settings.timezone;
  for (const c of useCharacterStore().list) {
    if (!diaryEnabled(c)) continue;
    for (const { date } of dueDiaryDates(Date.now(), timezone)) {
      const id = diaryId(c.id, date);
      if (store.byId(id) || store.removed.includes(id) || localTried.has(id)) continue;
      // 一天只试一次：失败了不在这里反复重试（回忆页里可以点"让Ta现在写"）
      localTried.add(id);
      await writeDiary(c.id, { date, auto: true });
    }
  }
}
const localTried = new Set<string>();
let started = false;

export function startDiarySchedule() {
  if (started) return;
  started = true;
  // Key 只存在各自的设备上，日记连同配图的失败原因却会同步：别的设备自动画失败的图，这台设备用自己的生图 API 再自动画一次
  onRemote('diaries', (changes) => {
    for (const ch of changes) {
      const e = ch.deleted ? undefined : useDiaryStore().byId(ch.key);
      if (e?.images?.[0]?.error) void drawDiaryImage(e.id, 0, 'auto');
    }
  });
  // 等云端状态同步回来再看要不要自己写
  setTimeout(() => void localTick(), 30_000);
  setInterval(() => void localTick(), 5 * 60_000);
}
