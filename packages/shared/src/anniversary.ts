import type { TextFn } from './programText.ts';
import { monthDayKey } from './timeQuery.ts';
import { daysBetweenDates, zonedDateKey } from './timezone.ts';
import type { ISODate } from './types/common.ts';

/**
 * 纪念日：每个角色自己的一份（回忆页里加、改、删），按每年或每月过。
 * 日期是日历上的那一天，不是时刻：哪天算"今天"按「环境与作息」的时区。
 */
export type AnniversaryRepeat = 'yearly' | 'monthly';

export interface Anniversary {
  id: string;
  /** "在一起""她的生日""第一次约会" */
  label: string;
  /** 那一天：'2026-10-12'；不记得哪一年时只写月日 '--03-14'（只能每年过） */
  date: string;
  repeat: AnniversaryRepeat;
  /** 生日：数字写成"N 岁"，回忆按"生日"标签找；不是生日写"N 个月 / N 周年" */
  birthday?: boolean;
  /** 提前几天开始惦记：这几天里每轮聊天、主动消息都带着它 */
  remindDays: number;
}

/** 新加的纪念日默认提前几天开始惦记（每个纪念日都能改） */
export const DEFAULT_ANNIVERSARY_REMIND_DAYS = 7;

export interface AnniversaryOccurrence {
  anniversary: Anniversary;
  /** 下一次（今天或以后）是哪天 */
  date: ISODate;
  /** 还有几天：0 = 今天 */
  daysLeft: number;
  /** 第几次：每年的是第几年（生日是几岁），每月的是第几个月；那天还没到第一次、不记年份时为 null */
  count: number | null;
}

const FULL = /^(\d{4})-(\d{2})-(\d{2})$/;
const NO_YEAR = /^--(\d{2})-(\d{2})$/;
const pad = (n: number) => String(n).padStart(2, '0');

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 某年某月的"那一天"：这个月没有 31 号、2 月没有 29 号时算这个月最后一天 */
function dayIn(year: number, month: number, day: number): ISODate {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

/** 拆开日期；写错的返回 null */
export function parseAnniversaryDate(date: string): { year: number | null; month: number; day: number } | null {
  const full = date.match(FULL);
  const short = full ? null : date.match(NO_YEAR);
  if (!full && !short) return null;
  const year = full ? Number(full[1]) : null;
  const month = Number((full ?? short)![full ? 2 : 1]);
  const day = Number((full ?? short)![full ? 3 : 2]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year ?? 2000, month)) return null;
  return { year, month, day };
}

/** 今天（含）以后最近的一次 */
export function nextAnniversary(a: Anniversary, today: ISODate): AnniversaryOccurrence | null {
  const d = parseAnniversaryDate(a.date);
  if (!d) return null;
  const [ty, tm] = today.split('-').map(Number) as [number, number];
  // 那天还没到（以后的日子）：下一次就是那一天
  if (d.year !== null) {
    const first = dayIn(d.year, d.month, d.day);
    if (first >= today) return { anniversary: a, date: first, daysLeft: daysBetweenDates(today, first), count: null };
  }
  let date: ISODate;
  let count: number | null;
  if (a.repeat === 'monthly' && d.year !== null) {
    let y = ty;
    let m = tm;
    date = dayIn(y, m, d.day);
    if (date < today) {
      m = m === 12 ? 1 : m + 1;
      y = m === 1 ? y + 1 : y;
      date = dayIn(y, m, d.day);
    }
    count = (y - d.year) * 12 + (m - d.month);
  } else {
    let y = ty;
    date = dayIn(y, d.month, d.day);
    if (date < today) date = dayIn(++y, d.month, d.day);
    count = d.year === null ? null : y - d.year;
  }
  return { anniversary: a, date, daysLeft: daysBetweenDates(today, date), count };
}

/** 全部纪念日的下一次，近的在前 */
export function upcomingAnniversaries(list: readonly Anniversary[] | undefined, now: number, timeZone: string): AnniversaryOccurrence[] {
  const today = zonedDateKey(now, timeZone);
  return (list ?? [])
    .map((a) => nextAnniversary(a, today))
    .filter((o): o is AnniversaryOccurrence => !!o)
    .sort((x, y) => x.daysLeft - y.daysLeft || x.anniversary.label.localeCompare(y.anniversary.label));
}

/** 这一次叫什么："在一起 2 个月""在一起 1 周年""她的生日（23 岁）"；第一次还没到、不记年份时就是名字 */
export function anniversaryTitle(o: Pick<AnniversaryOccurrence, 'anniversary' | 'count'>): string {
  const { label, birthday, repeat } = o.anniversary;
  const n = o.count;
  if (!n) return label;
  if (birthday) return `${label}（${n} 岁）`;
  if (repeat === 'monthly' && n % 12) return `${label} ${n} 个月`;
  return `${label} ${repeat === 'monthly' ? n / 12 : n} 周年`;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "11 月 18 日 周三"（不带星期时 "11 月 18 日"） */
export function anniversaryDayLabel(date: ISODate, withWeekday = true): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return withWeekday ? `${m} 月 ${d} 日 ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}` : `${m} 月 ${d} 日`;
}

/** 还有多久："今天""明天""后天""3 天后" */
export function anniversaryWhen(daysLeft: number): string {
  return daysLeft === 0 ? '今天' : daysLeft === 1 ? '明天' : daysLeft === 2 ? '后天' : `${daysLeft} 天后`;
}

/** 给模型看的这一次叫什么（程序文字 common.anniversary.*：名字、几岁生日、几个月、几周年） */
export function anniversaryTitleText(o: Pick<AnniversaryOccurrence, 'anniversary' | 'count'>, t: TextFn): string {
  const { label, birthday, repeat } = o.anniversary;
  const n = o.count;
  if (!n) return t('common.anniversary.plain', { label });
  if (birthday) return t('common.anniversary.birthday', { label, n });
  if (repeat === 'monthly' && n % 12) return t('common.anniversary.months', { label, n });
  return t('common.anniversary.years', { label, n: repeat === 'monthly' ? n / 12 : n });
}

/** 给模型看的还有多久（程序文字 common.daysLater.*：今天、明天、后天、几天后） */
export function daysLaterText(days: number, t: TextFn): string {
  return days <= 2 ? t(`common.daysLater.${days}`) : t('common.daysLater.n', { days });
}

/**
 * 给模型看的一行（程序文字 env.anniversaries / env.anniversary.today / env.anniversary.soon）：今天的、和进了"提前几天惦记"的。都不在时为空。
 */
export function anniversaryLine(list: readonly Anniversary[] | undefined, now: number, timeZone: string, t: TextFn): string {
  const near = upcomingAnniversaries(list, now, timeZone).filter((o) => o.daysLeft <= Math.max(0, o.anniversary.remindDays));
  if (!near.length) return '';
  const items = near.map((o) =>
    o.daysLeft === 0
      ? t('env.anniversary.today', { title: anniversaryTitleText(o, t) })
      : t('env.anniversary.soon', { when: daysLaterText(o.daysLeft, t), date: anniversaryDayLabel(o.date), title: anniversaryTitleText(o, t) }),
  );
  return t('env.anniversaries', { items });
}

/**
 * 读进来的纪念日整理成现在的样子：以前存的是 { label, date: '3 月 14 日' } 这样的文字，
 * 认得出月日的改成每年的 '--03-14'，认不出（"下周三"）的不是真的日子，去掉。
 */
export function normalizeAnniversaries(raw: unknown): Anniversary[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((x, i): Anniversary[] => {
    if (!x || typeof x !== 'object') return [];
    const o = x as Partial<Anniversary> & { label?: unknown; date?: unknown };
    const label = typeof o.label === 'string' ? o.label.trim() : '';
    const text = typeof o.date === 'string' ? o.date.trim() : '';
    if (!label || !text) return [];
    const md = parseAnniversaryDate(text) ? null : monthDayKey(text);
    const date = md ? `--${md}` : text;
    if (!parseAnniversaryDate(date)) return [];
    const repeat: AnniversaryRepeat = o.repeat === 'monthly' && FULL.test(date) ? 'monthly' : 'yearly';
    return [{
      id: typeof o.id === 'string' && o.id ? o.id : `ann-${i}-${date}`,
      label,
      date,
      repeat,
      ...(o.birthday ?? /生日/.test(label) ? { birthday: true } : {}),
      remindDays: typeof o.remindDays === 'number' && o.remindDays >= 0 ? Math.round(o.remindDays) : DEFAULT_ANNIVERSARY_REMIND_DAYS,
    }];
  });
}
