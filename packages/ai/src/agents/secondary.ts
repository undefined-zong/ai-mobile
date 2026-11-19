import { IMAGE_MODES, MODULE_TAGS, PRESET_USES, type ControlTagKind, type ImageMode, type PresetUseId } from '@app/shared';

/** 主对话保留实时表情和动作，副对话负责回复末尾的卡片、配图与附加任务。 */
export const SECONDARY_TAGS: readonly ControlTagKind[] = [...MODULE_TAGS, 'cg', 'choice'];

export interface SecondaryReply {
  /** 追加到主回复末尾的文字，可带现有的主动卡片、选项等标签；空串表示不追加 */
  append: string;
  /** null 表示这轮不画图 */
  image: { caption: string; mode: ImageMode; use: PresetUseId; moment?: string; model?: string } | null;
}

/** 字段说明在副对话预设中；这里只读取输出，沿用现有的标签与生图协议。 */
export function parseSecondaryReply(value: unknown): SecondaryReply | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.append !== 'string') return null;
  const raw = v.image && typeof v.image === 'object' ? v.image as Record<string, unknown> : null;
  const image: SecondaryReply['image'] = raw && typeof raw.caption === 'string' && raw.caption.trim()
    ? {
        caption: raw.caption.trim(),
        mode: (Object.keys(IMAGE_MODES) as ImageMode[]).find((mode) => mode === raw.mode) ?? 'scene',
        use: PRESET_USES.find((use) => use.category === 'image' && use.id === raw.use)?.id ?? 'image',
        moment: typeof raw.moment === 'string' ? raw.moment.trim() || undefined : undefined,
        model: typeof raw.model === 'string' ? raw.model.trim() || undefined : undefined,
      }
    : null;
  return { append: v.append.trim(), image };
}
