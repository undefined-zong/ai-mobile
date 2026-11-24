<script setup lang="ts">
import { computed, nextTick, ref } from 'vue';
import { showToast, type ImagePreviewInstance } from 'vant';
import { saveFiles } from '@/services/download';
import { imageViewer, type ViewerImage } from '@/services/imageViewer';
import { useAlbumStore } from '@/stores/album';

/** 全屏看图：和原来的 vant 看图一样，底下多一个"下载"（services/imageViewer.ts 的 previewImages 打开） */
const urls = computed(() => imageViewer.images.map((i) => i.url));
const saving = ref(false);
const preview = ref<ImagePreviewInstance>();
/** 正在重画的那几张 */
const redrawing = ref<Set<ViewerImage>>(new Set());
const current = computed(() => imageViewer.images[imageViewer.index]);
const busy = computed(() => !!current.value && redrawing.value.has(current.value));

/** 重新生成这一张（同样的 tags 换个种子）：画好在这里直接换成新的（关掉看图也照样画完，原来的地方会换） */
async function redraw(compare = false) {
  const img = current.value;
  const generate = compare ? img?.compareVibe : img?.redraw;
  if (!img || !generate || redrawing.value.has(img)) return;
  const list = imageViewer.images;
  redrawing.value = new Set([...redrawing.value, img]);
  try {
    const result = await generate();
    // 还开着这一组：把这一张换成新画的（关掉了、换了别的图就不动）
    const i = list.indexOf(img);
    if (result && imageViewer.images === list && i >= 0) {
      const next = typeof result === 'string' ? { ...img, url: result } : result;
      if (compare) {
        list.splice(i + 1, 0, next);
        await nextTick();
        preview.value?.swipeTo(i + 1);
      } else list[i] = next;
    }
    showToast(compare ? '对比图已生成' : '画好了');
  } catch (e) {
    showToast({ message: `没画成：${e instanceof Error ? e.message : String(e)}`, duration: 3500 });
  } finally {
    const next = new Set(redrawing.value);
    next.delete(img);
    redrawing.value = next;
  }
}

// —— 存到相册（生成的图）——
const album = useAlbumStore();
/** 这一张已经在相册里了（重画换了图之后按新图算） */
const inAlbum = computed(() => {
  const a = current.value?.album;
  return !!a && !!album.find(a);
});
function keep() {
  const a = current.value?.album;
  if (!a) return;
  const r = album.add(a);
  if (!r.ok) showToast(r.reason);
  else showToast(r.existed ? '已经在相册里了' : '存到相册了（回忆 → 相册）');
}

async function save() {
  const img = imageViewer.images[imageViewer.index];
  if (!img || saving.value) return;
  saving.value = true;
  try {
    const { saved, missing } = await saveFiles([{ url: img.url, name: img.name }]);
    if (missing) showToast('找不到这张图了');
    else if (saved && !matchMedia('(hover: none) and (pointer: coarse)').matches) showToast('已下载');
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <van-image-preview
    ref="preview"
    v-model:show="imageViewer.show"
    :images="urls"
    :start-position="imageViewer.start"
    :show-index="urls.length > 1"
    closeable
    @change="(i: number) => (imageViewer.index = i)"
  >
    <template #cover>
      <div class="viewer-actions">
        <div v-if="current?.label || urls.length > 1" class="viewer-label">
          <button v-if="urls.length > 1" type="button" class="viewer-btn press" aria-label="上一张" @click.stop="preview?.prev()"><span class="i-lucide-chevron-left" /></button>
          <span v-if="current?.label">{{ current.label }}</span>
          <button v-if="urls.length > 1" type="button" class="viewer-btn press" aria-label="下一张" @click.stop="preview?.next()"><span class="i-lucide-chevron-right" /></button>
        </div>
        <button v-if="current?.redraw" type="button" class="viewer-btn press" :disabled="busy" aria-label="重新生成这张图" data-testid="viewer-redraw" @click.stop="redraw()">
          <span :class="busy ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
          <span>{{ busy ? '正在画…' : '重新生成' }}</span>
        </button>
        <button v-if="current?.compareVibe" type="button" class="viewer-btn press" :disabled="busy" data-testid="viewer-compare-vibe" @click.stop="redraw(true)">
          <span class="i-lucide-columns-2" />
          <span>去掉 Vibe 对比</span>
        </button>
        <button v-if="current?.album" type="button" class="viewer-btn press" :class="{ kept: inAlbum }" :aria-label="inAlbum ? '已在相册里' : '存到相册'" data-testid="viewer-album" @click.stop="keep">
          <span :class="inAlbum ? 'i-lucide-images' : 'i-lucide-image-plus'" />
          <span>{{ inAlbum ? '已在相册' : '存到相册' }}</span>
        </button>
        <button v-if="current?.check" type="button" class="viewer-btn press" aria-label="同步检查：这张图在这台设备和云端各是什么状态" data-testid="viewer-check" @click.stop="current.check()">
          <span class="i-lucide-cloud" />
          <span>同步检查</span>
        </button>
        <button type="button" class="viewer-btn press" :disabled="saving" aria-label="下载这张图" data-testid="viewer-save" @click.stop="save">
          <span :class="saving ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-download'" />
          <span>下载</span>
        </button>
      </div>
    </template>
  </van-image-preview>
</template>

<style scoped>
.viewer-label {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #fff;
  text-align: center;
  font-size: 13px;
  text-shadow: 0 1px 4px #000;
}
.viewer-actions {
  position: fixed;
  left: 50%;
  bottom: calc(var(--safe-bottom, 0px) + 28px);
  transform: translateX(-50%);
  display: flex;
  width: max-content;
  max-width: calc(100vw - 24px);
  flex-wrap: wrap;
  justify-content: center;
  gap: 10px;
  pointer-events: auto;
}
.viewer-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 18px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.28);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 14px;
  backdrop-filter: blur(8px);
  white-space: nowrap;
}
.viewer-btn.kept {
  border-color: rgba(255, 255, 255, 0.6);
  background: rgba(255, 255, 255, 0.18);
}
.viewer-btn:disabled {
  opacity: 0.6;
}
</style>
