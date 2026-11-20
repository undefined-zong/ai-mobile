import { IMAGE_MODES, IMAGE_MOMENTS, MODULE_TAGS, PRESET_USES, type ControlTagKind, type ImageMode, type PresetUseId } from '@app/shared';

/** 主对话保留实时表情和动作，副对话负责回复末尾的卡片、配图与附加任务。 */
export const SECONDARY_TAGS: readonly ControlTagKind[] = [...MODULE_TAGS, 'cg', 'choice'];

/**
 * 副对话的输出不是 JSON：要追加的正文和隐藏标签照主对话的写法直接写（[music:…]、[cg:画面描述]……），
 * [cg:] 的画法另起一行写"名字###值###"（同生图的 image### 写法），程序读完从正文里去掉：
 *   mode###portrait###     画什么（IMAGE_MODES）
 *   use###image:date###    生图用途（生图类的预设用途）
 *   moment###keepsake###   这个用途的时刻（写 id 或中文名都认）
 *   model###…###           生图 API 上的模型（只认这一轮列出来的）
 */
export const SECONDARY_IMAGE_FIELDS = ['mode', 'use', 'moment', 'model'] as const;
type ImageField = (typeof SECONDARY_IMAGE_FIELDS)[number];

export interface SecondaryImageChoice {
  mode?: ImageMode;
  use?: PresetUseId;
  moment?: string;
  model?: string;
}

export interface SecondaryReply {
  /** 追加到主回复末尾的正文和标签（已去掉画法那几行）；空串表示不追加 */
  append: string;
  /** 这一轮 [cg:] 的画法；没写或认不出的项不放，按默认画 */
  image: SecondaryImageChoice;
}

/** 生图用途有哪些时刻（一起做事时画的图才有）：id → 中文名 */
export function imageUseMoments(use: PresetUseId): Record<string, string> | undefined {
  return use.startsWith('image:') ? IMAGE_MOMENTS[use.slice(6) as keyof typeof IMAGE_MOMENTS] : undefined;
}

const FIELD_RE = new RegExp(`[ \\t]*\\b(${SECONDARY_IMAGE_FIELDS.join('|')})[ \\t]*###([^\\n]*?)###[ \\t]*(?:\\r?\\n)?`, 'gi');

/** 读副对话的输出；models 是这一轮给它选的生图模型 */
export function parseSecondaryReply(text: string, models: readonly string[] = []): SecondaryReply {
  const raw: Partial<Record<ImageField, string>> = {};
  const append = text
    .replace(FIELD_RE, (_m, name: string, value: string) => {
      raw[name.toLowerCase() as ImageField] ??= value.trim();
      return '';
    })
    .trim();
  const image: SecondaryImageChoice = {};
  const mode = (Object.keys(IMAGE_MODES) as ImageMode[]).find((m) => m === raw.mode);
  if (mode) image.mode = mode;
  const use = PRESET_USES.find((u) => u.category === 'image' && u.id === raw.use)?.id;
  if (use) image.use = use;
  const moment = use && Object.entries(imageUseMoments(use) ?? {}).find(([id, label]) => raw.moment === id || raw.moment === label)?.[0];
  if (moment) image.moment = moment;
  if (raw.model && models.includes(raw.model)) image.model = raw.model;
  return { append, image };
}
