import { substituteMacros, type MacroContext } from './macros.ts';

/**
 * 程序块（marker）发什么，看块里自己写的内容：
 * - 没写：原样发送程序这一次填的内容；
 * - 写了：发送写的内容，{{original}} 换成程序填的内容（不写 {{original}} 就整块换成自己写的）；
 * - 程序这一次没有内容：这一块不发（不会只发一个空壳）。
 */
export function markerContent(template: string, filled: string, ctx: MacroContext): string {
  if (!template.trim() || !filled.trim()) return filled;
  return substituteMacros(template, { ...ctx, original: filled });
}

/** 程序块这一次注入了什么（预设编辑页里每个程序块显示"上次注入的内容"） */
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

export type MarkerInjectionListener = (presetId: string, blocks: MarkerInjection[]) => void;

const listeners = new Set<MarkerInjectionListener>();

/** 拼好一次提示词就通知一次（只有带 id 的预设；预览不算） */
export function onMarkerInjections(fn: MarkerInjectionListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function reportMarkerInjections(presetId: string | undefined, blocks: MarkerInjection[]): void {
  if (!presetId || !listeners.size || !blocks.length) return;
  for (const fn of listeners) {
    try {
      fn(presetId, blocks);
    } catch {
      // 只是记下来给人看，不影响拼提示词
    }
  }
}
