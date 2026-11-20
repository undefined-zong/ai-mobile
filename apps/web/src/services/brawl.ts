import { readBrawlFighter, type BrawlFighter, type TextFn } from '@app/shared';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';
import { sceneText } from './prompt';
import { usePersonaStore } from '@/stores/personas';

/** 参战者的材料（JSON；键名和身份的写法在大乱斗预设的程序文字 brawl.key.* 里） */
export function brawlMaterial(fighter: BrawlFighter, t: TextFn): string {
  const k = (name: string) => t(`brawl.key.${name}`);
  if (fighter.ownerKind === 'persona') {
    const p = usePersonaStore().byId(fighter.ownerId);
    return JSON.stringify({ [k('identity')]: t('brawl.identity.persona'), [k('name')]: p?.name ?? fighter.name, [k('setting')]: p?.description ?? '' });
  }
  const c = useCharacterStore().byId(fighter.ownerId);
  if (!c) return fighter.name;
  const lib = useLibraryStore();
  return JSON.stringify({
    [k('identity')]: t('brawl.identity.character'), [k('name')]: c.name, [k('description')]: c.card.description, [k('personality')]: c.card.personality,
    [k('scenario')]: c.card.scenario, [k('tags')]: c.card.tags, [k('looks')]: c.appearanceTags,
    [k('lore')]: c.lorebookIds.flatMap(id => lib.lorebookById(id)?.entries.filter(e => e.enabled).map(e => t('brawl.loreEntry', { title: e.comment, content: e.content })) ?? []).join('\n').slice(0,24000),
  });
}

/** 大乱斗预设的程序文字 */
export function brawlText(): TextFn {
  return sceneText('game-brawl');
}

export async function generateBrawlFighter(chatId: string, base: BrawlFighter, wish: string, signal: AbortSignal) {
  return useChatStore().sceneJson(chatId, {
    name: 'brawl-make',
    input: brawlText()('brawl.make', { material: brawlMaterial(base, brawlText()), current: JSON.stringify(base), wish: wish.trim() }),
  }, value => {
    if (!value || typeof value !== 'object' || !Array.isArray((value as { skills?: unknown }).skills)) return null;
    return { ...readBrawlFighter(value, base), source: 'ai' as const, updatedAt: Date.now() };
  }, signal, { use: 'game-brawl' });
}
