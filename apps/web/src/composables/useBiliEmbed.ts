import { computed, ref, watch, type Ref } from 'vue';
import { useHubStore } from '@/stores/hub';
import type { VideoLink } from '@/utils/videoLink';

/**
 * 嵌入播放器的地址（一起观影、一起吃饭时的下饭视频、健身时边练边看的视频共用）。
 * B 站的链接没带 aid + cid：连着 Hub 时请它查。手机上的嵌入播放器带上它们才不请求视频信息接口
 * （iOS 上那个请求没有 Cookie，B 站回 412、显示失效，见 utils/videoLink.ts）；查不到照旧用链接本来的地址。
 * 别的平台原样返回。
 */
export function useBiliEmbed(link: Ref<VideoLink | null>) {
  const hub = useHubStore();
  const ids = ref<{ key: string; aid: number; cid: number } | null>(null);
  const keyOf = (l: VideoLink) => `${l.id}:${l.page ?? 1}`;
  watch(
    link,
    async (l) => {
      if (l?.platform !== 'bilibili' || !l.id || l.src.includes('cid=') || !hub.connected || ids.value?.key === keyOf(l)) return;
      const key = keyOf(l);
      const found = await hub.videoIds(l.id, l.page ?? 1).catch(() => null);
      if (found) ids.value = { key, ...found };
    },
    { immediate: true },
  );
  return computed(() => {
    const l = link.value;
    if (!l) return '';
    const got = ids.value;
    if (l.platform === 'bilibili' && got?.key === keyOf(l) && !l.src.includes('cid=')) return `${l.src}${l.src.includes('aid=') ? '' : `&aid=${got.aid}`}&cid=${got.cid}`;
    return l.src;
  });
}
