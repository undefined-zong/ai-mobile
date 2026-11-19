import { reactive } from 'vue';
import type { PlaylistSearch } from './musicPlayer';

/**
 * 一件事自带的歌单（按词去网易云搜，搜到的歌就是这个歌单）能自己改：
 * 自带的几个只是起点，在歌单面板（components/scene/PlaylistMusic.vue）的"搜一个"里把搜的词钉成歌单、把不要的去掉，也能恢复成自带的。
 * 按这件事各存各的，只存在这台设备的浏览器里；没改过时不存，用的就是自带的（之后自带的换了也跟着换）。
 * 哄睡、共同的家、健身、陪伴学习、一起吃饭、戳戳乐各一份，都在这个文件最下面（和 services/musicPlayer.ts 里的播放器一一对应）。
 */
export interface PlaylistSearches {
  /** 现在有的歌单（响应式） */
  readonly list: PlaylistSearch[];
  /** 改过（和自带的不一样） */
  readonly changed: boolean;
  has(keyword: string): boolean;
  /** 把一个搜索词钉成歌单；已经有了、存不下时返回 false */
  add(keyword: string): boolean;
  remove(keyword: string): void;
  /** 恢复成自带的 */
  reset(): void;
}

/** 钉上去的歌单用什么图标（自带的各有各的） */
const PINNED_ICON = 'i-lucide-pin';

function readSaved(key: string): PlaylistSearch[] | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
    if (!Array.isArray(v)) return null;
    return v.flatMap((x) => {
      const o = x as Partial<PlaylistSearch> | null;
      const keyword = typeof o?.keyword === 'string' ? o.keyword.trim() : '';
      if (!keyword) return [];
      return [{ keyword, name: typeof o?.name === 'string' && o.name.trim() ? o.name.trim() : keyword, icon: typeof o?.icon === 'string' && o.icon ? o.icon : PINNED_ICON }];
    });
  } catch {
    return null;
  }
}

export function playlistSearches(storageKey: string, defaults: PlaylistSearch[]): PlaylistSearches {
  const saved = readSaved(storageKey);
  const state = reactive({ list: saved ?? defaults.slice(), changed: !!saved });

  function persist(): boolean {
    try {
      if (state.changed) localStorage.setItem(storageKey, JSON.stringify(state.list));
      else localStorage.removeItem(storageKey);
      return true;
    } catch {
      return false;
    }
  }
  const has = (keyword: string) => state.list.some((s) => s.keyword === keyword.trim());

  return {
    get list() {
      return state.list;
    },
    get changed() {
      return state.changed;
    },
    has,
    add(keyword) {
      const k = keyword.trim();
      if (!k || has(k)) return false;
      const before = { list: state.list, changed: state.changed };
      state.list = [...state.list, { name: k, keyword: k, icon: PINNED_ICON }];
      state.changed = true;
      if (persist()) return true;
      Object.assign(state, before);
      return false;
    },
    remove(keyword) {
      state.list = state.list.filter((s) => s.keyword !== keyword);
      state.changed = true;
      persist();
    },
    reset() {
      state.list = defaults.slice();
      state.changed = false;
      persist();
    },
  };
}

/** 哄睡：助眠的几个 */
export const sleepSearches = playlistSearches('ai-mobile:sleep:searches:v1', [
  { name: '睡前钢琴', keyword: '助眠 钢琴曲', icon: 'i-lucide-piano' },
  { name: '纯音乐', keyword: '睡前 纯音乐', icon: 'i-lucide-feather' },
  { name: '摇篮曲', keyword: '摇篮曲 八音盒', icon: 'i-lucide-moon-star' },
  { name: '冥想', keyword: '冥想 助眠', icon: 'i-lucide-leaf' },
  { name: '安静的民谣', keyword: '安静 民谣', icon: 'i-lucide-guitar' },
]);

/** 共同的家（做家务时）：轻快的几个 */
export const choreSearches = playlistSearches('ai-mobile:home:searches:v1', [
  { name: '轻快', keyword: '轻快 治愈 日常', icon: 'i-lucide-sparkles' },
  { name: '做家务', keyword: '做家务 BGM', icon: 'i-lucide-house' },
  { name: '元气', keyword: '元气 活力 歌曲', icon: 'i-lucide-sun' },
  { name: 'City Pop', keyword: 'city pop', icon: 'i-lucide-disc-3' },
  { name: '咖啡馆', keyword: '咖啡馆 爵士', icon: 'i-lucide-coffee' },
]);

/** 健身：有节奏的几个 */
export const fitSearches = playlistSearches('ai-mobile:fit:searches:v1', [
  { name: '燃脂', keyword: '燃脂 健身 音乐', icon: 'i-lucide-flame' },
  { name: '跑步', keyword: '跑步 节奏 歌单', icon: 'i-lucide-footprints' },
  { name: '力量', keyword: '健身房 力量 训练 音乐', icon: 'i-lucide-dumbbell' },
  { name: '瑜伽', keyword: '瑜伽 冥想 轻音乐', icon: 'i-lucide-flower-2' },
  { name: '元气', keyword: '元气 活力 歌曲', icon: 'i-lucide-sun' },
]);

/** 陪伴学习：不抢注意力的几个 */
export const studySearches = playlistSearches('ai-mobile:study:searches:v1', [
  { name: 'Lo-fi', keyword: 'lofi 学习', icon: 'i-lucide-headphones' },
  { name: '学习钢琴', keyword: '学习 钢琴曲', icon: 'i-lucide-piano' },
  { name: '轻音乐', keyword: '专注 轻音乐', icon: 'i-lucide-feather' },
  { name: '古典', keyword: '巴赫 古典 专注', icon: 'i-lucide-music-2' },
  { name: '自习室', keyword: '自习室 纯音乐', icon: 'i-lucide-book-open' },
]);

/** 一起吃饭：下饭的几个 */
export const mealSearches = playlistSearches('ai-mobile:meal:searches:v1', [
  { name: '下饭', keyword: '下饭 轻松 歌单', icon: 'i-lucide-utensils' },
  { name: '爵士', keyword: '餐厅 爵士', icon: 'i-lucide-wine' },
  { name: '咖啡馆', keyword: '咖啡馆 轻音乐', icon: 'i-lucide-coffee' },
  { name: 'City Pop', keyword: 'city pop', icon: 'i-lucide-building-2' },
  { name: '民谣', keyword: '民谣 安静', icon: 'i-lucide-guitar' },
]);

/** 戳戳乐：甜一点的几个 */
export const pokeSearches = playlistSearches('ai-mobile:poke:searches:v1', [
  { name: '甜甜的', keyword: '甜甜的 恋爱 歌单', icon: 'i-lucide-candy' },
  { name: '撒娇', keyword: '撒娇 可爱 歌曲', icon: 'i-lucide-cat' },
  { name: '心动', keyword: '心动 暧昧 歌单', icon: 'i-lucide-heart' },
  { name: 'R&B', keyword: '慵懒 R&B', icon: 'i-lucide-wine' },
  { name: 'Lo-fi', keyword: 'lofi 放松', icon: 'i-lucide-headphones' },
]);

/** 出逃：在路上、看远方的几个 */
export const escapeSearches = playlistSearches('ai-mobile:escape:searches:v1', [
  { name: '在路上', keyword: '旅行 公路 歌单', icon: 'i-lucide-car-front' },
  { name: '夜车', keyword: '深夜 电车 city pop', icon: 'i-lucide-train-front' },
  { name: '海边', keyword: '海边 夏日 治愈', icon: 'i-lucide-waves' },
  { name: '后摇', keyword: '后摇 空灵', icon: 'i-lucide-cloud' },
  { name: '一个人', keyword: '一个人 安静 歌单', icon: 'i-lucide-moon' },
]);

/** 心跳：暧昧、慵懒的几个 */
export const heartSearches = playlistSearches('ai-mobile:heart:searches:v1', [
  { name: '暧昧', keyword: '暧昧 氛围 歌单', icon: 'i-lucide-heart' },
  { name: 'R&B', keyword: '慵懒 R&B', icon: 'i-lucide-wine' },
  { name: '深夜', keyword: '深夜 氛围 纯音乐', icon: 'i-lucide-moon' },
  { name: 'Chill', keyword: 'chill 放松 歌单', icon: 'i-lucide-headphones' },
  { name: '爵士', keyword: '深夜 爵士', icon: 'i-lucide-music-2' },
]);

/** 约会：甜甜的、心动的几个 */
export const dateSearches = playlistSearches('ai-mobile:date:searches:v1', [
  { name: '心动', keyword: '心动 恋爱 歌单', icon: 'i-lucide-heart' },
  { name: '甜甜的', keyword: '甜歌 约会', icon: 'i-lucide-candy' },
  { name: '散步', keyword: '散步 轻快 治愈', icon: 'i-lucide-footprints' },
  { name: 'City Pop', keyword: 'city pop 夏夜', icon: 'i-lucide-building-2' },
  { name: '咖啡馆', keyword: '咖啡馆 爵士 bossa nova', icon: 'i-lucide-coffee' },
]);
