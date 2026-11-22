<script setup lang="ts">
import type { BiliFavFolder, VideoHit } from '@app/shared';
import { computed, onMounted, ref } from 'vue';
import { BILI_CATEGORIES, biliFavFolders, biliFavVideos, biliList, searchBili, type BiliCategory } from '@/services/bilibili';

/**
 * 一起观影里的"逛 B 站"：每小时更新的分类片单 + 搜索 + 我的收藏夹，点一个就选它（移植自 siios 的 Bilibili App）。
 * 刷新：分类重新取片单；搜索换下一批（翻到底回到第一批）；收藏夹重新读（B 站那边新收藏的也能看到）。
 */
const props = defineProps<{ query?: string }>();
const emit = defineEmits<{ (e: 'pick', video: VideoHit): void }>();

const tab = ref<BiliCategory | 'fav' | 'search'>('recommend');
const keyword = ref(props.query ?? '');
const videos = ref<VideoHit[]>([]);
const loading = ref(false);
const error = ref('');
const updatedAt = ref('');
/** 搜索结果不是真的搜 B 站得到时，写着为什么 */
const note = ref('');
/** 搜索、收藏夹后面还有 */
const more = ref(false);
/** 正在搜的词（输入框改了但没点搜索时，刷新还是换这个词的下一批） */
const searched = ref('');
/** 搜索第几批 */
const batch = ref(1);
const folders = ref<BiliFavFolder[]>([]);
const folderId = ref(0);
/** 收藏夹读到第几页 */
let favPage = 1;
const loadingMore = ref(false);
const moreError = ref('');
let seq = 0;

async function load(run: () => Promise<{ videos: VideoHit[]; updatedAt?: string; note?: string; more?: boolean }>) {
  const n = ++seq;
  loading.value = true;
  error.value = '';
  note.value = '';
  moreError.value = '';
  more.value = false;
  videos.value = [];
  try {
    const r = await run();
    if (n !== seq) return;
    videos.value = r.videos;
    updatedAt.value = r.updatedAt ?? '';
    note.value = r.note ?? '';
    more.value = r.more ?? false;
  } catch (e) {
    if (n === seq) error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (n === seq) loading.value = false;
  }
}
function openTab(id: BiliCategory, fresh = false) {
  tab.value = id;
  void load(() => biliList(id, fresh));
}
function runSearch(q: string, page: number, wrapped = false) {
  tab.value = 'search';
  searched.value = q;
  batch.value = page;
  void load(async () => {
    const r = await searchBili(q, page);
    return wrapped && !r.note ? { ...r, note: '这个词的结果都翻完了，回到第一批' } : r;
  });
}
function search() {
  const q = keyword.value.trim();
  if (q) runSearch(q, 1);
}
/** 打开收藏夹：没读过（或者 fresh）先读收藏夹列表，再读选中的那个的第一页 */
function openFav(fresh = false) {
  tab.value = 'fav';
  void load(async () => {
    if (fresh || !folders.value.length) folders.value = await biliFavFolders();
    if (!folders.value.some((f) => f.id === folderId.value)) folderId.value = folders.value[0]?.id ?? 0;
    favPage = 1;
    if (!folderId.value) return { videos: [] };
    const r = await biliFavVideos(folderId.value, 1);
    return { videos: r.hits, more: r.more };
  });
}
function openFolder(id: number) {
  folderId.value = id;
  openFav();
}
/** 收藏夹的下一页接在后面 */
async function loadMore() {
  if (tab.value !== 'fav' || !more.value || loadingMore.value) return;
  const n = seq;
  loadingMore.value = true;
  moreError.value = '';
  try {
    const r = await biliFavVideos(folderId.value, favPage + 1);
    if (n !== seq) return;
    favPage += 1;
    const have = new Set(videos.value.map((v) => v.bvid));
    videos.value = [...videos.value, ...r.hits.filter((v) => !have.has(v.bvid))];
    more.value = r.more;
  } catch (e) {
    if (n === seq) moreError.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (n === seq) loadingMore.value = false;
  }
}
/** 手动刷新：分类重新取片单，搜索换下一批（翻到底回到第一批），收藏夹重新读 */
function refresh() {
  if (tab.value === 'search') {
    if (more.value) runSearch(searched.value, batch.value + 1);
    else runSearch(searched.value, 1, batch.value > 1);
  } else if (tab.value === 'fav') openFav(true);
  else openTab(tab.value, true);
}
onMounted(() => (props.query?.trim() ? search() : openTab('recommend')));

const updated = computed(() => {
  const t = Date.parse(updatedAt.value);
  if (!Number.isFinite(t)) return '';
  const min = Math.max(0, Math.round((Date.now() - t) / 60_000));
  return min < 60 ? `${min} 分钟前更新` : `${Math.round(min / 60)} 小时前更新`;
});
const plays = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n));
/** B 站的封面加尺寸参数取小图，手机上省流量 */
const thumb = (url: string) => (/hdslb\.com\/bfs\//.test(url) && !url.includes('@') ? `${url}@320w_200h_1c.webp` : url);
</script>

<template>
  <div>
    <form class="flex gap-2 mt-2.5" @submit.prevent="search">
      <input v-model="keyword" class="field" type="search" enterkeyhint="search" placeholder="搜 B 站视频：片名、UP 主" aria-label="搜 B 站视频" />
      <button class="chip" type="submit">搜索</button>
    </form>
    <div class="flex gap-2 mt-2 overflow-x-auto no-scrollbar">
      <button v-for="c in BILI_CATEGORIES" :key="c.id" type="button" class="chip sm" :class="{ on: tab === c.id }" @click="openTab(c.id)">{{ c.label }}</button>
      <button type="button" class="chip sm" :class="{ on: tab === 'fav' }" data-testid="bili-fav" @click="openFav()"><span class="i-lucide-star align-[-2px]" /> 收藏夹</button>
      <button type="button" class="chip sm ml-auto" :disabled="loading" :aria-label="tab === 'search' ? '换一批' : '刷新'" data-testid="bili-refresh" @click="refresh">
        <span class="i-lucide-refresh-cw align-[-2px]" :class="{ 'animate-spin': loading }" /> {{ tab === 'search' ? '换一批' : '刷新' }}
      </button>
    </div>
    <div v-if="tab === 'fav' && folders.length" class="flex gap-2 mt-2 overflow-x-auto no-scrollbar" data-testid="bili-folders">
      <button v-for="f in folders" :key="f.id" type="button" class="chip sm" :class="{ on: folderId === f.id }" @click="openFolder(f.id)">{{ f.title }} · {{ f.count }}</button>
    </div>
    <div v-if="tab === 'search' && note && !loading" class="hint" data-testid="bili-note">{{ note }}</div>
    <div v-if="loading" class="hint">在取 B 站的视频…</div>
    <div v-else-if="error" class="hint bad">{{ error }}</div>
    <div v-else-if="!videos.length" class="hint">
      {{ tab === 'search' ? '没找到：换个词，或者在 B 站搜到以后用"贴链接"' : tab === 'fav' ? (folders.length ? '这个收藏夹里没有能放的视频（空的，或者都失效了）' : '这个 B 站账号还没有建收藏夹') : '这个分类是空的' }}
    </div>
    <div v-else class="grid" data-testid="bili-grid">
      <button v-for="v in videos" :key="v.bvid" type="button" class="card press" @click="emit('pick', v)">
        <span class="cover">
          <!-- referrerpolicy 要写在 :src 前面：iOS（WebKit）在设 src 的那一刻就发请求，后设的不算，带着来源 B 站图床回 403 -->
          <img referrerpolicy="no-referrer" loading="lazy" :src="thumb(v.cover)" alt="" />
          <span v-if="v.duration" class="dur num">{{ v.duration }}</span>
        </span>
        <span class="title">{{ v.title }}</span>
        <span class="meta">{{ v.author }} · {{ plays(v.plays) }} 播放</span>
      </button>
    </div>
    <div v-if="tab === 'search' && videos.length && !loading && (more || batch > 1)" class="hint">第 {{ batch }} 批 · {{ more ? '点"换一批"看下一批' : '已经是最后一批，再点回到第一批' }}</div>
    <template v-if="tab === 'fav' && !loading && !error">
      <button v-if="more" type="button" class="chip more" :disabled="loadingMore" data-testid="bili-fav-more" @click="loadMore">{{ loadingMore ? '在取…' : '加载更多' }}</button>
      <div v-if="moreError" class="hint bad">{{ moreError }}</div>
    </template>
    <div v-if="BILI_CATEGORIES.some((c) => c.id === tab) && updated && !loading && !error" class="hint">片单每小时从 B 站更新 · {{ updated }}</div>
  </div>
</template>

<style scoped>
.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip.sm {
  height: 26px;
  padding: 0 10px;
  font-size: 12.5px;
}
.chip.more {
  display: block;
  margin: 12px auto 0;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 16px;
}
.hint {
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.hint.bad {
  color: var(--bad);
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  min-width: 0;
}
.cover {
  position: relative;
  display: block;
  aspect-ratio: 16 / 10;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.dur {
  position: absolute;
  right: 5px;
  bottom: 4px;
  padding: 0 5px;
  border-radius: 6px;
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  font-size: 11px;
  line-height: 17px;
}
.title {
  font-size: 13px;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  font-size: 11.5px;
  color: var(--ink-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
