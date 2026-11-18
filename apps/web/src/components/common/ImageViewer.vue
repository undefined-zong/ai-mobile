<script setup lang="ts">
import { computed, ref } from 'vue';
import { showToast } from 'vant';
import { saveFiles } from '@/services/download';
import { imageViewer, type ViewerImage } from '@/services/imageViewer';

/** 全屏看图：和原来的 vant 看图一样，底下多一个"下载"（services/imageViewer.ts 的 previewImages 打开） */
const urls = computed(() => imageViewer.images.map((i) => i.url));
const saving = ref(false);
/** 正在重画的那几张 */
const redrawing = ref<Set<ViewerImage>>(new Set());
const current = computed(() => imageViewer.images[imageViewer.index]);
const busy = computed(() => !!current.value && redrawing.value.has(current.value));

/** 重新生成这一张：画好在这里直接换成新的（关掉看图也照样画完，原来的地方会换） */
async function redraw() {
  const img = current.value;
  if (!img?.redraw || redrawing.value.has(img)) return;
  const list = imageViewer.images;
  redrawing.value = new Set([...redrawing.value, img]);
  try {
    const url = await img.redraw();
    // 还开着这一组：把这一张换成新画的（关掉了、换了别的图就不动）
    const i = list.indexOf(img);
    if (url && imageViewer.images === list && i >= 0) list[i] = { ...img, url };
    showToast('画好了');
  } catch (e) {
    showToast({ message: `没画成：${e instanceof Error ? e.message : String(e)}`, duration: 3500 });
  } finally {
    const next = new Set(redrawing.value);
    next.delete(img);
    redrawing.value = next;
  }
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
    v-model:show="imageViewer.show"
    :images="urls"
    :start-position="imageViewer.start"
    :show-index="urls.length > 1"
    closeable
    @change="(i: number) => (imageViewer.index = i)"
  >
    <template #cover>
      <div class="viewer-actions">
        <button v-if="current?.redraw" type="button" class="viewer-btn press" :disabled="busy" aria-label="重新生成这张图" data-testid="viewer-redraw" @click.stop="redraw">
          <span :class="busy ? 'i-lucide-loader-circle animate-spin' : 'i-lucide-refresh-cw'" />
          <span>{{ busy ? '正在画…' : '重新生成' }}</span>
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
.viewer-actions {
  position: fixed;
  left: 50%;
  bottom: calc(var(--safe-bottom, 0px) + 28px);
  transform: translateX(-50%);
  display: flex;
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
.viewer-btn:disabled {
  opacity: 0.6;
}
</style>
