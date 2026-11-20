import { nullable, str } from './modelText.ts';
import type { TaskPresetLike } from './st/task.ts';
import { shiftDate, zonedDateKey, zonedInstant } from './timezone.ts';
import type { Character } from './types/character.ts';
import type { DiaryEntry } from './types/memory.ts';
import type { Preset } from './types/preset.ts';
import type { NotificationPreview } from './types/proactive.ts';
import type { SocialDay } from './types/social.ts';

/**
 * 日记在手机和云端共用的部分：每晚几点写、该补写哪几天、读模型的输出、把一篇日记写成一行字（进提示词）。
 * 开了"主动写日记"的角色每晚 22:00（按"环境与作息"的时区）写当天（节律日）的日记：
 * 连了云端时云端写（App 关着也写），没连时 App 开着到点写；22:00 时 App 没开，第二天上午打开时补写昨天的。
 */

/** 每晚几点写（当天的第几分钟） */
export const DIARY_MINUTE = 22 * 60;
export const DIARY_TIME_LABEL = '22:00';
/** 到点之后多久以内还补写：22:00 时没写成（App 没开、云端失败），第二天中午之前还补 */
export const DIARY_CATCH_UP_MS = 14 * 3_600_000;

/** 这一天的日记该写的时刻（毫秒） */
export function diaryDueAt(date: string, timezone: string): number {
  return zonedInstant(date, DIARY_MINUTE, timezone);
}

/** 这个角色这一天的日记的 id：手机和云端算的一样，两边不会各写一篇 */
export function diaryId(characterId: string, date: string): string {
  return `diary:${characterId}:${date}`;
}

/** 开着"主动写日记"吗 */
export function diaryEnabled(c: Pick<Character, 'diary'> | null | undefined): boolean {
  return !!c?.diary?.enabled;
}

/** 日记配不配图（默认配） */
export function diaryImageOn(c: Pick<Character, 'diary'> | null | undefined): boolean {
  return c?.diary?.image !== false;
}

/** 现在该写的那几天（昨天的、今天的）：过了 22:00、还在补写窗口里 */
export function dueDiaryDates(now: number, timezone: string, catchUpMs = DIARY_CATCH_UP_MS): { date: string; dueAt: number }[] {
  const today = zonedDateKey(now, timezone);
  return [shiftDate(today, -1), today]
    .map((date) => ({ date, dueAt: diaryDueAt(date, timezone) }))
    .filter((d) => d.dueAt <= now && now - d.dueAt < catchUpMs);
}

// —— 读模型的输出 ——

/** 一篇日记（"日记"预设的输出） */
export interface DiaryDraft {
  title: string;
  weather: string;
  mood: string;
  text: string;
  highlights: string[];
  /** 要配的图的画面（中文一句话）；不配图为 null */
  image: string | null;
}

export function parseDiaryDraft(value: unknown): DiaryDraft | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = str(v.text) || str(v.content) || str(v.diary);
  if (!text) return null;
  const highlights = (Array.isArray(v.highlights) ? v.highlights : typeof v.highlights === 'string' ? v.highlights.split(/[、，,；;]/) : [])
    .map((h) => str(h))
    .filter(Boolean)
    .slice(0, 4)
    .map((h) => h.slice(0, 16));
  const image = nullable(v.image);
  return {
    title: (nullable(v.title) ?? '').slice(0, 30),
    weather: (nullable(v.weather) ?? '').slice(0, 12),
    mood: (nullable(v.mood) ?? '').slice(0, 12),
    text: text.slice(0, 4000),
    highlights,
    image: image ? image.slice(0, 300) : null,
  };
}

/** 一篇日记写成一行字（进提示词、记忆拼装器）："11-18 苏晚的日记《雨天》：「……」" */
export function diaryLine(e: Pick<DiaryEntry, 'date' | 'title' | 'text' | 'mood'>, name: string, max = 160): string {
  const body = e.text.replace(/\s+/g, ' ').trim();
  return `${e.date.slice(5)} ${name}的日记${e.title ? `《${e.title}》` : ''}${e.mood ? `（心情：${e.mood}）` : ''}：「${body.length > max ? `${body.slice(0, max)}…` : body}」`;
}

// —— 云端 ——

/**
 * 上传云端的那份（按角色）：云端每晚 22:00 按它写。
 * withUser 是手机拼的"今天和你"（date 那一天的）；云端写的不是那一天时不用它（好几天没开 App）
 */
export interface DiaryContext {
  character: Pick<Character, 'id' | 'name' | 'pronoun'> & {
    card: Pick<Character['card'], 'description' | 'personality' | 'scenario'>;
  };
  userName: string;
  timezone: string;
  settings: { enabled: boolean; image: boolean };
  /** 手机上今天的节律（云端排过今天的以云端为准）；地点已经换成名字 */
  day: SocialDay | null;
  /** withUser 写的是哪一天 */
  date: string;
  /** 今天和你：聊天里说过的、一起做过的事 */
  withUser: string;
  /** Ta记得的关于你的事 */
  memories: string;
  /** 最近几篇日记（避免重复） */
  previous: string;
  /** Ta那边现在的天气（一句话） */
  weather: string;
  preset: (Pick<Preset, 'sampler'> & TaskPresetLike) | null;
  /** 通知里显示多少（同主动消息的设置） */
  preview: NotificationPreview;
}

/** 日记生成只用角色描述、性格、场景和任务预设；附件、界面配置及导出备份留在本机原始记录里。 */
export function packDiaryContext(input: DiaryContext): DiaryContext {
  const { character: c, preset } = input;
  const { description, personality, scenario } = c.card;
  return {
    ...input,
    character: { id: c.id, name: c.name, pronoun: c.pronoun, card: { description, personality, scenario } },
    preset: preset ? {
      blocks: preset.blocks.map(({ extra: _extra, ...block }) => block),
      sampler: preset.sampler,
      worldInfoEnabled: preset.worldInfoEnabled,
      lorebooks: preset.lorebooks?.map(({ extra: _extra, entries, ...book }) => ({
        ...book, entries: entries.map(({ extra: _entryExtra, ...entry }) => entry),
      })),
    } : null,
  };
}

/** 云端写好的日记（/v1/diary/entries）：图由手机收到后再画 */
export interface HubDiaries {
  entries: { doneAt: number; entry: DiaryEntry }[];
  errors: { characterId: string; date: string; reason: string }[];
}
