<script setup lang="ts">
import { showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import {
  AVATAR_FIELDS, AVATAR_LOOKS, AVATAR_PROPORTIONS, applyAvatarLook, randomAvatar, selectAvatarOption,
  type Avatar, type AvatarGroup, type AvatarLook,
} from './avatar';
import { ChibiStudio, type StudioView } from './studio';
import settings from './avatar-data/studio.json';
import { eyeArtworkReady } from './eyeArtwork';

const props = defineProps<{ you: Avatar; her: Avatar; herName: string; herPronoun: string; start: 'you' | 'her'; design: (who: 'you' | 'her') => Promise<Avatar | null> }>();
const show = defineModel<boolean>('show', { required: true });
const emit = defineEmits<{ save: [who: 'you' | 'her', avatar: Avatar] }>();
type Who = 'you' | 'her';
type Group = AvatarGroup | 'looks';
const GROUPS: { value: Group; label: string; icon: string }[] = [
  { value: 'looks', label: '搭配', icon: 'i-lucide-sparkles' },
  { value: 'face', label: '脸部', icon: 'i-lucide-smile' },
  { value: 'hair', label: '头发', icon: 'i-lucide-scissors' },
  { value: 'clothes', label: '穿搭', icon: 'i-lucide-shirt' },
  { value: 'more', label: '配饰', icon: 'i-lucide-glasses' },
];
const copy = (a: Avatar): Avatar => ({ ...a, acc: [...a.acc] });
const who = ref<Who>(props.start);
const group = ref<Group>('looks');
const draft = ref({ you: copy(props.you), her: copy(props.her) });
const current = computed(() => draft.value[who.value]);
const fields = computed(() => AVATAR_FIELDS.filter((f) => f.group === group.value && (!f.when || f.when(current.value))));
const activeKey = ref<keyof Avatar>('hair');
const activeField = computed(() => fields.value.find((f) => f.key === activeKey.value) ?? fields.value[0]);
const proportions = computed(() => AVATAR_PROPORTIONS.filter((p) => p.group === group.value));
const whoOptions = computed(() => [{ value: 'you' as const, label: '你' }, { value: 'her' as const, label: props.herName }]);
const past = ref<Record<Who, Avatar[]>>({ you: [], her: [] });
const future = ref<Record<Who, Avatar[]>>({ you: [], her: [] });
const designing = ref(false);
const view = ref<StudioView>('body');
const canvas = ref<HTMLCanvasElement | null>(null);
const fieldsPanel = ref<HTMLElement | null>(null);
const thumbnails = ref<Record<string, string>>({});
const loadingThumbnails = ref(false);
let studio: ChibiStudio | null = null;
let previewFrame = 0, thumbnailFrame = 0, previewRevision = 0, session = 0;
let groupedChange: Who | null = null;
let groupedRecorded = false;

const selectedLabel = computed(() => {
  const field = activeField.value;
  if (!field) return '';
  const value = current.value[field.key];
  if (field.multi) return (value as string[]).length ? `已选 ${(value as string[]).length} 件` : '未佩戴';
  return field.options?.find((o) => o.id === value)?.name ?? field.colors?.find((c) => c.hex === value)?.name ?? (typeof value === 'string' ? value : '');
});
const choices = computed(() => {
  if (group.value === 'looks') return AVATAR_LOOKS.map((look) => ({ id: look.id, name: look.name, note: look.note, avatar: applyAvatarLook(look, current.value), view: 'body' as StudioView }));
  const field = activeField.value;
  if (!field?.options) return [];
  return field.options.map((option) => ({
    ...option, note: '',
    avatar: field.multi ? { ...current.value, acc: [...new Set([...current.value.acc, option.id])] } : selectAvatarOption(current.value, field.key, option.id),
    view: (field.group === 'clothes' ? 'clothes' : field.key === 'hair' || (field.key === 'acc' && option.id === 'gloves') ? 'body' : 'face') as StudioView,
  }));
});

watch(show, async (open) => {
  session++;
  if (open) {
    who.value = props.start;
    draft.value = { you: copy(props.you), her: copy(props.her) };
    past.value = { you: [], her: [] };
    future.value = { you: [], her: [] };
    group.value = 'looks';
    view.value = 'body';
    designing.value = false;
    await nextTick();
    mountStudio();
  } else disposeStudio();
}, { immediate: true });
watch(current, () => {
  cancelAnimationFrame(previewFrame);
  previewFrame = requestAnimationFrame(() => studio?.setAvatar(current.value));
}, { deep: true });
watch([choices, show], refreshThumbnails, { deep: true });
watch([group, activeKey], () => { if (fieldsPanel.value) fieldsPanel.value.scrollTop = 0; });
watch(group, (next) => {
  activeKey.value = fields.value[0]?.key ?? 'hair';
  setView(next === 'face' ? 'face' : 'body');
});
watch(who, () => { endChange(); studio?.front(); });
onBeforeUnmount(() => { session++; disposeStudio(); });

async function mountStudio() {
  await eyeArtworkReady;
  if (!show.value || !canvas.value || studio) return;
  studio = new ChibiStudio(canvas.value, current.value);
  studio.setView(view.value);
  refreshThumbnails();
}
function disposeStudio() {
  previewRevision++;
  cancelAnimationFrame(previewFrame);
  cancelAnimationFrame(thumbnailFrame);
  studio?.dispose();
  studio = null;
  thumbnails.value = {};
  endChange();
}
function refreshThumbnails() {
  const revision = ++previewRevision;
  cancelAnimationFrame(thumbnailFrame);
  if (!show.value || !studio) return;
  const items = choices.value;
  thumbnails.value = {};
  loadingThumbnails.value = items.length > 0;
  let index = 0;
  const renderNext = () => {
    if (revision !== previewRevision || !studio) return;
    const item = items[index++];
    if (!item) { loadingThumbnails.value = false; return; }
    thumbnails.value[item.id] = studio.thumbnail(item.avatar, item.view);
    thumbnailFrame = requestAnimationFrame(renderNext);
  };
  thumbnailFrame = requestAnimationFrame(renderNext);
}
function change(target: Who, next: Avatar) {
  if (JSON.stringify(next) === JSON.stringify(draft.value[target])) return;
  if (groupedChange !== target || !groupedRecorded) {
    past.value[target] = [...past.value[target].slice(-(settings.historyLimit - 1)), copy(draft.value[target])];
    groupedRecorded = true;
  }
  future.value[target] = [];
  draft.value[target] = copy(next);
}
function beginChange() { groupedChange = who.value; groupedRecorded = false; }
function endChange() { groupedChange = null; groupedRecorded = false; }
function set<K extends keyof Avatar>(key: K, value: Avatar[K]) { change(who.value, { ...current.value, [key]: value }); }
function select(id: string) {
  const field = activeField.value!;
  if (field.multi) set('acc', current.value.acc.includes(id) ? current.value.acc.filter((v) => v !== id) : [...current.value.acc, id]);
  else change(who.value, selectAvatarOption(current.value, field.key, id));
}
function picked(id: string) {
  if (group.value === 'looks') {
    const look = AVATAR_LOOKS.find((v) => v.id === id)!;
    const expected = applyAvatarLook(look, current.value);
    return Object.keys(expected).every((key) => JSON.stringify(expected[key as keyof Avatar]) === JSON.stringify(current.value[key as keyof Avatar]));
  }
  const field = activeField.value!;
  return field.multi ? current.value.acc.includes(id) : current.value[field.key] === id;
}
function useLook(look: AvatarLook) { change(who.value, applyAvatarLook(look, current.value)); }
function choose(id: string) {
  if (group.value === 'looks') useLook(AVATAR_LOOKS.find((look) => look.id === id)!);
  else select(id);
}
function undo() {
  const previous = past.value[who.value].at(-1);
  if (!previous) return;
  future.value[who.value].push(copy(current.value));
  past.value[who.value].pop();
  draft.value[who.value] = copy(previous);
}
function redo() {
  const next = future.value[who.value].at(-1);
  if (!next) return;
  past.value[who.value].push(copy(current.value));
  future.value[who.value].pop();
  draft.value[who.value] = copy(next);
}
function setView(next: StudioView) { view.value = next; studio?.setView(next); }
function shuffle() { change(who.value, randomAvatar(current.value)); studio?.wave(); }
async function letHerDesign() {
  if (designing.value) return;
  designing.value = true;
  const target = who.value, openedSession = session, original = draft.value[target];
  try {
    const avatar = await props.design(target);
    if (avatar && show.value && session === openedSession && draft.value[target] === original) {
      change(target, avatar);
      studio?.wave();
    }
  } finally {
    if (session === openedSession) designing.value = false;
  }
}
function save() {
  for (const target of ['you', 'her'] as const) {
    if (JSON.stringify(draft.value[target]) !== JSON.stringify(props[target])) emit('save', target, copy(draft.value[target]));
  }
  show.value = false;
  showToast('造型已保存');
}
</script>

<template>
  <van-popup v-model:show="show" position="bottom" round teleport="body" class="avatar-pop" :close-on-popstate="true" @opened="mountStudio">
    <div class="editor" data-sheet="avatar">
      <header class="head">
        <button type="button" class="round-button" aria-label="取消修改" @click="show = false"><span class="i-lucide-x" /></button>
        <h2>造型间</h2>
        <button type="button" class="save" @click="save">保存造型</button>
      </header>
      <div class="workspace">
        <section class="preview" aria-label="造型预览">
          <div class="owner"><Segmented v-model="who" :options="whoOptions" /></div>
          <div class="stage">
            <canvas ref="canvas" aria-label="角色预览，可拖动旋转，也可使用右侧按钮旋转" />
            <div class="history">
              <button type="button" class="round-button" aria-label="撤销" :disabled="!past[who].length" @click="undo"><span class="i-lucide-undo-2" /></button>
              <button type="button" class="round-button" aria-label="重做" :disabled="!future[who].length" @click="redo"><span class="i-lucide-redo-2" /></button>
            </div>
            <div class="camera-tools">
              <button type="button" class="round-button" aria-label="旋转预览" @click="studio?.turn()"><span class="i-lucide-rotate-3d" /></button>
              <button type="button" class="round-button" aria-label="回到正面" @click="studio?.front()"><span class="i-lucide-scan-face" /></button>
            </div>
            <div class="view-tools" aria-label="预览范围">
              <button type="button" :class="{ on: view === 'body' }" :aria-pressed="view === 'body'" @click="setView('body')">全身</button>
              <button type="button" :class="{ on: view === 'face' }" :aria-pressed="view === 'face'" @click="setView('face')">脸部</button>
            </div>
            <span class="rotate-hint">拖动转一转</span>
          </div>
          <div class="inspiration">
            <button type="button" @click="shuffle"><span class="i-lucide-shuffle" />灵感搭配</button>
            <button type="button" :disabled="designing" @click="letHerDesign">
              <span :class="designing ? 'i-lucide-loader-circle spin' : 'i-lucide-wand-sparkles'" />
              {{ designing ? `${herPronoun}在捏…` : who === 'her' ? `让${herPronoun}给自己捏` : `让${herPronoun}帮你捏` }}
            </button>
          </div>
        </section>

        <section class="wardrobe" aria-label="编辑造型">
          <nav class="categories" aria-label="造型分类">
            <button v-for="item in GROUPS" :key="item.value" type="button" :class="{ on: group === item.value }" :aria-pressed="group === item.value" @click="group = item.value">
              <span :class="item.icon" /><span>{{ item.label }}</span>
            </button>
          </nav>
          <div v-if="fields.length" class="parts" aria-label="部件">
            <button v-for="field in fields" :key="field.key" type="button" :class="{ on: activeField?.key === field.key }" :aria-pressed="activeField?.key === field.key" @click="activeKey = field.key">{{ field.label.replace(/（.*）/, '') }}</button>
          </div>
          <div ref="fieldsPanel" class="fields">
            <div class="field-heading">
              <div><h3>{{ group === 'looks' ? '从喜欢的搭配开始' : activeField?.label }}</h3><p v-if="group === 'looks'">每一处都可以接着改，肤色和身形会保留。</p></div>
              <span v-if="group !== 'looks'" class="selection-label">{{ selectedLabel }}</span>
            </div>
            <div v-if="choices.length" class="option-grid" :class="{ 'look-grid': group === 'looks' }" :aria-busy="loadingThumbnails">
              <button v-if="activeField?.multi" type="button" class="option-card empty-option" :class="{ on: !current.acc.length }" :aria-pressed="!current.acc.length" @click="set('acc', [])"><span class="i-lucide-circle-slash" /><span>不戴配饰</span></button>
              <button v-for="choice in choices" :key="choice.id" type="button" class="option-card" :class="{ on: picked(choice.id) }" :aria-pressed="picked(choice.id)" :aria-label="choice.name" @click="choose(choice.id)">
                <span class="option-image"><img v-if="thumbnails[choice.id]" :src="thumbnails[choice.id]" alt="" /><span v-else class="i-lucide-user-round loading-image" /></span>
                <span class="option-name">{{ choice.name }}</span>
                <span v-if="choice.note" class="option-note">{{ choice.note }}</span>
                <span v-if="picked(choice.id)" class="selected-mark i-lucide-check" />
              </button>
            </div>
            <div v-else-if="activeField?.toggle" class="toggle-options">
              <button v-for="(label, index) in activeField.toggle" :key="label" type="button" :class="{ on: current[activeField.key] === (index === 0) }" :aria-pressed="current[activeField.key] === (index === 0)" @click="set(activeField.key, index === 0)">{{ label }}</button>
            </div>
            <div v-else-if="activeField?.colors" class="colors">
              <button v-if="activeField.none" type="button" class="color-option" :class="{ on: !current[activeField.key] }" :aria-pressed="!current[activeField.key]" @click="set(activeField.key, '')"><span class="color-dot no-color i-lucide-ban" /><span>{{ activeField.none }}</span></button>
              <button v-for="color in activeField.colors" :key="color.hex" type="button" class="color-option" :class="{ on: String(current[activeField.key]).toLowerCase() === color.hex }" :aria-pressed="String(current[activeField.key]).toLowerCase() === color.hex" @click="set(activeField.key, color.hex)"><span class="color-dot" :style="{ background: color.hex }" /><span>{{ color.name }}</span></button>
              <label class="color-option custom-color"><span class="color-dot"><span class="i-lucide-pipette" /></span><span>自定颜色</span><input type="color" :aria-label="`${activeField.label}：自定颜色`" :value="current[activeField.key] || activeField.colors[0]?.hex" @pointerdown="beginChange" @change="endChange" @blur="endChange" @input="set(activeField.key, ($event.target as HTMLInputElement).value)" /></label>
            </div>
            <div v-if="proportions.length && (group === 'more' || activeField?.key === 'faceShape' || activeField?.key === 'eyes')" class="proportions">
              <div v-for="p in proportions" :key="p.key" class="proportion">
                <label :for="`avatar-${p.key}`">{{ p.label }}<output>{{ Math.round(current[p.key] * 100) }}%</output></label>
                <input :id="`avatar-${p.key}`" type="range" :min="p.min" :max="p.max" :step="p.step" :value="current[p.key]" @pointerdown="beginChange" @pointerup="endChange" @pointercancel="endChange" @blur="endChange" @keydown="!$event.repeat && beginChange()" @keyup="endChange" @input="set(p.key, Number(($event.target as HTMLInputElement).value))" />
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
:global(.avatar-pop) { height: 95dvh; max-height: 980px; max-width: 900px; margin-inline: auto; right: 0; }
.editor { display: flex; flex-direction: column; height: 100%; padding-bottom: var(--safe-bottom); background: var(--surface); color: var(--ink); }
.head { display: flex; align-items: center; gap: 8px; padding: 10px 14px 8px; }
.head h2 { flex: 1; margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.02em; }
button, input, label.custom-color { -webkit-tap-highlight-color: transparent; }
button:focus-visible, input:focus-visible, .custom-color:focus-within { outline: 2px solid var(--accent-ink); outline-offset: 3px; }
button:disabled { opacity: .35; cursor: default; }
.round-button { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: 12px; font-size: 19px; color: var(--ink-2); }
.save { min-height: 40px; padding: 0 15px; border-radius: 12px; background: var(--accent); color: var(--on-accent); font-size: 14px; font-weight: 650; }
.workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.preview { display: flex; flex-direction: column; flex-shrink: 0; padding: 0 14px; }
.owner { width: min(76%, 300px); margin: 0 auto 6px; }
.stage { position: relative; height: clamp(190px, 28dvh, 300px); border-radius: 16px; background: var(--panel); overflow: hidden; }
.stage canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.history, .camera-tools { position: absolute; top: 8px; display: flex; flex-direction: column; gap: 2px; }
.history { left: 8px; }.camera-tools { right: 8px; }
.stage .round-button { background: var(--surface); }
.view-tools { position: absolute; left: 10px; bottom: 10px; display: flex; padding: 3px; border-radius: 10px; background: var(--surface); }
.view-tools button { min-height: 32px; padding: 0 12px; border-radius: 7px; color: var(--ink-2); font-size: 12px; }
.view-tools button.on { color: var(--accent-ink); background: var(--accent-soft); font-weight: 600; }
.rotate-hint { position: absolute; bottom: 17px; right: 12px; color: var(--ink-2); font-size: 11px; pointer-events: none; }
.inspiration { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; }
.inspiration button { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 42px; padding: 0 8px; color: var(--ink-2); font-size: 13px; }
.inspiration button:last-child { color: var(--accent-ink); }
.wardrobe { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.categories { display: flex; flex-shrink: 0; gap: 4px; padding: 0 14px; border-bottom: 1px solid var(--border); }
.categories button { display: flex; flex: 1; min-width: 0; min-height: 48px; align-items: center; justify-content: center; gap: 5px; position: relative; color: var(--ink-2); font-size: 13px; }
.categories button.on { color: var(--accent-ink); font-weight: 650; }
.categories button.on::after { content: ''; position: absolute; bottom: 0; left: 18%; right: 18%; height: 3px; border-radius: 3px 3px 0 0; background: var(--accent); }
.parts { display: flex; gap: 8px; padding: 10px 16px 2px; overflow-x: auto; flex-shrink: 0; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.parts button { flex-shrink: 0; min-height: 36px; padding: 0 12px; border-radius: 10px; color: var(--ink-2); font-size: 12px; }
.parts button.on { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
.fields { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 14px 16px 20px; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.field-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.field-heading h3 { margin: 0; font-size: 14px; font-weight: 600; }
.field-heading p { margin: 5px 0 0; color: var(--ink-2); font-size: 11px; line-height: 1.6; }
.selection-label { font-size: 11px; color: var(--ink-2); }
.option-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.option-card { position: relative; display: flex; flex-direction: column; align-items: center; overflow: hidden; min-width: 0; padding: 0 4px 10px; border: 1px solid var(--border); border-radius: 12px; color: var(--ink-2); background: var(--panel); }
.option-card.on { border-color: var(--accent); background: var(--accent-soft); color: var(--accent-ink); }
.option-image { width: 100%; aspect-ratio: 1; display: grid; place-items: center; }
.option-image img { display: block; width: 100%; height: 100%; object-fit: contain; }
.loading-image { color: var(--ink-3); font-size: 28px; opacity: .4; }
.option-name { font-size: 12px; line-height: 1.5; font-weight: 550; }
.option-note { display: none; color: var(--ink-2); font-size: 10px; line-height: 1.5; margin-top: 4px; }
.selected-mark { position: absolute; right: 6px; top: 6px; color: var(--accent-ink); font-size: 16px; }
.empty-option { justify-content: center; gap: 14px; font-size: 12px; min-height: 120px; }
.empty-option > span:first-child { font-size: 26px; }
.toggle-options { display: flex; gap: 10px; }
.toggle-options button { min-height: 44px; flex: 1; border-radius: 12px; background: var(--panel); color: var(--ink-2); }
.toggle-options button.on { background: var(--accent-soft); color: var(--accent-ink); outline: 1px solid var(--accent-line); }
.colors { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px 6px; }
.color-option { position: relative; display: flex; flex-direction: column; align-items: center; gap: 7px; padding: 4px 0; min-height: 62px; color: var(--ink-2); font-size: 10px; cursor: pointer; }
.color-dot { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid var(--border); border-radius: 50%; font-size: 16px; }
.color-option.on .color-dot { outline: 2px solid var(--accent-ink); outline-offset: 3px; }
.color-option.on { color: var(--accent-ink); font-weight: 650; }
.custom-color .color-dot, .no-color { background: var(--panel); }
.custom-color input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.proportions { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--border); }
.proportion + .proportion { margin-top: 12px; }
.proportion label { display: flex; justify-content: space-between; font-size: 12px; color: var(--ink-2); }
.proportion output { font-variant-numeric: tabular-nums; color: var(--ink); }
.proportion input { width: 100%; height: 32px; accent-color: var(--accent-ink); }
.spin { animation: spin 1s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (hover: hover) { .round-button:not(:disabled):hover, .inspiration button:not(:disabled):hover { background: var(--panel-2); }.option-card:hover { border-color: var(--accent-line); } }
@media (min-width: 700px) {
  :global(.avatar-pop) { height: min(88dvh, 760px); }
  .workspace { flex-direction: row; padding: 8px 0 16px; }
  .head { padding: 12px 20px; border-bottom: 1px solid var(--border); }
  .preview { width: 45%; padding: 8px 18px 0; }
  .stage { height: auto; flex: 1; max-height: 520px; }
  .owner { width: 90%; margin-bottom: 16px; }
  .wardrobe { border-left: 1px solid var(--border); }
  .categories { padding-inline: 10px; }
  .categories button { flex-direction: column; gap: 4px; min-height: 58px; }
  .option-note { display: block; }
  .look-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-height: 680px) and (max-width: 699px) {
  .stage { height: 180px; }
  .owner { margin-bottom: 3px; }
  .head { padding-block: 6px; }
  .inspiration button { min-height: 36px; }
}
@media (max-width: 360px) { .categories button > span:first-child { display: none; }.colors { grid-template-columns: repeat(4, minmax(0, 1fr)); }.option-grid { gap: 7px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
