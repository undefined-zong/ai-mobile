<script setup lang="ts">
import { worldOf, type BackgroundPlace, type Character, type DayOutfit, type PokeHotspot, type TimeOfDay } from '@app/shared';
import { computed, ref } from 'vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import type { FaceFrame } from '@/components/scene/location';
import { faceOf, hotspotsOf, portraitAspect } from '@/services/portraits';

/**
 * 舞台：背景 + 立绘（表情交叉淡化）+ 戳戳乐热区 + 覆盖层插槽（对话框、顶部按钮）。
 * 立绘框高度按 layout，宽度按立绘的宽高比（没有立绘时是占位立绘的 600:1000）；热区坐标相对立绘框（0-1）。
 * outfit / pose 是场景要的服装、姿势，dayOutfit 是节律里今天穿的那套：有立绘时按它们挑一张（PortraitFigure）。
 * 给了 faceFrame 时不按 layout 摆，按她的头像框把脸放到画面里（聚焦主题完整对话上面露出的那一截）：
 * x / y 是脸的中心在画面里的位置，size 是脸（头像框）占画面高度的多少；立绘设置里拖头像框、调这个画面都跟着变。
 */
const props = withDefaults(
  defineProps<{
    character: Character;
    expression: string;
    outfit?: string;
    pose?: string;
    dayOutfit?: DayOutfit;
    /** 同一个样子有几张时挑哪张；不给时跟着换表情的次数轮 */
    seed?: number;
    backdrop?: string;
    location?: BackgroundPlace | null;
    backgroundContext?: string;
    tod?: TimeOfDay;
    rain?: boolean;
    dim?: number;
    pokeable?: boolean;
    showHotspots?: boolean;
    /** 戳的时候怎么碰（戳戳乐里用手 / 用嘴 / 蹭蹭）：热区读屏念的动词、点一下和长按时冒出来的图标 */
    pokeAs?: { verb: string; tap: string; long: string };
    /** 立绘框位置：水平中心 %、距底部 %、高度 % */
    layout?: { left: number; bottom: number; height: number };
    faceFrame?: FaceFrame | null;
  }>(),
  {
    outfit: 'daily',
    pose: 'stand',
    backdrop: 'bedroom',
    rain: false,
    dim: 0,
    pokeable: false,
    showHotspots: false,
    pokeAs: () => ({ verb: '戳', tap: 'i-lucide-heart', long: 'i-lucide-hand-heart' }),
    layout: () => ({ left: 50, bottom: 14, height: 76 }),
    faceFrame: null,
  },
);
const emit = defineEmits<{ (e: 'poke', hotspot: PokeHotspot, kind: 'tap' | 'long'): void }>();

const root = ref<HTMLElement | null>(null);
const backgroundContext = computed(() => {
  const world = worldOf(props.character.id);
  return [world.name, world.blurb, props.character.card.scenario, props.character.card.description, props.backgroundContext].filter(Boolean).join('\n');
});
const pokeHotspots = computed(() => hotspotsOf(props.character));
const boxStyle = computed(() => {
  const aspect = portraitAspect(props.character);
  const ff = props.faceFrame;
  if (ff) {
    // 画面是 size 容器：立绘框宽 = 脸要占的高度 ÷ 头像框占框宽的比例，再把脸的中心挪到 (x, y)
    const face = faceOf(props.character);
    const w = `(${ff.size} * 100cqh / ${face.size})`;
    return {
      width: `calc${w}`,
      height: `calc(${w} / ${aspect})`,
      left: `calc(${ff.x} * 100cqw - ${face.x} * ${w})`,
      top: `calc(${ff.y} * 100cqh - ${face.y} * ${w} / ${aspect})`,
      transform: 'none',
      maxWidth: 'none',
    };
  }
  return {
    left: `${props.layout.left}%`,
    bottom: `${props.layout.bottom}%`,
    height: `${props.layout.height}%`,
    aspectRatio: String(aspect),
  };
});

function shapeStyle(h: PokeHotspot) {
  if (h.shape.kind === 'rect') {
    return { left: `${h.shape.x * 100}%`, top: `${h.shape.y * 100}%`, width: `${h.shape.w * 100}%`, height: `${h.shape.h * 100}%` };
  }
  const xs = h.shape.points.map((p) => p[0]);
  const ys = h.shape.points.map((p) => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    width: `${(Math.max(...xs) - x) * 100}%`,
    height: `${(Math.max(...ys) - y) * 100}%`,
    clipPath: `polygon(${h.shape.points.map((p) => `${((p[0] - x) / (Math.max(...xs) - x)) * 100}% ${((p[1] - y) / (Math.max(...ys) - y)) * 100}%`).join(',')})`,
  };
}

const effects = ref<{ id: number; x: number; y: number; kind: 'tap' | 'long' }[]>([]);
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let pressed: { h: PokeHotspot; x: number; y: number; cx: number; cy: number; long: boolean } | null = null;
/** 手指挪了这么远就不算戳（在她身上左右划、上下划时不误戳） */
const MOVE_SLOP = 12;

function local(e: PointerEvent) {
  const r = root.value?.getBoundingClientRect();
  return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
}

function spawn(x: number, y: number, kind: 'tap' | 'long') {
  const id = Date.now() + Math.random();
  effects.value.push({ id, x, y, kind });
  setTimeout(() => (effects.value = effects.value.filter((f) => f.id !== id)), 1100);
}

function down(h: PokeHotspot, e: PointerEvent) {
  const { x, y } = local(e);
  pressed = { h, x, y, cx: e.clientX, cy: e.clientY, long: false };
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => {
    if (!pressed) return;
    pressed.long = true;
    spawn(pressed.x, pressed.y, 'long');
    emit('poke', pressed.h, 'long');
  }, 480);
}

function move(e: PointerEvent) {
  if (pressed && !pressed.long && Math.hypot(e.clientX - pressed.cx, e.clientY - pressed.cy) > MOVE_SLOP) cancel();
}

function up() {
  clearTimeout(pressTimer);
  if (pressed && !pressed.long) {
    spawn(pressed.x, pressed.y, 'tap');
    emit('poke', pressed.h, 'tap');
  }
  pressed = null;
}

function cancel() {
  clearTimeout(pressTimer);
  pressed = null;
}
</script>

<template>
  <div ref="root" class="stage" :class="{ 'face-framed': faceFrame }">
    <!-- 出逃这种自己带画面（视频、会动的插画）的场景用 backdrop 插槽换掉素材库的背景，立绘照样站在上面 -->
    <slot name="backdrop">
      <SceneBackdrop :kind="backdrop" :location="location" :context="backgroundContext" :tod="tod" :rain="rain" :dim="dim" />
    </slot>
    <div class="figure-box" :style="boxStyle">
      <div class="breathe">
        <PortraitFigure :character="character" :expression="expression" :outfit="outfit" :pose="pose" :day-outfit="dayOutfit" :seed="seed" />
      </div>
      <template v-if="pokeable">
        <button
          v-for="h in pokeHotspots"
          :key="h.id"
          class="hotspot"
          :class="{ visible: showHotspots }"
          :style="shapeStyle(h)"
          :aria-label="`${pokeAs.verb}${h.label}`"
          :data-zone="h.id"
          @pointerdown="down(h, $event)"
          @pointermove="move"
          @pointerup="up"
          @pointerleave="cancel"
          @pointercancel="cancel"
          @contextmenu.prevent
        >
          <span v-if="showHotspots" class="hotspot-label">{{ h.label }}</span>
        </button>
      </template>
    </div>
    <template v-for="f in effects" :key="f.id">
      <span class="ripple" :style="{ left: `${f.x}px`, top: `${f.y}px` }" />
      <span class="heart" :class="f.kind === 'long' ? pokeAs.long : pokeAs.tap" :style="{ left: `${f.x}px`, top: `${f.y}px` }" />
    </template>
    <slot />
  </div>
</template>

<style scoped>
.stage {
  position: absolute;
  inset: 0;
  overflow: hidden;
  user-select: none;
  -webkit-user-select: none;
}
.face-framed {
  container-type: size;
}
.figure-box {
  position: absolute;
  transform: translateX(-50%);
  max-width: 96%;
}
.breathe {
  position: absolute;
  inset: 0;
  animation: breathe 5s ease-in-out infinite;
  transform-origin: 50% 100%;
  filter: drop-shadow(0 18px 30px rgba(0, 0, 0, 0.35));
}
.hotspot {
  position: absolute;
  border-radius: 40%;
  touch-action: manipulation;
  -webkit-touch-callout: none;
}
.hotspot.visible {
  outline: 2px dashed var(--accent);
  outline-offset: -2px;
  background: var(--accent-soft);
}
.hotspot-label {
  position: absolute;
  top: -22px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--accent);
  color: var(--on-accent);
  white-space: nowrap;
}
.ripple {
  position: absolute;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: 2px solid var(--accent);
  pointer-events: none;
  animation: ripple 0.6s ease-out forwards;
}
.heart {
  position: absolute;
  color: var(--accent);
  font-size: 22px;
  pointer-events: none;
  animation: float-up 1.1s ease-out forwards;
}
</style>
