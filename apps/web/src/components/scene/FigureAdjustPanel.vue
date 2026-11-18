<script setup lang="ts">
import type { Character, SceneFigureAdjust } from '@app/shared';
import { computed, ref } from 'vue';
import { setSceneFigureAdjust } from './location';

/**
 * 在画面里直接调立绘的位置和大小：直接拖她挪位置，拉滑块（电脑上也能滚轮）调大小；对着真正的背景调，比在立绘设置的预览里准。
 * 调的是这个画面自己的那一条（PortraitSet.sceneLayouts[layoutKey]，和"立绘设置 → 各场景的位置和大小"是同一份数据），
 * 别的画面不受影响。打开时盖一层透明的拖动层，下面的按钮先点不到，点"好了"收起。
 * 放在场景的 overlay 里（铺满画面的定位容器）。
 */
const props = defineProps<{ character: Character; layoutKey: string; label: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const NONE: SceneFigureAdjust = { x: 0, y: 0, scale: 1 };

const adj = computed<SceneFigureAdjust>(() => props.character.portraits?.sceneLayouts?.[props.layoutKey] ?? NONE);
function set(patch: Partial<SceneFigureAdjust>) {
  setSceneFigureAdjust(props.character, props.layoutKey, { ...adj.value, ...patch });
}
const x = computed({ get: () => adj.value.x, set: (v: number) => set({ x: v }) });
const y = computed({ get: () => adj.value.y, set: (v: number) => set({ y: v }) });
const scale = computed({ get: () => Math.round(adj.value.scale * 100), set: (v: number) => set({ scale: v / 100 }) });

// —— 直接拖 ——
const layer = ref<HTMLElement | null>(null);
let drag: { id: number; sx: number; sy: number; x: number; y: number; w: number; h: number } | null = null;
function down(e: PointerEvent) {
  const r = layer.value?.getBoundingClientRect();
  if (!r) return;
  drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, x: adj.value.x, y: adj.value.y, w: r.width, h: r.height };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  if (!drag || e.pointerId !== drag.id) return;
  set({ x: drag.x + ((e.clientX - drag.sx) / drag.w) * 100, y: drag.y - ((e.clientY - drag.sy) / drag.h) * 100 });
}
function up(e: PointerEvent) {
  if (drag?.id === e.pointerId) drag = null;
}
function wheel(e: WheelEvent) {
  set({ scale: adj.value.scale * (e.deltaY < 0 ? 1.05 : 1 / 1.05) });
}
</script>

<template>
  <div class="fa" data-testid="figure-adjust">
    <div ref="layer" class="fa-drag" role="presentation" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @wheel.prevent="wheel" />
    <section class="fa-panel" role="dialog" :aria-label="`调立绘：${label}`">
      <div class="flex items-center gap-2">
        <span class="i-lucide-move text-accent-ink shrink-0" />
        <span class="flex-1 min-w-0 truncate text-[13.5px] font-600">立绘 · {{ label }}</span>
        <button type="button" class="fa-btn" :disabled="adj === NONE" @click="set({ ...NONE })">恢复默认</button>
        <button type="button" class="fa-btn done" data-testid="figure-adjust-done" @click="emit('close')">好了</button>
      </div>
      <p class="fa-hint">直接拖{{ character.pronoun }}，或者拉滑块；只改这个画面，别的画面各记各的。</p>
      <div class="fa-row">
        <span class="fa-label">左右</span>
        <van-slider v-model="x" :min="-60" :max="60" :step="0.5" bar-height="4px" button-size="16px" aria-label="左右" />
      </div>
      <div class="fa-row">
        <span class="fa-label">上下</span>
        <van-slider v-model="y" :min="-80" :max="80" :step="0.5" bar-height="4px" button-size="16px" aria-label="上下" />
      </div>
      <div class="fa-row">
        <span class="fa-label">大小</span>
        <van-slider v-model="scale" :min="40" :max="250" :step="1" bar-height="4px" button-size="16px" aria-label="大小" />
        <span class="fa-num num">{{ scale }}%</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.fa {
  position: absolute;
  inset: 0;
  z-index: 40;
}
.fa-drag {
  position: absolute;
  inset: 0;
  cursor: grab;
  touch-action: none;
}
.fa-panel {
  position: absolute;
  /* 放在最下面：平时这里本来就压着对话框和按钮，脸和上半身都露在外面 */
  bottom: calc(var(--safe-bottom) + 12px);
  left: 12px;
  right: 12px;
  padding: 10px 12px 12px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  animation: rise 0.2s var(--ease) both;
}
.fa-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  flex-shrink: 0;
}
.fa-btn:disabled {
  opacity: 0.5;
}
.fa-btn.done {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.fa-hint {
  margin: 6px 0 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-3);
}
.fa-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 28px;
  padding-right: 6px;
}
.fa-row .van-slider {
  flex: 1;
}
.fa-label {
  width: 2.2em;
  font-size: 12.5px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.fa-num {
  width: 3em;
  text-align: right;
  font-size: 12px;
  color: var(--ink-3);
  flex-shrink: 0;
}
</style>
