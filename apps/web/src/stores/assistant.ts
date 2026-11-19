import type { AssistantOp, BrawlFighter, Character, EditChange, EditKind, Lorebook, Preset } from '@app/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { uid } from '@/utils/id';

/**
 * "我的 → 助手"的存档：和助手的对话、选着的对象、上次一键检测的时间、应用过的修改（改之前的样子，能撤销）。
 * 存在本机（settings 表的 assistant）。
 */
export interface AssistantTarget {
  kind: EditKind;
  id: string;
}

/** 应用修改前的样子：撤销时放回去；这次新建的撤销时删掉 */
export interface AssistantUndo {
  fighters?: BrawlFighter[];
  presets: Preset[];
  lorebooks: Lorebook[];
  characters: Character[];
  created: { kind: 'lorebook' | 'character' | 'preset'; id: string }[];
}

export type AssistantMode = 'check' | 'card' | 'merge';

/** 预设融合：拿哪个预设当底子，从哪个预设里找要缝进去的功能（预设 id） */
export interface AssistantMerge {
  base: string;
  source: string;
}

export interface AssistantMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: number;
  /** 这一次做的事：一键检测 check、做角色卡 / 补全设定 card、预设融合 merge；平时聊天为空 */
  mode?: AssistantMode;
  /** 预设融合时选的两个预设 */
  merge?: AssistantMerge;
  /** 发这一条时选着的对象 */
  targets?: AssistantTarget[];
  /** 助手给的修改（原样存，预览、应用时按对象现在的样子重算） */
  ops?: AssistantOp[];
  /** <edits> 里读不出来的 */
  opErrors?: string[];
  /** 应用过：什么时候、改了什么、改之前的样子（太早的不留，不能撤销）、应用时没做成的项 */
  applied?: { at: number; changes: EditChange[]; undo: AssistantUndo | null; errors: string[] } | null;
  /** 调用失败时的报错（只给人看，不发给助手） */
  error?: string;
}

interface Saved {
  messages: AssistantMessage[];
  targets: AssistantTarget[];
  lastScanAt: number;
}

const KEY = 'assistant';
/** 对话最多留多少条 */
const KEEP = 80;
/** 最近几次应用的能撤销（改之前的样子是整份预设、世界书，留太多占地方） */
export const UNDO_KEEP = 5;

const KINDS = new Set<EditKind>(['preset', 'lorebook', 'character', 'fighter']);
const isTarget = (t: unknown): t is AssistantTarget =>
  !!t && typeof t === 'object' && KINDS.has((t as AssistantTarget).kind) && typeof (t as AssistantTarget).id === 'string';

const isOp = (o: unknown): o is AssistantOp =>
  !!o && typeof o === 'object' && KINDS.has((o as AssistantOp).kind) && typeof (o as AssistantOp).id === 'string' && typeof (o as AssistantOp).op === 'string' && !!(o as AssistantOp).raw;

export const useAssistantStore = defineStore('assistant', () => {
  const messages = ref<AssistantMessage[]>([]);
  const targets = ref<AssistantTarget[]>([]);
  /** 上次一键检测的时间：之后导入的算"新导入的" */
  const lastScanAt = ref(0);
  const saver = autoSave(
    'settings',
    () => [{ key: KEY, value: { messages: messages.value.slice(-KEEP), targets: targets.value, lastScanAt: lastScanAt.value } satisfies Saved }],
    () => [messages.value, targets.value, lastScanAt.value],
    // 别的设备上和助手的对话（同步）：放进来
    { wait: 800, apply: ([c]) => { if (c && !c.deleted) load(c.value as Partial<Saved>); } },
  );

  function load(saved: Partial<Saved> | null | undefined) {
    messages.value = (Array.isArray(saved?.messages) ? saved.messages : [])
      .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string')
      .map((m) => (m.ops ? { ...m, ops: m.ops.filter(isOp) } : m));
    targets.value = (Array.isArray(saved?.targets) ? saved.targets : []).filter(isTarget);
    lastScanAt.value = typeof saved?.lastScanAt === 'number' ? saved.lastScanAt : 0;
  }

  async function hydrate() {
    load(await getOne<Partial<Saved>>('settings', KEY));
    saver.start();
  }

  function add(m: Omit<AssistantMessage, 'id' | 'at'>): AssistantMessage {
    messages.value.push({ ...m, id: uid('am'), at: Date.now() });
    if (messages.value.length > KEEP) messages.value.splice(0, messages.value.length - KEEP);
    return messages.value.at(-1) as AssistantMessage;
  }

  function byId(id: string): AssistantMessage | undefined {
    return messages.value.find((m) => m.id === id);
  }

  /** 旧回复没存融合对象时，沿用它前一条用户消息里的选择。 */
  function mergeOf(message: AssistantMessage): AssistantMerge | undefined {
    return message.merge ?? messages.value
      .slice(0, messages.value.findIndex((m) => m.id === message.id))
      .reverse().find((m) => m.role === 'user')?.merge;
  }

  /** 记下应用过；更早的应用只留"应用过"，不留改之前的样子 */
  function markApplied(id: string, changes: EditChange[], undo: AssistantUndo, errors: string[]) {
    const m = byId(id);
    if (!m) return;
    m.applied = { at: Date.now(), changes, undo, errors };
    const withUndo = messages.value.filter((x) => x.applied?.undo).sort((a, b) => (b.applied?.at ?? 0) - (a.applied?.at ?? 0));
    for (const old of withUndo.slice(UNDO_KEEP)) if (old.applied) old.applied.undo = null;
  }

  function markUndone(id: string) {
    const m = byId(id);
    if (m) m.applied = null;
  }

  function hasTarget(t: AssistantTarget): boolean {
    return targets.value.some((x) => x.kind === t.kind && x.id === t.id);
  }

  function toggleTarget(t: AssistantTarget) {
    if (hasTarget(t)) targets.value = targets.value.filter((x) => !(x.kind === t.kind && x.id === t.id));
    else targets.value.push({ kind: t.kind, id: t.id });
  }

  function setTargets(list: AssistantTarget[]) {
    targets.value = list.map((t) => ({ kind: t.kind, id: t.id }));
  }

  function clear() {
    messages.value = [];
  }

  return { messages, targets, lastScanAt, hydrate, add, byId, mergeOf, markApplied, markUndone, hasTarget, toggleTarget, setTargets, clear };
});
