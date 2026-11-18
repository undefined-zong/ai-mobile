<script setup lang="ts">
import { previewImages, type ViewerImage } from '@/services/imageViewer';
import type { MomentImage } from '@app/shared';

import { computed } from 'vue';
import HtmlFrame from '@/components/chat/HtmlFrame.vue';
import AssetImg from '@/components/common/AssetImg.vue';
import { assetUrl } from '@/services';

/**
 * 一条朋友圈 / 社群里一帖带的东西：图（你的照片 / AI 画的，没画出来时显示要画的画面和"画这张图"）
 * 和一小页 HTML（单据、卡片，放在沙盒小窗里）。朋友圈和社群共用。
 * 点开看大图：AI 画的那几张能"重新生成"（给了 redraw 时；拍的照片不行）
 */
const props = defineProps<{
  images: MomentImage[];
  html?: string;
  /** 正在画的那几张（第几张） */
  drawing?: number[];
  /** 重画已经画好的第 index 张 */
  redraw?: (index: number) => Promise<{ ok: true } | { ok: false; reason: string }>;
}>();
const emit = defineEmits<{ (e: 'draw', index: number): void }>();

const cols = computed(() => (props.images.length === 1 ? 1 : props.images.length <= 4 ? 2 : 3));

async function urlOf(i: MomentImage | undefined): Promise<string | null> {
  if (!i) return null;
  return i.assetKey ? (/^(?:https?:|data:|blob:)/.test(i.assetKey) ? i.assetKey : assetUrl(i.assetKey)) : (i.url ?? null);
}

async function preview(index: number) {
  const list: ViewerImage[] = [];
  let start = 0;
  for (const [n, img] of props.images.entries()) {
    const url = await urlOf(img);
    if (!url) continue;
    if (n === index) start = list.length;
    const redraw = props.redraw;
    list.push({
      url,
      name: img.caption,
      ...(redraw && !img.photo
        ? {
            redraw: async () => {
              const r = await redraw(n);
              if (!r.ok) throw new Error(r.reason);
              return urlOf(props.images[n]);
            },
          }
        : {}),
    });
  }
  if (list.length) previewImages(list, { startPosition: start });
}
</script>

<template>
  <div v-if="images.length" class="images" :class="`cols-${cols}`">
    <template v-for="(img, i) in images" :key="i">
      <button v-if="img.assetKey || img.url" type="button" class="image press" :aria-label="img.caption || '看大图'" @click="preview(i)">
        <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.caption" />
        <span v-if="drawing?.includes(i)" class="redrawing"><van-loading size="16" color="#fff" />正在重画…</span>
      </button>
      <div v-else class="image pending">
        <span v-if="drawing?.includes(i)" class="flex items-center gap-1.5 text-[12px] text-ink-3"><van-loading size="14" />正在画…</span>
        <template v-else>
          <span class="i-lucide-image text-[20px] text-ink-3" />
          <span class="caption">{{ img.caption }}</span>
          <span v-if="img.error" class="text-[11px] text-warn leading-snug line-clamp-2">{{ img.error }}</span>
          <button type="button" class="draw press" @click="emit('draw', i)">画这张图</button>
        </template>
      </div>
    </template>
  </div>

  <div v-if="html" class="receipt">
    <HtmlFrame :code="html" :message-index="0" :last-index="0" />
  </div>
</template>

<style scoped>
.images {
  display: grid;
  gap: 4px;
  margin-top: 8px;
  max-width: 320px;
}
.images.cols-1 {
  grid-template-columns: minmax(0, 220px);
}
.images.cols-2 {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-width: 240px;
}
.images.cols-3 {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}
.image {
  position: relative;
  aspect-ratio: 1;
  padding: 0;
  border-radius: 8px;
  overflow: hidden;
  background: var(--panel);
}
.cols-1 .image {
  aspect-ratio: 3 / 4;
}
.cols-1 .image.pending {
  aspect-ratio: 4 / 3;
}
.image.pending {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px;
  text-align: center;
  border: 1px dashed var(--border);
}
.caption {
  font-size: 12px;
  line-height: 1.45;
  color: var(--ink-2);
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.redrawing {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12px;
  color: #fff;
  background: rgba(0, 0, 0, 0.42);
}
.draw {
  height: 26px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
}
.receipt {
  margin-top: 8px;
  max-width: 340px;
  border-radius: 12px;
  overflow: hidden;
  border: 1px solid var(--border);
}
</style>
