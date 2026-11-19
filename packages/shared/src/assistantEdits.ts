import { characterFromCard } from './st/card.ts';
import { normalizeRegexScript, regexFromString } from './st/regex.ts';
import type { Character, StCardFields } from './types/character.ts';
import type { LoreEntry, LorePosition, Lorebook } from './types/lorebook.ts';
import { categoryMarkers } from './formats.ts';
import { canBecome, copyBlocks, copyRegex } from './presetBlocks.ts';
import { appBlocks } from './st/preset.ts';
import { PRESET_CATEGORIES, markerName, type Preset, type PresetCategory, type PromptBlock, type RegexScript } from './types/preset.ts';
import { readBrawlFighter, type BrawlFighter } from './brawl.ts';

/**
 * "我的 → 助手"改东西的写法（写在"助手"预设的"修改的写法"那块里，助手照着写）：
 * 回复最后一段 <edits>[…]</edits>，里面是 JSON 数组，一项一个修改：
 *   {"preset": "id", "op": "replace", "block": "main", "find": "原文", "with": "新的"}
 *   {"lorebook": "id", "op": "set", "entry": "3", "keys": ["…"]}
 *   {"character": "new", "op": "create", "name": "…", "description": "…"}
 *   {"preset": "new", "op": "create", "from": "底子的 id", "name": "…"}（照一个预设复制出新预设，之后 "preset": "new" 改的是它）
 *   {"preset": "new", "op": "copy", "from": "别的预设 id", "blocks": ["…"]}（把别的预设里的块原样复制过来）
 * 程序读出来先算"改之前 / 改之后"给你看，你点"应用"才写进去；应用前对象又变了也没关系：每次都按现在的样子重算。
 */

export type EditKind = 'preset' | 'lorebook' | 'character' | 'fighter';

export interface AssistantOp {
  kind: EditKind;
  /** 对象的 id；新建时是 "new" */
  id: string;
  op: string;
  raw: Record<string, unknown>;
}

export const EDIT_OPS: Record<EditKind, string[]> = {
  preset: ['replace', 'set', 'add', 'remove', 'move', 'add-regex', 'set-regex', 'remove-regex', 'meta', 'create', 'copy', 'copy-regex'],
  lorebook: ['replace', 'set', 'add', 'remove', 'meta', 'create'],
  character: ['replace', 'set', 'create'],
  fighter: ['set', 'skill'],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);
const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map((x) => str(x)?.trim() ?? '').filter(Boolean) : typeof v === 'string' ? v.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : undefined;
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : undefined);
const num = (v: unknown): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

// —— 读回复 ——

export interface ParsedAssistantReply {
  /** 给人看的部分（去掉了 <edits>） */
  text: string;
  ops: AssistantOp[];
  /** <edits> 里读不出来的项 */
  errors: string[];
  /** 有一段 <edits> 的 JSON 还没写完；此前完整的修改仍保留在 ops 里 */
  pending: boolean;
}

/** <edits> 后面紧跟着 JSON（或者什么都还没有，流式时）的才是修改；说明文字里提到 <edits> 这个词的不算 */
const OPEN_SOURCE = '<edits>\\s*(?:```(?:json)?\\s*)?(?=[[{]|$)';
/** JSON 后面收尾的 ``` 和 </edits> */
const CLOSE_RE = /^\s*(?:```\s*)?<\/edits>/i;
const FENCE_JSON_RE = /```(?:json)?\s*\n([\s\S]*?)```/gi;

/** 宽松地读 JSON：去掉代码块围栏、结尾多余的逗号 */
function looseJson(text: string): unknown {
  let s = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch {
    s = s.replace(/,\s*([\]}])/g, '$1');
    return JSON.parse(s);
  }
}

/**
 * 从 start（[ 或 {）起，找 JSON 的结尾或字符串外的下一处编辑标签。
 * 字符串里的括号和标签原样保留；遇到标签先结束当前段，让坏 JSON 不影响后面的修改。没写完返回 -1。
 */
function editBodyEnd(s: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '<' && /^<\/?edits>/i.test(s.slice(i, i + '</edits>'.length))) return i;
    else if (c === '"') inString = true;
    else if (c === '[' || c === '{') depth++;
    else if ((c === ']' || c === '}') && --depth === 0) return i + 1;
  }
  return -1;
}

/** 收掉 JSON 后面的围栏和结束标签；流式收到一半的收尾也先藏起来。 */
function editTailEnd(raw: string, end: number): number {
  const rest = raw.slice(end);
  const close = CLOSE_RE.exec(rest);
  if (close) return end + close[0].length;
  const fence = /^\s*```/.exec(rest);
  const tail = rest.slice(fence?.[0].length ?? 0).trim().toLowerCase();
  if ('```'.startsWith(rest.trim()) || '</edits>'.startsWith(tail)) return raw.length;
  return end + (fence?.[0].length ?? 0);
}

function opOf(item: unknown, i: number, errors: string[]): AssistantOp | null {
  if (!isObj(item)) {
    errors.push(`第 ${i + 1} 项不是对象`);
    return null;
  }
  const kind: EditKind | null = 'preset' in item ? 'preset' : 'lorebook' in item ? 'lorebook' : 'character' in item ? 'character' : 'fighter' in item ? 'fighter' : null;
  if (!kind) {
    errors.push(`第 ${i + 1} 项没写改哪个（preset / lorebook / character / fighter）`);
    return null;
  }
  const id = str(item[kind])?.trim();
  const op = str(item.op)?.trim().toLowerCase();
  if (!id || !op) {
    errors.push(`第 ${i + 1} 项缺 ${!id ? kind : 'op'}`);
    return null;
  }
  if (!EDIT_OPS[kind].includes(op)) {
    errors.push(`第 ${i + 1} 项的 op「${op}」不认识（${kind} 能用：${EDIT_OPS[kind].join(' / ')}）`);
    return null;
  }
  return { kind, id, op, raw: item };
}

function opsFrom(json: unknown, errors: string[]): AssistantOp[] {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.edits) ? json.edits : isObj(json) ? [json] : null;
  if (!list) {
    errors.push('<edits> 里不是 JSON 数组');
    return [];
  }
  return list.map((x, i) => opOf(x, i, errors)).filter((x): x is AssistantOp => !!x);
}

/** 读助手的回复：拿出 <edits>（没写标签、但有一段全是修改项的 ```json 也认），剩下的是给人看的 */
export function parseAssistantReply(raw: string): ParsedAssistantReply {
  const errors: string[] = [];
  const ops: AssistantOp[] = [];
  let pending = false;
  const kept: string[] = [];
  const read = (body: string): string | null => {
    try {
      ops.push(...opsFrom(looseJson(body), errors));
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  // 一段一段找 <edits>：JSON 的结尾按括号配对找（不是找第一个 </edits>），读出来的修改和 JSON 都不留在给人看的文字里
  const open = new RegExp(OPEN_SOURCE, 'gi');
  let pos = 0;
  for (let m = open.exec(raw); m; m = open.exec(raw)) {
    const start = m.index + m[0].length;
    const end = start < raw.length ? editBodyEnd(raw, start) : -1;
    const error = end > 0 ? read(raw.slice(start, end)) : 'JSON 没写完';
    let next: number;
    if (!error) next = editTailEnd(raw, end);
    else if (end > 0 && !raw.slice(start, end).includes('"op"')) {
      // 说明文字里举的例子（<edits>[…]</edits>），不是修改：原样留着
      open.lastIndex = start;
      continue;
    } else if (end > 0) {
      errors.push(`<edits> 不是有效的 JSON：${error}`);
      next = editTailEnd(raw, end);
    } else {
      // 还没写完（流式时）或者回复被截断了：后面整段先藏起来
      pending = true;
      next = raw.length;
    }
    kept.push(raw.slice(pos, m.index));
    pos = next;
    open.lastIndex = next;
  }
  kept.push(raw.slice(pos));
  let text = kept.join('');
  // <edits> 后的代码围栏还没收齐（如 ```j），同样等后面的 JSON，不把协议露进气泡。
  const unfinished = text.toLowerCase().lastIndexOf('<edits>');
  if (unfinished >= 0 && '```json'.startsWith(text.slice(unfinished + '<edits>'.length).trim().toLowerCase())) {
    text = text.slice(0, unfinished);
    pending = true;
  }
  if (!pending) {
    // 半截的 "<edi"（流式时）先藏起来
    const lt = text.lastIndexOf('<');
    if (lt >= 0 && lt >= text.length - 7 && '<edits>'.startsWith(text.slice(lt).toLowerCase())) text = text.slice(0, lt);
  }
  if (!ops.length && !pending) {
    text = text.replace(FENCE_JSON_RE, (m, body: string) => {
      try {
        const json = looseJson(body);
        const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.edits) ? json.edits : null;
        if (list?.length && list.every((x) => isObj(x) && typeof x.op === 'string' && ('preset' in x || 'lorebook' in x || 'character' in x || 'fighter' in x))) {
          ops.push(...opsFrom(list, errors));
          return '';
        }
      } catch {
        // 不是修改项，原样留着
      }
      return m;
    });
  }
  return { text: text.replace(/\n{3,}/g, '\n\n').trim(), ops, errors, pending };
}

// —— 算出改之后的样子 ——

export interface EditChange {
  /** 在这条回复里的稳定位置；旧的应用记录没有这两个字段 */
  key?: string;
  requires?: string[];
  kind: EditKind;
  /** 对象的 id；新建的是 new:序号 */
  id: string;
  title: string;
  /** 改了什么：改「主提示」的一段 / 加正则「…」 */
  label: string;
  before?: string;
  after?: string;
  /** 动了作者写的文字（不只是标签、字段名、开关这些格式） */
  textChanged: boolean;
}

export interface EditPlan {
  fighters: BrawlFighter[];
  /** 改过的预设、世界书、角色（改之后的副本） */
  presets: Preset[];
  lorebooks: Lorebook[];
  characters: Character[];
  /** 新建的 */
  newCharacters: Character[];
  newLorebooks: Lorebook[];
  newPresets: Preset[];
  /** 新建的世界书绑给谁（角色 id） */
  bindings: { lorebookId: string; characterId: string }[];
  changes: EditChange[];
  errors: string[];
}

export interface PlanContext {
  fighters?: BrawlFighter[];
  presets: Preset[];
  lorebooks: Lorebook[];
  characters: Character[];
  /** 生成新 id（预设块、正则、条目、新角色、新世界书） */
  newId(prefix: string): string;
  now: number;
  /** 新建角色用哪个对话预设 */
  defaultPresetId: string | null;
  /** 这一类预设的程序认得的程序块（复制程序块时查）；不给时按 PROMPT_MARKERS / TASK_MARKERS */
  knownMarkers?(category: PresetCategory): string[];
}

/** 选中一项时一起选它的前置项；取消前置项时一起取消依赖它的项。 */
export function toggleEditSelection(changes: EditChange[], selected: ReadonlySet<string>, key: string, on: boolean): Set<string> {
  const next = new Set(selected);
  const byKey = new Map(changes.map((c) => [c.key, c]));
  const include = (k: string) => {
    if (next.has(k)) return;
    next.add(k);
    for (const dep of byKey.get(k)?.requires ?? []) include(dep);
  };
  if (on) include(key);
  else {
    next.delete(key);
    for (const c of changes) if (c.key && c.requires?.some((dep) => !next.has(dep))) next.delete(c.key);
  }
  return next;
}

interface EditSelectionContext {
  key: string;
  selected?: ReadonlySet<string>;
  requires: Set<string>;
  owners: Map<string, string>;
  entryUid?: string;
}

const ownerKey = (...parts: string[]) => JSON.stringify(parts);
const partKey = (selection: EditSelectionContext, part: string) => `${selection.key}:${part}`;
const partSelected = (selection: EditSelectionContext, part: string) => !selection.selected || selection.selected.has(partKey(selection, part));
function requireOwner(selection: EditSelectionContext, ...parts: string[]) {
  const key = selection.owners.get(ownerKey(...parts));
  if (key) selection.requires.add(key);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** 文字里去掉格式（标签、宏、JSON 字段名、标点空白）后剩下的，用来判断改的是格式还是文字 */
function prose(s: string): string {
  return s
    .replace(/<\/?[A-Za-z一-鿿][^>\n]{0,300}>/g, ' ')
    .replace(/[[【][A-Za-z_-]+(?:[:：][^\]】\n]{0,300})?[\]】]/g, ' ')
    .replace(/\{\{[^}]*\}\}/g, ' ')
    .replace(/"[A-Za-z_][A-Za-z0-9_]*"\s*:/g, ' ')
    .replace(/```[a-z]*/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLowerCase();
}

export function isTextChange(before: string, after: string): boolean {
  return prose(before) !== prose(after);
}

/** 两段文字不一样的那部分，前后各带一点（预览用） */
export function diffSnippet(before: string, after: string, context = 40): { before: string; after: string } {
  const max = Math.min(before.length, after.length);
  let start = 0;
  while (start < max && before[start] === after[start]) start++;
  let endA = before.length;
  let endB = after.length;
  while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
    endA--;
    endB--;
  }
  const from = Math.max(0, start - context);
  const snip = (s: string, end: number) => {
    const to = Math.min(s.length, end + context);
    return `${from > 0 ? '…' : ''}${s.slice(from, to)}${to < s.length ? '…' : ''}`;
  };
  return { before: snip(before, endA), after: snip(after, endB) };
}

/** 在文字里找 find：先找一字不差的，找不到再放宽空白和全半角引号 */
function locate(text: string, find: string): { index: number; length: number } | null {
  if (!find) return null;
  const i = text.indexOf(find);
  if (i >= 0) return { index: i, length: find.length };
  const esc = find
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
    .replace(/["“”]/g, '["“”]')
    .replace(/[:：]/g, '[:：]');
  if (!esc) return null;
  const m = new RegExp(esc).exec(text);
  return m ? { index: m.index, length: m[0].length } : null;
}

function replaceIn(text: string, find: string, withText: string, all: boolean): string | null {
  if (all && text.includes(find)) return text.split(find).join(withText);
  const at = locate(text, find);
  if (!at) return null;
  return text.slice(0, at.index) + withText + text.slice(at.index + at.length);
}

/** op 的字段：平铺写的和写在 fields 里的都认 */
function fieldsOf(raw: Obj, skip: string[]): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(raw)) if (!skip.includes(k)) out[k] = v;
  if (isObj(raw.fields)) Object.assign(out, raw.fields);
  delete out.fields;
  return out;
}

const ROLES = new Set(['system', 'user', 'assistant']);
const POSITIONS = new Set<LorePosition>(['before_char', 'after_char', 'an_top', 'an_bottom', 'at_depth', 'em_top', 'em_bottom']);

function blockLabel(b: Pick<PromptBlock, 'name' | 'identifier'>) {
  return `「${b.name || b.identifier}」`;
}

/** 预设块的字段：返回改了哪些格式字段（中文），内容另算 */
function patchBlock(b: PromptBlock, f: Obj): string[] {
  const done: string[] = [];
  const name = str(f.name);
  if (name !== undefined && name !== b.name) (b.name = name), done.push('名字');
  const role = str(f.role);
  if (role && ROLES.has(role) && role !== b.role) (b.role = role as PromptBlock['role']), done.push(`身份改成 ${role}`);
  const enabled = bool(f.enabled);
  if (enabled !== undefined && enabled !== b.enabled) (b.enabled = enabled), done.push(enabled ? '打开' : '关掉');
  const triggers = 'triggers' in f ? (strList(f.triggers) ?? []) : undefined;
  if (triggers && triggers.join('|') !== (b.triggers ?? []).join('|')) {
    if (triggers.length) b.triggers = triggers;
    else delete b.triggers;
    done.push(triggers.length ? `触发条件 ${triggers.join(' / ')}` : '去掉触发条件');
  }
  const position = str(f.position);
  const depth = num(f.depth);
  const order = num(f.order);
  if ((position === 'relative' || position === 'absolute') && position !== b.injection.position) (b.injection = { ...b.injection, position }), done.push(position === 'absolute' ? '改成按深度插入' : '改成按顺序');
  if (depth !== undefined && depth !== b.injection.depth) (b.injection = { ...b.injection, depth }), done.push(`深度 ${depth}`);
  if (order !== undefined && order !== b.injection.order) (b.injection = { ...b.injection, order }), done.push(`同深度顺序 ${order}`);
  return done;
}

/** 块写的是 identifier 或名字 */
function blockOf(p: Pick<Preset, 'blocks'>, id: unknown): PromptBlock | undefined {
  const key = str(id)?.trim();
  return key ? (p.blocks.find((b) => b.identifier === key) ?? p.blocks.find((b) => b.name === key)) : undefined;
}

function planPreset(p: Preset, op: AssistantOp, ctx: PlanContext, changes: EditChange[], presetOf: (id: string) => Preset | undefined, selection: EditSelectionContext): string | null {
  const r = op.raw;
  const title = p.name;
  const change = (label: string, textChanged = false, before?: string, after?: string, key = selection.key, requires = [...selection.requires]) =>
    changes.push({ key, requires, kind: 'preset', id: p.id, title, label, textChanged, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  const findBlock = (id: unknown) => {
    const b = blockOf(p, id);
    if (b) requireOwner(selection, p.id, 'block', b.identifier);
    return b;
  };
  switch (op.op) {
    case 'replace': {
      const b = findBlock(r.block);
      if (!b) return `预设「${title}」里没有块「${str(r.block) ?? ''}」`;
      if (b.marker) return `「${b.name}」是程序填充块，没有文字可改`;
      const find = str(r.find) ?? '';
      const next = replaceIn(b.content, find, str(r.with) ?? str(r.replace) ?? '', bool(r.all) === true);
      if (next === null) return `预设「${title}」的块${blockLabel(b)}里找不到要换的那段：「${find.slice(0, 40)}」`;
      const d = diffSnippet(b.content, next);
      change(`改块${blockLabel(b)}的一段`, isTextChange(b.content, next), d.before, d.after);
      b.content = next;
      return null;
    }
    case 'set': {
      const b = findBlock(r.block);
      if (!b) return `预设「${title}」里没有块「${str(r.block) ?? ''}」`;
      const f = fieldsOf(r, ['preset', 'op', 'block']);
      const done = patchBlock(b, f);
      const content = str(f.content);
      if (content !== undefined && content !== b.content && !b.marker) {
        const d = diffSnippet(b.content, content);
        change(`改块${blockLabel(b)}的内容${done.length ? `，${done.join('、')}` : ''}`, isTextChange(b.content, content), d.before, d.after);
        b.content = content;
      } else if (done.length) change(`块${blockLabel(b)}：${done.join('、')}`);
      else return `块${blockLabel(b)}没有要改的`;
      return null;
    }
    case 'add': {
      const f = isObj(r.block) ? r.block : fieldsOf(r, ['preset', 'op', 'after']);
      const marker = bool(f.marker) === true;
      let identifier = str(f.identifier)?.trim() || ctx.newId('blk');
      if (p.blocks.some((b) => b.identifier === identifier)) {
        if (marker) return `预设「${title}」里已经有程序填充块「${identifier}」`;
        identifier = `${identifier}-${ctx.newId('b').slice(-4)}`;
      }
      const block: PromptBlock = {
        identifier,
        name: str(f.name) ?? (marker ? (markerName(identifier) ?? identifier) : identifier),
        role: ROLES.has(str(f.role) ?? '') ? (str(f.role) as PromptBlock['role']) : 'system',
        content: marker ? '' : (str(f.content) ?? ''),
        marker,
        enabled: bool(f.enabled) ?? true,
        injection: { position: 'relative', depth: 4 },
      };
      // App 自己的程序填充块（记忆、环境、场景规则……）默认和导入 ST 预设时补的一样放在历史前
      const app = [...appBlocks().before, ...appBlocks().after].find((x) => x.identifier === identifier);
      if (marker && app && f.position === undefined) block.injection = { ...app.injection };
      patchBlock(block, { ...f, name: undefined, role: undefined, enabled: undefined });
      const afterKey = 'after' in r ? r.after : f.after;
      const after = afterKey === null || str(afterKey) === 'start' ? -1 : findBlock(afterKey);
      const at = after === -1 ? 0 : after ? p.blocks.indexOf(after) + 1 : p.blocks.length;
      p.blocks.splice(at, 0, block);
      const where = after === -1 ? '最前面' : after ? `${blockLabel(after)}后面` : '最后';
      change(`在${where}加${marker ? '程序填充块' : '一块'}${blockLabel(block)}${block.triggers?.length ? `（只在 ${block.triggers.join(' / ')} 时发送）` : ''}`, false, undefined, marker ? undefined : block.content);
      selection.owners.set(ownerKey(p.id, 'block', block.identifier), selection.key);
      return null;
    }
    case 'remove': {
      const b = findBlock(r.block);
      if (!b) return `预设「${title}」里没有块「${str(r.block) ?? ''}」`;
      p.blocks.splice(p.blocks.indexOf(b), 1);
      change(`删掉块${blockLabel(b)}`, !b.marker && !!b.content.trim(), b.marker ? undefined : b.content);
      return null;
    }
    case 'move': {
      const b = findBlock(r.block);
      if (!b) return `预设「${title}」里没有块「${str(r.block) ?? ''}」`;
      const toStart = r.after === null || str(r.after) === 'start';
      const after = toStart ? undefined : findBlock(r.after);
      if (!toStart && r.after !== undefined && !after) return `预设「${title}」里没有块「${str(r.after) ?? ''}」，挪不过去`;
      if (after === b) return `块${blockLabel(b)}不能挪到自己后面`;
      p.blocks.splice(p.blocks.indexOf(b), 1);
      const at = toStart ? 0 : after ? p.blocks.indexOf(after) + 1 : p.blocks.length;
      p.blocks.splice(at, 0, b);
      change(`把块${blockLabel(b)}挪到${toStart ? '最前面' : after ? `${blockLabel(after)}后面` : '最后'}`);
      return null;
    }
    case 'add-regex': {
      const f = isObj(r.regex) ? r.regex : fieldsOf(r, ['preset', 'op']);
      const script = normalizeRegexScript(
        {
          id: ctx.newId('rx'),
          name: str(f.name) ?? str(f.scriptName) ?? '助手加的正则',
          find: str(f.find) ?? str(f.findRegex) ?? '',
          replace: str(f.replace) ?? str(f.replaceString) ?? '',
          placement: placementNames(f.placement),
          enabled: bool(f.enabled) !== false,
          markdownOnly: bool(f.markdownOnly) === true,
          promptOnly: bool(f.promptOnly) === true,
          trimStrings: strList(f.trimStrings) ?? [],
        },
        p.regex.length,
      );
      if (!script?.find) return `正则没写 find`;
      if (!regexFromString(script.find)) return `正则「${script.name}」的 find 写错了：${script.find}`;
      p.regex.push(script);
      change(`加正则「${script.name}」${regexTarget(script)}`, false, script.find, script.replace);
      selection.owners.set(ownerKey(p.id, 'regex', script.id), selection.key);
      return null;
    }
    case 'set-regex': {
      const key = str(r.regex) ?? str(r.id);
      const s = p.regex.find((x) => x.id === key) ?? p.regex.find((x) => x.name === key);
      if (!s) return `预设「${title}」里没有正则「${key ?? ''}」`;
      requireOwner(selection, p.id, 'regex', s.id);
      const f = fieldsOf(r, ['preset', 'op', 'regex', 'id']);
      const before = `${s.find} → ${s.replace}`;
      if (str(f.name) !== undefined) s.name = str(f.name)!;
      if (str(f.find) !== undefined) s.find = str(f.find)!;
      if (str(f.replace) !== undefined) s.replace = str(f.replace)!;
      if (bool(f.enabled) !== undefined) s.enabled = bool(f.enabled)!;
      if (bool(f.markdownOnly) !== undefined) s.markdownOnly = bool(f.markdownOnly)!;
      if (bool(f.promptOnly) !== undefined) s.promptOnly = bool(f.promptOnly)!;
      if ('placement' in f) s.placement = placementNames(f.placement);
      if (!regexFromString(s.find)) return `正则「${s.name}」的 find 写错了：${s.find}`;
      change(`改正则「${s.name}」${regexTarget(s)}`, false, before, `${s.find} → ${s.replace}`);
      return null;
    }
    case 'remove-regex': {
      const key = str(r.regex) ?? str(r.id);
      const s = p.regex.find((x) => x.id === key) ?? p.regex.find((x) => x.name === key);
      if (!s) return `预设「${title}」里没有正则「${key ?? ''}」`;
      requireOwner(selection, p.id, 'regex', s.id);
      p.regex.splice(p.regex.indexOf(s), 1);
      change(`删掉正则「${s.name}」`, false, `${s.find} → ${s.replace}`);
      return null;
    }
    case 'copy': {
      const fromId = str(r.from)?.trim();
      const src = fromId ? presetOf(fromId) : undefined;
      if (!src) return `要从哪个预设复制？没有 id 是「${fromId ?? ''}」的预设`;
      const keys = strList(r.blocks) ?? (r.block !== undefined ? [str(r.block) ?? ''] : []);
      const picked: PromptBlock[] = [];
      for (const k of keys) {
        const b = blockOf(src, k);
        if (!b) return `预设「${src.name}」里没有块「${k}」`;
        if (!picked.includes(b) && partSelected(selection, `block:${b.identifier}`)) picked.push(b);
      }
      if (!picked.length) return `从「${src.name}」复制哪几块？blocks 写块的 identifier`;
      const afterKey = 'after' in r ? r.after : undefined;
      const anchor = afterKey === undefined ? undefined : afterKey === null || str(afterKey) === 'start' ? -1 : findBlock(afterKey);
      if (afterKey !== undefined && anchor === undefined) return `预设「${title}」里没有块「${str(afterKey) ?? ''}」，不知道放哪`;
      const res = copyBlocks(p, src, picked, {
        known: ctx.knownMarkers?.(p.category) ?? Object.keys(categoryMarkers(p.category)),
        newId: ctx.newId,
        ...(anchor === undefined ? {} : { after: anchor === -1 ? -1 : p.blocks.indexOf(anchor) }),
      });
      const copiedFrom = picked.filter((b) => !res.skipped.some((s) => s.block === b)).sort((a, b) => src.blocks.indexOf(a) - src.blocks.indexOf(b));
      for (const [i, b] of res.added.entries()) {
        const source = copiedFrom[i]!;
        const key = partKey(selection, `block:${source.identifier}`);
        const sourceOwner = selection.owners.get(ownerKey(src.id, 'block', source.identifier));
        const prev = p.blocks[p.blocks.indexOf(b) - 1];
        change(`从「${src.name}」复制${b.marker ? '程序块' : '块'}${blockLabel(b)}，放在${prev ? `${blockLabel(prev)}后面` : '最前面'}`, false, undefined, b.marker ? undefined : b.content, key, [...selection.requires, ...(sourceOwner ? [sourceOwner] : [])]);
        selection.owners.set(ownerKey(p.id, 'block', b.identifier), key);
      }
      const skipped = res.skipped.map((s) => s.reason).join('；');
      return res.added.length ? (skipped ? `有几块没复制：${skipped}` : null) : skipped || '没有复制成的块';
    }
    case 'copy-regex': {
      const fromId = str(r.from)?.trim();
      const src = fromId ? presetOf(fromId) : undefined;
      if (!src) return `要从哪个预设复制正则？没有 id 是「${fromId ?? ''}」的预设`;
      const keys = strList(r.regex) ?? [];
      const all = keys.length === 1 && keys[0] === 'all';
      const picked: RegexScript[] = [];
      for (const k of all ? [] : keys) {
        const s = src.regex.find((x) => x.id === k) ?? src.regex.find((x) => x.name === k);
        if (!s) return `预设「${src.name}」里没有正则「${k}」`;
        picked.push(s);
      }
      const list = (all ? src.regex : picked).filter((s) => partSelected(selection, `regex:${s.id}`));
      if (!list.length) return `从「${src.name}」复制哪几条正则？regex 写正则的 id（全部写 "all"）`;
      const start = changes.length;
      for (const source of list) {
        const added = copyRegex(p, [source], ctx.newId);
        const key = partKey(selection, `regex:${source.id}`);
        const sourceOwner = selection.owners.get(ownerKey(src.id, 'regex', source.id));
        for (const s of added) {
          change(`从「${src.name}」复制正则「${s.name}」${regexTarget(s)}`, false, s.find, s.replace, key, [...selection.requires, ...(sourceOwner ? [sourceOwner] : [])]);
          selection.owners.set(ownerKey(p.id, 'regex', s.id), key);
        }
      }
      return changes.length > start ? null : `「${src.name}」的这几条正则「${title}」里已经有一样的了`;
    }
    case 'meta': {
      const f = fieldsOf(r, ['preset', 'op']);
      const done: string[] = [];
      if (str(f.name)?.trim() && str(f.name) !== p.name) (p.name = str(f.name)!.trim()), done.push(`名字改成「${p.name}」`);
      if (str(f.description) !== undefined && str(f.description) !== p.description) (p.description = str(f.description)!), done.push('改说明');
      if (!done.length) return `预设「${title}」没有要改的`;
      change(done.join('、'));
      return null;
    }
  }
  return `预设不认识 op「${op.op}」`;
}

/** ST 的 placement 数字：1 你发的、2 她的回复、3 斜杠命令、5 世界书、6 思考 */
const PLACEMENT_CODES: Record<string, number> = { user_input: 1, ai_output: 2, slash_command: 3, world_info: 5, reasoning: 6 };
function placementCodes(v: unknown): number[] {
  const list = Array.isArray(v) ? v : v === undefined ? ['ai_output'] : [v];
  const out = list.map((x) => (typeof x === 'number' ? x : PLACEMENT_CODES[String(x)])).filter((x): x is number => typeof x === 'number');
  return out.length ? out : [2];
}
function placementNames(v: unknown): RegexScript['placement'] {
  const names = Object.entries(PLACEMENT_CODES);
  return placementCodes(v).map((c) => names.find(([, n]) => n === c)?.[0]).filter((x): x is RegexScript['placement'][number] => !!x);
}
function regexTarget(s: RegexScript): string {
  const where = s.placement.map((p) => (p === 'ai_output' ? 'Ta的回复' : p === 'user_input' ? '你发的' : p)).join('、');
  const how = s.markdownOnly && s.promptOnly ? '只改显示和发给 AI 的' : s.markdownOnly ? '只改显示' : s.promptOnly ? '只改发给 AI 的' : '改存下来的消息';
  return `（${where}，${how}）`;
}

function blankEntry(uid: string): LoreEntry {
  return {
    uid,
    comment: '',
    keys: [],
    secondaryKeys: [],
    logic: 'and_any',
    content: '',
    constant: false,
    enabled: true,
    position: 'before_char',
    depth: 4,
    role: 'system',
    order: 100,
    probability: 100,
    useProbability: true,
    scanDepth: null,
    caseSensitive: null,
    matchWholeWords: null,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    preventRecursion: false,
    excludeRecursion: false,
    delayUntilRecursion: false,
    ignoreBudget: false,
    triggers: [],
    sticky: 0,
    cooldown: 0,
    delay: 0,
  };
}

/** 世界书条目的字段：返回改了哪些格式字段（中文），内容另算 */
function patchEntry(e: LoreEntry, f: Obj): string[] {
  const done: string[] = [];
  const comment = str(f.comment) ?? str(f.title);
  if (comment !== undefined && comment !== e.comment) (e.comment = comment), done.push('标题');
  const keys = 'keys' in f ? strList(f.keys) : 'key' in f ? strList(f.key) : undefined;
  if (keys && keys.join('|') !== e.keys.join('|')) (e.keys = keys), done.push(`关键词 ${keys.join('、') || '（空）'}`);
  const secondary = strList(f.secondaryKeys);
  if (secondary && secondary.join('|') !== e.secondaryKeys.join('|')) (e.secondaryKeys = secondary), done.push('次关键词');
  const constant = bool(f.constant);
  if (constant !== undefined && constant !== e.constant) (e.constant = constant), done.push(constant ? '改成常驻' : '改成关键词触发');
  const enabled = bool(f.enabled);
  if (enabled !== undefined && enabled !== e.enabled) (e.enabled = enabled), done.push(enabled ? '打开' : '关掉');
  const position = str(f.position) as LorePosition | undefined;
  if (position && POSITIONS.has(position) && position !== e.position) (e.position = position), done.push(`位置 ${position}`);
  const depth = num(f.depth);
  if (depth !== undefined && depth !== e.depth) (e.depth = depth), done.push(`深度 ${depth}`);
  const order = num(f.order);
  if (order !== undefined && order !== e.order) (e.order = order), done.push(`顺序 ${order}`);
  const role = str(f.role);
  if (role && ROLES.has(role) && role !== e.role) (e.role = role as LoreEntry['role']), done.push(`身份 ${role}`);
  const probability = num(f.probability);
  if (probability !== undefined && probability !== e.probability) (e.probability = probability), done.push(`概率 ${probability}`);
  return done;
}

function entryLabel(e: LoreEntry): string {
  return `「${e.comment || e.keys.slice(0, 2).join('、') || e.uid}」`;
}

function nextUid(book: Lorebook): string {
  const n = book.entries.reduce((m, e) => Math.max(m, Number(e.uid) || 0), -1);
  return String(n + 1);
}

function planLorebook(b: Lorebook, op: AssistantOp, changes: EditChange[], selection: EditSelectionContext): string | null {
  const r = op.raw;
  const title = b.name;
  const change = (label: string, textChanged = false, before?: string, after?: string) =>
    changes.push({ kind: 'lorebook', id: b.id, title, label, textChanged, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  const findEntry = (id: unknown) => {
    const key = str(id)?.trim();
    const entry = key ? (b.entries.find((e) => e.uid === key) ?? b.entries.find((e) => e.comment === key)) : undefined;
    if (entry) requireOwner(selection, b.id, 'entry', entry.uid);
    return entry;
  };
  switch (op.op) {
    case 'replace': {
      const e = findEntry(r.entry);
      if (!e) return `世界书「${title}」里没有条目「${str(r.entry) ?? ''}」`;
      const find = str(r.find) ?? '';
      const next = replaceIn(e.content, find, str(r.with) ?? str(r.replace) ?? '', bool(r.all) === true);
      if (next === null) return `世界书「${title}」的条目${entryLabel(e)}里找不到要换的那段：「${find.slice(0, 40)}」`;
      const d = diffSnippet(e.content, next);
      change(`改条目${entryLabel(e)}的一段`, isTextChange(e.content, next), d.before, d.after);
      e.content = next;
      return null;
    }
    case 'set': {
      const e = findEntry(r.entry);
      if (!e) return `世界书「${title}」里没有条目「${str(r.entry) ?? ''}」`;
      const f = fieldsOf(r, ['lorebook', 'op', 'entry']);
      const done = patchEntry(e, f);
      const content = str(f.content);
      if (content !== undefined && content !== e.content) {
        const d = diffSnippet(e.content, content);
        change(`改条目${entryLabel(e)}的内容${done.length ? `，${done.join('、')}` : ''}`, isTextChange(e.content, content), d.before, d.after);
        e.content = content;
      } else if (done.length) change(`条目${entryLabel(e)}：${done.join('、')}`);
      else return `条目${entryLabel(e)}没有要改的`;
      return null;
    }
    case 'add': {
      const f = isObj(r.entry) ? r.entry : fieldsOf(r, ['lorebook', 'op']);
      const e = blankEntry(selection.entryUid ?? nextUid(b));
      patchEntry(e, f);
      e.content = str(f.content) ?? '';
      b.entries.push(e);
      change(`加条目${entryLabel(e)}${e.constant ? '（常驻）' : e.keys.length ? `（关键词 ${e.keys.join('、')}）` : ''}`, false, undefined, e.content);
      selection.owners.set(ownerKey(b.id, 'entry', e.uid), selection.key);
      return null;
    }
    case 'remove': {
      const e = findEntry(r.entry);
      if (!e) return `世界书「${title}」里没有条目「${str(r.entry) ?? ''}」`;
      b.entries.splice(b.entries.indexOf(e), 1);
      change(`删掉条目${entryLabel(e)}`, !!e.content.trim(), e.content);
      return null;
    }
    case 'meta': {
      const f = fieldsOf(r, ['lorebook', 'op']);
      const done: string[] = [];
      if (str(f.name)?.trim() && str(f.name) !== b.name) (b.name = str(f.name)!.trim()), done.push(`名字改成「${b.name}」`);
      if (str(f.description) !== undefined && str(f.description) !== b.description) (b.description = str(f.description)!), done.push('改说明');
      if (!done.length) return `世界书「${title}」没有要改的`;
      change(done.join('、'));
      return null;
    }
  }
  return `世界书不认识 op「${op.op}」`;
}

/** 角色卡里助手能改的字段（ST 的蛇形写法也认） */
const CARD_TEXT: Record<string, keyof StCardFields> = {
  description: 'description',
  personality: 'personality',
  scenario: 'scenario',
  firstMes: 'firstMes',
  first_mes: 'firstMes',
  mesExample: 'mesExample',
  mes_example: 'mesExample',
  systemPrompt: 'systemPrompt',
  system_prompt: 'systemPrompt',
  postHistoryInstructions: 'postHistoryInstructions',
  post_history_instructions: 'postHistoryInstructions',
  creatorNotes: 'creatorNotes',
  creator_notes: 'creatorNotes',
};
const CARD_LISTS: Record<string, 'alternateGreetings' | 'tags'> = { alternateGreetings: 'alternateGreetings', alternate_greetings: 'alternateGreetings', tags: 'tags' };
const TOP_TEXT = ['name', 'appearanceTags', 'negativeTags'] as const;
export const CHARACTER_FIELD_LABELS: Record<string, string> = {
  name: '名字',
  pronoun: '称呼',
  description: '描述',
  personality: '性格',
  scenario: '场景',
  firstMes: '开场白',
  alternateGreetings: '备选开场白',
  mesExample: '示例对话',
  systemPrompt: '角色卡的系统提示',
  postHistoryInstructions: '角色卡的后置指令',
  creatorNotes: '作者备注',
  tags: '标签',
  appearanceTags: '外观 tags',
  negativeTags: '负面 tags',
};

/** 把字段写进角色（返回改了的字段：名字、改之前、改之后） */
function patchCharacter(c: Character, f: Obj): { field: string; before: string; after: string }[] {
  const done: { field: string; before: string; after: string }[] = [];
  for (const [k, v] of Object.entries(f)) {
    const text = str(v);
    if (k in CARD_TEXT && text !== undefined) {
      const key = CARD_TEXT[k]!;
      const before = String(c.card[key] ?? '');
      if (before !== text) {
        (c.card as unknown as Obj)[key] = text;
        done.push({ field: key, before, after: text });
      }
    } else if (k in CARD_LISTS) {
      const list = Array.isArray(v) ? v.map((x) => str(x) ?? '').filter((s) => s.trim()) : strList(v);
      const key = CARD_LISTS[k]!;
      if (list && list.join('\n') !== c.card[key].join('\n')) {
        done.push({ field: key, before: c.card[key].join('\n—\n'), after: list.join('\n—\n') });
        c.card[key] = list;
      }
    } else if ((TOP_TEXT as readonly string[]).includes(k) && text !== undefined) {
      const key = k as (typeof TOP_TEXT)[number];
      if (key === 'name' && !text.trim()) continue;
      if (c[key] !== text) {
        done.push({ field: key, before: c[key], after: text });
        c[key] = text;
      }
    } else if (k === 'pronoun' && (v === '她' || v === '他' || v === 'Ta' || v === 'TA') && c.pronoun !== (v === 'TA' ? 'Ta' : v)) {
      const pronoun = v === 'TA' ? 'Ta' : v;
      done.push({ field: 'pronoun', before: c.pronoun, after: pronoun });
      c.pronoun = pronoun;
    }
  }
  return done;
}

function planCharacter(c: Character, op: AssistantOp, changes: EditChange[], selection: EditSelectionContext): string | null {
  const r = op.raw;
  const title = c.name;
  if (op.op === 'replace') {
    const raw = str(r.field) ?? '';
    const top = raw === 'appearanceTags' || raw === 'negativeTags' ? raw : null;
    const cardKey = CARD_TEXT[raw];
    const key: string | undefined = top ?? cardKey;
    if (!key) return `角色「${title}」没有能按段改的字段「${raw}」`;
    const before = top ? c[top] : String(c.card[cardKey!] ?? '');
    const next = replaceIn(before, str(r.find) ?? '', str(r.with) ?? str(r.replace) ?? '', bool(r.all) === true);
    if (next === null) return `角色「${title}」的${CHARACTER_FIELD_LABELS[key] ?? key}里找不到要换的那段：「${(str(r.find) ?? '').slice(0, 40)}」`;
    if (top) c[top] = next;
    else (c.card as unknown as Obj)[cardKey!] = next;
    const d = diffSnippet(before, next);
    changes.push({ kind: 'character', id: c.id, title, label: `改${CHARACTER_FIELD_LABELS[key] ?? key}的一段`, textChanged: isTextChange(before, next), before: d.before, after: d.after });
    return null;
  }
  const done = Object.entries(fieldsOf(r, ['character', 'op'])).flatMap(([field, value]) =>
    partSelected(selection, `field:${field}`) ? patchCharacter(c, { [field]: value }).map((d) => ({ ...d, key: partKey(selection, `field:${field}`) })) : [],
  );
  if (!done.length) return `角色「${title}」没有要改的`;
  for (const d of done) {
    changes.push({
      key: d.key,
      kind: 'character',
      id: c.id,
      title,
      label: `${d.before.trim() ? '改' : '补上'}${CHARACTER_FIELD_LABELS[d.field] ?? d.field}`,
      // 补空着的字段不算动了原文
      textChanged: !!d.before.trim() && isTextChange(d.before, d.after),
      before: d.before || undefined,
      after: d.after,
    });
  }
  return null;
}

/**
 * 照修改项算出改之后的样子（不动传进来的对象，改的是副本）。
 * 找不到的对象、块、条目、要换的那段记进 errors，其余照常算。
 */
/** 照一个预设复制出新预设（预设融合）：名字、说明、分类（角色扮演类之间可以换）按 op 写的 */
function createPreset(op: AssistantOp, ctx: PlanContext, presetOf: (id: string) => Preset | undefined): { preset: Preset; label: string } | string {
  const f = fieldsOf(op.raw, ['preset', 'op']);
  const fromId = str(f.from)?.trim();
  const base = fromId ? presetOf(fromId) : undefined;
  if (!base) return fromId ? `没有 id 是「${fromId}」的预设，新预设没法照它复制` : '新预设要写 from：照哪个预设复制（底子的 id）';
  const want = str(f.category)?.trim() as PresetCategory | undefined;
  const category = want && PRESET_CATEGORIES[want] && canBecome(base.category, want) ? want : base.category;
  const { seedFile: _seed, ...rest } = clone(base);
  const preset: Preset = {
    ...rest,
    id: ctx.newId('preset'),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    name: str(f.name)?.trim() || `${base.name}（融合）`,
    description: str(f.description) ?? base.description,
    category,
  };
  const label = `新建${PRESET_CATEGORIES[category].label}预设「${preset.name}」（照「${base.name}」复制${want && want !== category ? `；分类「${want}」换不了，还是${PRESET_CATEGORIES[category].label}` : ''}）`;
  return { preset, label };
}

/** 不传 selected 时预览全部；传入预览项的 key 时只把所选修改写入副本。 */
export function planEdits(ops: AssistantOp[], ctx: PlanContext, selected?: ReadonlySet<string>): EditPlan {
  const plan: EditPlan = { fighters: [], presets: [], lorebooks: [], characters: [], newCharacters: [], newLorebooks: [], newPresets: [], bindings: [], changes: [], errors: [] };
  const fighters = new Map<string, BrawlFighter>();
  const presets = new Map<string, Preset>();
  const books = new Map<string, Lorebook>();
  const chars = new Map<string, Character>();
  const owners = new Map<string, string>();
  // 新条目的编号按原操作顺序分配；取消前面的新增项不能把后续修改指向别的条目。
  const entryUids = new Map(ctx.lorebooks.map((b) => [b.id, Number(nextUid(b))]));
  const selectedOps = selected && new Set([...selected].map((key) => key.split(':')[0]));
  const working = <T extends { id: string }>(map: Map<string, T>, list: T[], id: string): T | undefined => {
    if (!map.has(id)) {
      const src = list.find((x) => x.id === id);
      if (!src) return undefined;
      map.set(id, clone(src));
    }
    return map.get(id);
  };
  let lastNewChar: Character | null = null;
  /** 预设按 id 找：这次新建的、改到一半的、库里的（复制的来源按现在改到的样子） */
  const presetOf = (id: string): Preset | undefined => {
    if (id === 'new') return plan.newPresets.at(-1);
    return plan.newPresets.find((x) => x.id === id) ?? presets.get(id) ?? ctx.presets.find((x) => x.id === id);
  };
  for (const [index, op] of ops.entries()) {
    const key = String(index);
    const entryUid = op.kind === 'lorebook' && op.op === 'add' ? entryUids.get(op.id) : undefined;
    if (entryUid !== undefined) entryUids.set(op.id, entryUid + 1);
    if (selectedOps && !selectedOps.has(key)) continue;
    const selection: EditSelectionContext = { key, selected, requires: new Set(), owners, entryUid: entryUid?.toString() };
    const start = plan.changes.length;
    const sourcePreset = (id: string) => {
      const p = presetOf(id);
      if (p) requireOwner(selection, p.id);
      return p;
    };
    let error: string | null = null;
    if (op.kind === 'fighter') {
      const f = working(fighters, ctx.fighters ?? [], op.id);
      if (!f) error = `没有 id 是「${op.id}」的战斗档案，先在大乱斗打开角色的档案`;
      else {
        const fields = fieldsOf(op.raw, ['fighter', 'op', 'slot']);
        let patch: Record<string, unknown> = fields;
        const slot = num(op.raw.slot);
        if (op.op === 'skill') {
          if (slot !== 1 && slot !== 2 && slot !== 3) error = '技能位置 slot 写 1、2 或 3（3 是奥义）';
          else patch = { skills: f.skills.map((s, i) => i === slot - 1 ? { ...s, ...fields } : s) };
        }
        if (!error) {
          const next = readBrawlFighter(patch, f);
          const before = JSON.stringify(f, null, 2), after = JSON.stringify(next, null, 2);
          if (before !== after) {
            const diff = diffSnippet(before, after, 100);
            plan.changes.push({ kind: 'fighter', id: f.id, title: f.name, label: op.op === 'skill' ? `调整${slot === 3 ? '奥义' : `技能${slot}`}` : '调整战斗属性与配招', textChanged: false, ...diff });
            Object.assign(f, next, { source: 'manual', updatedAt: ctx.now });
          }
        }
      }
    } else if (op.kind === 'preset' && op.op === 'create') {
      const created = createPreset(op, ctx, sourcePreset);
      if (typeof created === 'string') error = created;
      else {
        plan.newPresets.push(created.preset);
        plan.changes.push({ kind: 'preset', id: created.preset.id, title: created.preset.name, label: created.label, textChanged: false });
        owners.set(ownerKey(created.preset.id), key);
      }
    } else if (op.kind === 'preset') {
      const p = op.id === 'new' ? plan.newPresets.at(-1) : (plan.newPresets.find((x) => x.id === op.id) ?? working(presets, ctx.presets, op.id));
      if (p) requireOwner(selection, p.id);
      error = p ? planPreset(p, op, ctx, plan.changes, sourcePreset, selection) : op.id === 'new' ? '还没有新建的预设：先写 {"preset": "new", "op": "create", "from": "底子的 id"}' : `没有 id 是「${op.id}」的预设`;
    } else if (op.kind === 'lorebook') {
      if (op.op === 'create') {
        const f = fieldsOf(op.raw, ['lorebook', 'op', 'bindTo', 'entries']);
        const book: Lorebook = {
          id: ctx.newId('lb'),
          createdAt: ctx.now,
          updatedAt: ctx.now,
          name: str(f.name)?.trim() || '助手写的世界书',
          description: str(f.description) ?? '',
          scanDepth: 4,
          tokenBudget: 0,
          recursive: false,
          entries: [],
        };
        for (const raw of Array.isArray(op.raw.entries) ? op.raw.entries : []) {
          if (!isObj(raw)) continue;
          const e = blankEntry(nextUid(book));
          patchEntry(e, raw);
          e.content = str(raw.content) ?? '';
          book.entries.push(e);
        }
        plan.newLorebooks.push(book);
        const bindTo = str(op.raw.bindTo)?.trim();
        const target = bindTo === 'new' ? lastNewChar : bindTo ? (working(chars, ctx.characters, bindTo) ?? null) : null;
        if (bindTo && !target) error = `世界书「${book.name}」要绑的角色「${bindTo}」找不到，先不绑`;
        if (target) {
          requireOwner(selection, target.id);
          target.lorebookIds = [...target.lorebookIds, book.id];
          plan.bindings.push({ lorebookId: book.id, characterId: target.id });
        }
        plan.changes.push({
          kind: 'lorebook',
          id: book.id,
          title: book.name,
          label: `新建世界书「${book.name}」（${book.entries.length} 条）${target ? `，绑给${target.name}` : ''}`,
          textChanged: false,
          after: book.entries.map((e) => `${entryLabel(e)}${e.constant ? '（常驻）' : `（${e.keys.join('、')}）`}\n${e.content}`).join('\n\n'),
        });
      } else {
        const b = working(books, ctx.lorebooks, op.id);
        error = b ? planLorebook(b, op, plan.changes, selection) : `没有 id 是「${op.id}」的世界书`;
      }
    } else if (op.op === 'create') {
      const f = fieldsOf(op.raw, ['character', 'op']);
      const name = str(f.name)?.trim();
      if (!name) error = '新角色没写名字';
      else {
        const card: StCardFields = {
          description: '',
          personality: '',
          scenario: '',
          firstMes: '',
          alternateGreetings: [],
          mesExample: '',
          systemPrompt: '',
          postHistoryInstructions: '',
          creatorNotes: '',
          tags: [],
          creator: '',
          characterVersion: '',
          extensions: {},
          extra: {},
        };
        const c = characterFromCard({ spec: 'v3', source: 'json', name, card, book: null, warnings: [] }, { id: ctx.newId('char'), now: ctx.now, lorebookIds: [], presetId: ctx.defaultPresetId });
        patchCharacter(c, f);
        plan.newCharacters.push(c);
        lastNewChar = c;
        owners.set(ownerKey(c.id), key);
        const filled = Object.keys(CHARACTER_FIELD_LABELS).filter((k) => k !== 'name' && (k in c.card ? String((c.card as unknown as Obj)[k] ?? '').trim() : String((c as unknown as Obj)[k] ?? '').trim()));
        plan.changes.push({
          kind: 'character',
          id: c.id,
          title: c.name,
          label: `新建角色「${c.name}」（${filled.map((k) => CHARACTER_FIELD_LABELS[k]).join('、') || '只有名字'}）`,
          textChanged: false,
          after: [c.card.description, c.card.personality && `性格：${c.card.personality}`, c.card.scenario && `场景：${c.card.scenario}`, c.card.firstMes && `开场白：${c.card.firstMes}`]
            .filter(Boolean)
            .join('\n\n'),
        });
      }
    } else {
      const c = op.id === 'new' ? (lastNewChar ?? undefined) : working(chars, ctx.characters, op.id);
      if (c) requireOwner(selection, c.id);
      error = c ? planCharacter(c, op, plan.changes, selection) : `没有 id 是「${op.id}」的角色`;
    }
    for (const change of plan.changes.slice(start)) {
      change.key ??= key;
      change.requires ??= [...selection.requires];
    }
    if (error) plan.errors.push(error);
  }
  const newCharIds = new Set(plan.newCharacters.map((c) => c.id));
  plan.presets = [...presets.values()];
  plan.lorebooks = [...books.values()];
  plan.characters = [...chars.values()].filter((c) => !newCharIds.has(c.id));
  plan.fighters = [...fighters.values()];
  return plan;
}
