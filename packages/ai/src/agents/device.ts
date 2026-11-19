import { assembleTaskPrompt } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 控制指令智能体（设计文档 §9.14，心跳）：按她刚说的那句话、连着的玩具能做什么，写玩具的控制指令。
 * 提示词（任务、规则、输出格式）全在"控制指令"预设里；这里只把这一次的输入填进程序填充块。
 * 输出是她这句话照抄一遍、要变的地方插 <device>…</device>，用 @app/shared 的 placeDeviceTags 放回原话的位置上，读到、念到那里时执行；
 * 强度照 0–100 写，每个头的上限由播放的那一边按比例换算。
 */

/** 控制指令预设的程序填充块（TASK_MARKERS.device） */
export type DeviceFill = 'deviceToys' | 'deviceLimits' | 'deviceNow' | 'deviceRecent' | 'deviceLine';

export interface DevicePromptInput {
  /** 你的名字（预设里的 {{user}}） */
  userName: string;
  /** 她的名字（预设里的 {{char}}） */
  characterName: string;
  pronoun?: string;
  fills: Partial<Record<DeviceFill, string>>;
}

export function buildDeviceMessages(input: DevicePromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { pronoun: input.pronoun, char: input.characterName, user: input.userName } }).messages;
}
