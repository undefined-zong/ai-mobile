import type { TextFn } from './programText.ts';
import { cleanHtml, hash32, nullable, shortDay, shortStamp, str } from './modelText.ts';
import { outfitOfDay, toMinutes } from './rhythm.ts';
import type { RhythmDay } from './types/rhythm.ts';
import { zonedInstant } from './timezone.ts';
import { MOMENT_USER, SOCIAL_PER_DAY_MAX, type Moment, type SocialCharacterSettings, type SocialDay } from './types/social.ts';

/**
 * 朋友圈在手机和云端共用的部分：每天什么时候发（按角色和日期算出来的随机时间，两边算的一样）、
 * 读模型的输出、把一条朋友圈写成一行字（进提示词、进记忆）。
 */

/** 每天最多几条：1 到 SOCIAL_PER_DAY_MAX */
export function socialPerDay(settings: Pick<SocialCharacterSettings, 'perDay'>): number {
  return Math.min(SOCIAL_PER_DAY_MAX, Math.max(1, Math.round(settings.perDay) || 1));
}

/**
 * 一天里随机但可重复的几个时刻（当天的第几分钟，从早到晚）：同一个 key 同一天算出来的一样，
 * 所以重叠的 Cron、手机和云端不会各发各的。朋友圈、社群的帖子都用它。
 * 个数在 min 到 max 之间；把醒着的时段平分成几段，每段里随机挑一个时间，不会挤在一起。
 */
export function dailySlots(input: { key: string; date: string; min: number; max: number; awake: { from: string; to: string } }): number[] {
  const seed = `${input.key}:${input.date}`;
  const min = Math.max(0, Math.round(input.min) || 0);
  const max = Math.max(min, Math.round(input.max) || 0);
  const count = min + (hash32(`${seed}:count`) % (max - min + 1));
  if (!count) return [];
  let from = toMinutes(input.awake.from) ?? 8 * 60;
  let to = toMinutes(input.awake.to) ?? 23 * 60;
  // 睡得比起得早（凌晨才睡）：当天算到 23:59
  if (to <= from) to = 24 * 60 - 1;
  // 刚醒、快睡的半小时不发
  from = Math.min(from + 30, to);
  to = Math.max(to - 30, from + 1);
  const span = Math.max(1, Math.floor((to - from) / count));
  return Array.from({ length: count }, (_, i) => from + i * span + (hash32(`${seed}:${i}`) % span));
}

/** 这个角色这一天发朋友圈的时间：1 到"每天最多几条"之间，落在她醒着的时段里 */
export function momentSlots(input: { characterId: string; date: string; perDay: number; awake: { from: string; to: string } }): number[] {
  return dailySlots({ key: input.characterId, date: input.date, min: 1, max: socialPerDay(input), awake: input.awake });
}

/** 这一天每条朋友圈该发的时刻（毫秒） */
export function momentDueTimes(input: { characterId: string; date: string; perDay: number; awake: { from: string; to: string }; timezone: string }): number[] {
  return momentSlots(input).map((minute) => zonedInstant(input.date, minute, input.timezone));
}

/** 云端发的那条的 id：一个角色、一天、第几条，重试也不会变 */
export function hubMomentId(characterId: string, date: string, slot: number): string {
  return `moment:${characterId}:${date}:${slot}`;
}

// —— 读模型的输出 ——

/** 她发的一条朋友圈（社媒预设 post 任务的输出） */
export interface MomentDraft {
  text: string;
  /** 要配的图的画面（中文一句话）；不配图为 null */
  image: string | null;
  /** 一小页 HTML（缴费单、小票……）；没有为 null */
  html: string | null;
  htmlTitle: string;
  location: string;
}

/** 她对一条朋友圈的回应（社媒预设 react 任务的输出） */
export interface MomentReaction {
  like: boolean;
  /** 评论或回复；不说话为 null */
  comment: string | null;
}

export function parseMomentDraft(value: unknown): MomentDraft | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = str(v.text);
  const html = cleanHtml(v.html);
  const image = nullable(v.image);
  // 只发图、只发一张小票也行；什么都没有不算
  if (!text && !html && !image) return null;
  return { text: text.slice(0, 2000), image: image ? image.slice(0, 300) : null, html, htmlTitle: str(v.htmlTitle).slice(0, 30), location: (nullable(v.location) ?? '').slice(0, 40) };
}

export function parseMomentReaction(value: unknown): MomentReaction | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const comment = nullable(v.comment);
  return { like: v.like === true || v.like === 'true', comment: comment ? comment.slice(0, 500) : null };
}

// —— 写成文字 ——

/** 一条朋友圈里除了正文还有什么："配图：…"、"附：便利店小票"、"在 图书馆" */
export function momentExtras(m: Pick<Moment, 'images' | 'htmlTitle' | 'html' | 'location'>, t: TextFn, htmlFallbackKey = 'moment.htmlFallback'): string {
  const images = m.images.map((i) => (i.photo ? (i.seen ? t('moment.image.photoSeen', { seen: i.seen }) : t('moment.image.photo')) : i.caption ? t('moment.image.caption', { caption: i.caption }) : t('moment.image.plain')));
  const html = m.html ? t('moment.html', { title: m.htmlTitle || t(htmlFallbackKey) }) : '';
  const location = m.location ? t('moment.location', { location: m.location }) : '';
  return t('moment.extras', { items: [...images, html, location].filter(Boolean) });
}

/** 一条评论（程序文字 moment.comment）：谁、回复谁、说了什么 */
export function commentText(c: { authorId: string; replyTo?: string | null; text: string }, names: (id: string) => string, t: TextFn): string {
  return t('moment.comment', { author: names(c.authorId), replyTo: c.replyTo ? names(c.replyTo) : null, text: c.text });
}

/**
 * 一条朋友圈写成几行字（进提示词）：谁、什么时候、发了什么、谁点了赞、下面的评论。
 * names：id → 名字（MOMENT_USER 是你的名字）
 */
export function momentText(m: Moment, names: (id: string) => string, t: TextFn, opts: { timeZone?: string; comments?: number } = {}): string {
  const head = t('moment.head', { stamp: shortStamp(m.createdAt, opts.timeZone), author: names(m.authorId), text: m.text, extras: momentExtras(m, t) });
  const likes = m.likes.length ? t('moment.likes', { names: m.likes.map(names) }) : '';
  const comments = m.comments.slice(-(opts.comments ?? 8)).map((c) => commentText(c, names, t));
  return [head, likes, ...comments].filter(Boolean).join('\n');
}

/**
 * 一条朋友圈对这个角色来说要记住的一句话（写进记忆）：只带她自己和你的互动
 */
export function momentMemory(m: Moment, characterId: string, names: (id: string) => string, t: TextFn, timeZone?: string): string {
  const mine = m.authorId === characterId;
  const who = mine ? names(characterId) : names(MOMENT_USER);
  const other = mine ? MOMENT_USER : characterId;
  const talk = m.comments.filter((c) => c.authorId === characterId || c.authorId === MOMENT_USER).slice(-4);
  return t('moment.memory', {
    parts: [
      t('moment.memory.head', { day: shortDay(m.createdAt, timeZone), who, text: m.text.slice(0, 200), extras: momentExtras(m, t) }),
      m.likes.includes(other) ? t('moment.memory.liked', { name: names(other) }) : '',
      talk.length ? t('moment.memory.talk', { items: talk.map((c) => t('moment.memory.talkItem', { name: names(c.authorId), text: c.text.slice(0, 80) })) }) : '',
    ].filter(Boolean),
  });
}

/** 节律里的一天换成朋友圈用的样子：地点 id 换成名字，穿着取平时那一套 */
export function socialDayOf(day: RhythmDay, placeName: (locationId: string) => string): SocialDay {
  return {
    date: day.date,
    schedule: day.schedule.map((s) => ({ from: s.from, to: s.to, place: placeName(s.locationId), status: s.status, ...(s.fixed ? { fixed: true } : {}) })),
    meals: day.meals,
    outfit: outfitOfDay(day, null)?.name ?? '',
    task: day.task,
    events: day.events ?? [],
    ...(day.edited ? { edited: true } : {}),
  };
}

/** 节律里的一天写成几行字：作息（标出现在在做什么）、三餐、穿着、手头的事、小事 */
export function socialDayText(day: SocialDay, nowMinute: number | null, t: TextFn): string {
  const slots = day.schedule.map((s) => {
    const a = toMinutes(s.from) ?? 0;
    let b = toMinutes(s.to) ?? 0;
    if (b <= a) b += 24 * 60;
    const now = nowMinute !== null && ((nowMinute >= a && nowMinute < b) || (nowMinute + 24 * 60 >= a && nowMinute + 24 * 60 < b));
    return t('day.slot', { from: s.from, to: s.to, place: s.place, status: s.status, now });
  });
  const none = t('common.none');
  return t('day.block', {
    slots,
    breakfast: day.meals.breakfast || none,
    lunch: day.meals.lunch || none,
    dinner: day.meals.dinner || none,
    outfit: day.outfit,
    task: day.task,
    events: day.events,
  });
}
