import { errorText, isAbortError, parallelCaptureMessages, samplerRequest } from '@app/ai';
import {
  AGENT_META,
  CAPTURE_DAYS,
  captureRefs,
  clockOf,
  isParallelCapturePreset,
  nowDayMinute,
  parseParallelCapture,
  settleCapture,
  shiftDate,
  type CaptureDay,
  type CaptureNow,
  type CapturePlan,
  type ISODate,
  type Persona,
  type Preset,
} from '@app/shared';
import { calendarBusy, calendarState, linkToCalendar, syncItemCalendar } from './calendarSync';
import { editEntry, myEntriesOn, parallelToday } from './parallel';
import { MissingPresetError } from './prompt';
import { useAiStore } from '@/stores/ai';
import { useEnvironmentStore } from '@/stores/environment';
import { useLibraryStore } from '@/stores/library';
import { useParallelStore } from '@/stores/parallel';
import { uid } from '@/utils/id';

/**
 * 平行时空 · AI 记一件事（设计文档 §9.16）：
 * 1. 你随口说一句；把这几天（今天起 7 天）你那一边的安排、Google 日历里已有的（开着同步时）、作息交给"平行时空 · AI 记一件事"预设；
 * 2. 模型整理成要做的事、排好时间，必要时挪一挪能挪的；程序再查一遍冲突（撞了、排到过去的挪到最近的空档）；
 * 3. 你看过、去掉不要的，再记进去：新的记成"自己记的"（排到哪天记在哪天），挪的改在各自的来源上；开着同步的写进 Google 日历。
 * 调"平行时空"的 API。
 */

/** AI 记一件事用的预设（选成了别的、被删了时为空） */
export function capturePreset(): Preset | undefined {
  const p = useLibraryStore().presetForUse('parallel-capture');
  return p?.category === 'parallel' && isParallelCapturePreset(p) ? p : undefined;
}

/** 能不能用 AI 记（API 接通了、有"平行时空 · AI 记一件事"预设）；不能时说明原因、去哪改 */
export function captureStatus(): { ok: true } | { ok: false; reason: string; fix: string } {
  const s = useAiStore().status('parallel');
  if (!s.live) return { ok: false, reason: `「${AGENT_META.parallel.label}」的 API 还没接通：${s.reason}`, fix: '/me/api?feature=parallel' };
  if (!capturePreset()) return { ok: false, reason: new MissingPresetError('平行时空 · AI 记一件事').message, fix: '/me/presets?cat=parallel' };
  return { ok: true };
}

export type CaptureResult = { ok: true; plan: CapturePlan; days: CaptureDay[]; clock: CaptureNow; calendarNote: string } | { ok: false; reason: string };

/** 让 AI 整理、排好（还没记进去）；calendar：开着同步时先看一眼这几天 Google 日历里已有的 */
export async function draftCapture(persona: Persona, text: string, opts: { calendar: boolean; signal?: AbortSignal }): Promise<CaptureResult> {
  const said = text.trim();
  if (!said) return { ok: false, reason: '先说一句要做什么' };
  const status = captureStatus();
  if (!status.ok) return status;
  const env = useEnvironmentStore().settings;
  const now = Date.now();
  const today = parallelToday();
  const clock: CaptureNow = { today, minute: nowDayMinute(now, env.timezone) };
  const dates: ISODate[] = Array.from({ length: CAPTURE_DAYS }, (_, i) => shiftDate(today, i));

  let calendar = new Map<ISODate, CaptureDay['calendar']>();
  let calendarNote = '';
  if (opts.calendar && calendarState(persona).ok) {
    try {
      calendar = await calendarBusy(persona, dates);
    } catch (e) {
      if (isAbortError(e) && opts.signal?.aborted) return { ok: false, reason: '取消了' };
      calendarNote = `没读到 Google 日历（${errorText(e)}），只按平行时空里的安排排`;
    }
  }
  const days: CaptureDay[] = dates.map((date) => ({ date, entries: myEntriesOn(persona, date), calendar: calendar.get(date) ?? [] }));
  const refs = captureRefs(days, clock);
  const preset = capturePreset()!;
  try {
    const { value } = await useAiStore().system.json(
      'parallel',
      {
        messages: parallelCaptureMessages({ userName: persona.name, text: said, now, timeZone: env.timezone, clock, days, refs, env }, preset),
        ...samplerRequest(preset.sampler),
      },
      (v) => parseParallelCapture(v, dates),
      { signal: opts.signal },
    );
    return { ok: true, plan: settleCapture(value, days, refs, clock, env), days, clock, calendarNote };
  } catch (e) {
    return { ok: false, reason: isAbortError(e) ? '取消了' : errorText(e) };
  }
}

export interface CaptureChoice {
  /** 和 plan.items、plan.moves 一一对应：要不要 */
  items: boolean[];
  moves: boolean[];
  /** 新记的写进 Google 日历 */
  calendar: boolean;
}

export interface CaptureApplied {
  added: number;
  moved: number;
  /** 写进 Google 日历的几件 */
  synced: number;
  /** 没写进 Google 日历的原因（第一条） */
  calendarError: string;
}

/**
 * 记进去：先挪（今天的改在各自的来源上，和你自己点开改一样；别的日子只挪自己记的），再把新的记成"自己记的"；
 * 开着同步的写进 Google 日历，挪过的、同步过的自己记的那几条在日历里跟着改。日历没写成不影响记下来的
 */
export async function applyCapture(persona: Persona, plan: CapturePlan, choice: CaptureChoice): Promise<CaptureApplied> {
  const parallel = useParallelStore();
  const today = parallelToday();
  let moved = 0;
  const relinked: { date: ISODate; id: string }[] = [];
  plan.moves.forEach((m, i) => {
    if (!choice.moves[i]) return;
    const e = m.ref.entry;
    if (m.ref.date === today) editEntry(persona, e, { time: m.time });
    else if (e.kind === 'item') parallel.updateItem(persona.id, m.ref.date, e.key.slice('item:'.length), { time: m.time });
    else return;
    moved += 1;
    if (e.kind === 'item') relinked.push({ date: m.ref.date, id: e.key.slice('item:'.length) });
  });

  const added: { date: ISODate; id: string }[] = [];
  plan.items.forEach((it, i) => {
    if (!choice.items[i]) return;
    const item = parallel.addItem(persona.id, it.date, {
      time: it.start !== null ? clockOf(it.start) : '',
      minutes: it.minutes,
      title: it.title,
      note: it.note,
      checklist: it.checklist.map((text) => ({ id: uid('pc'), text, done: false })),
    });
    added.push({ date: it.date, id: item.id });
  });

  let synced = 0;
  const errors: string[] = [];
  if (choice.calendar && calendarState(persona).ok) {
    for (const a of added) {
      try {
        await linkToCalendar(persona, a.date, a.id);
        synced += 1;
      } catch (e) {
        errors.push(errorText(e));
      }
    }
  }
  for (const r of relinked) await syncItemCalendar(persona, r.date, r.id).catch((e: unknown) => errors.push(errorText(e)));
  return { added: added.length, moved, synced, calendarError: errors[0] ?? '' };
}
