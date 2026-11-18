<script setup lang="ts">
import type { VideoHit } from '@app/shared';
import { computed, onMounted, ref } from 'vue';
import { BILI_CATEGORIES, biliList, searchBili, type BiliCategory } from '@/services/bilibili';

/** 一起观影里的"逛 B 站"：每小时更新的分类片单 + 搜索 + 手动刷新，点一个就选它（移植自 siios 的 Bilibili App） */
const props = defineProps<{ query?: string }>();
const emit = defineEmits<{ (e: 'pick', video: VideoHit): void }>();

const tab = ref<BiliCategory | 'search'>('recommend');
const keyword = ref(props.query ?? '');
const videos = ref<VideoHit[]>([]);
const loading = ref(false);
const error = ref('');
const updatedAt = ref('');
/** 搜索结果不是真的搜 B 站得到时，写着为什么 */
const note = ref('');
let seq = 0;

async function load(run: () => Promise<{ videos: VideoHit[]; updatedAt?: string; note?: string }>) {
  const n = ++seq;
  loading.value = true;
  error.value = '';
  note.value = '';
  videos.value = [];
  try {
    const r = await run();
    if (n !== seq) return;
    videos.value = r.videos;
    updatedAt.value = r.updatedAt ?? '';
    note.value = r.note ?? '';
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
function search() {
  const q = keyword.value.trim();
  if (!q) return;
  tab.value = 'search';
  void load(() => searchBili(q));
}
/** 手动刷新：分类重新取片单，搜索再搜一次 */
function refresh() {
  if (tab.value === 'search') search();
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
      <button type="button" class="chip sm ml-auto" :disabled="loading" aria-label="刷新" data-testid="bili-refresh" @click="refresh">
        <span class="i-lucide-refresh-cw align-[-2px]" :class="{ 'animate-spin': loading }" /> 刷新
      </button>
    </div>
    <div v-if="tab === 'search' && note && !loading" class="hint" data-testid="bili-note">{{ note }}</div>
    <div v-if="loading" class="hint">在取 B 站的视频…</div>
    <div v-else-if="error" class="hint bad">{{ error }}</div>
    <div v-else-if="!videos.length" class="hint">{{ tab === 'search' ? '没找到：换个词，或者在 B 站搜到以后用"贴链接"' : '这个分类是空的' }}</div>
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
    <div v-if="tab !== 'search' && updated && !loading && !error" class="hint">片单每小时从 B 站更新 · {{ updated }}</div>
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
  font-size: 14px;
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
