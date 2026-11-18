<script setup lang="ts">
import type { SceneId } from '@app/shared';
import type { TogetherTile } from '@/composables/useTogether';

/**
 * 一起做点什么的格子（一行 4 个）：点一下去做，长按活动换地方。
 * more 有数时最后多一格"其他"（放不下的在页面自己的面板里）；markNear 时她此刻在的地方就能做的标出来。
 */
const props = withDefaults(defineProps<{ tiles: TogetherTile[]; disabled?: boolean; more?: number; markNear?: boolean }>(), {
  disabled: false,
  more: 0,
  markNear: false,
});
const emit = defineEmits<{ (e: 'pick', tile: TogetherTile): void; (e: 'choose', scene: SceneId): void; (e: 'more'): void }>();

let pressTimer = 0;
let longPressed = false;
function pressStart(t: TogetherTile) {
  longPressed = false;
  clearTimeout(pressTimer);
  const scene = t.scene;
  if (!scene) return;
  pressTimer = window.setTimeout(() => {
    longPressed = true;
    emit('choose', scene);
    navigator.vibrate?.(10);
  }, 480);
}
function pressEnd() {
  clearTimeout(pressTimer);
}
function tap(t: TogetherTile) {
  if (longPressed) {
    longPressed = false;
    return;
  }
  emit('pick', t);
}
</script>

<template>
  <div class="acts">
    <button
      v-for="t in props.tiles"
      :key="t.key"
      class="act press"
      :class="{ near: markNear && t.near }"
      :style="{ '--tone': t.tint }"
      :data-scene="t.key"
      :disabled="disabled"
      @pointerdown="pressStart(t)"
      @pointerup="pressEnd"
      @pointerleave="pressEnd"
      @pointercancel="pressEnd"
      @contextmenu.prevent
      @click="tap(t)"
    >
      <span class="act-icon"><span :class="t.icon" /></span>
      <span class="act-name">{{ t.name }}</span>
      <span class="act-where">{{ t.where }}</span>
    </button>
    <button v-if="more" class="act press" style="--tone: var(--ink-3)" data-act="other" @click="emit('more')">
      <span class="act-icon"><span class="i-lucide-layout-grid" /></span>
      <span class="act-name">其他</span>
      <span class="act-where">还有 {{ more }} 项</span>
    </button>
  </div>
</template>

<style scoped>
.acts {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.act {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1px;
  min-width: 0;
  padding: 8px 4px 7px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: inherit;
  text-decoration: none;
  -webkit-touch-callout: none;
  user-select: none;
}
.act.near {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.act-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  color: var(--tone);
  font-size: 19px;
  flex-shrink: 0;
}
.act-icon::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: var(--tone);
  opacity: 0.18;
}
.act-icon > span {
  position: relative;
}
/* 窄屏 + 系统大字体时字号跟着屏宽缩一点，四个字的名字也放得下 */
.act-name {
  margin-top: 2px;
  font-size: min(13.5px, 3.4vw);
  font-weight: 600;
  white-space: nowrap;
}
.act-where {
  max-width: 100%;
  overflow: hidden;
  color: var(--ink-3);
  font-size: min(11px, 3vw);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.act:disabled {
  opacity: 0.6;
}
</style>
