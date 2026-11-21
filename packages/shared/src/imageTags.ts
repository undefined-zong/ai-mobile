import type { Character } from './types/character.ts';

/**
 * 生图 tags 的小工具：前端和 Worker 共用（@app/ai 的生图提示词智能体也用这里的 joinTags）。
 */

/**
 * 生图提示词输出里的几段（"名字###内容###"，@app/ai 的 parseImagePrompt 读）：
 * image 画面的 tags（画几个人、画谁只看这一段）、negative 额外的负面 tags、size 画幅
 */
export const IMAGE_PROMPT_SECTIONS = ['image', 'negative', 'size'] as const;
/** image### / negative### 里把整体画面和每个人隔开的符号（NovelAI 网页版的写法） */
export const IMAGE_PROMPT_PERSON_SEPARATOR = '|';

/** 每一段写什么（写给助手看的说明，也是预设里输出格式的依据） */
export const IMAGE_PROMPT_SECTION_DOCS: Record<(typeof IMAGE_PROMPT_SECTIONS)[number], string> = {
  image: `画面的英文 tags（必须有），画几个人、画谁只看这一段；要分人物时用 ${IMAGE_PROMPT_PERSON_SEPARATOR} 隔开（第一段是整体画面：总人数、构图、场景、光线，后面每段一个人），或者写成 NovelAI 网页版那样：Scene Composition: 整体画面; Character 1 Prompt: 第一个人; Character 1 UC: 只针对第一个人的负面; Character 2 Prompt: …`,
  negative: `额外的负面 tags（可以不写）；image### 用了 ${IMAGE_PROMPT_PERSON_SEPARATOR} 时也按同样的顺序隔开，第一段是整体的，后面每段只针对那个人`,
  size: '画幅 portrait / landscape / square（可以不写：不写是竖图，程序给了画幅时照程序的）',
};

/**
 * NovelAI V4 起多人图的动作标签：写在 | 分开的人物那一段里，source# 发起、target# 承受、mutual# 相互（source#hug / target#hug）。
 * 只在 NovelAI 分人物写时有用；整体那一段、不分人物的接口用 plainActionTags 去掉前缀
 */
export const ACTION_TAG_PREFIXES = ['source', 'target', 'mutual'] as const;
const ACTION_PREFIX_RE = new RegExp(`^(?:${ACTION_TAG_PREFIXES.join('|')})#\\s*`, 'i');

/** 去掉动作标签的 source# / target# / mutual# 前缀（source#hug → hug） */
export function plainActionTags(tags: string): string {
  return joinTags(...tags.split(/[,，\n]/).map((t) => t.trim().replace(ACTION_PREFIX_RE, '')));
}

/** 逗号分隔的 tags 合并：去掉空项和重复项（不区分大小写），保留第一次出现的顺序 */
export function joinTags(...lists: (string | undefined | null)[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of (list ?? '').split(/[,，\n]/)) {
      const tag = raw.trim();
      const key = tag.toLowerCase();
      if (!tag || seen.has(key)) continue;
      seen.add(key);
      out.push(tag);
    }
  }
  return out.join(', ');
}

/** 人数一类的 tags（1girl、2boys、solo、no humans……）：NovelAI 建议写在最前面 */
const COUNT_TAG = /^(?:\d+\+?(?:girls?|boys?|others?)|solo|solo focus|no humans|multiple (?:girls|boys|others))$/i;

/** 把人数 tags 挑出来：{ lead: '1girl, solo', rest: '其余' }。拼最终提示词时放在角色 tag、外观 tags 前面 */
export function leadCountTags(tags: string): { lead: string; rest: string } {
  const lead: string[] = [];
  const rest: string[] = [];
  for (const raw of tags.split(/[,，\n]/)) {
    const t = raw.trim();
    if (!t) continue;
    (COUNT_TAG.test(t) ? lead : rest).push(t);
  }
  return { lead: lead.join(', '), rest: rest.join(', ') };
}

/** 打了"同人"标记、也填了角色 tag */
export function isFandom(c: Pick<Character, 'fandom'> | null | undefined): boolean {
  return !!c?.fandom?.enabled && !!c.fandom.characterTag.trim();
}

/**
 * 生图时她的长相（{{char_appearance}}，程序加在提示词最前面）：
 * - 同人：角色 tag + 作品 tag，再加你补的外观 tags（NovelAI 认不全的地方，可以不写）；
 * - 原创：外观 tags。
 */
export function imageAppearance(c: Pick<Character, 'fandom' | 'appearanceTags'>): string {
  if (!isFandom(c)) return joinTags(c.appearanceTags);
  return joinTags(c.fandom?.characterTag, c.fandom?.copyrightTag, c.appearanceTags);
}
