import { canVibe, NOVELAI_DEFAULT_MODEL, NOVELAI_REFERENCE_CANVASES, supportsVibeTransfer, type ImageVibe } from '@app/ai';
import { base64Decode, base64Encode, type Persona } from '@app/shared';
import { assetUrl, putAsset } from './assets';
import { useAiStore } from '@/stores/ai';
import { usePersonaStore } from '@/stores/personas';
import { referenceImage } from '@/utils/spriteImage';

/**
 * "你"的立绘的 Vibe Transfer：第一次用到时编码一次（NovelAI 扣 2 点），编码存进素材库、记在立绘上，之后一直用它，
 * 你入画的图长相都跟立绘一样。编码只对一个模型、一个信息提取量有效：换了模型或改了信息提取量时再编码一次。
 * 生图不是 NovelAI、模型不支持（V5）、没有立绘或者关了时不带（照样画，只是长相只靠外观 tags）。
 */

async function assetBlob(key: string): Promise<Blob | null> {
  const url = await assetUrl(key);
  return url ? (await fetch(url)).blob() : null;
}

/** 这次出图会用的生图连接和模型（model：这一次换的模型） */
function imageTarget(model?: string): { model: string } | null {
  try {
    const ep = useAiStore().system.router.attempts('image', { model })[0]?.endpoint;
    if (!ep || !canVibe(ep.kind)) return null;
    const m = ep.model || NOVELAI_DEFAULT_MODEL;
    return supportsVibeTransfer(m) ? { model: m } : null;
  } catch {
    return null;
  }
}

export async function personaVibes(p: Persona, opts: { model?: string; signal?: AbortSignal } = {}): Promise<ImageVibe[]> {
  const img = p.image;
  const portrait = img?.portrait;
  if (!img?.vibe.enabled || !portrait) return [];
  const target = imageTarget(opts.model);
  if (!target) return [];
  const { strength, informationExtracted } = img.vibe;
  const cached = portrait.vibes?.find((v) => v.model === target.model && v.informationExtracted === informationExtracted);
  const saved = cached ? await assetBlob(cached.assetKey) : null;
  if (saved?.size) return [{ encoding: base64Encode(new Uint8Array(await saved.arrayBuffer())), strength, informationExtracted }];
  const source = await assetBlob(portrait.assetKey);
  if (!source) return [];
  const image = await referenceImage(source, NOVELAI_REFERENCE_CANVASES);
  const r = await useAiStore().system.encodeVibe({ image, informationExtracted, model: target.model, signal: opts.signal });
  const assetKey = await putAsset(base64Decode(r.encoding) as Uint8Array<ArrayBuffer>, 'application/octet-stream');
  // await 之后立绘可能换了：只记在还是这张的立绘上
  if (p.image?.portrait === portrait) {
    portrait.vibes = [...(portrait.vibes ?? []).filter((v) => !(v.model === r.model && v.informationExtracted === informationExtracted)), { model: r.model, informationExtracted, assetKey }];
    usePersonaStore().touch(p);
  }
  return [{ encoding: r.encoding, strength, informationExtracted }];
}
