import type { BiliFavFolder, VideoHit, VideoPage } from '@app/shared';
import { useHubStore } from '@/stores/hub';
import { useServicesStore } from '@/stores/services';
import { clock } from '@/utils/time';

/**
 * 一起观影的 B 站片单（移植自 siios 的 Bilibili App）：GitHub Actions 每小时从 B 站取推荐、番剧、热门、游戏
 * （apps/web/scripts/update-bilibili.mjs → bilibili-data 分支），这里从 raw.githubusercontent.com 读，
 * 都是真实的视频（BV 号），用 B 站官方的嵌入播放器放。不用登录、不用自己的服务器，手机上也一样。
 * 搜索：连着云端 Hub 时先真的搜 B 站（/v1/video/search，带上"观影设置"里的 B 站 Cookie）；没连或者没搜到，在这几份片单里找（同 siios），并说明为什么。
 * 搜索结果一批 SEARCH_BATCH 个，刷新换下一批。
 * 收藏夹：连着 Hub 并填了 B 站 Cookie 时，经 Hub 读这个账号自己建的收藏夹（/v1/video/fav/*）。
 */

/** 搜索结果一批几个（刷新换下一批） */
export const SEARCH_BATCH = 8;

export const BILI_CATEGORIES = [
  { id: 'recommend', label: '推荐' },
  { id: 'anime', label: '番剧' },
  { id: 'hot', label: '热门' },
  { id: 'games', label: '游戏' },
] as const;
export type BiliCategory = (typeof BILI_CATEGORIES)[number]['id'];

/** 片单在构建这份 App 的仓库里（fork 的读 fork 自己的，见 vite.config.ts 的 githubRepo） */
const REPO = import.meta.env.VITE_GITHUB_REPO;
const DATA_URL = REPO ? `https://raw.githubusercontent.com/${REPO}/bilibili-data` : '';

export interface BiliList {
  videos: (VideoHit & { tag: string })[];
  /** 片单是什么时候取的（ISO） */
  updatedAt: string;
}

interface RawVideo {
  bvid: string;
  /** 旧的片单没有 */
  aid?: number;
  cid?: number;
  title: string;
  cover: string;
  views: number;
  duration: number;
  owner: string;
  tag: string;
}

const cache = new Map<BiliCategory, Promise<BiliList>>();

/** 一个分类的片单（打开期间只取一次；fresh：手动刷新，重新取） */
export function biliList(id: BiliCategory, fresh = false): Promise<BiliList> {
  if (fresh) cache.delete(id);
  let p = cache.get(id);
  if (!p) {
    p = (async () => {
      if (!DATA_URL) throw new Error('不知道 B 站片单在哪个 GitHub 仓库：用 GitHub Actions 构建，或者构建时设 VITE_GITHUB_REPO=用户名/仓库名');
      let res: Response;
      try {
        res = await fetch(`${DATA_URL}/${id}.json`, { signal: AbortSignal.timeout(15_000), cache: fresh ? 'no-cache' : 'default' });
      } catch (e) {
        throw new Error(`取不到 B 站片单（${e instanceof Error ? e.message : String(e)}），检查一下网络`);
      }
      if (!res.ok) throw new Error(`B 站片单还没准备好（HTTP ${res.status}）：${REPO} 的 Actions 里"Bilibili data"要先跑过一次`);
      const data = (await res.json()) as { updated_at?: string; videos?: RawVideo[] };
      return {
        updatedAt: data.updated_at ?? '',
        videos: (data.videos ?? []).map((v) => ({
          bvid: v.bvid,
          title: v.title,
          author: v.owner,
          duration: v.duration ? clock(v.duration) : '',
          cover: v.cover,
          plays: v.views,
          // 带上 aid + cid：iOS 上嵌入播放器靠它们才放得了（见 utils/videoLink.ts）
          url: `https://www.bilibili.com/video/${v.bvid}${v.aid && v.cid ? `?aid=${v.aid}&cid=${v.cid}` : ''}`,
          tag: v.tag,
        })),
      };
    })();
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

/**
 * 按关键词找 B 站视频的第 page 批（每批 SEARCH_BATCH 个）：连着 Hub 先真的搜 B 站，再在片单里找（标题、UP 主、分区都算）；都没有时 videos 为空数组。
 * note 为空说明是真的搜 B 站得到的；不为空写着为什么是片单里找的（或者为什么换不了一批）。more：后面还有下一批。
 */
export async function searchBili(keyword: string, page = 1): Promise<{ videos: VideoHit[]; note: string; more: boolean }> {
  const q = keyword.trim();
  if (!q) return { videos: [], note: '', more: false };
  let hubError = '';
  const hub = useHubStore();
  if (hub.connected) {
    try {
      const r = await hub.searchVideos(q, useServicesStore().biliCookie, page, SEARCH_BATCH);
      // 旧版 Hub 不认 page，也不回 more：只有这一批
      if (r.more === undefined && r.hits.length) return { videos: r.hits, note: '云端 Hub 是旧版，换不了一批：部署最新 main 的 Hub', more: false };
      if (r.hits.length || page > 1) return { videos: r.hits, note: '', more: r.more === true };
    } catch (e) {
      if (page > 1) throw e;
      hubError = e instanceof Error ? e.message : String(e);
    }
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const seen = new Set<string>();
  const found: VideoHit[] = [];
  for (const r of await Promise.allSettled(BILI_CATEGORIES.map((c) => biliList(c.id)))) {
    if (r.status !== 'fulfilled') continue;
    for (const v of r.value.videos) {
      const hay = `${v.title} ${v.author} ${v.tag}`.toLowerCase();
      if (!seen.has(v.bvid) && words.every((w) => hay.includes(w))) {
        seen.add(v.bvid);
        found.push(v);
      }
    }
  }
  if (!found.length && hubError) throw new Error(`${hubError}；片单里也没有`);
  const note = !hub.connected ? '没连云端 Hub，只在片单里找（我的 → 观影设置）' : hubError ? `B 站搜索没成功（${hubError}），下面是片单里的` : 'B 站没搜到，下面是片单里的';
  const from = (page - 1) * SEARCH_BATCH;
  return { videos: found.slice(from, from + SEARCH_BATCH), note, more: found.length > from + SEARCH_BATCH };
}

/** 收藏夹要经过 Hub、要 B 站 Cookie：缺哪个就说清楚去哪儿补 */
function favCookie(): string {
  if (!useHubStore().connected) throw new Error('读 B 站收藏夹要经过云端 Hub：先连上 Hub（我的 → 云端同步）');
  const cookie = useServicesStore().biliCookie.trim();
  if (!cookie) throw new Error('读 B 站收藏夹要登录：在"我的 → 观影设置"里填 B 站 Cookie（SESSDATA）');
  return cookie;
}

/** B 站 Cookie 登录的账号自己建的收藏夹 */
export async function biliFavFolders(): Promise<BiliFavFolder[]> {
  return useHubStore().favFolders(favCookie());
}

/** 一个收藏夹的第 page 页视频 */
export async function biliFavVideos(id: number, page = 1): Promise<VideoPage> {
  return useHubStore().favVideos(favCookie(), id, page);
}
