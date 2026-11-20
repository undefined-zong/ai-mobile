import { characterPronoun } from '@app/shared';
import { substituteMacros, type Character, type TextFn } from '@app/shared';
import { useLibraryStore } from '@/stores/library';

/**
 * 交给任务类智能体（节律建世界、立绘写外观 tags）的角色材料：角色卡的几项，加上作者备注和绑定的世界书。
 */

/** 名字、称呼、描述、性格、场景 */
export function characterLines(c: Character, user: string, t: TextFn): string {
  const sub = (x: string) => substituteMacros(x, { char: c.name, user, pronoun: c.pronoun }).trim();
  return t('social.character', {
    name: c.name,
    pronoun: characterPronoun(c),
    description: c.card.description ? sub(c.card.description) : '',
    personality: c.card.personality ? sub(c.card.personality) : '',
    scenario: c.card.scenario ? sub(c.card.scenario) : '',
  });
}

/** 角色卡的作者备注和绑定的世界书（开着的条目），太长时截断 */
export function sourceLines(c: Character, user: string, t: TextFn, budget = 9000): string {
  const lib = useLibraryStore();
  const parts: string[] = [];
  let left = budget;
  if (c.card.creatorNotes.trim()) parts.push(t('source.notes', { notes: c.card.creatorNotes.trim().slice(0, 600) }));
  for (const id of c.lorebookIds) {
    const book = lib.lorebookById(id);
    if (!book) continue;
    for (const e of book.entries) {
      if (!e.enabled || !e.content.trim() || left <= 0) continue;
      const title = e.comment || e.keys.slice(0, 3).join('、');
      const text = substituteMacros(e.content, { char: c.name, user, pronoun: c.pronoun }).trim().slice(0, Math.min(1200, left));
      left -= text.length;
      parts.push(t('source.entry', { title, text }));
    }
  }
  return parts.length ? t('source.block', { parts }) : '';
}
