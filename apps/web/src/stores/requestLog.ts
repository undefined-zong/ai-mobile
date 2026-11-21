import { observeRequests, type IllustrateTrace, type RequestRecord } from '@app/ai';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getAll, write } from '@/db/idb';

/**
 * 请求记录：发出去的每一个请求原样记下来（地址、请求体、返回内容，Key 打码），生图另外记一份怎么拼的
 * （预设每一块发没发、模型原样的输出、出图用了哪几块）。只存在这台设备上（不同步、不进备份），留最近 MAX 条。
 */

export type RequestLogEntry =
  | { kind: 'http'; id: string; at: number; record: RequestRecord }
  | { kind: 'image'; id: string; at: number; /** 画的是谁、哪个场景 */ label: string; trace: IllustrateTrace };

const MAX = 80;

export const useRequestLogStore = defineStore('requestLog', () => {
  const entries = ref<RequestLogEntry[]>([]);
  const dirty = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  /** 改了的攒一下再写（流式回复读完、生图返回都会再改一次） */
  function persist(id: string) {
    dirty.add(id);
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const ids = [...dirty];
      dirty.clear();
      const puts = ids.map((k) => entries.value.find((e) => e.id === k)).filter((e): e is RequestLogEntry => !!e).map((e) => ({ key: e.id, value: JSON.parse(JSON.stringify(e)) as RequestLogEntry }));
      void write('requestLog', puts, [], { sync: true });
    }, 400);
  }

  function add(entry: RequestLogEntry) {
    entries.value.push(entry);
    const drop = entries.value.length > MAX ? entries.value.splice(0, entries.value.length - MAX).map((e) => e.id) : [];
    if (drop.length) void write('requestLog', [], drop, { sync: true });
    persist(entry.id);
  }

  observeRequests({
    begin(record) {
      add({ kind: 'http', id: record.id, at: record.at, record });
    },
    end(id, patch) {
      const e = entries.value.find((x) => x.id === id);
      if (e?.kind !== 'http') return;
      Object.assign(e.record, patch);
      persist(id);
    },
  });

  /** 生图：这一张是怎么拼的 */
  function addImage(label: string, trace: IllustrateTrace) {
    const at = Date.now();
    add({ kind: 'image', id: `img-${at.toString(36)}-${Math.random().toString(36).slice(2, 6)}`, at, label, trace });
  }

  async function hydrate() {
    const saved = await getAll<RequestLogEntry>('requestLog');
    const have = new Set(entries.value.map((e) => e.id));
    // 打开 App 之后、读完之前发的请求已经在内存里：合在一起按时间排
    entries.value = [...saved.filter((e) => e && !have.has(e.id)), ...entries.value].sort((a, b) => a.at - b.at);
    if (entries.value.length > MAX) {
      const drop = entries.value.splice(0, entries.value.length - MAX).map((e) => e.id);
      await write('requestLog', [], drop, { sync: true });
    }
  }

  async function clear() {
    const ids = entries.value.map((e) => e.id);
    entries.value = [];
    await write('requestLog', [], ids, { sync: true });
  }

  return { entries, addImage, hydrate, clear };
});
