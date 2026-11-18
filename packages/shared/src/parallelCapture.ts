import { WEEKDAY_LABEL } from './housework.ts';
import { str } from './modelText.ts';
import { clockOf, entryLabel, parallelEnvMinutes, parallelMinute } from './parallel.ts';
import { toHHMM, toMinutes } from './rhythm.ts';
import type { ISODate } from './types/common.ts';
import type { ParallelEntry, ParallelEnv } from './types/parallel.ts';

/**
 * 平行时空 · AI 记一件事（设计文档 §9.16）在手机和云端共用的部分：
 * - 你随口说一句（"明天下午找时间去趟超市，顺便取快递；周五前把报告交了"），模型整理成要做的事，排进这几天的安排；
 * - 给模型看的：这几天你那一边的安排（每项带编号 E1、E2…，写着能不能挪）、Google 日历里已有的（只看不挪）、你的作息；
 * - 模型写回来的：要新记的几件（哪天、几点、多久、清单）、要挪的几项（编号、挪到几点）、一句怎么排的；
 * - 写回来之后程序再查一遍冲突：撞上了、排到了已经过去的时间，就挪到离它最近的空档（5 分钟一格），挪不开的标出来。
 * 时间都是节律日（凌晨 4 点起）的分钟，和时间线一样。
 */

/** 最多往后排几天（含今天） */
export const CAPTURE_DAYS = 7;
/** 没写多久的事查冲突时算多久 */
const DEFAULT_SPAN = 30;
const STEP = 5;
const MAX_ITEMS = 8;
const MAX_MOVES = 8;

/** Google 日历里已有的一条（节律日的分钟；全天的 start 为 null，不算占用时间） */
export interface CaptureBusy {
  title: string;
  start: number | null;
  end: number | null;
}

/** 一天的安排：你那一边的、Google 日历里的 */
export interface CaptureDay {
  date: ISODate;
  entries: ParallelEntry[];
  calendar: CaptureBusy[];
}

/** 给模型看的一项：编号、哪天、能不能挪 */
export interface CaptureRef {
  ref: string;
  date: ISODate;
  entry: ParallelEntry;
  movable: boolean;
}

/** 现在：今天（节律日）和现在是节律日的第几分钟 */
export interface CaptureNow {
  today: ISODate;
  minute: number;
}

/**
 * 哪些能挪：你那一边、写了时间、没做完、不是定死的；今天的还没开始的（日程计划、家务、健康、整理好的、自己记的都能改时间），
 * 别的日子只挪自己记的（家务、日程计划那几天还会重排）
 */
function movable(e: ParallelEntry, date: ISODate, now: CaptureNow): boolean {
  if (e.side !== 'me' || e.fixed || e.done || e.start === null || e.kind === 'todo' || e.kind === 'slot') return false;
  if (date === now.today) return e.start > now.minute;
  return e.kind === 'item';
}

/** 这几天的安排编上号（E1、E2…，按天、按时间） */
export function captureRefs(days: CaptureDay[], now: CaptureNow): CaptureRef[] {
  const out: CaptureRef[] = [];
  for (const d of days) for (const e of d.entries) out.push({ ref: `E${out.length + 1}`, date: d.date, entry: e, movable: movable(e, d.date, now) });
  return out;
}

function dayName(date: ISODate, today: ISODate): string {
  const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const wd = WEEKDAY_LABEL[new Date(`${date}T12:00:00Z`).getUTCDay()];
  const rel = ['今天', '明天', '后天'][diff] ?? '';
  return [rel, date, wd].filter(Boolean).join(' ');
}

function spanText(start: number | null, end: number | null): string {
  if (start === null) return '全天';
  return end !== null && end > start ? `${clockOf(start)}–${clockOf(end)}` : clockOf(start);
}

/** 作息写成一行（排时间时避开睡觉、吃饭） */
export function captureEnvText(env: ParallelEnv): string {
  const e = parallelEnvMinutes(env);
  return `作息：起床 ${clockOf(e.wake)}，睡觉 ${clockOf(e.sleep)}；早饭 ${clockOf(e.breakfast)}，午饭 ${clockOf(e.lunchStart)}–${clockOf(e.lunchEnd)}，晚饭 ${clockOf(e.dinnerStart)}–${clockOf(e.dinnerEnd)}`;
}

/** 这几天的安排写成给模型看的几段：每天一段，每项带编号和能不能挪；Google 日历里的另起几行 */
export function captureScheduleText(days: CaptureDay[], refs: CaptureRef[], now: CaptureNow, env: ParallelEnv, userName: string): string {
  const parts = days.map((d) => {
    const mine = refs.filter((r) => r.date === d.date);
    const line = (r: CaptureRef) => {
      const e = r.entry;
      const tags = [e.source, e.done ? '做完了' : '', e.fixed ? '定死的' : '', r.movable ? '能挪' : e.start !== null ? '不挪' : ''].filter(Boolean).join('；');
      const list = e.checklist?.length ? `；清单：${e.checklist.map((c) => c.text).join('、')}` : '';
      return `- [${r.ref}] ${e.start === null ? '不定时' : spanText(e.start, e.end)} ${e.title}（${tags}${list}）`;
    };
    const cal = d.calendar.map((c) => `- ${spanText(c.start, c.end)} ${c.title}（Google 日历，不挪）`);
    const head = `${dayName(d.date, now.today)}${d.date === now.today ? `（现在 ${clockOf(now.minute)}，这之前的时间不能再排）` : ''}：`;
    const body = [...mine.map(line), ...cal];
    return `${head}\n${body.length ? body.join('\n') : '- 还没有安排'}`;
  });
  return [`${userName}这几天的安排（只列${userName}这一边；"能挪"的必要时可以挪，其余不动）：`, captureEnvText(env), ...parts].join('\n');
}

// —— 读模型写回来的 ——

export interface CaptureItemDraft {
  date: ISODate;
  /** "HH:mm"；不定时为空 */
  time: string;
  minutes: number;
  title: string;
  note: string;
  checklist: string[];
  /** 为什么排在这里（给你看） */
  why: string;
}

export interface CaptureMoveDraft {
  ref: string;
  time: string;
  why: string;
}

export interface CaptureDraft {
  items: CaptureItemDraft[];
  moves: CaptureMoveDraft[];
  /** 一句话：整理成了什么、怎么排的、哪些已经有了没再记 */
  summary: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function hhmm(v: unknown): string {
  const m = /(\d{1,2})[:：](\d{2})/.exec(str(v));
  const min = m ? toMinutes(`${m[1]}:${m[2]}`) : null;
  return min !== null ? toHHMM(min % 1440) : '';
}

/**
 * 读模型写回来的（parallel-capture）。dates 是能排的那几天（今天在最前）：写了别的日子的按 day（往后几天）找，都没有的算今天。
 * 不是对象时返回 null；什么都没记（说的都已经有了）时 items、moves 都是空的
 */
export function parseParallelCapture(v: unknown, dates: ISODate[]): CaptureDraft | null {
  if (!isObj(v)) return null;
  const pickDate = (it: Record<string, unknown>): ISODate => {
    const d = /\d{4}-\d{2}-\d{2}/.exec(str(it.date))?.[0];
    if (d && dates.includes(d)) return d;
    const n = Number(it.day);
    return (Number.isInteger(n) && dates[n]) || dates[0]!;
  };
  const items: CaptureItemDraft[] = [];
  for (const it of Array.isArray(v.items) ? v.items : []) {
    if (!isObj(it)) continue;
    const title = str(it.title).slice(0, 60);
    if (!title) continue;
    const checklist = (Array.isArray(it.checklist) ? it.checklist : []).map((c) => str(isObj(c) ? c.text : c).slice(0, 40)).filter(Boolean).slice(0, 12);
    items.push({
      date: pickDate(it),
      time: hhmm(it.time),
      minutes: Math.min(720, Math.max(0, Math.round(Number(it.minutes) || 0))),
      title,
      note: str(it.note).slice(0, 120),
      checklist,
      why: str(it.why).slice(0, 120),
    });
    if (items.length >= MAX_ITEMS) break;
  }
  const moves: CaptureMoveDraft[] = [];
  for (const m of Array.isArray(v.moves) ? v.moves : []) {
    if (!isObj(m)) continue;
    const ref = /E\s*(\d{1,3})/i.exec(str(m.ref));
    const time = hhmm(m.time);
    if (!ref || !time) continue;
    moves.push({ ref: `E${Number(ref[1])}`, time, why: str(m.why).slice(0, 120) });
    if (moves.length >= MAX_MOVES) break;
  }
  return { items, moves, summary: str(v.summary).slice(0, 300) };
}

// —— 查冲突、挪到空档 ——

export interface CaptureItemPlan extends CaptureItemDraft {
  /** 节律日的分钟；不定时为 null */
  start: number | null;
  /** 程序挪过（模型排的时间撞上了、已经过去了）：原来写的、为什么挪 */
  shifted?: string;
  /** 挪不开（那天排满了）：和什么撞了 */
  conflict?: string;
}

export interface CaptureMovePlan {
  ref: CaptureRef;
  /** 挪到几点（"HH:mm"） */
  time: string;
  start: number;
  why: string;
  shifted?: string;
  conflict?: string;
}

export interface CapturePlan {
  items: CaptureItemPlan[];
  moves: CaptureMovePlan[];
  summary: string;
  /** 用不上的挪动（编号不对、定死的、做完了的、已经过去的）：给你看为什么没挪 */
  dropped: string[];
}

interface Busy {
  start: number;
  end: number;
  title: string;
  /** 时间线上的哪一项（挪它时先把它自己拿掉） */
  key?: string;
}

const overlaps = (a: number, b: number, x: Busy) => a < x.end && x.start < b;
const ceilStep = (m: number) => Math.ceil(m / STEP) * STEP;

/**
 * 这一段放得下吗；放不下时找离想要的时间最近的空档（5 分钟一格，在 [lo, hi] 里；一样近的往后放）。
 * 返回放下的开始时间和撞上的那一项；哪里都放不下时返回 null
 */
function fit(want: number, span: number, busy: Busy[], lo: number, hi: number): { start: number; hit?: Busy } | null {
  const hitAt = (s: number) => busy.find((b) => overlaps(s, s + span, b));
  const hit = hitAt(want);
  if (want >= lo && !hit) return { start: want };
  let best: number | null = null;
  for (let s = ceilStep(lo); s + span <= hi; s += STEP) {
    if (hitAt(s)) continue;
    if (best === null || Math.abs(s - want) < Math.abs(best - want) || (Math.abs(s - want) === Math.abs(best - want) && s > best)) best = s;
  }
  return best === null ? null : { start: best, ...(hit ? { hit } : {}) };
}

/**
 * 模型排好的再查一遍：先挪要挪的，再一件件放新记的；每放下一件，它占的时间别的就不能再用。
 * 撞上已有的（时间线上的、Google 日历里的、前面刚放下的）或者排到了已经过去的时间，挪到最近的空档（今天从现在往后、别的日子从起床到睡觉）
 */
export function settleCapture(draft: CaptureDraft, days: CaptureDay[], refs: CaptureRef[], now: CaptureNow, env: ParallelEnv): CapturePlan {
  const e = parallelEnvMinutes(env);
  const busy = new Map<ISODate, Busy[]>();
  for (const d of days) {
    const list: Busy[] = [];
    for (const x of d.entries) if (x.start !== null) list.push({ start: x.start, end: x.end !== null && x.end > x.start ? x.end : x.start + DEFAULT_SPAN, title: x.title, key: x.key });
    for (const c of d.calendar) if (c.start !== null) list.push({ start: c.start, end: c.end !== null && c.end > c.start ? c.end : c.start + DEFAULT_SPAN, title: c.title });
    busy.set(d.date, list);
  }
  const window = (date: ISODate) => ({ lo: date === now.today ? ceilStep(now.minute + STEP) : e.wake, hi: e.sleep });
  const whyShift = (wrote: string, hit: Busy | undefined, to: number) => `原来排在 ${wrote}，${hit ? `和「${hit.title}」撞了` : '那时已经过去了'}，挪到 ${clockOf(to)}`;

  const moves: CaptureMovePlan[] = [];
  const dropped: string[] = [];
  const moved = new Set<string>();
  for (const m of draft.moves) {
    const r = refs.find((x) => x.ref === m.ref);
    if (!r) {
      dropped.push(`${m.ref}：没有这一项`);
      continue;
    }
    if (!r.movable || moved.has(r.ref)) {
      if (!moved.has(r.ref)) dropped.push(`${entryLabel(r.entry)}：${r.entry.fixed ? '定死的' : r.entry.done ? '做完了' : '不能挪'}，没挪`);
      continue;
    }
    const want = parallelMinute(m.time, env);
    const e0 = r.entry;
    if (want === null || e0.start === null || want === e0.start) continue;
    const span = e0.end !== null && e0.end > e0.start ? e0.end - e0.start : DEFAULT_SPAN;
    const list = (busy.get(r.date) ?? []).filter((b) => b.key !== e0.key);
    const { lo, hi } = window(r.date);
    const spot = fit(want, span, list, lo, Math.max(hi, want + span));
    if (!spot) {
      dropped.push(`${entryLabel(e0)}：挪到 ${m.time} 会撞上别的，那天也没有空档，没挪`);
      continue;
    }
    moved.add(r.ref);
    list.push({ start: spot.start, end: spot.start + span, title: e0.title, key: e0.key });
    busy.set(r.date, list);
    moves.push({ ref: r, time: clockOf(spot.start), start: spot.start, why: m.why, ...(spot.start !== want ? { shifted: whyShift(m.time, spot.hit, spot.start) } : {}) });
  }

  const items: CaptureItemPlan[] = draft.items.map((it) => {
    const want = it.time ? parallelMinute(it.time, env) : null;
    if (want === null) return { ...it, time: '', start: null };
    const span = it.minutes || DEFAULT_SPAN;
    const list = busy.get(it.date) ?? [];
    const { lo, hi } = window(it.date);
    const spot = fit(want, span, list, lo, Math.max(hi, want + span));
    if (!spot) {
      const hit = list.find((b) => overlaps(want, want + span, b));
      list.push({ start: want, end: want + span, title: it.title });
      busy.set(it.date, list);
      return { ...it, start: want, conflict: hit ? `和「${hit.title}」撞了，那天没有别的空档` : '那时已经过去了，今天也没有别的空档' };
    }
    list.push({ start: spot.start, end: spot.start + span, title: it.title });
    busy.set(it.date, list);
    return { ...it, time: clockOf(spot.start), start: spot.start, ...(spot.start !== want ? { shifted: whyShift(it.time, spot.hit, spot.start) } : {}) };
  });

  return { items, moves, summary: draft.summary, dropped };
}
