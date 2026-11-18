export type CharacterPronoun = '他' | '她' | 'Ta';

/** 沿用角色选择；旧数据里的 TA 和未绑定角色的场合统一用 Ta。 */
export function characterPronoun(character?: { pronoun?: string } | null): CharacterPronoun {
  const p = character?.pronoun;
  return p === '他' || p === '她' ? p : 'Ta';
}

/** App 文案中的人称占位符；不改写角色卡、聊天记录等用户内容。 */
export function pronounText(text: string, character?: { pronoun?: string } | null): string {
  return text.replaceAll('{{pronoun}}', characterPronoun(character));
}
