import { assembleTaskPrompt, IMAGE_PROMPT_PERSON_SEPARATOR, IMAGE_PROMPT_SECTIONS, joinTags, leadCountTags, substituteMacros, triggerMatches, type PromptBlock } from '@app/shared';
import type { ImageCharacter, ImageRequest, ImageSize } from '../image/types.ts';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 生图提示词智能体（设计文档 §4.3）：把一个画面写成 NovelAI 的 tags。
 * 发给模型的每一个字、出图时加的每一个 tag 都在"生图"预设里，程序只提供这一次的数据（宏）和类型（块的触发条件）：
 * - 发给模型：预设里的普通块，按触发条件和这次的类型（imagePromptTypes）挑，宏换成这次的数据（imagePromptMacros）；
 * - 出图：触发条件写了 image-prompt:<拼法> / image-negative:<拼法> / image-size:<拼法> 的块拼成正向、负面、画幅（composeKind 定拼法）；
 * - 格式不对让模型重写：触发条件写了 retry 的块；没有就不重写；
 * - 你立绘的 Vibe：触发条件写了 vibe:<类型> 的块，这次的类型里有那个才带上。
 * 这几种块（image-prompt:… / image-negative:… / image-size:… / retry / vibe:…）的触发条件不会出现在发给模型的类型里，所以不会发给模型。
 *
 * 模型的输出（parseImagePrompt 读）：
 *   image###1girl, upper body, smile, ...###        画面的 tags（必须有）
 *   negative###...###                              负面 tags（可以不写）
 *   size###landscape###                            画幅 portrait / landscape / square（可以不写）
 * image### 里用 NovelAI 的 | 写法分人物时：image###整体画面 | 一个人 | 又一个人###，negative### 按同样的顺序用 | 隔开（第一段是整体的）。
 */

/**
 * 画什么（对照 SillyTavern 生图扩展的几种模式）：
 * - scene：一个具体的画面（[cg:] 里的描述、番外里的一幕），默认；
 * - portrait：全身像（ST 的 Character）；
 * - face：脸部特写，比如自拍（ST 的 Face）；
 * - background：只画场景、不画人（ST 的 Background），给地点做背景图。
 * 预设里"画什么"的几块按触发条件（这几个值）只发对应的那一块。
 */
export type ImagePromptMode = 'scene' | 'portrait' | 'face' | 'background';

export interface ImagePromptInput {
  /** 画什么，默认 scene */
  mode?: ImagePromptMode;
  /** 一起做事时画的是哪个时刻（入座 seat、偷拍 peek、奖励 reward……）：当作这一次的一个类型 */
  moment?: string;
  character: {
    name: string;
    /** 她的长相：原创是外观 tags；同人是角色 tag + 作品 tag（+ 补充的外观） */
    appearanceTags: string;
    negativeTags?: string;
    pronoun?: string;
    /** 她今天这个场景该穿的那套（节律） */
    outfit?: { name: string; tags: string } | null;
  };
  /** 锁定今天那一身：宏 {{char_outfit_locked}} 有值，类型多一个 outfit-locked（没锁、但给了衣服时是 outfit-unlocked） */
  lockOutfit?: boolean;
  /** 服装参考关着（生图设置）：这一次的类型多一个 outfit-free */
  outfitFree?: boolean;
  /** 写好的画面描述（[cg:] 里的、你写的、日记朋友圈的模型写的）：宏 {{image_caption}} */
  caption?: string;
  scene?: {
    place?: string;
    timeOfDay?: string;
    weather?: string;
    expression?: string;
  };
  /** 最近的对话（一句一行）：宏 {{image_recent}}，{{image_recent::N}} 是最后 N 句 */
  recent?: string[];
  /** 你（这条聊天的人设）：宏 {{user}} {{user_appearance}} {{user_outfit}} {{user_negative}} */
  withUser?: {
    name: string;
    appearanceTags?: string;
    negativeTags?: string;
    outfit?: { tags: string };
  } | null;
  /** 画幅由场景定（陪伴学习半屏画方图……）：宏 {{image_size}}，类型多一个 size:<画幅>，出图按它 */
  size?: PromptSize;
  /** 不同框、只在预设里出现的另一个人（{{user}}）：画"你"这边时是她 */
  companionName?: string;
  /** 你坐在她旁边：类型多一个 duo */
  duo?: boolean;
  /** 场景给的数据：宏 {{名字}}（名字用小写） */
  vars?: Record<string, string>;
  /** 场景给的类型（连线 remote / 坐在旁边 visit、气氛几级……）：预设里触发条件写了它的块才发 */
  types?: string[];
}

/** 提示词里能用的画幅（竖图、横图、方图） */
export type PromptSize = 'portrait' | 'landscape' | 'square';

export interface ImagePromptOutput {
  /** 中文短标题，进相册 */
  caption: string;
  tags: string;
  negative: string;
  /** 模型写的画幅（size###） */
  size?: PromptSize;
  /** image### 里 | 隔开的后面几段（一段一个人）：负面 tags 是 negative### 里同一个位置的那段 */
  others?: { tags: string; negative: string }[];
}

/** 锁定的衣服 tags（{{char_outfit_locked}}） */
function lockedOutfit(input: ImagePromptInput): string {
  return input.lockOutfit ? (input.character.outfit?.tags.trim() ?? '') : '';
}

/** 生图预设里能用的数据宏（名字小写）；写进块里就换成这一次的值，没有时是空的 */
export function imagePromptMacros(input: ImagePromptInput): Record<string, string> {
  const c = input.character;
  const looks = leadCountTags(c.appearanceTags);
  const scene = input.scene ?? {};
  const vars = Object.fromEntries(Object.entries(input.vars ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    char_appearance: c.appearanceTags,
    char_count: looks.lead,
    char_look: looks.rest,
    char_outfit: c.outfit ? `${c.outfit.name}（${c.outfit.tags}）` : '',
    char_outfit_name: c.outfit?.name ?? '',
    char_outfit_tags: c.outfit?.tags ?? '',
    char_outfit_locked: lockedOutfit(input),
    char_negative: c.negativeTags ?? '',
    user_appearance: input.withUser?.appearanceTags ?? '',
    user_outfit: input.withUser?.outfit?.tags ?? '',
    user_negative: input.withUser?.negativeTags ?? '',
    image_place: scene.place ?? '',
    image_time: scene.timeOfDay ?? '',
    image_weather: scene.weather ?? '',
    image_expression: scene.expression ?? '',
    image_size: input.size ?? '',
    image_recent: (input.recent ?? []).join('\n'),
    image_caption: input.caption ?? '',
    ...vars,
  };
}

/**
 * 这一次的类型（块的触发条件按它挑）：image-task（生图都有）、画什么、时刻、duo（坐在她旁边）、outfit-free / outfit-locked / outfit-unlocked、
 * size:<画幅>（场景定了画幅时）、场景给的类型；每个数据宏有值时多一个 has:<名字>，没值时多一个 no:<名字>
 */
export function imagePromptTypes(input: ImagePromptInput): string[] {
  const mode = input.mode ?? 'scene';
  const outfit = input.outfitFree ? 'outfit-free' : lockedOutfit(input) ? 'outfit-locked' : input.character.outfit ? 'outfit-unlocked' : '';
  return [
    // 生图任务都有：生图的块加进别的分类的预设时（那个预设也负责生图），只在生图时发的块用它
    'image-task',
    mode,
    ...(input.moment ? [input.moment] : []),
    ...(input.duo && mode === 'scene' ? ['duo'] : []),
    ...(outfit ? [outfit] : []),
    ...(input.size ? [`size:${input.size}`] : []),
    ...(input.types ?? []),
    ...Object.entries(imagePromptMacros(input)).map(([k, v]) => `${v.trim() ? 'has' : 'no'}:${k}`),
  ];
}

function macroContext(input: ImagePromptInput, extra: Record<string, string> = {}) {
  return {
    char: input.character.name,
    pronoun: input.character.pronoun,
    user: input.companionName ?? input.withUser?.name ?? '',
    extra: { ...imagePromptMacros(input), ...extra },
  };
}

/** {{image_recent::N}}：最近的对话只要最后 N 句 */
function withRecentCount(text: string, recent: string[] | undefined): string {
  return text.replace(/\{\{image_recent::(\d+)\}\}/gi, (_, n: string) => (recent ?? []).slice(-Number(n)).join('\n'));
}

/** 按"生图"预设拼发给模型的提示词：块按触发条件和这次的类型挑，宏换成这次的数据；世界书按这次的数据扫描 */
export function buildImagePromptMessages(input: ImagePromptInput, preset: TaskPreset): ChatMessage[] {
  const blocks: PromptBlock[] = preset.blocks.map((b) => (b.content.includes('{{') ? { ...b, content: withRecentCount(b.content, input.recent) } : b));
  return assembleTaskPrompt({
    preset: { ...preset, blocks },
    fills: {},
    scan: Object.values(imagePromptMacros(input)).filter((v) => v.trim()),
    macros: macroContext(input),
    type: imagePromptTypes(input),
  }).messages;
}

/** 预设里触发条件对得上这个（再加上这次的类型，可以写成 image-prompt:scene+duo）的块（开着的），宏换成这次的数据后用逗号接起来；一块都没有时为 null */
function presetText(preset: Pick<TaskPreset, 'blocks'> | null | undefined, trigger: string, input: ImagePromptInput, extra: Record<string, string> = {}): string | null {
  const types = new Set([trigger, ...imagePromptTypes(input)]);
  const blocks = (preset?.blocks ?? []).filter((b) => b.enabled && !b.marker && b.triggers?.some((t) => t.split('+')[0]!.trim() === trigger && triggerMatches([t], types)));
  if (!blocks.length) return null;
  const ctx = macroContext(input, extra);
  return blocks.map((b) => substituteMacros(withRecentCount(b.content, input.recent), ctx).trim()).filter(Boolean).join(', ');
}

/** 预设里有没有这一类的块（任何拼法） */
function presetHas(preset: Pick<TaskPreset, 'blocks'> | null | undefined, prefix: string): boolean {
  return (preset?.blocks ?? []).some((b) => b.enabled && !b.marker && b.triggers?.some((t) => t.startsWith(prefix)));
}

/** 格式不对时让模型重写的那句话：预设里触发条件写了 retry 的块；没有就不重写 */
export function imagePromptRetry(preset: Pick<TaskPreset, 'blocks'> | null | undefined, input: ImagePromptInput): string {
  const types = new Set(['retry', ...imagePromptTypes(input)]);
  return (preset?.blocks ?? [])
    .filter((b) => b.enabled && !b.marker && b.triggers?.some((t) => t.split('+')[0]!.trim() === 'retry' && triggerMatches([t], types)))
    .map((b) => substituteMacros(b.content, macroContext(input)).trim())
    .filter(Boolean)
    .join('\n');
}

/** 带不带你立绘的 Vibe：预设里有触发条件写了 vibe:<类型> 的块（开着的），而且这次的类型对得上（可以写成 vibe:peek+visit） */
export function wantsUserVibe(preset: Pick<TaskPreset, 'blocks'> | null | undefined, input: ImagePromptInput): boolean {
  const types = new Set(imagePromptTypes(input));
  return (preset?.blocks ?? []).some((b) => b.enabled && !b.marker && b.triggers?.some((t) => t.startsWith('vibe:') && triggerMatches([t.slice(5)], types)));
}

const SIZES = new Set(['portrait', 'landscape', 'square']);

/**
 * tags 整理：按逗号、换行切开，去掉空的、重复的和带中文的（生图接口读不了中文，发过去等于没写、只剩画风词，会画出一堆随机的人；
 * 整段都是中文时 image### 算没写，让模型按 retry 那块重写）
 */
function cleanTags(tags: string): string {
  return joinTags(tags.replace(/[\r\n]+/g, ', ').split(/[,，]/).map((t) => t.trim()).filter((t) => !/[\u4e00-\u9fff]/.test(t)).join(', '));
}

/** 一段"名字###"的开头：名字见 IMAGE_PROMPT_SECTIONS；前面紧挨着别的词的（例如 char negative###）不算 */
const SECTION_RE = new RegExp(`(?<![A-Za-z0-9_][ \\t_-]*)(${IMAGE_PROMPT_SECTIONS.join('|')})[ \\t]*###`, 'gi');

/** 输出里的每一段：内容到下一个 ### 或者下一段的开头为止（最后一段忘了收尾的 ### 也认） */
function sections(text: string): { name: string; body: string }[] {
  const heads = [...text.matchAll(SECTION_RE)];
  return heads.map((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const close = text.indexOf('###', from);
    const next = heads[i + 1]?.index ?? text.length;
    const end = close >= 0 ? Math.min(close, next) : next;
    return { name: (m[1] ?? '').toLowerCase(), body: text.slice(from, end).trim() };
  });
}

/** 读模型的输出（image###tags###，另外认 negative###、size###）；没有 image### 或者里面是空的时为 null（让模型重写） */
export function parseImagePrompt(text: string): ImagePromptOutput | null {
  const list = sections(text);
  const body = (name: string) => list.filter((x) => x.name === name).map((x) => x.body).join(', ');
  // NovelAI 的 | 写法：第一段是整体画面，后面每段一个人；负面 tags 按同样的顺序
  const [base = '', ...people] = body('image').split(IMAGE_PROMPT_PERSON_SEPARATOR);
  const tags = cleanTags(base);
  if (!tags) return null;
  const negParts = body('negative').split(IMAGE_PROMPT_PERSON_SEPARATOR);
  const size = list.find((x) => x.name === 'size')?.body.toLowerCase();
  const out: ImagePromptOutput = {
    caption: '',
    tags,
    negative: cleanTags(people.length ? (negParts[0] ?? '') : negParts.join(', ')),
    ...(size && SIZES.has(size) ? { size: size as PromptSize } : {}),
  };
  const others = people.map((p, i) => ({ tags: cleanTags(p), negative: cleanTags(negParts[i + 1] ?? '') })).filter((o) => o.tags);
  if (others.length) out.others = others;
  return out;
}

/** 人数 tags 里写了 no humans，又没有 1girl、2boys、multiple girls 这类有人的 */
function noHumans(lead: string): boolean {
  const tags = lead.split(',').map((t) => t.trim().toLowerCase());
  return tags.includes('no humans') && !tags.some((t) => /^\d|^multiple /.test(t));
}

/** 出图用哪种拼法：只画背景 background → image### 写了 no humans 时 no-humans → 画什么（scene / portrait / face） */
export function composeKind(out: ImagePromptOutput, input: ImagePromptInput): string {
  if (input.mode === 'background') return 'background';
  if (noHumans(leadCountTags(out.tags).lead)) return 'no-humans';
  return input.mode ?? 'scene';
}

/**
 * 模型的输出 → 生图请求，全按预设：
 * - 正向：触发条件写了 image-prompt:<拼法> 的块；预设里没有这类块、或者拼出来是空的，就是 image### 原样；
 * - 负面：触发条件写了 image-negative:<拼法> 的块；预设里没有这类块时是 negative### 原样；
 * - 画幅：场景定的 → 模型写的 size### → 触发条件写了 image-size:<拼法> 的块 → portrait；
 * - image### 用 | 分了人：后面每段原样做 NovelAI V4 的人物提示词，负面是 negative### 里同一个位置的那段。
 * 拼的时候能用的宏：发给模型时的那些，加上 {{image}}（image### 整段）、{{image_count}}（里面的人数 tags）、{{image_tags}}（除了人数的）、{{negative}}（negative###）
 */
export function toImageRequest(out: ImagePromptOutput, input: ImagePromptInput, preset?: Pick<TaskPreset, 'blocks'> | null, seed?: number): ImageRequest {
  const kind = composeKind(out, input);
  const { lead, rest } = leadCountTags(out.tags);
  const extra = { image: out.tags, image_count: lead, image_tags: rest, negative: out.negative };
  const prompt = joinTags(presetText(preset, `image-prompt:${kind}`, input, extra) ?? '') || out.tags;
  const negative = presetHas(preset, 'image-negative:') ? joinTags(presetText(preset, `image-negative:${kind}`, input, extra) ?? '') : out.negative;
  const presetSize = presetText(preset, `image-size:${kind}`, input, extra)?.split(',').map((s) => s.trim().toLowerCase()).find((s) => SIZES.has(s));
  const size: ImageSize = input.size ?? out.size ?? (presetSize as PromptSize | undefined) ?? 'portrait';
  const characters: ImageCharacter[] = (out.others ?? []).map((o) => ({ prompt: o.tags, negative: o.negative }));
  return { prompt, negative, size, seed, ...(characters.length ? { characters } : {}) };
}

/** 没有分配生图提示词智能体、或者没有生图预设时：image### 就是写好的画面描述原文 */
export function fallbackImagePrompt(input: ImagePromptInput): ImagePromptOutput {
  return { caption: (input.caption ?? '').slice(0, 30), tags: (input.caption ?? '').trim(), negative: '' };
}
