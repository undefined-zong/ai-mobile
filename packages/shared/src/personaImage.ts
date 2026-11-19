import type { PersonaImage, PersonaVibe } from './types/character.ts';

/** 立绘 Vibe 的默认值（NovelAI 网页版的默认强度和信息提取量） */
export const DEFAULT_PERSONA_VIBE: PersonaVibe = { enabled: true, strength: 0.6, informationExtracted: 1 };

const unit = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** 读进来的生图设置补齐字段 */
export function normalizePersonaImage(raw: Partial<PersonaImage> | null | undefined): PersonaImage {
  const v: Partial<PersonaVibe> = raw?.vibe ?? {};
  return {
    appearanceTags: str(raw?.appearanceTags),
    negativeTags: str(raw?.negativeTags),
    outfitTags: str(raw?.outfitTags),
    ...(raw?.portrait?.assetKey ? { portrait: raw.portrait } : {}),
    vibe: {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : DEFAULT_PERSONA_VIBE.enabled,
      strength: unit(v.strength, DEFAULT_PERSONA_VIBE.strength),
      informationExtracted: unit(v.informationExtracted, DEFAULT_PERSONA_VIBE.informationExtracted),
    },
  };
}
