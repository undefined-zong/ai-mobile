import { ref, watch } from 'vue';
import { assetUrl } from '@/services';
import { syncState } from '@/services/sync';

const LINK = /^(?:https?:|data:|blob:)/;

/**
 * 素材库里的一张图（按 key 取）或者链接 → 放进 <img> 的地址。
 * 本机没有、云端这会儿也取不到（另一台设备刚画好、图还没传完；刚打开 App 还没连上云端）时为空，missing 为 true；
 * 之后云端到了新文件、连上了云端（syncState.arrivals 变了）就自己再取一次，不用退出页面重进。
 * key 取不到时退回服务商给的链接（url，可能已经失效）。
 */
export function useAssetSrc(source: () => { key: string | null | undefined; url?: string | null }) {
  const src = ref<string | null>(null);
  const missing = ref(false);
  let token = 0;
  let loading = false;
  /** 正在取的时候云端又到了文件：这次没取到就再取一次 */
  let retry = false;

  async function load(again: boolean) {
    const { key, url } = source();
    const mine = (token += 1);
    if (!again) {
      src.value = null;
      missing.value = false;
    }
    retry = false;
    loading = true;
    let resolved: string | null = null;
    try {
      if (key) resolved = LINK.test(key) ? key : await assetUrl(key).catch(() => null);
      if (!resolved && url) resolved = url;
    } finally {
      if (mine === token) loading = false;
    }
    if (mine !== token) return;
    src.value = resolved;
    missing.value = !resolved;
    if (!resolved && retry) void load(true);
  }

  watch(() => { const s = source(); return [s.key, s.url] as const; }, () => void load(false), { immediate: true });
  watch(() => syncState.arrivals, () => {
    if (loading) retry = true;
    else if (missing.value) void load(true);
  });

  /** <img> 读不出来（链接失效、文件坏了）：当成没有，等云端到了再取 */
  function broken() {
    missing.value = true;
  }

  return { src, missing, broken };
}
