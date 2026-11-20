import {
  assembleTaskPrompt,
  captureScheduleText,
  herEntries,
  nowDayMinute,
  parallelHerText,
  parallelMineText,
  parallelSourcesText,
  type CaptureDay,
  type CaptureNow,
  type CaptureRef,
  type ParallelContext,
  type ParallelEntry,
  type ParallelEnv,
  type ParallelTask,
  type SocialDay,
  type TextFn,
  TASK_MARKERS,
  textFn,
} from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import { socialCharacterFill, socialNowFill } from './social.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 平行时空智能体（设计文档 §9.16）：
 * - parallel-post：她看着你们俩今天的安排给你留一句言（云端每天在随机的时间，或者你让她现在留）；
 * - parallel-reply：你留了言、或者在留言下面回了她，她回你；
 * - parallel-request：你请她改今天的日程，她决定答不答应，答应了写出改成什么样；
 * - parallel-plan：每天到点把你的日程计划、家务、健康计划整理成平行时空里的一份计划（"平行时空 · 整理你的一天"预设）；
 * - parallel-capture：你随口说一句，整理成要做的事、避开这几天的安排排进去（"平行时空 · AI 记一件事"预设）。
 * 提示词（任务、规则、输出格式）全在"平行时空"预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseParallelPost / parseParallelReply / parseParallelRequest 读。手机和云端 Worker 用的是同一份。
 */

export type ParallelFill = keyof (typeof TASK_MARKERS)['parallel'];

export interface ParallelPromptInput {
  task: ParallelTask;
  characterName: string;
  pronoun?: string;
  userName: string;
  now?: Date;
  timeZone?: string;
  fills: Partial<Record<ParallelFill, string>>;
}

export function buildParallelMessages(input: ParallelPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { pronoun: input.pronoun, char: input.characterName, user: input.userName, now: input.now, timeZone: input.timeZone }, type: input.task }).messages;
}

/** 她今天的作息（地点是名字的那一份）→ 时间线，标出现在 */
export function herEntriesOf(day: SocialDay | null, now: number, timeZone: string): ParallelEntry[] {
  return day ? herEntries({ schedule: day.schedule, meals: day.meals, nowMin: nowDayMinute(now, timeZone) }) : [];
}

/** "她今天的节律"那一块 */
export function herFill(day: SocialDay | null, entries: ParallelEntry[], characterName: string, t: TextFn, opts: { ids?: boolean } = {}): string {
  return day ? parallelHerText(entries, t, { meals: day.meals, outfit: day.outfit, task: day.task, events: day.events }, opts) : t('parallel.her.none', { char: characterName });
}

/** "你今天的安排"那一块；不知道（云端也没有今天的）时写明 */
export function mineFill(entries: ParallelEntry[] | null, userName: string, t: TextFn): string {
  return entries ? parallelMineText(entries, userName, t) : t('parallel.mine.unknown', { user: userName });
}

/**
 * 她给你留言的输入：按上传的上下文和此刻的时间拼。her 传云端自己排的今天（手机上改过的以手机为准），
 * mine 传你今天的安排（手机上传的是今天的就用它，否则云端按日程计划算的）。
 * 一起返回两边的时间线：读回来时把模型写的编号（C3、U5）对上是哪一项
 */
export function parallelPostInput(context: ParallelContext, now: number, her: SocialDay | null, mine: ParallelEntry[] | null): { input: ParallelPromptInput; her: ParallelEntry[]; mine: ParallelEntry[] } {
  const { character: c } = context;
  const userName = context.persona.name;
  // 说明文字都在平行时空预设的程序文字里（上传的预设已经合好了自带预设文件里的）
  const t = textFn(context.preset?.texts);
  const herList = herEntriesOf(her, now, context.timezone);
  return {
    her: herList,
    mine: mine ?? [],
    input: {
      task: 'parallel-post',
      characterName: c.name, pronoun: c.pronoun,
      userName,
      now: new Date(now),
      timeZone: context.timezone,
      fills: {
        parallelCharacter: socialCharacterFill(c, userName, t),
        parallelNow: socialNowFill(now, context.timezone, t).text,
        parallelHer: herFill(her, herList, c.name, t),
        parallelMine: mineFill(mine, userName, t),
        parallelMemories: context.memories,
        parallelRecent: context.recent ? t('social.recent', { recent: context.recent }) : '',
        parallelNotes: context.notes ? t('parallel.notes', { notes: context.notes }) : '',
        parallelAsk: t('parallel.ask.post', { char: c.name, user: userName }),
      },
    },
  };
}

/**
 * 整理你的一天（parallel-plan）：几份计划里的事（带编号 S1、S2…）交给模型，排成一份。
 * 输出用 @app/shared 的 parseParallelPlan 读（编号换回来源的 key）。手机和云端 Worker 用的是同一份
 */
export function parallelPlanMessages(input: { userName: string; date: string; now: number; timeZone: string; sources: ParallelEntry[] }, preset: TaskPreset): ChatMessage[] {
  const t = textFn(preset.texts);
  return buildParallelMessages({
    task: 'parallel-plan',
    characterName: '',
    userName: input.userName,
    now: new Date(input.now),
    timeZone: input.timeZone,
    fills: {
      parallelNow: socialNowFill(input.now, input.timeZone, t).text,
      parallelSources: parallelSourcesText(input.sources, input.userName, t),
      parallelAsk: t('parallel.ask.plan', { user: input.userName, date: input.date }),
    },
  }, preset);
}

/**
 * AI 记一件事（parallel-capture）：你随口说的、这几天的安排（带编号 E1、E2…，能不能挪，Google 日历里已有的）交给模型，
 * 整理成要做的事排进去。输出用 @app/shared 的 parseParallelCapture 读，再用 settleCapture 查一遍冲突
 */
export function parallelCaptureMessages(
  input: { userName: string; text: string; now: number; timeZone: string; clock: CaptureNow; days: CaptureDay[]; refs: CaptureRef[]; env: ParallelEnv },
  preset: TaskPreset,
): ChatMessage[] {
  const last = input.days.at(-1)?.date ?? input.clock.today;
  const t = textFn(preset.texts);
  return buildParallelMessages({
    task: 'parallel-capture',
    characterName: '',
    userName: input.userName,
    now: new Date(input.now),
    timeZone: input.timeZone,
    fills: {
      parallelNow: socialNowFill(input.now, input.timeZone, t).text,
      parallelSchedule: captureScheduleText(input.days, input.refs, input.clock, input.env, input.userName, t),
      parallelInput: t('parallel.capture.input', { user: input.userName, text: input.text.trim() }),
      parallelAsk: t('parallel.ask.capture', { user: input.userName, from: input.clock.today, to: last }),
    },
  }, preset);
}
