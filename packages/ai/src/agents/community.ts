import { assembleTaskPrompt, communityInfoText, socialDayText, type CommunityContext, type CommunityTask, type SocialContext, type SocialDay } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import { socialCharacterFill, socialNowFill, type SocialFill } from './social.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 社媒智能体（社群）：
 * - community-create：搜不到社群时按关键字建一个（名字、简介、风气、标签、图标）；
 * - community-feed：网友发一批帖子（正文，可以配图——写画面交给生图，可以附一小页 HTML）；
 * - community-react：你发了帖、回了话，网友点赞、顶帖、回复；
 * - community-member-post / community-member-react：你邀请进社群的角色发帖、回应你。
 * 提示词（任务、规则、输出格式）全在"社媒 · 社群"预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseCommunityDraft / parseCommunityBatch / parseCommunityReaction / parseMemberReaction 读。
 * 手机和云端 Worker 用的是同一份。
 */

/** 社群预设的程序填充块：社群自己的四块，加上角色发帖、回应时和朋友圈共用的几块（TASK_MARKERS.social） */
export type CommunityFill = 'communityInfo' | 'communityMembers' | 'communityFeed' | 'communityPost' | Exclude<SocialFill, 'socialFeed' | 'socialPost'>;

export interface CommunityPromptInput {
  task: CommunityTask;
  /** 角色发帖、回应时是她的名字；网友的任务为空 */
  characterName: string;
  pronoun?: string;
  userName: string;
  /** {{community}}：社群的名字（建社群时还没有，为空） */
  communityName: string;
  now?: Date;
  timeZone?: string;
  fills: Partial<Record<CommunityFill, string>>;
}

export function buildCommunityMessages(input: CommunityPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({
    preset, fills, type: input.task,
    macros: { pronoun: input.pronoun, char: input.characterName, user: input.userName, now: input.now, timeZone: input.timeZone, extra: { community: input.communityName } },
  }).messages;
}

/** "社群里你认识的人"那一块：你和你邀请进来的角色。网友不能用这些名字发帖、回复 */
export function communityMembersFill(userName: string, members: { name: string }[]): string {
  return [
    '社群里的熟人（真实的用户，和用户邀请进来的角色）：',
    `- ${userName}：用这个 App 的人，社群成员`,
    ...members.map((m) => `- ${m.name}：${userName}邀请进来的，和${userName}互相关注`),
  ].join('\n');
}

/** 网友发一批帖子的输入：按上传的上下文（手机拼好的文字）和此刻的时间拼 */
export function communityFeedInput(context: CommunityContext, now: number): CommunityPromptInput {
  const n = context.settings.batchSize;
  return {
    task: 'community-feed', characterName: '', userName: context.userName, communityName: context.community.name, now: new Date(now), timeZone: context.timezone,
    fills: {
      communityInfo: communityInfoText(context.community),
      communityMembers: communityMembersFill(context.userName, context.members),
      socialNow: socialNowFill(now, context.timezone).text,
      communityFeed: context.feed ? `最近的帖子（不要重复发过的内容）：\n${context.feed}` : '',
      socialAsk: `这一次：写 ${n} 帖，是 ${n} 个不同的网友发的。`,
    },
  };
}

/**
 * 加入社群的角色发一帖的输入：社群这边用社群的上下文，她这边用她上传的朋友圈上下文（角色卡、记得的事、最近的聊天）。
 * day 传云端自己排的今天，没有就用她上下文里的
 */
export function communityMemberPostInput(context: CommunityContext, member: SocialContext, now: number, day: SocialDay | null = member.day): CommunityPromptInput {
  const c = member.character;
  // 她眼里你的名字（和她那条聊天选的人设）：和她记得的事、最近的聊天里的称呼一致
  const userName = member.userName || context.userName;
  const at = socialNowFill(now, context.timezone);
  return {
    task: 'community-member-post', characterName: c.name, pronoun: c.pronoun, userName, communityName: context.community.name, now: new Date(now), timeZone: context.timezone,
    fills: {
      socialCharacter: socialCharacterFill(c, userName),
      socialLife: day ? socialDayText(day, at.minute) : '',
      socialNow: at.text,
      socialMemories: member.memories,
      socialRecent: member.recent ? `最近的聊天：\n${member.recent}` : '',
      communityInfo: communityInfoText(context.community),
      communityMembers: communityMembersFill(userName, context.members),
      communityFeed: context.feed ? `最近的帖子（不要重复发过的内容）：\n${context.feed}` : '',
      socialAsk: `这一次：${c.name}在社群「${context.community.name}」里发一帖。`,
    },
  };
}
