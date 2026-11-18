import {
  DEFAULT_PARALLEL_CHARACTER,
  DEFAULT_PARALLEL_SETTINGS,
  parallelPerDay,
  PARALLEL_USER,
  rhythmDate,
  shiftDate,
  toMinutes,
  type ISODate,
  type ParallelCharacterSettings,
  type ParallelDay,
  type ParallelItem,
  type ParallelNote,
  type ParallelOverride,
  type ParallelPlan,
  type ParallelReply,
  type ParallelSettings,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { uid } from '@/utils/id';
import { useEnvironmentStore } from './environment';

/**
 * 平行时空的数据（设计文档 §9.16）：你每天自己记的事和改过的地方（按人设、节律日）、每天整理好的你的一份计划、和每个角色之间的留言、设置。
 * 存在本机（settings 表的 parallel / parallel:days / parallel:plans / parallel:notes）：最近 30 天的你的一天和计划、最近 400 条留言。
 * 这里只管存和改；拼你的一天、调模型（她留言、回你、改日程）、写进记忆在 services/parallel.ts。
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const KEEP_DAYS = 30;
const KEEP_NOTES = 400;

interface Saved {
  settings?: Partial<ParallelSettings>;
  removed?: string[];
  cursor?: number;
  planCursor?: number;
}

export const useParallelStore = defineStore('parallel', () => {
  /** `${人设}:${日期}` → 你那一天 */
  const days = reactive<Record<string, ParallelDay>>({});
  /** 留言，从旧到新 */
  const notes = ref<ParallelNote[]>([]);
  const settings = reactive<ParallelSettings>(clone(DEFAULT_PARALLEL_SETTINGS));
  /** 你删掉的云端留言：再拉到也不放回来 */
  const removed = ref<string[]>([]);
  /** 云端留言拉到哪了（/v1/parallel/notes 的 since） */
  const cursor = ref(0);
  /** `${人设}:${日期}` → 那天整理好的你的一份计划 */
  const plans = reactive<Record<string, ParallelPlan>>({});
  /** 云端整理好的计划拉到哪了（/v1/parallel/plans 的 since） */
  const planCursor = ref(0);
  /** 云端整理计划没成的（今天的） */
  const planErrors = ref<{ personaId: string; date: string; reason: string }[]>([]);
  const ready = ref(false);
  /** 正在做的事（界面上转圈）：`post:角色`、`reply:留言`、`request:留言` */
  const busy = reactive<Record<string, boolean | undefined>>({});
  /** 上一次没做成的原因，同样的键 */
  const failures = reactive<Record<string, string | undefined>>({});

  const saver = autoSave(
    'settings',
    () => [
      { key: 'parallel', value: { settings, removed: removed.value, cursor: cursor.value, planCursor: planCursor.value } },
      { key: 'parallel:days', value: Object.values(days) },
      { key: 'parallel:plans', value: Object.values(plans) },
      { key: 'parallel:notes', value: notes.value },
    ],
    () => [settings, removed.value, cursor.value, planCursor.value, days, plans, notes.value],
    {
      // 别的设备记的事、留言、整理好的计划、设置（同步）：放进来
      apply: (changes) => {
        for (const c of changes) {
          if (c.deleted) continue;
          if (c.key === 'parallel') loadSaved(c.value as Saved);
          else if (c.key === 'parallel:days') loadDays(c.value as ParallelDay[], true);
          else if (c.key === 'parallel:plans') loadPlans(c.value as ParallelPlan[], true);
          else if (c.key === 'parallel:notes') loadNotes(c.value as ParallelNote[]);
        }
      },
    },
  );

  function oldestDay() {
    return shiftDate(rhythmDate(new Date(), useEnvironmentStore().settings.timezone), -KEEP_DAYS);
  }

  /** 读出四份存档（读库时、别的设备改了时）；replace：先清掉内存里的 */
  function loadSaved(saved: Saved | null | undefined) {
    if (saved?.settings) {
      if (typeof saved.settings.inChat === 'boolean') settings.inChat = saved.settings.inChat;
      if (typeof saved.settings.calendarSync === 'boolean') settings.calendarSync = saved.settings.calendarSync;
      if (typeof saved.settings.planAt === 'string' && toMinutes(saved.settings.planAt) !== null) settings.planAt = saved.settings.planAt;
      if (saved.settings.characters && typeof saved.settings.characters === 'object') settings.characters = saved.settings.characters;
    }
    if (Array.isArray(saved?.removed)) removed.value = saved.removed.slice(-300);
    if (typeof saved?.cursor === 'number') cursor.value = Math.max(cursor.value, saved.cursor);
    if (typeof saved?.planCursor === 'number') planCursor.value = Math.max(planCursor.value, saved.planCursor);
  }
  function loadDays(list: ParallelDay[] | null | undefined, replace = false) {
    if (replace) for (const k of Object.keys(days)) delete days[k];
    const oldest = oldestDay();
    for (const d of Array.isArray(list) ? list : []) {
      if (!d || typeof d.personaId !== 'string' || typeof d.date !== 'string' || d.date < oldest) continue;
      days[`${d.personaId}:${d.date}`] = { personaId: d.personaId, date: d.date, items: Array.isArray(d.items) ? d.items : [], overrides: d.overrides && typeof d.overrides === 'object' ? d.overrides : {} };
    }
  }
  function loadPlans(list: ParallelPlan[] | null | undefined, replace = false) {
    if (replace) for (const k of Object.keys(plans)) delete plans[k];
    const oldest = oldestDay();
    for (const p of Array.isArray(list) ? list : []) {
      if (p && typeof p.personaId === 'string' && typeof p.date === 'string' && p.date >= oldest && Array.isArray(p.items)) plans[`${p.personaId}:${p.date}`] = p;
    }
  }
  function loadNotes(list: ParallelNote[] | null | undefined) {
    notes.value = (Array.isArray(list) ? list : [])
      .filter((n) => n && n.id && n.characterId)
      .map((n) => ({ ...n, replies: Array.isArray(n.replies) ? n.replies : [] }))
      .sort((a, b) => a.at - b.at)
      .slice(-KEEP_NOTES);
  }

  async function hydrate() {
    const [saved, savedDays, savedPlans, savedNotes] = await Promise.all([
      getOne<Saved>('settings', 'parallel'),
      getOne<ParallelDay[]>('settings', 'parallel:days'),
      getOne<ParallelPlan[]>('settings', 'parallel:plans'),
      getOne<ParallelNote[]>('settings', 'parallel:notes'),
    ]);
    loadSaved(saved);
    loadDays(savedDays);
    loadPlans(savedPlans);
    loadNotes(savedNotes);
    saver.start();
    ready.value = true;
  }

  // —— 设置 ——

  function characterSettings(characterId: string): ParallelCharacterSettings {
    const s = settings.characters[characterId];
    return { enabled: s?.enabled ?? DEFAULT_PARALLEL_CHARACTER.enabled, perDay: parallelPerDay({ perDay: s?.perDay ?? DEFAULT_PARALLEL_CHARACTER.perDay }) };
  }

  function setCharacter(characterId: string, patch: Partial<ParallelCharacterSettings>) {
    settings.characters[characterId] = { ...characterSettings(characterId), ...patch };
  }

  // —— 你的一天 ——

  function dayOf(personaId: string, date: ISODate): ParallelDay | null {
    return days[`${personaId}:${date}`] ?? null;
  }

  /** 要改时先放进表里 */
  function ensureDay(personaId: string, date: ISODate): ParallelDay {
    const k = `${personaId}:${date}`;
    return (days[k] ??= { personaId, date, items: [], overrides: {} });
  }

  function addItem(personaId: string, date: ISODate, item: Omit<ParallelItem, 'id' | 'createdAt' | 'done'>): ParallelItem {
    const day = ensureDay(personaId, date);
    const it: ParallelItem = { ...clone(item), id: uid('pi'), done: false, createdAt: Date.now() };
    day.items.push(it);
    return it;
  }

  function itemOf(personaId: string, date: ISODate, id: string): ParallelItem | undefined {
    return dayOf(personaId, date)?.items.find((x) => x.id === id);
  }

  function updateItem(personaId: string, date: ISODate, id: string, patch: Partial<Omit<ParallelItem, 'id' | 'createdAt'>>) {
    const it = itemOf(personaId, date, id);
    if (it) Object.assign(it, clone(patch));
  }

  function removeItem(personaId: string, date: ISODate, id: string) {
    const day = dayOf(personaId, date);
    if (day) day.items = day.items.filter((x) => x.id !== id);
  }

  /** 来源里的事改过的地方（合并进去；undefined 的字段去掉） */
  function setOverride(personaId: string, date: ISODate, key: string, patch: ParallelOverride) {
    const day = ensureDay(personaId, date);
    const next: ParallelOverride = { ...day.overrides[key], ...clone(patch) };
    for (const k of Object.keys(next) as (keyof ParallelOverride)[]) if (next[k] === undefined) delete next[k];
    if (Object.keys(next).length) day.overrides[key] = next;
    else delete day.overrides[key];
  }

  function overrideOf(personaId: string, date: ISODate, key: string): ParallelOverride | undefined {
    return dayOf(personaId, date)?.overrides[key];
  }

  // —— 整理好的你的一份计划 ——

  function planOf(personaId: string, date: ISODate): ParallelPlan | null {
    return plans[`${personaId}:${date}`] ?? null;
  }

  /** 收下一份（本机整理的、云端整理的）：同一天的换成新的；旧的过了 30 天不留 */
  function setPlan(p: ParallelPlan) {
    const prev = planOf(p.personaId, p.date);
    if (prev && prev.at > p.at) return;
    plans[`${p.personaId}:${p.date}`] = clone(p);
    const oldest = shiftDate(rhythmDate(new Date(), useEnvironmentStore().settings.timezone), -KEEP_DAYS);
    for (const [k, x] of Object.entries(plans)) if (x.date < oldest) delete plans[k];
  }

  // —— 留言 ——

  function noteById(id: string): ParallelNote | undefined {
    return notes.value.find((n) => n.id === id);
  }

  /** 和这个角色的留言（从旧到新）；给了日期只要那一天的 */
  function notesOf(characterId: string, date?: ISODate): ParallelNote[] {
    return notes.value.filter((n) => n.characterId === characterId && (!date || n.date === date));
  }

  function unreadOf(characterId: string): number {
    return notes.value.filter((n) => n.characterId === characterId && n.unread).length;
  }

  function addNote(n: ParallelNote): ParallelNote {
    notes.value.push(n);
    notes.value.sort((a, b) => a.at - b.at);
    if (notes.value.length > KEEP_NOTES) notes.value = notes.value.slice(-KEEP_NOTES);
    return noteById(n.id) as ParallelNote;
  }

  /** 云端留的：没见过、也没被你删过的才放进来 */
  function ingest(list: ParallelNote[]): ParallelNote[] {
    const out: ParallelNote[] = [];
    for (const n of list) {
      if (!n?.id || noteById(n.id) || removed.value.includes(n.id)) continue;
      out.push(addNote({ ...n, replies: n.replies ?? [], unread: true }));
    }
    return out;
  }

  function addReply(noteId: string, authorId: string, text: string): ParallelReply | undefined {
    const n = noteById(noteId);
    const said = text.trim();
    if (!n || !said) return undefined;
    const r: ParallelReply = { id: uid('pr'), authorId, text: said, at: Date.now() };
    n.replies.push(r);
    n.updatedAt = r.at;
    if (authorId !== PARALLEL_USER) n.unread = true;
    return r;
  }

  function removeNote(id: string) {
    const n = noteById(id);
    if (!n) return;
    if (n.source === 'hub') removed.value = [...removed.value, id].slice(-300);
    notes.value = notes.value.filter((x) => x.id !== id);
  }

  function markRead(characterId: string) {
    for (const n of notes.value) if (n.characterId === characterId && n.unread) n.unread = false;
  }

  return {
    days, notes, settings, removed, cursor, plans, planCursor, planErrors, ready, busy, failures, hydrate,
    characterSettings, setCharacter,
    dayOf, ensureDay, addItem, itemOf, updateItem, removeItem, setOverride, overrideOf, planOf, setPlan,
    noteById, notesOf, unreadOf, addNote, ingest, addReply, removeNote, markRead,
  };
});
