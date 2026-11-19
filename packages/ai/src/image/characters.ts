import { joinTags, plainActionTags } from '@app/shared';
import type { ImageRequest } from './types.ts';

/**
 * 不能分人物写的接口（OpenAI 兼容的、NovelAI V3）：把每个人的那一份并进整体提示词，
 * 动作标签去掉 source# / target# / mutual# 前缀（只有 NovelAI V4 起分人物写时认）。
 * 每个人自己的负面 tags 不并进来：放到整体上会管到所有人（她的 short hair、你的 long hair 会把两种发型都排除），只留整体的。
 * 没有分人物时原样返回
 */
export function flattenCharacters(req: Pick<ImageRequest, 'prompt' | 'negative' | 'characters'>): { prompt: string; negative: string } {
  const chars = req.characters ?? [];
  if (!chars.length) return { prompt: req.prompt, negative: req.negative ?? '' };
  return { prompt: plainActionTags(joinTags(req.prompt, ...chars.map((c) => c.prompt))), negative: req.negative ?? '' };
}
