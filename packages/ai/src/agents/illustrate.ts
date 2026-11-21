import type { ImageRequest, ImageVibe } from '../image/types.ts';
import { buildImagePromptMessages, fallbackImagePrompt, imagePromptRetry, parseImagePrompt, toImageRequest, wantsUserVibe, type ImagePromptInput, type ImagePromptOutput } from './imagePrompt.ts';
import type { AgentCallOptions, AgentSystem, CallMeta } from './system.ts';
import { samplerRequest, type TaskPreset } from './taskPreset.ts';

/**
 * 配图流水线（设计文档 §4.1：[cg:] → 生图提示词智能体 → 生图智能体 → 相册）。
 * 和 sleep-together 的生图轮次一样分阶段报告进度（写提示词 → 出图 → 完成），界面据此显示"正在构思""正在画"。
 * 生图提示词智能体按"生图"预设输出 image###tags###（imagePrompt.ts 的 parseImagePrompt 读），出图的正向、负面、画幅按预设里的块拼；
 * 没分配智能体或者没有预设时，image### 就是画面描述原文。
 * "你"的立绘有 Vibe 时：预设里 vibe:<类型> 的块对上这次的类型才带上。
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
    /** 写 tags、拼出图提示词用的"生图"预设；没有时 image### 就是画面描述原文 */
    preset?: TaskPreset | null;
    /** "你"的立绘的 Vibe（用到时才取：第一次要编码）；带不带按预设里 vibe:<类型> 的块 */
    userVibes?: () => Promise<ImageVibe[]>;
  } = {},
): Promise<IllustrateResult> {
  opts.onStage?.('prompt');
  let prompt: ImagePromptOutput;
  let promptBy: IllustrateResult['promptBy'] = null;
  const preset = opts.preset;
  if (system.isLive('imagePrompt') && preset) {
    const retry = imagePromptRetry(preset, input);
    const { value, result } = await system.text('imagePrompt', { messages: buildImagePromptMessages(input, preset), ...samplerRequest(preset.sampler) }, parseImagePrompt, retry, { ...opts, retries: retry ? 1 : 0 });
    prompt = value;
    promptBy = result;
  } else {
    prompt = fallbackImagePrompt(input);
  }
  if (!prompt.caption) prompt.caption = (input.caption ?? '').slice(0, 30);
  const request = toImageRequest(prompt, input, preset, opts.seed);
  if (opts.userVibes && wantsUserVibe(preset, input)) {
    const vibes = await opts.userVibes();
    if (vibes.length) request.vibes = vibes;
  }
  opts.onStage?.('image');
  const image = await system.draw(request, opts);
  return { prompt, request, image, promptBy };
}
