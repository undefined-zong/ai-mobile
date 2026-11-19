import type { TextObfuscationMode, TextObfuscationSettings } from '@app/shared';
import { randomSeed } from '../core/util.ts';
import dictionary from './homophones.json';
import config from './obfuscation.json';
import type { ChatRequest } from './types.ts';

export const DEFAULT_TEXT_OBFUSCATION = config.defaults as TextObfuscationSettings;
export const TEXT_OBFUSCATION_MODES = config.modes as { value: TextObfuscationMode; label: string; description: string }[];
export const TEXT_OBFUSCATION_RANGES = config.ranges;

// 数据来自用户提供的 v8.0.8 参考文件；只取同音组和同音词，不执行其中的脚本。
const readings = new Map<string, string[]>();
for (const [syllable, chars] of Object.entries(dictionary.groups)) {
  for (const char of chars) readings.set(char, [...(readings.get(char) ?? []), syllable]);
}
const alternatives = new Map<string, string[]>();
for (const chars of Object.values(dictionary.groups)) {
  const unambiguous = Array.from(chars).filter((char) => readings.get(char)?.length === 1);
  for (const char of unambiguous) alternatives.set(char, unambiguous.filter((other) => other !== char));
}

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]!;
}

/** 同音转换只作用于中文正文；机器字段、代码和标签仍按原格式表达。 */
export function replaceHomophones(text: string, settings: TextObfuscationSettings): string {
  const words: Record<string, string> = { ...dictionary.words };
  for (const line of settings.customWords.split('\n')) {
    const split = line.indexOf('=');
    if (split > 0) words[line.slice(0, split).trim()] = line.slice(split + 1).trim();
  }
  const keys = Object.keys(words).filter((key) => key && words[key]).sort((a, b) => b.length - a.length);
  const probability = settings.homophoneRate / 100;
  // 这些部分属于文本中的格式约定，而不是待替换的自然语言。
  const segments = /```[\s\S]*?```|`[^`\n]*`|\{\{[\s\S]*?\}\}|<[^>\n]*>|https?:\/\/[^\s<>]+|"(?:\\.|[^"\\])*"(?=\s*:)|[\p{Script=Han}]+/gu;
  return text.replace(segments, (segment) => {
    if (!/^\p{Script=Han}/u.test(segment)) return segment;
    let out = '';
    for (let at = 0; at < segment.length;) {
      const word = keys.find((key) => segment.startsWith(key, at));
      if (word) {
        out += Math.random() < probability ? words[word] : word;
        at += word.length;
      } else {
        const char = String.fromCodePoint(segment.codePointAt(at)!);
        const candidates = alternatives.get(char);
        out += candidates?.length && Math.random() < probability ? pick(candidates) : char;
        at += char.length;
      }
    }
    return out;
  });
}

/** 预览和实际请求共用。只返回新字符串，不把混淆结果写回消息或预设。 */
export function obfuscateText(text: string, settings: TextObfuscationSettings): string {
  if (!text.trim()) return text;
  const homophone = settings.mode === 'homophone' || settings.mode === 'homophone-scatter';
  const converted = homophone ? replaceHomophones(text, settings) : text;
  if (settings.mode === 'homophone') return [settings.homophoneInstruction, converted].filter(Boolean).join('\n\n');

  const scatter = settings.mode === 'scatter' || settings.mode === 'homophone-scatter';
  const chars = typeof Intl.Segmenter === 'function'
    ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(converted), (part) => part.segment)
    : Array.from(converted);
  const fragments = scatter
    ? Array.from({ length: Math.ceil(chars.length / settings.chunkSize) }, (_, i) => chars.slice(i * settings.chunkSize, (i + 1) * settings.chunkSize).join(''))
    : [converted];
  const marker = `@${randomSeed().toString(36)}`;
  const templates = settings.carrier.split('\n');
  const slots = new Map<number, string[]>();
  for (let i = 0; i < settings.carrierLines; i++) {
    const position = settings.mode === 'wrap' ? fragments.length : Math.floor(Math.random() * (fragments.length + 1));
    const carrier = pick(templates).replaceAll('{noise}', () => randomSeed().toString(36)).replaceAll('{index}', () => String(i + 1));
    slots.set(position, [...(slots.get(position) ?? []), carrier]);
  }
  const lines = fragments.flatMap((fragment, i) => [...(slots.get(i) ?? []), `${marker} ${JSON.stringify(fragment)}`]);
  lines.push(...(slots.get(fragments.length) ?? []));
  const instruction = settings.instruction.replaceAll('{marker}', () => marker);
  return [instruction, homophone ? settings.homophoneInstruction : '', lines.join('\n')].filter(Boolean).join('\n\n');
}

/** 所有文本 AI（含生图提示词）在路由重试之前处理一次；图片和协议字段原样传递。 */
export function obfuscateChatRequest(req: ChatRequest, settings?: TextObfuscationSettings): ChatRequest {
  if (!settings?.enabled) return req;
  return {
    ...req,
    messages: req.messages.map((message) => ({
      ...message,
      content: typeof message.content === 'string'
        ? obfuscateText(message.content, settings)
        : message.content.map((part) => part.type === 'text' ? { ...part, text: obfuscateText(part.text, settings) } : part),
    })),
  };
}
