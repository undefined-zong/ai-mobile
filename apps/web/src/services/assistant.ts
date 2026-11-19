import { samplerRequest } from '@app/ai';
import {
  assembleTaskPrompt,
  checkCharacter,
  checkLorebook,
  checkPreset,
  FORMAT_LEVELS,
  formatGuide,
  parseAssistantReply,
  planEdits,
  PRESET_CATEGORIES,
  worstLevel,
  type AssistantOp,
  type BrawlFighter,
  type Character,
  type EditKind,
  type EditPlan,
  type FormatIssue,
  type FormatLevel,
  type Lorebook,
  type Preset,
  type PresetCategory,
} from '@app/shared';
import { useAiStore } from '@/stores/ai';
import { useAssistantStore, type AssistantMerge, type AssistantMessage, type AssistantMode, type AssistantTarget, type AssistantUndo } from '@/stores/assistant';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { isDemoRecord, useLibraryStore } from '@/stores/library';
import { usePersonaStore } from '@/stores/personas';
import { uid } from '@/utils/id';
import { defaultPresetId } from './importer';
import { MissingPresetError } from './prompt';
import { useBrawlStore } from '@/stores/brawl';
import { brawlMaterial } from './brawl';

/**
 * "我的 → 助手"：检测预设、世界书、角色卡和 App 的格式合不合（packages/shared/src/formats.ts），
 * 把要看的对象、程序检测到的问题、特殊格式和参照的自带预设填进"助手"预设（用途 assistant），调"助手"的 API；
 * 助手回复里的 <edits> 读成修改项（assistantEdits.ts），先给你看改之前 / 改之后，你点"应用"才写进去，能撤销。
 */

export const KIND_LABEL: Record<EditKind, string> = { preset: '预设', lorebook: '世界书', character: '角色卡', fighter: '战斗档案' };
export const MODE_LABEL: Record<AssistantMode, string> = { check: '一键检测', card: '做角色卡 / 补全设定', merge: '预设融合' };

/** 发给助手的对象 JSON 最多多少字：超了就把长的块、条目从后面截掉（写明还有多少字没给） */
const TARGET_BUDGET = 60_000;
const MIN_CAP = 300;
/** 对话最多带最近几条 */
const CHAT_KEEP = 12;

export function assistantStatus(): { live: boolean; reason: string } {
  const s = useAiStore().status('assistant');
  return s.live ? { live: true, reason: '' } : { live: false, reason: `「助手」还没接通：${s.reason}` };
}

type Subject = { kind: 'preset'; obj: Preset } | { kind: 'lorebook'; obj: Lorebook } | { kind: 'character'; obj: Character } | { kind: 'fighter'; obj: BrawlFighter };

export function subjectOf(t: AssistantTarget): Subject | null {
  if (t.kind === 'fighter') {
    const obj = useBrawlStore().byId(t.id);
    return obj ? { kind: 'fighter', obj } : null;
  }
  if (t.kind === 'preset') {
    const obj = useLibraryStore().presetById(t.id);
    return obj ? { kind: 'preset', obj } : null;
  }
  if (t.kind === 'lorebook') {
    const obj = useLibraryStore().lorebookById(t.id);
    return obj ? { kind: 'lorebook', obj } : null;
  }
  const obj = useCharacterStore().byId(t.id);
  return obj ? { kind: 'character', obj } : null;
}

/** 导入的（不是 App 自带、演示的）：自带预设复制出来的、助手新建的也算 */
export function isImported(t: AssistantTarget): boolean {
  if (t.kind === 'fighter') return true;
  if (t.kind === 'preset') return !useLibraryStore().presetById(t.id)?.seedFile;
  if (t.kind === 'lorebook') return !isDemoRecord(t.id);
  return !useCharacterStore().isDemo(t.id);
}

export function linkOf(t: AssistantTarget): string {
  if (t.kind === 'fighter') return `/scene/game?g=brawl&fighter=${encodeURIComponent(t.id)}`;
  return t.kind === 'preset' ? `/me/presets/${t.id}` : t.kind === 'lorebook' ? `/me/lorebooks/${t.id}` : `/me/characters/${t.id}`;
}

function boundTo(bookId: string): string[] {
  return useCharacterStore()
    .list.filter((c) => c.lorebookIds.includes(bookId))
    .map((c) => c.name);
}

/** 预设用在哪：用途的名字；对话预设还有哪些角色在用 */
function presetUsedFor(p: Preset): string[] {
  const lib = useLibraryStore();
  const out = lib.usesOf(p.id).map((u) => u.label);
  if (p.category === 'chat') for (const c of useCharacterStore().list) if (lib.chatPresetFor(c)?.id === p.id) out.push(`${c.name}的对话`);
  return out;
}

export function issuesOf(t: AssistantTarget): FormatIssue[] {
  const s = subjectOf(t);
  if (!s) return [];
  if (s.kind === 'fighter') return [];
  if (s.kind === 'preset') {
    const lib = useLibraryStore();
    const reference = lib.referenceFor(s.obj);
    const issues = checkPreset(s.obj, { reference, knownMarkers: lib.knownMarkersOf(s.obj.category) });
    if (!reference && s.obj.category === 'feature') {
      issues.unshift({ level: 'info', code: 'unused', message: '还没用在哪件事上：不知道按哪件事的格式查，只查了通用的（在"预设"页给它选好用途再检测）' });
    }
    return issues;
  }
  if (s.kind === 'lorebook') {
    const issues = checkLorebook(s.obj);
    if (!boundTo(s.obj.id).length) issues.unshift({ level: 'info', code: 'unbound', message: '还没绑给哪个角色：在角色页里绑上才生效' });
    return issues;
  }
  return checkCharacter(s.obj);
}

export interface TargetInfo {
  target: AssistantTarget;
  name: string;
  /** 小字：预设的分类和用途、世界书的条目数和绑给谁、角色卡的情况 */
  sub: string;
  imported: boolean;
  createdAt: number;
  issues: FormatIssue[];
  level: FormatLevel | null;
}

export function targetInfo(t: AssistantTarget): TargetInfo | null {
  const s = subjectOf(t);
  if (!s) return null;
  const issues = issuesOf(t);
  let sub: string;
  if (s.kind === 'preset') {
    const used = presetUsedFor(s.obj);
    sub = `${PRESET_CATEGORIES[s.obj.category].label}预设 · ${s.obj.blocks.length} 块${s.obj.regex.length ? ` · 正则 ${s.obj.regex.length}` : ''}${used.length ? ` · 用在${used.slice(0, 2).join('、')}${used.length > 2 ? '等' : ''}` : ''}`;
  } else if (s.kind === 'lorebook') {
    const who = boundTo(s.obj.id);
    sub = `${s.obj.entries.length} 条${who.length ? ` · 绑给${who.join('、')}` : ' · 没绑角色'}`;
  } else if (s.kind === 'fighter') {
    sub = `${s.obj.hp} 血量 · ${s.obj.mp} 蓝量 · ${s.obj.skills.map(k => k.name).join('、')}`;
  } else {
    sub = `${[...s.obj.card.description].length} 字描述${s.obj.lorebookIds.length ? ` · 世界书 ${s.obj.lorebookIds.length}` : ''}`;
  }
  return { target: t, name: s.obj.name, sub, imported: isImported(t), createdAt: s.obj.createdAt, issues, level: worstLevel(issues) };
}

/** 所有导入的预设、世界书、角色卡 */
export function importedTargets(): AssistantTarget[] {
  const lib = useLibraryStore();
  const chars = useCharacterStore();
  return [
    ...lib.presets.filter((p) => !p.seedFile).map((p): AssistantTarget => ({ kind: 'preset', id: p.id })),
    ...lib.lorebooks.filter((b) => !isDemoRecord(b.id)).map((b): AssistantTarget => ({ kind: 'lorebook', id: b.id })),
    ...chars.list.filter((c) => !chars.isDemo(c.id)).map((c): AssistantTarget => ({ kind: 'character', id: c.id })),
  ];
}

const LEVEL_ORDER: (FormatLevel | null)[] = ['error', 'warn', 'info', null];

export interface ScanResult {
  /** 只看了上次检测之后导入的（没有新导入的时看全部） */
  onlyNew: boolean;
  rows: TargetInfo[];
  at: number;
}

/** 一键检测：上次检测之后导入的；没有新导入的就查全部导入的。查完记下时间 */
export function scanImports(): ScanResult {
  const store = useAssistantStore();
  const all = importedTargets()
    .map(targetInfo)
    .filter((x): x is TargetInfo => !!x);
  const fresh = all.filter((x) => x.createdAt > store.lastScanAt);
  const rows = (fresh.length ? fresh : all).sort((a, b) => LEVEL_ORDER.indexOf(a.level) - LEVEL_ORDER.indexOf(b.level) || b.createdAt - a.createdAt);
  const at = Date.now();
  store.lastScanAt = at;
  return { onlyNew: fresh.length > 0 && fresh.length < all.length, rows, at };
}

/** 有"不适配"或"可能不适配"的 */
export function needsFix(row: TargetInfo): boolean {
  return row.level === 'error' || row.level === 'warn';
}

// —— 拼给助手的输入 ——

/** 长文字截到多长，才能让所有对象一共不超过 budget（短的照全文给） */
function fitCap(lengths: number[], budget: number): number {
  const sorted = [...lengths].sort((a, b) => a - b);
  let rest = budget;
  for (let i = 0; i < sorted.length; i++) {
    const n = sorted.length - i;
    if (sorted[i]! * n <= rest) {
      rest -= sorted[i]!;
      continue;
    }
    return Math.max(MIN_CAP, Math.floor(rest / n));
  }
  return Number.POSITIVE_INFINITY;
}

function clip(text: string, cap: number): string {
  return text.length > cap ? `${text.slice(0, cap)}（后面还有 ${text.length - cap} 字没给）` : text;
}

function texts(s: Subject): string[] {
  if (s.kind === 'fighter') return [s.obj.title, ...s.obj.skills.map(k => k.description)];
  if (s.kind === 'preset') return [...s.obj.blocks.map((b) => b.content), ...s.obj.regex.map((r) => r.replace)];
  if (s.kind === 'lorebook') return s.obj.entries.map((e) => e.content);
  const c = s.obj.card;
  return [c.description, c.personality, c.scenario, c.firstMes, c.mesExample, c.systemPrompt, c.postHistoryInstructions, c.creatorNotes, ...c.alternateGreetings];
}

function subjectJson(s: Subject, cap: number): Record<string, unknown> {
  if (s.kind === 'fighter') return { type: 'fighter', ...s.obj, material: brawlMaterial(s.obj) };
  if (s.kind === 'preset') {
    const p = s.obj;
    return {
      type: 'preset',
      id: p.id,
      name: p.name,
      category: p.category,
      categoryLabel: PRESET_CATEGORIES[p.category].label,
      usedFor: presetUsedFor(p),
      from: p.seedFile ? `App 自带（${p.seedFile}）` : p.source?.kind === 'sillytavern' ? `从 SillyTavern 导入${p.source.fileName ? `（${p.source.fileName}）` : ''}` : '导入或复制的',
      description: p.description,
      blocks: p.blocks.map((b) => ({
        identifier: b.identifier,
        name: b.name,
        role: b.role,
        enabled: b.enabled,
        ...(b.marker ? { marker: true } : { content: clip(b.content, cap) }),
        ...(b.triggers?.length ? { triggers: b.triggers } : {}),
        ...(b.injection.position === 'absolute' ? { position: 'absolute', depth: b.injection.depth } : {}),
      })),
      regex: p.regex.map((r) => ({
        id: r.id,
        name: r.name,
        find: r.find,
        replace: clip(r.replace, cap),
        placement: r.placement,
        enabled: r.enabled,
        ...(r.markdownOnly ? { markdownOnly: true } : {}),
        ...(r.promptOnly ? { promptOnly: true } : {}),
      })),
    };
  }
  if (s.kind === 'lorebook') {
    const b = s.obj;
    return {
      type: 'lorebook',
      id: b.id,
      name: b.name,
      description: b.description,
      boundTo: boundTo(b.id),
      entries: b.entries.map((e) => ({
        uid: e.uid,
        comment: e.comment,
        keys: e.keys,
        ...(e.secondaryKeys.length ? { secondaryKeys: e.secondaryKeys } : {}),
        constant: e.constant,
        enabled: e.enabled,
        position: e.position,
        ...(e.position === 'at_depth' ? { depth: e.depth, role: e.role } : {}),
        order: e.order,
        content: clip(e.content, cap),
      })),
    };
  }
  const c = s.obj;
  const lib = useLibraryStore();
  const regex = c.card.extensions?.regex_scripts;
  return {
    type: 'character',
    id: c.id,
    name: c.name,
    pronoun: c.pronoun,
    description: clip(c.card.description, cap),
    personality: clip(c.card.personality, cap),
    scenario: clip(c.card.scenario, cap),
    firstMes: clip(c.card.firstMes, cap),
    alternateGreetings: c.card.alternateGreetings.map((g) => clip(g, cap)),
    mesExample: clip(c.card.mesExample, cap),
    systemPrompt: clip(c.card.systemPrompt, cap),
    postHistoryInstructions: clip(c.card.postHistoryInstructions, cap),
    creatorNotes: clip(c.card.creatorNotes, cap),
    tags: c.card.tags,
    appearanceTags: c.appearanceTags,
    negativeTags: c.negativeTags,
    ...(c.fandom?.enabled ? { fandom: { characterTag: c.fandom.characterTag, copyrightTag: c.fandom.copyrightTag } } : {}),
    lorebooks: c.lorebookIds.map((id) => ({ id, name: lib.lorebookById(id)?.name ?? '（找不到）' })),
    preset: lib.chatPresetFor(c) ? { id: lib.chatPresetFor(c)!.id, name: lib.chatPresetFor(c)!.name } : null,
    ...(Array.isArray(regex) && regex.length ? { cardRegexScripts: regex.length } : {}),
  };
}

function targetsText(subjects: Subject[]): string {
  if (!subjects.length) return '要看的对象：用户这次没选（要改东西的话请用户在上面"要看的"里选；做新角色卡不用选）。';
  const cap = fitCap(subjects.flatMap(texts).map((t) => t.length), TARGET_BUDGET);
  return `要看的对象（${subjects.length} 个）：\n${subjects.map((s) => JSON.stringify(subjectJson(s, cap))).join('\n')}`;
}

function checksText(targets: AssistantTarget[]): string {
  const lib = useLibraryStore();
  const parts: string[] = [];
  for (const t of targets) {
    const s = subjectOf(t);
    if (!s) continue;
    if (s.kind === 'fighter') continue;
    const issues = issuesOf(t);
    const ref = s.kind === 'preset' ? lib.referenceFor(s.obj) : undefined;
    const head = `【${KIND_LABEL[t.kind]}「${s.obj.name}」（${t.id}）】${ref ? `参照 App 自带的「${ref.name}」` : ''}`;
    parts.push(
      issues.length
        ? `${head}\n${issues.map((i) => `- [${FORMAT_LEVELS[i.level].label}] ${i.whereLabel ? `${i.whereLabel}${i.where && i.where !== i.whereLabel ? `（${i.where}）` : ''}：` : ''}${i.message}`).join('\n')}`
        : `${head}\n- 程序没查出问题`,
    );
  }
  return parts.length ? `程序检测到的问题：\n${parts.join('\n\n')}` : '';
}

function guideText(subjects: Subject[]): string {
  const lib = useLibraryStore();
  const presets = subjects.filter((s): s is Extract<Subject, { kind: 'preset' }> => s.kind === 'preset').map((s) => s.obj);
  const references: Preset[] = [];
  if (subjects.some(s => s.kind === 'fighter')) {
    const p = lib.presetForUse('game-brawl');
    const reference = p ? lib.referenceFor(p) : undefined;
    if (reference) references.push(reference);
  }
  for (const p of presets) {
    const r = lib.referenceFor(p);
    if (r && !references.some((x) => x.name === r.name)) references.push(r);
  }
  const categories = [...new Set(presets.map((p) => p.category))] as PresetCategory[];
  const guide = formatGuide({
    categories,
    lorebook: subjects.some((s) => s.kind === 'lorebook'),
    // 没选对象时多半是要做新角色卡：带上角色卡的字段说明
    character: subjects.some((s) => s.kind === 'character') || !subjects.length,
    references,
  });
  return guide ? `特殊格式（App 认的写法）：\n\n${guide}` : '';
}

function chatText(history: AssistantMessage[]): string {
  const recent = history.filter((m) => !m.error).slice(-CHAT_KEEP);
  if (!recent.length) return '';
  const line = (m: AssistantMessage) => {
    const who = m.role === 'user' ? '用户' : '你';
    const text = m.text.length > 1500 ? `${m.text.slice(0, 1500)}…` : m.text;
    const ops = m.ops?.length ? `（给了 ${m.ops.length} 项修改，${m.applied ? '用户点了应用' : '用户还没应用'}）` : '';
    return `${who}：${text || '（没写字）'}${ops}`;
  };
  return `最近的对话：\n${recent.map(line).join('\n\n')}`;
}

/** 预设融合选的两个预设：「名字」（id） */
function mergeText(merge: AssistantMerge | undefined): string {
  if (!merge) return '';
  const lib = useLibraryStore();
  const name = (id: string) => {
    const p = lib.presetById(id);
    return p ? `「${p.name}」（${PRESET_CATEGORIES[p.category].label}预设，id ${id}）` : `（找不到 id 是 ${id} 的预设）`;
  };
  return `用户要融合两个预设：底子是${name(merge.base)}，功能来源是${name(merge.source)}。照底子新建一个预设，把功能来源里的功能缝进去，底子和功能来源都不改。`;
}

function askText(ask: string, mode: AssistantMode | undefined, subjects: Subject[], merge?: AssistantMerge): string {
  const head =
    mode === 'merge'
      ? mergeText(merge)
      : mode === 'check'
      ? '用户点了"一键检测"：看看要看的对象哪些和 App 的格式不合，改成适配的（只改格式）。'
      : mode === 'card'
        ? subjects.some((s) => s.kind === 'character')
          ? '用户要补全角色卡的设定。'
          : '用户要做一张新角色卡。'
        : '';
  const said = ask.trim();
  return `这一次：${head}${said ? `\n用户说：${said}` : head ? '' : '用户没写话。'}`;
}

export interface AskOptions {
  ask: string;
  mode?: AssistantMode;
  /** 预设融合时选的两个预设 */
  merge?: AssistantMerge;
  targets: AssistantTarget[];
  /** 这一次之前的对话 */
  history: AssistantMessage[];
  signal?: AbortSignal;
  onText?(text: string): void;
}

/** 问助手：按"助手"预设拼好，调"助手"的 API；返回原文（<edits> 由调用方读） */
export async function askAssistant(opts: AskOptions): Promise<string> {
  const status = assistantStatus();
  if (!status.live) throw new Error(status.reason);
  const preset = useLibraryStore().presetForUse('assistant');
  if (!preset) throw new MissingPresetError('助手');
  const subjects = opts.targets.map(subjectOf).filter((s): s is Subject => !!s);
  const { messages } = assembleTaskPrompt({
    preset,
    fills: {
      assistantFormats: guideText(subjects),
      assistantTargets: targetsText(subjects),
      assistantChecks: checksText(opts.targets),
      assistantChat: chatText(opts.history),
      assistantAsk: askText(opts.ask, opts.mode, subjects, opts.merge),
    },
    // 预设里的示例照 SillyTavern 写 {{char}} {{user}}，原样留给助手（不换成名字）
    macros: { char: '{{char}}', user: '{{user}}', pronoun: subjects.length === 1 && subjects[0]?.kind === 'character' ? subjects[0].obj.pronoun : undefined },
    type: opts.mode,
  });
  const stream = preset.sampler.stream !== false && !!opts.onText;
  const r = await useAiStore().system.chat(
    'assistant',
    { messages, ...samplerRequest(preset.sampler) },
    {
      signal: opts.signal,
      // 修改项会引用思考标签和正则，不能对编辑协议做正文修剪；接口的思考分离仍由读流层处理。
      outputFilters: [],
      ...(stream ? { onDelta: (t: string) => opts.onText?.(parseAssistantReply(t).text) } : {}),
    },
  );
  return r.text;
}

/** 你的名字（预设里不用，显示用） */
export function userName(): string {
  return usePersonaStore().defaultPersona.name;
}

// —— 修改：预览、应用、撤销 ——

/** 按对象现在的样子算出改之后的样子（预览、应用都用它） */
export function planOps(ops: AssistantOp[], selected?: ReadonlySet<string>): EditPlan {
  const lib = useLibraryStore();
  return planEdits(ops, {
    presets: lib.presets,
    lorebooks: lib.lorebooks,
    characters: useCharacterStore().list,
    fighters: useBrawlStore().fighters,
    newId: (prefix) => uid(prefix),
    now: Date.now(),
    defaultPresetId: defaultPresetId(),
    knownMarkers: (category) => lib.markerChoices(category).map((m) => m.identifier),
  }, selected);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** 应用：改过的换成改之后的，新建的加进去（新角色顺带开一条聊天，同导入）；返回改之前的样子 */
export function applyPlan(plan: EditPlan): AssistantUndo {
  const lib = useLibraryStore();
  const chars = useCharacterStore();
  const now = Date.now();
  const undo: AssistantUndo = { presets: [], lorebooks: [], characters: [], fighters: [], created: [] };
  const brawl = useBrawlStore();
  for (const f of plan.fighters) {
    const before = brawl.byId(f.id);
    if (before) undo.fighters!.push(clone(before));
    brawl.save(f);
  }
  for (const p of plan.presets) {
    const i = lib.presets.findIndex((x) => x.id === p.id);
    if (i < 0) continue;
    undo.presets.push(clone(lib.presets[i]!));
    lib.presets[i] = { ...p, updatedAt: now };
  }
  for (const b of plan.lorebooks) {
    const i = lib.lorebooks.findIndex((x) => x.id === b.id);
    if (i < 0) continue;
    undo.lorebooks.push(clone(lib.lorebooks[i]!));
    lib.lorebooks[i] = { ...b, updatedAt: now };
  }
  for (const c of plan.characters) {
    const i = chars.list.findIndex((x) => x.id === c.id);
    if (i < 0) continue;
    undo.characters.push(clone(chars.list[i]!));
    chars.list[i] = { ...c, updatedAt: now };
  }
  for (const p of plan.newPresets) {
    lib.addPreset({ ...p, updatedAt: now });
    undo.created.push({ kind: 'preset', id: p.id });
  }
  for (const b of plan.newLorebooks) {
    lib.addLorebook(b);
    undo.created.push({ kind: 'lorebook', id: b.id });
  }
  for (const c of plan.newCharacters) {
    const added = chars.add(c);
    useChatStore().startChat(added);
    undo.created.push({ kind: 'character', id: c.id });
  }
  return undo;
}

/** 撤销：放回改之前的样子，删掉这次新建的（新角色的聊天一起删） */
export function undoApply(undo: AssistantUndo) {
  for (const f of undo.fighters ?? []) useBrawlStore().save(f);
  const lib = useLibraryStore();
  const chars = useCharacterStore();
  const chat = useChatStore();
  for (const p of undo.presets) {
    const i = lib.presets.findIndex((x) => x.id === p.id);
    if (i >= 0) lib.presets[i] = clone(p);
    else lib.addPreset(clone(p));
  }
  for (const b of undo.lorebooks) {
    const i = lib.lorebooks.findIndex((x) => x.id === b.id);
    if (i >= 0) lib.lorebooks[i] = clone(b);
    else lib.addLorebook(clone(b));
  }
  for (const c of undo.characters) {
    const i = chars.list.findIndex((x) => x.id === c.id);
    if (i >= 0) chars.list[i] = clone(c);
  }
  for (const x of undo.created) {
    if (x.kind === 'preset') lib.removePreset(x.id);
    else if (x.kind === 'lorebook') {
      lib.removeLorebook(x.id);
      for (const c of chars.list) if (c.lorebookIds.includes(x.id)) c.lorebookIds = c.lorebookIds.filter((id) => id !== x.id);
    } else {
      const ch = chat.chatOfCharacter(x.id);
      if (ch) chat.removeChat(ch.id);
      chars.remove(x.id);
    }
  }
}
