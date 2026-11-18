import type { Character } from '@app/shared';

/**
 * 角色的像素小人：纸娃娃（身体 + 发型 + 眼睛 + 衣服），全部从角色数据里取，不用画图。
 * - 发色、发型、瞳色、肤色：先看 NovelAI 外观 tags（brown hair、twintails、blue eyes、dark skin…），没写的用占位发色；
 * - 衣服颜色：先看今天 / 日常那套衣服的 tags 里的颜色词，没有就用角色主题色。
 */
export type HairStyle = 'long' | 'short' | 'twintails' | 'ponytail';

export interface SpriteLook {
  hair: string;
  style: HairStyle;
  eyes: string;
  skin: string;
  outfit: string;
}

const COLORS: [RegExp, string][] = [
  [/\b(silver|white|platinum)\b/, '#dfe3ec'],
  [/\b(grey|gray)\b/, '#9aa0aa'],
  [/\bblack\b/, '#2a2430'],
  [/\bdark brown\b/, '#4b3329'],
  [/\blight brown\b/, '#a37552'],
  [/\bbrown\b/, '#6b4a3a'],
  [/\b(blonde|blond|golden|yellow)\b/, '#e8c56e'],
  [/\b(orange|ginger)\b/, '#e8894a'],
  [/\bred\b/, '#b8433c'],
  [/\bpink\b/, '#f2a2bf'],
  [/\b(light blue|sky blue)\b/, '#9cc8ef'],
  [/\b(dark blue|navy)\b/, '#2f4f8a'],
  [/\bblue\b/, '#4f78c8'],
  [/\b(aqua|teal|cyan)\b/, '#4fc3c3'],
  [/\bgreen\b/, '#5aa06a'],
  [/\b(purple|violet|lavender)\b/, '#8a63b8'],
  [/\bbeige|cream\b/, '#e8dcc2'],
];

function colorIn(text: string): string | null {
  for (const [re, hex] of COLORS) if (re.test(text)) return hex;
  return null;
}

/** "xxx hair" / "xxx eyes" 前面那几个词 */
function before(tags: string, noun: string): string | null {
  const m = tags.match(new RegExp(`([a-z ]{0,24})\\b${noun}\\b`));
  return m ? colorIn(m[1]!) : null;
}

const CLOTHES = /(dress|shirt|blouse|sweater|cardigan|hoodie|jacket|coat|kimono|robe|hanfu|uniform|t-shirt|vest|suit|armor|cape|tracksuit|track suit)/;

export function spriteLookOf(c: Character, outfitTags = ''): SpriteLook {
  const tags = `${c.appearanceTags ?? ''}`.toLowerCase();
  const style: HairStyle = /twintails|twin tails|pigtails/.test(tags)
    ? 'twintails'
    : /ponytail/.test(tags)
      ? 'ponytail'
      : /short hair|bob cut|buzz cut|crew cut/.test(tags)
        ? 'short'
        : /long hair|very long hair|medium hair/.test(tags)
          ? 'long'
          : c.pronoun === '他'
            ? 'short'
            : 'long';
  let outfit: string | null = null;
  for (const part of `${outfitTags},${tags}`.toLowerCase().split(',')) {
    if (CLOTHES.test(part)) {
      outfit = colorIn(part);
      if (outfit) break;
    }
  }
  return {
    hair: before(tags, 'hair') ?? c.hairColor ?? '#3b2a35',
    style,
    eyes: before(tags, 'eyes') ?? '#2a2230',
    skin: /dark skin|tan(ned)? skin/.test(tags) ? '#c99572' : '#f7d9c4',
    outfit: outfit ?? c.accent ?? '#f5b8a6',
  };
}
