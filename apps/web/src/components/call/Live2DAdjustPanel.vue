<script setup lang="ts">
import type { Character } from '@app/shared';
import { computed, ref } from 'vue';
import { FRAMING_LIMITS, normalizeFraming, setFraming, type Framing } from '@/live2d/framing';

/**
 * 视频通话里直接调 Live2D 的位置和大小：一根手指（或鼠标）拖着挪，两根手指捏着缩放，电脑上滚轮缩放，也能拉滑块。
 * 对着通话的真背景和字幕调，比在角色设定的小预览里准。改的是角色上的 live2d.framing，和「角色设定 → Live2D」是同一份。
 * 打开时盖一层透明的拖动层，下面的按钮先点不到，点"好了"收起。做法同场景里的调立绘（scene/FigureAdjustPanel.vue）。
 */
const props = defineProps<{ character: Character; /** 人物画面（画布）此刻在屏幕上的位置：拖多远按它的宽高算 */ stage: () => DOMRect | undefined }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const framing = computed(() => normalizeFraming(props.character.live2d?.framing));
const untouched = computed(() => framing.value.zoom === 1 && !framing.value.x && !framing.value.y);
function set(patch: Partial<Framing>) {
  const config = props.character.live2d;
  if (!config) return;
  setFraming(config, patch);
  props.character.updatedAt = Date.now();
}
const x = computed({ get: () => framing.value.x, set: (v: number) => set({ x: v }) });
const y = computed({ get: () => framing.value.y, set: (v: number) => set({ y: v }) });
const zoom = computed({ get: () => Math.round(framing.value.zoom * 100), set: (v: number) => set({ zoom: v / 100 }) });

// —— 直接拖 / 捏 ——
const layer = ref<HTMLElement | null>(null);
const fingers = new Map<number, { x: number; y: number }>();
let from: { framing: Framing; x: number; y: number; spread: number; w: number; h: number } | null = null;
function centre() {
  const points = [...fingers.values()];
  const cx = points.reduce((sum, p) => sum + p.x, 0) / points.length;
  const cy = points.reduce((sum, p) => sum + p.y, 0) / points.length;
  const spread = points.length > 1 ? Math.hypot(points[0]!.x - points[1]!.x, points[0]!.y - points[1]!.y) : 0;
  return { x: cx, y: cy, spread };
}
/** 手指数变了（按下第二根、抬起一根）就从现在的位置重新起算，人物不会跳 */
function rebase() {
  if (!fingers.size) { from = null; return; }
  const rect = props.stage() ?? layer.value?.getBoundingClientRect();
  if (!rect?.width || !rect.height) { from = null; return; }
  from = { framing: { ...framing.value }, ...centre(), w: rect.width, h: rect.height };
}
function down(e: PointerEvent) {
  // 捕获后手指滑出画面也接着拖；捕获不了（指针已经抬起）时照样能拖
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* 不捕获 */ }
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  rebase();
}
function move(e: PointerEvent) {
  if (!fingers.has(e.pointerId) || !from) return;
  fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const now = centre();
  set({
    x: from.framing.x + ((now.x - from.x) / from.w) * 100,
    y: from.framing.y - ((now.y - from.y) / from.h) * 100,
    ...(from.spread > 8 && now.spread > 8 ? { zoom: from.framing.zoom * (now.spread / from.spread) } : {}),
  });
}
function up(e: PointerEvent) {
  if (fingers.delete(e.pointerId)) rebase();
}
function wheel(e: WheelEvent) {
  set({ zoom: framing.value.zoom * (e.deltaY < 0 ? 1.05 : 1 / 1.05) });
}
</script>

<template>
  <div class="la" data-testid="live2d-adjust">
    <div ref="layer" class="la-drag" role="presentation" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @wheel.prevent="wheel" />
    <section class="la-panel" role="dialog" :aria-label="`调${character.name}在画面里的位置和大小`">
      <div class="flex items-center gap-2">
        <span class="i-lucide-move text-accent-ink shrink-0" />
        <span class="flex-1 min-w-0 truncate text-[13.5px] font-600">位置和大小</span>
        <button type="button" class="la-btn" :disabled="untouched" data-testid="live2d-adjust-reset" @click="set({ zoom: 1, x: 0, y: 0 })">恢复默认</button>
        <button type="button" class="la-btn done" data-testid="live2d-adjust-done" @click="emit('close')">好了</button>
      </div>
      <p class="la-hint">直接拖{{ character.pronoun }}挪位置，两指捏合或滚轮缩放，也能拉滑块；会记在这个角色上。</p>
      <div class="la-row">
        <span class="la-label">左右</span>
        <van-slider v-model="x" :min="FRAMING_LIMITS.x[0]" :max="FRAMING_LIMITS.x[1]" :step="0.5" bar-height="4px" button-size="16px" aria-label="左右" />
      </div>
      <div class="la-row">
        <span class="la-label">上下</span>
        <van-slider v-model="y" :min="FRAMING_LIMITS.y[0]" :max="FRAMING_LIMITS.y[1]" :step="0.5" bar-height="4px" button-size="16px" aria-label="上下" />
      </div>
      <div class="la-row">
        <span class="la-label">大小</span>
        <van-slider v-model="zoom" :min="FRAMING_LIMITS.zoom[0] * 100" :max="FRAMING_LIMITS.zoom[1] * 100" :step="1" bar-height="4px" button-size="16px" aria-label="大小" />
        <span class="la-num num">{{ zoom }}%</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.la {
  position: absolute;
  inset: 0;
  z-index: 40;
}
.la-drag {
  position: absolute;
  inset: 0;
  cursor: grab;
  touch-action: none;
}
.la-drag:active {
  cursor: grabbing;
}
.la-panel {
  position: absolute;
  /* 放在最下面：这里平时是通话按钮，脸和上半身都露在外面 */
  bottom: calc(var(--safe-bottom) + 12px);
  left: 12px;
  right: 12px;
  padding: 10px 12px 12px;
  border-radius: 18px;
  /* 通话页不分深浅主题，字一直是浅色的（CallPage 里改了 --ink），面板也固定用深色的玻璃 */
  background: rgba(17, 11, 28, 0.88);
  border: 1px solid rgba(255, 255, 255, 0.12);
  color: var(--ink);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  animation: rise 0.2s var(--ease) both;
}
.la-btn {
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.12);
  color: var(--ink-2);
  font-size: 12.5px;
  flex-shrink: 0;
}
.la-btn:disabled {
  opacity: 0.5;
}
.la-btn.done {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.la-hint {
  margin: 6px 0 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-3);
}
.la-row {
  display: flex;
  align-items: center;
  gap: 12px;
  height: 28px;
  padding-right: 6px;
}
.la-row .van-slider {
  flex: 1;
  --van-slider-inactive-background: rgba(255, 255, 255, 0.22);
}
.la-label {
  width: 2.2em;
  font-size: 12.5px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.la-num {
  width: 3em;
  text-align: right;
  font-size: 12px;
  color: var(--ink-3);
  flex-shrink: 0;
}
</style>
