import { DEFAULT_SOCIAL_CHARACTER, DEFAULT_SOCIAL_SETTINGS, MOMENT_USER, SOCIAL_PER_DAY_MAX, type Moment, type MomentComment, type SocialCharacterSettings, type SocialSettings } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { autoSave, getAll, getOne } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { useCharacterStore } from './characters';
import { uid } from '@/utils/id';

/**
 * 朋友圈的数据：每一条（她们发的、你发的，连同点赞、评论）和设置（显示最近几条、每个角色发不发、每天最多几条）。
 * 这里只管存和改；调模型（让她发、让她回应）、配图、写进记忆在 services/social.ts。
 */

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** 本机最多留这么多条（更早的删掉；它们的记忆还在） */
const KEEP = 500;

export const useSocialStore = defineStore('social', () => {
  /** 从旧到新 */
  const moments = ref<Moment[]>([]);
  const settings = reactive<SocialSettings>(clone(DEFAULT_SOCIAL_SETTINGS));
  /** 你删掉的云端朋友圈：再拉到也不放回来 */
  const removed = ref<string[]>([]);
  /** 已经应用到哪一次云端结果（/v1/social/posts 的 since） */
  const cursor = ref(0);
  /** 演示动态放进去过了（只放一次，删了不再放回来） */
  const seeded = ref(false);
  const ready = ref(false);
  /** 正在做的事（界面上转圈）：`post:角色`、`react:朋友圈:角色`、`image:朋友圈` */
  const busy = reactive<Record<string, boolean | undefined>>({});
  /** 上一次没做成的原因，同样的键 */
  const failures = reactive<Record<string, string | undefined>>({});

  type Saved = { settings?: Partial<SocialSettings>; removed?: string[]; cursor?: number; seeded?: boolean };
  // 别的设备发的、改的朋友圈（点赞、评论、已读）和朋友圈的设置（同步）：放进来
  const saver = autoSave('moments', () => moments.value.map((m) => ({ key: m.id, value: m })), moments,
    { apply: (changes) => applyList(moments, changes, { sort: (a, b) => a.createdAt - b.createdAt }) });
  const settingSaver = autoSave(
    'settings',
    () => [{ key: 'social', value: { settings, removed: removed.value, cursor: cursor.value, seeded: seeded.value } }],
    () => [settings, removed.value, cursor.value, seeded.value],
    { apply: ([c]) => { if (c && !c.deleted) loadSaved(c.value as Saved); } },
  );

  /** 朋友圈的设置、删掉的云端朋友圈、云端游标（读库时、别的设备改了时） */
  function loadSaved(saved: Saved | null | undefined) {
    if (saved?.settings) {
      const s = saved.settings;
      if (typeof s.visibleCount === 'number' && s.visibleCount >= 0) settings.visibleCount = Math.round(s.visibleCount);
      if (typeof s.autoImage === 'boolean') settings.autoImage = s.autoImage;
      if (s.characters && typeof s.characters === 'object') settings.characters = s.characters;
    }
    if (Array.isArray(saved?.removed)) removed.value = saved.removed.slice(-300);
    if (typeof saved?.cursor === 'number') cursor.value = Math.max(cursor.value, saved.cursor);
    if (saved?.seeded === true) seeded.value = true;
  }

  async function hydrate() {
    const [list, saved] = await Promise.all([getAll<Moment>('moments'), getOne<Saved>('settings', 'social')]);
    moments.value = list.filter((m) => m && m.id).sort((a, b) => a.createdAt - b.createdAt).slice(-KEEP);
    loadSaved(saved);
    seeded.value = saved?.seeded === true || list.length > 0;
    saver.start();
    settingSaver.start();
    // 超出的那些从本机删掉（start 之后改，才会真的删）
    if (list.length > KEEP) moments.value = [...moments.value];
    ready.value = true;
  }

  // —— 设置 ——

  function characterSettings(characterId: string): SocialCharacterSettings {
    const s = settings.characters[characterId];
    return { enabled: s?.enabled ?? DEFAULT_SOCIAL_CHARACTER.enabled, perDay: Math.min(SOCIAL_PER_DAY_MAX, Math.max(1, Math.round(s?.perDay ?? DEFAULT_SOCIAL_CHARACTER.perDay))) };
  }

  function setCharacter(characterId: string, patch: Partial<SocialCharacterSettings>) {
    settings.characters[characterId] = { ...characterSettings(characterId), ...patch };
  }

  // —— 读 ——

  function byId(id: string): Moment | undefined {
    return moments.value.find((m) => m.id === id);
  }

  /** 只展示还在的角色和你发的动态；保留原记录，重新导入角色后仍能看到历史。 */
  const available = computed(() => {
    const authors = new Set(useCharacterStore().list.map((c) => c.id));
    return moments.value.filter((m) => m.authorId === MOMENT_USER || authors.has(m.authorId));
  });
  /** 朋友圈页显示的：最新的在前，只显示最近 x 条（"我的"页里设；0 = 全部） */
  const feed = computed(() => {
    const all = [...available.value].sort((a, b) => b.createdAt - a.createdAt);
    return settings.visibleCount > 0 ? all.slice(0, settings.visibleCount) : all;
  });
  /** 因为"只显示最近 x 条"没显示出来的条数 */
  const hidden = computed(() => available.value.length - feed.value.length);
  const unread = computed(() => feed.value.filter((m) => m.unread).length);

  /** 这个角色看得到的：她自己发的，和你发的里面她看得到的（从旧到新） */
  function visibleTo(characterId: string): Moment[] {
    return available.value.filter((m) => m.authorId === characterId || (m.authorId === MOMENT_USER && (m.visibleTo === null || m.visibleTo.includes(characterId))));
  }

  // —— 改 ——

  function add(m: Moment): Moment {
    moments.value.push(m);
    moments.value.sort((a, b) => a.createdAt - b.createdAt);
    if (moments.value.length > KEEP) moments.value = moments.value.slice(-KEEP);
    return byId(m.id) as Moment;
  }

  /** 云端发来的：作者还在、没见过、也没被你删过的才放进来 */
  function ingest(list: Moment[]): Moment[] {
    const out: Moment[] = [];
    for (const m of list) {
      if (!m?.id || byId(m.id) || removed.value.includes(m.id)) continue;
      if (m.authorId !== MOMENT_USER && !useCharacterStore().byId(m.authorId)) continue;
      out.push(add({ ...m, likes: m.likes ?? [], comments: m.comments ?? [], images: m.images ?? [], unread: true }));
    }
    return out;
  }

  function remove(id: string) {
    const m = byId(id);
    if (!m) return;
    if (m.source === 'hub') removed.value = [...removed.value, id].slice(-300);
    moments.value = moments.value.filter((x) => x.id !== id);
  }

  function touch(m: Moment) {
    m.updatedAt = Date.now();
  }

  function setLike(id: string, who: string, on: boolean) {
    const m = byId(id);
    if (!m || m.likes.includes(who) === on) return;
    m.likes = on ? [...m.likes, who] : m.likes.filter((x) => x !== who);
    touch(m);
  }

  function comment(id: string, authorId: string, text: string, replyTo?: string): MomentComment | undefined {
    const m = byId(id);
    const said = text.trim();
    if (!m || !said) return undefined;
    m.comments.push({ id: uid('mc'), authorId, text: said, ...(replyTo ? { replyTo } : {}), at: Date.now() });
    touch(m);
    return m.comments.at(-1);
  }

  function removeComment(id: string, commentId: string) {
    const m = byId(id);
    if (!m) return;
    m.comments = m.comments.filter((c) => c.id !== commentId);
    touch(m);
  }

  function markAllRead() {
    for (const m of moments.value) if (m.unread) m.unread = false;
  }

  return { moments, settings, removed, cursor, seeded, ready, busy, failures, feed, hidden, unread, hydrate, characterSettings, setCharacter, byId, visibleTo, add, ingest, remove, setLike, comment, removeComment, markAllRead };
});
