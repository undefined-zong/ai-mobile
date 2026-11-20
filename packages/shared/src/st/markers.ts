import type { PromptBlock } from '../types/preset.ts';
import { substituteMacros, type MacroContext } from './macros.ts';

/**
 * 程序块（marker）发什么，看块里自己写的内容：
 * - 这一次的场景在 variants 里写了，用它；没写用 content；
 * - 都没写：原样发送程序这一次填的内容；
 * - 写了：发送写的内容，{{original}} 换成程序填的内容（不写 {{original}} 就整块换成自己写的）；
 * - 程序这一次没有内容：这一块不发（不会只发一个空壳）。
 */
export function markerContent(b: Pick<PromptBlock, 'content' | 'variants'>, keys: readonly string[], filled: string, ctx: MacroContext): string {
  const template = markerTemplate(b, keys);
  if (!template.trim() || !filled.trim()) return filled;
  return substituteMacros(template, { ...ctx, original: filled });
}

/** 这一次用块里哪一段写法：keys 从最具体到最宽，先找到的为准，都没有用 content */
export function markerTemplate(b: Pick<PromptBlock, 'content' | 'variants'>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = b.variants?.[k];
    if (v?.trim()) return v;
  }
  return b.content;
}

/**
 * 这一次在哪个场景：keys 从最具体到最宽（例如 ["scene:game|td-pick", "scene:game"]），
 * 找块里按场景写的内容按这个顺序，记"上一次注入的内容"记在 keys[0] 下（没有场景之分时为空）。
 * who 是这一次的角色（同一个场景不同角色内容不一样，显示时说明是谁的）。
 */
export interface MarkerContext {
  keys: string[];
  who?: string;
}

/** 程序块这一次注入了什么（预设编辑页里每个程序块按场景显示"上一次注入的内容"） */
export interface MarkerInjection {
  identifier: string;
  /** 最终发出去的内容（套用了块里写的内容之后） */
  content: string;
  /** 程序填的原内容（块里写了内容、和最终内容不一样时才有） */
  filled?: string;
  source?: string;
  sent: boolean;
  note?: string;
}

export type MarkerInjectionListener = (presetId: string, context: MarkerContext, blocks: MarkerInjection[]) => void;

const listeners = new Set<MarkerInjectionListener>();

/** 拼好一次提示词就通知一次（只有带 id 的预设；预览不算） */
export function onMarkerInjections(fn: MarkerInjectionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reportMarkerInjections(presetId: string | undefined, context: MarkerContext, blocks: MarkerInjection[]): void {
  if (!presetId || !listeners.size || !blocks.length) return;
  for (const fn of listeners) {
    try {
      fn(presetId, context, blocks);
    } catch {
      // 只是记下来给人看，不影响拼提示词
    }
  }
}
