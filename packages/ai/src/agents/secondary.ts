import { IMAGE_MODES, MODULE_TAGS, PRESET_USES, type ControlTagKind, type ImageMode, type PresetUseId } from '@app/shared';
import { parseJsonLoose } from '../core/util.ts';

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
  if (typeof v.append !== 'string' && !(v.append === undefined && (image || v.image === null))) return null;
  return { append: typeof v.append === 'string' ? v.append.trim() : '', image };
}

/** 附加任务直接输出文字；只拆出 append / image 控制信息，其余内容按原顺序保留。 */
export function parseSecondaryOutput(text: string): SecondaryReply {
  const parts: string[] = [];
  let image: SecondaryReply['image'] = null;
  let cursor = 0;
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{' && text[start] !== '[') continue;
    let end = jsonEnd(text, start);
    if (end === null) continue;
    const value = parseJsonLoose(text.slice(start, end));
    if (value === undefined) continue;
    const reply = parseSecondaryReply(value);
    if (!reply) {
      // 自定义 JSON（包括数组）整体保留，不把它内部的对象误当作控制信息。
      start = end - 1;
      continue;
    }
    let from = start;
    const fence = text.slice(cursor, start).match(/(^|\n)[ \t]*(`{3,}|~{3,})(?:json)?[ \t]*\r?\n[ \t]*$/i);
    const closing = fence && text.slice(end).match(new RegExp(`^[ \\t]*\\r?\\n[ \\t]*${fence[2]}[ \\t]*(?=\\r?\\n|$)`));
    if (fence && closing) {
      from = cursor + fence.index! + fence[1]!.length;
      end += closing[0].length;
    }
    const { append: _append, image: _image, ...extra } = value as Record<string, unknown>;
    const content = [reply.append, Object.keys(extra).length ? JSON.stringify(extra, null, 2) : ''].filter(Boolean).join('\n\n');
    parts.push(text.slice(cursor, from), content);
    image ??= reply.image;
    cursor = end;
    start = end - 1;
  }
  parts.push(text.slice(cursor));
  return { append: parts.join('').trim(), image };
}

/** 返回完整对象 / 数组的结束位置，字符串内的括号不参与配平。 */
function jsonEnd(text: string, start: number): number | null {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return null;
}
