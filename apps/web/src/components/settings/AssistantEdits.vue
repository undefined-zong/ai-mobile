<script setup lang="ts">
import { toggleEditSelection, type EditChange } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, ref } from 'vue';
import { applyPlan, KIND_LABEL, linkOf, planOps, undoApply } from '@/services/assistant';
import { useAssistantStore, type AssistantMessage } from '@/stores/assistant';

/**
 * 助手给的修改：按对象分组，每项写改了什么、改之前 / 改之后（只显示变了的那一段）；
 * 每项可以单独选择，动了原文的标"改了文字"。应用所选时按对象现在的样子重算，应用后能撤销。
 */
const props = defineProps<{ message: AssistantMessage }>();
const store = useAssistantStore();

const applied = computed(() => props.message.applied ?? null);
const merge = computed(() => store.mergeOf(props.message));
// 没应用的按对象现在的样子算；应用过的用当时记下的
const plan = computed(() => (applied.value || !props.message.ops?.length ? null : planOps(props.message.ops, undefined, merge.value)));
const picked = ref<Set<string> | null>(null);
const keys = computed(() => (plan.value?.changes ?? []).map((c) => c.key!));
const selected = computed(() => new Set(keys.value.filter((key) => picked.value === null || picked.value.has(key))));
const allSelected = computed(() => !!keys.value.length && selected.value.size === keys.value.length);
const selectedPlan = computed(() => plan.value ? planOps(props.message.ops!, selected.value, merge.value) : null);
const changes = computed<EditChange[]>(() => {
  if (applied.value) return applied.value.changes;
  const previews = new Map(selectedPlan.value?.changes.map((c) => [c.key, c]));
  // 取消相邻的复制项后，所选项的位置、文字预览也跟着重新计算；分组仍用完整计划里的 id。
  return (plan.value?.changes ?? []).map((c) => ({ ...(previews.get(c.key) ?? c), id: c.id }));
});
const errors = computed(() => [...new Set([
  ...(props.message.opErrors ?? []),
  ...(applied.value ? applied.value.errors : [...(plan.value?.errors ?? []), ...(selectedPlan.value?.errors ?? [])]),
])]);
const hasDependencies = computed(() => plan.value?.changes.some((c) => c.requires?.length));
const textChanges = computed(() => changes.value.filter((c) => c.textChanged).length);
const groups = computed(() => {
  const out: { key: string; kind: EditChange['kind']; id: string; title: string; items: EditChange[] }[] = [];
  for (const c of changes.value) {
    const key = `${c.kind}:${c.id}`;
    let g = out.find((x) => x.key === key);
    if (!g) out.push((g = { key, kind: c.kind, id: c.id, title: c.title, items: [] }));
    g.items.push(c);
  }
  return out;
});

function toggle(key: string, on: boolean) {
  picked.value = toggleEditSelection(plan.value!.changes, selected.value, key, on);
}

function toggleAll() {
  picked.value = new Set(allSelected.value ? [] : keys.value);
}

async function apply() {
  const m = props.message;
  if (!m.ops?.length || m.applied) return;
  const p = planOps(m.ops, selected.value, merge.value);
  if (!p.changes.length) return showToast('没有能做成的修改');
  const texts = p.changes.filter((c) => c.textChanged).length;
  if (texts) {
    try {
      await showConfirmDialog({
        title: `有 ${texts} 项改了文字`,
        message: '标着"改了文字"的不只是改格式，还动了原来写的字（展开能看改之前 / 改之后）。照样应用吗？',
        confirmButtonText: '应用',
      });
    } catch {
      return;
    }
  }
  const undo = applyPlan(p);
  store.markApplied(m.id, p.changes, undo, p.errors);
  showToast(p.errors.length ? `应用了 ${p.changes.length} 项，${p.errors.length} 项没做成` : `应用了 ${p.changes.length} 项`);
}

async function undo() {
  const a = props.message.applied;
  if (!a?.undo) return;
  try {
    await showConfirmDialog({
      title: '撤销这次修改',
      message: '把这些对象放回应用之前的样子（应用之后又改过的地方也会回去），这次新建的预设、角色、世界书会删掉。',
      confirmButtonText: '撤销',
    });
  } catch {
    return;
  }
  undoApply(a.undo);
  store.markUndone(props.message.id);
  showToast('撤销了');
}
</script>

<template>
  <div v-if="changes.length || errors.length" class="edits" :class="{ done: !!applied }" data-testid="assistant-edits">
    <div class="head">
      <span :class="applied ? 'i-lucide-circle-check' : 'i-lucide-file-pen-line'" class="shrink-0" />
      <span class="flex-1 min-w-0">
        {{ applied ? `已应用 ${changes.length} 项修改` : `${changes.length} 项修改，选择要应用的项` }}
        <span v-if="textChanges" class="warn-text">（{{ textChanges }} 项改了文字）</span>
      </span>
    </div>
    <div v-if="!applied && changes.length" class="selection-bar">
      <label class="select-all">
        <input type="checkbox" :checked="allSelected" :indeterminate="selected.size > 0 && !allSelected" @change="toggleAll" />
        全选
      </label>
      <span aria-live="polite">已选 {{ selected.size }} / {{ keys.length }} 项</span>
    </div>
    <p v-if="!applied && hasDependencies" class="selection-hint">选择后续修改时，会同时选中它需要的新建或复制项。</p>
    <div v-for="g in groups" :key="g.key" class="group">
      <RouterLink v-if="applied" :to="linkOf({ kind: g.kind, id: g.id })" class="g-title press">
        <span class="truncate">{{ KIND_LABEL[g.kind] }} · {{ g.title }}</span><span class="i-lucide-chevron-right shrink-0" />
      </RouterLink>
      <div v-else class="g-title">
        <span class="truncate">{{ KIND_LABEL[g.kind] }} · {{ g.title }}</span>
      </div>
      <div v-for="(c, i) in g.items" :key="c.key ?? i" class="change-row" :class="{ 'not-selected': !applied && !selected.has(c.key!) }">
        <label v-if="!applied" class="pick">
          <input type="checkbox" :checked="selected.has(c.key!)" :aria-label="`应用：${c.label}`" @change="toggle(c.key!, ($event.target as HTMLInputElement).checked)" />
        </label>
        <details class="change" :open="changes.length <= 3 && !applied">
          <summary>
            <span class="flex-1 min-w-0">{{ c.label }}</span>
            <span v-if="c.textChanged" class="badge">改了文字</span>
            <span class="i-lucide-chevron-down chevron shrink-0" aria-hidden="true" />
          </summary>
          <div v-if="c.before" class="diff del">{{ c.before }}</div>
          <div v-if="c.after" class="diff ins">{{ c.after }}</div>
          <div v-if="!c.before && !c.after" class="text-[12px] text-ink-3 px-1 pb-1">只改了设置，没有文字</div>
        </details>
      </div>
    </div>
    <div v-if="errors.length" class="errs">
      <div v-for="(e, i) in errors" :key="i" class="err"><span class="i-lucide-circle-alert shrink-0 mt-[3px]" /><span>{{ e }}</span></div>
    </div>
    <div class="actions">
      <template v-if="applied">
        <button v-if="applied.undo" type="button" class="btn ghost press" @click="undo"><span class="i-lucide-undo-2" />撤销</button>
        <span v-else class="text-[12px] text-ink-3">应用得太早了，不能撤销</span>
      </template>
      <button v-else type="button" class="btn primary press" :disabled="!selectedPlan?.changes.length" data-testid="assistant-apply" @click="apply"><span class="i-lucide-check" />应用所选（{{ selectedPlan?.changes.length ?? 0 }}）</button>
    </div>
  </div>
</template>

<style scoped>
.edits {
  align-self: stretch;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  font-size: 13px;
}
.edits.done {
  opacity: 0.85;
}
.head {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-weight: 600;
  line-height: 1.5;
}
.warn-text {
  color: var(--warn);
  font-weight: 500;
}
.selection-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  color: var(--ink-2);
}
.select-all,
.pick {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  cursor: pointer;
}
.select-all {
  gap: 8px;
}
input[type='checkbox'] {
  width: 18px;
  height: 18px;
  margin: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.selection-hint {
  margin: 0 0 8px;
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.5;
}
.group {
  margin-top: 8px;
}
.g-title {
  display: flex;
  align-items: center;
  gap: 2px;
  color: var(--accent-ink);
  font-size: 12.5px;
  text-decoration: none;
}
.change-row {
  display: flex;
  align-items: flex-start;
  margin-top: 4px;
}
.pick {
  flex: 0 0 44px;
}
.change {
  flex: 1;
  min-width: 0;
  border-radius: 10px;
  background: var(--panel);
}
.change summary {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-height: 44px;
  padding: 12px 8px;
  line-height: 1.5;
  cursor: pointer;
  list-style: none;
}
.not-selected .change {
  background: transparent;
}
.chevron {
  margin-top: 3px;
}
.change[open] .chevron {
  transform: rotate(180deg);
}
.change summary:focus-visible,
input[type='checkbox']:focus-visible,
.btn:focus-visible {
  outline: 2px solid var(--accent-ink);
  outline-offset: 2px;
}
.change summary::-webkit-details-marker {
  display: none;
}
.badge {
  flex-shrink: 0;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--warn) 22%, transparent);
  color: var(--warn);
  font-size: 11px;
  line-height: 18px;
}
.diff {
  margin: 0 6px 6px;
  padding: 6px 8px;
  border-radius: 8px;
  max-height: 220px;
  overflow-y: auto;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.diff.del {
  background: color-mix(in srgb, var(--bad) 12%, transparent);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--bad) 60%, transparent);
}
.diff.ins {
  background: color-mix(in srgb, var(--good) 14%, transparent);
}
.errs {
  margin-top: 8px;
  display: grid;
  gap: 4px;
}
.err {
  display: flex;
  gap: 6px;
  color: var(--bad);
  font-size: 12px;
  line-height: 1.5;
}
.actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  margin-top: 10px;
}
.btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-height: 44px;
  padding: 0 14px;
  border-radius: 999px;
  font-size: 13px;
}
.btn.primary {
  background: var(--accent);
  color: #fff;
}
.btn.primary:disabled {
  opacity: 0.4;
}
.btn.ghost {
  background: var(--panel);
  color: var(--ink);
}
</style>
