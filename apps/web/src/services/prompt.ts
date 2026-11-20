import { characterPronoun } from '@app/shared';
import { openaiReasoningEffort } from '@app/ai';
import {
  allowedInviteGames,
  anniversaryLine,
  applyModuleSwitches,
  applyRegexScripts,
  assemblePrompt,
  buildChatRequest,
  estimateTokens,
  expressionPromptLines,
  formatEnvironmentBlock,
  getLocation,
  getScene,
  inviteGameLabel,
  isRealPlace,
  MEAL_LABEL,
  moduleSwitches,
  pokeLine,
  portraitTags,
  PRESET_CATEGORIES,
  presetUse,
  sceneUse,
  tagDoc,
  textFn,
  type AppBlockFill,
  type PresetUseId,
  type AssembleResult,
  type Character,
  type Chat,
  type ChatTurn,
  type ControlTagKind,
  type GenerationType,
  type Message,
  type MessagePart,
  type AgentRole,
  type Persona,
  type Preset,
  type TextFn,
  type RegexScript,
  type TruthDareTally,
} from '@app/shared';
import type { LLMChatMessage } from './types';
import { useAiStore } from '@/stores/ai';
import { usePersonaStore } from '@/stores/personas';
import { useEnvironmentStore } from '@/stores/environment';
import { textsFor, useLibraryStore } from '@/stores/library';
import { afterSummarized, lastN, useMessageSettingsStore } from '@/stores/messageSettings';
import { useRealWorldStore } from '@/stores/realworld';
import { useRhythmStore } from '@/stores/rhythm';
import { useWeatherStore } from '@/stores/weather';
import { homeBlock, lifeFlags } from './homeBlock';
import { memoryBlocks } from './memoryBlocks';
import { recallForTurn, type RecallForTurn } from './recall';

/**
 * 每一轮的提示词：把这条聊天、角色卡、绑定的世界书、预设交给共享的拼装器（packages/shared/src/st/assemble.ts，
 * 按 SillyTavern 的规则拼），App 自己的记忆 / 摘要 / 环境 / 场景规则在这里填好内容传进去。
 * 发送和"查看提示词"用的是同一个函数，所以查看到的就是真实请求。
 */

export { estimateTokens };

export function personaOf(chat: Chat | undefined): Persona {
  return usePersonaStore().forChat(chat);
}

function partToText(p: MessagePart, character: Character, user: string, mapText?: (text: string) => string): string {
  switch (p.type) {
    case 'text':
      return mapText ? mapText(p.text) : p.text;
    case 'voice':
      return `[语音] ${p.transcript}`;
    case 'image':
      // 你发的照片：识图看到的内容代替图片；没看成就照实说看不到
      if (p.photo) return p.seen ? `[照片：${p.seen}]` : `[照片（${character.name}看不到照片的内容）]`;
      return `[图片：${p.title || p.caption}]`;
    case 'music':
      return `[分享歌曲：${p.title} - ${p.artist}]`;
    case 'poke':
      return `（${pokeLine(p, user, character.name)}）`;
    case 'call-log':
      if (p.missed) return `[${p.answered ? '打来的' : '没接通的'}${p.video ? '视频通话' : '语音通话'}]`;
      return `[${p.video ? '视频通话' : '语音通话'} ${Math.round(p.durationSec / 60)} 分钟${p.scene ? ` · ${p.scene}` : ''}]`;
    case 'workout':
      return `[${workoutText(p)}]`;
    case 'chore':
      return p.status === 'done'
        ? `[家务：${p.name} 做完了${p.minutes ? `，做了 ${p.minutes} 分钟` : ''}${p.later ? `（之前拖了 ${p.later} 次）` : ''}${p.note ? `；${p.note}` : ''}]`
        : `[家务：${p.name} 说晚点再做（拖了 ${p.later ?? 1} 次）]`;
    case 'meal': {
      const how = p.how === 'together' ? '共同吃饭' : p.how === 'solo' ? '各吃各的' : '';
      const way = p.plan ? `按计划${{ cook: '自己做', buy: '去买', bento: '带便当' }[p.plan.way]}（计划：${p.plan.name}）` : p.mode === 'free' ? '随便吃点' : '';
      const extra = [p.photo ? '拍了照片' : '', p.herMeal ? `${character.name}吃的：${p.herMeal}` : '', p.cheers ? `碰杯 ${p.cheers} 次` : ''].filter(Boolean);
      const meta = [how, way].filter(Boolean).join('，');
      return `[一起吃饭 · ${MEAL_LABEL[p.meal] ?? '一顿饭'}：${p.food}${meta ? `（${meta}）` : ''}${extra.length ? `；${extra.join('；')}` : ''}]`;
    }
    case 'study': {
      const done = p.tasks?.filter((t) => t.done).map((t) => t.text) ?? [];
      const extra = [
        done.length ? `完成：${done.join('、')}` : '',
        p.promise ? `约定"${p.promise.text}"${p.promise.kept ? '做到了' : '没做到'}` : '',
      ].filter(Boolean);
      const how = !p.timer || p.timer === 'pomodoro' ? `${p.pomodoros} 个番茄，` : p.timer === 'countdown' ? '倒计时，' : '正计时，';
      return `[陪伴学习：${how}${p.minutes} 分钟${p.together === false ? '，各自专注' : ''}${extra.length ? `；${extra.join('；')}` : ''}]`;
    }
    case 'date': {
      if (p.status !== 'memory') return `[约会邀请：${p.when} ${p.place}]`;
      const picks = Object.entries(p.picks ?? {})
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k} ${n} 次`);
      const extra = [
        p.turns ? `走了 ${p.turns} 段${p.minutes ? `、${p.minutes} 分钟` : ''}` : '',
        picks.length ? `${user}的回法：${picks.join('、')}` : '',
        p.images?.length ? `留了 ${p.images.length} 张图` : '',
        p.farewell ? `${character.name}最后说：${p.farewell}` : '',
      ].filter(Boolean);
      return `[约会回忆 · ${p.place}${extra.length ? `：${extra.join('；')}` : ''}]`;
    }
    case 'gift':
      return `[礼物：${p.name}]`;
    case 'read':
      return `[一起读《${p.title}》：读到${p.chapter}，全书 ${p.progress}%，写了 ${p.notes} 条批注${p.quote ? `；划了"${p.quote}"` : ''}]`;
    case 'game':
      if (p.game === 'brawl') {
        const r = p.result;
        return `[大乱斗：${r.you}对战${r.opponent}，${r.winner === 'draw' ? '平局' : `${r.winner === 'you' ? r.you : r.opponent}获胜`}；${r.seconds} 秒，玩家造成 ${r.damage} 伤害，最高 ${r.combo} 连击${r.reason === 'forfeit' ? '，玩家认输' : ''}]`;
      }
      if (p.game === 'truthdare') {
        const tally = (t: TruthDareTally) => `真心话 ${t.truth} 次、大冒险 ${t.dare} 次${t.skipped ? `、认罚 ${t.skipped} 次` : ''}`;
        return `[真心话大冒险${p.level ? `（${p.level}）` : ''}：玩了 ${p.rounds} 轮；${user}${tally(p.you)}；${character.name}${tally(p.her)}]`;
      }
      if (p.game === 'decor') {
        const her = p.herAdded ? `，其中${character.name}放了 ${p.herAdded} 件` : '';
        return `[一起装修小屋「${p.room}」：现在摆了 ${p.items} 件，这一次添了 ${p.added} 件${her}]`;
      }
      if (p.game === 'workshop') {
        const mood = p.verdict === 'cheer' ? `，想听${characterPronoun(character)}捧场` : p.verdict === 'roast' ? `，想听${characterPronoun(character)}吐槽` : '';
        if (p.kind === 'image') return `[${user}在创意工坊画了一张画「${p.title}」拿给${character.name}看${mood}]`;
        const head = p.excerpt ? `，开头是：${p.excerpt}` : '';
        return `[${user}在创意工坊写的小说《${p.title}》${p.chapter ? `的「${p.chapter}」` : ''}拿给${character.name}看${mood}${head}]`;
      }
      if (p.game === 'flight') {
        const won = p.winner ? `；${p.winner === 'you' ? user : character.name}先到了终点` : '';
        return `[飞行棋「${p.board}」：掷了 ${p.turns} 次骰子；${user}走到第 ${p.you} 格，${character.name}走到第 ${p.her} 格（一共 ${p.size} 格）${won}]`;
      }
      return `[海龟汤《${p.title}》：${{ solved: '猜出来了', partial: '猜对了一半', 'gave-up': '认输了' }[p.result]}，问了 ${p.questions} 个问题${p.truth ? `；汤底：${p.truth}` : ''}]`;
    case 'watch':
      return `[一起看了《${p.title}》${p.minutes} 分钟${p.yourScore ? `；${user}打 ${p.yourScore}/5` : ''}${p.herScore ? `；${character.name}打 ${p.herScore}/5` : ''}]`;
    case 'scene':
      return `（${p.title}${p.summary ? `：${p.summary}` : ''}）`;
    case 'invite': {
      const activity = p.kind === 'sleep' ? '哄睡' : p.kind === 'exercise' ? '一起运动' : p.kind === 'parallel' ? '一起看平行时空' : '';
      const what =
        p.kind === 'study'
          ? `一起学习${p.task ? `：${p.task}` : ''}${p.minutes ? `（${p.minutes} 分钟）` : ''}`
          : p.kind === 'watch'
            ? `一起看${p.title ? `《${p.title}》` : '片'}`
            : p.kind === 'game'
              ? `一起玩${inviteGameLabel(p.game)}`
              : activity;
      return `[邀请${what}${p.answer === 'yes' ? `；${user}答应了` : p.answer === 'no' ? `；${user}这次没答应` : ''}]`;
    }
    case 'toy':
      return `[玩具：${p.text}]`;
  }
}

/** 运动卡片的一句话："健身：照计划练「上肢 + 核心」做完 5/6 个动作，32 分钟；平均心率 138；约 210 千卡" */
export function workoutText(p: Extract<MessagePart, { type: 'workout' }>): string {
  const head = p.mode === 'plan' && p.plan ? `健身：照计划练「${p.plan.title}」，做完 ${p.plan.done}/${p.plan.total} 个动作` : `运动记录：${p.sport}`;
  const parts = [
    `用时 ${Math.max(1, Math.round(p.durationSec / 60))} 分钟`,
    p.distanceKm ? `${p.distanceKm} 公里${p.pace ? `（配速 ${p.pace}）` : ''}` : '',
    p.steps ? `${p.steps} 步` : '',
    p.heartRate?.avg ? `平均心率 ${p.heartRate.avg}${p.heartRate.max ? `、最高 ${p.heartRate.max}` : ''}` : '',
    p.kcal ? `约 ${p.kcal} 千卡` : '',
  ].filter(Boolean);
  return `${head}；${parts.join('；')}${p.source === 'watch' ? '（手表记的）' : ''}`;
}

/** mapText：只改文字部分（正则只改你写的、她说的，不动卡片的描述） */
export function messageToText(m: Message, character: Character, user = usePersonaStore().defaultPersona.name, mapText?: (text: string) => string): string {
  return m.parts.map((p) => partToText(p, character, user, mapText)).filter(Boolean).join('\n').trim();
}

export interface TurnOptions {
  /** 只发送最近几条（消息设置 → 发送条数）；不给不限 */
  last?: number;
  /** 预设里的正则：只跑"只改发给 AI 的"，按这条在发出去的聊天记录里的深度（0 = 最后一条） */
  regex?: readonly RegexScript[];
  /** 统计：有内容的消息一共几条、按条数截掉几条、正则改了几条 */
  stats?: { total: number; dropped: number; regexed: number };
}

/** 聊天记录 → 拼装器要的格式：旁白 / 场景分隔当系统消息（同 ST 的 narrator） */
export function toTurns(history: Message[], character: Character, user: string, opts: TurnOptions = {}): ChatTurn[] {
  const all = history.filter((m) => messageToText(m, character, user));
  const items = lastN(all, opts.last);
  if (opts.stats) Object.assign(opts.stats, { total: all.length, dropped: all.length - items.length, regexed: 0 });
  const out: ChatTurn[] = [];
  items.forEach((m, i) => {
    const placement = m.role === 'user' ? 'user_input' : m.role === 'assistant' ? 'ai_output' : null;
    const plain = messageToText(m, character, user);
    const text =
      placement && opts.regex?.length
        ? messageToText(m, character, user, (t) => applyRegexScripts(opts.regex, t, { target: 'prompt', placement, depth: items.length - 1 - i, char: character.name, user }))
        : plain;
    if (opts.stats && text !== plain) opts.stats.regexed++;
    // 正则把整条都删掉了：这一条不发（同空消息）
    if (!text) return;
    // 一起做事时说的话带上位置（第几个番茄、片内时间……），她知道是在哪一刻说的
    // 通话状态由当前任务提供，历史通话的标签不再写进说话正文。
    const cue = m.meta?.cue;
    const content = cue && cue !== '语音通话' && cue !== '视频通话' ? `（${cue}）${text}` : text;
    if (m.role === 'user') out.push({ role: 'user', name: user, content });
    else if (m.role === 'assistant') out.push({ role: 'assistant', name: character.name, content });
    else out.push({ role: 'system', name: '', content });
  });
  return out;
}

/**
 * 预设里改存下来的消息的正则（"只改显示""只改发给 AI 的"都没勾的）：她回复写完、你发送、改消息时执行（同 ST）。
 * 用这一轮的预设（聊天页是这个角色的对话预设）
 */
export function storeRegex(chat: Chat, character: Character, text: string, role: 'user' | 'assistant', opts: { edit?: boolean; preset?: Preset } = {}): string {
  const preset = opts.preset ?? presetForTurn(chat, character).preset;
  if (!preset?.regex.length) return text;
  return applyRegexScripts(preset.regex, text, {
    target: 'store',
    placement: role === 'user' ? 'user_input' : 'ai_output',
    edit: opts.edit,
    char: character.name,
    user: personaOf(chat).name,
  });
}

/** App 自己的四块：摘要、记忆 + 关系、【当前环境】、场景规则；说明文字都是这一轮预设的程序文字（t） */
function appFills(chat: Chat, character: Character, history: Message[], now: Date, timeZone: string, recall: RecallForTurn, proactive: boolean, query: string, t: TextFn): Record<string, AppBlockFill> {
  const scene = getScene(chat.currentScene ?? 'free');
  const loc = getLocation(chat.togetherAt ?? character.locationId);
  const who = { char: character.name, pronoun: character.pronoun, place: loc?.name };
  const place = !loc
    ? null
    : chat.togetherAt
      ? isRealPlace(loc)
        ? loc.id === 'real:home'
          ? t('env.place.home', who)
          : t('env.place.out', who)
        : t('env.place.herWorldTogether', who)
      : t('env.place.her', { ...who, status: character.status, you: useRealWorldStore().whereText(t) });

  // 距上次聊天：最后一条之前那条消息到现在
  const before = history.at(-2)?.createdAt;
  const sinceLastChatMin = before ? Math.max(0, (now.getTime() - before) / 60_000) : null;

  // 她今天穿什么（节律里这个场景该穿的那套）；服装参考关着时不告诉，免得 [cg:] 里写的永远是这一身
  const outfit = useAiStore().outfitRef() ? useRhythmStore().outfitFor(character.id, chat.currentScene) : undefined;
  // 真实天气：你那边；她住在别的城市（例如国内）时再加她那边的。取不到就不写，不编
  const { weather, herWeather } = useWeatherStore().envInput(character, t);

  const blocks = memoryBlocks(chat, character, now.getTime(), timeZone, { proactive, query, recall: recall.lines, t });
  const { summary, memory } = blocks;
  recall.lines = blocks.recall;
  const cached = new Set(recall.snapshot?.lines.map((l) => l.key));
  recall.added = recall.reused ? 0 : recall.lines.filter((l) => !cached.has(l.key)).length;
  if (!proactive) {
    const notes = [
      recall.reused ? '重新生成：沿用这条回复原来用的记忆' : recall.snapshot ? `本轮输入检索保留 ${recall.lines.length} 条${recall.snapshot.dense ? '（按意思 + 字面）' : `（${recall.snapshot.denseNote || '只按字面'}）`}` : '按本轮输入在本机检索',
      recall.added ? `发送时按本轮消息补了 ${recall.added} 条` : '',
    ].filter(Boolean);
    memory.source = `${memory.source} · ${notes.join(' · ')}`;
  }

  return {
    summary,
    memory,
    environment: {
      content: formatEnvironmentBlock({
        now,
        timeZone,
        weather,
        herWeather,
        sinceLastChatMin,
        place,
        outfit: outfit ? t('env.outfit', { char: character.name, outfit: outfit.name }) : null,
        sceneName: scene.id === 'free' ? null : scene.name,
        anniversaries: anniversaryLine(character.relationship.anniversaries, now.getTime(), timeZone, t),
      }, t),
      source: `时间 / 节气 / 纪念日 / 天气（${[weather ? `你那边 ${weather.city}` : '你那边没取到', herWeather ? `${character.name}那边 ${herWeather.city}` : ''].filter(Boolean).join('，')}）/ ${characterPronoun(character)}在哪 / ${characterPronoun(character)}今天穿什么`,
    },
    sceneRules: {
      content: tagsLine(scene, character, t),
      source: `场景"${scene.name}"能用的标签和表情（场景规则由当前预设提供）`,
    },
  };
}

/** 她能用自己的动作立绘的地方：聊天里，还有戳戳乐（被碰了捂脸、躲开、凑过来……） */
const POSE_SCENES = new Set<string>(['free', 'poke']);

/**
 * 这个场景能用的标签：每个都写清楚写法和什么时候用（只给名字的话模型写不对，比如 [cg] 后面不带画面就画不出来）。
 * 表情只列她有图的（没有立绘时是占位小人会的那几种）；聊天里、戳戳乐里她有两个以上的动作时加上 [pose:] 和能用的动作
 */
export function sceneTags(scene: ReturnType<typeof getScene>, character: Character): ControlTagKind[] {
  // 日常聊天里能主动调用哪些模块（歌曲、电话、学习 / 看片 / 游戏 / 哄睡 / 运动 / 平行时空邀请、玩具）：按她绑定的世界书里对应条目的开关
  const base = scene.id === 'free' ? applyModuleSwitches(scene.allowedTags, moduleSwitches(boundLoreEntries(character))) : scene.allowedTags;
  return POSE_SCENES.has(scene.id) ? portraitTags(base, character.portraits) : base;
}

/** 她绑定的世界书里的全部条目（开着的、关着的）：聊天里的主动卡片按它们开关 */
export function boundLoreEntries(character: Character) {
  const lib = useLibraryStore();
  return character.lorebookIds.flatMap((id) => lib.lorebookById(id)?.entries ?? []);
}

/** 场景规则那一块（程序文字 tags.block / tags.item / tags.<种类>.*）：这个场景能用的标签，游戏只列她现在能约的 */
function tagsLine(scene: ReturnType<typeof getScene>, character: Character, t: TextFn, allowed = sceneTags(scene, character)): string {
  const games = allowedInviteGames(boundLoreEntries(character)).map(inviteGameLabel);
  return t('tags.block', {
    tags: allowed.map((k) => t('tags.item', tagDoc(k, t, { games }))),
    expressions: expressionPromptLines(character.portraits, t, { poses: allowed.includes('pose') }),
  });
}

/** 这个角色的对话预设；没选或失效时回退到日常对话。 */
export function presetFor(character: Character | undefined): Preset | undefined {
  return useLibraryStore().chatPresetFor(character);
}

/** 这一轮用的是哪个用途的预设：主动消息 → 在场景页里一起做某件事（那件事的功能预设）→ 聊天（这个角色的对话预设）。场景只在场景页开着时有 */
export type ChatPresetUse = PresetUseId | 'chat';

export function presetForTurn(chat: Chat, character: Character, agent?: AgentRole, use?: PresetUseId): { preset: Preset | undefined; use: ChatPresetUse } {
  const lib = useLibraryStore();
  // 指定了用途（语音通话）：按那个用途选，不看场景
  if (use) return { preset: lib.presetForUse(use, character), use };
  if (agent === 'secondary') return { preset: lib.presetForUse('secondary', character), use: 'secondary' };
  if (agent === 'proactive') return { preset: lib.presetForUse('proactive', character), use: 'proactive' };
  const scene = sceneUse(chat.currentScene);
  if (scene) return { preset: lib.presetForUse(scene, character), use: scene };
  return { preset: lib.chatPresetFor(character), use: 'chat' };
}

/** 一个预设都选不到时的报错：说清楚缺哪一类、去哪里补 */
export class MissingPresetError extends Error {
  constructor(what: string) {
    super(`没有可用的${what}预设：去"我的 → 预设"导入一个预设文件，或者复制一个过来`);
    this.name = 'MissingPresetError';
  }
}

/**
 * 一起做事、通话、游戏拼场景任务时用的程序文字：这个用途这一次会用的那个预设里的
 * （和 presetForTurn 选的同一个；chat 是这个角色的对话预设）
 */
export function sceneText(use: ChatPresetUse, character?: Character | null): TextFn {
  const lib = useLibraryStore();
  return textFn(textsFor(use === 'chat' ? lib.chatPresetFor(character) : lib.presetForUse(use, character)));
}

/** "功能 · 一起吃饭"、"对话"：这一轮的预设是按什么选的 */
export function useLabel(use: ChatPresetUse): string {
  if (use === 'chat') return '对话（这个角色的预设）';
  const u = presetUse(use);
  return u ? `${PRESET_CATEGORIES[u.category].label} · ${u.label}` : use;
}

/** 这个功能用的模型名（请求体里的 model）；还没接通时显示"演示模型" */
export function modelOf(agent: AgentRole = 'main'): string {
  const ai = useAiStore();
  return ai.isLive(agent) ? ai.chatModelOf(agent) || '演示模型' : '演示模型';
}

/** 主对话智能体用的模型名 */
export function mainModel(): string {
  return modelOf('main');
}

export interface ChatPrompt extends AssembleResult {
  preset: Preset;
  /** 预设是按什么选的：对话 / 某件事的功能预设 / 主动消息 */
  use: ChatPresetUse;
  persona: Persona;
  request: Record<string, unknown>;
  /** 交给拼装器之前的聊天记录：有内容的总条数、按发送条数截掉的条数、正则修改的条数、去掉的已总结消息条数 */
  turnStats: { total: number; dropped: number; regexed: number; last?: number; summarized?: number };
  /** 这一轮带上的记忆（取到的和为什么） */
  recall: RecallForTurn;
}

export interface ChatAssembleOptions {
  /** 同一次生成的提示词和时间宏共用这个时刻，按环境设置的时区格式化。 */
  now?: Date;
  /** 只是查看：不推进世界书的粘性 / 冷却、不改聊天变量 */
  dryRun?: boolean;
  type?: GenerationType;
  /**
   * 后台生成（主动消息）：这一次要她做的事（程序写的，只有时间和要做什么；怎么写由预设里的块说）。
   * 预设里有"主动消息"这一块就填在那儿；没有或关着时也放在历史前，让模型知道这次是她先开口
   */
  quiet?: string;
  /** 哪个功能在调用：决定用哪个用途的预设、请求体里写谁的模型；默认主对话 */
  agent?: AgentRole;
  /**
   * 一起做事时这一次要做的事：name 是任务名（预设里触发条件写了它的块只在这时发送），
   * input 是程序写的这一次的输入（只放数据，填进"场景任务"块；预设里没有这一块时也放在历史前）
   */
  task?: { name: string; input: string };
  /** 指定按哪个用途选预设（语音通话用 call）；不给时按主动消息 / 场景 / 对话预设 */
  use?: PresetUseId;
  /** 重新生成的那条回复：沿用它原来用的记忆 */
  targetId?: string;
  /** 这一次另外打开的触发条件（心跳连着玩具、指令由她自己写时是 device-inline）：块写了它就发送 */
  flags?: string[];
  /** 本轮实际执行的标签（副对话接管卡片时，主对话只保留实时表情等） */
  allowedTags?: ControlTagKind[];
  /** 已交给副对话的标签，让主对话知道这些动作由另一条请求决定 */
  delegatedTags?: ControlTagKind[];
}

/**
 * 拼这一轮的提示词。history 是要发出去的聊天记录（从旧到新，最后一条通常是你刚发的）。
 * 预设按用途选：语音通话用"语音通话"选的预设，主动消息用"主动消息"预设，在场景页里一起做某件事时用那件事的功能预设，聊天里用这个角色的对话预设。
 */
export function assembleForChat(chat: Chat, character: Character, history: Message[], opts: ChatAssembleOptions = {}): ChatPrompt {
  const lib = useLibraryStore();
  const { preset, use } = presetForTurn(chat, character, opts.agent, opts.use);
  if (!preset) throw new MissingPresetError(use === 'chat' ? '对话' : useLabel(use));
  const persona = personaOf(chat);
  const model = modelOf(opts.agent);
  const books = character.lorebookIds.map((id) => lib.lorebookById(id)).filter((b) => !!b);
  const lastUser = [...history].reverse().find((m) => m.role === 'user');
  const prevUser = [...history].reverse().filter((m) => m.role === 'user')[1];
  const now = opts.now ?? new Date();
  const timeZone = useEnvironmentStore().settings.timezone;
  const proactive = opts.agent === 'proactive' || opts.type === 'quiet';
  const userText = lastUser ? messageToText(lastUser, character, persona.name) : '';
  const recall: RecallForTurn = proactive ? { lines: [], snapshot: undefined, added: 0, reused: false } : recallForTurn(chat, character, userText, opts.targetId);
  const t = textFn(textsFor(preset));
  const app = appFills(chat, character, history, now, timeZone, recall, proactive, userText, t);
  if (opts.allowedTags) app.sceneRules = {
    content: tagsLine(getScene(chat.currentScene ?? 'free'), character, t, opts.allowedTags),
    source: '本轮实际可用的标签',
  };
  if (opts.delegatedTags?.length) app.sceneRules!.content += `\n${t('tags.delegated', { tags: opts.delegatedTags })}`;
  // 家务和健康：你人设里开着的系统今天的情况（都没开时没有这一块）
  const flags: string[] = [...lifeFlags(persona), ...(opts.flags ?? [])];
  const home = homeBlock(persona, t);
  if (home) app.home = home;
  if (opts.quiet) app.proactive = { content: opts.quiet, source: `主动消息：这一次要${characterPronoun(character)}做的事` };
  if (opts.task) app.sceneTask = { content: opts.task.input, source: `场景任务：${opts.task.name}` };
  // 聊天记录：按消息设置的发送条数截取；预设中"仅格式提示词"的正则按深度执行（世界书扫描修改后的文本）
  // "已总结的消息不发送给 AI"：总结覆盖到的那条之前的不发（提示词里用时间线和取到的记忆代替）
  const msgSettings = useMessageSettingsStore();
  const last = msgSettings.sendCount();
  const sendable = msgSettings.settings.dropSummarized ? afterSummarized(history, chat.summaryUntilMessageId) : history;
  const turnStats = { total: 0, dropped: 0, regexed: 0 };
  const turns = toTurns(sendable, character, persona.name, { last, regex: preset.regex, stats: turnStats });
  const loreHistory = toTurns(history, character, persona.name, { regex: preset.regex });
  const result = assemblePrompt({
    preset,
    character,
    user: { name: persona.name, description: persona.description },
    lorebooks: books,
    history: turns,
    loreHistory,
    chatLength: history.filter((m) => !m.deleted && !m.meta.error && !m.meta.interrupted).length,
    app,
    type: opts.type,
    now,
    timeZone,
    idleMs: lastUser && prevUser ? lastUser.createdAt - prevUser.createdAt : null,
    vars: chat.vars,
    loreState: chat.loreState,
    dryRun: opts.dryRun,
    model,
    task: opts.task?.name,
    // 程序块按场景写的内容、上一次注入的内容：按这一轮的用途（chat、scene:meal、proactive……），场景里的某一步再细一层
    context: { keys: opts.task?.name ? [`${use}|${opts.task.name}`, use] : [use], who: character.name },
    flags,
  });
  const request = buildChatRequest(result, preset, model);
  // 和 AgentSystem 相同：API 页面明确选了强度就覆盖预设；自动时保留预设值。
  const effort = openaiReasoningEffort(useAiStore().routeOf(opts.agent ?? 'main').params?.reasoningEffort);
  if (effort) request.reasoning_effort = effort;
  return { ...result, preset, use, persona, request, turnStats: { ...turnStats, last, summarized: history.length - sendable.length }, recall };
}

/** 发给模型的消息（去掉来源说明） */
export function toLLMMessages(p: ChatPrompt): LLMChatMessage[] {
  return p.messages.map(({ role, content, name }) => (name ? { role, content, name } : { role, content }));
}
