<script setup lang="ts">
import type { Character, MapLocation, TimeOfDay, TownDesign, World } from '@app/shared';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRhythmStore } from '@/stores/rhythm';
import { drawRain, drawSprite, drawWaterShimmer, renderStatic, spriteTint, type StaticLayer } from './art';
import { buildLayout, FLAT_SHAPES, TILE, type Plot } from './layout';
import { lookFor } from './look';
import { spriteLookOf, type SpriteLook } from './sprite';

/**
 * 像素小镇：按世界数据和 AI 写的蓝图（design）生成的图块地图。
 * - 没有蓝图时按地名猜一份示例的样子；preview 可以临时换成某一份示例（预览用）。
 * - 拖动（或触控板滚动）平移；默认镜头对准 focusId 那个角色。
 * - 点建筑 → select-location；点小人 → select-character。
 * - flyTo(地点)：镜头推进到那栋楼（一键直达时用），推进完再跳转。
 * 地名、气泡是 DOM 叠在画布上，文字始终清楚。
 */
const props = withDefaults(
  defineProps<{
    world: World;
    characters: Character[];
    design?: TownDesign | null;
    preview?: string | null;
    tod: TimeOfDay;
    rain?: boolean;
    focusId?: string | null;
    bubbles?: Record<string, string>;
  }>(),
  { design: null, preview: null, rain: false, focusId: null, bubbles: () => ({}) },
);
const emit = defineEmits<{
  (e: 'select-location', loc: MapLocation): void;
  (e: 'select-character', c: Character): void;
}>();

/** 蓝图 → 能画的样子（每栋楼的形状、大小、材料、颜色） */
const resolved = computed(() => lookFor(props.world, props.design, props.preview));
const layout = computed(() => {
  const { look, builds } = resolved.value;
  const sizes = new Map([...builds].map(([id, b]) => [id, { shape: b.shape, w: b.w, h: b.h }]));
  const trees = { grass: 1, moss: 1.2, dirt: 0.7, sand: 0.35, snow: 0.6, stone: 0.45, asphalt: 0.25, ash: 0.4 }[look.ground];
  return buildLayout(props.world, { sizes, water: look.water, edges: look.edges, trees });
});
const staticLayer = shallowRef<StaticLayer | null>(null);
/** 画不出来时保留上一张，别让一处画法的问题卡住整页 */
function rebuild() {
  try {
    staticLayer.value = renderStatic(layout.value, resolved.value.look, resolved.value.builds, props.tod);
  } catch (e) {
    console.error('[town] 小镇没画出来', e);
  }
}

// —— 尺寸：一个画布像素 = 整数个屏幕像素，保证像素方正 ——
const dpr = typeof window === 'undefined' ? 2 : Math.min(3, window.devicePixelRatio || 1);
const devPx = Math.max(2, Math.round(dpr));
const css = devPx / dpr;
const artW = computed(() => layout.value.w * TILE);
const artH = computed(() => layout.value.h * TILE);

const box = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();
const ox = ref(0);
const oy = ref(0);
const zoom = ref(1);
const flying = ref(false);
const boxSize = ref({ w: 390, h: 420 });

function clampOffset(x: number, y: number) {
  const mw = artW.value * css;
  const mh = artH.value * css;
  const { w, h } = boxSize.value;
  return { x: Math.min(0, Math.max(w - mw, x)), y: Math.min(0, Math.max(h - mh, y)) };
}
function centerOn(artX: number, artY: number) {
  const { w, h } = boxSize.value;
  const c = clampOffset(w / 2 - artX * css, h * 0.46 - artY * css);
  ox.value = c.x;
  oy.value = c.y;
}

// —— 谁在哪 ——
const plotOf = (locId: string | null | undefined) => layout.value.plots.find((p) => p.loc.id === locId);
interface Walker {
  c: Character;
  plot: Plot;
  x: number;
  y: number;
  look: SpriteLook;
}
const rhythm = useRhythmStore();
const walkers = computed<Walker[]>(() => {
  const used = new Map<string, number>();
  const list: Walker[] = [];
  for (const c of props.characters) {
    const plot = plotOf(c.locationId);
    if (!plot) continue;
    const n = used.get(plot.loc.id) ?? 0;
    used.set(plot.loc.id, n + 1);
    list.push({
      c,
      plot,
      x: plot.doorX * TILE + 3 + n * 12 + 9,
      y: plot.doorY * TILE - 6,
      // 衣服颜色看她今天穿的那套
      look: spriteLookOf(c, rhythm.outfitFor(c.id, null)?.tags ?? ''),
    });
  }
  return list;
});

function focusNow() {
  const w = walkers.value.find((w) => w.c.id === props.focusId) ?? walkers.value[0];
  if (w) centerOn(w.x + 5, w.y);
  else centerOn(artW.value / 2, artH.value / 2);
}

// —— 画 ——
let raf = 0;
let last = 0;
/** 小人先画在小画布上，夜里乘上时段颜色（再用自己的轮廓裁一次，背景不被染色） */
const spriteCanvas = typeof document === 'undefined' ? null : document.createElement('canvas');
const spriteMask = typeof document === 'undefined' ? null : document.createElement('canvas');
function tintedSprite(look: SpriteLook, f: number, tint: string): HTMLCanvasElement {
  const a = spriteCanvas!;
  const m = spriteMask!;
  a.width = m.width = 12;
  a.height = m.height = 18;
  const s = a.getContext('2d')!;
  drawSprite(s, 1, 0, look, f);
  drawSprite(m.getContext('2d')!, 1, 0, look, f);
  s.globalCompositeOperation = 'multiply';
  s.fillStyle = tint;
  s.fillRect(0, 0, 12, 18);
  s.globalCompositeOperation = 'destination-in';
  s.drawImage(m, 0, 0);
  s.globalCompositeOperation = 'source-over';
  return a;
}
function frame(now: number) {
  raf = requestAnimationFrame(frame);
  if (now - last < 120 || document.hidden) return;
  last = now;
  paint(now / 1000);
}
function paint(t: number) {
  const cv = canvas.value;
  const st = staticLayer.value;
  if (!cv || !st) return;
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(devPx, 0, 0, devPx, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(st.canvas, 0, 0);
  drawWaterShimmer(ctx, layout.value, resolved.value.look, t);
  const tint = spriteTint(props.tod);
  for (const w of walkers.value) {
    const f = Math.floor(t * 2 + w.x) % 2;
    // 脚下一圈她的颜色，一呼一吸，找得到她
    ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t * 3);
    ctx.fillStyle = w.look.outfit;
    ctx.fillRect(w.x - 2, w.y + 14, 14, 3);
    ctx.fillRect(w.x - 1, w.y + 13, 12, 5);
    ctx.globalAlpha = 1;
    if (tint && spriteCanvas) ctx.drawImage(tintedSprite(w.look, f, tint), w.x - 1, w.y);
    else drawSprite(ctx, w.x, w.y, w.look, f);
  }
  if (props.rain) drawRain(ctx, artW.value, artH.value, t);
}

// —— 拖动 ——
let down: { x: number; y: number; ox: number; oy: number; id: number } | null = null;
let dragged = false;
function onDown(e: PointerEvent) {
  if (flying.value) return;
  down = { x: e.clientX, y: e.clientY, ox: ox.value, oy: oy.value, id: e.pointerId };
  dragged = false;
}
function onMove(e: PointerEvent) {
  if (!down || e.pointerId !== down.id) return;
  const dx = e.clientX - down.x;
  const dy = e.clientY - down.y;
  if (!dragged && Math.hypot(dx, dy) > 6) {
    dragged = true;
    box.value?.setPointerCapture(e.pointerId);
  }
  if (dragged) {
    const c = clampOffset(down.ox + dx, down.oy + dy);
    ox.value = c.x;
    oy.value = c.y;
  }
}
function onUp(e: PointerEvent) {
  if (down && e.pointerId === down.id) down = null;
  if (box.value?.hasPointerCapture(e.pointerId)) box.value.releasePointerCapture(e.pointerId);
}
function onWheel(e: WheelEvent) {
  if (flying.value) return;
  e.preventDefault();
  const c = clampOffset(ox.value - e.deltaX, oy.value - e.deltaY);
  ox.value = c.x;
  oy.value = c.y;
}
function tapLocation(p: Plot) {
  if (dragged) return;
  emit('select-location', p.loc);
}
function tapCharacter(c: Character) {
  if (dragged) return;
  emit('select-character', c);
}

/** 镜头推进到那个地点：平移 + 放大，结束后 resolve */
function flyTo(locationId: string): Promise<void> {
  const p = plotOf(locationId);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!p || reduce) return Promise.resolve();
  flying.value = true;
  centerOn((p.x + p.w / 2) * TILE, (p.y + p.h / 2) * TILE);
  zoom.value = 2.2;
  return new Promise((r) => setTimeout(r, 460));
}
function resetCamera() {
  flying.value = false;
  zoom.value = 1;
  focusNow();
}
defineExpose({ flyTo, resetCamera });

// —— 地名和气泡的位置（画布像素 → CSS 像素） ——
/** 地名写在自己的地块里：有屋顶的写在屋顶上，平地（跑道、公园、摊位、栈道、沙滩）写在场地中间，不会压到别人 */
const labels = computed(() =>
  layout.value.plots.map((p) => ({
    p,
    left: (p.x + p.w / 2) * TILE * css,
    top: (FLAT_SHAPES.has(p.shape) ? (p.y + p.h / 2) * TILE + 6 : p.y * TILE + 14) * css,
    here: walkers.value.some((w) => w.plot === p),
  })),
);

let ro: ResizeObserver | null = null;
onMounted(() => {
  rebuild();
  if (box.value) {
    boxSize.value = { w: box.value.clientWidth, h: box.value.clientHeight };
    ro = new ResizeObserver(() => {
      if (!box.value) return;
      boxSize.value = { w: box.value.clientWidth, h: box.value.clientHeight };
      if (!flying.value) focusNow();
    });
    ro.observe(box.value);
  }
  focusNow();
  paint(0);
  raf = requestAnimationFrame(frame);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  ro?.disconnect();
});
watch(
  () => [layout.value, resolved.value, props.tod],
  () => {
    rebuild();
    paint(performance.now() / 1000);
  },
);
watch(
  () => [props.world.id, props.focusId],
  () => focusNow(),
);
</script>

<template>
  <div
    ref="box"
    class="town"
    role="group"
    :aria-label="world.name"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @wheel="onWheel"
  >
    <div
      class="town-map"
      :class="{ flying }"
      :style="{
        width: `${artW * css}px`,
        height: `${artH * css}px`,
        transform: `translate(${ox}px, ${oy}px)`,
      }"
    >
      <div class="town-zoom" :style="{ transform: `scale(${zoom})`, transformOrigin: `${-ox + boxSize.w / 2}px ${-oy + boxSize.h * 0.46}px` }">
        <canvas ref="canvas" :width="artW * devPx" :height="artH * devPx" :style="{ width: `${artW * css}px`, height: `${artH * css}px` }" />
        <button
          v-for="l in labels"
          :key="l.p.loc.id"
          class="hit"
          :style="{ left: `${l.p.x * TILE * css}px`, top: `${(l.p.y * TILE - 6) * css}px`, width: `${l.p.w * TILE * css}px`, height: `${(l.p.h * TILE + 6) * css}px` }"
          :aria-label="l.p.loc.name"
          :data-place="l.p.loc.id"
          @click="tapLocation(l.p)"
        />
        <span v-for="l in labels" :key="`t-${l.p.loc.id}`" class="tag" :class="{ here: l.here }" :style="{ left: `${l.left}px`, top: `${l.top}px` }">{{ l.p.loc.name }}</span>
        <template v-for="w in walkers" :key="w.c.id">
          <button class="who" :style="{ left: `${(w.x + 5) * css}px`, top: `${(w.y + 8) * css}px` }" :aria-label="w.c.name" @click="tapCharacter(w.c)" />
          <span v-if="bubbles[w.c.id]" class="bubble" :style="{ left: `${(w.x + 5) * css}px`, top: `${(w.y - 4) * css}px` }">{{ bubbles[w.c.id] }}</span>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.town {
  position: absolute;
  inset: 0;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  cursor: grab;
  background: #1b1f2a;
}
.town:active {
  cursor: grabbing;
}
.town-map {
  position: absolute;
  left: 0;
  top: 0;
  will-change: transform;
}
.town-map.flying {
  transition: transform 0.42s cubic-bezier(0.3, 0.7, 0.2, 1);
}
.town-zoom {
  position: absolute;
  inset: 0;
  transition: transform 0.46s cubic-bezier(0.5, 0, 0.3, 1);
}
canvas {
  display: block;
  image-rendering: pixelated;
  image-rendering: crisp-edges;
}
.hit,
.who {
  position: absolute;
  background: none;
  border: 0;
  padding: 0;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
}
.who {
  width: 34px;
  height: 40px;
  transform: translate(-50%, -50%);
}
.hit:focus-visible,
.who:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
  border-radius: 6px;
}
.tag {
  position: absolute;
  transform: translate(-50%, -100%);
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 10.5px;
  line-height: 16px;
  white-space: nowrap;
  color: #fff;
  background: rgba(24, 20, 30, 0.58);
  pointer-events: none;
}
.tag.here {
  background: rgba(24, 20, 30, 0.82);
  font-weight: 600;
}
.bubble {
  position: absolute;
  transform: translate(-50%, -100%);
  max-width: 180px;
  padding: 4px 9px;
  border-radius: 10px;
  font-size: 12px;
  line-height: 1.35;
  color: #2a2230;
  background: #fff;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.18);
  pointer-events: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  animation: bob 2.4s ease-in-out infinite;
}
.bubble::after {
  content: '';
  position: absolute;
  left: 50%;
  bottom: -4px;
  width: 8px;
  height: 8px;
  background: #fff;
  transform: translateX(-50%) rotate(45deg);
}
@keyframes bob {
  50% {
    margin-top: -2px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .bubble {
    animation: none;
  }
}
</style>
