import { assembleTaskPrompt, IMAGE_PROMPT_MODIFIERS, IMAGE_PROMPT_SECTIONS, joinTags, leadCountTags } from '@app/shared';
import type { ImageRequest, ImageSize } from '../image/types.ts';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 生图提示词智能体（设计文档 §4.3）：把对话里的一个画面（[cg:描述]、"画一张"、约会的关键时刻、番外里的一幕）
 * 写成 NovelAI 的 tags。外观基础 tags 来自角色卡，模型只写构图、动作、表情、服装、场景、光线；
 * 程序把外观 tags 放在最前面，负面 tags 合并角色卡的，标题、画幅也由程序定。
 * 提示词（任务、规则、"画什么"、输出格式）全在"生图"预设里；这里只填这一次的输入。
 *
 * 模型的输出不是 JSON，是几段"名字###内容###"（parseImagePrompt 读，toImageRequest 拼成生图请求）：
 *   image###1girl, upper body, smile, ...###        画面的 tags（必须有）
 *   negative###...###                              额外的负面 tags（可以不写）
 *   size###landscape###                            画幅 portrait / landscape / square（可以不写：程序给了画幅时照程序的，否则竖图）
 *   char left###girl, smile, ...###                两个人同框时她的那一份（left / right / center 是位置，可以不写）
 *   user right###boy, ...###                       两个人同框时"你"的那一份
 *   char negative###...###                         只针对她（或 user negative###：只针对你）的负面 tags
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
  /**
   * 一起做事时画的是哪个时刻（入座 seat、偷拍 peek、奖励 reward……）：场景的生图预设里触发条件写了它的块只在这时发送。
   * 和 mode 一起当作这一次的类型（跟随配图时，配图预设按 mode 发"画什么"那一块）
   */
  moment?: string;
  character: {
    name: string;
    /** 她的长相（{{char_appearance}}）：原创是外观 tags；同人是角色 tag + 作品 tag（+ 补充的外观） */
    appearanceTags: string;
    negativeTags?: string;
    pronoun?: string;
    /** 她今天这个场景该穿的那套（节律）：{{char_outfit}} */
    outfit?: { name: string; tags: string } | null;
  };
  /**
   * 衣服由程序加（一起做事时按节律该穿的那套，同一天的图衣服一致）：加在外观后面，模型不用写衣服。
   * 不锁时只告诉模型她今天穿什么，画面要换装（[cg:] 里写了泳装之类）时模型自己写
   */
  lockOutfit?: boolean;
  /** 要画的画面（中文描述） */
  caption: string;
  scene?: {
    /** 在哪：图书馆、雨夜的卧室…… */
    place?: string;
    /** 服装：睡衣、运动服、约会装…… */
    outfit?: string;
    timeOfDay?: string;
    weather?: string;
    /** 此刻的表情 */
    expression?: string;
  };
  /** 最近几句对话（帮助理解画面），纯文本 */
  recent?: string[];
  /**
   * "你"可以入画（{{user}} 的长相按人设的外观 tags）：画不画、画成单人还是双人由生图预设定，
   * 预设里"{{user}}可以入画"那一块（程序填充 imageCharacters）发了才告诉模型；两个人同框时用 V4 的多人提示词
   */
  withUser?: { name: string; appearanceTags?: string; negativeTags?: string } | null;
  /**
   * 画幅由程序定（例如陪伴学习分上下两屏时，半屏接近方形就画方图）：告诉模型按这个画幅构图，出图时也按它，不看模型写的 size
   */
  size?: PromptSize;
  /** 不同框、只在预设里出现的另一个人（{{user}}）：画"你"这边时是她，陪着你但不在画面里 */
  companionName?: string;
}

/** 提示词里能用的画幅（竖图、横图、方图） */
export type PromptSize = 'portrait' | 'landscape' | 'square';

const SIZE_LABEL: Record<PromptSize, string> = { portrait: '竖图（portrait）', landscape: '横图（landscape）', square: '方图（square）' };

export interface ImagePromptOutput {
  /** 中文短标题，进相册（程序按要画的画面写） */
  caption: string;
  tags: string;
  negative: string;
  /** 模型写的画幅（size###）；没写时由程序定 */
  size?: PromptSize;
  /** 两个人同框时每个人单独的 tags（模型给出的动作），外观 tags 由程序补上 */
  characters?: { who: 'char' | 'user'; tags: string; negative?: string; position?: 'left' | 'right' | 'center' }[];
}

/** 衣服锁定时实际加进提示词的服装 tags */
function lockedOutfit(input: ImagePromptInput): string {
  return input.lockOutfit && input.mode !== 'background' ? (input.character.outfit?.tags.trim() ?? '') : '';
}

/** 这一次的输入：填进"生图"预设的程序填充块 */
export function imagePromptFills(input: ImagePromptInput): Record<string, string> {
  const { character: c, scene = {}, withUser } = input;
  const mode = input.mode ?? 'scene';
  const outfit = c.outfit;
  const locked = lockedOutfit(input);
  return {
    // "你"可以入画时：你的长相和两个人同框时的输出字段（解析时按 characters 读每个人的动作）；单人图不写 characters
    imageCharacters:
      withUser && mode === 'scene'
        ? [
            `${withUser.name}可以入画；外观 tags（程序会加，不要重复）：${withUser.appearanceTags || '（无）'}`,
            `画${c.name}和${withUser.name}两个人同框时：image### 里只写整体画面（人数、构图、场景、光线），再各起一行分别写每个人：`,
            `char###${c.name}的人物类别（boy/girl/other）、表情、动作、服装###`,
            `user###${withUser.name}的人物类别（boy/girl/other）、表情、动作、服装###`,
            `人物类别按各自的外观与角色信息填写，不按 char / user 固定性别。位置明确时在 char / user 后面空一格写 left、right 或 center（例如 char left###…###），不指定位置时不写。`,
            `只针对一个人的负面 tags 另起一行写 char negative###…### 或 user negative###…###。只画${c.name}一个人时不写 char### 和 user###。`,
          ].join('\n')
        : '',
    imageSubject: [
      `角色：${c.name}${c.pronoun ? `（${c.pronoun}）` : ''}；外观 tags（程序会加，不要重复）：${c.appearanceTags || '（无）'}`,
      locked && outfit ? `服装：${outfit.name}；服装 tags（程序会加在外观后面，不要重复，也不要另写别的衣服）：${locked}` : outfit ? `${c.name}今天穿：${outfit.name}（${outfit.tags}）` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    imageScene: [
      scene.place ? `地点：${scene.place}` : '',
      scene.outfit ? `服装：${scene.outfit}` : '',
      [scene.timeOfDay, scene.weather].filter(Boolean).length ? `时间与天气：${[scene.timeOfDay, scene.weather].filter(Boolean).join('，')}` : '',
      scene.expression ? `此刻的表情：${scene.expression}` : '',
      input.size ? `画幅：${SIZE_LABEL[input.size]}，程序按这个画幅出图，构图照它来` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    imageRecent: input.recent?.length ? `最近的对话：\n${input.recent.slice(-6).join('\n')}` : '',
    imageCaption: `要画的画面：${input.caption}`,
  };
}

/** 生图预设里能用的宏：{{char_appearance}} {{char_outfit}} {{user_appearance}}，按这次画的角色替换 */
export function imagePromptMacros(input: ImagePromptInput): Record<string, string> {
  return {
    char_appearance: input.character.appearanceTags,
    char_outfit: input.character.outfit ? `${input.character.outfit.name}（${input.character.outfit.tags}）` : '',
    user_appearance: input.withUser?.appearanceTags ?? '',
  };
}

/** 这一次的类型：画什么（scene / portrait / face / background）+ 场景里的时刻 */
export function imagePromptTypes(input: ImagePromptInput): string[] {
  return [input.mode ?? 'scene', ...(input.moment ? [input.moment] : [])];
}

/** 按"生图"预设拼写 tags 的提示词；"画什么"那几块、场景时刻那几块按这次的类型只发对应的 */
export function buildImagePromptMessages(input: ImagePromptInput, preset: TaskPreset): ChatMessage[] {
  return assembleTaskPrompt({
    preset,
    fills: imagePromptFills(input),
    macros: { char: input.character.name, pronoun: input.character.pronoun, user: input.withUser?.name ?? input.companionName ?? '', extra: imagePromptMacros(input) },
    type: imagePromptTypes(input),
  }).messages;
}

const SIZES = new Set(['portrait', 'landscape', 'square']);
const POSITIONS: ReadonlySet<string> = new Set(IMAGE_PROMPT_MODIFIERS.filter((m) => m !== 'negative'));

/** 英文 tags 清理：去掉中文和模型多写的外观、质量词 */
function cleanTags(tags: string): string {
  return joinTags(
    tags
      .replace(/[\r\n]+/g, ', ')
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => t && !/[\u4e00-\u9fff]/.test(t) && !/^(?:masterpiece|best quality|high quality|amazing quality|very aesthetic|absurdres)$/i.test(t))
      .join(', '),
  );
}

/** 一段"名字###"的开头：名字见 IMAGE_PROMPT_SECTIONS，char、user 后面可以跟位置和 negative（IMAGE_PROMPT_MODIFIERS） */
const SECTION_RE = new RegExp(`\\b(${IMAGE_PROMPT_SECTIONS.join('|')})((?:[ \\t_-]+(?:${IMAGE_PROMPT_MODIFIERS.join('|')}))*)[ \\t]*###`, 'gi');

/** 输出里的每一段：内容到下一个 ### 或者下一段的开头为止（最后一段忘了收尾的 ### 也认） */
function sections(text: string): { name: string; mods: string[]; body: string }[] {
  const heads = [...text.matchAll(SECTION_RE)];
  return heads.map((m, i) => {
    const from = (m.index ?? 0) + m[0].length;
    const close = text.indexOf('###', from);
    const next = heads[i + 1]?.index ?? text.length;
    const end = close >= 0 ? Math.min(close, next) : next;
    return {
      name: (m[1] ?? '').toLowerCase(),
      mods: (m[2] ?? '').toLowerCase().split(/[ \t_-]+/).filter(Boolean),
      body: text.slice(from, end).trim(),
    };
  });
}

/** 读模型的输出（image###tags### 那几段）；没有 image### 或者里面没有能用的 tags 时为 null（让模型重写） */
export function parseImagePrompt(text: string): ImagePromptOutput | null {
  const list = sections(text);
  const tags = cleanTags(list.filter((x) => x.name === 'image').map((x) => x.body).join(', '));
  if (!tags) return null;
  const size = list.find((x) => x.name === 'size')?.body.toLowerCase();
  const out: ImagePromptOutput = {
    caption: '',
    tags,
    negative: cleanTags(list.filter((x) => x.name === 'negative').map((x) => x.body).join(', ')),
    ...(size && SIZES.has(size) ? { size: size as PromptSize } : {}),
  };
  const chars = (['char', 'user'] as const).flatMap((who) => {
    const mine = list.filter((x) => x.name === who);
    const own = cleanTags(mine.filter((x) => !x.mods.includes('negative')).map((x) => x.body).join(', '));
    if (!own) return [];
    const position = mine.flatMap((x) => x.mods).find((m): m is 'left' | 'right' | 'center' => POSITIONS.has(m));
    return [{ who, tags: own, negative: cleanTags(mine.filter((x) => x.mods.includes('negative')).map((x) => x.body).join(', ')), ...(position ? { position } : {}), at: list.indexOf(mine[0]!) }];
  });
  // 按写的先后排（位置明确时从左到右写）
  if (chars.length) out.characters = chars.sort((a, b) => a.at - b.at).map(({ at: _at, ...c }) => c);
  return out;
}

/** 让模型重写时的提醒 */
export const IMAGE_PROMPT_RETRY = '上面的输出没有按要求的写法。请只输出 image###逗号分隔的英文 tags### 这样的一段（需要时另起一行 negative###…###），不要 JSON、不要任何其他文字。';

const CENTERS = { left: { x: 0.3, y: 0.5 }, right: { x: 0.7, y: 0.5 }, center: { x: 0.5, y: 0.5 } } as const;

/** 人物块去掉人数和 solo，保留人数标签里的人物类别。 */
function characterTags(tags: string | undefined): string {
  const { lead, rest } = leadCountTags(tags ?? '');
  const subjects = lead.split(',').flatMap((tag) => {
    const match = tag.trim().match(/^(?:\d+\+?|multiple\s+)(girl|boy|other)s?$/i);
    return match ? [match[1]!.toLowerCase()] : [];
  });
  return joinTags(...subjects, rest);
}

/** 模型画了两个人同框（"你"可以入画、输出里有"你"的那一份） */
export function hasUserInFrame(out: ImagePromptOutput, input: ImagePromptInput): boolean {
  return !!input.withUser && input.mode !== 'background' && !!out.characters?.some((c) => c.who === 'user');
}

/**
 * 智能体的输出 → 生图请求：单人时人数 tags 在最前面，接着是她的长相（同人是角色 tag + 作品 tag）、锁定的衣服，再是画面；
 * 两个人时整体 tags 做基础提示词（人数在这里），每个人的外观（去掉人数 tags）+ 动作做 V4 的人物提示词，按左右位置放
 */
export function toImageRequest(out: ImagePromptOutput, input: ImagePromptInput, seed?: number): ImageRequest {
  // 背景图不画人：不加外观 tags，确保有 no humans；画幅没定时用横图
  if (input.mode === 'background') {
    return { prompt: joinTags('no humans, scenery', out.tags), negative: joinTags('1girl, 1boy, people', out.negative), size: input.size ?? out.size ?? 'landscape', seed };
  }
  // 画幅：程序给的 → 模型写的 size### → 两个人同框横图、其余竖图
  const size: ImageSize = input.size ?? out.size ?? (hasUserInFrame(out, input) ? 'landscape' : 'portrait');
  const negative = joinTags(input.character.negativeTags, out.negative);
  const outfit = lockedOutfit(input);
  if (hasUserInFrame(out, input)) {
    return {
      prompt: out.tags,
      negative: out.negative,
      size,
      seed,
      characters: (out.characters ?? []).map((c) => ({
        prompt: c.who === 'char'
          ? joinTags(characterTags(input.character.appearanceTags), outfit, characterTags(c.tags))
          : joinTags(characterTags(input.withUser?.appearanceTags), characterTags(c.tags)),
        negative: joinTags(c.who === 'char' ? input.character.negativeTags : input.withUser?.negativeTags, c.negative),
        ...(c.position ? { center: CENTERS[c.position] } : {}),
      })),
    };
  }
  const scene = leadCountTags(out.tags);
  // 模型判断画面里没有人（她只拍了吃的、东西、风景）：不加她的长相和衣服，否则和 no humans 打架，会把她硬塞进画面边上
  if (noHumans(scene.lead)) return { prompt: joinTags(scene.lead, scene.rest), negative, size, seed };
  const appearance = leadCountTags(input.character.appearanceTags);
  return { prompt: joinTags(scene.lead, appearance.lead, appearance.rest, outfit, scene.rest), negative, size, seed };
}

/** 人数 tags 里写了 no humans，又没有 1girl、2boys、multiple girls 这类有人的 */
function noHumans(lead: string): boolean {
  const tags = lead.split(',').map((t) => t.trim().toLowerCase());
  return tags.includes('no humans') && !tags.some((t) => /^\d|^multiple /.test(t));
}

/** 没有分配生图提示词智能体时的退路：外观 tags + 画面描述原文（V4 起能读懂一些自然语言） */
export function fallbackImagePrompt(input: ImagePromptInput): ImagePromptOutput {
  const lead = { scene: '', portrait: 'full body', face: 'close-up, portrait', background: '' }[input.mode ?? 'scene'];
  return { caption: input.caption.slice(0, 30), tags: joinTags(lead, input.caption), negative: '' };
}
