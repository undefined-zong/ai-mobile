import { ACTION_TAG_PREFIXES, IMAGE_PROMPT_MODIFIERS, IMAGE_PROMPT_SECTION_DOCS, IMAGE_PROMPT_SECTIONS } from './imageTags.ts';
import { characterPronoun } from './pronouns.ts';
import type { Character } from './types/character.ts';
import type { Lorebook } from './types/lorebook.ts';
import { IMAGE_MODES, LIFE_FLAGS, PROMPT_MARKERS, TASK_MARKERS, isRoleplayCategory, markerName, type Preset, type PresetCategory, type PromptBlock } from './types/preset.ts';
import { IMAGE_MOMENTS, LEVEL_PREFIXES } from './presetUses.ts';
import { SPRITE_EXPR, SPRITE_FRAME, SPRITE_POSE } from './spritePreset.ts';
import { CONTROL_TAG_DOCS, CONTROL_TAG_KINDS, BLOCK_TAG_KINDS } from './tags.ts';

/**
 * 特殊格式登记表：App 认的写法集中在这里（给人看的版本是 docs/FORMATS.md）。
 * - 模型回复里夹带的隐藏控制标签（tags.ts：[expr:] [cg:] <device>……）；
 * - 预设里的程序填充块、触发条件（任务名、尺度、生图的类型和时刻、立绘的构图 / 表情 / 动作）、App 自己加的宏；
 * - 各用途的输出格式（JSON 字段名、"# 标题"、生图的 image###、控制指令的 <device>……）：以 App 自带的预设文件为准（apps/web/src/presets/），
 *   这里不另抄一份，检测时拿同一用途的自带预设当参照，从里面读字段名、任务、程序填充块；
 * - 别的 App / SillyTavern 预设和世界书里常见、App 不认的写法（另一套生图、表情、选项、状态栏、思考标签……）和对应的 App 写法。
 * "我的 → 助手"按它检测导入的预设、世界书、角色卡哪些不适配，也把相关的部分写进助手的提示词。
 */

export type FormatLevel = 'error' | 'warn' | 'info';

export const FORMAT_LEVELS: Record<FormatLevel, { label: string; icon: string }> = {
  error: { label: '不适配', icon: 'i-lucide-circle-x' },
  warn: { label: '可能不适配', icon: 'i-lucide-triangle-alert' },
  info: { label: '可以补', icon: 'i-lucide-info' },
};

export interface FormatIssue {
  level: FormatLevel;
  /** 哪一类问题（marker / task / output / foreign / lore-keys ……），界面按它分组，助手看得懂 */
  code: string;
  message: string;
  /** 在哪：预设块的 identifier、正则的 id、世界书条目的 uid、角色卡的字段名 */
  where?: string;
  /** 给人看的位置：块名、条目标题、字段名 */
  whereLabel?: string;
}

// —— 一、App 认的写法 ——

/** App 在 SillyTavern 的宏之外认的宏 */
export const APP_MACROS: { name: string; desc: string }[] = [
  { name: '{{char}} {{user}}', desc: '角色名、你的名字；SillyTavern 常用的宏都认（{{time}} {{date}} {{random::a::b}} {{setvar}} {{getvar}}……）' },
  { name: '{{pronoun}} {{char_pronoun}}', desc: '当前角色选择的人称（他 / 她 / Ta）；未绑定角色时为 Ta' },
  { name: '{{weather}}', desc: '天气一句话' },
  { name: '{{char_appearance}}', desc: '生图预设：Ta的长相（原创是外观 tags；同人是角色 tag + 作品 tag）' },
  { name: '{{char_outfit}}', desc: '生图预设：节律里Ta今天这个场景穿的那套' },
  { name: '{{user_appearance}}', desc: '生图预设：你的长相' },
  { name: '{{framing}} {{expression}} {{pose}}', desc: '立绘预设的画法块：这次画的构图、表情、动作' },
  { name: '{{community}}', desc: '社群预设：这个社群的名字' },
];

/** 触发条件里有特殊含义的写法（其余的是各功能的任务名，以自带预设为准） */
export const TRIGGER_NOTES: { pattern: string; desc: string }[] = [
  { pattern: Object.keys(LIFE_FLAGS).join(' / '), desc: '角色扮演预设：你人设里开了家务 / 健康系统时才发这块' },
  { pattern: LEVEL_PREFIXES.map((p) => `${p}名字`).join(' / '), desc: '真心话大冒险 / 海龟汤 / 戳戳乐的尺度：一块一个尺度，名字是冒号后面的字' },
  { pattern: Object.keys(IMAGE_MODES).join(' / '), desc: `生图预设：画什么（${Object.values(IMAGE_MODES).join('、')}），只发对应的那块` },
  { pattern: 'outfit-free', desc: '生图预设：生图设置里关了"服装参考"时才发这块（不给角色和你的衣服，衣服由模型按画面自己设计）' },
  {
    pattern: Object.values(IMAGE_MOMENTS)
      .flatMap((m) => Object.keys(m ?? {}))
      .join(' / '),
    desc: '一起做事时自动画图的时刻（陪伴学习、一起吃饭、约会、哄睡、心跳），场景的生图预设按时刻只发那一块',
  },
  { pattern: [SPRITE_FRAME, SPRITE_EXPR, SPRITE_POSE].map((p) => `${p}名字`).join(' / '), desc: '立绘预设：构图、表情、动作，一块一个，名字就是画出来的立绘标的名字' },
  { pattern: '其余', desc: '各功能的任务名（排今天 plan-day、发朋友圈 post、约会的每一段 date-turn……）：程序做哪件事就只发写了它的块；以同一用途的自带预设为准' },
];

/** 隐藏控制标签的说明（一行一个） */
export function controlTagLines(): string[] {
  return [...CONTROL_TAG_KINDS, ...BLOCK_TAG_KINDS].map((k) => `- ${CONTROL_TAG_DOCS[k].syntax}：${CONTROL_TAG_DOCS[k].desc}`);
}

/** 这一类预设的程序填充块（identifier → 名字） */
export function categoryMarkers(category: PresetCategory): Record<string, string> {
  if (isRoleplayCategory(category)) return { ...PROMPT_MARKERS };
  return { ...(TASK_MARKERS as Partial<Record<PresetCategory, Record<string, string>>>)[category] };
}

// —— 二、别的写法 ——

export interface ForeignFormat {
  id: string;
  label: string;
  re: RegExp;
  /** App 里对应的写法；没有对应写法时写 App 会怎么显示 */
  app: string;
  advice: string;
}

/**
 * 别的 App / SillyTavern 预设、世界书、角色卡里常见、App 不认的写法。
 * 只看角色扮演类的预设、世界书和角色卡（任务类预设只读 JSON，不看这些）。
 */
export const FOREIGN_FORMATS: ForeignFormat[] = [
  {
    id: 'image',
    label: '另一套生图写法',
    re: /<img\b|!\[[^\]\n]*\]\(\s*https?:|pollinations|<pic\b|<image\b|<imgthink|<(?:生图|配图|图片|插图)\b|[[【](?:img|image|pic|picture|photo|IMG_GEN|生图|配图|图片|插图|照片)\s*[:：\]】]|\/(?:sd|imagine)\b/i,
    app: '[cg:画面描述]',
    advice: 'App 的配图是 [cg:画面描述]（冒号后面用中文写画面），程序交给"生图提示词"写 tags 再调生图 API；别的写法 App 不会拿去画（开了 HTML 渲染时 <img> 外链会直接显示别人的图）',
  },
  {
    id: 'expr',
    label: '另一套表情写法',
    re: /[[【](?:表情|expression|emotion|sprite|立绘)\s*[:：]|<(?:expression|emotion|表情|立绘)\b/i,
    app: '[expr:表情]',
    advice: '换立绘表情是 [expr:表情]，能用的表情由程序按Ta的立绘列在"当前场景规则 + 可用标签"里',
  },
  {
    id: 'music',
    label: '另一套分享歌曲写法',
    re: /<(?:music|song|bgm)\b|[[【](?:音乐|歌曲|歌|song|bgm)\s*[:：]/i,
    app: '[music:歌名-歌手]',
    advice: '分享歌曲是 [music:歌名-歌手]，程序生成歌曲卡片',
  },
  {
    id: 'choice',
    label: '另一套选项写法',
    re: /<(?:options?|choices?|选项)\b|【选项】|[[【](?:选项|options?)\s*[:：]/i,
    app: '[choice:选项A|选项B]',
    advice: '可以点的选项是 [choice:选项A|选项B]（约会里用；聊天里别的写法会原样显示成字）',
  },
  {
    id: 'call',
    label: '另一套打电话写法',
    re: /[[【](?:电话|来电|打电话|语音通话|phone ?call)[\]】]/i,
    app: '[call]',
    advice: '想打电话是 [call]，界面弹出来电',
  },
  {
    id: 'think',
    label: '思考标签',
    re: /<(?:thinking|思考|思维链|cot|reasoning|analysis)\b/i,
    app: '<think>…</think>',
    advice: 'App 默认只去掉 <think>…</think>；写成别的标签时思考内容会留在气泡里（不认识的标签去掉标签、留下字）。改成 <think>，或者在"API 设置 → 输出修剪"里加一条',
  },
  {
    id: 'status',
    label: '状态栏 / 面板',
    re: /<(?:status|statusbar|status_?block|state|panel|状态栏|状态|面板|小剧场)\b/i,
    app: '（气泡里显示）',
    advice: '开了 HTML 渲染时 <details> <div style> 这类排版标签能显示，不认识的标签去掉标签、留下字；整页的 HTML（带 <html> <body> <style>）要放在 ```html 代码块里才在小窗里运行。不想要就加一条"仅格式显示"的正则藏起来',
  },
  {
    id: 'wrapper',
    label: '正文包装标签',
    re: /<(?:content|正文|maintext|main_text|story|reply|response)\b/i,
    app: '（气泡里会看到标签里的字，标签本身去掉）',
    advice: '一般不用改；想让存下来的消息干净，加一条正则去掉这对标签（只去标签、留下正文）',
  },
  {
    id: 'style',
    label: '样式表',
    re: /<style\b/i,
    app: '（行内 HTML 不认 <style>）',
    advice: '<style> 只在 ```html 代码块里的整页 HTML 里生效；写在普通回复里会连同内容一起去掉。改成整页 HTML 放进代码块，或者改用 style 属性',
  },
];

export interface ForeignHit {
  format: ForeignFormat;
  /** 命中处前后的一小段原文 */
  sample: string;
}

/** 一段文字里用了哪些别的写法（每种取第一处） */
export function scanForeign(text: string): ForeignHit[] {
  const hits: ForeignHit[] = [];
  if (!text) return hits;
  for (const format of FOREIGN_FORMATS) {
    const m = format.re.exec(text);
    if (!m) continue;
    const at = m.index;
    // 从这一句的开头截（往前最多 24 字），免得截在宏、标签中间
    const head = text.slice(Math.max(0, at - 24), at);
    const cut = Math.max(head.lastIndexOf('\n'), ...['。', '！', '？', '；', '. '].map((p) => head.lastIndexOf(p)));
    const from = cut >= 0 ? at - head.length + cut + 1 : Math.max(0, at - 12);
    const sample = text
      .slice(from, at + Math.max(m[0].length, 1) + 28)
      .replace(/\s+/g, ' ')
      .trim();
    hits.push({ format, sample });
  }
  return hits;
}

// —— 三、输出格式：从自带预设里读 ——

const JSON_KEY_RE = /"([A-Za-z_][A-Za-z0-9_]*)"\s*:/g;
/** "名字###内容###"写法的段名（生图的 image###tags###；只认程序读的那几段，收尾的 ### 不算） */
const SECTION_KEY_RE = new RegExp(`(?<![A-Za-z0-9_])(${IMAGE_PROMPT_SECTIONS.join('|')})(?:[ \\t_-]+(?:${IMAGE_PROMPT_MODIFIERS.join('|')}))*[ \\t]*###`, 'gi');

/** 文字里输出格式的字段名（按出现的顺序，不重复）：JSON 示例的字段名，和 image### 这种段名（带着 ###） */
export function jsonKeysOf(text: string): string[] {
  return [...new Set([...[...text.matchAll(JSON_KEY_RE)].map((m) => m[1]!), ...[...text.matchAll(SECTION_KEY_RE)].map((m) => `${m[1]!.toLowerCase()}###`)])];
}

function mentions(text: string, key: string): boolean {
  if (key.endsWith('###')) return new RegExp(`(^|[^A-Za-z0-9_])${key.slice(0, -3)}(?:[ \\t_-]+(?:${IMAGE_PROMPT_MODIFIERS.join('|')}))*[ \\t]*###`, 'i').test(text);
  return new RegExp(`(^|[^A-Za-z0-9_])${key}($|[^A-Za-z0-9_])`).test(text);
}

/** 不是 JSON 的输出格式：写给助手的说明（只在看这一类预设时给） */
const OUTPUT_NOTES: Partial<Record<PresetCategory, string>> = {
  image: [
    '【生图预设的输出】不是 JSON，是几段"名字###内容###"，程序读了再拼成生图请求（标题、画幅、长相、衣服都由程序加）：',
    ...IMAGE_PROMPT_SECTIONS.map((k) => `- ${k}###…###：${IMAGE_PROMPT_SECTION_DOCS[k]}`),
    `- char / user 后面空一格写 ${IMAGE_PROMPT_MODIFIERS.filter((m) => m !== 'negative').join(' / ')} 是位置（例如 char left###…###），写 negative 是只针对这个人的负面 tags（例如 char negative###…###）`,
    `- 两个人之间的动作写在各自那一份里，用 ${ACTION_TAG_PREFIXES.map((p) => `${p}#`).join(' / ')} 标出发起、承受、相互（char###girl, source#hug### 和 user###boy, target#hug###）；NovelAI V4 起分人物时认，单人图和不分人物的接口程序会去掉前缀`,
    '- 每个人的那一份（char###、user###、| 后面的每段）各自带各自的负面 tags：Ta的是角色卡的负面 tags + char negative###，你的是人设的 + user negative###，别的人是 negative### 里同一个位置的那段',
    '旧写法（{"caption", "tags", "negative", "size"} 的 JSON、characters 字段）程序不再读：照参照预设的输出格式那块换成这种写法，规则里讲到 negative、size、characters 的句子也跟着换成 negative###、size###、char### / user###。',
  ].join('\n'),
  device: [
    '【控制指令预设的输出】不是 JSON：把Ta那一句照抄一遍、在要变的地方插 <device>"VIBRATE": 40</device>（键的写法同隐藏标签 <device>），程序按抄的字放回原话的位置；可以只抄到最后一个 <device> 为止，这一句不用变时原样抄、不插。',
    '强度照 0–100 写，写多少发多少：超过每个头上限的由程序压到上限，预设里不要让模型压在上限以内。',
    '旧写法 {"steps": [{"at": "…", "do": {…}}]} 程序不再读：照参照预设的输出格式那块换成这种写法，规则里讲到 at、steps 的句子也跟着换。',
  ].join('\n'),
};

/** 这一类预设里程序不再读的旧输出写法：查到就是不适配 */
const LEGACY_OUTPUTS: { category: PresetCategory; re: RegExp; message: string }[] = [
  { category: 'image', re: /"(?:caption|tags|characters)"\s*:/, message: '输出格式还是 JSON（caption、tags……）：程序现在读 image###英文 tags###，旧写法读不到，照参照预设的输出格式改' },
  { category: 'device', re: /"(?:steps|at|do)"\s*:/, message: '输出格式还是 {"steps": [{"at", "do"}]}：程序现在读照抄原话、插在里面的 <device>，旧写法读不到，照参照预设的输出格式改' },
];

/** 触发条件是不是用户自己起名的那种（尺度、立绘的构图表情动作）或者开关（家务、健康），不算任务 */
export function isNamedTrigger(t: string): boolean {
  return t in LIFE_FLAGS || [...LEVEL_PREFIXES, SPRITE_EXPR, SPRITE_POSE, SPRITE_FRAME].some((p) => t.startsWith(p));
}

/** 自带预设里有、但预设里没有时程序用自带那块顶上的块（不算缺） */
const SEED_FALLBACK_BLOCKS = new Set(['photoLook', 'mealLook', 'homeRules', 'healthRules']);

/** 任务类预设里缺了就做不成事的程序填充块（其余缺了是少一点材料） */
const KEY_TASK_MARKERS = new Set([
  'storyCharacter',
  'summaryTranscript',
  'consolidateInput',
  'imageCaption',
  'imageSubject',
  'rhythmCharacter',
  'rhythmAsk',
  'healthProfile',
  'healthAsk',
  'parallelAsk',
  'parallelInput',
  'deviceToys',
  'deviceLine',
  'novelAsk',
  'spriteCharacter',
  'spriteAsk',
  'socialAsk',
  'assistantTargets',
  'assistantAsk',
]);

/** 角色扮演类预设的程序填充块：缺了会怎样 */
const ROLEPLAY_MARKERS: { id: string; level: FormatLevel; why: string; categories?: PresetCategory[] }[] = [
  { id: 'chatHistory', level: 'error', why: '聊天记录不会发，Ta不知道你们刚才说了什么' },
  { id: 'charDescription', level: 'error', why: '角色卡的描述不会发' },
  { id: 'sceneRules', level: 'warn', why: '能用的隐藏标签（[expr:] [cg:] [music:]……）和场景规则不会发：表情不会换、不会配图' },
  { id: 'sceneTask', level: 'error', why: '程序给这件事的输入（这一步要Ta做什么）不会发', categories: ['feature'] },
  { id: 'proactive', level: 'error', why: '这次为什么来找你、现在几点不会发', categories: ['proactive'] },
  { id: 'memory', level: 'warn', why: '长期记忆和关系状态不会发' },
  { id: 'summary', level: 'warn', why: '过往摘要不会发' },
  { id: 'environment', level: 'warn', why: '现在几点、天气、Ta在哪不会发' },
  { id: 'personaDescription', level: 'warn', why: '你的人设不会发' },
  { id: 'home', level: 'info', why: '开了家务 / 健康系统时，你今天的情况不会发' },
  { id: 'charPersonality', level: 'info', why: '角色卡的性格不会发' },
  { id: 'scenario', level: 'info', why: '角色卡的场景不会发' },
  { id: 'dialogueExamples', level: 'info', why: '角色卡的示例对话不会发' },
];

export interface PresetCheckOptions {
  /** 参照的自带预设（同一个用途或同一类）：程序填充块、任务、输出格式以它为准；没有时只按通用规则查 */
  reference?: Pick<Preset, 'name' | 'blocks'> | null;
  /** 程序认得的程序填充块（这一类的自带预设里出现过的）；不给时按 PROMPT_MARKERS / TASK_MARKERS */
  knownMarkers?: Iterable<string>;
}

const blockLabel = (b: Pick<PromptBlock, 'name' | 'identifier'>) => b.name || b.identifier;

/** 检查一个预设和 App 的格式合不合：程序填充块、任务块、输出格式、别的写法 */
export function checkPreset(preset: Pick<Preset, 'category' | 'blocks' | 'regex'>, opts: PresetCheckOptions = {}): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const roleplay = isRoleplayCategory(preset.category);
  const ref = opts.reference ?? null;
  const on = preset.blocks.filter((b) => b.enabled);
  const markerOn = (id: string) => on.some((b) => b.marker && b.identifier === id);
  const markerOff = (id: string) => preset.blocks.some((b) => b.marker && !b.enabled && b.identifier === id);
  const missing = (id: string, name: string, level: FormatLevel, why: string) =>
    issues.push({ level, code: 'marker', where: id, whereLabel: name, message: `${markerOff(id) ? '关着' : '没有'}程序填充块「${name}」：${why}` });

  // 1. 程序填充块
  if (roleplay) {
    const refMarkers = ref ? new Set(ref.blocks.filter((b) => b.marker).map((b) => b.identifier)) : null;
    for (const r of ROLEPLAY_MARKERS) {
      if (r.categories && !r.categories.includes(preset.category)) continue;
      // 有参照时只要求参照里有的（例如"小屋 · 角色生活"本来就不带场景规则）
      if (refMarkers && !refMarkers.has(r.id)) continue;
      if (!markerOn(r.id)) missing(r.id, markerName(r.id) ?? r.id, r.level, r.why);
    }
    if (!markerOn('worldInfoBefore') && !markerOn('worldInfoAfter')) {
      issues.push({ level: 'warn', code: 'marker', where: 'worldInfoBefore', whereLabel: '世界书', message: '没有世界书的程序填充块（角色前 / 角色后）：命中的世界书条目不会发（按深度插入的照样插）' });
    }
  } else if (ref) {
    for (const b of ref.blocks) {
      if (!b.marker || !b.enabled || markerOn(b.identifier)) continue;
      const name = markerName(b.identifier) ?? blockLabel(b);
      missing(b.identifier, name, KEY_TASK_MARKERS.has(b.identifier) ? 'error' : 'warn', KEY_TASK_MARKERS.has(b.identifier) ? '这次任务的输入不会发给模型' : '少发一部分材料');
    }
  }
  const known = new Set([...Object.keys(categoryMarkers(preset.category)), ...(opts.knownMarkers ?? []), ...(ref?.blocks.filter((b) => b.marker).map((b) => b.identifier) ?? [])]);
  for (const b of on) {
    if (b.marker && !known.has(b.identifier)) {
      issues.push({ level: 'warn', code: 'marker-unknown', where: b.identifier, whereLabel: blockLabel(b), message: `程序不认识「${blockLabel(b)}」（${b.identifier}）这个程序填充块：不会填内容` });
    }
  }

  // 2. 任务块和输出格式（以参照为准）
  if (ref) {
    const text = (blocks: PromptBlock[]) => blocks.map((b) => b.content).join('\n');
    const general = on.filter((b) => !b.marker && !b.triggers?.length);
    const triggered = (t: string) => on.filter((b) => !b.marker && b.triggers?.includes(t));
    const refTasks = new Map<string, PromptBlock[]>();
    for (const b of ref.blocks) {
      if (!b.enabled || b.marker || SEED_FALLBACK_BLOCKS.has(b.identifier)) continue;
      for (const t of b.triggers ?? []) if (!isNamedTrigger(t)) refTasks.set(t, [...(refTasks.get(t) ?? []), b]);
    }
    const plain: string[] = [];
    for (const [t, blocks] of refTasks) {
      if (triggered(t).length) continue;
      const keys = jsonKeysOf(text(blocks));
      const label = blocks.map(blockLabel).join('、');
      if (keys.length && !keys.slice(0, 3).some((k) => mentions(text(general), k))) {
        issues.push({ level: 'error', code: 'task', where: t, whereLabel: label, message: `没有「${label}」这一块（只在 ${t} 时发送）：做这件事时没有说明，程序要的输出格式（${keys.slice(0, 6).join('、')}）也没有` });
      } else plain.push(`${label}（${t}）`);
    }
    if (plain.length) {
      issues.push({ level: 'warn', code: 'task', whereLabel: plain.join('、'), message: `没有这几件事专门的块：${plain.slice(0, 8).join('、')}${plain.length > 8 ? ` 等 ${plain.length} 件` : ''}。做这些事时只发通用的块` });
    }
    for (const b of ref.blocks) {
      if (!b.enabled || b.marker || SEED_FALLBACK_BLOCKS.has(b.identifier)) continue;
      const keys = jsonKeysOf(b.content);
      if (!keys.length) continue;
      const tasks = (b.triggers ?? []).filter((t) => !isNamedTrigger(t));
      const scope = tasks.length ? on.filter((x) => !x.marker && x.triggers?.some((t) => tasks.includes(t))) : [];
      if (tasks.length && !scope.length) continue; // 缺整块，上面说过了
      const body = text([...scope, ...general]);
      const lost = keys.filter((k) => !mentions(body, k));
      if (!lost.length) continue;
      const where = scope[0]?.identifier ?? b.identifier;
      if (lost.length === keys.length) {
        issues.push({ level: 'error', code: 'output', where, whereLabel: blockLabel(b), message: `没写「${blockLabel(b)}」要的输出格式（${keys.slice(0, 6).join('、')}${keys.length > 6 ? '……' : ''}）：程序按这些字段名读` });
      } else {
        issues.push({ level: 'warn', code: 'output', where, whereLabel: blockLabel(b), message: `「${blockLabel(b)}」的输出格式里少了 ${lost.slice(0, 8).join('、')}${lost.length > 8 ? '……' : ''}：程序按字段名读，少了的那部分读不到` });
      }
    }
  }

  // 2.5 程序不再读的旧输出写法
  for (const l of LEGACY_OUTPUTS) {
    if (l.category !== preset.category) continue;
    for (const b of on) if (!b.marker && l.re.test(b.content)) issues.push({ level: 'error', code: 'output', where: b.identifier, whereLabel: blockLabel(b), message: l.message });
  }

  // 3. 别的写法（角色扮演类）
  if (roleplay) {
    for (const b of on) {
      if (b.marker) continue;
      for (const hit of scanForeign(b.content)) {
        issues.push({ level: 'warn', code: `foreign:${hit.format.id}`, where: b.identifier, whereLabel: blockLabel(b), message: `${hit.format.label}「${hit.sample}」：${hit.format.advice}` });
      }
    }
    for (const r of preset.regex ?? []) {
      if (!r.enabled) continue;
      const out = r.replace ?? '';
      if (/<style\b|<html\b|<body\b/i.test(out) && !/```/.test(out)) {
        issues.push({ level: 'warn', code: 'regex-html', where: r.id, whereLabel: r.name, message: `正则「${r.name}」替换出来的是整页 HTML / 样式，但没放进 \`\`\`html 代码块：App 只在代码块里的整页 HTML 才运行（行内 <style> 会去掉）` });
      }
    }
  }
  return issues;
}

// —— 四、世界书、角色卡 ——

/** 检查一本世界书：触发不了的条目、别的写法 */
export function checkLorebook(book: Pick<Lorebook, 'entries'>): FormatIssue[] {
  const issues: FormatIssue[] = [];
  for (const e of book.entries) {
    if (!e.enabled) continue;
    const label = e.comment || e.keys.slice(0, 2).join('、') || e.uid;
    if (!e.content.trim()) issues.push({ level: 'info', code: 'lore-empty', where: e.uid, whereLabel: label, message: '内容是空的' });
    if (!e.constant && !e.keys.some((k) => k.trim())) {
      issues.push({ level: 'warn', code: 'lore-keys', where: e.uid, whereLabel: label, message: '没有关键词、也不是常驻：永远不会触发' });
    }
    for (const hit of scanForeign(e.content)) {
      issues.push({ level: 'warn', code: `foreign:${hit.format.id}`, where: e.uid, whereLabel: label, message: `${hit.format.label}「${hit.sample}」：${hit.format.advice}` });
    }
  }
  return issues;
}

/** 角色卡里可能要补的设定、App 不认的东西 */
export function checkCharacter(c: Pick<Character, 'name' | 'pronoun' | 'card' | 'appearanceTags' | 'fandom' | 'lorebookIds'>): FormatIssue[] {
  const issues: FormatIssue[] = [];
  const card = c.card;
  const add = (level: FormatLevel, code: string, where: string, whereLabel: string, message: string) => issues.push({ level, code, where, whereLabel, message });
  if (!card.description.trim()) add('warn', 'card-empty', 'description', '描述', `没有角色描述：${characterPronoun(c)}是谁、什么样、什么经历都没写`);
  else if ([...card.description].length < 80 && !card.personality.trim()) add('info', 'card-thin', 'description', '描述', '描述很短、性格也没写：可以让助手补全设定');
  if (!card.personality.trim() && card.description.trim()) add('info', 'card-empty', 'personality', '性格', '没写性格（写在描述里也行）');
  if (!card.scenario.trim()) add('info', 'card-empty', 'scenario', '场景', '没写场景：你们是什么关系、现在在什么情况下');
  if (!card.firstMes.trim()) add('info', 'card-empty', 'firstMes', '开场白', '没有开场白');
  if (!card.mesExample.trim()) add('info', 'card-empty', 'mesExample', '示例对话', '没有示例对话：说话的口气靠描述猜');
  if (!c.appearanceTags.trim() && !c.fandom?.enabled) add('info', 'card-look', 'appearanceTags', '外观 tags', '没有外观 tags：配图、AI 画立绘前要先写（同人角色打上"同人"标记、填角色 tag 也行）');
  const regex = card.extensions?.regex_scripts;
  if (Array.isArray(regex) && regex.length) {
    add('warn', 'card-regex', 'extensions.regex_scripts', '角色卡的正则', `角色卡带了 ${regex.length} 条正则脚本：App 只执行预设里的正则（在对话预设的"正则"里从角色卡导入，或者让助手搬进预设）`);
  }
  const fields: [keyof typeof card, string][] = [
    ['description', '描述'],
    ['personality', '性格'],
    ['scenario', '场景'],
    ['firstMes', '开场白'],
    ['mesExample', '示例对话'],
    ['systemPrompt', '角色卡的系统提示'],
    ['postHistoryInstructions', '角色卡的后置指令'],
  ];
  for (const [field, label] of fields) {
    const v = card[field];
    if (typeof v !== 'string') continue;
    for (const hit of scanForeign(v)) add('warn', `foreign:${hit.format.id}`, field, label, `${hit.format.label}「${hit.sample}」：${hit.format.advice}`);
  }
  card.alternateGreetings.forEach((g, i) => {
    for (const hit of scanForeign(g)) add('warn', `foreign:${hit.format.id}`, `alternateGreetings.${i}`, `备选开场白 ${i + 1}`, `${hit.format.label}「${hit.sample}」：${hit.format.advice}`);
  });
  return issues;
}

/** 最严重的一级；没有问题为空 */
export function worstLevel(issues: FormatIssue[]): FormatLevel | null {
  if (issues.some((i) => i.level === 'error')) return 'error';
  if (issues.some((i) => i.level === 'warn')) return 'warn';
  return issues.length ? 'info' : null;
}

// —— 五、写给助手看的 ——

/** 参照预设的骨架：每块的 identifier、名字、角色、触发条件；带 JSON 字段或叫"……格式"的块连内容一起（照着改格式用） */
export function referenceSkeleton(ref: Pick<Preset, 'name' | 'blocks'>): string {
  const lines = [`参照：App 自带的预设「${ref.name}」`];
  for (const b of ref.blocks) {
    if (!b.enabled) continue;
    const head = `- ${b.identifier}「${blockLabel(b)}」${b.marker ? '（程序填充）' : ''}${b.role !== 'system' ? ` [${b.role}]` : ''}${b.triggers?.length ? ` 只在 ${b.triggers.join(' / ')} 时发送` : ''}`;
    const showBody = !b.marker && (jsonKeysOf(b.content).length > 0 || /格式/.test(b.name));
    lines.push(showBody ? `${head}\n  内容：${b.content.trim().replace(/\n/g, '\n  ')}` : head);
  }
  return lines.join('\n');
}

/** 写给助手的格式说明：只放这次要看的东西用得上的部分 */
export function formatGuide(opts: { categories: PresetCategory[]; lorebook?: boolean; character?: boolean; references?: Pick<Preset, 'name' | 'blocks'>[] }): string {
  const parts: string[] = [];
  const roleplay = opts.categories.some(isRoleplayCategory) || opts.lorebook || opts.character;
  if (roleplay) {
    parts.push(`【隐藏控制标签】角色扮演的回复里夹带，对方看不到、程序执行；兼容全角【expr：smile】。能用哪些、有哪些表情由程序按场景填在"当前场景规则 + 可用标签"里，预设和世界书里不用列表情：\n${controlTagLines().join('\n')}`);
    parts.push(
      `【别的写法 → App 的写法】导入的预设、世界书、角色卡里常见这些写法，App 不认或显示不一样：\n${FOREIGN_FORMATS.map((f) => `- ${f.label} → ${f.app}：${f.advice}`).join('\n')}`,
    );
    parts.push(
      '【消息显示】聊天气泡是纯文字；"我的 → 消息设置"开了 HTML 渲染时，排版标签（<details> <b> <span style> <table> <img>……）按白名单显示，不认识的标签去掉标签、留下字，<style> <script> 去掉；整页 HTML（带 <html> <head> <body>）放在 ```html 代码块里才在沙盒小窗里运行。（动作）和 *动作* 显示得淡一点。',
    );
  }
  for (const c of [...new Set(opts.categories)]) {
    const note = OUTPUT_NOTES[c];
    if (note) parts.push(note);
    const markers = categoryMarkers(c);
    if (Object.keys(markers).length) {
      parts.push(`【${c} 类预设的程序填充块】marker 为 true、content 为空，程序每次填：\n${Object.entries(markers).map(([id, name]) => `- ${id}：${name}`).join('\n')}`);
    }
  }
  if (opts.categories.length) parts.push(`【触发条件里的写法】块的 triggers 写了值时，只在程序做这些事时发送：\n${TRIGGER_NOTES.map((t) => `- ${t.pattern}：${t.desc}`).join('\n')}`);
  if (opts.categories.length) parts.push(`【宏】\n${APP_MACROS.map((m) => `- ${m.name}：${m.desc}`).join('\n')}`);
  for (const r of opts.references ?? []) parts.push(referenceSkeleton(r));
  if (opts.lorebook) {
    parts.push(
      '【世界书】条目按关键词（keys，中文按包含匹配）在最近的聊天里命中才发，constant 为 true 的常驻；position：before_char / after_char（角色定义前后）、at_depth（插在聊天记录倒数第 depth 条前，role 决定身份）、an_top / an_bottom、em_top / em_bottom；order 大的靠后。世界书的内容会进对话预设的提示词，所以里面写的"回复格式"（生图、状态栏……）也要用 App 的写法。',
    );
  }
  if (opts.character) {
    parts.push(
      '【角色卡】SillyTavern V2/V3 的字段：name、description（描述）、personality（性格）、scenario（场景）、firstMes（开场白）、alternateGreetings（备选开场白）、mesExample（示例对话，用 <START> 分段，{{char}}: / {{user}}: 开头）、systemPrompt、postHistoryInstructions、creatorNotes、tags。App 自己的：pronoun（他 / 她 / Ta）、appearanceTags（NovelAI 外观 tags，英文逗号分隔：发色、发型、眼睛、体型、常见特征，不写衣服、表情、动作）、negativeTags。',
    );
  }
  return parts.join('\n\n');
}
