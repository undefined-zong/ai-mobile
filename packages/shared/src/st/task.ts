import type { Lorebook } from '../types/lorebook.ts';
import { markerName, type Preset, type PromptBlock } from '../types/preset.ts';
import { substituteMacros, type MacroContext } from './macros.ts';
import { markerContent, reportMarkerInjections } from './markers.ts';
import { estimateTokens } from './tokens.ts';
import { scanWorldInfo } from './worldinfo.ts';

/**
 * 任务类预设（小剧场 / 总结 / 生图）拼成消息：按块的顺序，关掉的不发、空的不发；
 * 普通块替换宏（{{char}} {{user}} {{time}}……），程序填充块填这次任务的输入（块里写了内容时按写的发，{{original}} 换成程序填的，见 markers.ts）；
 * 相邻的同角色块合成一条（中间空一行），所以默认的预设拼出来是"一条系统说明 + 一条输入"。
 * 任务没有聊天记录，块的"插在聊天记录倒数第几条"不起作用。
 * 没放进预设的任务输入按 fills 的顺序补在最后；已有块（包括关闭或有触发条件的）仍按预设控制。
 * 世界书：预设打开"使用世界书"（worldInfoEnabled 为 true，任务预设没写时不发）、调用方带了角色绑定的世界书时，
 * 按这一次的输入扫描，常驻和命中的条目填进 worldInfoBefore / worldInfoAfter 块；预设里没放这两块时放在第一个程序填充块前面。
 */

/** 任务预设：块、采样参数（上下文上限 contextTokens）、"使用世界书"开关；lorebooks 是调用方按这次的角色带上的世界书 */
export type TaskPresetLike = Pick<Preset, 'blocks'> & Partial<Pick<Preset, 'id' | 'worldInfoEnabled'>> & { sampler?: Pick<Preset['sampler'], 'contextTokens'>; lorebooks?: Lorebook[] };

const WORLD_INFO_BLOCKS = new Set(['worldInfoBefore', 'worldInfoAfter']);

/** 按这一次的输入扫描世界书；没打开或没有世界书时为空 */
function taskWorldInfo(input: TaskPromptInput, ctx: MacroContext): Record<string, string> {
  const books = input.preset.lorebooks ?? [];
  if (input.preset.worldInfoEnabled !== true || !books.length) return {};
  const text = Object.values(input.fills).filter((v) => v.trim()).join('\n\n');
  const lore = scanWorldInfo({ books, messages: text ? [text] : [], chatLength: 0, dryRun: true, trigger: 'quiet', macro: (t) => substituteMacros(t, ctx) });
  // 任务没有聊天记录和作者注：按深度、示例前后、作者注位置的条目都放在"角色后"
  const after = [lore.after, ...lore.anTop, ...lore.anBottom, ...lore.emTop, ...lore.emBottom, ...lore.depth.map((d) => d.content)].filter((s) => s.trim());
  return { worldInfoBefore: lore.before, worldInfoAfter: after.join('\n') };
}

export interface TaskPromptInput {
  preset: TaskPresetLike;
  /** 程序填充块的内容：块的 identifier → 这一次的内容（空的不发） */
  fills: Record<string, string>;
  macros?: MacroContext;
  /**
   * 这一次的类型（生图：scene / portrait / face / background，场景里的时刻 seat / peek……；节律：build-world / plan-day……）：
   * 块写了触发条件时，只在条件里有其中一个时发送。可以给几个（例如节律的 plan-day + outfit-pick）
   */
  type?: string | string[];
}

export interface TaskBlockReport {
  identifier: string;
  name: string;
  role: PromptBlock['role'];
  enabled: boolean;
  marker: boolean;
  content: string;
  /** 程序块：程序填的原内容（块里写了内容、和最终内容不一样时才有） */
  filled?: string;
  tokens: number;
  sent: boolean;
  note?: string;
}

export interface TaskPromptResult {
  messages: { role: PromptBlock['role']; content: string }[];
  blocks: TaskBlockReport[];
}

export function assembleTaskPrompt(input: TaskPromptInput): TaskPromptResult {
  const ctx: MacroContext = input.macros ?? { char: '', user: '' };
  const messages: TaskPromptResult['messages'] = [];
  const blocks: TaskBlockReport[] = [];
  const types = new Set(['normal', ...(Array.isArray(input.type) ? input.type : [input.type])].filter((t): t is string => !!t));
  const fills = { ...taskWorldInfo(input, ctx), ...input.fills };
  const supplied = new Set(input.preset.blocks.filter((b) => b.marker).map((b) => b.identifier));
  const missing = Object.keys(fills).filter((identifier) => !supplied.has(identifier));
  const inputBlock = (identifier: string, role: PromptBlock['role']): PromptBlock => ({
    identifier, name: markerName(identifier) ?? identifier, role, content: '', marker: true, enabled: true,
    injection: { position: 'relative', depth: 0 }, origin: 'app',
  });
  const list = [...input.preset.blocks];
  // 预设里没放世界书块：放在第一个程序填充块（这一次的输入）前面
  const firstInput = list.findIndex((b) => b.marker);
  list.splice(firstInput < 0 ? list.length : firstInput, 0, ...missing.filter((id) => WORLD_INFO_BLOCKS.has(id)).map((id) => inputBlock(id, 'system')));
  list.push(...missing.filter((id) => !WORLD_INFO_BLOCKS.has(id)).map((id) => inputBlock(id, 'user')));
  const sent: TaskBlockReport[] = [];
  for (const b of list) {
    const known = !b.marker || b.identifier in fills;
    const filled = b.marker ? (fills[b.identifier] ?? '').replace(/\r/g, '') : '';
    const content = (b.marker ? markerContent(b.content, filled, ctx) : substituteMacros(b.content, ctx)).replace(/\r/g, '');
    const report: TaskBlockReport = { identifier: b.identifier, name: b.name, role: b.role, enabled: b.enabled, marker: b.marker, content, tokens: estimateTokens(content), sent: false };
    if (b.marker && filled !== content) report.filled = filled;
    blocks.push(report);
    if (!b.enabled) {
      report.note = '预设里关闭了';
      continue;
    }
    if (b.triggers?.length && !b.triggers.some((t) => types.has(t))) {
      report.note = `只在 ${b.triggers.join(' / ')} 时发送`;
      continue;
    }
    if (!content.trim()) {
      report.note = known ? '这一次内容为空，不发送' : '这次任务没有提供这块内容';
      continue;
    }
    report.sent = true;
    sent.push(report);
  }
  fitContext(sent, input.preset.sampler?.contextTokens);
  reportMarkerInjections(
    input.preset.id,
    blocks.filter((r) => r.marker).map((r) => ({ identifier: r.identifier, content: r.content, filled: r.filled, sent: r.sent, note: r.note })),
  );
  for (const r of sent.filter((x) => x.sent)) {
    const last = messages.at(-1);
    if (last && last.role === r.role) last.content = `${last.content}\n\n${r.content}`;
    else messages.push({ role: r.role, content: r.content });
  }
  return { messages, blocks };
}

/** 上下文上限（预设的 contextTokens）：超过时从最长的程序填充块开头截掉（保留后面较新的内容），预设写的块不动 */
function fitContext(sent: TaskBlockReport[], budget: number | undefined) {
  if (!budget || budget <= 0) return;
  let total = sent.reduce((n, r) => n + r.tokens, 0);
  while (total > budget) {
    const longest = sent.filter((r) => r.sent && r.marker && r.tokens > 0).sort((a, b) => b.tokens - a.tokens)[0];
    if (!longest) return;
    const keep = Math.max(0, longest.tokens - (total - budget));
    const chars = Math.floor(longest.content.length * (keep / longest.tokens));
    const content = chars > 0 ? longest.content.slice(-chars) : '';
    const tokens = estimateTokens(content);
    if (tokens >= longest.tokens) return;
    total -= longest.tokens - tokens;
    longest.content = content;
    longest.tokens = tokens;
    longest.note = `超过上下文上限 ${budget}，截掉了开头`;
    if (!content.trim()) longest.sent = false;
  }
}
