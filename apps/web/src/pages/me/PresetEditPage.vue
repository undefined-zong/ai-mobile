<script setup lang="ts">
import {
  DEVICE_INLINE_FLAG,
  HEALTH_TASKS,
  PLANNER_TASKS,
  PARALLEL_TASKS,
  SOCIAL_TASKS,
  COMMUNITY_TASKS,
  COMMUNITY_IMAGE_MOMENTS,
  IMAGE_MODES,
  IMAGE_MOMENTS,
  isRoleplayCategory,
  isPokePreset,
  isSoupPreset,
  isTruthDarePreset,
  LEVEL_PREFIXES,
  LIFE_FLAGS,
  markerName,
  momentLabel,
  PRESET_CATEGORIES,
  RHYTHM_TASKS,
  PRESET_CATEGORY_ORDER,
  SCENES,
  blockLevel,
  POKE_LEVEL,
  SOUP_LEVEL,
  SPRITE_DRAW,
  SPRITE_EXPR,
  SPRITE_FRAME,
  SPRITE_NEGATIVE,
  SPRITE_POSE,
  SPRITE_TASKS,
  TRUTH_DARE_LEVEL,
  type Preset,
  type PresetCategory,
  type PromptBlock,
} from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, ref, toRaw, watch, type ComponentPublicInstance } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import PresetChooser from '@/components/settings/PresetChooser.vue';
import PresetRegex from '@/components/settings/PresetRegex.vue';
import SpriteBlockFields from '@/components/settings/SpriteBlockFields.vue';
import SpriteParamsForm from '@/components/settings/SpriteParamsForm.vue';
import { useDragSort } from '@/composables/useDragSort';
import PageHeader from '@/layouts/PageHeader.vue';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';

/**
 * 编辑一个预设（自带的和导入的一样）：
 * - 提示词：每一块的名字、内容、角色、位置都能改，能加块、删块、开关；长按一块拖动调顺序（电脑上按住直接拖）；程序填充的块内容由程序填，其余都能改；
 *   "加程序块"可选所有用途的程序块（角色卡、你的人设、场景、聊天记录……）；
 *   一块或者多选几块能复制一份、复制到别的预设（目标里已经有的程序块会跳过）；
 * - 采样参数；正则（导入、改、拖动调顺序，见 components/settings/PresetRegex.vue）；名字、说明、分类（所有分类都能互换）；
 * - 右上角 ⋯：复制一份、导出成预设文件、恢复成预设文件里的样子（自带的）、删除。
 * 改了马上存在本机，下一次调用起生效。
 */
const route = useRoute();
const router = useRouter();
const lib = useLibraryStore();
const chars = useCharacterStore();
const preset = computed(() => lib.presetById(route.params.id as string));
const tab = ref<'blocks' | 'params' | 'sampler' | 'regex' | 'info'>('blocks');
/** 立绘预设多一页"出图参数"（模型、尺寸、换表情 / 换动作的办法） */
const tabs = computed(() => [
  { value: 'blocks' as const, label: '提示词' },
  ...(preset.value?.category === 'sprite' ? [{ value: 'params' as const, label: '出图参数' }] : []),
  { value: 'sampler' as const, label: '采样参数' },
  { value: 'regex' as const, label: '正则' },
  { value: 'info' as const, label: '名字分类' },
]);
const ROLE: Record<PromptBlock['role'], string> = { system: '系统', user: '用户', assistant: '助手' };
const roleplay = computed(() => !!preset.value && isRoleplayCategory(preset.value.category));
const usedBy = computed(() => {
  const p = preset.value;
  if (!p) return '';
  return [...chars.list.filter((c) => lib.chatPresetFor(c)?.id === p.id).map((c) => c.name), ...lib.usesOf(p.id).map((u) => u.label)].join('、');
});
const hasSeed = computed(() => !!preset.value && !!lib.seedOf(preset.value.id));

function touch() {
  if (preset.value) preset.value.updatedAt = Date.now();
}

function where(b: PromptBlock): string {
  if (!roleplay.value || b.injection.position !== 'absolute') return '按顺序';
  return b.injection.depth === 0 ? '插在聊天记录最后' : `插在聊天记录倒数第 ${b.injection.depth} 条前`;
}
function line(b: PromptBlock): string {
  if (b.marker) return `程序填充：${markerName(b.identifier) ?? b.name}`;
  return b.content.replace(/\s+/g, ' ').trim() || '（空）';
}

// —— 一块一块地改 ——
const editing = ref<PromptBlock | null>(null);
const editOpen = computed({ get: () => !!editing.value, set: (v) => !v && (editing.value = null) });
// 直接换到另一个预设（同一个页面换参数）：正在改的那一块属于上一个预设，关掉
watch(
  () => route.params.id,
  () => {
    editing.value = null;
    selecting.value = false;
    if (tab.value === 'params' && preset.value?.category !== 'sprite') tab.value = 'blocks';
  },
);

// —— 调顺序：长按一块拖到想要的位置（电脑上按住直接拖，手柄上也能用 ↑ ↓）——
function moveBlock(from: number, to: number) {
  const bs = preset.value?.blocks;
  if (!bs || from === to || !bs[from] || to < 0 || to >= bs.length) return;
  const [b] = bs.splice(from, 1);
  if (b) bs.splice(to, 0, b);
  touch();
}
const listEl = ref<HTMLElement | null>(null);
const tabsEl = ref<ComponentPublicInstance | null>(null);
/** 吸顶的标签栏下面才是看得见的列表：拖到标签栏下沿就开始往上滚 */
const tabsBottom = () => (tabsEl.value?.$el as HTMLElement | undefined)?.getBoundingClientRect().bottom ?? 0;
const sort = useDragSort({ list: listEl, onMove: moveBlock, visibleTop: tabsBottom });
/** 每一块一个固定的 key（同一个预设里 identifier 可能重复），挪位置时 DOM 跟着这一块走 */
const blockKeys = new WeakMap<PromptBlock, string>();
let keySeq = 0;
function keyOf(b: PromptBlock): string {
  const raw = toRaw(b);
  let k = blockKeys.get(raw);
  if (!k) {
    keySeq += 1;
    k = `block-${keySeq}`;
    blockKeys.set(raw, k);
  }
  return k;
}
function addBlock() {
  const bs = preset.value?.blocks;
  if (!bs) return;
  bs.push({ identifier: `custom-${Date.now().toString(36)}`, name: '新的一块', role: 'system', content: '', marker: false, enabled: true, injection: { position: 'relative', depth: 4 } });
  touch();
  editing.value = bs.at(-1) ?? null;
}
async function removeBlock(b: PromptBlock) {
  const p = preset.value;
  if (!p) return;
  const ok = await showConfirmDialog({
    title: `删掉"${b.name}"？`,
    message: b.marker ? '这是程序填充的块，删了以后这部分内容不会再发给模型。' : '这一块的文字会一起删掉。',
    confirmButtonText: '删掉',
    confirmButtonColor: 'var(--bad)',
  }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  p.blocks = p.blocks.filter((x) => x !== b);
  editing.value = null;
  touch();
}
// —— 加程序块：这一类的程序认得的程序填充块，已经有的点了打开那一块 ——
const markerOpen = ref(false);
const markerRows = computed(() => {
  const p = preset.value;
  if (!p) return [];
  return lib.markerChoices(p.category).map((m) => ({ ...m, block: p.blocks.find((b) => b.marker && b.identifier === m.identifier) }));
});
function pickMarker(row: { identifier: string; name: string; block?: PromptBlock }) {
  markerOpen.value = false;
  if (row.block) {
    editing.value = row.block;
    return;
  }
  const p = preset.value;
  const added = p && lib.addMarker(p.id, row.identifier);
  if (!added) return;
  showToast(`加了程序块「${added.name}」${p.blocks.at(-1) === added ? '，在最后' : '，在聊天记录前'}；长按可以拖到别的位置`);
}

// —— 复制：一块（编辑弹层里）或者多选几块；复制一份放在原来那块后面，或者复制到别的预设 ——
const selecting = ref(false);
const selected = ref<string[]>([]);
const selectedBlocks = computed(() => preset.value?.blocks.filter((b) => selected.value.includes(keyOf(b))) ?? []);
function startSelect() {
  editing.value = null;
  selected.value = [];
  selecting.value = true;
}
function toggleSelect(b: PromptBlock) {
  const k = keyOf(b);
  selected.value = selected.value.includes(k) ? selected.value.filter((x) => x !== k) : [...selected.value, k];
}
/** 复制结果的一句话：复制了几块，跳过的为什么 */
function copySummary(added: number, skipped: { reason: string }[]): string {
  return [added ? `复制了 ${added} 块` : '一块都没复制', ...skipped.map((x) => x.reason)].join('；');
}
function duplicate(blocks: PromptBlock[]) {
  const p = preset.value;
  const res = p && lib.copyBlocksTo(p.id, blocks, p.id);
  if (!p || !res) return;
  showToast(res.skipped.length ? copySummary(res.added.length, res.skipped) : `复制了 ${res.added.length} 块，放在原来那块后面`);
  selecting.value = false;
  // 只复制了一块：接着改复制出来的那块
  const copy = res.added.length === 1 ? p.blocks.find((b) => toRaw(b) === res.added[0]) : undefined;
  editing.value = copy ?? null;
}
const copying = ref<PromptBlock[] | null>(null);
const copyToOpen = computed({ get: () => !!copying.value, set: (v) => !v && (copying.value = null) });
function startCopyTo(blocks: PromptBlock[]) {
  if (!blocks.length) return;
  editing.value = null;
  copying.value = blocks;
}
/** 选目标时提醒已有的程序块，避免重复复制。 */
function copyNote(target: Preset): string {
  const skip = (copying.value ?? []).filter((b) => b.marker && target.blocks.some((x) => x.marker && x.identifier === b.identifier));
  return skip.length ? `${skip.length} 块程序块会跳过（那边已经有）` : '';
}
async function copyTo(id: string) {
  const p = preset.value;
  const blocks = copying.value;
  copying.value = null;
  const res = p && blocks && lib.copyBlocksTo(p.id, blocks, id);
  const target = lib.presetById(id);
  if (!res || !target) return;
  selecting.value = false;
  if (!res.added.length) return showToast(copySummary(0, res.skipped));
  const go = await showConfirmDialog({
    title: `复制到「${target.name}」了`,
    message: `${copySummary(res.added.length, res.skipped)}。放在和原来相同的邻居旁边，没有对应的邻居就放在最后。`,
    confirmButtonText: '去看看',
    cancelButtonText: '留在这里',
  }).then(
    () => true,
    () => false,
  );
  if (go) void router.push(`/me/presets/${id}`);
}

function setPosition(b: PromptBlock, absolute: boolean) {
  b.injection = { ...b.injection, position: absolute ? 'absolute' : 'relative' };
  touch();
}
/** 角色扮演预设里按开关发送的块：你人设里开着的系统，还有心跳里"连着玩具、她自己写指令" */
const ROLEPLAY_FLAGS: Record<string, string> = { ...LIFE_FLAGS, [DEVICE_INLINE_FLAG]: '心跳：连着玩具、Ta自己写指令' };
/** 触发条件的中文名：画什么、场景里的时刻、节律的任务、真心话大冒险的尺度；别的（一起做事的场景任务名）原样显示 */
const SPRITE_TRIGGERS: Record<string, string> = { ...SPRITE_TASKS, [SPRITE_DRAW]: '画法', [SPRITE_NEGATIVE]: '负面' };
function triggerLabel(t: string): string {
  const level = LEVEL_PREFIXES.map((p) => blockLevel({ triggers: [t] }, p)).find(Boolean);
  if (level) return `尺度"${level}"`;
  if (t.startsWith(SPRITE_FRAME)) return `构图"${t.slice(SPRITE_FRAME.length)}"`;
  if (t.startsWith(SPRITE_EXPR)) return `表情"${t.slice(SPRITE_EXPR.length)}"`;
  if (t.startsWith(SPRITE_POSE)) return `动作"${t.slice(SPRITE_POSE.length)}"`;
  if (SPRITE_TRIGGERS[t]) return SPRITE_TRIGGERS[t];
  return IMAGE_MODES[t as keyof typeof IMAGE_MODES] ?? momentLabel(t) ?? RHYTHM_TASKS[t as keyof typeof RHYTHM_TASKS] ?? HEALTH_TASKS[t as keyof typeof HEALTH_TASKS] ?? PLANNER_TASKS[t as keyof typeof PLANNER_TASKS] ?? PARALLEL_TASKS[t as keyof typeof PARALLEL_TASKS] ?? SOCIAL_TASKS[t as keyof typeof SOCIAL_TASKS] ?? COMMUNITY_TASKS[t as keyof typeof COMMUNITY_TASKS]
    ?? COMMUNITY_IMAGE_MOMENTS[t as keyof typeof COMMUNITY_IMAGE_MOMENTS] ?? ROLEPLAY_FLAGS[t] ?? t;
}
/** 尺度：真心话大冒险、海龟汤、戳戳乐的预设里，块上能填"…的尺度"（名字写进触发条件 前缀名字） */
const LEVEL_FIELDS = [
  { prefix: TRUTH_DARE_LEVEL, label: '真心话大冒险的尺度', show: isTruthDarePreset },
  { prefix: SOUP_LEVEL, label: '海龟汤的尺度', show: isSoupPreset },
  { prefix: POKE_LEVEL, label: '戳戳乐的尺度', show: isPokePreset },
];
const levelFields = computed(() => LEVEL_FIELDS.filter((f) => f.show(preset.value)));
/** 这一块当哪个尺度：清空就不再是尺度 */
function setLevel(b: PromptBlock, prefix: string, name: string) {
  const rest = (b.triggers ?? []).filter((t) => !t.startsWith(prefix));
  const n = name.trim();
  b.triggers = n ? [...rest, `${prefix}${n}`] : rest.length ? rest : undefined;
  touch();
}
/** 生图预设里能选的时刻：按场景分组（只列有时刻的场景） */
const momentGroups = computed(() =>
  SCENES.filter((sc) => IMAGE_MOMENTS[sc.id as keyof typeof IMAGE_MOMENTS]).map((sc) => ({ scene: sc.name, moments: IMAGE_MOMENTS[sc.id as keyof typeof IMAGE_MOMENTS] ?? {} })),
);
function toggleTrigger(b: PromptBlock, mode: string) {
  const t = new Set(b.triggers ?? []);
  if (t.has(mode)) t.delete(mode);
  else t.add(mode);
  b.triggers = t.size ? [...t] : undefined;
  touch();
}

// —— 名字、分类 ——
function setCategory(c: PresetCategory) {
  const p = preset.value;
  if (!p || p.category === c) return;
  p.category = c;
  touch();
  showToast(`已归入${PRESET_CATEGORIES[c].label}分类`);
}

// —— 右上角 ⋯ ——
const moreOpen = ref(false);
const actions = computed(() => [
  { name: '复制一份', subname: '可以复制到任意分类', key: 'copy' },
  { name: '导出预设文件', subname: '.json，能在别的设备上导入，也能放进 src/presets 当自带预设', key: 'export' },
  ...(hasSeed.value ? [{ name: '恢复成预设文件里的样子', subname: preset.value?.seedFile ?? '', key: 'restore' }] : []),
  { name: '删除这个预设', color: 'var(--bad)', key: 'delete' },
]);
const copyOpen = ref(false);
function onAction(a: { key: string }) {
  moreOpen.value = false;
  if (a.key === 'copy') {
    copyOpen.value = true;
  } else if (a.key === 'export') exportFile();
  else if (a.key === 'restore') void restore();
  else if (a.key === 'delete') void remove();
}
function copyAs(c?: PresetCategory) {
  copyOpen.value = false;
  const p = preset.value;
  if (!p) return;
  const copy = lib.duplicatePreset(p.id, c);
  if (!copy) return;
  showToast(`复制好了：${PRESET_CATEGORIES[copy.category].label}预设「${copy.name}」`);
  void router.replace(`/me/presets/${copy.id}`);
}
function exportFile() {
  const p = preset.value;
  const file = p && lib.exportFile(p.id);
  if (!p || !file) return;
  const blob = new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.name.replace(/[\\/:*?"<>|]/g, '_')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
async function restore() {
  const p = preset.value;
  if (!p) return;
  const ok = await showConfirmDialog({ title: '恢复成预设文件里的样子？', message: `按 ${p.seedFile} 重新来一遍：你在这个预设里改过的块、参数、名字都会还原。`, confirmButtonText: '恢复' }).then(
    () => true,
    () => false,
  );
  if (ok && lib.restoreFromFile(p.id)) showToast('恢复好了');
}
async function remove() {
  const p = preset.value;
  if (!p) return;
  const ok = await showConfirmDialog({
    title: `删除「${p.name}」？`,
    message: `${usedBy.value ? `现在用在：${usedBy.value}，删了以后那些地方改用这一类的第一个预设。` : ''}${p.seedFile ? `这是自带的预设，删了不会自己回来；想要可以重新导入 ${p.seedFile}。` : ''}`,
    confirmButtonText: '删除',
    confirmButtonColor: 'var(--bad)',
  }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  const cat = p.category;
  lib.removePreset(p.id);
  showToast('删掉了');
  void router.replace(`/me/presets?cat=${cat}`);
}

const MACROS = '{{char}}、{{user}}、{{time}}';
const HINT: Record<PresetCategory, string> = {
  chat: '"程序填充"的块由 App 生成：角色卡字段、命中的世界书、记忆、【当前环境】、场景规则、聊天记录。导入 ST 预设时，这几块会自动插进它的顺序里。',
  feature: '一起做某件事时用。"场景规则"那一块写这件事里Ta怎么说话，可以改；能用的标签和表情由程序按场景填。',
  proactive: '"主动消息：这一次要Ta做的事"由程序填（现在几点、这次为什么来找你），插在聊天记录最后；怎么写（长短、口吻）写在别的块里。',
  theater: '"程序填充"的块是这一次的输入（角色、Ta的世界、现在、记得的事、最近的聊天）；任务、要求、输出格式都能改。输出格式里的字段名别改，程序按它读。',
  summary: '"程序填充"的块是这一次的输入（现在、上一段摘要、已有记忆、要整理的聊天）；任务、规则、输出格式都能改。输出格式里的字段名别改，程序按它读。',
  image:
    '"画什么"几块按这次画的类型只发一块，一起做事时自动画的"时刻"（入座、偷拍、奖励……）也一样（在块里设"只在画这些时发送"）；"程序填充"的块是这一次的输入。块里能用 {{char_appearance}}（Ta的长相，同人是角色 tag + 作品 tag）、{{char_outfit}}（节律里Ta今天这个场景穿的那套）、{{user_appearance}}。输出格式里的字段名别改，程序按它读。',
  rhythm:
    '"建世界""排今天"两件任务、穿着的两种做法按触发条件只发这次要做的那几块（在块里设"只在做这些事时发送"）；"程序填充"的块是这一次的输入（角色、世界书、Ta的世界、模板、衣柜、今天、最近几天）。输出格式里的字段名别改，程序按它读，读完还会检查作息有没有盖满一天、地点在不在Ta的世界里。',
  health:
    '"排这周""排今天"两件任务按触发条件只发这次要做的那几块（在块里设"只在做这些事时发送"）；"程序填充"的块是这一次的输入（你人设里的身体和目标、能练的方式和时间、食材和厨具、今天、这周的计划、最近练了什么）。动作怎么讲（大白话、少用肌肉名称）写在规则里，可以改；输出格式里的字段名别改，程序按它读。',
  planner:
    '日程系统用。"查邮件和日程""排这周""排今天"三件任务按触发条件只发这次要做的那一块（在块里设"只在做这些事时发送"）；"程序填充"的块是这一次的输入（你和你写的情况、今天、家务和健康、能用的 MCP 工具、查到的邮件和日程、这周的计划、最近几天）。哪些邮件算要紧、时间线怎么排写在规则里，可以改；输出格式里的字段名别改，程序按它读。',
  parallel:
    '平行时空用。"Ta给你留言""回你的留言""你请Ta改日程"三件任务按触发条件只发这次要做的那一块（在块里设"只在做这些事时发送"）；"程序填充"的块是这一次的输入（角色、现在、Ta今天的节律、Ta世界里的地点、你今天的安排、记忆、最近的聊天和留言、这一条留言）。两边的事各有编号（Ta的 C1…、你的 U1…），留言说的是哪一项写编号。留言的分寸、改日程答不答应的规矩写在规则和任务块里，可以改；输出格式里的字段名别改，程序按它读。',
  device:
    '心跳里Ta每说完一句，按这个预设给连着的玩具写指令。"程序填充"的块是这一次的输入：连着的玩具和能写的键、你设的强度上限和最快速度、玩具现在在做什么、最近的对话、Ta这一句。轻重怎么对应剧情写在规则里，可以改；指令的键（VIBRATE、LINEAR……）和输出格式里的字段名别改，程序按它读，读到Ta原话里 at 写的那几个字时执行。',
  sprite:
    '"角色 → 立绘 → AI 画立绘"用。两种块：交给"生图提示词"的文本模型的任务（写外观 tags、给新表情写 tags，"程序填充"的块是这一次的输入，输出格式里的字段名别改）；直接拼进 NovelAI 提示词的画法、负面、构图、表情、动作（不发给文本模型）。构图（半身、全身……）、表情、动作一块一个，名字就是画出来的立绘标的名字，有几个、叫什么、tags 都随你改，关掉的不用；App 里平时用半身立绘，全身的也能画。画法里能用 {{char_appearance}} {{char_outfit}} {{framing}} {{expression}} {{pose}}。模型、尺寸、默认构图、换表情和换动作的办法在"出图参数"里。',
  social:
    '朋友圈和社群各用一个。朋友圈的两件任务（Ta发一条、回应你）和社群的五件任务（按关键字建社群、网友发帖、网友回应你、加入社群的角色发帖、Ta回应你）按触发条件只发这次要做的那几块（在块里设"只在做这些事时发送"）；"程序填充"的块是这一次的输入（角色、Ta今天的节律、现在、记得的事、最近的聊天；朋友圈的最近几条和要回应的那一条；社群的介绍、认识的人、最近的帖子和要回应的那一帖）。发什么、多长、什么时候配图、什么时候附一张小票或卡片、赞和顶给多少写在规则里，可以改；输出格式里的字段名别改，程序按它读。',
  novel:
    '创意工坊里写小说用。"商量""写下一章""写番外"几件事按触发条件只发这次要做的那一块（novel-chat、novel-chapter、novel-extra）；"程序填充"的块是这一次的输入（作品的设定和大纲、已经写好的章节、你们最近的讨论、这一次要做的）。文风、长度、尺度写在规则里，可以改；写章节时第一行"# 标题"的格式别改，程序按它分出标题和正文。',
  assistant:
    '"我的 → 助手"用。"一键检测""做角色卡""预设融合"三件事按触发条件只发那一块（check、card、merge），平时聊天都不发；"程序填充"的块是这一次的输入（特殊格式和参照的自带预设、要看的对象、程序检测到的问题、最近的对话、你刚说的）。"规则"里写着只改格式不改原文，可以改；"修改的写法"里的字段名别改，程序按它读。',
};
</script>

<template>
  <div v-if="preset" class="page" data-page="preset-edit">
    <PageHeader :title="preset.name" :subtitle="`${PRESET_CATEGORIES[preset.category].label}预设${usedBy ? ` · 用在：${usedBy}` : ''}`" :fallback="`/me/presets?cat=${preset.category}`">
      <template #right>
        <RouterLink :to="`/me/assistant?target=preset:${preset.id}`" class="icon-btn" aria-label="让助手看看格式"><span class="i-lucide-bot text-[20px]" /></RouterLink>
        <button class="icon-btn" aria-label="更多" @click="moreOpen = true"><span class="i-lucide-ellipsis text-[20px]" /></button>
      </template>
    </PageHeader>
    <div class="page-scroll pb-10">
      <Segmented ref="tabsEl" v-model="tab" sticky :options="tabs" />

      <div v-if="tab === 'blocks'" ref="listEl" class="px-4 grid gap-1.5" data-testid="preset-blocks">
        <van-cell
          title="使用世界书"
          :label="roleplay
            ? '控制角色绑定的全部世界书条目，包括按深度、示例前后和作者注位置。角色卡示例和预设正文按各自设置发送。'
            : '打开后按这一次的输入扫描角色绑定的世界书，常驻和命中的条目放进世界书程序块（预设里没有时放在第一个程序填充块前面）。没有绑定角色的任务不发。'"
          center
          class="!rounded-[14px]"
        >
          <template #right-icon>
            <van-switch :model-value="preset.worldInfoEnabled ?? roleplay" size="22px" aria-label="使用世界书" @update:model-value="preset.worldInfoEnabled = $event; touch()" />
          </template>
        </van-cell>
        <div class="flex items-center gap-2 text-[12.5px] text-ink-3 px-1">
          <span class="flex-1">{{ selecting ? `点块来选，已选 ${selected.length} 块` : `${preset.blocks.length} 块` }}</span>
          <button v-if="!selecting" type="button" class="mini press" data-testid="blocks-select" @click="startSelect"><span class="i-lucide-list-checks" />选几块复制</button>
          <button v-else type="button" class="mini press" @click="selected = selected.length === preset.blocks.length ? [] : preset.blocks.map(keyOf)">
            {{ selected.length === preset.blocks.length ? '全不选' : '全选' }}
          </button>
        </div>
        <div
          v-for="(b, i) in preset.blocks"
          :key="keyOf(b)"
          class="block sortable"
          :class="{ off: !b.enabled && !selecting, lifted: sort.state.phase === 'drag' && sort.state.from === i, picked: selecting && selected.includes(keyOf(b)) }"
          :style="sort.styleFor(i)"
          :data-block="b.identifier"
          data-sort-item
          @pointerdown="!selecting && sort.onPointerDown($event, i)"
          @touchstart.passive="!selecting && sort.onTouchStart($event, i)"
        >
          <span v-if="selecting" class="check" aria-hidden="true"><span v-if="selected.includes(keyOf(b))" class="i-lucide-check" /></span>
          <button v-else type="button" class="grip" data-sort-handle :aria-label="`拖动调整「${b.name}」的位置，也可以按上下方向键`" @keydown="sort.onHandleKey($event, i)">
            <span class="i-lucide-grip-vertical" />
          </button>
          <button
            type="button"
            class="flex-1 min-w-0 text-left"
            :aria-label="selecting ? `选「${b.name}」` : `编辑「${b.name}」`"
            :aria-pressed="selecting ? selected.includes(keyOf(b)) : undefined"
            @click="selecting ? toggleSelect(b) : (editing = b)"
          >
            <div class="flex items-center gap-1.5 min-w-0">
              <span class="block-name text-[14px] truncate" :class="{ 'font-600': !b.marker }">{{ b.name }}</span>
              <!-- 窄屏、大字体时标签先让位，名字尽量完整 -->
              <span class="block-tags">
                <span class="tag">{{ ROLE[b.role] }}</span>
                <span v-if="b.marker" class="tag accent">程序填充</span>
                <span v-if="b.triggers?.length" class="tag">只在 {{ b.triggers.map(triggerLabel).join(' / ') }}</span>
              </span>
            </div>
            <div class="text-[11.5px] text-ink-3 truncate">{{ where(b) }} · {{ line(b) }}</div>
          </button>
          <van-switch v-if="!selecting" v-model="b.enabled" data-sort-ignore size="20px" :aria-label="`发送「${b.name}」`" @change="touch" />
        </div>
        <div v-if="selecting" class="select-bar" data-testid="blocks-select-bar">
          <button type="button" class="sb-btn press" :disabled="!selected.length" @click="duplicate(selectedBlocks)"><span class="i-lucide-copy" />复制一份</button>
          <button type="button" class="sb-btn press" :disabled="!selected.length" @click="startCopyTo(selectedBlocks)"><span class="i-lucide-copy-plus" />复制到其他预设</button>
          <button type="button" class="sb-btn press" @click="selecting = false">取消</button>
        </div>
        <div v-else class="grid grid-cols-2 gap-1.5">
          <button type="button" class="add press" @click="addBlock"><span class="i-lucide-plus" />加一块</button>
          <button type="button" class="add press" data-testid="add-marker" @click="markerOpen = true"><span class="i-lucide-cpu" />加程序块</button>
        </div>
        <p class="text-[12px] text-ink-3 mt-1 mb-0 leading-relaxed">
          长按一块拖到想要的位置（电脑上用鼠标按住直接拖），从上到下就是发给模型的顺序。{{ HINT[preset.category] }} "加程序块"能把关掉、删掉的程序填充块加回来。文字里可以用 {{ MACROS }} 这些宏。
        </p>
      </div>

      <SpriteParamsForm v-else-if="tab === 'params' && preset.category === 'sprite'" :key="preset.id" :preset="preset" @touch="touch" />

      <van-cell-group v-else-if="tab === 'sampler'" inset>
        <van-cell :title="`温度 ${preset.sampler.temperature.toFixed(2)}`" label="越高越随性">
          <template #label><van-slider v-model="preset.sampler.temperature" :min="0" :max="2" :step="0.05" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell :title="`Top P ${preset.sampler.topP.toFixed(2)}`">
          <template #label><van-slider v-model="preset.sampler.topP" :min="0" :max="1" :step="0.01" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell title="最大回复（token）" center>
          <template #right-icon><van-stepper v-model="preset.sampler.maxTokens" min="32" max="16000" step="32" @change="touch" /></template>
        </van-cell>
        <van-cell title="最长上下文（token）" :label="roleplay ? '聊天记录按它截断' : '这一次的输入超过时，从最长的程序填充块开头截掉'" center>
          <template #right-icon><van-stepper v-model="preset.sampler.contextTokens" min="2000" max="200000" step="2000" @change="touch" /></template>
        </van-cell>
        <van-cell :title="`频率惩罚 ${preset.sampler.frequencyPenalty.toFixed(1)}`">
          <template #label><van-slider v-model="preset.sampler.frequencyPenalty" :min="-2" :max="2" :step="0.1" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell :title="`存在惩罚 ${preset.sampler.presencePenalty.toFixed(1)}`">
          <template #label><van-slider v-model="preset.sampler.presencePenalty" :min="-2" :max="2" :step="0.1" class="!mt-3" bar-height="4px" button-size="16px" @change="touch" /></template>
        </van-cell>
        <van-cell v-if="roleplay" title="流式输出" center>
          <template #right-icon><van-switch v-model="preset.sampler.stream" size="22px" @change="touch" /></template>
        </van-cell>
      </van-cell-group>

      <PresetRegex v-else-if="tab === 'regex'" :preset="preset" :visible-top="tabsBottom" @touch="touch" />

      <div v-else class="px-4">
        <label class="field-label" for="pe-name">名字</label>
        <input id="pe-name" v-model="preset.name" class="input" autocomplete="off" @change="touch" />
        <label class="field-label" for="pe-desc">说明</label>
        <textarea id="pe-desc" v-model="preset.description" class="textarea" rows="3" @change="touch" />
        <div class="field-label">分类</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="c in PRESET_CATEGORY_ORDER" :key="c" type="button" class="opt" :class="{ on: preset.category === c }" @click="setCategory(c)">{{ PRESET_CATEGORIES[c].label }}</button>
        </div>
        <p class="text-[12px] text-ink-3 mt-1.5 mb-0 leading-relaxed">
          分类用来整理预设。每个场景都能选用任意分类的预设，改分类后原来的用途绑定继续生效。
        </p>
        <p class="text-[12px] text-ink-3 mt-3 mb-0 leading-relaxed">
          {{ preset.seedFile ? `自带的预设，来自预设文件 ${preset.seedFile}；改了、删了都可以，右上角 ⋯ 能恢复成文件里的样子。` : preset.source?.kind === 'sillytavern' ? `从 SillyTavern 导入（${preset.source.fileName ?? ''}）。` : '你导入或复制的预设。' }}
        </p>
      </div>
    </div>

    <van-action-sheet v-model:show="moreOpen" :actions="actions" cancel-text="取消" close-on-click-action @select="onAction" />
    <van-action-sheet
      v-model:show="copyOpen"
      title="复制成哪一类"
      :actions="PRESET_CATEGORY_ORDER.map((c) => ({ name: `${PRESET_CATEGORIES[c].label}预设`, subname: PRESET_CATEGORIES[c].desc, key: c }))"
      cancel-text="取消"
      close-on-click-action
      @select="(a: { key: PresetCategory }) => copyAs(a.key)"
    />

    <van-popup v-model:show="editOpen" position="bottom" round :style="{ maxHeight: '92%' }">
      <div v-if="editing" class="sheet" data-testid="block-editor">
        <div class="sheet-title">{{ editing.marker ? '程序填充的块' : '编辑这一块' }}</div>
        <label class="field-label" for="be-name">名字</label>
        <input id="be-name" v-model="editing.name" class="input" autocomplete="off" @change="touch" />
        <p v-if="editing.marker" class="text-[12.5px] text-ink-3 mt-2 mb-0 leading-relaxed">
          内容由程序填：{{ markerName(editing.identifier) ?? editing.identifier }}。可以改名字、角色{{ roleplay ? '、位置' : '' }}，或者关掉、删掉。
        </p>
        <template v-else>
          <label class="field-label" for="be-content">内容</label>
          <textarea id="be-content" v-model="editing.content" class="textarea" rows="9" spellcheck="false" @change="touch" />
        </template>
        <div class="field-label">角色</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="(label, r) in ROLE" :key="r" type="button" class="opt" :class="{ on: editing.role === r }" @click="(editing.role = r), touch()">{{ label }}</button>
        </div>
        <template v-if="roleplay">
          <div class="field-label">位置</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <button type="button" class="opt" :class="{ on: editing.injection.position !== 'absolute' }" @click="setPosition(editing, false)">按顺序</button>
            <button type="button" class="opt" :class="{ on: editing.injection.position === 'absolute' }" @click="setPosition(editing, true)">插进聊天记录</button>
            <template v-if="editing.injection.position === 'absolute'">
              <span class="text-[13px] text-ink-2 ml-1">倒数第</span>
              <van-stepper v-model="editing.injection.depth" min="0" max="50" @change="touch" />
              <span class="text-[13px] text-ink-2">条前（0 = 最后）</span>
            </template>
          </div>
        </template>
        <template v-if="preset.category === 'image'">
          <div class="field-label">只在画这些时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, m) in IMAGE_MODES" :key="m" type="button" class="opt" :class="{ on: editing.triggers?.includes(m) }" @click="toggleTrigger(editing, m)">{{ label }}</button>
          </div>
          <template v-for="g in momentGroups" :key="g.scene">
            <div class="text-[12px] text-ink-3 mt-2.5 mb-1.5">{{ g.scene }}时自动画的时刻</div>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, m) in g.moments" :key="m" type="button" class="opt" :class="{ on: editing.triggers?.includes(m) }" @click="toggleTrigger(editing, m)">{{ label }}</button>
            </div>
          </template>
          <div class="text-[12px] text-ink-3 mt-2.5 mb-1.5">社群里帖子的配图：谁发的</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, m) in COMMUNITY_IMAGE_MOMENTS" :key="m" type="button" class="opt" :class="{ on: editing.triggers?.includes(m) }" @click="toggleTrigger(editing, m)">{{ label }}</button>
          </div>
        </template>
        <template v-else-if="preset.category === 'rhythm'">
          <div class="field-label">只在做这些事时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in RHYTHM_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
        </template>
        <SpriteBlockFields v-else-if="preset.category === 'sprite' && !editing.marker" :block="editing" @touch="touch" />
        <template v-else-if="preset.category === 'health'">
          <div class="field-label">只在做这些事时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in HEALTH_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
        </template>
        <template v-else-if="preset.category === 'planner'">
          <div class="field-label">只在做这些事时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in PLANNER_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
        </template>
        <template v-else-if="preset.category === 'parallel'">
          <div class="field-label">只在做这些事时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in PARALLEL_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
        </template>
        <template v-else-if="preset.category === 'social'">
          <div class="field-label">只在做这些事时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in SOCIAL_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
          <div class="text-[12px] text-ink-3 mt-2.5 mb-1.5">社群</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in COMMUNITY_TASKS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
        </template>
        <template v-else-if="roleplay && !editing.marker">
          <div class="field-label">只在这些开着时发送（都不选 = 一直发）</div>
          <div class="flex flex-wrap gap-1.5">
            <button v-for="(label, t) in ROLEPLAY_FLAGS" :key="t" type="button" class="opt" :class="{ on: editing.triggers?.includes(t) }" @click="toggleTrigger(editing, t)">{{ label }}</button>
          </div>
          <template v-for="f in levelFields" :key="f.prefix">
            <label class="field-label" :for="`be-level-${f.prefix}`">{{ f.label }}（填了名字，这一块就是一个尺度：开始前按块的顺序列出来，选了它才发送）</label>
            <input
              :id="`be-level-${f.prefix}`"
              :value="blockLevel(editing, f.prefix)"
              class="input"
              autocomplete="off"
              placeholder="不是尺度就空着"
              @change="setLevel(editing, f.prefix, ($event.target as HTMLInputElement).value)"
            />
          </template>
        </template>
        <div class="flex gap-2.5 mt-5">
          <van-button round block size="small" :disabled="editing.marker" @click="duplicate([editing])"><span class="i-lucide-copy mr-1 align-[-2px]" />复制一份</van-button>
          <van-button round block size="small" @click="startCopyTo([editing])"><span class="i-lucide-copy-plus mr-1 align-[-2px]" />复制到其他预设</van-button>
        </div>
        <p v-if="editing.marker" class="text-[12px] text-ink-3 mt-1.5 mb-0">程序块在一个预设里只能有一块，可以复制到别的预设。</p>
        <div class="flex gap-2.5 mt-2.5">
          <van-button round block @click="removeBlock(editing)">删掉这一块</van-button>
          <van-button round block type="primary" @click="editing = null">好了</van-button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="markerOpen" position="bottom" round :style="{ maxHeight: '80%' }">
      <div class="sheet" data-testid="marker-picker">
        <div class="sheet-title">加程序块</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">
          所有用途的程序块都能添加，内容由当前场景填充。已经有的点了打开那一块。
        </p>
        <div class="grid gap-1.5">
          <button v-for="m in markerRows" :key="m.identifier" type="button" class="marker-row press" :class="{ has: !!m.block }" :data-marker="m.identifier" @click="pickMarker(m)">
            <span class="flex-1 min-w-0 text-left">
              <span class="block text-[14px] truncate">{{ m.name }}</span>
              <span class="block text-[11.5px] text-ink-3 truncate">{{ m.identifier }}</span>
            </span>
            <span v-if="m.block" class="tag">{{ m.block.enabled ? '已有' : '已有 · 关着' }}</span>
            <span v-else class="i-lucide-plus text-accent-ink" />
          </button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="copyToOpen" position="bottom" round :style="{ maxHeight: '85%' }">
      <div v-if="copying" class="sheet" data-testid="copy-to">
        <div class="sheet-title">复制 {{ copying.length === 1 ? `「${copying[0]!.name}」` : `${copying.length} 块` }}到哪个预设</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-3 leading-relaxed">原样复制过去，放在和这边相同的邻居旁边；那边已经有、或者那一类用不了的程序块会跳过。</p>
        <PresetChooser :exclude="[preset.id]" :initial-category="preset.category" :note="copyNote" @update:model-value="copyTo" />
      </div>
    </van-popup>
  </div>
  <div v-else class="page items-center justify-center text-ink-3 gap-3" data-page="preset-missing">
    这个预设不在了
    <RouterLink to="/me/presets" class="text-accent-ink">回到预设</RouterLink>
  </div>
</template>

<style scoped>
.block {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 8px 6px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.block.off {
  opacity: 0.55;
}
.block.picked {
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
.block.picked .check {
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
.marker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border-radius: 14px;
  background: var(--panel);
}
.marker-row.has {
  opacity: 0.7;
}
/* 长按拖动：不选中文字、不弹系统菜单 */
.sortable {
  padding-left: 2px;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}
.sortable.lifted {
  opacity: 1;
  border-color: var(--accent-line);
  box-shadow: var(--shadow);
}
.block-name {
  flex: 0 1 auto;
  min-width: 2.5em;
}
.block-tags {
  display: flex;
  gap: 6px;
  flex: 0 10 auto;
  min-width: 0;
  overflow: hidden;
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
  /* 按住手柄直接拖，不滚动页面 */
  touch-action: none;
  cursor: grab;
}
@media (hover: hover) {
  .sortable:hover .grip {
    color: var(--ink-2);
  }
}
.add {
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
</style>
