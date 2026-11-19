import { categoryMarkers } from './formats.ts';
import { appBlocks } from './st/preset.ts';
import { PRESET_CATEGORIES, isRoleplayCategory, type Preset, type PresetCategory, type PromptBlock, type RegexScript } from './types/preset.ts';

/**
 * 预设里的块怎么加、怎么复制（预设编辑页、"我的 → 助手"的预设融合共用）：
 * - 程序块：这一类预设的程序认得的程序填充块，加进来时内容为空、由程序每次填；
 * - 复制：普通块原样复制（identifier 撞了就换一个），程序块目标里已经有、或者目标那一类的程序不认识时跳过；
 *   放的位置跟着原来的邻居走：原来在哪一块后面，目标里有那一块就放它后面，没有就找后面的邻居放它前面，都没有放最后。
 */

/** 这一类预设能加的程序块（identifier → 名字）：程序按分类认的，再加上 extra（这一类的自带预设里出现过的） */
export function markerChoices(category: PresetCategory, extra: Pick<PromptBlock, 'identifier' | 'name'>[] = []): { identifier: string; name: string }[] {
  const out = Object.entries(categoryMarkers(category)).map(([identifier, name]) => ({ identifier, name }));
  for (const b of extra) if (!out.some((x) => x.identifier === b.identifier)) out.push({ identifier: b.identifier, name: b.name });
  return out;
}

/** 新的程序块：App 自己的上下文块（记忆、环境、场景规则……）的位置和导入 ST 预设时补的一样 */
export function markerBlock(identifier: string, name: string): PromptBlock {
  const app = appBlocks().before.find((b) => b.identifier === identifier);
  return {
    identifier,
    name,
    role: 'system',
    content: '',
    marker: true,
    enabled: true,
    injection: app ? { ...app.injection } : { position: 'relative', depth: 4 },
  };
}

/** 程序块插在哪：有聊天记录块的放它前面（程序给的上下文都在历史前），聊天记录块本身和没有聊天记录块的放最后 */
export function markerInsertIndex(blocks: PromptBlock[], identifier: string, historyId = 'chatHistory'): number {
  if (identifier === historyId) return blocks.length;
  const at = blocks.findIndex((b) => b.identifier === historyId);
  return at < 0 ? blocks.length : at;
}

export interface CopyBlocksOptions {
  /** 目标那一类的程序认得的程序块（identifier）；不在里面的程序块不复制 */
  known: Iterable<string>;
  /** 生成新的 identifier（普通块的 identifier 在目标里撞了时） */
  newId(prefix: string): string;
  /** 指定放在目标的第几块后面（-1 = 最前面）；不给时按原来的邻居找位置 */
  after?: number;
}

export interface CopyBlocksResult {
  added: PromptBlock[];
  skipped: { block: PromptBlock; reason: string }[];
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** 目标里没用过的 identifier：原来的没撞就用原来的 */
function freeIdentifier(blocks: PromptBlock[], identifier: string, newId: (prefix: string) => string): string {
  if (!blocks.some((b) => b.identifier === identifier)) return identifier;
  let id = `${identifier}-${newId('b').slice(-4)}`;
  while (blocks.some((b) => b.identifier === id)) id = `${identifier}-${newId('b').slice(-6)}`;
  return id;
}

/**
 * 把 source 里的几块复制进 target（直接改 target.blocks）。source 和 target 可以是同一个预设（复制一份放在原来那块后面）。
 * blocks 是 source.blocks 里的块（按 source 里的顺序复制）。
 */
export function copyBlocks(target: Preset, source: Pick<Preset, 'blocks'>, blocks: PromptBlock[], opts: CopyBlocksOptions): CopyBlocksResult {
  const known = new Set(opts.known);
  const label = PRESET_CATEGORIES[target.category].label;
  const result: CopyBlocksResult = { added: [], skipped: [] };
  const order = [...blocks].sort((a, b) => source.blocks.indexOf(a) - source.blocks.indexOf(b));
  /** 原来的块 → 目标里对应的块（复制过去的那块；原来就在目标里的是它自己） */
  const placed = new Map<PromptBlock, PromptBlock>();
  let cursor = opts.after;
  const anchorOf = (b: PromptBlock): PromptBlock | undefined => placed.get(b) ?? target.blocks.find((x) => x === b || x.identifier === b.identifier);
  for (const b of order) {
    if (b.marker) {
      if (target.blocks.some((x) => x.marker && x.identifier === b.identifier)) {
        result.skipped.push({ block: b, reason: `「${target.name}」里已经有程序块「${b.name}」` });
        continue;
      }
      if (!known.has(b.identifier)) {
        result.skipped.push({ block: b, reason: `${label}预设的程序不认识程序块「${b.name}」，复制过去也不会填内容` });
        continue;
      }
    }
    const copy: PromptBlock = { ...clone(b), identifier: b.marker ? b.identifier : freeIdentifier(target.blocks, b.identifier, opts.newId) };
    let at: number;
    if (cursor !== undefined) {
      at = cursor + 1;
      cursor = at;
    } else {
      const i = source.blocks.indexOf(b);
      const before = source.blocks.slice(0, i + 1).reverse().map(anchorOf).find((x) => !!x);
      const next = before ? undefined : source.blocks.slice(i + 1).map(anchorOf).find((x) => !!x);
      at = before ? target.blocks.indexOf(before) + 1 : next ? target.blocks.indexOf(next) : target.blocks.length;
    }
    target.blocks.splice(at, 0, copy);
    placed.set(b, copy);
    result.added.push(copy);
  }
  return result;
}

/** 两条正则做的是同一件事（查找、替换、作用在哪都一样） */
export function sameRegex(a: RegexScript, b: RegexScript): boolean {
  return a.find === b.find && a.replace === b.replace && [...a.placement].sort().join() === [...b.placement].sort().join();
}

/** 复制正则进 target（换新 id）；目标里已经有一样的跳过。返回复制过去的 */
export function copyRegex(target: Preset, scripts: RegexScript[], newId: (prefix: string) => string): RegexScript[] {
  const added: RegexScript[] = [];
  for (const s of scripts) {
    if (target.regex.some((x) => sameRegex(x, s))) continue;
    const copy = { ...clone(s), id: newId('rx') };
    target.regex.push(copy);
    added.push(copy);
  }
  return added;
}

/** 预设能不能改成 / 复制成另一类：同一类，或者都是角色扮演类 */
export function canBecome(from: PresetCategory, to: PresetCategory): boolean {
  return from === to || (isRoleplayCategory(from) && isRoleplayCategory(to));
}
