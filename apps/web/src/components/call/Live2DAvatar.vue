<script setup lang="ts">
import type { CharacterLive2D, DayOutfit } from '@app/shared';
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { getOne } from '@/db/idb';
import type { ModelPackage } from '@/live2d/model';
import { Live2DRenderer } from '@/live2d/renderer';

const props = withDefaults(defineProps<{
  config: CharacterLive2D; expression?: string; text?: string; sentence?: number; level?: number; audible?: boolean; outfit?: DayOutfit; previewOutfit?: string;
  /** 视线跟着鼠标 / 手指走；调位置这类要拖她的时候先关掉。角色自己关了（config.followPointer）时不跟 */
  follow?: boolean;
  /** 直接指定的姿势（通话里她写的 [pose:抱臂]、设置页的预览按钮）：姿势的 id 或名字；空着按表情和台词的映射来 */
  pose?: string;
  /** 同一个姿势再要一次时加一（抬手是抬一下就放下，第二次还得再抬） */
  poseTurn?: number;
}>(), { expression: 'neutral', text: '', sentence: 0, level: 0, audible: false, follow: true, pose: '', poseTurn: 0 });
const emit = defineEmits<{ ready: [settings: Pick<CharacterLive2D, 'parameters' | 'outfits' | 'defaultOutfit' | 'motionLabels' | 'poses'>] }>();
const canvas = ref<HTMLCanvasElement>();
const canvasKey = ref(0);
const loading = ref(true);
const error = ref('');
let avatar: Live2DRenderer | undefined;
let generation = 0;
let mounted = false;

function syncCue() { avatar?.setCue(props.expression, props.text); }
function syncPose() { avatar?.setPose(props.pose); }
function syncAudio() { avatar?.setAudio(props.level, props.audible); }
function syncOutfit() {
  try { avatar?.setOutfit(props.outfit, props.previewOutfit); }
  catch (e) { error.value = e instanceof Error ? e.message : '衣着加载失败'; }
}

// —— 视线追踪：鼠标移到哪、手指按到哪，她看向哪（从她眼睛的位置算，不是从画面中心）——
// 听整个窗口的指针：字幕、按钮盖在她身上的地方也跟。鼠标移出窗口、手指抬起后过一会儿看回正前方。
const following = () => props.follow && props.config.followPointer !== false;
let recentre: ReturnType<typeof setTimeout> | undefined;
function lookHome(delay = 0) {
  clearTimeout(recentre);
  recentre = setTimeout(() => avatar?.lookAt(0, 0), delay);
}
function onPointer(e: PointerEvent) {
  if (!avatar || !following()) return;
  // 鼠标没按着也跟；手指、笔只有碰着屏幕时才有位置
  clearTimeout(recentre);
  avatar.lookAtPoint(e.clientX, e.clientY);
}
function onPointerEnd(e: PointerEvent) {
  if (e.pointerType !== 'mouse') lookHome(900);
}
function onLeave() { lookHome(); }
function syncFollow() {
  avatar?.setFollow(following());
}
const listeners: [EventTarget, string, EventListener][] = [
  [window, 'pointermove', onPointer as EventListener],
  [window, 'pointerdown', onPointer as EventListener],
  [window, 'pointerup', onPointerEnd as EventListener],
  [window, 'pointercancel', onPointerEnd as EventListener],
  [window, 'blur', onLeave],
  [document.documentElement, 'pointerleave', onLeave],
];
function listen(on: boolean) {
  for (const [target, type, handler] of listeners) {
    if (on) target.addEventListener(type, handler, { passive: true });
    else target.removeEventListener(type, handler);
  }
}

async function load() {
  const token = ++generation;
  avatar?.dispose();
  avatar = undefined;
  loading.value = true;
  error.value = '';
  // A lost WebGL context belongs to its canvas; retry with a fresh surface.
  canvasKey.value++;
  await nextTick();
  if (token !== generation) return;
  try {
    const model = await getOne<ModelPackage>('live2d', props.config.assetId);
    if (token !== generation || !canvas.value) return;
    if (!model) throw new Error('这台设备还没有模型文件，请到角色设定重新上传');
    const instance = await Live2DRenderer.create(canvas.value, model, props.config, message => {
      if (token === generation) error.value = message;
    });
    if (token !== generation) { instance.dispose(); return; }
    avatar = instance;
    emit('ready', instance.settings());
    syncOutfit();
    syncCue();
    syncPose();
    syncAudio();
    syncFollow();
  } catch (e) { if (token === generation) error.value = e instanceof Error ? e.message : '模型加载失败'; }
  finally { if (token === generation) loading.value = false; }
}
watch(() => props.config.assetId, () => { if (mounted) void load(); });
watch(() => [props.expression, props.text, props.sentence, props.config.expressionMap, props.config.motionMap, props.config.poseMap], syncCue, { deep: true });
watch(() => [props.pose, props.poseTurn], syncPose);
watch(() => [props.level, props.audible], syncAudio, { flush: 'sync' });
watch(() => [props.outfit, props.previewOutfit, props.config.outfits, props.config.defaultOutfit], syncOutfit, { deep: true });
watch(() => [props.follow, props.config.followPointer], syncFollow);
onMounted(() => { mounted = true; listen(true); void load(); });
onBeforeUnmount(() => { generation++; listen(false); clearTimeout(recentre); avatar?.dispose(); });
defineExpose({ snapshot: () => avatar?.snapshot(), lookAt: (x: number, y: number) => avatar?.lookAt(x, y), stage: () => canvas.value?.getBoundingClientRect() });
</script>

<template>
  <div class="live2d-avatar" :data-state="error ? 'error' : loading ? 'loading' : 'ready'" data-testid="live2d-avatar">
    <canvas :key="canvasKey" ref="canvas" :class="{ hidden: loading || error }" aria-label="Live2D 角色" />
    <div v-if="loading || error" class="model-message" role="status">
      <span>{{ error || '正在加载角色…' }}</span>
      <button v-if="error" type="button" @click="load">重试</button>
    </div>
  </div>
</template>

<style scoped>
.live2d-avatar { position: relative; width: 100%; height: 100%; min-height: 120px; }
canvas { display: block; width: 100%; height: 100%; }
canvas.hidden { opacity: 0; }
.model-message { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 12px; padding: 24px; text-align: center; font-size: 13px; }
.model-message button { border: 1px solid currentColor; border-radius: 20px; padding: 6px 18px; }
</style>
