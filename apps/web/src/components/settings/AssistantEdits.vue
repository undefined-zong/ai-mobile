<script setup lang="ts">
import type { EditChange } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed } from 'vue';
import { applyPlan, KIND_LABEL, linkOf, planOps, undoApply } from '@/services/assistant';
import { useAssistantStore, type AssistantMessage } from '@/stores/assistant';

/**
 * 助手给的修改：按对象分组，每项写改了什么、改之前 / 改之后（只显示变了的那一段）；
 * 动了原文（不只是标签、字段名、开关这些格式）的标"改了文字"。点"应用"按对象现在的样子重算一遍再写进去，应用后能撤销。
 */
const props = defineProps<{ message: AssistantMessage }>();
const store = useAssistantStore();

const applied = computed(() => props.message.applied ?? null);
// 没应用的按对象现在的样子算；应用过的用当时记下的
const plan = computed(() => (applied.value || !props.message.ops?.length ? null : planOps(props.message.ops)));
const changes = computed<EditChange[]>(() => applied.value?.changes ?? plan.value?.changes ?? []);
const errors = computed(() => [...(props.message.opErrors ?? []), ...(applied.value ? applied.value.errors : (plan.value?.errors ?? []))]);
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

async function apply() {
  const m = props.message;
  if (!m.ops?.length || m.applied) return;
  const p = planOps(m.ops);
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
        {{ applied ? `已应用 ${changes.length} 项修改` : `${changes.length} 项修改，点"应用"才会改` }}
        <span v-if="textChanges" class="warn-text">（{{ textChanges }} 项改了文字）</span>
      </span>
    </div>
    <div v-for="g in groups" :key="g.key" class="group">
      <RouterLink v-if="applied" :to="linkOf({ kind: g.kind, id: g.id })" class="g-title press">
        <span class="truncate">{{ KIND_LABEL[g.kind] }} · {{ g.title }}</span><span class="i-lucide-chevron-right shrink-0" />
      </RouterLink>
      <div v-else class="g-title">
        <span class="truncate">{{ KIND_LABEL[g.kind] }} · {{ g.title }}</span>
      </div>
      <details v-for="(c, i) in g.items" :key="i" class="change" :open="changes.length <= 3 && !applied">
        <summary>
          <span class="flex-1 min-w-0">{{ c.label }}</span>
          <span v-if="c.textChanged" class="badge">改了文字</span>
        </summary>
        <div v-if="c.before" class="diff del">{{ c.before }}</div>
        <div v-if="c.after" class="diff ins">{{ c.after }}</div>
        <div v-if="!c.before && !c.after" class="text-[12px] text-ink-3 px-1 pb-1">只改了设置，没有文字</div>
      </details>
    </div>
    <div v-if="errors.length" class="errs">
      <div v-for="(e, i) in errors" :key="i" class="err"><span class="i-lucide-circle-alert shrink-0 mt-[3px]" /><span>{{ e }}</span></div>
    </div>
    <div class="actions">
      <template v-if="applied">
        <button v-if="applied.undo" type="button" class="btn ghost press" @click="undo"><span class="i-lucide-undo-2" />撤销</button>
        <span v-else class="text-[12px] text-ink-3">应用得太早了，不能撤销</span>
      </template>
      <button v-else type="button" class="btn primary press" :disabled="!changes.length" data-testid="assistant-apply" @click="apply"><span class="i-lucide-check" />应用</button>
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
.change {
  margin-top: 4px;
  border-radius: 10px;
  background: var(--panel);
}
.change summary {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  line-height: 1.5;
  cursor: pointer;
  list-style: none;
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
  height: 32px;
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
