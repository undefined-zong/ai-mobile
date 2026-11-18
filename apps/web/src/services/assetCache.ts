import { reactive } from 'vue';
import { getKeys, getOne, registerFlusher, write } from '@/db/idb';
import { setAssetUseHook } from '@/services/assets';
import { cloudBackedAssets, syncState } from '@/services/sync';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useCommunityStore } from '@/stores/community';
import { useGalleryStore } from '@/stores/gallery';
import { useSocialStore } from '@/stores/social';
import { useWorkshopStore } from '@/stores/workshop';

/**
 * 图片缓存（我的 → 图片缓存）：连着云端、开着多设备同步时，生成的图片、语音和拍的照片在云端都有一份，
 * 这台设备只留最近用过的：超过设定的天数没看过的从本机清掉，下次用到时自动从云端下载回来（services/sync 的按需下载）。
 * - 挂在角色身上的（立绘）一直留着；
 * - 只清云端已经有完整一份的（推上去过、之后没再改）；没连云端、关了同步时一张都不清；
 * - 清本机这份不算删除，不会同步给别的设备；
 * - 每台设备各自设置（settings 表的 assetCache / assetUsed 不进同步）。
 */

/** 0 = 一直保留 */
export const CACHE_DAYS = [1, 3, 7, 30, 0] as const;
export type CacheDays = (typeof CACHE_DAYS)[number];
const SETTINGS_KEY = 'assetCache';
const USED_KEY = 'assetUsed';
const DAY = 86_400_000;
const today = () => Math.floor(Date.now() / DAY);

export const assetCache = reactive({
  days: 30 as CacheDays,
  cleaning: false,
  last: null as { at: number; removed: number } | null,
});

/** 每张图上次用到是哪天（从 1970 年起第几天） */
let used: Record<string, number> | null = null;
let loading: Promise<Record<string, number>> | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | undefined;

function loadUsed(): Promise<Record<string, number>> {
  if (used) return Promise.resolve(used);
  loading ??= getOne<Record<string, number>>('settings', USED_KEY, { local: true })
    .catch(() => undefined)
    .then((saved) => (used = saved && typeof saved === 'object' ? { ...saved } : {}));
  return loading;
}

async function saveUsed() {
  clearTimeout(timer);
  if (!used || !dirty) return;
  dirty = false;
  if (!(await write('settings', [{ key: USED_KEY, value: { ...used } }]))) dirty = true;
}
registerFlusher(saveUsed);

/** 用到了一张图（显示、播放、存进来）：记下今天，一天只记一次 */
export function noteAssetUse(key: string) {
  if (!key || /^(?:https?:|data:|blob:)/.test(key)) return;
  void loadUsed().then((u) => {
    const d = today();
    if (u[key] === d) return;
    u[key] = d;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => void saveUsed(), 5000);
  });
}

setAssetUseHook(noteAssetUse);

export async function loadCacheSettings() {
  const saved = await getOne<{ days?: number }>('settings', SETTINGS_KEY, { local: true }).catch(() => undefined);
  if ((CACHE_DAYS as readonly number[]).includes(saved?.days ?? -1)) assetCache.days = saved!.days as CacheDays;
}

export async function setCacheDays(days: CacheDays) {
  assetCache.days = days;
  await write('settings', [{ key: SETTINGS_KEY, value: { days } }]);
}

/** 记录里的素材：assetKey / photo / photoKey 字段（本机素材库的 key，不是链接） */
function collect(value: unknown, out: (key: string) => void, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && (k === 'assetKey' || k === 'photo' || k === 'photoKey')) {
      if (v && !/^(?:https?:|data:|blob:)/.test(v)) out(v);
    } else if (v && typeof v === 'object') collect(v, out, depth + 1);
  }
}

/** 一直留着的：挂在角色身上的（立绘） */
function pinnedKeys(): Set<string> {
  const pinned = new Set<string>();
  for (const c of useCharacterStore().list) collect(c, (k) => pinned.add(k));
  return pinned;
}

/** 素材是哪天放进来的（按引用它的消息、朋友圈、帖子、图库、作品的时间）：以前没记过"上次用到"的按这个算 */
function referenceDays(): Map<string, number> {
  const out = new Map<string, number>();
  const note = (time: number | undefined) => (key: string) => {
    const d = Math.floor((time || Date.now()) / DAY);
    if ((out.get(key) ?? -1) < d) out.set(key, d);
  };
  for (const list of Object.values(useChatStore().messages)) for (const m of list ?? []) collect(m.parts, note(m.createdAt));
  for (const m of useSocialStore().moments) collect(m, note(m.updatedAt ?? m.createdAt));
  for (const p of useCommunityStore().posts) collect(p, note(p.createdAt));
  for (const g of useGalleryStore().items) collect(g, note(g.at));
  for (const d of useWorkshopStore().drawings) collect(d, note(d.at));
  return out;
}

/**
 * 清掉本机超过设定天数没用过、云端已经有的素材（立绘不清）。返回清掉几张。
 * 没连云端 / 关了同步 / 设成一直保留时什么也不做
 */
export async function cleanAssetCache(): Promise<number> {
  const days = assetCache.days;
  if (!days || assetCache.cleaning || !syncState.enabled || !syncState.joined || !syncState.supported) return 0;
  assetCache.cleaning = true;
  try {
    const u = await loadUsed();
    const now = today();
    const keys = await getKeys('assets');
    const pinned = pinnedKeys();
    const refs = referenceDays();
    const old: string[] = [];
    for (const k of keys) {
      if (pinned.has(k)) continue;
      let day = u[k] ?? refs.get(k);
      if (day === undefined) {
        // 第一次见到、哪儿也没引用它：从今天开始算
        u[k] = day = now;
        dirty = true;
      }
      if (now - day >= days) old.push(k);
    }
    const backed = await cloudBackedAssets(old);
    const remove = old.filter((_, i) => backed[i]);
    // 只是清掉本机这份（sync: true：不记进发件箱，不会变成"删除"同步给别的设备）
    for (let i = 0; i < remove.length; i += 200) await write('assets', [], remove.slice(i, i + 200), { sync: true });
    for (const k of remove) delete u[k];
    // 本机已经没有的（删掉了的、清掉了的）不用再记
    const local = new Set(keys);
    for (const k of Object.keys(u)) if (!local.has(k)) delete u[k];
    dirty = true;
    await saveUsed();
    assetCache.last = { at: Date.now(), removed: remove.length };
    return remove.length;
  } finally {
    assetCache.cleaning = false;
  }
}

let started = false;
/** 打开 App 以后：读设置，过一会儿清一次，之后每 6 小时清一次 */
export async function startAssetCache() {
  if (started) return;
  started = true;
  await loadCacheSettings();
  setTimeout(() => void cleanAssetCache().catch(() => undefined), 60_000);
  setInterval(() => void cleanAssetCache().catch(() => undefined), 6 * 3_600_000);
}
