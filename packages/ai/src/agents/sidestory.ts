import { characterPronoun, textFn, type TextFn } from '@app/shared';
import { assembleTaskPrompt } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 番外智能体（sidestory）：你不在的时候，她在自己的小世界里发生了什么。
 * 按她的性格、作息、此刻的地点、世界里的其他人，以及最近和你聊过的事，写一小段第三人称的日常故事。
 * 故事可以引出一条主动消息（hook）或一张配图（cg，交给生图提示词智能体），
 * 也写进她的"生活记录"，之后聊天时她能自然地提起（"今天室友又借我充电器"）。
 * 提示词（说明、要求、输出格式）全在"小剧场"预设里；这里只填这一次的输入。
 */

export interface SidestoryInput {
  character: {
    name: string;
    pronoun: string;
    description: string;
    personality?: string;
    scenario?: string;
  };
  user: { name: string };
  now: Date;
  world?: {
    name: string;
    blurb?: string;
    /** "08:30–11:30 图书馆 · 自习中" 这样的作息行 */
    schedule?: string[];
    studyTask?: string;
    meals?: string;
    people?: { name: string; relation: string }[];
  };
  /** 她此刻在哪、在做什么 */
  current?: { place?: string; status?: string };
  memories?: string[];
  recentChat?: string[];
  /** 最近写过的番外标题，避免重复 */
  previous?: string[];
}

export interface Sidestory {
  title: string;
  story: string;
  /** 故事发生的时段（"午后""21:40"） */
  time: string;
  place: string;
  /** 她现在的心情（一个词） */
  mood: string;
  people: string[];
  /** 写完这件事后她可能发给你的一句话；没有为 null */
  hook: string | null;
  /** 最适合配图的一幕（中文）；没有为 null */
  cg: string | null;
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function clock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function cut(text: string | undefined, max: number): string {
  const t = (text ?? '').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 这一次的输入：填进"小剧场"预设的程序填充块 */
export function sidestoryFills(input: SidestoryInput, t: TextFn): Record<string, string> {
  const { character: c, user, world, current } = input;
  const now = input.now;
  return {
    storyCharacter: t('story.character', { name: c.name, description: cut(c.description, 1200), personality: cut(c.personality, 300), scenario: cut(c.scenario, 300) }),
    storyWorld: world
      ? t('story.world', {
        pronoun: characterPronoun(c), name: world.name, blurb: world.blurb, schedule: world.schedule ?? [], task: world.studyTask, meals: world.meals,
        people: (world.people ?? []).map((p) => t('story.person', { name: p.name, relation: p.relation })),
      })
      : '',
    storyNow: t('story.now', {
      date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`, weekday: WEEKDAY[now.getDay()], time: clock(now),
      char: c.name, place: current?.place, status: current?.status,
    }),
    storyMemories: input.memories?.length ? t('story.memories', { char: c.name, user: user.name, items: input.memories.slice(0, 8) }) : '',
    storyRecent: input.recentChat?.length ? t('story.recent', { lines: input.recentChat.slice(-8) }) : '',
    storyPrevious: input.previous?.length ? t('story.previous', { titles: input.previous.slice(-5) }) : '',
  };
}

/** 按"小剧场"预设拼番外的提示词 */
export function buildSidestoryMessages(input: SidestoryInput, preset: TaskPreset): ChatMessage[] {
  return assembleTaskPrompt({ preset, fills: sidestoryFills(input, textFn(preset.texts)), macros: { char: input.character.name, pronoun: input.character.pronoun, user: input.user.name, now: input.now } }).messages;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function nullable(v: unknown): string | null {
  const s = str(v);
  return s && s.toLowerCase() !== 'null' ? s : null;
}

export function parseSidestory(value: unknown): Sidestory | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const story = str(v.story);
  if (story.length < 20) return null;
  return {
    title: str(v.title).slice(0, 30) || story.slice(0, 12),
    story,
    time: str(v.time),
    place: str(v.place),
    mood: str(v.mood).slice(0, 12),
    people: Array.isArray(v.people) ? v.people.map(str).filter(Boolean).slice(0, 8) : [],
    hook: nullable(v.hook),
    cg: nullable(v.cg),
  };
}
