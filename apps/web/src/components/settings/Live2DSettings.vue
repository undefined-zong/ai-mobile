<script setup lang="ts">
import { EXPRESSION_LABELS, EXPRESSIONS, expressionMood, type Character, type CharacterLive2D, type Live2DOutfit } from '@app/shared';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { showToast } from 'vant';
import Live2DAvatar from '@/components/call/Live2DAvatar.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import { write } from '@/db/idb';
import { ACTION_LABELS, autoMotions, autoPose, defaultBindings, findPose, isPoseTransition, motionLabel, NO_MOTION, storedMotions } from '@/live2d/cues';
import { FRAMING_LIMITS, normalizeFraming, setFraming, type Framing } from '@/live2d/framing';
import { importModel } from '@/live2d/import';
import { Live2DRenderer } from '@/live2d/renderer';
import { useCharacterStore } from '@/stores/characters';
import { uid } from '@/utils/id';

const props = defineProps<{ character: Character }>();
const config = computed(() => props.character.live2d);
const busy = ref(false);
const progress = ref('');
const error = ref('');
/** 映射哪些表情：她有立绘时是立绘上她自己的表情，没有时是占位小人那几种 */
const faces = computed(() => {
  const own = props.character.portraits?.expressions ?? [];
  return own.length ? own.map((e) => ({ id: e.id, label: e.label, own: true })) : EXPRESSIONS.map((e) => ({ id: e, label: EXPRESSION_LABELS[e], own: false }));
});
const expression = ref(props.character.portraits?.defaultExpression || faces.value[0]?.id || 'neutral');
/** 她自己的表情没单独设时，按名字猜成的那种情绪用的是哪个 */
function autoName(id: string, map: Record<string, string>): string {
  return map[expressionMood(id, props.character.portraits)] || map.neutral || '';
}
const text = ref('');
const sentence = ref(0);
/** 预览里直接点的姿势（自然 / 抬手 / 抱臂）；换表情、点挥手点头摇头时交回给映射 */
const previewPose = ref('');
const poseTurn = ref(0);
function tryPose(id: string) { previewPose.value = id; poseTurn.value++; }
watch(expression, () => { previewPose.value = ''; });
const previewOutfit = ref('');
/** 取景：大小、左右、上下。和视频通话里"调位置"拖出来的是同一份（live2d.framing） */
const framing = computed(() => normalizeFraming(config.value?.framing));
const frame = (key: keyof Framing, unit = 1) => computed({
  get: () => Math.round(framing.value[key] * unit),
  set: (value: number) => { if (config.value && Number.isFinite(value)) setFraming(config.value, { [key]: value / unit }); },
});
const zoom = frame('zoom', 100);
const offsetX = frame('x');
const offsetY = frame('y');
const moved = computed(() => framing.value.zoom !== 1 || !!framing.value.x || !!framing.value.y);
function resetFraming() { if (config.value) setFraming(config.value, { zoom: 1, x: 0, y: 0 }); }
const follow = computed({
  get: () => config.value?.followPointer !== false,
  set: (value: boolean) => { if (config.value) config.value.followPointer = value; },
});

/**
 * 动作按文件名列出来（rest-to-wave、nod……），不是 Gesture:3 这种编号。
 * 没单独选的那些按名字自动对：这里算出来的和视频通话时实际用的是同一套（live2d/cues.ts 的 autoMotions）。
 */
const poses = computed(() => config.value?.poses ?? []);
const allMotions = computed(() => (config.value ? storedMotions(config.value) : []));
/** 能选的动作：两个姿势之间的过渡片段（rest-to-wave……）不算动作，姿势在旁边那一栏选 */
const motionList = computed(() => allMotions.value.filter((m) => !isPoseTransition(m.stem, poses.value)));
const auto = computed(() => autoMotions(allMotions.value, poses.value));
const nameOf = (key: string) => (config.value ? motionLabel(config.value, key) : key);
/** 一个表情 / 时刻没单独选动作时，实际会用哪个；没有对得上的是空的 */
function autoMotion(key: string): string {
  const map = config.value?.motionMap ?? {};
  const mood = expressionMood(key, props.character.portraits);
  const viaMood = mood !== key && map[mood] !== NO_MOTION ? map[mood] || auto.value.map[mood] : '';
  return auto.value.map[key] || viaMood || '';
}
/** 一个表情 / 时刻没单独选姿势时会摆哪个（名字）：表情落到它映射的模型表情上，冷淡、愠怒的脸自带抱臂 */
function autoPoseName(key: string, mood: boolean): string {
  const c = config.value;
  if (!c) return '';
  const face = mood ? c.expressionMap[key] || autoName(key, c.expressionMap) : '';
  const viaMood = mood ? expressionMood(key, props.character.portraits) : key;
  const own = viaMood !== key ? c.poseMap?.[viaMood] : '';
  const id = autoPose(auto.value, key, face) || (own && own !== NO_MOTION ? own : '') || (viaMood !== key ? autoPose(auto.value, viaMood, face) : '');
  return findPose(poses.value, id)?.name ?? '';
}
const zip = ref<HTMLInputElement>();
const folder = ref<HTMLInputElement>();
let mounted = true;
onBeforeUnmount(() => { mounted = false; });

async function pick(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length || busy.value) return;
  const target = props.character;
  busy.value = true;
  error.value = '';
  progress.value = '正在读取模型清单…';
  try {
    const imported = await importModel(files, message => { progress.value = message; });
    if (!mounted) return;
    progress.value = '正在检查模型和纹理…';
    let renderError = '';
    const check = await Live2DRenderer.create(document.createElement('canvas'), imported.model, imported.config, message => { renderError = message; });
    try {
      await new Promise(requestAnimationFrame);
      if (renderError) throw new Error(renderError);
      Object.assign(imported.config, check.settings());
      // 模型有姿势时（自然 / 抬手 / 抱臂）：姿势之间的过渡片段不当动作，映射按姿势重新对一遍
      if (imported.config.poses?.length) Object.assign(imported.config, defaultBindings(imported.model.manifest, imported.config.poses), { poseMap: {} });
    } finally { check.dispose(); }
    if (!mounted) return;
    progress.value = '正在保存到这台设备…';
    if (!await write('live2d', [{ key: imported.config.assetId, value: imported.model }])) throw new Error('本机存储空间不足或不可用，原模型已保留');
    const saved = { ...JSON.parse(JSON.stringify(target)), live2d: imported.config, updatedAt: Date.now() };
    if (!await write('characters', [{ key: target.id, value: saved }])) {
      await write('live2d', [], [imported.config.assetId]);
      throw new Error('角色设置保存失败，原模型已保留');
    }
    const previous = target.live2d?.assetId;
    target.live2d = imported.config;
    previewOutfit.value = '';
    target.updatedAt = saved.updatedAt;
    if (previous && !useCharacterStore().list.some(c => c.id !== target.id && c.live2d?.assetId === previous)) await write('live2d', [], [previous]);
    showToast('Live2D 已保存，可以视频通话了');
  } catch (e) { error.value = e instanceof Error ? e.message : '模型上传失败'; }
  finally { busy.value = false; }
}

async function remove() {
  const target = props.character;
  const id = target.live2d?.assetId;
  if (!id) return;
  const saved = JSON.parse(JSON.stringify(target)) as Character;
  delete saved.live2d;
  saved.updatedAt = Date.now();
  if (!await write('characters', [{ key: target.id, value: saved }])) { error.value = '移除失败，请重试'; return; }
  delete target.live2d;
  target.updatedAt = saved.updatedAt;
  if (!useCharacterStore().list.some(c => c.live2d?.assetId === id)) await write('live2d', [], [id]);
}
function action(value: string) { previewPose.value = ''; text.value = value; sentence.value++; }
function rememberSettings(settings: Pick<CharacterLive2D, 'parameters' | 'outfits' | 'defaultOutfit' | 'motionLabels' | 'poses'>) {
  if (!config.value) return;
  config.value.parameters = settings.parameters;
  // 模型能摆的姿势跟着模型走：以前上传的在这里补上
  if (JSON.stringify(settings.poses ?? []) !== JSON.stringify(config.value.poses ?? [])) config.value.poses = settings.poses;
  // 姿势的映射存在 poseMap 里：以前上传的模型没有这一栏
  if (settings.poses?.length) config.value.poseMap ??= {};
  // 以前上传的模型没有记动作的名字：打开这一页时补上
  if (settings.motionLabels && JSON.stringify(settings.motionLabels) !== JSON.stringify(config.value.motionLabels)) config.value.motionLabels = settings.motionLabels;
  config.value.outfits ??= settings.outfits;
  config.value.defaultOutfit ??= settings.defaultOutfit;
}
function addOutfit() {
  if (!config.value) return;
  const outfit = { id: uid('outfit'), name: '新衣着', match: '', parameters: {} };
  (config.value.outfits ??= []).push(outfit);
  previewOutfit.value = outfit.id;
}
function removeOutfit(outfit: Live2DOutfit) {
  if (!config.value) return;
  config.value.outfits = config.value.outfits?.filter(o => o.id !== outfit.id);
  if (config.value.defaultOutfit === outfit.id) config.value.defaultOutfit = config.value.outfits?.[0]?.id;
  if (previewOutfit.value === outfit.id) previewOutfit.value = '';
}
function addParameter(outfit: Live2DOutfit, event: Event) {
  const input = event.target as HTMLSelectElement;
  const parameter = config.value?.parameters?.find(p => p.id === input.value);
  if (parameter) outfit.parameters[parameter.id] = parameter.default;
  input.value = '';
}
function parameter(id: string) { return config.value?.parameters?.find(p => p.id === id); }
/** 映射的下拉框：没存过的（以前上传的模型、后来加的立绘表情）当成"自动"显示，不是一片空白 */
function choose(map: Record<string, string>, key: string, event: Event) { map[key] = (event.target as HTMLSelectElement).value; }
</script>

<template>
  <section class="model-settings">
    <p>上传角色的 Live2D 模型，视频通话时会自动眨眼，随声音开口，视线跟着你的鼠标或手指，并跟随情绪和对话做动作。</p>
    <input ref="zip" hidden type="file" accept=".zip,application/zip" aria-label="上传 Live2D ZIP" data-testid="live2d-upload" @change="pick" />
    <input ref="folder" hidden type="file" webkitdirectory multiple aria-label="上传 Live2D 文件夹" @change="pick" />
    <div class="pick-actions">
      <van-button round type="primary" :loading="busy" :disabled="busy" @click="zip?.click()">{{ config ? '更换 ZIP 模型' : '上传 ZIP 模型' }}</van-button>
      <van-button round :disabled="busy" @click="folder?.click()">选择文件夹</van-button>
    </div>
    <p class="hint">支持 Cubism 3/4/5。ZIP 可包含多层目录；保留 .model3.json 引用的 MOC3、纹理、表情和动作，模型文件夹里没写进清单的动作（.motion3.json）和表情（.exp3.json）也一并读进来。模型保存在这台设备上。</p>
    <p v-if="busy" role="status">{{ progress }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="config">
      <div class="model-info"><strong>{{ config.name }}</strong><span>{{ (config.bytes / 1048576).toFixed(1) }} MB · {{ config.fileCount }} 个运行文件</span></div>
      <div v-if="!busy" class="preview">
        <SceneBackdrop kind="room" tod="afternoon" />
        <Live2DAvatar :config="config" :expression="expression" :text="text" :sentence="sentence" :preview-outfit="previewOutfit" :pose="previewPose" :pose-turn="poseTurn" @ready="rememberSettings" />
      </div>
      <div class="framing-control">
        <label for="live2d-zoom">人物大小 <output>{{ zoom }}%</output></label>
        <input id="live2d-zoom" v-model.number="zoom" type="range" :min="FRAMING_LIMITS.zoom[0] * 100" :max="FRAMING_LIMITS.zoom[1] * 100" step="1" aria-label="人物大小" />
      </div>
      <div class="framing-control">
        <label for="live2d-x">左右 <output>{{ offsetX }}</output></label>
        <input id="live2d-x" v-model.number="offsetX" type="range" :min="FRAMING_LIMITS.x[0]" :max="FRAMING_LIMITS.x[1]" step="1" aria-label="人物左右位置" />
      </div>
      <div class="framing-control">
        <label for="live2d-y">上下 <output>{{ offsetY }}</output></label>
        <input id="live2d-y" v-model.number="offsetY" type="range" :min="FRAMING_LIMITS.y[0]" :max="FRAMING_LIMITS.y[1]" step="1" aria-label="人物上下位置" />
        <button type="button" :disabled="!moved" @click="resetFraming">恢复默认</button>
      </div>
      <p class="hint">默认按这份模型的可见轮廓自动适配、保持比例、居中贴底。大小和位置随角色保存；视频通话时点右上角"调位置"，能对着通话画面直接拖、两指缩放。</p>
      <label class="follow-control"><input v-model="follow" type="checkbox" aria-label="视线跟随鼠标和手指" />视线跟随鼠标和手指<span class="hint">在画面上移动鼠标、用手指按住滑动，{{ character.pronoun }}会看过来；移开后看回正前方。</span></label>
      <div class="preview-controls">
        <label>预览表情 <select v-model="expression" aria-label="预览表情"><option v-for="e in faces" :key="e.id" :value="e.id">{{ e.label }}</option></select></label>
        <button type="button" @click="action('你好')">挥手</button><button type="button" @click="action('好的')">点头</button><button type="button" @click="action('不行')">摇头</button>
      </div>
      <div v-if="poses.length" class="preview-controls pose-controls" data-testid="live2d-poses">
        <span>预览姿势</span>
        <button v-for="p in poses" :key="p.id" type="button" :class="{ on: previewPose === p.id }" :aria-pressed="previewPose === p.id" @click="tryPose(p.id)">{{ p.name }}</button>
        <button v-if="previewPose" type="button" class="plain" @click="previewPose = ''">按映射来</button>
      </div>
      <p v-if="poses.length" class="hint">这份模型有 {{ poses.length }} 种姿势：{{ poses.map(p => p.momentary ? `${p.name}（抬一下，几秒后放下）` : p.name).join('、') }}。视频通话时按下面"表情与动作映射"里的姿势来，{{ character.pronoun }}也能自己用 <code>[pose:{{ poses.at(-1)?.name }}]</code> 换。</p>
      <div class="outfit-controls">
        <label>默认衣着<select v-model="config.defaultOutfit" aria-label="默认衣着"><option v-for="outfit in config.outfits" :key="outfit.id" :value="outfit.id">{{ outfit.name }}</option></select></label>
        <label>预览衣着<select v-model="previewOutfit" aria-label="预览衣着"><option value="">跟随默认衣着</option><option v-for="outfit in config.outfits" :key="outfit.id" :value="outfit.id">{{ outfit.name }}</option></select></label>
      </div>
      <p class="hint">视频通话会匹配角色节律中的衣着名称或标签；没有匹配项时使用上面设置的默认衣着。</p>
      <details class="outfit-settings">
        <summary>衣着匹配与模型参数</summary>
        <p class="hint">为模型已有的衣着填写名称和匹配词（逗号分隔）。未自动识别的换装，可新增衣着并选择模型的换装参数。素材本身需要包含对应服装。</p>
        <div v-for="outfit in config.outfits" :key="outfit.id" class="outfit-editor">
          <label>衣着名称<input v-model="outfit.name" :aria-label="`${outfit.id}衣着名称`" /></label>
          <label>匹配词<input v-model="outfit.match" :aria-label="`${outfit.id}衣着匹配词`" placeholder="如：族服,clan" /></label>
          <div v-for="(_, id) in outfit.parameters" :key="id" class="outfit-parameter">
            <label :for="`${outfit.id}-${id}`">{{ parameter(id)?.name ?? id }}</label>
            <input :id="`${outfit.id}-${id}`" v-model.number="outfit.parameters[id]" type="number" :min="parameter(id)?.min" :max="parameter(id)?.max" step="any" :aria-label="`${outfit.id}-${id}`" />
            <button type="button" :aria-label="`移除${outfit.id}的${id}参数`" @click="delete outfit.parameters[id]">移除</button>
          </div>
          <select :aria-label="`${outfit.id}添加换装参数`" value="" @change="addParameter(outfit, $event)"><option value="">添加换装参数…</option><option v-for="p in config.parameters?.filter(p => !(p.id in outfit.parameters))" :key="p.id" :value="p.id">{{ p.name }} · {{ p.id }}</option></select>
          <div class="outfit-actions"><button type="button" @click="previewOutfit = outfit.id">预览这套</button><button v-if="(config.outfits?.length ?? 0) > 1" type="button" @click="removeOutfit(outfit)">删除这套</button></div>
        </div>
        <button type="button" class="add-outfit" @click="addOutfit">新增衣着</button>
      </details>
      <RouterLink :to="`/call/${character.id}?video=1`" class="start-video"><span class="i-lucide-video" />开始视频通话</RouterLink>
      <details>
        <summary>表情与动作映射</summary>
        <p class="hint">{{ faces[0]?.own ? `按${character.name}立绘上的表情列出；没单独选的按名字自动找最像的。` : '已按名称匹配。' }}可为每个表情改选模型实际导出的表情和动作；动作按文件名列出，选"自动"的按动作名字找（wave / nod / shake、挥手 / 点头 / 摇头……），找不到时保持自然待机。<template v-if="poses.length">最右一栏是姿势：表情管平时摆哪个，打招呼、赞同、否定是说到那句话时摆几秒再回来。</template></p>
        <div v-for="e in faces" :key="e.id" class="binding" :class="{ posed: poses.length }">
          <label>{{ e.label }}</label>
          <select :value="config.expressionMap[e.id] ?? ''" @change="choose(config.expressionMap, e.id, $event)" :aria-label="`${e.label}表情映射`"><option value="">{{ e.own ? `自动（${autoName(e.id, config.expressionMap) || '默认表情'}）` : '默认表情' }}</option><option v-for="name in config.expressions" :key="name" :value="name">{{ name }}</option></select>
          <select :value="config.motionMap[e.id] ?? ''" @change="choose(config.motionMap, e.id, $event)" :aria-label="`${e.label}动作映射`"><option value="">{{ autoMotion(e.id) ? `自动（${nameOf(autoMotion(e.id))}）` : '自然动作' }}</option><option v-for="m in motionList" :key="m.key" :value="m.key">{{ m.label }}</option></select>
          <select v-if="poses.length && config.poseMap" :value="config.poseMap[e.id] ?? ''" @change="choose(config.poseMap, e.id, $event)" :aria-label="`${e.label}姿势映射`"><option value="">自动（{{ autoPoseName(e.id, true) || poses[0]?.name }}）</option><option v-for="p in poses" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        </div>
        <div v-for="(label, key) in ACTION_LABELS" :key="key" class="binding action" :class="{ posed: poses.length }"><label>{{ label }}</label><select :value="config.motionMap[key] ?? ''" @change="choose(config.motionMap, key, $event)" :aria-label="`${label}动作映射`"><option value="">{{ autoMotion(key) ? `自动（${nameOf(autoMotion(key))}）` : poses.length ? '自动（不播动作）' : '自动（没有对得上的动作）' }}</option><option :value="NO_MOTION">不做动作</option><option v-for="m in motionList" :key="m.key" :value="m.key">{{ m.label }}</option></select>
          <select v-if="poses.length && config.poseMap" :value="config.poseMap[key] ?? ''" @change="choose(config.poseMap, key, $event)" :aria-label="`${label}姿势映射`"><option value="">自动（{{ autoPoseName(key, false) || '不换姿势' }}）</option><option :value="NO_MOTION">不换姿势</option><option v-for="p in poses" :key="p.id" :value="p.id">{{ p.name }}</option></select>
        </div>
      </details>
      <button type="button" class="remove" :disabled="busy" @click="remove">移除 Live2D 模型</button>
    </template>
  </section>
</template>

<style scoped>
.model-settings { padding: 4px 16px 24px; }
p { font-size: 13px; line-height: 1.7; }
.hint { color: var(--ink-3); font-size: 12px; }
.pick-actions, .preview-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.error { color: var(--danger, #d44); }
.model-info { display: grid; gap: 4px; margin: 16px 0 10px; overflow-wrap: anywhere; }
.model-info span { font-size: 12px; color: var(--ink-3); }
.preview { height: 350px; position: relative; border-radius: 20px; overflow: hidden; }
.preview-controls { margin: 12px 0; font-size: 12px; }
select { padding: 7px 4px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface); min-width: 0; max-width: 100%; }
.preview-controls button { padding: 7px 10px; background: var(--accent-soft); border-radius: 12px; }
.framing-control { display: flex; align-items: center; gap: 10px; margin-top: 12px; font-size: 12px; }
.framing-control label { white-space: nowrap; min-width: 6.5em; }
.framing-control button:disabled { opacity: 0.45; }
.follow-control { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 2px 8px; margin: 12px 0; font-size: 13px; }
.follow-control input { accent-color: var(--accent); width: 16px; height: 16px; }
.follow-control .hint { grid-column: 2; }
.binding.action { grid-template-columns: 52px minmax(0, 1fr); }
.binding.posed { grid-template-columns: 52px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr); }
.binding.action.posed { grid-template-columns: 52px minmax(0, 2fr) minmax(0, 1fr); }
.pose-controls button.on { background: var(--accent); color: var(--on-accent); }
.pose-controls button.plain { background: none; color: var(--accent-ink); padding: 7px 4px; }
code { padding: 0 3px; border-radius: 4px; background: var(--panel); font-size: 0.92em; }
.framing-control input { min-width: 40px; flex: 1; accent-color: var(--accent); }
.framing-control button { color: var(--accent); font-size: 12px; }
.outfit-controls { display: flex; gap: 12px; }
.outfit-controls label { flex: 1; min-width: 0; display: grid; gap: 6px; font-size: 13px; }
.outfit-editor { display: grid; gap: 10px; padding: 12px; border: 1px solid var(--line); border-radius: 12px; margin: 10px 0; font-size: 12px; }
.outfit-editor > label { display: grid; gap: 5px; }
.outfit-editor input { min-width: 0; width: 100%; padding: 8px; border-radius: 8px; border: 1px solid var(--line); color: var(--ink); background: var(--surface); }
.outfit-parameter { display: grid; grid-template-columns: minmax(0, 1fr) 64px 32px; align-items: center; gap: 8px; }
.outfit-parameter label { overflow-wrap: anywhere; }
.outfit-actions { display: flex; justify-content: space-between; color: var(--accent); }
.add-outfit { color: var(--accent); padding: 8px 0; }
.start-video { display: flex; align-items: center; justify-content: center; gap: 8px; padding: 13px; border-radius: 24px; color: var(--on-accent); background: var(--accent); margin: 16px 0; }
summary { padding: 10px 0; cursor: pointer; font-size: 14px; }
.binding { display: grid; grid-template-columns: 52px minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: center; font-size: 12px; margin: 8px 0; }
.remove { color: var(--ink-3); font-size: 12px; text-decoration: underline; margin-top: 20px; }
</style>
