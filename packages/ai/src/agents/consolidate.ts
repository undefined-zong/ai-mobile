import { assembleTaskPrompt, type MemoryConsolidationContext, type MemoryOp, type MemoryType, type ProfileOp, textFn, type TextFn } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { AgentSystem } from './system.ts';
import { dayLabel, lineTime } from './summary.ts';
import { samplerRequest, type TaskPreset } from './taskPreset.ts';

/**
 * 记忆整理智能体（"记忆整理"的 API 和"整理"预设）：每天凌晨 4 点在 Cloudflare 上跑，也能在记忆本里"立即整理"。
 * 四件事各一次调用，预设里按任务类型（块的触发条件）只发这次的那几块：
 * - merge：合并重复的记忆（手机按向量算出的可能重复的组）；
 * - rollup：时间线同层满 4 段，合并成上一层的一段；
 * - tense：过期的待跟进改时态（"要去面试" → "11/12 去面试了，结果还不知道"）；
 * - profile：按新记忆逐行修改画像卡（增加、修改、删除某一行），不整张重写。
 * 手机和 Worker 共用这里的拼装和解析。
 */

export type ConsolidateTask = 'merge' | 'rollup' | 'tense' | 'profile';

export interface ConsolidateContext {
  character: { name: string; pronoun: string };
  user: { name: string };
  now: Date;
  timeZone?: string;
}

export interface MergeGroup {
  /** 组号："g1" */
  group: string;
  items: { id: string; type: MemoryType; content: string; at: number | null; importance: number }[];
}

export interface RollupSegment {
  text: string;
  fromAt: number;
  toAt: number;
}

export interface TenseItem {
  id: string;
  content: string;
  dueAt: number;
}

export interface ProfileInputLine {
  id: string;
  section: string;
  text: string;
}

export type ConsolidateInput =
  | { task: 'merge'; groups: MergeGroup[] }
  | { task: 'rollup'; segments: RollupSegment[] }
  | { task: 'tense'; items: TenseItem[] }
  | { task: 'profile'; lines: ProfileInputLine[]; memories: { content: string; type: MemoryType; at: number | null }[] };

export function consolidateFills(ctx: ConsolidateContext, input: ConsolidateInput, t: TextFn): Record<string, string> {
  const tz = ctx.timeZone;
  const now = ctx.now.getTime();
  const day = (at: number | null) => (at ? dayLabel(at, tz) : t('consolidate.noDate'));
  let body = '';
  switch (input.task) {
    case 'merge':
      body = t('consolidate.merge', {
        groups: input.groups.map((g) => t('consolidate.merge.group', {
          group: g.group,
          items: g.items.map((m) => t('consolidate.merge.item', { id: m.id, day: day(m.at), type: m.type, importance: m.importance, content: m.content })),
        })),
      });
      break;
    case 'rollup':
      body = t('consolidate.rollup', { n: input.segments.length, items: input.segments.map((s, i) => t('consolidate.rollup.item', { n: i + 1, from: day(s.fromAt), to: day(s.toAt), text: s.text })) });
      break;
    case 'tense':
      body = t('consolidate.tense', { items: input.items.map((m) => t('consolidate.tense.item', { id: m.id, due: lineTime(m.dueAt, tz), content: m.content })) });
      break;
    case 'profile':
      body = t('consolidate.profile', {
        lines: input.lines.map((l) => t('consolidate.profile.line', { id: l.id, section: l.section, text: l.text })),
        memories: input.memories.map((m) => t('consolidate.profile.memory', { day: day(m.at), type: m.type, content: m.content })),
      });
      break;
  }
  return {
    consolidateNow: t('summary.now', { day: dayLabel(now, tz), time: lineTime(now, tz).slice(6), timeZone: tz }),
    consolidateInput: body,
  };
}

/** 按"整理"预设拼提示词：块的触发条件写任务类型，只发这次的那几块 */
export function buildConsolidateMessages(ctx: ConsolidateContext, input: ConsolidateInput, preset: TaskPreset): ChatMessage[] {
  return assembleTaskPrompt({ preset, fills: consolidateFills(ctx, input, textFn(preset.texts)), macros: { char: ctx.character.name, pronoun: ctx.character.pronoun, user: ctx.user.name, now: ctx.now }, type: input.task }).messages;
}

const TYPES = new Set<MemoryType>(['fact', 'preference', 'event', 'promise', 'followup', 'emotion', 'relationship']);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export interface MergeDecision {
  /** 合并成一条的记忆 id（至少两条，都在同一组里） */
  ids: string[];
  content: string;
  type: MemoryType | null;
  importance: number | null;
}

/** {"merges": [{"ids": [...], "content": "...", "type": "...", "importance": 7}]}；组里没写进去的保持原样 */
export function parseMerge(value: unknown, groups: MergeGroup[]): MergeDecision[] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>).merges;
  if (!Array.isArray(raw)) return null;
  const groupOf = new Map<string, string>();
  for (const g of groups) for (const m of g.items) groupOf.set(m.id, g.group);
  const used = new Set<string>();
  const out: MergeDecision[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const ids = (Array.isArray(o.ids) ? o.ids : []).filter((id): id is string => typeof id === 'string' && groupOf.has(id) && !used.has(id));
    const content = str(o.content);
    if (ids.length < 2 || !content || new Set(ids.map((id) => groupOf.get(id))).size !== 1) continue;
    ids.forEach((id) => used.add(id));
    const type = TYPES.has(o.type as MemoryType) ? (o.type as MemoryType) : null;
    const imp = Math.round(Number(o.importance));
    out.push({ ids, content, type, importance: Number.isFinite(imp) ? Math.min(10, Math.max(1, imp)) : null });
  }
  return out;
}

/** {"text": "..."} */
export function parseRollup(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const text = str((value as Record<string, unknown>).text);
  return text || null;
}

export interface TenseUpdate {
  id: string;
  content: string;
  /** 事情过去了改成 event；还值得再问一次就留 followup，带新的到期时间 */
  type: 'event' | 'followup';
  dueAt: number | null;
}

/** {"updates": [{"id": "...", "content": "...", "type": "event|followup", "dueAt": "ISO 或 null"}]} */
export function parseTense(value: unknown, ids: Set<string>): TenseUpdate[] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>).updates;
  if (!Array.isArray(raw)) return null;
  const out: TenseUpdate[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    const id = str(o.id);
    const content = str(o.content);
    if (!ids.has(id) || !content) continue;
    const due = typeof o.dueAt === 'string' ? Date.parse(o.dueAt) : NaN;
    const type = o.type === 'followup' && Number.isFinite(due) ? 'followup' : 'event';
    out.push({ id, content, type, dueAt: type === 'followup' ? due : null });
  }
  return out;
}

export type { ProfileOp };

/** {"ops": [{"op": "add", "section": "...", "text": "..."}, {"op": "edit", "id": "...", "text": "..."}, {"op": "remove", "id": "..."}]} */
export function parseProfileOps(value: unknown, lineIds: Set<string>): ProfileOp[] | null {
  if (!value || typeof value !== 'object') return null;
  const raw = (value as Record<string, unknown>).ops;
  if (!Array.isArray(raw)) return null;
  const out: ProfileOp[] = [];
  for (const r of raw) {
    const o = (r ?? {}) as Record<string, unknown>;
    if (o.op === 'add' && str(o.text)) out.push({ op: 'add', section: str(o.section) || '其他', text: str(o.text) });
    else if (o.op === 'edit' && lineIds.has(str(o.id)) && str(o.text)) out.push({ op: 'edit', id: str(o.id), text: str(o.text), ...(str(o.section) ? { section: str(o.section) } : {}) });
    else if (o.op === 'remove' && lineIds.has(str(o.id))) out.push({ op: 'remove', id: str(o.id) });
  }
  return out;
}

/** 一晚最多合并几组时间线（多出来的下次接着合并） */
const MAX_ROLLUPS = 4;

/**
 * 跑一次整理：四件事各一次调用（没有要做的跳过），某一件失败不影响别的，失败写进 errors。
 * system 是手机或 Worker 上的智能体入口，用"记忆整理"（consolidate）这个功能的 API
 */
export async function runConsolidation(system: AgentSystem, ctx: MemoryConsolidationContext, opts: { signal?: AbortSignal } = {}): Promise<{ ops: MemoryOp[]; errors: string[] }> {
  const preset = ctx.preset;
  if (!preset) return { ops: [], errors: ['没有"整理"预设'] };
  const base: ConsolidateContext = { character: ctx.character, user: { name: ctx.userName }, now: new Date(), timeZone: ctx.timezone };
  const req = (input: ConsolidateInput) => ({ messages: buildConsolidateMessages(base, input, preset), ...samplerRequest(preset.sampler) });
  const ops: MemoryOp[] = [];
  const errors: string[] = [];
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      errors.push(`${name}：${e instanceof Error ? e.message : String(e)}`);
    }
  };
  if (ctx.mergeGroups.length) {
    await step('合并重复的记忆', async () => {
      const input: ConsolidateInput = { task: 'merge', groups: ctx.mergeGroups };
      const { value } = await system.json('consolidate', req(input), (v) => parseMerge(v, ctx.mergeGroups), { signal: opts.signal });
      for (const m of value) ops.push({ op: 'merge', ...m });
    });
  }
  for (const r of ctx.rollups.slice(0, MAX_ROLLUPS)) {
    await step('合并时间线', async () => {
      const { value } = await system.json('consolidate', req({ task: 'rollup', segments: r.segments }), parseRollup, { signal: opts.signal });
      ops.push({ op: 'rollup', ids: r.ids, text: value });
    });
  }
  if (ctx.followups.length) {
    await step('过期的事改时态', async () => {
      const ids = new Set(ctx.followups.map((f) => f.id));
      const { value } = await system.json('consolidate', req({ task: 'tense', items: ctx.followups }), (v) => parseTense(v, ids), { signal: opts.signal });
      for (const u of value) ops.push({ op: 'tense', ...u });
    });
  }
  if (ctx.newMemories.length) {
    await step('修改画像卡', async () => {
      const lineIds = new Set(ctx.profile.lines.map((l) => l.id));
      const { value } = await system.json('consolidate', req({ task: 'profile', lines: ctx.profile.lines, memories: ctx.newMemories }), (v) => parseProfileOps(v, lineIds), { signal: opts.signal });
      if (value.length) ops.push({ op: 'profile', ops: value });
    });
  }
  return { ops, errors };
}
