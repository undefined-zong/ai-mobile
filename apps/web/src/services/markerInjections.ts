import { onMarkerInjections, type MarkerInjection } from '@app/shared';
import { reactive } from 'vue';

/**
 * 每个预设里每个程序块上一次注入了什么：拼提示词时（对话、各个任务）记下来，预设编辑页里直接显示，
 * 程序块不再只写一句"内容由程序填"。存在本机（不同步），重开 App 还在；这一次内容为空时保留上一次的。
 */
export interface LastInjection extends Omit<MarkerInjection, 'identifier'> {
  at: number;
}

const KEY = 'marker-injections';
/** 一块最多留多少字（免得聊天很长时把本机存储撑满） */
const MAX_CHARS = 20000;

function load(): Record<string, Record<string, LastInjection>> {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, Record<string, LastInjection>>) : {};
  } catch {
    return {};
  }
}

const state = reactive<Record<string, Record<string, LastInjection>>>(load());
let timer: ReturnType<typeof setTimeout> | undefined;

function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      // 存不下就只留在内存里
    }
  }, 1000);
}

const clip = (s: string | undefined) => (s && s.length > MAX_CHARS ? `${s.slice(0, MAX_CHARS)}\n……（太长，只留了前 ${MAX_CHARS} 字）` : s);

onMarkerInjections((presetId, blocks) => {
  const at = Date.now();
  let changed = false;
  for (const { identifier, ...b } of blocks) {
    if (!b.content.trim() && !b.filled?.trim()) continue;
    (state[presetId] ??= {})[identifier] = { ...b, content: clip(b.content) ?? '', filled: clip(b.filled), at };
    changed = true;
  }
  if (changed) save();
});

export function lastInjection(presetId: string | undefined, identifier: string): LastInjection | undefined {
  return presetId ? state[presetId]?.[identifier] : undefined;
}
