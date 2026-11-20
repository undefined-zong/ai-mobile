import type { Character } from '@app/shared';
import { useChatStore } from '@/stores/chat';
import { useMemoryStore } from '@/stores/memory';

/**
 * 回忆页的时间线（全是这个角色真的记忆，不放演示数据）：
 * - 相识：按最早的一条记忆定（事实记忆发生的时间、故事片段、聊天梗概里最早的那个）；一条记忆都没有时按第一条聊天，再没有按角色卡导入的时间；
 * - 一路上的大事：关系里程碑、重要的（或置顶的）事件和约定、标了"重要"的故事片段、总结记下的关系变化。
 */

export interface TimelineNode {
  id: string;
  at: number;
  icon: string;
  tint: string;
  title: string;
  desc: string;
  kind: 'met' | 'relationship' | 'event' | 'promise' | 'slice' | 'milestone';
  /** 点了回到原话：聊天里那条消息 */
  messageId?: string;
}

/** 最早的一条记忆：什么时候、写的是什么 */
export function firstMemory(characterId: string): { at: number; text: string } | null {
  const mem = useMemoryStore();
  let best: { at: number; text: string } | null = null;
  const consider = (at: number | null | undefined, text: string) => {
    if (typeof at === 'number' && at > 0 && (!best || at < best.at)) best = { at, text };
  };
  for (const m of mem.memoriesOf(characterId)) consider(m.happenedAt ?? m.createdAt, m.content);
  for (const s of mem.slicesOf(characterId)) consider(s.startAt, s.title);
  const chat = useChatStore().chatOfCharacter(characterId);
  if (chat) for (const s of mem.summariesOf(chat.id)) consider(s.fromAt, s.text);
  return best;
}

/** 相识的时间：最早的那条记忆；没有记忆时是第一条聊天，再没有是角色卡里记的 */
export function metAtOf(character: Character): number {
  const first = firstMemory(character.id);
  if (first) return first.at;
  const chat = useChatStore().chatOfCharacter(character.id);
  const firstMessage = chat ? useChatStore().list(chat.id)[0]?.createdAt : undefined;
  return firstMessage ?? character.relationship.metAt;
}

const clip = (text: string, n: number) => {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/** 这个角色的时间线（新的在前，"相识"在最后） */
export function timelineNodes(character: Character): TimelineNode[] {
  const mem = useMemoryStore();
  const nodes: TimelineNode[] = [];
  for (const m of mem.memoriesOf(character.id)) {
    if (m.status === 'superseded') continue;
    const at = m.happenedAt ?? m.createdAt;
    const big = m.pinned || m.importance >= 7;
    if (m.type === 'relationship') nodes.push({ id: `m:${m.id}`, at, icon: 'i-lucide-sparkles', tint: '#f5b8a6', title: clip(m.content, 40), desc: '关系里程碑', kind: 'relationship', messageId: m.sourceMessageIds[0] });
    else if (m.type === 'event' && big) nodes.push({ id: `m:${m.id}`, at, icon: 'i-lucide-calendar-heart', tint: '#7fd6a4', title: clip(m.content, 40), desc: '一起经历的事', kind: 'event', messageId: m.sourceMessageIds[0] });
    else if (m.type === 'promise' && big) nodes.push({ id: `m:${m.id}`, at, icon: 'i-lucide-handshake', tint: '#f39cc0', title: clip(m.content, 40), desc: m.status === 'active' ? '约定' : '约定 · 已经过去了', kind: 'promise', messageId: m.sourceMessageIds[0] });
  }
  for (const s of mem.slicesOf(character.id)) {
    if (!s.tags.important) continue;
    nodes.push({ id: `s:${s.id}`, at: s.startAt, icon: 'i-lucide-bookmark', tint: 'var(--accent)', title: clip(s.title, 40), desc: s.text !== s.title ? clip(s.text, 70) : [...s.tags.special, ...s.tags.mood].join(' · '), kind: 'slice', messageId: s.fromMessageId });
  }
  for (const [i, ms] of (character.relationship.milestones ?? []).entries()) {
    if (ms?.label && ms.at) nodes.push({ id: `ms:${i}`, at: ms.at, icon: 'i-lucide-flag', tint: '#b7a6f5', title: clip(ms.label, 40), desc: '关系变化', kind: 'milestone' });
  }
  // 同一件事记了好几处（记忆和片段）：只留一处
  const seen = new Set<string>();
  const unique = nodes
    .sort((a, b) => b.at - a.at)
    .filter((n) => {
      const key = n.title.replace(/[\s，。！？、,.!?…"“”'‘’]/g, '').slice(0, 16);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const first = firstMemory(character.id);
  const metAt = metAtOf(character);
  unique.push({
    id: 'met', at: metAt, icon: 'i-lucide-heart-handshake', tint: '#b9adce', title: '相识',
    desc: first ? `最早的记忆：${clip(first.text, 50)}` : '从第一次聊天开始',
    kind: 'met',
  });
  return unique;
}
