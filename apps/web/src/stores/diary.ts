import type { DiaryEntry } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { autoSave, getAll, getOne } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { useCharacterStore } from './characters';

/**
 * 日记的数据：每一篇（谁写的、哪一天、正文、心情、配图），连同云端游标、你删掉的那几篇。
 * 这里只管存和改；调模型写、配图、到点写在 services/diary.ts。
 * 一篇一条存在 diaries 表（多设备同步）。日记的 id 按角色和日子算（diaryId），同一天只有一篇。
 */

/** 本机最多留这么多篇（更早的删掉） */
const KEEP = 1000;

export const useDiaryStore = defineStore('diary', () => {
  /** 从旧到新（按日子） */
  const entries = ref<DiaryEntry[]>([]);
  /** 你删掉的：云端再拉到、到点补写时都不再放回来 */
  const removed = ref<string[]>([]);
  /** 已经拉到哪一次云端结果（/v1/diary/entries 的 since） */
  const cursor = ref(0);
  const ready = ref(false);
  /** 正在做的事（界面上转圈）：`write:角色`、`image:日记 id:第几张` */
  const busy = reactive<Record<string, boolean | undefined>>({});
  /** 上一次没做成的原因，同样的键 */
  const failures = reactive<Record<string, string | undefined>>({});

  const order = (a: DiaryEntry, b: DiaryEntry) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt;

  type Saved = { removed?: string[]; cursor?: number };
  // 别的设备写的、改的、删的日记（同步）：放进来
  const saver = autoSave('diaries', () => entries.value.map((e) => ({ key: e.id, value: e })), entries,
    { apply: (changes) => applyList(entries, changes, { sort: order }) });
  const settingSaver = autoSave('settings', () => [{ key: 'diary', value: { removed: removed.value, cursor: cursor.value } }], () => [removed.value, cursor.value],
    { apply: ([c]) => { if (c && !c.deleted) loadSaved(c.value as Saved); } });

  function loadSaved(saved: Saved | null | undefined) {
    if (Array.isArray(saved?.removed)) removed.value = saved.removed.filter((x) => typeof x === 'string').slice(-500);
    if (typeof saved?.cursor === 'number') cursor.value = Math.max(cursor.value, saved.cursor);
  }

  async function hydrate() {
    const [list, saved] = await Promise.all([getAll<DiaryEntry>('diaries'), getOne<Saved>('settings', 'diary')]);
    entries.value = list.filter((e) => e && e.id && typeof e.text === 'string' && typeof e.date === 'string').sort(order).slice(-KEEP);
    loadSaved(saved);
    saver.start();
    settingSaver.start();
    if (list.length > KEEP) entries.value = [...entries.value];
    ready.value = true;
  }

  function byId(id: string): DiaryEntry | undefined {
    return entries.value.find((e) => e.id === id);
  }

  /** 这个角色的日记（新的在前） */
  function of(characterId: string): DiaryEntry[] {
    return entries.value.filter((e) => e.characterId === characterId).sort((a, b) => order(b, a));
  }

  /** 还在的角色的、没看过的 */
  const unread = computed(() => {
    const ids = new Set(useCharacterStore().list.map((c) => c.id));
    return entries.value.filter((e) => e.unread && ids.has(e.characterId)).length;
  });

  /** 放进来一篇（同一 id 的换掉） */
  function put(e: DiaryEntry): DiaryEntry {
    const i = entries.value.findIndex((x) => x.id === e.id);
    if (i >= 0) entries.value.splice(i, 1, e);
    else entries.value.push(e);
    entries.value.sort(order);
    if (entries.value.length > KEEP) entries.value = entries.value.slice(-KEEP);
    return byId(e.id) as DiaryEntry;
  }

  /** 云端写的：角色还在、没见过、也没被你删过的才放进来 */
  function ingest(list: DiaryEntry[]): DiaryEntry[] {
    const out: DiaryEntry[] = [];
    for (const e of list) {
      if (!e?.id || byId(e.id) || removed.value.includes(e.id) || !useCharacterStore().byId(e.characterId)) continue;
      out.push(put(e));
    }
    return out;
  }

  function remove(id: string) {
    entries.value = entries.value.filter((e) => e.id !== id);
    if (!removed.value.includes(id)) removed.value = [...removed.value, id].slice(-500);
  }

  function markRead(characterId: string) {
    for (const e of entries.value) if (e.characterId === characterId && e.unread) e.unread = false;
  }

  return { entries, removed, cursor, ready, busy, failures, unread, hydrate, byId, of, put, ingest, remove, markRead };
});
