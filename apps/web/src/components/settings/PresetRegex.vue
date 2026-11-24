<script setup lang="ts">
import { describeFind, parseRegexImport, regexFromString, REGEX_PLACEMENTS, runRegexScript, sameRegex, type Preset, type RegexPlacement, type RegexScript } from '@app/shared';
import { showConfirmDialog, showDialog, showToast } from 'vant';
import { computed, ref, toRaw, watch } from 'vue';
import { useRouter } from 'vue-router';
import PresetChooser from '@/components/settings/PresetChooser.vue';
import { useDragSort } from '@/composables/useDragSort';
import { personaOf } from '@/services/prompt';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { uid } from '@/utils/id';

/**
 * 预设编辑 → 正则：编辑、启用 / 停用、拖动排序（按列表顺序依次执行）；
 * 导入 SillyTavern 导出的正则脚本（单个或数组），或包含正则的 ST 预设、角色卡、App 预设文件，可多选文件；
 * 一条（编辑弹层里）或者多选几条复制到别的预设（那边已经有一样的跳过）。
 * 改动即时保存在预设中，下一次显示、发送起生效。
 */
const props = defineProps<{ preset: Preset; visibleTop?: () => number }>();
const emit = defineEmits<{ (e: 'touch'): void }>();
const chars = useCharacterStore();
const lib = useLibraryStore();
const router = useRouter();
const touch = () => emit('touch');

const EDITABLE: RegexPlacement[] = ['user_input', 'ai_output'];

function placementLabel(r: RegexScript): string {
  const own = EDITABLE.filter((p) => r.placement.includes(p));
  if (own.length) return own.map((p) => REGEX_PLACEMENTS[p]).join('、');
  return r.placement.length ? `${r.placement.map((p) => REGEX_PLACEMENTS[p]).join('、')}（不执行）` : '未选择作用范围';
}
function targetLabel(r: RegexScript): string {
  if (r.markdownOnly && r.promptOnly) return '仅格式显示和提示词';
  if (r.markdownOnly) return '仅格式显示';
  if (r.promptOnly) return '仅格式提示词';
  return '修改消息原文';
}
function depthLabel(r: RegexScript): string {
  const lo = r.minDepth ?? null;
  const hi = r.maxDepth ?? null;
  if (lo !== null && hi !== null) return `深度 ${lo}–${hi}`;
  if (lo !== null) return `深度 ≥ ${lo}`;
  if (hi !== null) return `深度 ≤ ${hi}`;
  return '';
}
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const bad = (r: RegexScript) => !!r.find && !regexFromString(r.find);

// —— 调顺序 ——
const listEl = ref<HTMLElement | null>(null);
function move(from: number, to: number) {
  const list = props.preset.regex;
  if (from === to || !list[from] || to < 0 || to >= list.length) return;
  const [r] = list.splice(from, 1);
  if (r) list.splice(to, 0, r);
  touch();
}
const sort = useDragSort({ list: listEl, onMove: move, visibleTop: () => props.visibleTop?.() ?? 0 });
/** 每一条一个固定的 key（导入的 id 可能重复），挪位置时 DOM 跟着这一条走 */
const keys = new WeakMap<RegexScript, string>();
let seq = 0;
function keyOf(r: RegexScript): string {
  const raw = toRaw(r);
  let k = keys.get(raw);
  if (!k) {
    seq += 1;
    k = `regex-${seq}`;
    keys.set(raw, k);
  }
  return k;
}

// —— 新建、导入 ——
const editing = ref<RegexScript | null>(null);
const editOpen = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) });
watch(
  () => props.preset.id,
  () => {
    editing.value = null;
    selecting.value = false;
    copying.value = null;
  },
);

function freshId(id: string | undefined): string {
  return id && !props.preset.regex.some((x) => x.id === id) ? id : uid('regex');
}
function addRegex() {
  props.preset.regex.push({
    id: uid('regex'),
    name: '新正则',
    find: '',
    replace: '',
    placement: ['ai_output'],
    enabled: true,
    trimStrings: [],
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    minDepth: null,
    maxDepth: null,
    substituteRegex: 0,
  });
  touch();
  editing.value = props.preset.regex.at(-1) ?? null;
}

const fileEl = ref<HTMLInputElement | null>(null);
async function onFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = '';
  const added: string[] = [];
  const problems: string[] = [];
  let same = 0;
  for (const f of files) {
    try {
      const { scripts } = parseRegexImport(JSON.parse((await f.text()).replace(/^﻿/, '')));
      if (!scripts.length) problems.push(`${f.name}：未找到正则脚本`);
      for (const s of scripts) {
        // 名称、查找、替换都相同的视为重复，跳过
        if (props.preset.regex.some((x) => x.name === s.name && x.find === s.find && x.replace === s.replace)) {
          same += 1;
          continue;
        }
        props.preset.regex.push({ ...s, id: freshId(s.id) });
        added.push(s.name);
      }
    } catch (err) {
      problems.push(`${f.name}：${err instanceof SyntaxError ? '不是有效的 JSON 文件' : err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (added.length) touch();
  const sameLine = same ? `已跳过 ${same} 条重复项` : '';
  if (problems.length) {
    void showDialog({ title: added.length ? `已导入 ${added.length} 条，部分文件未导入` : '导入失败', message: [...problems, sameLine].filter(Boolean).join('\n'), messageAlign: 'left' });
  } else if (added.length) {
    showToast({ message: `已导入 ${added.length} 条正则${sameLine ? `，${sameLine}` : ''}`, duration: 2200 });
  } else if (same) showToast(sameLine);
}

async function removeRegex(r: RegexScript) {
  const ok = await showConfirmDialog({ title: `删除「${r.name}」？`, confirmButtonText: '删除', confirmButtonColor: 'var(--bad)' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  props.preset.regex = props.preset.regex.filter((x) => x !== r);
  editing.value = null;
  touch();
}

// —— 复制到其他预设：一条（编辑弹层里）或者多选几条 ——
const selecting = ref(false);
const selected = ref<string[]>([]);
/** 选中的几条，按列表里的先后（复制过去也是这个先后） */
const selectedScripts = computed(() => props.preset.regex.filter((r) => selected.value.includes(keyOf(r))));
const allSelected = computed(() => !!props.preset.regex.length && selected.value.length === props.preset.regex.length);
function startSelect() {
  editing.value = null;
  selected.value = [];
  selecting.value = true;
}
function toggleSelect(r: RegexScript) {
  const k = keyOf(r);
  selected.value = selected.value.includes(k) ? selected.value.filter((x) => x !== k) : [...selected.value, k];
}
function toggleAll() {
  selected.value = allSelected.value ? [] : props.preset.regex.map(keyOf);
}
const copying = ref<RegexScript[] | null>(null);
const copyToOpen = computed({ get: () => !!copying.value, set: (v) => !v && (copying.value = null) });
function startCopyTo(list: RegexScript[]) {
  if (!list.length) return;
  editing.value = null;
  copying.value = list;
}
/** 选目标时提醒那边已经有一样的（查找、替换、作用范围都相同），这几条会跳过 */
function copyNote(target: Preset): string {
  const skip = (copying.value ?? []).filter((r) => target.regex.some((x) => sameRegex(x, r))).length;
  return skip ? `${skip} 条会跳过（那边已经有一样的）` : '';
}
function copySummary(added: number, skipped: number): string {
  return [added ? `复制了 ${added} 条正则` : '一条都没复制', skipped ? `${skipped} 条那边已经有一样的，跳过了` : ''].filter(Boolean).join('；');
}
async function copyTo(id: string) {
  const list = copying.value;
  copying.value = null;
  const res = list && lib.copyRegexTo(list, id);
  const target = lib.presetById(id);
  if (!res || !target) return;
  selecting.value = false;
  if (!res.added.length) return showToast(copySummary(0, res.skipped));
  const go = await showConfirmDialog({
    title: `复制到「${target.name}」了`,
    message: `${copySummary(res.added.length, res.skipped)}。按这边的先后接在那边正则列表的最后。`,
    confirmButtonText: '去看看',
    cancelButtonText: '留在这里',
  }).then(
    () => true,
    () => false,
  );
  if (go) void router.push(`/me/presets/${id}`);
}

// —— 编辑一条 ——
const findInfo = computed(() => describeFind(editing.value?.find ?? ''));
function togglePlacement(p: RegexPlacement) {
  const r = editing.value;
  if (!r) return;
  r.placement = r.placement.includes(p) ? r.placement.filter((x) => x !== p) : [...r.placement, p];
  touch();
}
function toggleTarget(key: 'markdownOnly' | 'promptOnly') {
  const r = editing.value;
  if (!r) return;
  r[key] = !r[key];
  touch();
}
function targetHint(r: RegexScript): string {
  if (r.markdownOnly && r.promptOnly) return '修改显示内容和发送给 AI 的内容，不修改消息原文。';
  if (r.markdownOnly) return '仅修改显示内容，消息原文和发送给 AI 的内容不变。';
  if (r.promptOnly) return '仅修改发送给 AI 的内容，消息原文和显示内容不变。';
  return '均不勾选时，在收到回复和发送消息时直接修改消息原文。';
}
function setTrim(e: Event) {
  const r = editing.value;
  if (!r) return;
  r.trimStrings = (e.target as HTMLTextAreaElement).value.split('\n').filter((t) => t !== '');
  touch();
}
function setDepth(key: 'minDepth' | 'maxDepth', e: Event) {
  const r = editing.value;
  if (!r) return;
  const raw = (e.target as HTMLInputElement).value.trim();
  const n = Math.trunc(Number(raw));
  r[key] = raw === '' || !Number.isFinite(n) ? null : Math.max(key === 'minDepth' ? -1 : 0, n);
  touch();
}
/** 模板里不能直接写双花括号 */
const MACRO = { match: '{{match}}', char: '{{char}}', user: '{{user}}' };
const SUBSTITUTE: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: '不替换' },
  { value: 1, label: '原样替换' },
  { value: 2, label: '转义后替换' },
];

// —— 测试：只运行这一条（不判断作用范围、格式选项和深度） ——
const sample = ref('');
const testNames = computed(() => ({ char: chars.list[0]?.name ?? 'Ta', user: personaOf(undefined).name }));
const sampleOut = computed(() => {
  const r = editing.value;
  if (!r || !sample.value) return '';
  return runRegexScript({ ...toRaw(r), enabled: true }, sample.value, testNames.value);
});
</script>

<template>
  <div class="px-4">
    <div v-if="preset.regex.length" class="flex items-center gap-2 text-[12.5px] text-ink-3 px-1 mb-1.5">
      <span class="flex-1">{{ selecting ? `点正则来选，已选 ${selected.length} 条` : `${preset.regex.length} 条` }}</span>
      <button v-if="!selecting" type="button" class="mini press" data-testid="regex-select" @click="startSelect"><span class="i-lucide-list-checks" />选几条复制</button>
      <button v-else type="button" class="mini press" @click="toggleAll">{{ allSelected ? '全不选' : '全选' }}</button>
    </div>
    <div ref="listEl" class="grid gap-1.5" data-testid="preset-regex">
      <div
        v-for="(r, i) in preset.regex"
        :key="keyOf(r)"
        class="row sortable"
        :class="{ off: !r.enabled && !selecting, lifted: sort.state.phase === 'drag' && sort.state.from === i, picked: selecting && selected.includes(keyOf(r)) }"
        :style="sort.styleFor(i)"
        data-sort-item
        @pointerdown="!selecting && sort.onPointerDown($event, i)"
        @touchstart.passive="!selecting && sort.onTouchStart($event, i)"
      >
        <span v-if="selecting" class="check" aria-hidden="true"><span v-if="selected.includes(keyOf(r))" class="i-lucide-check" /></span>
        <button v-else type="button" class="grip" data-sort-handle :aria-label="`拖动排序「${r.name}」，或按上下方向键`" @keydown="sort.onHandleKey($event, i)">
          <span class="i-lucide-grip-vertical" />
        </button>
        <button
          type="button"
          class="flex-1 min-w-0 text-left"
          :aria-label="selecting ? `选「${r.name}」` : `编辑「${r.name}」`"
          :aria-pressed="selecting ? selected.includes(keyOf(r)) : undefined"
          @click="selecting ? toggleSelect(r) : (editing = r)"
        >
          <div class="name text-[14px] font-600 truncate">{{ r.name }}</div>
          <div class="tags">
            <span class="tag">{{ placementLabel(r) }}</span>
            <span class="tag accent">{{ targetLabel(r) }}</span>
            <span v-if="depthLabel(r)" class="tag">{{ depthLabel(r) }}</span>
          </div>
          <div class="text-[11.5px] text-ink-3 truncate mono">{{ r.find || '（未填写）' }} → {{ oneLine(r.replace) || '（空）' }}</div>
          <div v-if="bad(r)" class="text-[11.5px] text-bad">正则表达式无效，不会执行</div>
        </button>
        <van-switch v-if="!selecting" v-model="r.enabled" data-sort-ignore size="20px" :aria-label="`启用「${r.name}」`" @change="touch" />
      </div>
      <p v-if="!preset.regex.length" class="text-[13px] text-ink-3 text-center py-5 m-0">暂无正则脚本</p>
    </div>
    <div v-if="selecting" class="select-bar mt-2" data-testid="regex-select-bar">
      <button type="button" class="sb-btn press" :disabled="!selected.length" @click="startCopyTo(selectedScripts)"><span class="i-lucide-copy-plus" />复制到其他预设</button>
      <button type="button" class="sb-btn press" @click="selecting = false">取消</button>
    </div>
    <div v-else class="flex gap-2 mt-2">
      <button type="button" class="add press" @click="addRegex"><span class="i-lucide-plus" />新建</button>
      <button type="button" class="add press" data-testid="regex-import" @click="fileEl?.click()"><span class="i-lucide-file-up" />导入</button>
    </div>
    <input ref="fileEl" type="file" accept=".json,application/json" multiple class="file-hidden" aria-hidden="true" tabindex="-1" data-testid="regex-file" @change="onFiles" />
    <p class="text-[12px] text-ink-3 mt-2 mb-0 leading-relaxed">按列表顺序依次执行，长按拖动排序。支持导入 SillyTavern 正则脚本，以及包含正则的预设和角色卡；"选几条复制"能把几条一起复制到别的预设。</p>

    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '92%' }">
      <div v-if="editing" class="sheet" data-testid="regex-editor">
        <div class="sheet-title">编辑正则</div>
        <label class="field-label" for="re-name">名称</label>
        <input id="re-name" v-model="editing.name" class="input" autocomplete="off" @change="touch" />

        <label class="field-label" for="re-find">查找（正则表达式）</label>
        <textarea id="re-find" v-model="editing.find" class="textarea mono" rows="3" spellcheck="false" placeholder="/<bgm>(.+?)<\/bgm>/g" @change="touch" />
        <p class="text-[12px] mt-1 mb-0" :class="findInfo.ok ? 'text-ink-3' : 'text-bad'">{{ findInfo.text }}</p>

        <label class="field-label" for="re-replace">替换为</label>
        <textarea id="re-replace" v-model="editing.replace" class="textarea mono" rows="5" spellcheck="false" placeholder="留空表示删除匹配内容" @change="touch" />
        <p class="text-[12px] text-ink-3 mt-1 mb-0 leading-relaxed">$1、$2 引用捕获组，$&lt;name&gt; 引用命名捕获组，{{ MACRO.match }} 为完整匹配；支持 {{ MACRO.char }}、{{ MACRO.user }} 等宏。</p>

        <label class="field-label" for="re-trim">修剪掉（每行一项，从捕获内容中移除）</label>
        <textarea id="re-trim" :value="(editing.trimStrings ?? []).join('\n')" class="textarea mono !min-h-[60px]" rows="2" spellcheck="false" @change="setTrim" />

        <div class="field-label">作用范围</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="p in EDITABLE" :key="p" type="button" class="opt" :class="{ on: editing.placement.includes(p) }" @click="togglePlacement(p)">{{ REGEX_PLACEMENTS[p] }}</button>
          <span v-for="p in editing.placement.filter((x) => !EDITABLE.includes(x))" :key="p" class="tag self-center">{{ REGEX_PLACEMENTS[p] }}（不执行）</span>
        </div>

        <div class="field-label">格式选项</div>
        <div class="flex flex-wrap gap-1.5">
          <button type="button" class="opt" :class="{ on: editing.markdownOnly }" @click="toggleTarget('markdownOnly')">仅格式显示</button>
          <button type="button" class="opt" :class="{ on: editing.promptOnly }" @click="toggleTarget('promptOnly')">仅格式提示词</button>
        </div>
        <p class="text-[12px] text-ink-3 mt-1.5 mb-0 leading-relaxed">{{ targetHint(editing) }}</p>
        <label v-if="!editing.markdownOnly && !editing.promptOnly" class="flex items-center justify-between gap-3 mt-2.5 text-[13.5px]">
          编辑消息时运行
          <van-switch v-model="editing.runOnEdit" size="20px" class="shrink-0" @change="touch" />
        </label>

        <div class="field-label">深度（0 为最后一条，留空不限）</div>
        <div class="flex items-center gap-2 text-[13.5px] text-ink-2">
          <input class="input num !w-[88px] !h-[36px]" type="number" min="-1" inputmode="numeric" placeholder="最小" :value="editing.minDepth ?? ''" aria-label="最小深度" @change="setDepth('minDepth', $event)" />
          –
          <input class="input num !w-[88px] !h-[36px]" type="number" min="0" inputmode="numeric" placeholder="最大" :value="editing.maxDepth ?? ''" aria-label="最大深度" @change="setDepth('maxDepth', $event)" />
        </div>

        <div class="field-label">查找中的宏</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="o in SUBSTITUTE" :key="o.value" type="button" class="opt" :class="{ on: (editing.substituteRegex ?? 0) === o.value }" @click="(editing.substituteRegex = o.value), touch()">
            {{ o.label }}
          </button>
        </div>

        <div class="field-label">测试</div>
        <textarea v-model="sample" class="textarea !min-h-[64px]" rows="3" placeholder="输入测试文本" data-testid="regex-sample" />
        <pre v-if="sample" class="result" data-testid="regex-result">{{ sampleOut === sample ? '（无匹配）' : sampleOut || '（输出为空）' }}</pre>

        <van-button round block size="small" class="!mt-5" @click="startCopyTo([editing])"><span class="i-lucide-copy-plus mr-1 align-[-2px]" />复制到其他预设</van-button>
        <div class="flex gap-2.5 mt-2.5">
          <van-button round block @click="removeRegex(editing)">删除</van-button>
          <van-button round block type="primary" @click="editing = null">完成</van-button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="copyToOpen" position="bottom" round :style="{ maxHeight: '85%' }">
      <div v-if="copying" class="sheet" data-testid="regex-copy-to">
        <div class="sheet-title">复制 {{ copying.length === 1 ? `「${copying[0]!.name}」` : `${copying.length} 条正则` }}到哪个预设</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">原样复制过去，按这边的先后接在那边正则列表的最后；那边已经有一样的（查找、替换、作用范围都相同）会跳过。</p>
        <PresetChooser :exclude="[preset.id]" :initial-category="preset.category" :note="copyNote" @update:model-value="copyTo" />
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 8px 2px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.row.off {
  opacity: 0.55;
}
.sortable {
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.sortable.lifted {
  opacity: 1;
  border-color: var(--accent-line);
  box-shadow: var(--shadow);
}
.row.picked {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 22px;
  height: 22px;
  margin: 0 3px 0 5px;
  border-radius: 99px;
  border: 1.5px solid var(--border);
  color: var(--on-accent);
  font-size: 13px;
}
.row.picked .check {
  background: var(--accent);
  border-color: var(--accent);
}
.mini {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.select-bar {
  position: sticky;
  bottom: 8px;
  z-index: 2;
  display: flex;
  gap: 6px;
  padding: 6px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow);
}
.sb-btn {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 38px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}
.sb-btn:disabled {
  opacity: 0.45;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 6px;
  margin: 3px 0 2px;
}
.grip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 28px;
  height: 40px;
  margin-right: -4px;
  border-radius: 10px;
  color: var(--ink-3);
  font-size: 18px;
  touch-action: none;
  cursor: grab;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
textarea.mono {
  font-size: 16px;
}
.add {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 42px;
  border-radius: 14px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 13.5px;
}
.opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.result {
  margin: 8px 0 0;
  max-height: 30vh;
  overflow: auto;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.file-hidden {
  position: fixed;
  left: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
}
</style>
