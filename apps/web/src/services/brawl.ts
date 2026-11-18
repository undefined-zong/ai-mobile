import { readBrawlFighter, type BrawlFighter } from '@app/shared';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { usePersonaStore } from '@/stores/personas';

export function brawlMaterial(fighter: BrawlFighter): string {
  if (fighter.ownerKind === 'persona') {
    const p = usePersonaStore().byId(fighter.ownerId);
    return JSON.stringify({ 身份: '用户操控的人设', 名字: p?.name ?? fighter.name, 设定: p?.description ?? '' });
  }
  const c = useCharacterStore().byId(fighter.ownerId);
  if (!c) return fighter.name;
  const lib = useLibraryStore();
  return JSON.stringify({
    身份: '角色', 名字: c.name, 描述: c.card.description, 性格: c.card.personality,
    场景: c.card.scenario, 标签: c.card.tags, 外观: c.appearanceTags,
    世界书: c.lorebookIds.flatMap(id => lib.lorebookById(id)?.entries.filter(e => e.enabled).map(e => `${e.comment}：${e.content}`) ?? []).join('\n').slice(0,24000),
  });
}

export async function generateBrawlFighter(chatId: string, base: BrawlFighter, wish: string, signal: AbortSignal) {
  return useChatStore().sceneJson(chatId, {
    name: 'brawl-make',
    input: `这次只为下面这个参战者生成战斗档案，不要把当前聊天角色的能力套给其他人。\n参战者：${brawlMaterial(base)}\n现有战斗档案：${JSON.stringify(base)}\n用户想要：${wish.trim() || '贴合角色设定，招式各有用途'}`,
  }, value => {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { skills?: unknown }).skills)) return null;
    return { ...readBrawlFighter(value, base), source: 'ai' as const, updatedAt: Date.now() };
  }, signal, { use: 'game-brawl' });
}
