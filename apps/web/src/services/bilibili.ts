import type { VideoHit } from '@app/shared';
import { useHubStore } from '@/stores/hub';
import { useServicesStore } from '@/stores/services';
import { clock } from '@/utils/time';

/**
 * 一起观影的 B 站片单（移植自 siios 的 Bilibili App）：GitHub Actions 每小时从 B 站取推荐、番剧、热门、游戏
 * （apps/web/scripts/update-bilibili.mjs → bilibili-data 分支），这里从 raw.githubusercontent.com 读，
 * 都是真实的视频（BV 号），用 B 站官方的嵌入播放器放。不用登录、不用自己的服务器，手机上也一样。
 * 搜索：连着云端 Hub 时先真的搜 B 站（/v1/video/search，带上"观影设置"里的 B 站 Cookie）；没连或者没搜到，在这几份片单里找（同 siios），并说明为什么。
 */

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
 * 按关键词找 B 站视频：连着 Hub 先真的搜 B 站，再在片单里找（标题、UP 主、分区都算）；都没有时 videos 为空数组。
 * note 为空说明是真的搜 B 站得到的；不为空写着为什么是片单里找的。
 */
export async function searchBili(keyword: string): Promise<{ videos: VideoHit[]; note: string }> {
  const q = keyword.trim();
  if (!q) return { videos: [], note: '' };
  let hubError = '';
  const hub = useHubStore();
  if (hub.connected) {
    try {
      const hits = await hub.searchVideos(q, useServicesStore().biliCookie);
      if (hits.length) return { videos: hits, note: '' };
    } catch (e) {
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
  return { videos: found.slice(0, 30), note };
}
