import type { TextFn } from './programText.ts';
import { CHORE_KINDS } from './housework.ts';
import { MEAL_LABEL } from './health.ts';
import { nullable, shortDay, shortStamp, str } from './modelText.ts';
import { checkSchedule, mealOfStatus, RHYTHM_DAY_START_HOUR, slotsFrom, toHHMM, toMinutes } from './rhythm.ts';
import { dailySlots } from './social.ts';
import { zonedInstant, zonedParts } from './timezone.ts';
import type { ChoreItem } from './housework.ts';
import type { HealthDayPlan } from './health.ts';
import type { ChoreWhen, FitTimeOfDay, MealKey } from './types/life.ts';
import {
  PARALLEL_PER_DAY_MAX,
  PARALLEL_USER,
  type ParallelCharacterSettings,
  type ParallelDay,
  type ParallelEntry,
  type ParallelEnv,
  type ParallelNote,
  type ParallelOverride,
  type ParallelPlan,
  type ParallelPlanItem,
  type ParallelRef,
  type ParallelSide,
} from './types/parallel.ts';
import type { PlannerDayPlan } from './types/planner.ts';
import type { RhythmMeals, RhythmSlot, RhythmTemplate } from './types/rhythm.ts';

/**
 * 平行时空在手机和云端共用的部分（设计文档 §9.16）：
 * - 时间线：她的作息、你的安排（日程计划、家务、健康计划、自己记的）排成同一种样子，按节律日（凌晨 4 点起）的分钟排；
 * - 写进提示词：两边各自编号（她的 C1、C2…，你的 U1、U2…），模型留言时写"说的是哪一项"就写编号；
 * - 你请她改日程：读模型写的几段，插进她今天的作息，再按节律的规矩检查（固定的事不挪、盖满一整天）；
 * - 她每天什么时候留言：按角色和日期算出来的随机时间，手机和云端算的一样。
 */

const DAY = 1440;
const START = RHYTHM_DAY_START_HOUR * 60;

/** 一天里的第几分钟 → 节律日的分钟（凌晨 4 点前的算前一天的深夜，加 1440） */
export function dayMinute(min: number): number {
  const m = ((Math.round(min) % DAY) + DAY) % DAY;
  return m < START ? m + DAY : m;
}

/** 节律日的分钟 → "07:30" */
export function clockOf(min: number): string {
  return toHHMM(((Math.round(min) % DAY) + DAY) % DAY);
}

/** 现在是节律日的第几分钟（按你的时区） */
export function nowDayMinute(at: number, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  return dayMinute(p.hour * 60 + p.minute);
}

/** "环境与作息"里的几个时间点（节律日的分钟） */
export function parallelEnvMinutes(env: ParallelEnv) {
  const m = (t: string, fallback: number) => dayMinute(toMinutes(t) ?? fallback);
  const wake = m(env.wakeTime, 7 * 60);
  const lunchStart = m(env.meals.lunch.start, wake + 300);
  const dinnerStart = m(env.meals.dinner.start, lunchStart + 360);
  return {
    wake,
    sleep: Math.max(m(env.sleepTime, 23 * 60), wake + 60),
    breakfast: m(env.meals.breakfast.start, wake),
    lunchStart,
    lunchEnd: m(env.meals.lunch.end, lunchStart + 60),
    dinnerStart,
    dinnerEnd: m(env.meals.dinner.end, dinnerStart + 60),
  };
}

/**
 * 不写几点、只写"上午""晚上"的大概时间：按你的作息换成节律日的分钟（排顺序用）；认不出为 null。
 * 早上是起床时间，中午、傍晚、晚上跟着三餐，睡前是睡觉时间
 */
export function fuzzyMinute(text: string, env: ParallelEnv): number | null {
  const e = parallelEnvMinutes(env);
  const rules: [RegExp, number][] = [
    [/睡前|临睡|深夜|半夜/, e.sleep],
    [/早饭|早餐/, e.breakfast],
    [/午饭|午餐/, e.lunchStart],
    [/晚饭|晚餐/, e.dinnerStart],
    [/早上|早晨|清晨|起床/, e.wake],
    [/上午/, Math.round((e.wake + e.lunchStart) / 2)],
    [/中午/, e.lunchStart],
    [/下午/, Math.round((e.lunchEnd + e.dinnerStart) / 2)],
    [/傍晚/, e.dinnerStart],
    [/晚上|晚间|夜里|今晚/, e.dinnerEnd],
  ];
  return rules.find(([re]) => re.test(text))?.[1] ?? null;
}

/** "09:30"、"9:30-10:30"、"上午" → 节律日的分钟；认不出（"随时"）为 null */
export function parallelMinute(time: string, env: ParallelEnv): number | null {
  const m = /(\d{1,2})[:：](\d{2})/.exec(time);
  const exact = m ? toMinutes(`${m[1]}:${m[2]}`) : null;
  if (exact !== null) return dayMinute(exact);
  return time.trim() ? fuzzyMinute(time, env) : null;
}

/** 家务的"早上 / 中午 / 晚上 / 睡前"在时间线上放在哪（随时的不定时） */
function choreMinute(slot: ChoreWhen, env: ParallelEnv): number | null {
  const e = parallelEnvMinutes(env);
  return { morning: e.wake, noon: e.lunchStart, evening: e.dinnerEnd, bedtime: e.sleep, any: null }[slot];
}

/** 健身"一般什么时候练"在时间线上放在哪 */
function fitMinute(t: FitTimeOfDay | null, env: ParallelEnv): number | null {
  if (!t) return null;
  const e = parallelEnvMinutes(env);
  return { morning: e.wake, noon: e.lunchStart, evening: e.dinnerEnd, any: null }[t];
}

function mealMinute(k: MealKey | 'snack', env: ParallelEnv): number | null {
  const e = parallelEnvMinutes(env);
  return { breakfast: e.breakfast, lunch: e.lunchStart, dinner: e.dinnerStart, snack: null }[k];
}

/** 两个名字是不是说的同一件事（一个包含另一个；去掉空白和标点） */
function sameThing(a: string, b: string): boolean {
  const clean = (s: string) => s.replace(/[\s·，,。.、:：()（）]/g, '');
  const x = clean(a);
  const y = clean(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
}

// —— 你的一天 ——

export interface MyDayInput {
  /** 日程计划今天排的（日程系统没开、还没排时为空） */
  plan: PlannerDayPlan | null;
  /** 日程计划时间线里勾掉的（下标） */
  planDone: ReadonlySet<number>;
  /** "共同的家"今天的家务（没开家务系统时为空） */
  chores: ChoreItem[];
  /** 健康计划今天排的 */
  health: HealthDayPlan | null;
  /** 今天有没有运动记录（练过了的健身算做完） */
  workedOut: boolean;
  /** 健身一般什么时候练（健康设置里的） */
  fitTime: FitTimeOfDay | null;
  /** 你在平行时空里自己记的、改过的 */
  day: ParallelDay | null;
  env: ParallelEnv;
  /** 今天整理好的那一份计划（每天到点用"平行时空 · 整理你的一天"排的）；还没有时按几份计划直接拼 */
  arranged?: ParallelPlan | null;
}

/** 按改过的地方改一项（拿掉了的返回 null） */
function applyOverride(e: ParallelEntry, o: ParallelOverride | undefined, env: ParallelEnv): ParallelEntry | null {
  if (!o) return e;
  if (o.hidden) return null;
  const next: ParallelEntry = { ...e };
  if (o.time !== undefined) {
    const start = o.time ? parallelMinute(o.time, env) : null;
    next.end = start !== null && e.start !== null && e.end !== null ? start + (e.end - e.start) : null;
    next.start = start;
    next.time = start !== null ? clockOf(start) : '';
    next.edited = true;
  }
  if (o.title?.trim()) {
    next.title = o.title.trim();
    next.edited = true;
  }
  if (o.note?.trim()) next.sub = [e.sub, o.note.trim()].filter(Boolean).join(' · ');
  if (o.done !== undefined && (e.kind === 'workout' || e.kind === 'meal')) next.done = !!e.done || o.done;
  if (o.done !== undefined && e.kind === 'merged') next.done = o.done;
  if (next.checklist) {
    const checked = new Set(o.checks ?? []);
    next.checklist = next.checklist.map((c) => ({ ...c, done: checked.has(c.key) }));
  }
  return next;
}

/** 显示的时间：写了几点的按几点；只写了"上午"这类的照写 */
function timeAt(start: number | null, written = ''): string {
  return start === null ? written : /\d[:：]\d/.test(written) || !written ? clockOf(start) : written;
}

/** 待办的 key：按标题（重新排了顺序也对得上） */
export const TODO_KEY = 'plan:todos';
const todoKey = (title: string) => `todo:${title}`;

/** 几份计划各自的那几项（还没合并、没按你改过的改） */
function sourceParts(input: Omit<MyDayInput, 'day' | 'arranged'>, ov: Record<string, ParallelOverride>) {
  const { env } = input;
  const chores: (ParallelEntry & { name: string })[] = input.chores.map((it) => {
    const start = choreMinute(it.slot, env);
    const done = it.mark.status === 'done';
    return {
      name: it.chore.name,
      key: `chore:${it.key}`,
      side: 'me',
      kind: 'chore',
      start,
      end: start !== null && it.chore.minutes ? start + it.chore.minutes : null,
      time: timeAt(start),
      title: it.label,
      sub: [it.label.includes(it.when) ? '' : it.when, it.mark.status === 'later' && it.mark.later ? `拖了 ${it.mark.later} 次` : ''].filter(Boolean).join(' · '),
      source: '家务',
      done,
      ...(it.overdue && !done ? { overdue: true } : {}),
      choreKey: it.key,
      icon: CHORE_KINDS[it.chore.kind]?.icon,
    };
  });

  const h = input.health;
  let workout: ParallelEntry | null = null;
  if (h?.workout && !h.rest) {
    const w = h.workout;
    const start = fitMinute(input.fitTime, env);
    const names = [...new Set([...w.warmup, ...w.items, ...w.cooldown].map((m) => m.name.trim()).filter(Boolean))];
    workout = {
      key: 'health:workout',
      side: 'me',
      kind: 'workout',
      start,
      end: start !== null && w.minutes ? start + w.minutes : null,
      time: timeAt(start),
      title: w.title || '健身',
      sub: [w.minutes ? `${w.minutes} 分钟` : '', w.intensity].filter(Boolean).join(' · '),
      source: '健康计划',
      done: input.workedOut || !!ov['health:workout']?.done,
      checklist: names.map((n) => ({ key: n, text: n, done: false })),
    };
  }
  const meals: ParallelEntry[] = [];
  for (const k of ['breakfast', 'lunch', 'dinner', 'snack'] as const) {
    const m = h?.meals[k];
    if (!m) continue;
    const start = mealMinute(k, env);
    const how = m.cook && m.minutes ? `自己做，约 ${m.minutes} 分钟` : m.bento ? '带提前做好的' : m.place ? `去${m.place}` : '';
    const key = `health:meal:${k}`;
    meals.push({ key, side: 'me', kind: 'meal', start, end: null, time: timeAt(start), title: `${MEAL_LABEL[k]}：${m.name}`, sub: how, source: '健康计划', done: !!ov[key]?.done });
  }

  const plan = input.plan;
  const plans: ParallelEntry[] = (plan?.items ?? []).map((it, i) => {
    const start = parallelMinute(it.time, env);
    return {
      key: `plan:${plan!.at}:${i}`,
      side: 'me',
      kind: 'plan',
      start,
      end: start !== null && it.minutes ? start + it.minutes : null,
      time: timeAt(start, it.time),
      title: it.title,
      sub: [it.minutes ? `${it.minutes} 分钟` : '', it.note].filter(Boolean).join(' · '),
      source: ['日程系统', it.source].filter(Boolean).join(' · '),
      done: input.planDone.has(i),
      ...(it.fixed ? { fixed: true } : {}),
      planIndex: i,
    };
  });
  const checked = new Set(ov[TODO_KEY]?.checks ?? []);
  const todos = (plan?.todos ?? []).map((t) => ({ key: t.title, text: `${t.title}${t.due ? `（${t.due} 前）` : ''}`, done: checked.has(t.title) }));
  return { chores, workout, meals, plans, todos };
}

/**
 * 这一天几份计划里的事，一项一项的（日程计划的时间线和待办、家务、健康计划的健身和三顿饭；还没合并）：
 * 整理你的一天时给模型看的就是这些（编号 S1、S2…），整理好的计划里每一项写着是从这里的哪几项来的
 */
export function parallelSources(input: Omit<MyDayInput, 'day' | 'arranged'>, overrides: Record<string, ParallelOverride> = {}): ParallelEntry[] {
  const { chores, workout, meals, plans, todos } = sourceParts(input, overrides);
  const todoEntries: ParallelEntry[] = todos.map((t) => ({ key: todoKey(t.key), side: 'me', kind: 'todo', start: null, end: null, time: '', title: t.text, sub: '', source: '日程系统 · 待办', done: t.done }));
  return [...plans, ...todoEntries, ...chores.map(({ name: _name, ...e }) => e), ...(workout ? [workout] : []), ...meals];
}

/** 几份计划的样子（整理好之后来源变了——重排了、改了时间和名字——能看出来）；做没做不算 */
export function parallelSourcesBasis(sources: ParallelEntry[]): string {
  const text = sources.map((e) => `${e.key}|${e.time}|${e.title}`).sort().join('\n');
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return `${sources.length}:${(h >>> 0).toString(36)}`;
}

/** 几份计划里的事写成几行给模型看（每项带编号 S1、S2…，写着从哪份来、几点、补充） */
export function parallelSourcesText(sources: ParallelEntry[], userName: string, t: TextFn): string {
  if (!sources.length) return t('parallel.sources.empty', { user: userName });
  const items = sources.map((e, i) => t('parallel.sources.item', { ref: `S${i + 1}`, time: e.time || t('capture.untimed'), title: e.title, tags: [e.source, e.sub, e.fixed ? t('parallel.sources.fixed') : ''].filter(Boolean) }));
  return t('parallel.sources', { user: userName, items });
}

/**
 * 读模型整理好的计划（parallel-plan）：每一项的 from 写的编号换成来源的 key；编不出来的编号、重复用到的编号去掉；
 * 哪一项都没用到的来源原样补在后面（什么都不丢）。一项都读不出来时返回 null
 */
export function parseParallelPlan(v: unknown, sources: ParallelEntry[], idPrefix: string): ParallelPlanItem[] | null {
  const raw = isObj(v) && Array.isArray(v.items) ? v.items : Array.isArray(v) ? v : null;
  if (!raw) return null;
  const used = new Set<string>();
  const items: ParallelPlanItem[] = [];
  for (const it of raw) {
    if (!isObj(it)) continue;
    const refs = Array.isArray(it.from) ? it.from : typeof it.from === 'string' ? it.from.split(/[,，、\s]+/) : [];
    const from = refs.flatMap((r) => {
      const m = /S\s*(\d{1,3})/i.exec(String(r));
      const e = m ? sources[Number(m[1]) - 1] : undefined;
      if (!e || used.has(e.key)) return [];
      used.add(e.key);
      return [e.key];
    });
    const title = str(it.title) || (from[0] ? sources.find((e) => e.key === from[0])?.title ?? '' : '');
    if (!title) continue;
    const t = /(\d{1,2})[:：](\d{2})/.exec(str(it.time));
    const time = t && toMinutes(`${t[1]}:${t[2]}`) !== null ? toHHMM(toMinutes(`${t[1]}:${t[2]}`)!) : '';
    const minutes = Math.max(0, Math.round(Number(it.minutes) || 0));
    items.push({ id: `${idPrefix}-${items.length}`, time, minutes, title: title.slice(0, 80), note: str(it.note).slice(0, 200), from });
  }
  if (!items.length && sources.length) return null;
  for (const e of sources) {
    if (used.has(e.key)) continue;
    items.push({ id: `${idPrefix}-${items.length}`, time: e.start !== null ? clockOf(e.start) : '', minutes: e.start !== null && e.end !== null ? e.end - e.start : 0, title: e.title, note: e.sub, from: [e.key] });
  }
  return items;
}

/** 整理好的计划里的一项在时间线上的样子：合成的几项说的是同一件事，哪一项做完了就算做完（你在这里勾过的以勾的为准） */
function arrangedEntry(it: ParallelPlanItem, parts: ParallelEntry[], env: ParallelEnv): ParallelEntry {
  const start = it.time ? parallelMinute(it.time, env) : null;
  const first = parts[0];
  return {
    key: `merged:${it.id}`,
    side: 'me',
    kind: 'merged',
    start,
    end: start !== null && it.minutes ? start + it.minutes : null,
    time: start !== null ? clockOf(start) : '',
    title: it.title,
    sub: [it.minutes ? `${it.minutes} 分钟` : '', it.note].filter(Boolean).join(' · '),
    source: ['平行时空整理的', ...new Set(parts.map((p) => p.source))].join(' · '),
    done: parts.some((p) => p.done),
    ...(parts.some((p) => p.fixed) ? { fixed: true } : {}),
    ...(parts.some((p) => p.overdue) && !parts.some((p) => p.done) ? { overdue: true } : {}),
    parts: parts.map((p) => p.key),
    ...(first ? { via: first.kind } : {}),
    ...(first?.icon ? { icon: first.icon } : {}),
  };
}

/**
 * 你今天的安排：
 * - 整理好了（arranged）：就是那一份计划，每一项勾掉时把它合成的那几项一起勾；整理之后几份计划里新出来的事接在后面；
 * - 还没整理：日程计划的时间线、家务、健康计划（健身、三顿饭）、待办直接拼（对得上名字的家务、健康不重复显示，用计划里的时间）。
 * 你自己记的一直在。不定时的排在前面，其余按时间排
 */
export function myDayEntries(input: MyDayInput): ParallelEntry[] {
  const { env } = input;
  const ov = input.day?.overrides ?? {};
  const own: ParallelEntry[] = (input.day?.items ?? []).map((it) => {
    const start = it.time ? parallelMinute(it.time, env) : null;
    return {
      key: `item:${it.id}`,
      side: 'me',
      kind: 'item',
      start,
      end: start !== null && it.minutes ? start + it.minutes : null,
      time: timeAt(start, it.time),
      title: it.title,
      sub: [it.minutes ? `${it.minutes} 分钟` : '', it.note].filter(Boolean).join(' · '),
      source: '自己记的',
      done: it.done,
      ...(it.checklist.length ? { checklist: it.checklist.map((c) => ({ key: c.id, text: c.text, done: c.done })) } : {}),
    };
  });
  const sorted = (all: ParallelEntry[]) => {
    const untimed = all.filter((e) => e.start === null);
    const timed = all.filter((e) => e.start !== null).sort((a, b) => (a.start as number) - (b.start as number));
    return [...untimed, ...timed];
  };

  if (input.arranged) {
    const sources = parallelSources(input, ov);
    const byKey = new Map(sources.map((e) => [e.key, e]));
    const covered = new Set(input.arranged.items.flatMap((it) => it.from));
    const arranged = input.arranged.items
      .map((it) => arrangedEntry(it, it.from.flatMap((k) => byKey.get(k) ?? []), env))
      .map((e) => applyOverride(e, ov[e.key], env))
      .filter((e): e is ParallelEntry => !!e);
    // 整理之后几份计划里新出来的（重排了、后来才排的健康计划）：原样接在后面，按你改过的改
    const later = sources.filter((e) => !covered.has(e.key)).map((e) => applyOverride(e, ov[e.key], env)).filter((e): e is ParallelEntry => !!e);
    return sorted([...arranged, ...later, ...own]);
  }

  const { chores, workout, meals, plans: planList, todos: todoChecks } = sourceParts(input, {});
  const plans: ParallelEntry[] = [];
  const plan = input.plan;
  const adopt = (e: ParallelEntry, i: number, start: number | null, written: string) => {
    e.planIndex = i;
    if (start === null) return;
    const span = e.start !== null && e.end !== null ? e.end - e.start : null;
    e.start = start;
    e.end = span !== null ? start + span : null;
    e.time = timeAt(start, written);
  };
  if (plan) {
    plan.items.forEach((it, i) => {
      const start = parallelMinute(it.time, env);
      if (/家务/.test(it.source) && chores.length) {
        const c = chores.find((x) => x.planIndex === undefined && sameThing(x.name, it.title));
        if (c) return adopt(c, i, start, it.time);
      }
      if (/健康|健身|运动|饮食/.test(it.source) && (workout || meals.length)) {
        const meal = meals.find((x) => x.planIndex === undefined && (sameThing(x.title.split('：')[0] ?? '', it.title) || sameThing(x.title.split('：')[1] ?? '', it.title)));
        if (meal) return adopt(meal, i, start, it.time);
        if (workout && workout.planIndex === undefined) return adopt(workout, i, start, it.time);
        return;
      }
      plans.push(planList[i]!);
    });
  }
  const todos: ParallelEntry[] = todoChecks.length
    ? [{ key: TODO_KEY, side: 'me', kind: 'todo', start: null, end: null, time: '', title: '待办', sub: '', source: '日程系统', checklist: todoChecks.map((t) => ({ ...t, done: false })) }]
    : [];
  const derived = [...chores.map(({ name: _name, ...e }) => e), ...(workout ? [{ ...workout, done: input.workedOut }] : []), ...meals.map((m) => ({ ...m, done: false })), ...todos]
    .map((e) => applyOverride(e, ov[e.key], env))
    .filter((e): e is ParallelEntry => !!e)
    .map((e) => (e.kind === 'todo' && e.checklist ? { ...e, done: e.checklist.every((c) => c.done) } : e));
  return sorted([...plans, ...derived, ...own]);
}

// —— 她的一天 ——

/** 她作息里的一段（地点已经换成名字；手机上还带着地点 id） */
export interface HerSlot {
  from: string;
  to: string;
  place: string;
  status: string;
  fixed?: boolean;
  placeId?: string;
  icon?: string;
}

/**
 * 她今天的作息排成时间线：从凌晨 4 点排到第二天凌晨 4 点（过了半夜的那段接在最后），
 * 跨过 4 点的那段切开，接起来一样的两段合成一段；吃饭的那段写上吃什么
 */
export function herEntries(input: { schedule: HerSlot[]; meals?: RhythmMeals | null; nowMin: number | null }): ParallelEntry[] {
  type Span = HerSlot & { a: number; b: number };
  const spans: Span[] = [];
  for (const s of input.schedule) {
    const a0 = toMinutes(s.from);
    const raw = toMinutes(s.to);
    if (a0 === null || raw === null) continue;
    const b0 = raw <= a0 ? raw + DAY : raw;
    if (a0 < START) spans.push({ ...s, a: a0 + DAY, b: Math.min(b0, START) + DAY });
    const lo = Math.max(a0, START);
    const hi = Math.min(b0, DAY + START);
    if (hi > lo) spans.push({ ...s, a: lo, b: hi });
  }
  spans.sort((x, y) => x.a - y.a);
  const merged: Span[] = [];
  for (const s of spans) {
    const prev = merged.at(-1);
    if (prev && prev.b === s.a && prev.place === s.place && prev.status === s.status && !!prev.fixed === !!s.fixed) prev.b = s.b;
    else if (s.b > s.a) merged.push({ ...s });
  }
  return merged.map((s) => {
    const meal = mealOfStatus(s.status, clockOf(s.a));
    const food = meal && meal !== 'snack' ? input.meals?.[meal] : '';
    return {
      key: `slot:${clockOf(s.a)}`,
      side: 'her' as const,
      kind: 'slot' as const,
      start: s.a,
      end: s.b,
      time: `${clockOf(s.a)}–${clockOf(s.b)}`,
      title: s.status,
      sub: [s.place, food].filter(Boolean).join(' · '),
      source: '节律',
      ...(s.fixed ? { fixed: true } : {}),
      ...(input.nowMin !== null && s.a <= input.nowMin && input.nowMin < s.b ? { now: true } : {}),
      place: s.place,
      ...(s.placeId ? { placeId: s.placeId } : {}),
      ...(s.icon ? { icon: s.icon } : {}),
    };
  });
}

// —— 编号和写成文字 ——

/** 写进提示词的编号：她的 C1、C2…，你的 U1、U2… */
export function entryRef(side: ParallelSide, index: number): string {
  return `${side === 'her' ? 'C' : 'U'}${index + 1}`;
}

/** 给人看的一项："09:30 组会" */
export function entryLabel(e: Pick<ParallelEntry, 'time' | 'title'>): string {
  return [e.time, e.title].filter(Boolean).join(' ').slice(0, 80);
}

/** 模型写的编号（"C3""[U5]"）→ 是哪一项；认不出为 undefined */
export function resolveParallelRef(ref: string | null | undefined, her: ParallelEntry[], mine: ParallelEntry[]): ParallelRef | undefined {
  const m = /\b([CU])\s*(\d{1,3})\b/i.exec(ref ?? '');
  if (!m) return undefined;
  const e = (m[1]!.toUpperCase() === 'C' ? her : mine)[Number(m[2]) - 1];
  return e ? { side: e.side, key: e.key, label: entryLabel(e) } : undefined;
}

/** 她今天的节律写成几行（每段带编号）；ids：写上地点 id（改日程时她要写去哪） */
export function parallelHerText(
  entries: ParallelEntry[],
  t: TextFn,
  extras: { meals?: RhythmMeals | null; outfit?: string; task?: string; events?: string[] } = {},
  opts: { ids?: boolean } = {},
): string {
  const slots = entries.map((e, i) =>
    t('parallel.her.slot', { ref: entryRef('her', i), time: e.time, title: e.title, place: e.place, placeId: opts.ids ? e.placeId : null, fixed: !!e.fixed, now: !!e.now }),
  );
  const m = extras.meals;
  const none = t('common.none');
  return t('parallel.her', {
    slots,
    meals: !!m,
    breakfast: m?.breakfast || none,
    lunch: m?.lunch || none,
    dinner: m?.dinner || none,
    outfit: extras.outfit,
    task: extras.task,
    events: extras.events,
  });
}

/** 你今天的安排写成几行（每项带编号、从哪来、做没做） */
/** 清单（程序文字 parallel.checklist / parallel.checkItem） */
export function checklistText(list: { text: string; done: boolean }[] | undefined, t: TextFn): string {
  return list?.length ? t('parallel.checklist', { items: list.map((c) => t('parallel.checkItem', { text: c.text, done: c.done })) }) : '';
}

export function parallelMineText(entries: ParallelEntry[], userName: string, t: TextFn): string {
  if (!entries.length) return t('parallel.mine.empty', { user: userName });
  const line = (e: ParallelEntry, i: number) => {
    const from = [e.source, e.sub, e.fixed ? t('parallel.mine.fixed') : '', e.edited ? t('parallel.mine.edited', { user: userName }) : ''].filter(Boolean);
    return t('parallel.mine.item', { ref: entryRef('me', i), label: entryLabel(e), from, checklist: checklistText(e.checklist, t), done: !!e.done, overdue: !e.done && !!e.overdue });
  };
  const untimed = entries.filter((e) => e.start === null).length;
  const rows = entries.map(line);
  return t('parallel.mine', { untimed: rows.slice(0, untimed), timeline: rows.slice(untimed) });
}

/** 一条留言写成几行（进提示词）：谁留的、说的是哪一项、请她改日程的结果、下面的回复 */
export function parallelNoteText(n: ParallelNote, names: (id: string) => string, t: TextFn, timeZone?: string, opts: { replies?: number } = {}): string {
  const vars = {
    stamp: shortStamp(n.at, timeZone),
    author: names(n.authorId),
    her: names(n.characterId),
    text: n.text,
    about: n.about?.label,
    accepted: n.request?.status === 'accepted',
    declined: !!n.request && n.request.status !== 'accepted',
    changes: n.request?.changes ?? [],
  };
  const head = t(n.kind === 'request' ? 'parallel.note.request' : 'parallel.note.post', vars);
  const replies = n.replies.slice(-(opts.replies ?? 8)).map((r) => t('parallel.note.reply', { author: names(r.authorId), text: r.text }));
  return [head, ...replies].join('\n');
}

/** 一条留言对她来说要记住的一句话（写进记忆） */
export function parallelNoteMemory(n: ParallelNote, names: (id: string) => string, t: TextFn, timeZone?: string): string {
  return t(n.kind === 'request' ? 'parallel.memory.request' : 'parallel.memory.post', {
    day: shortDay(n.at, timeZone),
    who: names(n.authorId),
    her: names(n.characterId),
    text: n.text.slice(0, 120),
    accepted: n.request?.status === 'accepted',
    declined: !!n.request && n.request.status !== 'accepted',
    changes: n.request?.changes.join('；').slice(0, 120),
    talk: n.replies.slice(-4).map((r) => t('moment.memory.talkItem', { name: names(r.authorId), text: r.text.slice(0, 80) })),
  });
}

// —— 读模型的输出 ——

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** 她给你留言（parallel-post）：说的话，说的是哪一项（编号，可以没有） */
export interface ParallelPostDraft {
  text: string;
  about: string | null;
}

export function parseParallelPost(v: unknown): ParallelPostDraft | null {
  if (!isObj(v)) return null;
  const text = str(v.text);
  if (!text) return null;
  const about = typeof v.about === 'number' ? String(v.about) : nullable(v.about);
  return { text: text.slice(0, 800), about };
}

/** 她回你的留言（parallel-reply） */
export function parseParallelReply(v: unknown): { text: string } | null {
  if (!isObj(v)) return null;
  const text = str(v.text ?? v.reply);
  return text ? { text: text.slice(0, 800) } : null;
}

/** 你请她改日程（parallel-request）：答不答应、她说的话、答应了改成的那几段 */
export interface ParallelRequestDraft {
  accept: boolean;
  text: string;
  schedule: RhythmSlot[];
}

export function parseParallelRequest(v: unknown): ParallelRequestDraft | null {
  if (!isObj(v)) return null;
  const text = str(v.text ?? v.reply);
  if (!text) return null;
  const accept = v.accept === true || v.accept === 'true';
  return { accept, text: text.slice(0, 800), schedule: accept ? slotsFrom(v.schedule).slice(0, 12) : [] };
}

// —— 你请她改日程 ——

export interface ScheduleChange {
  schedule: RhythmSlot[];
  /** 改了哪几段（给人看） */
  changes: string[];
  /** 检查时改回去、补上的 */
  fixes: string[];
}

/**
 * 把她答应改的那几段插进今天的作息：和它重叠的部分让出来，再按节律的规矩检查（固定的事放回原处、盖满一整天）。
 * 写到半夜以后的算到 24:00；地点认不出就用原来这个时间的地点。一段都用不上时返回 null
 */
export function applyScheduleChange(
  schedule: RhythmSlot[],
  wanted: RhythmSlot[],
  ctx: { template: RhythmTemplate; resolve(ref: string): string | null; placeName(id: string): string },
): ScheduleChange | null {
  type S = { from: number; to: number; locationId: string; status: string; fixed?: boolean };
  const cur: S[] = schedule.flatMap((s) => {
    const a = toMinutes(s.from);
    const b = toMinutes(s.to);
    return a === null || b === null || b <= a ? [] : [{ from: a, to: b, locationId: s.locationId, status: s.status, ...(s.fixed ? { fixed: true } : {}) }];
  });
  const at = (m: number) => cur.find((s) => s.from <= m && m < s.to);
  const add: S[] = [];
  for (const w of wanted) {
    const a = toMinutes(w.from);
    let b = toMinutes(w.to);
    if (a === null || b === null) continue;
    if (b <= a) b = DAY;
    if (b <= a) continue;
    const loc = ctx.resolve(w.locationId) ?? at(a)?.locationId;
    if (!loc) continue;
    add.push({ from: a, to: b, locationId: loc, status: w.status.trim() || at(a)?.status || '自己的事' });
  }
  if (!add.length) return null;
  let next = cur;
  for (const n of add) {
    const cut: S[] = [];
    for (const s of next) {
      if (s.to <= n.from || s.from >= n.to) cut.push(s);
      else {
        if (s.from < n.from) cut.push({ ...s, to: n.from });
        if (s.to > n.to) cut.push({ ...s, from: n.to });
      }
    }
    cut.push(n);
    next = cut.sort((x, y) => x.from - y.from);
  }
  const checked = checkSchedule(
    next.map((s) => ({ from: toHHMM(s.from), to: toHHMM(s.to), locationId: s.locationId, status: s.status, ...(s.fixed ? { fixed: true } : {}) })),
    { template: ctx.template, resolve: ctx.resolve },
  );
  const changes = add.map((n) => {
    const before = [...new Set(cur.filter((s) => s.from < n.to && s.to > n.from).map((s) => `${s.status} · ${ctx.placeName(s.locationId)}`))];
    return `${toHHMM(n.from)}–${toHHMM(n.to)} ${before.join('、') || '—'} → ${n.status} · ${ctx.placeName(n.locationId)}`;
  });
  return { schedule: checked.schedule, changes, fixes: checked.fixes };
}

// —— 她什么时候留言 ——

/** 每天最多几条：1 到 PARALLEL_PER_DAY_MAX */
export function parallelPerDay(settings: Pick<ParallelCharacterSettings, 'perDay'>): number {
  return Math.min(PARALLEL_PER_DAY_MAX, Math.max(1, Math.round(settings.perDay) || 1));
}

/** 这个角色这一天留言的时刻（毫秒）：1 到"每天最多几条"之间，落在她醒着的时段里，手机和云端算的一样 */
export function parallelDueTimes(input: { characterId: string; date: string; perDay: number; awake: { from: string; to: string }; timezone: string }): number[] {
  return dailySlots({ key: `parallel:${input.characterId}`, date: input.date, min: 1, max: parallelPerDay(input), awake: input.awake })
    .map((minute) => zonedInstant(input.date, minute, input.timezone));
}

/** 按时间留的那条的 id：一个角色、一天、第几条，重试也不会变（手机和云端不会各留一条） */
export function hubParallelNoteId(characterId: string, date: string, slot: number): string {
  return `pnote:${characterId}:${date}:${slot}`;
}

/** 名字表：PARALLEL_USER 是你 */
export function parallelNames(userName: string, characterName: (id: string) => string): (id: string) => string {
  return (id) => (id === PARALLEL_USER ? userName : characterName(id));
}
