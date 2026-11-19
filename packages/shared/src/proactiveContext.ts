import type { Message, MessagePart } from './types/chat.ts';
import type { ProactiveContext } from './types/hub.ts';

function partText(p: MessagePart): string {
  if (p.type === 'voice') return p.transcript;
  if (p.type === 'image' && !p.photo) return `[图片：${p.caption}]`;
  if (p.type === 'chore') return p.status === 'done' ? `[家务：${p.name} 做完了]` : `[家务：${p.name} 说晚点再做（拖了 ${p.later ?? 1} 次）]`;
  if (p.type === 'workout') return `[运动记录：${p.mode === 'plan' && p.plan ? `照计划练「${p.plan.title}」` : p.sport} ${Math.max(1, Math.round(p.durationSec / 60))} 分钟${p.kcal ? `，约 ${p.kcal} 千卡` : ''}]`;
  return '';
}

/** 云端实际使用的消息内容：文字、语音转写和图片描述，不传本机媒体。 */
export function proactiveMessageText(m: Pick<Message, 'text' | 'parts'>): string {
  const base = m.text || m.parts.map(partText).join(' ');
  const photos = m.parts.flatMap((p) => (p.type === 'image' && p.photo ? [p.seen ? `[照片：${p.seen}]` : '[照片]'] : []));
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
      id: m.id, chatId: m.chatId, role: m.role, text: proactiveMessageText(m), parts: [],
      createdAt: m.createdAt, deleted: m.deleted, proactive: m.proactive, read: m.read,
    })),
    environment: { timezone: environment.timezone, wakeTime: environment.wakeTime, sleepTime: environment.sleepTime, meals: environment.meals },
  };
}
