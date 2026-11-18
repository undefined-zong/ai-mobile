<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useDragFloat, type FloatPos } from '@/composables/useDragFloat';
import { useTheater } from '@/composables/useTheater';

/**
 * 视频浮窗（一起吃饭时的下饭视频、健身时边练边看的视频）：放在一个划好范围的父元素里，像健身的计时器那样按住拖着走（composables/useDragFloat.ts）。
 * - 拖：按住上面那一条；位置记成能放的范围里的比例，转屏、弹键盘还在差不多的地方，也拖不出去；
 * - 调大小：拖右下角那个角标（键盘是左右键），左上角不动；宽度记成范围宽度的比例，画面照 16:9；
 * - 全屏：铺满整个屏幕，手机竖着时里面转成横的（composables/useTheater.ts，和一起观影的放映厅一样）；
 *   进出全屏只改样式，不挪 iframe（一挪就重新加载、从头放）。播放器自己的全屏按钮也照常能用。
 * 位置和大小记在本机（storageKey），下次打开还在那儿；没动过时用 home、width，给了 above 就贴着它的上边放（不挡住它）。
 */
const props = withDefaults(
  defineProps<{
    /** 嵌入播放器的地址 */
    src: string;
    title: string;
    /** 位置和大小存在本机的哪一项 */
    storageKey: string;
    /** 没拖过时放哪（能放的范围里的比例） */
    home?: FloatPos;
    /** 没拖过时贴着这个元素的上边放（一起吃饭：放在"这顿吃的"那张卡片上面，不挡输入；健身：动作卡 / 那一排数上面）；放不下、没给时照 home 的上下位置 */
    above?: HTMLElement | null;
    /** 没调过大小时多宽（范围宽度的比例） */
    width?: number;
    /** 最窄能缩到多少（范围宽度的比例；再窄上面那一条的按钮就挤了） */
    minWidth?: number;
  }>(),
  { home: () => ({ x: 0.5, y: 0.5 }), above: null, width: 0.6, minWidth: 0.4 },
);
const emit = defineEmits<{ (e: 'close'): void; (e: 'full', on: boolean): void }>();

/** 画面的宽高比 */
const RATIO = 16 / 9;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const clampWidth = (w: number) => Math.min(1, Math.max(props.minWidth, w));
const validPos = (p: unknown): p is FloatPos => !!p && typeof p === 'object' && Number.isFinite((p as FloatPos).x) && Number.isFinite((p as FloatPos).y);

function loadSaved(): { pos?: unknown; width?: unknown } {
  try {
    const v = JSON.parse(localStorage.getItem(props.storageKey) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as { pos?: unknown; width?: unknown }) : {};
  } catch {
    return {};
  }
}
const saved = loadSaved();
/** 你拖过、调过大小：之后就放在你放的地方 */
const placed = validPos(saved.pos);
const pos = ref<FloatPos>(validPos(saved.pos) ? { x: clamp01(saved.pos.x), y: clamp01(saved.pos.y) } : { ...props.home });
const width = ref(clampWidth(typeof saved.width === 'number' && Number.isFinite(saved.width) ? saved.width : props.width));
function persist() {
  try {
    localStorage.setItem(props.storageKey, JSON.stringify({ pos: pos.value, width: width.value }));
  } catch {
    // 存不下就算了
  }
}

// —— 拖着走 ——
const { el, dragging, style: dragStyle, listeners, onClickCapture } = useDragFloat(pos, persist);
onMounted(() => {
  const node = el.value;
  const area = node?.offsetParent as HTMLElement | null;
  if (placed || !node || !area || !props.above) return;
  const room = area.clientHeight - node.offsetHeight;
  const top = props.above.getBoundingClientRect().top - area.getBoundingClientRect().top - node.offsetHeight;
  if (room > 0 && top >= 0) pos.value = { x: pos.value.x, y: clamp01(top / room) };
});

// —— 调大小：拖右下角，左上角不动（角标上的这几下不往外传，外面那层不会当成拖着走） ——
const screenEl = ref<HTMLElement | null>(null);
const resizing = ref(false);
let grip: { id: number; x: number; w: number; left: number; top: number; areaW: number; areaH: number; chrome: number } | null = null;
function onGripDown(e: PointerEvent) {
  const node = el.value;
  const area = node?.offsetParent as HTMLElement | null;
  const screen = screenEl.value;
  if (!node || !area || !screen || (e.pointerType === 'mouse' && e.button !== 0)) return;
  const box = node.getBoundingClientRect();
  const range = area.getBoundingClientRect();
  grip = { id: e.pointerId, x: e.clientX, w: box.width, left: box.left - range.left, top: box.top - range.top, areaW: area.clientWidth, areaH: area.clientHeight, chrome: box.height - screen.getBoundingClientRect().height };
  resizing.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
}
function onGripMove(e: PointerEvent) {
  const g = grip;
  if (!g || e.pointerId !== g.id) return;
  // 最宽：不超出范围的右边和下边
  const max = Math.min(g.areaW - g.left, (g.areaH - g.top - g.chrome) * RATIO);
  const w = Math.max(Math.min(props.minWidth * g.areaW, max), Math.min(g.w + e.clientX - g.x, max));
  const h = g.chrome + w / RATIO;
  width.value = clampWidth(w / g.areaW);
  // 位置是"剩下的地方里的比例"：大小变了，照左上角不动重新算
  pos.value = { x: g.areaW - w > 0 ? clamp01(g.left / (g.areaW - w)) : 0, y: g.areaH - h > 0 ? clamp01(g.top / (g.areaH - h)) : 0 };
}
function onGripUp(e: PointerEvent) {
  if (!grip || e.pointerId !== grip.id) return;
  grip = null;
  resizing.value = false;
  persist();
}
/** 键盘（角标上按左右键）：一下调范围宽度的这么多 */
const KEY_STEP = 0.05;
function nudge(dir: 1 | -1) {
  width.value = clampWidth(width.value + dir * KEY_STEP);
  persist();
}

// —— 全屏 ——
const { on: full, rotate, size, enter, exit } = useTheater(el);
watch(full, (on) => emit('full', on));
/** 要在点击里同步调用（系统全屏只认用户刚点过） */
function toggleFull() {
  if (full.value) exit();
  else enter();
}
/** 屏幕竖着：里面的内容框宽高对调、转 90° */
const boxStyle = computed(() => (rotate.value ? { width: `${size.value.h}px`, height: `${size.value.w}px`, left: `${size.value.w}px` } : {}));
const winStyle = computed(() => (full.value ? {} : { ...dragStyle.value, width: `${width.value * 100}%` }));
</script>

<template>
  <div
    ref="el"
    class="vwin"
    :class="{ dragging, resizing, full }"
    :style="winStyle"
    role="group"
    :aria-label="`视频：${title}`"
    data-testid="float-video"
    v-on="full ? {} : listeners"
    @click.capture="onClickCapture"
  >
    <div class="vbox" :class="{ rot: rotate }" :style="boxStyle">
      <div class="vbar">
        <span v-if="!full" class="i-lucide-grip-horizontal shrink-0 opacity-70" aria-hidden="true" />
        <span class="flex-1 min-w-0 truncate" :title="title">{{ title }}</span>
        <button type="button" class="vbtn" :aria-label="full ? '退出全屏' : '全屏'" data-testid="float-video-full" @click="toggleFull">
          <span :class="full ? 'i-lucide-minimize-2' : 'i-lucide-maximize-2'" />
        </button>
        <button type="button" class="vbtn" aria-label="不看了" data-testid="float-video-close" @click="emit('close')"><span class="i-lucide-x" /></button>
      </div>
      <div ref="screenEl" class="vscreen">
        <iframe :src="src" :title="`B 站播放器：${title}`" allow="autoplay; fullscreen; encrypted-media; picture-in-picture" allowfullscreen data-testid="float-video-frame" />
      </div>
      <!-- 角标放在画面下面的一条里：不压住播放器自己右下角的全屏按钮 -->
      <div v-if="!full" class="vfoot">
        <span
          class="vgrip"
          role="slider"
          tabindex="0"
          aria-label="调整大小：拖动，或者按左右键"
          aria-orientation="horizontal"
          :aria-valuemin="Math.round(minWidth * 100)"
          aria-valuemax="100"
          :aria-valuenow="Math.round(width * 100)"
          data-testid="float-video-grip"
          @pointerdown.stop.prevent="onGripDown"
          @pointermove.stop="onGripMove"
          @pointerup.stop="onGripUp"
          @pointercancel.stop="onGripUp"
          @keydown.left.prevent="nudge(-1)"
          @keydown.right.prevent="nudge(1)"
        >
          <span class="i-lucide-move-diagonal-2" />
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vwin {
  position: absolute;
  display: flex;
  flex-direction: column;
  max-width: 100%;
  max-height: 100%;
  border-radius: 14px;
  border: 1px solid var(--glass-line);
  background: var(--veil);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: var(--shadow-sm);
  pointer-events: auto;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  transition: box-shadow 0.15s ease;
}
.vwin.dragging,
.vwin.resizing {
  box-shadow: var(--shadow);
}
/* 拖、调大小时手指会经过画面：别让 iframe 把这一下抢走 */
.vwin.dragging iframe,
.vwin.resizing iframe {
  pointer-events: none;
}
.vbox {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  border-radius: inherit;
}
.vbar {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  height: 32px;
  padding: 0 3px 0 10px;
  color: var(--ink-2);
  font-size: 12px;
  cursor: grab;
}
.vwin.dragging .vbar {
  cursor: grabbing;
}
.vbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  color: var(--ink);
  font-size: 14px;
}
/* 范围不够高时画面变矮（播放器自己留黑边），不顶出去 */
.vscreen {
  flex: 0 1 auto;
  min-height: 0;
  aspect-ratio: 16 / 9;
  background: #000;
}
.vscreen iframe {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
}
.vfoot {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
  height: 18px;
}
.vgrip {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 100%;
  color: var(--ink-2);
  font-size: 13px;
  cursor: nwse-resize;
  touch-action: none;
}
/* 手指好按：能按的地方比看到的大一圈（往窗外伸，不压画面） */
.vgrip::after {
  content: '';
  position: absolute;
  inset: 0 -8px -12px -14px;
}

/* —— 全屏：铺满屏幕、没有内边距（系统全屏时就是整个屏幕） —— */
.vwin.full {
  position: fixed;
  inset: 0;
  z-index: 70;
  max-width: none;
  max-height: none;
  border: 0;
  border-radius: 0;
  background: #000;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  overflow: hidden;
}
.vwin.full .vbox {
  position: absolute;
  inset: 0;
  --full-l: env(safe-area-inset-left, 0px);
  --full-r: env(safe-area-inset-right, 0px);
  --full-t: env(safe-area-inset-top, 0px);
}
/* 屏幕竖着：框的左上角放在屏幕右上角，顺时针转 90°（手机往左横过来看就是正的） */
.vwin.full .vbox.rot {
  inset: auto;
  top: 0;
  transform-origin: 0 0;
  transform: rotate(90deg);
  --full-l: env(safe-area-inset-top, 0px);
  --full-r: env(safe-area-inset-bottom, 0px);
  --full-t: 0px;
}
.vwin.full .vbar {
  box-sizing: content-box;
  padding: var(--full-t) calc(var(--full-r) + 6px) 0 calc(var(--full-l) + 12px);
  color: #fff;
  cursor: default;
}
.vwin.full .vbtn {
  color: #fff;
}
.vwin.full .vscreen {
  flex: 1;
  aspect-ratio: auto;
}
</style>
