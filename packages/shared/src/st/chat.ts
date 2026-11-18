import type { Message } from '../types/chat.ts';

export interface ParsedChat {
  characterName: string;
  userName: string;
  messages: Omit<Message, 'id' | 'chatId'>[];
}

interface StMessage {
  name?: string;
  is_user?: boolean;
  is_system?: boolean;
  mes?: string;
  send_date?: string | number;
  swipes?: string[];
  swipe_id?: number;
  swipe_info?: { send_date?: string | number }[];
  extra?: { type?: string; model?: string };
  user_name?: string;
  character_name?: string;
  chat_metadata?: unknown;
}

/** ST 的 ISO、毫秒时间戳和旧版 YYYY-MM-DD@HHhMMmSSsMSms。 */
function messageTime(value: string | number | undefined, fallback: number): number {
  let time: number;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value))) time = Number(value);
  else {
    const text = (value ?? '').replace(
      /(\d{4})-(\d{1,2})-(\d{1,2})\s?@(\d{1,2})h\s?(\d{1,2})m\s?(\d{1,2})s(?:\s?(\d{1,3})ms)?/,
      (_, y: string, m: string, d: string, h: string, min: string, s: string, ms?: string) =>
        `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}T${h.padStart(2, '0')}:${min.padStart(2, '0')}:${s.padStart(2, '0')}.${(ms ?? '0').padStart(3, '0')}Z`,
    ).replace(/(\d)(am|pm)$/i, '$1 $2');
    time = Date.parse(text);
  }
  return Number.isFinite(time) ? time : fallback;
}

/** 逐行读 ST JSONL：首行元数据不当消息；正文、时间和备选回复原样保留。 */
export function parseChat(text: string, now = Date.now()): ParsedChat {
  const result: ParsedChat = { characterName: '', userName: '', messages: [] };
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let fallback = now - lines.length;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) continue;
    let row: StMessage;
    try {
      row = JSON.parse(line) as StMessage;
    } catch {
      throw new Error(`第 ${index + 1} 行不是完整的 JSON`);
    }
    if (row && typeof row.mes !== 'string' && ('chat_metadata' in row || 'user_name' in row || 'character_name' in row)) {
      result.characterName = row.character_name === 'unused' ? '' : (row.character_name ?? '');
      result.userName = row.user_name === 'unused' ? '' : (row.user_name ?? '');
      continue;
    }
    if (!row || typeof row.mes !== 'string') throw new Error(`第 ${index + 1} 行没有聊天正文 mes`);
    const createdAt = messageTime(row.send_date, fallback);
    fallback = createdAt + 1;
    const swipes = (row.swipes ?? []).map((text, i) => ({ text, createdAt: messageTime(row.swipe_info?.[i]?.send_date, createdAt) }));
    const swipeIndex = Math.max(0, Math.min(row.swipe_id ?? 0, swipes.length - 1));
    // ST 允许编辑当前正文而保留其他备选；当前版本以 mes 为准。
    if (swipes.length) swipes[swipeIndex] = { ...swipes[swipeIndex]!, text: row.mes };
    const role = row.is_user ? 'user' : row.extra?.type === 'narrator' ? 'narrator' : 'assistant';
    if (role === 'assistant' && !result.characterName) result.characterName = row.name ?? '';
    if (role === 'user' && !result.userName) result.userName = row.name ?? '';
    result.messages.push({
      role, text: row.mes, parts: [{ type: 'text', text: row.mes }],
      createdAt, updatedAt: now, expression: null, swipes, swipeIndex,
      proactive: false, read: true,
      meta: { ...(row.extra?.model ? { model: row.extra.model } : {}) },
    });
  }
  if (!result.messages.length) throw new Error('文件里没有聊天消息');
  return result;
}
