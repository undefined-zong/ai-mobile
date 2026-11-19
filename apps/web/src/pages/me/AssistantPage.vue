<script setup lang="ts">
import { errorText, isAbortError } from '@app/ai';
import { FORMAT_LEVELS, PRESET_CATEGORIES, parseAssistantReply, type EditKind, type FormatLevel } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import AssistantEdits from '@/components/settings/AssistantEdits.vue';
import PresetChooser from '@/components/settings/PresetChooser.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import {
  askAssistant,
  assistantStatus,
  isImported,
  KIND_LABEL,
  linkOf,
  MODE_LABEL,
  needsFix,
  scanImports,
  targetInfo,
  type ScanResult,
  type TargetInfo,
} from '@/services/assistant';
import { useAssistantStore, type AssistantMerge, type AssistantMode, type AssistantTarget } from '@/stores/assistant';
import { useCharacterStore } from '@/stores/characters';
import { useLibraryStore } from '@/stores/library';
import { useBrawlStore } from '@/stores/brawl';

/**
 * 我的 → 助手：和助手聊着改预设、世界书、角色卡。
 * - 上面选"要看的"（可以选好几个，批量改）；
 * - 一键检测：上次检测之后导入的（没有就查全部导入的）哪些和 App 的格式不合，不用 API；有问题的一键交给助手修；
 * - 做角色卡、补全设定；
 * - 预设融合：选一个底子、一个功能来源，助手照底子新建预设，把功能来源里的块和正则缝进去（两个原来的都不改）；
 * - 助手给的修改先预览（改之前 / 改之后），点"应用"才改，能撤销。提示词在"助手"预设里，API 是"助手"这个功能。
 */
const store = useAssistantStore();
const lib = useLibraryStore();
const chars = useCharacterStore();
const brawl = useBrawlStore();
const route = useRoute();
const router = useRouter();

const status = computed(() => assistantStatus());
const presetLink = computed(() => {
  const id = lib.presetForUse('assistant')?.id;
  return id ? `/me/presets/${id}` : '/me/presets?cat=assistant';
});

// —— 要看的 ——
const targetRows = computed(() => store.targets.map(targetInfo).filter((x): x is TargetInfo => !!x));
const hasCharacter = computed(() => targetRows.value.some((r) => r.target.kind === 'character'));

const LEVEL_TONE: Record<FormatLevel, string> = { error: 'bad', warn: 'warn', info: 'info' };
function countText(r: TargetInfo): string {
  const n = (l: FormatLevel) => r.issues.filter((i) => i.level === l).length;
  const parts = [n('error') ? `不适配 ${n('error')}` : '', n('warn') ? `可能 ${n('warn')}` : '', n('info') ? `可补 ${n('info')}` : ''].filter(Boolean);
  return parts.join(' · ') || '适配';
}

// —— 选对象 ——
const pickerOpen = ref(false);
const pickTab = ref<EditKind>('preset');
const PICK_TABS: { value: EditKind; label: string; icon: string }[] = [
  { value: 'preset', label: '预设', icon: 'i-lucide-sliders-horizontal' },
  { value: 'lorebook', label: '世界书', icon: 'i-lucide-library-big' },
  { value: 'character', label: '角色卡', icon: 'i-lucide-contact-round' },
  { value: 'fighter', label: '战斗档案', icon: 'i-lucide-swords' },
];
const onlyImported = ref(true);
const pickRows = computed(() => {
  const list: AssistantTarget[] =
    pickTab.value === 'preset'
      ? lib.presets.map((p) => ({ kind: 'preset', id: p.id }))
      : pickTab.value === 'lorebook'
        ? lib.lorebooks.map((b) => ({ kind: 'lorebook', id: b.id }))
        : pickTab.value === 'fighter'
          ? brawl.fighters.map(f => ({ kind: 'fighter', id: f.id }))
          : chars.list.map((c) => ({ kind: 'character', id: c.id }));
  return list
    .filter((t) => !onlyImported.value || isImported(t))
    .map(targetInfo)
    .filter((x): x is TargetInfo => !!x);
});
function openPicker(tab?: EditKind) {
  if (tab) pickTab.value = tab;
  pickerOpen.value = true;
}
function pickProblems() {
  for (const r of pickRows.value) if (needsFix(r) && !store.hasTarget(r.target)) store.toggleTarget(r.target);
}

// —— 对话 ——
const said = ref('');
const mode = ref<AssistantMode | null>(null);
const replying = ref<string | null>(null);
const box = ref<HTMLElement | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
let abort: AbortController | null = null;
let alive = true;
onBeforeUnmount(() => {
  alive = false;
  abort?.abort();
});

function scrollDown() {
  void nextTick(() => {
    const el = box.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

const placeholder = computed(() =>
  mode.value === 'card'
    ? hasCharacter.value
      ? '要补哪些（不写就补空着的）'
      : '说说Ta是谁：名字、性格、你们的关系、世界观……'
    : targetRows.value.length
      ? store.targets.some(t => t.kind === 'fighter') ? '例如：提高血量，把技能二改成突进上挑，降低奥义耗蓝' : '要怎么改：把生图写法换成 [cg:]、补上输出格式……'
      : '说点什么，或者先在上面选要看的预设、世界书、角色卡',
);

async function send(text = said.value, m: AssistantMode | null = mode.value, merge?: AssistantMerge) {
  const t = text.trim();
  if (replying.value !== null || (!t && !m)) return;
  if (!status.value.live) return showToast(status.value.reason);
  const history = [...store.messages];
  const targets = store.targets.map((x) => ({ ...x }));
  said.value = '';
  mode.value = null;
  store.add({ role: 'user', text: t || MODE_LABEL[m!], ...(m ? { mode: m } : {}), ...(merge ? { merge } : {}), targets });
  replying.value = '';
  scrollDown();
  abort = new AbortController();
  try {
    const raw = await askAssistant({
      ask: t,
      mode: m ?? undefined,
      merge,
      targets,
      history,
      signal: abort.signal,
      onText: (x) => {
        if (!alive) return;
        replying.value = x;
        scrollDown();
      },
    });
    const r = parseAssistantReply(raw);
    // 回复写完了 <edits> 还没收尾：被截断了（回复最长不够）或者 JSON 读不出来，说清楚，不要悄悄丢掉
    const opErrors = r.pending ? [...r.errors, '<edits> 没写完，后面的修改没读到：回复可能被截断了，可以在"助手"预设的采样参数里调大"回复最长"再问一次'] : r.errors;
    store.add({ role: 'assistant', text: r.text || (r.ops.length ? '' : '（没说什么）'), ...(r.ops.length ? { ops: r.ops } : {}), ...(opErrors.length ? { opErrors } : {}) });
  } catch (e) {
    if (isAbortError(e)) {
      if (replying.value?.trim()) store.add({ role: 'assistant', text: `${replying.value.trim()}…（停下了）` });
    } else store.add({ role: 'assistant', text: '', error: errorText(e) });
  } finally {
    replying.value = null;
    abort = null;
    scrollDown();
  }
}

function stop() {
  abort?.abort();
}

function startCard() {
  mode.value = 'card';
  void nextTick(() => input.value?.focus());
}

function fillCard() {
  if (!hasCharacter.value) {
    showToast('先选一个角色卡');
    return openPicker('character');
  }
  void send(said.value || '把空着的设定补全（已经写了的不改）', 'card');
}

async function clearChat() {
  if (!store.messages.length) return;
  try {
    await showConfirmDialog({ title: '清空和助手的对话', message: '应用过的修改不会撤销。', confirmButtonText: '清空' });
  } catch {
    return;
  }
  store.clear();
  scan.value = null;
}

// —— 预设融合：选底子和功能来源 ——
const mergeOpen = ref(false);
const mergeSlot = ref<keyof AssistantMerge>('base');
const merging = ref<{ base: string | null; source: string | null }>({ base: null, source: null });
const MERGE_SLOTS: { value: keyof AssistantMerge; label: string }[] = [
  { value: 'base', label: '底子' },
  { value: 'source', label: '功能来源' },
];
const presetName = (id: string | null | undefined) => (id ? (lib.presetById(id)?.name ?? '（找不到了）') : '');
function startMerge() {
  // 要看的里已经选了预设：先拿前两个填上
  const [base, source] = store.targets.filter((t) => t.kind === 'preset' && lib.presetById(t.id)).map((t) => t.id);
  merging.value = { base: base ?? null, source: source ?? null };
  mergeSlot.value = merging.value.base ? 'source' : 'base';
  mergeOpen.value = true;
}
function pickMerge(id: string) {
  const other: keyof AssistantMerge = mergeSlot.value === 'base' ? 'source' : 'base';
  merging.value = { ...merging.value, [mergeSlot.value]: id, ...(merging.value[other] === id ? { [other]: null } : {}) };
  if (!merging.value[other]) mergeSlot.value = other;
}
function swapMerge() {
  merging.value = { base: merging.value.source, source: merging.value.base };
}
function runMerge() {
  const { base, source } = merging.value;
  if (!base || !source) return showToast('底子和功能来源都要选');
  if (!status.value.live) return showToast(status.value.reason);
  mergeOpen.value = false;
  store.setTargets([
    { kind: 'preset', id: base },
    { kind: 'preset', id: source },
  ]);
  void send(said.value || `把「${presetName(source)}」里的功能缝进「${presetName(base)}」，做成一个新预设`, 'merge', { base, source });
}

// —— 一键检测 ——
const scan = ref<ScanResult | null>(null);
const fightersOnly = computed(() => store.targets.length > 0 && store.targets.every(t => t.kind === 'fighter'));
const scanProblems = computed(() => scan.value?.rows.filter(needsFix) ?? []);
function runScan() {
  scan.value = scanImports();
  scrollDown();
}
function fixScan() {
  const rows = scanProblems.value;
  if (!rows.length) return;
  if (!status.value.live) return showToast(status.value.reason);
  store.setTargets(rows.map((r) => r.target));
  scan.value = null;
  void send(said.value || `检测这 ${rows.length} 个，不适配的改成适配的（只改格式）`, 'check');
}
function checkSelected() {
  if (!targetRows.value.length) return runScan();
  void send(said.value, 'check');
}

// 从别的页进来：?check=1 一键检测；?target=preset:id,lorebook:id 选好要看的
onMounted(() => {
  const t = String(route.query.target ?? '');
  if (t) {
    const list = t
      .split(',')
      .map((x) => [x.slice(0, x.indexOf(':')), x.slice(x.indexOf(':') + 1)])
      .filter((x): x is [EditKind, string] => (x[0] === 'preset' || x[0] === 'lorebook' || x[0] === 'character' || x[0] === 'fighter') && !!x[1])
      .map(([kind, id]) => ({ kind, id }));
    if (list.length) store.setTargets(list);
  }
  if (route.query.check) runScan();
  if (t || route.query.check) void router.replace({ query: {} });
  scrollDown();
});

const IDEAS: { label: string; icon: string; run: () => void }[] = [
  { label: '一键检测新导入的', icon: 'i-lucide-scan-search', run: runScan },
  { label: '做一张新角色卡', icon: 'i-lucide-user-round-plus', run: startCard },
  { label: '补全角色卡的设定', icon: 'i-lucide-list-plus', run: fillCard },
  { label: '批量改几个预设 / 世界书', icon: 'i-lucide-layers', run: () => openPicker('preset') },
  { label: '融合两个预设', icon: 'i-lucide-combine', run: startMerge },
  { label: '调整大乱斗属性与技能', icon: 'i-lucide-swords', run: () => openPicker('fighter') },
];
</script>

<template>
  <div class="page" data-page="assistant">
    <PageHeader title="助手" subtitle="打理预设和角色，调整大乱斗招式" fallback="/me">
      <template #right>
        <RouterLink :to="presetLink" class="icon-btn" aria-label="助手的预设"><span class="i-lucide-sliders-horizontal text-[19px]" /></RouterLink>
        <button type="button" class="icon-btn" aria-label="清空对话" :disabled="!store.messages.length" @click="clearChat"><span class="i-lucide-trash-2 text-[19px]" /></button>
      </template>
    </PageHeader>

    <div v-if="!status.live" class="notice mx-4">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ status.reason }}<template v-if="!fightersOnly">（一键检测不用 API）</template></span>
      <RouterLink to="/me/api" class="text-accent-ink shrink-0">去设置</RouterLink>
    </div>

    <div class="targets" data-testid="assistant-targets">
      <span class="t-label">要看的</span>
      <div class="t-list">
        <span v-for="r in targetRows" :key="`${r.target.kind}:${r.target.id}`" class="t-chip" :class="r.level ? LEVEL_TONE[r.level] : 'ok'">
          <RouterLink :to="linkOf(r.target)" class="t-name">{{ KIND_LABEL[r.target.kind] }} · {{ r.name }}</RouterLink>
          <button type="button" class="t-x" :aria-label="`不看${r.name}`" @click="store.toggleTarget(r.target)"><span class="i-lucide-x" /></button>
        </span>
        <button type="button" class="t-chip add press" data-testid="assistant-pick" @click="openPicker()"><span class="i-lucide-plus" />{{ targetRows.length ? '再选' : '选预设、世界书、角色卡' }}</button>
      </div>
    </div>

    <div ref="box" class="page-scroll px-4 pb-3 talk">
      <div v-if="!store.messages.length && !scan && replying === null" class="welcome">
        <span class="i-lucide-bot text-[26px] text-accent-ink" />
        <p v-if="fightersOnly">告诉助手你想怎么调整：血量、蓝量、战斗风格、被动，或某个技能的招式、伤害与冷却。助手会参考角色设定，给出能直接应用的战斗档案。</p>
        <p v-else>
          导入的预设、世界书、角色卡和这个 App 的格式（生图写法、输出格式的字段名、触发条件、程序填充块……）对不上时，助手帮你找出来、改成适配的——只改格式，不动原来写的字（除非你要它改）。也能帮你做角色卡、补全设定，一次改好几个也行。
        </p>
        <p class="text-ink-3">改之前先给你看改了哪儿，点"应用"才改，改错了能撤销。</p>
        <div class="ideas">
          <button v-for="i in IDEAS" :key="i.label" type="button" class="idea press" @click="i.run()"><span :class="i.icon" class="shrink-0" />{{ i.label }}</button>
        </div>
      </div>

      <template v-for="m in store.messages" :key="m.id">
        <div v-if="m.role === 'user'" class="bubble user">
          <div v-if="m.mode" class="mode-line">{{ MODE_LABEL[m.mode] }}</div>
          <div v-if="m.merge" class="t-line !mt-0 !mb-1">底子「{{ presetName(m.merge.base) }}」 + 功能来源「{{ presetName(m.merge.source) }}」</div>
          {{ m.text }}
          <div v-if="m.targets?.length" class="t-line">看：{{ m.targets.length }} 个对象</div>
        </div>
        <template v-else>
          <div v-if="m.error" class="bubble assistant error">
            <span class="i-lucide-circle-alert" /> 调用失败：{{ m.error }}
          </div>
          <div v-else-if="m.text" class="bubble assistant">{{ m.text }}</div>
          <AssistantEdits v-if="m.ops?.length || m.opErrors?.length" :message="m" />
        </template>
      </template>

      <div v-if="replying !== null" class="bubble assistant">
        <template v-if="replying">{{ replying }}</template>
        <span v-else class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
      </div>

      <section v-if="scan" class="scan" data-testid="assistant-scan">
        <div class="scan-head">
          <span class="i-lucide-scan-search shrink-0" />
          <span class="flex-1 min-w-0">一键检测 · {{ scan.onlyNew ? '新导入的' : '全部导入的' }} {{ scan.rows.length }} 个<span v-if="scan.rows.length" class="text-ink-3">，{{ scanProblems.length ? `${scanProblems.length} 个要改` : '都适配' }}</span></span>
          <button type="button" class="icon-btn !w-7 !h-7" aria-label="收起" @click="scan = null"><span class="i-lucide-x" /></button>
        </div>
        <p v-if="!scan.rows.length" class="text-[13px] text-ink-3 mt-1">还没有导入的预设、世界书、角色卡（"我的 → 导入 ST 文件"）。</p>
        <details v-for="r in scan.rows" :key="`${r.target.kind}:${r.target.id}`" class="s-row" :open="scan.rows.length <= 2 && !!r.issues.length">
          <summary>
            <span :class="[r.level ? FORMAT_LEVELS[r.level].icon : 'i-lucide-circle-check', r.level ? LEVEL_TONE[r.level] : 'ok']" class="s-icon" />
            <span class="flex-1 min-w-0">
              <span class="block truncate">{{ KIND_LABEL[r.target.kind] }} · {{ r.name }}</span>
              <span class="block text-[11.5px] text-ink-3 truncate">{{ r.sub }}</span>
            </span>
            <span class="s-count" :class="r.level ? LEVEL_TONE[r.level] : 'ok'">{{ countText(r) }}</span>
          </summary>
          <ul v-if="r.issues.length" class="s-issues">
            <li v-for="(i, k) in r.issues" :key="k" :class="LEVEL_TONE[i.level]">
              <span class="lv">{{ FORMAT_LEVELS[i.level].label }}</span>
              <span>{{ i.whereLabel && !i.message.includes(i.whereLabel) ? `${i.whereLabel}：` : '' }}{{ i.message }}</span>
            </li>
          </ul>
          <RouterLink :to="linkOf(r.target)" class="s-link">打开{{ KIND_LABEL[r.target.kind] }}<span class="i-lucide-chevron-right" /></RouterLink>
        </details>
        <button v-if="scanProblems.length" type="button" class="fix press" data-testid="assistant-fix-scan" @click="fixScan">
          <span class="i-lucide-wand-sparkles" />交给助手修这 {{ scanProblems.length }} 个（只改格式）
        </button>
      </section>
    </div>

    <div class="bottom">
      <div v-if="store.messages.length || scan" class="quick">
        <button v-if="!fightersOnly" type="button" class="q press" :disabled="replying !== null" @click="checkSelected"><span class="i-lucide-scan-search" />{{ targetRows.length ? '检测选中的' : '一键检测' }}</button>
        <button type="button" class="q press" :class="{ on: mode === 'card' }" :disabled="replying !== null" @click="mode === 'card' ? (mode = null) : startCard()"><span class="i-lucide-user-round-plus" />做角色卡</button>
        <button type="button" class="q press" :disabled="replying !== null" @click="fillCard"><span class="i-lucide-list-plus" />补全设定</button>
        <button type="button" class="q press" :disabled="replying !== null" data-testid="assistant-merge" @click="startMerge"><span class="i-lucide-combine" />融合预设</button>
      </div>
      <div v-if="mode" class="mode-tag">
        <span class="i-lucide-sparkles" />这次：{{ MODE_LABEL[mode] }}
        <button type="button" aria-label="不用了" @click="mode = null"><span class="i-lucide-x" /></button>
      </div>
      <div class="composer">
        <textarea ref="input" v-model="said" class="area" rows="2" :placeholder="placeholder" aria-label="和助手说的话" @keydown.enter.exact.prevent="send()" />
        <button v-if="replying !== null" type="button" class="send stop" aria-label="停下" @click="stop"><span class="i-lucide-square" /></button>
        <button v-else type="button" class="send" aria-label="发送" data-testid="assistant-send" :disabled="!said.trim() && !mode" @click="send()"><span class="i-lucide-arrow-up" /></button>
      </div>
    </div>

    <van-popup v-model:show="mergeOpen" position="bottom" round teleport="body" :style="{ height: '82%' }">
      <div class="picker" data-testid="merge-sheet">
        <div class="p-head">
          <span class="font-600 shrink-0">预设融合</span>
          <span class="text-[12px] text-ink-3 min-w-0 truncate">照底子新建一个预设，把功能来源里的功能缝进去</span>
        </div>
        <div class="m-slots">
          <button v-for="sl in MERGE_SLOTS" :key="sl.value" type="button" class="m-slot press" :class="{ on: mergeSlot === sl.value }" :data-slot="sl.value" @click="mergeSlot = sl.value">
            <span class="text-[11.5px] text-ink-3">{{ sl.label }}</span>
            <span class="block truncate text-[14px] font-600">{{ presetName(merging[sl.value]) || '点这里，再在下面选' }}</span>
            <span v-if="merging[sl.value]" class="block truncate text-[11px] text-ink-3">{{ PRESET_CATEGORIES[lib.presetById(merging[sl.value])?.category ?? 'chat'].label }}预设</span>
          </button>
          <button type="button" class="icon-btn self-center" aria-label="底子和功能来源对调" :disabled="!merging.base && !merging.source" @click="swapMerge"><span class="i-lucide-arrow-left-right" /></button>
        </div>
        <p class="text-[12px] text-ink-3 mt-2 mb-0 leading-relaxed">
          {{ mergeSlot === 'base' ? '底子：新预设照它复制，文风、规矩、程序块都按它。' : '功能来源：助手从里面找出功能（状态栏、生图、选项、某个玩法的规则和输出格式……）和配套的正则，复制进新预设。' }}
          两个原来的预设都不改。想只要某几个功能，在下面输入框里写上再点"开始融合"。
        </p>
        <div class="p-list">
          <PresetChooser :model-value="merging[mergeSlot]" @update:model-value="pickMerge" />
        </div>
        <div class="p-foot">
          <span class="flex-1 text-[12px] text-ink-3 truncate">{{ said.trim() ? `要求：${said.trim()}` : '' }}</span>
          <button type="button" class="q press" @click="mergeOpen = false">取消</button>
          <button type="button" class="done press" :disabled="!merging.base || !merging.source || replying !== null" data-testid="merge-run" @click="runMerge">开始融合</button>
        </div>
      </div>
    </van-popup>

    <van-popup v-model:show="pickerOpen" position="bottom" round teleport="body" :style="{ height: '78%' }">
      <div class="picker">
        <div class="p-head">
          <span class="font-600">选要看的</span>
          <span class="text-[12px] text-ink-3">选了 {{ store.targets.length }} 个</span>
          <span class="flex-1" />
          <label v-if="pickTab !== 'fighter'" class="p-only"><van-switch v-model="onlyImported" size="18px" />只看导入的</label>
        </div>
        <Segmented v-model="pickTab" :options="PICK_TABS" />
        <div class="p-list">
          <p v-if="!pickRows.length" class="text-[13px] text-ink-3 text-center py-6"><template v-if="pickTab === 'fighter'">先去<RouterLink to="/scene/game?g=brawl" class="text-accent-ink">大乱斗</RouterLink>，角色的战斗档案会出现在这里。</template><template v-else>{{ onlyImported ? '没有导入的，关掉"只看导入的"能选自带的' : '一个都没有' }}</template></p>
          <button v-for="r in pickRows" :key="r.target.id" type="button" class="p-row press" :class="{ on: store.hasTarget(r.target) }" @click="store.toggleTarget(r.target)">
            <span :class="store.hasTarget(r.target) ? 'i-lucide-square-check-big text-accent-ink' : 'i-lucide-square text-ink-3'" class="text-[18px] shrink-0" />
            <span class="flex-1 min-w-0 text-left">
              <span class="block truncate text-[14px]">{{ r.name }}<span v-if="!r.imported" class="seed">自带</span></span>
              <span class="block truncate text-[11.5px] text-ink-3">{{ r.sub }}</span>
            </span>
            <span v-if="r.target.kind !== 'fighter'" class="s-count shrink-0" :class="r.level ? LEVEL_TONE[r.level] : 'ok'">{{ countText(r) }}</span>
          </button>
        </div>
        <div class="p-foot">
          <button v-if="pickTab !== 'fighter'" type="button" class="q press" @click="pickProblems"><span class="i-lucide-triangle-alert" />选上有问题的</button>
          <button type="button" class="q press" :disabled="!store.targets.length" @click="store.setTargets([])">全不选</button>
          <span class="flex-1" />
          <button type="button" class="done press" @click="pickerOpen = false">好了</button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.targets {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 16px 6px;
}
.t-label {
  flex-shrink: 0;
  padding-top: 5px;
  font-size: 12px;
  color: var(--ink-3);
}
.t-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  max-height: 76px;
  overflow-y: auto;
}
.t-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  max-width: 100%;
  height: 28px;
  padding: 0 4px 0 10px;
  border-radius: 999px;
  background: var(--panel);
  border: 1px solid var(--border);
  font-size: 12.5px;
}
.t-chip.bad {
  border-color: color-mix(in srgb, var(--bad) 55%, transparent);
}
.t-chip.warn {
  border-color: color-mix(in srgb, var(--warn) 55%, transparent);
}
.t-chip.add {
  padding: 0 10px;
  gap: 4px;
  color: var(--accent-ink);
  border-style: dashed;
}
.t-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: inherit;
  text-decoration: none;
}
.t-x {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  color: var(--ink-3);
}
.talk {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-top: 6px;
}
.welcome {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 18px 4px;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink-2);
  text-align: center;
}
.ideas {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  width: 100%;
  margin-top: 6px;
}
.idea {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--ink);
  font-size: 13px;
  text-align: left;
  line-height: 1.4;
}
.bubble {
  max-width: 88%;
  padding: 8px 12px;
  border-radius: 16px;
  font-size: 14px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.bubble.user {
  align-self: flex-end;
  background: var(--accent-soft);
  color: var(--ink);
  border-bottom-right-radius: 6px;
}
.bubble.assistant {
  align-self: flex-start;
  background: var(--panel);
  border: 1px solid var(--border);
  border-bottom-left-radius: 6px;
}
.bubble.error {
  color: var(--bad);
  font-size: 13px;
}
.mode-line,
.t-line {
  font-size: 11.5px;
  color: var(--accent-ink);
}
.t-line {
  color: var(--ink-3);
  margin-top: 2px;
}
.scan {
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.scan-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
  font-weight: 600;
}
.s-row {
  margin-top: 6px;
  border-radius: 12px;
  background: var(--panel);
}
.s-row summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  list-style: none;
  cursor: pointer;
  font-size: 13.5px;
}
.s-row summary::-webkit-details-marker {
  display: none;
}
.s-icon {
  flex-shrink: 0;
  font-size: 17px;
}
.bad {
  color: var(--bad);
}
.warn {
  color: var(--warn);
}
.info {
  color: var(--accent-ink);
}
.ok {
  color: var(--good);
}
.t-chip.bad,
.t-chip.warn,
.t-chip.info,
.t-chip.ok {
  color: var(--ink);
}
.s-count {
  flex-shrink: 0;
  font-size: 11.5px;
}
.s-issues {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0 10px 6px;
  list-style: none;
  font-size: 12.5px;
  line-height: 1.55;
}
.s-issues li {
  display: flex;
  gap: 6px;
}
.s-issues li > span:last-child {
  color: var(--ink-2);
}
.lv {
  flex-shrink: 0;
  font-size: 11px;
  padding-top: 1px;
}
.s-link {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 10px 8px;
  font-size: 12px;
  color: var(--accent-ink);
  text-decoration: none;
}
.fix {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 40px;
  margin-top: 10px;
  border-radius: 12px;
  background: var(--accent);
  color: #fff;
  font-size: 13.5px;
}
.bottom {
  padding: 6px 16px calc(10px + env(safe-area-inset-bottom));
  border-top: 1px solid var(--border);
  background: var(--bg);
}
.quick {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  padding-bottom: 6px;
}
.q {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 999px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.q.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.q:disabled {
  opacity: 0.45;
}
.mode-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 6px;
  padding: 2px 4px 2px 10px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 12px;
}
.mode-tag button {
  display: inline-flex;
  padding: 2px;
}
.composer {
  display: flex;
  align-items: flex-end;
  gap: 8px;
}
.area {
  flex: 1;
  min-width: 0;
  padding: 9px 12px;
  border-radius: 14px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
  font-size: 14px;
  line-height: 1.55;
  resize: none;
}
.send {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  font-size: 18px;
}
.send:disabled {
  opacity: 0.4;
}
.send.stop {
  background: var(--panel);
  color: var(--ink);
}
.picker {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 12px 16px calc(10px + env(safe-area-inset-bottom));
}
.p-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.p-only {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.p-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: grid;
  align-content: start;
  gap: 6px;
  margin-top: 8px;
}
.p-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 10px;
  border-radius: 12px;
  background: var(--panel);
  border: 1px solid transparent;
}
.p-row.on {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
}
.seed {
  margin-left: 6px;
  padding: 0 5px;
  border-radius: 6px;
  background: var(--surface);
  color: var(--ink-3);
  font-size: 10.5px;
}
.p-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  padding-top: 8px;
}
.m-slots {
  display: flex;
  gap: 8px;
}
.m-slot {
  flex: 1;
  min-width: 0;
  padding: 8px 12px;
  border-radius: 14px;
  background: var(--panel);
  border: 1.5px solid transparent;
  text-align: left;
}
.m-slot.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.done:disabled {
  opacity: 0.45;
}
.done {
  height: 34px;
  padding: 0 18px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 13.5px;
}
</style>
