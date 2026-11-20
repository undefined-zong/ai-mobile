import { assembleTaskPrompt, rhythmDate, socialDayText, type DiaryContext, type SocialDay, type TASK_MARKERS } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import { socialCharacterFill, socialNowFill } from './social.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 日记智能体（"日记"的 API 和"日记"预设）：开了"主动写日记"的角色每晚 22:00 按今天的节律写一篇当天的日记——
 * 写Ta自己的一天（在哪、做了什么、吃了什么、穿什么、遇到的小事、心里在想什么），你只是其中一部分；
 * 可以配一张图（写一句画面，手机用"生图"画）。
 * 提示词（任务、规则、输出格式）全在"日记"预设里；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseDiaryDraft 读。手机和云端 Worker 用的是同一份。
 */

export type DiaryFill = keyof (typeof TASK_MARKERS)['diary'];

export interface DiaryPromptInput {
  characterName: string;
  pronoun?: string;
  userName: string;
  now?: Date;
  timeZone?: string;
  fills: Partial<Record<DiaryFill, string>>;
}

export function buildDiaryMessages(input: DiaryPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { pronoun: input.pronoun, char: input.characterName, user: input.userName, now: input.now, timeZone: input.timeZone }, type: 'diary' }).messages;
}

/**
 * 写一篇日记的输入：按上传的上下文（手机拼好的文字）和此刻的时间拼。
 * day 传云端自己排的那天（没有就用上下文里的）；date 是要写的那一天（补写昨天的时不是今天）
 */
export function diaryInput(context: DiaryContext, now: number, date: string, day: SocialDay | null = context.day): DiaryPromptInput {
  const { character: c, userName } = context;
  const at = socialNowFill(now, context.timezone);
  // 写的是今天（今晚睡前写）还是补写前一天的
  const today = rhythmDate(new Date(now), context.timezone) === date;
  const ownDay = day && day.date === date ? day : context.day?.date === date ? context.day : null;
  const withUser = context.date === date ? context.withUser : '';
  return {
    characterName: c.name, pronoun: c.pronoun, userName, now: new Date(now), timeZone: context.timezone,
    fills: {
      diaryCharacter: socialCharacterFill(c, userName),
      diaryDay: ownDay ? socialDayText(ownDay, today ? at.minute : null) : `${c.name}这一天没有排节律：按角色卡里平时的生活来写`,
      diaryNow: [at.text, today && context.weather ? `天气：${context.weather}` : ''].filter(Boolean).join('\n'),
      diaryUser: withUser ? `${date} 这一天和${userName}：\n${withUser}` : `${date} 这一天和${userName}没怎么聊`,
      diaryMemories: context.memories,
      diaryPrevious: context.previous ? `最近几篇日记（不要重复写过的事和句子）：\n${context.previous}` : '',
      diaryAsk: [
        `这一次：${c.name}在写 ${date} 这一天的日记${today ? '（今晚睡前写）' : '（那天晚上没来得及写，现在补写那一天）'}。`,
        context.settings.image ? '这一天有值得画下来的画面就写 image，没有写 null。' : '这一篇不配图：image 写 null。',
      ].join('\n'),
    },
  };
}
