import { textFn, type TextFn } from './programText.ts';
import type { Message, MessagePart } from './types/chat.ts';
import type { ProactiveContext } from './types/hub.ts';

/** 卡片写成一句（程序文字 history.*，和手机上聊天记录里的一样） */
function partText(p: MessagePart, t: TextFn): string {
  const card = (body: string) => t('history.card', { body });
  if (p.type === 'voice') return p.transcript;
  if (p.type === 'image' && !p.photo) return card(t('history.image', { title: p.caption }));
  if (p.type === 'chore') return card(p.status === 'done' ? t('history.chore.done', { name: p.name, minutes: null, later: null, note: null }) : t('history.chore.later', { name: p.name, later: p.later ?? 1 }));
  if (p.type === 'workout') return card(t('history.workout.short', { title: p.mode === 'plan' && p.plan ? t('event.workout.plan', { title: p.plan.title }) : p.sport, minutes: Math.max(1, Math.round(p.durationSec / 60)), kcal: p.kcal || null }));
  return '';
}

/** 云端实际使用的消息内容：文字、语音转写和图片描述，不传本机媒体。t 是主动消息预设的程序文字 */
export function proactiveMessageText(m: Pick<Message, 'text' | 'parts'>, t: TextFn): string {
  const base = m.text || m.parts.map((p) => partText(p, t)).join(' ');
  const photos = m.parts.flatMap((p) => (p.type === 'image' && p.photo ? [t('history.card', { body: p.seen ? t('history.photo', { seen: p.seen }) : t('history.photoPlain') })] : []));
  return [base.trim(), ...photos].filter(Boolean).join(' ');
}

/**
 * 上传生成和排期需要的快照，不把角色卡附件、备选回复、媒体和导出用的冗余字段塞进 D1。
 * 正文、世界书条目、预设块及其运行参数原样保留；不改本机记录或多设备同步的数据。
 */
export function packProactiveContext(input: ProactiveContext): ProactiveContext {
  const { character: c, chat, persona, preset, environment } = input;
  const { description, personality, scenario, mesExample, systemPrompt, postHistoryInstructions, characterVersion, extensions } = c.card;
  const { assistant_prefill, reasoning_effort, show_thoughts, custom_prompt_post_processing } = preset?.extra ?? {};
  return {
    ...input,
    character: {
      id: c.id, name: c.name, pronoun: c.pronoun, proactive: c.proactive, relationship: c.relationship,
      card: { description, personality, scenario, mesExample, systemPrompt, postHistoryInstructions, characterVersion,
        extensions: { depth_prompt: extensions.depth_prompt } },
    },
    chat: { id: chat.id, characterId: chat.characterId, lastMessageAt: chat.lastMessageAt, vars: chat.vars, loreState: chat.loreState,
      ...(input.memoryBlocks ? {} : { summaries: chat.summaries }) },
    persona: { name: persona.name, description: persona.description },
    preset: preset ? {
      ...preset,
      blocks: preset.blocks.map(({ extra: _extra, ...block }) => block),
      extra: { assistant_prefill, reasoning_effort, show_thoughts, custom_prompt_post_processing },
    } : null,
    lorebooks: input.lorebooks.map(({ extra: _extra, entries, ...book }) => ({
      ...book, entries: entries.map(({ extra: _entryExtra, ...entry }) => entry),
    })),
    history: input.history.map((m) => ({
      id: m.id, chatId: m.chatId, role: m.role, text: proactiveMessageText(m, textFn(preset?.texts)), parts: [],
      createdAt: m.createdAt, deleted: m.deleted, proactive: m.proactive, read: m.read,
    })),
    environment: { timezone: environment.timezone, wakeTime: environment.wakeTime, sleepTime: environment.sleepTime, meals: environment.meals },
  };
}
