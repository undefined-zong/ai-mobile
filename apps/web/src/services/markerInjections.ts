import { onMarkerInjections, type MarkerInjection } from '@app/shared';
import { reactive } from 'vue';

/**
 * 每个预设里每个程序块、在每个场景上一次注入了什么：拼提示词时（对话、各个任务）记下来，预设编辑页里按场景直接显示，
 * 程序块不再只写一句"内容由程序填"。场景是 MarkerContext.keys[0]（对话：chat、scene:meal、proactive……；任务：触发条件名），
 * 不分场景的任务记在 '' 下。存在本机（不同步），重开 App 还在；这一次内容为空时保留上一次的。
 */
export interface LastInjection extends Omit<MarkerInjection, 'identifier'> {
  at: number;
  /** 这一次是哪个角色的 */
  who?: string;
}

/** 预设 id → 块 identifier → 场景 → 上一次注入的内容 */
type State = Record<string, Record<string, Record<string, LastInjection>>>;

const KEY = 'marker-injections';
/** 一块最多留多少字（免得聊天很长时把本机存储撑满） */
const MAX_CHARS = 20000;

function load(): State {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as unknown;
    return v && typeof v === 'object' ? (v as State) : {};
  } catch {
    return {};
  }
}

const state = reactive<State>(load());
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

onMarkerInjections((presetId, context, blocks) => {
  const at = Date.now();
  const scene = context.keys[0] ?? '';
  let changed = false;
  for (const { identifier, ...b } of blocks) {
    if (!b.content.trim() && !b.filled?.trim()) continue;
    const byScene = ((state[presetId] ??= {})[identifier] ??= {});
    byScene[scene] = { ...b, content: clip(b.content) ?? '', filled: clip(b.filled), at, who: context.who };
    changed = true;
  }
  if (changed) save();
});

/** 这一块在各个场景上一次注入的内容，最近的在前 */
export function injectionsOf(presetId: string | undefined, identifier: string): (LastInjection & { scene: string })[] {
  const byScene = presetId ? state[presetId]?.[identifier] : undefined;
  if (!byScene) return [];
  return Object.entries(byScene)
    .map(([scene, x]) => ({ ...x, scene }))
    .sort((a, b) => b.at - a.at);
}
