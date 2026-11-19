import type { ImageRequest, ImageVibe } from '../image/types.ts';
import { buildImagePromptMessages, fallbackImagePrompt, hasUserInFrame, IMAGE_PROMPT_RETRY, parseImagePrompt, toImageRequest, type ImagePromptInput, type ImagePromptOutput } from './imagePrompt.ts';
import type { AgentCallOptions, AgentSystem, CallMeta } from './system.ts';
import { samplerRequest, type TaskPreset } from './taskPreset.ts';

/**
 * 配图流水线（设计文档 §4.1：[cg:] → 生图提示词智能体 → 生图智能体 → 相册）。
 * 和 sleep-together 的生图轮次一样分阶段报告进度（写提示词 → 出图 → 完成），界面据此显示"正在构思""正在画"。
 * 生图提示词智能体按"生图"预设输出 image###tags###（imagePrompt.ts 的 parseImagePrompt 读），标题、画幅、外观由程序拼；没分配时用外观 tags + 画面描述原文。
 * "你"的立绘有 Vibe 时：画面里真的有你（两个人同框，或者画的就是你）才带上，只画她时不带。
 */

export type IllustrateStage = 'prompt' | 'image';

export interface IllustrateResult {
  prompt: ImagePromptOutput;
  /** 实际发给生图接口的请求（相册"用同样参数重画"） */
  request: ImageRequest;
  image: Awaited<ReturnType<AgentSystem['draw']>>;
  /** 写提示词用的模型；没用智能体时为 null */
  promptBy: (CallMeta & { model: string }) | null;
}

export async function illustrate(
  system: AgentSystem,
  input: ImagePromptInput,
  opts: AgentCallOptions & {
    seed?: number;
    model?: string;
    onStage?(stage: IllustrateStage): void;
    /** 写 tags 用的"生图"预设；没有时直接用外观 tags + 画面描述 */
    preset?: TaskPreset | null;
    /** "你"的立绘的 Vibe（用到时才取：第一次要编码）；userIsSubject：画的就是你，总是带上 */
    userVibes?: () => Promise<ImageVibe[]>;
    userIsSubject?: boolean;
  } = {},
): Promise<IllustrateResult> {
  opts.onStage?.('prompt');
  let prompt: ImagePromptOutput;
  let promptBy: IllustrateResult['promptBy'] = null;
  const preset = opts.preset;
  if (system.isLive('imagePrompt') && preset) {
    const { value, result } = await system.text('imagePrompt', { messages: buildImagePromptMessages(input, preset), ...samplerRequest(preset.sampler) }, parseImagePrompt, IMAGE_PROMPT_RETRY, opts);
    prompt = value;
    promptBy = result;
  } else {
    prompt = fallbackImagePrompt(input);
  }
  if (!prompt.caption) prompt.caption = input.caption.slice(0, 30);
  const request = toImageRequest(prompt, input, opts.seed);
  if (opts.userVibes && (opts.userIsSubject || hasUserInFrame(prompt, input))) {
    const vibes = await opts.userVibes();
    if (vibes.length) request.vibes = vibes;
  }
  opts.onStage?.('image');
  const image = await system.draw(request, opts);
  return { prompt, request, image, promptBy };
}
