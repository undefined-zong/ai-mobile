import type { ImageStyle } from '@app/shared';
import type { ImageRequest } from './types.ts';

/**
 * 生图风格：采样器、步数、scale 这些出图参数。
 * 提示词里的词（画风、质量词、负面词）都在预设里（生图预设的「最终提示词」「最终负面词」，立绘预设的「画法」「负面」），这里不往提示词里加任何词。
 */
export const DEFAULT_IMAGE_STYLE: ImageStyle = {};

/** 把生图风格的出图参数套到请求上：请求里写了的参数优先；不改提示词和负面词 */
export function applyImageStyle(req: ImageRequest, style?: ImageStyle): ImageRequest {
  if (!style) return req;
  return {
    ...req,
    sampler: req.sampler ?? style.sampler,
    noiseSchedule: req.noiseSchedule ?? style.schedule,
    steps: req.steps ?? style.steps,
    scale: req.scale ?? style.scale,
    varietyBoost: req.varietyBoost ?? style.varietyBoost,
  };
}
