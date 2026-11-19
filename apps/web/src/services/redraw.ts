import { assetUrl } from '@/services/assets';
import { services } from '@/services';
import type { ViewerImage } from '@/services/imageViewer';
import { useChatStore } from '@/stores/chat';
import { useGalleryStore, type GalleryItem } from '@/stores/gallery';

/**
 * 看大图时的"重新生成"：场景里画的图（图库里的一张）和聊天卡片上的那几张（饭卡、学习卡、约会回忆）。
 * 照图库里记的画面（场景、时刻、描述、地点、画幅）再画一张换掉；聊天卡片里用着旧图的跟着换。
 * 朋友圈、社群的图各自按帖子里写的画面重画（services/social.ts、services/community.ts 的 redo）。
 */

type Shot = { id?: string; assetKey: string | null; url?: string; title?: string };

async function urlOf(i: { assetKey: string | null; url?: string }): Promise<string | null> {
  if (!i.assetKey) return i.url ?? null;
  return /^(?:https?:|data:|blob:)/.test(i.assetKey) ? i.assetKey : assetUrl(i.assetKey);
}

/** 这张图在图库里是哪一条（按 id，不然按图的 key） */
function galleryItemOf(shot: Shot): GalleryItem | undefined {
  const gallery = useGalleryStore();
  return (shot.id ? gallery.items.find((i) => i.id === shot.id) : undefined) ?? (shot.assetKey ? gallery.items.find((i) => i.assetKey === shot.assetKey) : undefined);
}

/** 聊天卡片（饭卡、学习卡、约会回忆）里用着旧图的那几张换成新的 */
function replaceInCards(oldKey: string | null, oldUrl: string | undefined, item: GalleryItem) {
  if (!oldKey && !oldUrl) return;
  for (const list of Object.values(useChatStore().messages)) {
    for (const m of list ?? []) {
      for (const p of m.parts) {
        if ((p.type !== 'meal' && p.type !== 'study' && p.type !== 'date') || !p.images) continue;
        for (const img of p.images) {
          if ((oldKey && img.assetKey === oldKey) || (!oldKey && oldUrl && img.url === oldUrl)) {
            img.assetKey = item.assetKey;
            if (item.url) img.url = item.url;
            else delete img.url;
            if (item.title) img.title = item.title;
          }
        }
      }
    }
  }
}

/** 重画图库里的一张，返回新图的链接 */
export async function redrawGalleryItem(id: string): Promise<string | null> {
  const r = await useGalleryStore().redraw(id);
  if (!r.ok) throw new Error(r.reason);
  replaceInCards(r.oldKey, r.oldUrl, r.item);
  return urlOf(r.item);
}

/** 场景里画的一张、卡片上的一张 → 看大图用的（在图库里找得到时能重新生成） */
export async function shotViewerImage(shot: Shot | null | undefined): Promise<ViewerImage | null> {
  if (!shot) return null;
  const url = await urlOf(shot);
  if (!url) return null;
  const item = galleryItemOf(shot);
  const id = item?.id;
  return {
    url,
    name: shot.title || item?.title,
    ...(id ? {
      redraw: async () => {
        await redrawGalleryItem(id);
        return shotViewerImage(useGalleryStore().items.find((i) => i.id === id));
      },
    } : {}),
    ...(item?.vibeComparison ? {
      label: '原图 · Vibe 开启',
      compareVibe: async () => {
        const result = await services.image.compareVibe(item.vibeComparison!.assetKey);
        const comparisonUrl = await urlOf(result);
        return comparisonUrl ? { url: comparisonUrl, name: `${item.title} · Vibe 关闭`, label: '对比图 · Vibe 关闭' } : null;
      },
    } : {}),
  };
}

/** 一组（这次画的几张）：找不到图的跳过；返回列表和 start 在列表里的位置 */
export async function shotViewerImages(shots: Shot[], start = 0): Promise<{ images: ViewerImage[]; start: number }> {
  const all = await Promise.all(shots.map(shotViewerImage));
  const images = all.filter((i): i is ViewerImage => !!i);
  return { images, start: all.slice(0, start).filter(Boolean).length };
}
