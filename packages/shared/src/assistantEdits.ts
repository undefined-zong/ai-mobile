import { characterFromCard } from './st/card.ts';
import { normalizeRegexScript, regexFromString } from './st/regex.ts';
import type { Character, StCardFields } from './types/character.ts';
import type { LoreEntry, LorePosition, Lorebook } from './types/lorebook.ts';
import { appBlocks } from './st/preset.ts';
import { markerName, type Preset, type PromptBlock, type RegexScript } from './types/preset.ts';
import { readBrawlFighter, type BrawlFighter } from './brawl.ts';

/**
 * "我的 → 助手"改东西的写法（写在"助手"预设的"修改的写法"那块里，助手照着写）：
 * 回复最后一段 <edits>[…]</edits>，里面是 JSON 数组，一项一个修改：
 *   {"preset": "id", "op": "replace", "block": "main", "find": "原文", "with": "新的"}
 *   {"lorebook": "id", "op": "set", "entry": "3", "keys": ["…"]}
 *   {"character": "new", "op": "create", "name": "…", "description": "…"}
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
  preset: ['replace', 'set', 'add', 'remove', 'move', 'add-regex', 'set-regex', 'remove-regex', 'meta'],
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
  /** 流式时：<edits> 还没写完 */
  pending: boolean;
}

// 最里层的一对（说明文字里提到 <edits> 这个词时，不会把说明当成修改）
const EDITS_RE = /<edits>((?:(?!<edits>)[\s\S])*?)<\/edits>/gi;
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
  let text = raw.replace(EDITS_RE, (_m, body: string) => {
    try {
      ops.push(...opsFrom(looseJson(body), errors));
    } catch (e) {
      errors.push(`<edits> 不是有效的 JSON：${e instanceof Error ? e.message : String(e)}`);
    }
    return '';
  });
  let pending = false;
  const open = text.toLowerCase().lastIndexOf('<edits>');
  const rest = open >= 0 ? text.slice(open + 7) : '';
  // 后面紧跟着 JSON（或者什么都还没有）的才是修改：写完了但忘了 </edits> 的照样读，没写完的（流式时）先藏起来
  if (open >= 0 && /^\s*(?:```(?:json)?\s*)?(?:[[{]|$)/i.test(rest)) {
    text = text.slice(0, open);
    try {
      ops.push(...opsFrom(looseJson(rest), errors));
    } catch {
      pending = true;
    }
  } else {
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

function planPreset(p: Preset, op: AssistantOp, ctx: PlanContext, changes: EditChange[]): string | null {
  const r = op.raw;
  const title = p.name;
  const change = (label: string, textChanged = false, before?: string, after?: string) =>
    changes.push({ kind: 'preset', id: p.id, title, label, textChanged, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  const findBlock = (id: unknown) => {
    const key = str(id)?.trim();
    return key ? (p.blocks.find((b) => b.identifier === key) ?? p.blocks.find((b) => b.name === key)) : undefined;
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
      return null;
    }
    case 'set-regex': {
      const key = str(r.regex) ?? str(r.id);
      const s = p.regex.find((x) => x.id === key) ?? p.regex.find((x) => x.name === key);
      if (!s) return `预设「${title}」里没有正则「${key ?? ''}」`;
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
      p.regex.splice(p.regex.indexOf(s), 1);
      change(`删掉正则「${s.name}」`, false, `${s.find} → ${s.replace}`);
      return null;
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

function planLorebook(b: Lorebook, op: AssistantOp, changes: EditChange[]): string | null {
  const r = op.raw;
  const title = b.name;
  const change = (label: string, textChanged = false, before?: string, after?: string) =>
    changes.push({ kind: 'lorebook', id: b.id, title, label, textChanged, ...(before !== undefined ? { before } : {}), ...(after !== undefined ? { after } : {}) });
  const findEntry = (id: unknown) => {
    const key = str(id)?.trim();
    return key ? (b.entries.find((e) => e.uid === key) ?? b.entries.find((e) => e.comment === key)) : undefined;
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
      const e = blankEntry(nextUid(b));
      patchEntry(e, f);
      e.content = str(f.content) ?? '';
      b.entries.push(e);
      change(`加条目${entryLabel(e)}${e.constant ? '（常驻）' : e.keys.length ? `（关键词 ${e.keys.join('、')}）` : ''}`, false, undefined, e.content);
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

function planCharacter(c: Character, op: AssistantOp, changes: EditChange[]): string | null {
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
  const done = patchCharacter(c, fieldsOf(r, ['character', 'op']));
  if (!done.length) return `角色「${title}」没有要改的`;
  for (const d of done) {
    changes.push({
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
export function planEdits(ops: AssistantOp[], ctx: PlanContext): EditPlan {
  const plan: EditPlan = { fighters: [], presets: [], lorebooks: [], characters: [], newCharacters: [], newLorebooks: [], bindings: [], changes: [], errors: [] };
  const fighters = new Map<string, BrawlFighter>();
  const presets = new Map<string, Preset>();
  const books = new Map<string, Lorebook>();
  const chars = new Map<string, Character>();
  const working = <T extends { id: string }>(map: Map<string, T>, list: T[], id: string): T | undefined => {
    if (!map.has(id)) {
      const src = list.find((x) => x.id === id);
      if (!src) return undefined;
      map.set(id, clone(src));
    }
    return map.get(id);
  };
  let lastNewChar: Character | null = null;
  for (const op of ops) {
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
    } else if (op.kind === 'preset') {
      const p = working(presets, ctx.presets, op.id);
      error = p ? planPreset(p, op, ctx, plan.changes) : `没有 id 是「${op.id}」的预设`;
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
          tokenBudget: 2048,
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
        error = b ? planLorebook(b, op, plan.changes) : `没有 id 是「${op.id}」的世界书`;
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
      error = c ? planCharacter(c, op, plan.changes) : `没有 id 是「${op.id}」的角色`;
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
