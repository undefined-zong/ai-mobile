<script setup lang="ts">
import { zonedDateKey, type Character } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import AssetImg from '@/components/common/AssetImg.vue';
import HScroll from '@/components/common/HScroll.vue';
import { assetUrl } from '@/services';
import { previewImages, type ViewerImage } from '@/services/imageViewer';
import { albumScene, useAlbumStore, type AlbumItem } from '@/stores/album';
import { useCharacterStore } from '@/stores/characters';
import { useEnvironmentStore } from '@/stores/environment';

/**
 * 回忆 → 相册：你从生成的图里存下来的（看大图时点"存到相册"）。
 * - 搜：按字（标题、画面、场景、地点、日期"11-18""11月18日"）、按哪一天、按场景；默认只看这个角色的，可以切成全部；
 * - 整理：每张右上角能删；按住左上角的把手拖动换位置（电脑上鼠标拖整张也行；把手上按方向键挪一格）。
 */
const props = defineProps<{ character: Character }>();
const album = useAlbumStore();
const chars = useCharacterStore();
const tz = computed(() => useEnvironmentStore().settings.timezone);

const keyword = ref('');
const day = ref('');
const scene = ref('all');
const everyone = ref(false);
const editing = ref(false);
watch(() => props.character.id, () => {
  scene.value = 'all';
  editing.value = false;
});

const dateOf = (i: AlbumItem) => zonedDateKey(i.at, tz.value);
/** 这个人的（或者全部） */
const mine = computed(() => album.sorted.filter((i) => everyone.value || i.characterId === props.character.id));
/** 这些图里有哪些场景（筛选用，多的在前） */
const scenes = computed(() => {
  const count = new Map<string, number>();
  for (const i of mine.value) count.set(i.scene, (count.get(i.scene) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, n, ...albumScene(id) }));
});
watch(scenes, (list) => {
  if (scene.value !== 'all' && !list.some((s) => s.id === scene.value)) scene.value = 'all';
});

/** 一张图能被搜到的字：标题、画面、场景名、地点、谁、日期的几种写法 */
function haystack(i: AlbumItem): string {
  const d = dateOf(i);
  const [y, m, dd] = d.split('-').map(Number);
  return [i.title, i.caption, albumScene(i.scene).label, i.place ?? '', chars.byId(i.characterId ?? '')?.name ?? '', d, d.slice(5), `${m}月${dd}日`, `${m}月${dd}号`, `${y}年${m}月`, `${m}月`].join(' ').toLowerCase();
}
const filtered = computed(() => {
  const k = keyword.value.trim().toLowerCase();
  const words = k.split(/\s+/).filter(Boolean);
  return mine.value.filter((i) => (scene.value === 'all' || i.scene === scene.value) && (!day.value || dateOf(i) === day.value) && words.every((w) => haystack(i).includes(w)));
});
const searching = computed(() => !!keyword.value.trim() || !!day.value || scene.value !== 'all');

// —— 拖动排序：按住把手（或者电脑上按住整张）拖，经过别的图时换位置，松手时存 ——
const gridEl = ref<HTMLElement | null>(null);
const live = ref<string[] | null>(null);
const shown = computed(() => {
  if (!live.value) return filtered.value;
  const byId = new Map(filtered.value.map((i) => [i.id, i]));
  return live.value.map((id) => byId.get(id)).filter((i): i is AlbumItem => !!i);
});
const drag = ref<{ id: string; pointerId: number; grabX: number; grabY: number; x: number; y: number; started: boolean; startX: number; startY: number } | null>(null);
const dragStyle = ref<Record<string, string>>({});
let raf = 0;

function tileEl(id: string): HTMLElement | null {
  return gridEl.value?.querySelector<HTMLElement>(`[data-album-id="${CSS.escape(id)}"]`) ?? null;
}
function place() {
  const d = drag.value;
  const el = d && tileEl(d.id);
  const grid = gridEl.value;
  if (!d || !el || !grid) return;
  const box = grid.getBoundingClientRect();
  dragStyle.value = { transform: `translate3d(${d.x - box.left - d.grabX - el.offsetLeft}px, ${d.y - box.top - d.grabY - el.offsetTop}px, 0) scale(1.04)` };
}
function onDown(e: PointerEvent, item: AlbumItem, handle: boolean) {
  if (!editing.value || drag.value || e.button !== 0) return;
  // 手指只从把手拖（整张拖会和翻页抢）；鼠标整张都能拖
  if (e.pointerType === 'touch' && !handle) return;
  const el = tileEl(item.id);
  if (!el) return;
  const r = el.getBoundingClientRect();
  drag.value = { id: item.id, pointerId: e.pointerId, grabX: e.clientX - r.left, grabY: e.clientY - r.top, x: e.clientX, y: e.clientY, started: handle, startX: e.clientX, startY: e.clientY };
  if (handle) begin();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onCancel);
}
function begin() {
  if (!drag.value) return;
  drag.value.started = true;
  live.value = filtered.value.map((i) => i.id);
  document.documentElement.classList.add('is-sorting');
  if ('vibrate' in navigator) navigator.vibrate(10);
  raf = requestAnimationFrame(autoScroll);
  place();
}
function onMove(e: PointerEvent) {
  const d = drag.value;
  if (!d || e.pointerId !== d.pointerId) return;
  d.x = e.clientX;
  d.y = e.clientY;
  if (!d.started) {
    if (Math.hypot(d.x - d.startX, d.y - d.startY) < 5) return;
    begin();
  }
  e.preventDefault();
  // 手指下面是哪一张：换到它的位置
  const over = document.elementsFromPoint(d.x, d.y).map((n) => (n as HTMLElement).closest?.('[data-album-id]') as HTMLElement | null).find((n) => n && n.dataset.albumId !== d.id);
  const target = over?.dataset.albumId;
  if (target && live.value) {
    const from = live.value.indexOf(d.id);
    const to = live.value.indexOf(target);
    if (from >= 0 && to >= 0 && from !== to) {
      const next = live.value.slice();
      next.splice(to, 0, next.splice(from, 1)[0]!);
      live.value = next;
      void nextTick(place);
      return;
    }
  }
  place();
}
/** 拖到屏幕上下边缘时自动滚 */
function autoScroll() {
  const d = drag.value;
  if (!d?.started) return;
  const scroller = gridEl.value?.closest('.page-scroll') as HTMLElement | null;
  if (scroller) {
    const box = scroller.getBoundingClientRect();
    const edge = 70;
    const v = d.y < box.top + edge ? -Math.min(1, (box.top + edge - d.y) / edge) : d.y > box.bottom - edge ? Math.min(1, (d.y - (box.bottom - edge)) / edge) : 0;
    if (v) {
      scroller.scrollTop += v * 12;
      place();
    }
  }
  raf = requestAnimationFrame(autoScroll);
}
function finish(save: boolean) {
  const d = drag.value;
  window.removeEventListener('pointermove', onMove);
  window.removeEventListener('pointerup', onUp);
  window.removeEventListener('pointercancel', onCancel);
  cancelAnimationFrame(raf);
  document.documentElement.classList.remove('is-sorting');
  if (d?.started && save && live.value) {
    const before = filtered.value.map((i) => i.id).join();
    if (live.value.join() !== before) album.reorder(live.value);
    swallowClick = true;
    setTimeout(() => (swallowClick = false), 0);
  }
  drag.value = null;
  live.value = null;
  dragStyle.value = {};
}
const onUp = (e: PointerEvent) => { if (drag.value && e.pointerId === drag.value.pointerId) finish(true); };
const onCancel = (e: PointerEvent) => { if (drag.value && e.pointerId === drag.value.pointerId) finish(false); };
onBeforeUnmount(() => finish(false));
let swallowClick = false;

/** 把手上按方向键：挪一格 */
function onKey(e: KeyboardEvent, index: number) {
  const d = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : 0;
  if (!d) return;
  e.preventDefault();
  const ids = filtered.value.map((i) => i.id);
  const to = index + d;
  if (to < 0 || to >= ids.length) return;
  ids.splice(to, 0, ids.splice(index, 1)[0]!);
  album.reorder(ids);
  void nextTick(() => gridEl.value?.querySelectorAll<HTMLElement>('[data-sort-handle]')[to]?.focus());
}

// —— 看大图、删 ——
async function urlOf(i: AlbumItem): Promise<string | null> {
  return i.assetKey ? assetUrl(i.assetKey) : (i.url ?? null);
}
async function open(index: number) {
  if (swallowClick || editing.value) return;
  const list = shown.value;
  const out: ViewerImage[] = [];
  let start = 0;
  for (const [n, i] of list.entries()) {
    const url = await urlOf(i);
    if (!url) continue;
    if (n === index) start = out.length;
    const { id: _id, savedAt: _s, order: _o, ...draft } = i;
    out.push({ url, name: i.title || i.caption, label: [albumScene(i.scene).label, dateOf(i).slice(5)].join(' · '), album: draft });
  }
  if (out.length) previewImages(out, { startPosition: start });
  else showToast('本机找不到这张图了');
}
async function remove(i: AlbumItem) {
  const ok = await showConfirmDialog({ title: '从相册删掉这张？', message: '只是从相册里拿掉，聊天、场景、朋友圈里的原图还在。', confirmButtonText: '删掉', confirmButtonColor: 'var(--bad)' }).catch(() => false);
  if (ok) album.remove(i.id);
}
function clearSearch() {
  keyword.value = '';
  day.value = '';
  scene.value = 'all';
}
</script>

<template>
  <div class="px-4 mt-1" data-testid="album">
    <div class="search">
      <span class="i-lucide-search text-ink-3" />
      <input v-model="keyword" placeholder="搜标题、画面、地点、日期（11-18）" aria-label="搜相册" />
      <button v-if="keyword" type="button" class="clear" aria-label="清空" @click="keyword = ''"><span class="i-lucide-x" /></button>
    </div>
    <div class="flex items-center gap-2 mt-2.5">
      <label class="date-chip" :class="{ on: !!day }">
        <span class="i-lucide-calendar-days" />
        <input v-model="day" type="date" aria-label="按哪一天找" />
        <span v-if="!day" class="placeholder">按日期</span>
      </label>
      <button v-if="day" type="button" class="filter" aria-label="不限日期" @click="day = ''"><span class="i-lucide-x" /></button>
      <span class="flex-1" />
      <button type="button" class="filter" :class="{ on: everyone }" :aria-pressed="everyone" @click="everyone = !everyone">{{ everyone ? '全部角色' : `只看${character.name}` }}</button>
      <button type="button" class="filter" :class="{ on: editing }" :aria-pressed="editing" data-testid="album-edit" @click="editing = !editing">{{ editing ? '完成' : '整理' }}</button>
    </div>
    <HScroll v-if="scenes.length > 1" :active="scene" class="gap-2 pt-2.5" aria-label="按场景筛选">
      <button type="button" class="filter" :class="{ on: scene === 'all' }" @click="scene = 'all'">全部场景</button>
      <button v-for="s in scenes" :key="s.id" type="button" class="filter" :class="{ on: scene === s.id }" :aria-pressed="scene === s.id" @click="scene = s.id">
        <span :class="s.icon" class="mr-1" />{{ s.label }} <span class="num opacity-70">{{ s.n }}</span>
      </button>
    </HScroll>
    <p class="text-[12px] text-ink-3 m-0 mt-2.5 mb-2.5">
      <template v-if="editing">按住左上角的 <span class="i-lucide-grip align-[-2px]" /> 拖动换位置，右上角删掉</template>
      <template v-else-if="searching">找到 {{ filtered.length }} 张<button type="button" class="link ml-2" @click="clearSearch">清除筛选</button></template>
      <template v-else>{{ mine.length ? `${mine.length} 张 · 看大图时点「存到相册」存进来` : '' }}</template>
    </p>

    <div ref="gridEl" class="grid-album" :class="{ editing }">
      <div
        v-for="(a, i) in shown"
        :key="a.id"
        class="tile"
        :class="{ dragging: drag?.started && drag.id === a.id }"
        :data-album-id="a.id"
        :style="drag?.started && drag.id === a.id ? dragStyle : undefined"
        @pointerdown="onDown($event, a, false)"
      >
        <button type="button" class="shot press" :aria-label="`看大图：${a.title || a.caption}`" @click="open(i)">
          <AssetImg :asset-key="a.assetKey" :url="a.url" :alt="a.title || a.caption" />
        </button>
        <div class="text-[13px] font-600 mt-1.5 truncate">{{ a.title || a.caption || albumScene(a.scene).label }}</div>
        <div class="text-[11.5px] text-ink-3 num truncate">
          {{ dateOf(a).slice(5).replace('-', '/') }} · {{ albumScene(a.scene).label }}<template v-if="everyone && a.characterId && chars.byId(a.characterId)"> · {{ chars.byId(a.characterId)!.name }}</template>
        </div>
        <template v-if="editing">
          <button type="button" class="handle" data-sort-handle aria-label="拖动换位置（方向键挪一格）" @pointerdown.stop="onDown($event, a, true)" @keydown="onKey($event, i)"><span class="i-lucide-grip" /></button>
          <button type="button" class="del" :aria-label="`从相册删掉：${a.title || a.caption}`" @click.stop="remove(a)"><span class="i-lucide-x" /></button>
        </template>
      </div>
    </div>
    <p v-if="!shown.length" class="text-center text-ink-3 text-[13px] py-8 m-0 leading-relaxed">
      <template v-if="searching">没有找到</template>
      <template v-else>
        还没有存图<br />
        聊天配图、一起做事时画的、朋友圈和日记的配图，点开看大图时点「存到相册」就会存在这里
      </template>
    </p>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  background: var(--panel);
}
.search input {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  color: var(--ink);
  font-size: 16px;
}
.clear {
  color: var(--ink-3);
}
.filter {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.filter.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.date-chip {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  flex-shrink: 0;
}
.date-chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  box-shadow: inset 0 0 0 1.5px var(--accent);
}
.date-chip input {
  width: 118px;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 13px;
}
.date-chip:not(.on) input {
  position: absolute;
  inset: 0;
  width: 100%;
  opacity: 0;
}
.placeholder {
  pointer-events: none;
}
.link {
  color: var(--accent-ink);
  text-decoration: underline;
}
.grid-album {
  position: relative;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.tile {
  position: relative;
  min-width: 0;
}
.tile.dragging {
  z-index: 10;
  pointer-events: none;
  filter: drop-shadow(0 10px 18px rgba(0, 0, 0, 0.25));
}
.grid-album.editing .tile:not(.dragging) {
  transition: transform 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.shot {
  display: block;
  width: 100%;
  aspect-ratio: 3 / 4;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
}
.grid-album.editing .shot {
  cursor: grab;
}
.handle,
.del {
  position: absolute;
  top: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 16px;
  backdrop-filter: blur(6px);
}
.handle {
  left: 6px;
  cursor: grab;
  touch-action: none;
}
.del {
  right: 6px;
}
</style>
