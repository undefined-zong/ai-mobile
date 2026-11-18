import {
  communityFromDraft, communitySettingsOf, DEFAULT_COMMUNITY_SETTINGS, matchCommunity, parseCommunityFile, postsFromDrafts,
  type Community, type CommunityComment, type CommunityPost, type CommunitySettings, type CommunitySort,
} from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { autoSave, getAll, getOne } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { uid } from '@/utils/id';

/**
 * 社群的数据：社群（自带的、搜不到时模型建的）、里面的帖子（网友的、角色的、你的，连同赞、顶、回复）和设置。
 * 这里只管存和改；调模型（建社群、网友发帖、回应）、配图、写进记忆在 services/community.ts。
 *
 * 自带的社群是 src/communities/ 里的社群文件：第一次打开时放进来，之后和搜出来的一样能加入、退出、删掉；
 * 删掉的不会再放回来。往这个文件夹里加一个 .json 就多一个自带社群。
 */
const FILES = import.meta.glob<unknown>('../communities/*.json', { eager: true, import: 'default' });

/** 帖子的排法：按哪个时间从新到旧 */
const SORT_KEY: Record<CommunitySort, (p: CommunityPost) => number> = { active: (p) => p.bumpedAt, new: (p) => p.createdAt };

interface Saved {
  settings?: Partial<CommunitySettings>;
  removed?: string[];
  cursor?: number;
  seededFiles?: string[];
}

export const useCommunityStore = defineStore('community', () => {
  const communities = ref<Community[]>([]);
  /** 所有社群的帖子，从旧到新 */
  const posts = ref<CommunityPost[]>([]);
  const settings = reactive<CommunitySettings>({ ...DEFAULT_COMMUNITY_SETTINGS });
  /** 你删掉的帖子：云端、定时发的再拉到 / 再算到也不放回来 */
  const removed = ref<string[]>([]);
  /** 已经应用到哪一次云端结果（/v1/community/posts 的 since） */
  const cursor = ref(0);
  /** 放进来过的社群文件（只放一次） */
  const seededFiles = ref<string[]>([]);
  const ready = ref(false);
  /** 正在做的事（界面上转圈）：`create`、`feed:社群`、`member:社群:角色`、`react:帖子`、`react:帖子:角色`、`image:帖子:第几张` */
  const busy = reactive<Record<string, boolean | undefined>>({});
  /** 上一次没做成的原因，同样的键 */
  const failures = reactive<Record<string, string | undefined>>({});

  // 别的设备改了社群、帖子、社群的设置（同步）：放进来
  const communitySaver = autoSave('communities', () => communities.value.map((c) => ({ key: c.id, value: c })), communities,
    { apply: (changes) => applyList(communities, changes, { sort: (a, b) => a.createdAt - b.createdAt }) });
  const postSaver = autoSave('communityPosts', () => posts.value.map((p) => ({ key: p.id, value: p })), posts,
    { apply: (changes) => applyList(posts, changes, { sort: (a, b) => a.createdAt - b.createdAt }) });
  const settingSaver = autoSave(
    'settings',
    () => [{ key: 'community', value: { settings: { ...settings }, removed: removed.value, cursor: cursor.value, seededFiles: seededFiles.value } satisfies Saved }],
    () => [settings, removed.value, cursor.value, seededFiles.value],
    { apply: ([c]) => { if (c && !c.deleted) loadSaved(c.value as Saved); } },
  );

  /** 社群的设置、删掉的帖子、云端游标、放进来过的文件（读库时、别的设备改了时） */
  function loadSaved(saved: Saved | null | undefined) {
    Object.assign(settings, communitySettingsOf(saved?.settings));
    if (Array.isArray(saved?.removed)) removed.value = saved.removed.slice(-500);
    if (typeof saved?.cursor === 'number') cursor.value = Math.max(cursor.value, saved.cursor);
    if (Array.isArray(saved?.seededFiles)) seededFiles.value = saved.seededFiles;
  }

  async function hydrate() {
    const [cs, ps, saved] = await Promise.all([getAll<Community>('communities'), getAll<CommunityPost>('communityPosts'), getOne<Saved>('settings', 'community')]);
    communities.value = cs.filter((c) => c && c.id).sort((a, b) => a.createdAt - b.createdAt);
    posts.value = ps.filter((p) => p && p.id && communities.value.some((c) => c.id === p.communityId)).sort((a, b) => a.createdAt - b.createdAt);
    loadSaved(saved);
    communitySaver.start();
    postSaver.start();
    settingSaver.start();
    // start 之后再放自带的社群、删超出的帖子：这些改动才会写进本机
    seed();
    trim();
    ready.value = true;
  }

  /** 新的社群文件（第一次打开，或者 App 更新后多了一个）：放进来，连同文件里带的几帖 */
  function seed() {
    const now = Date.now();
    for (const [path, json] of Object.entries(FILES)) {
      const file = path.split('/').pop() ?? path;
      if (seededFiles.value.includes(file)) continue;
      seededFiles.value = [...seededFiles.value, file];
      try {
        const parsed = parseCommunityFile(json, file);
        const id = parsed.id ?? `community-${file.replace(/\.json$/i, '')}`;
        if (byId(id)) continue;
        communities.value.push(communityFromDraft(parsed.draft, { id, now, source: 'seed', joined: parsed.joined, seedFile: file }));
        addPosts(postsFromDrafts(parsed.posts, { communityId: id, batchId: `cpost:${id}:seed`, now, source: 'seed', known: {} }));
      } catch (e) {
        console.error(`社群文件 ${file} 读不出来：`, e);
      }
    }
  }

  // —— 读 ——

  function byId(id: string | null | undefined): Community | undefined {
    return communities.value.find((c) => c.id === id);
  }

  function postById(id: string): CommunityPost | undefined {
    return posts.value.find((p) => p.id === id);
  }

  /** 你加入的社群 */
  const joined = computed(() => communities.value.filter((c) => c.joined));

  /** 这个社群的帖子，按设置里选的排法（最近顶起 / 最新发布），新的在前 */
  function postsOf(communityId: string, sort: CommunitySort = settings.sort): CommunityPost[] {
    const key = SORT_KEY[sort];
    return posts.value.filter((p) => p.communityId === communityId).sort((a, b) => key(b) - key(a));
  }

  /** 这个社群的帖子，从旧到新（进提示词、进记忆用） */
  function timelineOf(communityId: string): CommunityPost[] {
    return posts.value.filter((p) => p.communityId === communityId);
  }

  function unreadOf(communityId: string): number {
    return posts.value.filter((p) => p.communityId === communityId && p.unread).length;
  }

  /** 你加入的社群里没看过的帖子（社媒页签上的数） */
  const unread = computed(() => {
    const mine = new Set(joined.value.map((c) => c.id));
    return posts.value.filter((p) => p.unread && mine.has(p.communityId)).length;
  });

  /** 按关键字找社群：你加入的排前面 */
  function search(query: string): Community[] {
    return communities.value.filter((c) => matchCommunity(c, query)).sort((a, b) => Number(b.joined) - Number(a.joined));
  }

  /** 这个角色所在的社群（你邀请她进去、你也还在里面的） */
  function communitiesOf(characterId: string): Community[] {
    return joined.value.filter((c) => c.members.includes(characterId));
  }

  // —— 改社群 ——

  function touch(c: Community) {
    c.updatedAt = Date.now();
  }

  function addCommunity(c: Community): Community {
    communities.value.push(c);
    return byId(c.id) as Community;
  }

  /** 删掉一个社群，连同里面的帖子（自带的也能删，不会再放回来） */
  function removeCommunity(id: string) {
    communities.value = communities.value.filter((c) => c.id !== id);
    posts.value = posts.value.filter((p) => p.communityId !== id);
  }

  function setJoined(id: string, on: boolean) {
    const c = byId(id);
    if (!c || c.joined === on) return;
    c.joined = on;
    touch(c);
  }

  function patchCommunity(id: string, patch: Partial<Pick<Community, 'name' | 'description' | 'vibe' | 'tags' | 'icon' | 'color' | 'memberCount' | 'memoryIds'>>) {
    const c = byId(id);
    if (!c) return;
    Object.assign(c, patch);
    touch(c);
  }

  function setMember(id: string, characterId: string, on: boolean) {
    const c = byId(id);
    if (!c || c.members.includes(characterId) === on) return;
    c.members = on ? [...c.members, characterId] : c.members.filter((x) => x !== characterId);
    touch(c);
  }

  // —— 改帖子 ——

  /** 每个社群只留最近 settings.keep 帖（更早的从本机删掉；她们记住的还在） */
  function trim() {
    const count = new Map<string, number>();
    const keep = new Set<string>();
    for (let i = posts.value.length - 1; i >= 0; i -= 1) {
      const p = posts.value[i]!;
      const n = (count.get(p.communityId) ?? 0) + 1;
      count.set(p.communityId, n);
      if (n <= settings.keep) keep.add(p.id);
    }
    if (keep.size < posts.value.length) posts.value = posts.value.filter((p) => keep.has(p.id));
  }

  /** 放进来一批帖子：社群不在了的、已经有的、你删过的不放。返回真的放进来的那些 */
  function addPosts(list: CommunityPost[]): CommunityPost[] {
    const fresh = list.filter((p) => p?.id && byId(p.communityId) && !postById(p.id) && !removed.value.includes(p.id));
    if (!fresh.length) return [];
    posts.value.push(...fresh);
    posts.value.sort((a, b) => a.createdAt - b.createdAt);
    trim();
    return fresh.flatMap((p) => postById(p.id) ?? []);
  }

  function removePost(id: string) {
    const p = postById(id);
    if (!p) return;
    // 定时发的帖子 id 是算出来的：记下来，免得云端、手机再发一遍
    if (p.source !== 'user') removed.value = [...removed.value, id].slice(-500);
    posts.value = posts.value.filter((x) => x.id !== id);
  }

  function touchPost(p: CommunityPost) {
    p.updatedAt = Date.now();
  }

  /** 你或角色点赞 / 取消 */
  function setLiked(id: string, who: string, on: boolean) {
    const p = postById(id);
    if (!p || p.liked.includes(who) === on) return;
    p.liked = on ? [...p.liked, who] : p.liked.filter((x) => x !== who);
    touchPost(p);
  }

  /** 你或角色顶帖 / 取消：顶了就把帖子顶上来 */
  function setBumped(id: string, who: string, on: boolean) {
    const p = postById(id);
    if (!p || p.bumped.includes(who) === on) return;
    p.bumped = on ? [...p.bumped, who] : p.bumped.filter((x) => x !== who);
    if (on) p.bumpedAt = Date.now();
    touchPost(p);
  }

  /** 网友新增的赞和顶 */
  function addCounts(id: string, add: { likes: number; bumps: number }) {
    const p = postById(id);
    if (!p || (!add.likes && !add.bumps)) return;
    p.likes += add.likes;
    p.bumps += add.bumps;
    if (add.bumps) p.bumpedAt = Date.now();
    touchPost(p);
  }

  function comment(id: string, authorId: string, text: string, replyTo?: string): CommunityComment | undefined {
    const p = postById(id);
    const said = text.trim();
    if (!p || !said) return undefined;
    p.comments.push({ id: uid('cc'), authorId, text: said, ...(replyTo ? { replyTo } : {}), at: Date.now() });
    touchPost(p);
    return p.comments.at(-1);
  }

  function addComments(id: string, list: CommunityComment[]) {
    const p = postById(id);
    if (!p || !list.length) return;
    p.comments.push(...list);
    touchPost(p);
  }

  function removeComment(id: string, commentId: string) {
    const p = postById(id);
    if (!p) return;
    p.comments = p.comments.filter((c) => c.id !== commentId);
    touchPost(p);
  }

  function markRead(communityId: string) {
    for (const p of posts.value) if (p.unread && p.communityId === communityId) p.unread = false;
  }

  return {
    communities, posts, settings, removed, cursor, ready, busy, failures, joined, unread,
    hydrate, byId, postById, postsOf, timelineOf, unreadOf, search, communitiesOf,
    addCommunity, removeCommunity, setJoined, patchCommunity, setMember,
    trim, addPosts, removePost, setLiked, setBumped, addCounts, comment, addComments, removeComment, markRead,
  };
});
