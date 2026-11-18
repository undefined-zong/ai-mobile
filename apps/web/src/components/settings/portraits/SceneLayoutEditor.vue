<script setup lang="ts">
import { getScene, type Character, type SceneFigureAdjust } from '@app/shared';
import { computed, ref } from 'vue';
import LabelPicker from './LabelPicker.vue';
import { adjustFaceFrame, adjustFigureLayout, SCENE_FIGURE_LAYOUTS, setSceneFigureAdjust } from '@/components/scene/location';
import StageView from '@/components/stage/StageView.vue';

/**
 * 立绘设置 → 各场景的位置和大小：每个场景单独挪一挪、放大缩小（存在 PortraitSet.sceneLayouts，SceneShell 叠在场景默认位置上）。
 * 预览按手机竖屏的比例摆，可以直接拖她，也可以拉滑块。只露出一截的画面（聚焦主题完整对话上面）预览也只露出那一截，挪动按那一截算。
 */
const props = defineProps<{ character: Character }>();
const NONE: SceneFigureAdjust = { x: 0, y: 0, scale: 1 };

const sceneId = ref(SCENE_FIGURE_LAYOUTS[0]!.id);
const options = computed(() =>
  SCENE_FIGURE_LAYOUTS.map(({ id, scene, name, label }) => ({
    id,
    label: `${name ?? getScene(scene).name}${label ? ` · ${label}` : ''}${props.character.portraits?.sceneLayouts?.[id] ? ' ·调过' : ''}`,
  })),
);
const entry = computed(() => SCENE_FIGURE_LAYOUTS.find((s) => s.id === sceneId.value)!);
const scene = computed(() => getScene(entry.value.scene));
const adj = computed<SceneFigureAdjust>(() => props.character.portraits?.sceneLayouts?.[sceneId.value] ?? NONE);
const layout = computed(() => (entry.value.layout ? adjustFigureLayout(entry.value.layout, adj.value) : undefined));
const faceFrame = computed(() => (entry.value.face ? adjustFaceFrame(entry.value.face, adj.value) : null));

function set(patch: Partial<SceneFigureAdjust>) {
  setSceneFigureAdjust(props.character, sceneId.value, { ...adj.value, ...patch });
}
function reset() {
  set({ ...NONE });
}

const x = computed({ get: () => adj.value.x, set: (v: number) => set({ x: v }) });
const y = computed({ get: () => adj.value.y, set: (v: number) => set({ y: v }) });
const scale = computed({ get: () => Math.round(adj.value.scale * 100), set: (v: number) => set({ scale: v / 100 }) });

// —— 在预览里拖 ——
const frame = ref<HTMLElement | null>(null);
const peek = ref<HTMLElement | null>(null);
let drag: { id: number; sx: number; sy: number; x: number; y: number; w: number; h: number } | null = null;
function down(e: PointerEvent) {
  const r = (faceFrame.value ? peek.value : frame.value)?.getBoundingClientRect();
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
  <div class="sle" data-testid="scene-layout-editor">
    <p class="sle-hint">不同场景的立绘位置是场景定的，图的构图不一样时可能偏大、偏小或者偏到一边。这里给每个场景单独调（一个场景有几种画面的分开调）：拖预览里的人，或者拉下面的滑块。</p>
    <LabelPicker v-model="sceneId" name="选场景" :options="options" />
    <div ref="frame" class="sle-frame">
      <template v-if="faceFrame">
        <div ref="peek" class="sle-peek">
          <StageView :character="character" expression="smile" :outfit="scene.outfit" :pose="scene.pose" :backdrop="scene.backdrop" :face-frame="faceFrame" />
        </div>
        <div class="sle-sheet" aria-hidden="true" />
      </template>
      <StageView v-else :character="character" expression="smile" :outfit="scene.outfit" :pose="scene.pose" :backdrop="scene.backdrop" :location="entry.place" :tod="entry.tod" :layout="layout" />
      <div class="sle-drag" role="presentation" @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @wheel.prevent="wheel" />
    </div>
    <label class="field-label">左右 {{ x > 0 ? `往右 ${x}` : x < 0 ? `往左 ${-x}` : '不挪' }}</label>
    <van-slider v-model="x" :min="-60" :max="60" :step="0.5" bar-height="4px" button-size="18px" aria-label="左右" />
    <label class="field-label">上下 {{ y > 0 ? `往上 ${y}` : y < 0 ? `往下 ${-y}` : '不挪' }}</label>
    <van-slider v-model="y" :min="-80" :max="80" :step="0.5" bar-height="4px" button-size="18px" aria-label="上下" />
    <label class="field-label">大小 {{ scale }}%</label>
    <van-slider v-model="scale" :min="40" :max="250" :step="1" bar-height="4px" button-size="18px" aria-label="大小" />
    <button type="button" class="sle-reset" :disabled="adj === NONE" @click="reset">这个画面恢复默认</button>
  </div>
</template>

<style scoped>
.sle {
  padding: 4px 0 8px;
}
.sle-hint {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
  margin: 4px 0 10px;
}
.sle-frame {
  position: relative;
  width: min(62%, 240px);
  aspect-ratio: 9 / 19.5;
  margin: 12px auto 4px;
  border-radius: 14px;
  overflow: hidden;
  border: 1px solid var(--border);
}
.sle-peek {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 29%;
}
.sle-sheet {
  position: absolute;
  top: 25%;
  left: 0;
  right: 0;
  bottom: 0;
  border-radius: 12px 12px 0 0;
  background: var(--glass-strong);
  box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.2);
}
.sle-drag {
  position: absolute;
  inset: 0;
  z-index: 5;
  cursor: grab;
  touch-action: none;
}
.sle-reset {
  display: block;
  margin: 14px auto 0;
  font-size: 13px;
  color: var(--accent-ink);
}
.sle-reset:disabled {
  color: var(--ink-3);
}
</style>
