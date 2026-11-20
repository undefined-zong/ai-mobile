import { SCENES } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { autoSave, getAll } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { uid } from '@/utils/id';

/**
 * 相册：你从生成的图里挑出来存下的（聊天配图、一起做事时画的、朋友圈和社群的配图、日记的配图、创意工坊的画……）。
 * 看大图时点"存到相册"就存进来；能删、能拖动排序、能按日期和场景搜。
 * 一张一条存在 album 表（多设备同步），图片本身还在本机素材库（按内容哈希），这里只记索引。
 */

export interface AlbumItem {
  id: string;
  /** 本机素材库的 key；服务商只给了链接时为空 */
  assetKey: string | null;
  url?: string;
  /** 哪个角色的（社群网友的帖子、自由画的可以没有） */
  characterId: string | null;
  /** 标题（生图提示词智能体起的、卡片上写的） */
  title: string;
  /** 画的是什么（要画的画面） */
  caption: string;
  /** 在哪画的：一起做事的场景 id，或者 chat 聊天配图 / moments 朋友圈 / community 社群 / diary 日记 / workshop 创意工坊 */
  scene: string;
  /** 地点的名字 */
  place?: string;
  /** 图是什么时候画的 */
  at: number;
  /** 存进相册的时刻 */
  savedAt: number;
  /** 排序：小的在前（拖动排序改它） */
  order: number;
  prompt?: string;
  seed?: number | null;
  model?: string;
}

/** 看大图时带上的：存到相册要的东西（没有 id、排序，存的时候补） */
export type AlbumDraft = Omit<AlbumItem, 'id' | 'savedAt' | 'order'>;

/** 不是一起做事的场景的那几处 */
const EXTRA_SCENES: Record<string, { label: string; icon: string }> = {
  chat: { label: '聊天配图', icon: 'i-lucide-message-circle' },
  moments: { label: '朋友圈', icon: 'i-lucide-aperture' },
  community: { label: '社群', icon: 'i-lucide-users-round' },
  diary: { label: '日记', icon: 'i-lucide-notebook-tabs' },
  workshop: { label: '创意工坊', icon: 'i-lucide-palette' },
  sprite: { label: '立绘', icon: 'i-lucide-person-standing' },
};

/** 场景的中文名和图标（搜索、筛选、显示用） */
export function albumScene(scene: string): { label: string; icon: string } {
  const s = SCENES.find((x) => x.id === scene);
  return s ? { label: s.name, icon: s.icon } : (EXTRA_SCENES[scene] ?? { label: '其他', icon: 'i-lucide-image' });
}

/** 同一张图（按图的 key，没有 key 按链接） */
const sameImage = (a: Pick<AlbumItem, 'assetKey' | 'url'>, b: Pick<AlbumItem, 'assetKey' | 'url'>) =>
  (!!a.assetKey && a.assetKey === b.assetKey) || (!a.assetKey && !b.assetKey && !!a.url && a.url === b.url);

export const useAlbumStore = defineStore('album', () => {
  const items = ref<AlbumItem[]>([]);
  const ready = ref(false);
  const byOrder = (a: AlbumItem, b: AlbumItem) => a.order - b.order || b.savedAt - a.savedAt;

  // 别的设备存的、删的、排过的（同步）：放进来
  const saver = autoSave('album', () => items.value.map((i) => ({ key: i.id, value: i })), items,
    { apply: (changes) => applyList(items, changes, { sort: byOrder }) });

  async function hydrate() {
    const list = await getAll<AlbumItem>('album');
    items.value = list.filter((i) => i && i.id && (i.assetKey || i.url)).sort(byOrder);
    saver.start();
    ready.value = true;
  }

  /** 按排序（拖过的位置） */
  const sorted = computed(() => [...items.value].sort(byOrder));

  function find(img: Pick<AlbumItem, 'assetKey' | 'url'>): AlbumItem | undefined {
    return items.value.find((i) => sameImage(i, img));
  }

  /** 存进相册（放在最前面）；已经存过的不重复存 */
  function add(draft: AlbumDraft): { ok: true; item: AlbumItem; existed: boolean } | { ok: false; reason: string } {
    if (!draft.assetKey && !draft.url) return { ok: false, reason: '这张图还没画好' };
    const old = find(draft);
    if (old) return { ok: true, item: old, existed: true };
    const first = items.value.reduce((m, i) => Math.min(m, i.order), 0);
    const item: AlbumItem = {
      ...draft,
      title: draft.title.trim().slice(0, 60),
      caption: draft.caption.trim().slice(0, 400),
      id: uid('album'),
      savedAt: Date.now(),
      order: first - 1,
    };
    items.value.push(item);
    items.value.sort(byOrder);
    return { ok: true, item: items.value.find((i) => i.id === item.id)!, existed: false };
  }

  function remove(id: string) {
    items.value = items.value.filter((i) => i.id !== id);
  }

  function update(id: string, patch: Partial<Pick<AlbumItem, 'title' | 'caption'>>) {
    const i = items.value.find((x) => x.id === id);
    if (i) Object.assign(i, patch);
  }

  /**
   * 按新的顺序排这几张（拖动排序：筛选着的时候只排看得到的那几张）：
   * 这几张原来占着的位置（order）按新顺序重新分给它们，别的不动
   */
  function reorder(ids: string[]) {
    const list = ids.map((id) => items.value.find((i) => i.id === id)).filter((i): i is AlbumItem => !!i);
    const slots = list.map((i) => i.order).sort((a, b) => a - b);
    // 原来有一样的 order（同一时刻存的）：先拉开
    for (let k = 1; k < slots.length; k += 1) if (slots[k]! <= slots[k - 1]!) slots[k] = slots[k - 1]! + 1;
    list.forEach((item, k) => {
      if (item.order !== slots[k]) item.order = slots[k]!;
    });
    items.value.sort(byOrder);
  }

  return { items, sorted, ready, hydrate, find, add, remove, update, reorder };
});
