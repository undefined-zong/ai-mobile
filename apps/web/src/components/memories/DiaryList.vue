<script setup lang="ts">
import { DIARY_TIME_LABEL, diaryEnabled, diaryImageOn, rhythmDate, shiftDate, type Character, type DiaryEntry } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, onMounted, ref, watch } from 'vue';
import AssetImg from '@/components/common/AssetImg.vue';
import { assetUrl } from '@/services';
import { diaryStatus, drawDiaryImage, writeDiary } from '@/services/diary';
import { previewImages, type ViewerImage } from '@/services/imageViewer';
import { useCharacterStore } from '@/stores/characters';
import { useDiaryStore } from '@/stores/diary';
import { useEnvironmentStore } from '@/stores/environment';
import { useHubStore } from '@/stores/hub';
import { showErrorDialog } from '@/utils/errors';

/**
 * 回忆 → 日记：这个角色写的日记（新的在前）。开着"主动写日记"时每晚 22:00 写一篇；也能让Ta现在写。
 * 点一篇展开全文；配图点开看大图（能重新生成、存到相册）；⋯ 里能重写、删掉。
 */
const props = defineProps<{ character: Character }>();
const store = useDiaryStore();
const hub = useHubStore();
const chars = useCharacterStore();
const env = useEnvironmentStore();

const list = computed(() => store.of(props.character.id));
const enabled = computed(() => diaryEnabled(props.character));
const status = computed(() => diaryStatus(props.character));
const writing = computed(() => !!store.busy[`write:${props.character.id}`]);
const failure = computed(() => store.failures[`write:${props.character.id}`]);
const cloudErrors = computed(() => hub.diaryErrors.filter((e) => e.characterId === props.character.id));
const today = computed(() => rhythmDate(new Date(), env.settings.timezone));

const expanded = ref<string | null>(null);
watch(() => props.character.id, () => (expanded.value = list.value[0]?.id ?? null), { immediate: true });
// 看过了：未读的标成已读
onMounted(() => store.markRead(props.character.id));
watch(() => [props.character.id, list.value.length], () => store.markRead(props.character.id));

function toggleEnabled(on: boolean) {
  const c = chars.byId(props.character.id);
  if (!c) return;
  c.diary = { enabled: on, image: diaryImageOn(c) };
  c.updatedAt = Date.now();
  showToast(on ? `${c.name}每晚 ${DIARY_TIME_LABEL} 会写日记` : `${c.name}不再每晚写日记了（写过的还在）`);
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
function dateLabel(date: string): string {
  if (date === today.value) return '今天';
  if (date === shiftDate(today.value, -1)) return '昨天';
  const [y, m, d] = date.split('-').map(Number);
  const week = WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? '';
  return `${y !== Number(today.value.slice(0, 4)) ? `${y}年` : ''}${m}月${d}日 ${week}`;
}
function weatherIcon(w: string): string {
  if (/雷/.test(w)) return 'i-lucide-cloud-lightning';
  if (/雪/.test(w)) return 'i-lucide-snowflake';
  if (/雨/.test(w)) return 'i-lucide-cloud-rain';
  if (/雾|霾/.test(w)) return 'i-lucide-cloud-fog';
  if (/阴|云/.test(w)) return 'i-lucide-cloud';
  if (/晴/.test(w)) return 'i-lucide-sun';
  return 'i-lucide-cloud-sun';
}

/** 让Ta现在写（今天的已经写过就问一下要不要重写） */
async function writeNow(date = today.value) {
  if (!status.value.ok) {
    showErrorDialog('现在写不了', status.value.reason);
    return;
  }
  const old = store.byId(`diary:${props.character.id}:${date}`);
  if (old) {
    const ok = await showConfirmDialog({ title: `重写${dateLabel(date)}的日记？`, message: '这一篇会换成新写的（配图也重新画）。', confirmButtonText: '重写' }).catch(() => false);
    if (!ok) return;
  }
  const r = await writeDiary(props.character.id, { date });
  if (!r.ok) showErrorDialog('没写成', r.reason);
  else {
    expanded.value = r.entry.id;
    showToast(`${props.character.name}写好了`);
  }
}

// —— 配图 ——
const drawingKey = (e: DiaryEntry, i = 0) => `image:${e.id}:${i}`;
async function draw(e: DiaryEntry, redo = false) {
  const r = await drawDiaryImage(e.id, 0, 'user', { redo });
  if (!r.ok) showToast({ message: `没画成：${r.reason}`, duration: 3500 });
}
async function viewerOf(e: DiaryEntry): Promise<ViewerImage | null> {
  const img = store.byId(e.id)?.images?.[0];
  if (!img || (!img.assetKey && !img.url)) return null;
  const url = img.assetKey ? await assetUrl(img.assetKey) : (img.url ?? null);
  if (!url) return null;
  return {
    url,
    name: img.title || e.title || `${props.character.name}的日记`,
    redraw: async () => {
      const r = await drawDiaryImage(e.id, 0, 'user', { redo: true });
      if (!r.ok) throw new Error(r.reason);
      return viewerOf(e);
    },
    album: {
      assetKey: img.assetKey, ...(img.url ? { url: img.url } : {}), characterId: e.characterId,
      title: img.title || e.title || `${dateLabel(e.date)}的日记`, caption: img.caption, scene: 'diary', at: e.createdAt,
    },
  };
}
async function openImage(e: DiaryEntry) {
  const v = await viewerOf(e);
  if (v) previewImages([v]);
  else showToast('本机找不到这张图了');
}

// —— 更多：重写、删掉 ——
const actionFor = ref<DiaryEntry | null>(null);
const actionOpen = computed({ get: () => !!actionFor.value, set: (v) => { if (!v) actionFor.value = null; } });
const actions = computed(() => {
  const e = actionFor.value;
  if (!e) return [];
  return [
    { name: '重写这一篇', key: 'rewrite' },
    ...(e.images?.[0] && (e.images[0].assetKey || e.images[0].url) ? [{ name: '重画配图', key: 'redraw' }] : []),
    { name: '删掉这一篇', key: 'remove', color: 'var(--bad)' },
  ];
});
async function onAction(a: { key: string }) {
  const e = actionFor.value;
  actionFor.value = null;
  if (!e) return;
  if (a.key === 'rewrite') await writeNow(e.date);
  else if (a.key === 'redraw') await draw(e, true);
  else if (a.key === 'remove') {
    const ok = await showConfirmDialog({ title: '删掉这一篇日记？', message: `${dateLabel(e.date)}的日记会从所有设备上删掉，删了不会再自动补写这一天。`, confirmButtonText: '删掉', confirmButtonColor: 'var(--bad)' }).catch(() => false);
    if (ok) store.remove(e.id);
  }
}
</script>

<template>
  <div class="px-4 grid gap-3 mt-1" data-testid="diary-list">
    <div class="diary-head">
      <div class="flex-1 min-w-0">
        <div class="text-[14.5px] font-600">每晚 {{ DIARY_TIME_LABEL }} 写日记</div>
        <div class="text-[12px] text-ink-3 leading-snug mt-0.5">
          {{ enabled ? `${character.name}按今天的节律写自己的一天${hub.connected && hub.supportsDiary ? '（云端写，App 关着也写）' : '（App 开着时写，没开第二天上午补写）'}` : `开了以后${character.name}每晚写一篇当天的日记，可以配图` }}
        </div>
      </div>
      <van-switch :model-value="enabled" size="22px" aria-label="主动写日记" data-testid="diary-toggle" @update:model-value="toggleEnabled" />
    </div>
    <div class="flex gap-2">
      <van-button size="small" round icon="edit" :loading="writing" loading-text="正在写…" data-testid="diary-write" @click="writeNow()">让{{ character.pronoun }}现在写一篇</van-button>
      <RouterLink to="/me/presets?cat=diary" class="mini-link">日记预设</RouterLink>
      <RouterLink to="/me/api" class="mini-link">日记 API</RouterLink>
    </div>
    <p v-if="!status.ok" class="note warn">{{ status.reason }}</p>
    <p v-else-if="failure" class="note warn" role="alert">上一次没写成：{{ failure }}</p>
    <p v-for="e in cloudErrors" :key="e.date" class="note warn">{{ dateLabel(e.date) }}：{{ e.reason }}</p>

    <article v-for="d in list" :key="d.id" class="diary" :class="{ unread: d.unread }" :data-diary="d.date">
      <div class="flex items-center gap-2 text-[12.5px] text-ink-3">
        <button type="button" class="flex items-center gap-2 flex-1 min-w-0 text-left" :aria-expanded="expanded === d.id" @click="expanded = expanded === d.id ? null : d.id">
          <span class="text-[15px] font-600 text-ink shrink-0">{{ dateLabel(d.date) }}</span>
          <template v-if="d.weather"><span :class="weatherIcon(d.weather)" />{{ d.weather }}</template>
          <span v-if="d.mood" class="mood-chip">{{ d.mood }}</span>
        </button>
        <button type="button" class="more" aria-label="这一篇的更多操作" @click="actionFor = d"><span class="i-lucide-ellipsis" /></button>
      </div>
      <div v-if="d.title" class="serif text-[16px] font-600 mt-2">{{ d.title }}</div>
      <p class="serif diary-text" :class="{ clamp: expanded !== d.id }" @click="expanded = expanded === d.id ? null : d.id">{{ d.text }}</p>

      <template v-for="img in (d.images ?? []).slice(0, 1)" :key="img.caption">
        <button v-if="img.assetKey || img.url" type="button" class="polaroid press" :aria-label="`看大图：${img.title || img.caption}`" @click="openImage(d)">
          <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.title || img.caption" />
          <span v-if="store.busy[drawingKey(d)]" class="redrawing"><van-loading size="16" color="#fff" />正在重画…</span>
        </button>
        <div v-else class="pending-img">
          <span class="i-lucide-image text-[18px] text-ink-3 shrink-0" />
          <div class="flex-1 min-w-0 text-[12.5px] text-ink-2 leading-snug">
            <div class="truncate">{{ img.caption }}</div>
            <div v-if="img.error && !store.busy[drawingKey(d)]" class="text-warn mt-0.5">{{ img.error }}</div>
          </div>
          <van-button size="mini" round :loading="!!store.busy[drawingKey(d)]" @click="draw(d)">画这张图</van-button>
        </div>
      </template>

      <div v-if="d.highlights.length" class="flex flex-wrap gap-1.5 mt-2">
        <span v-for="h in d.highlights" :key="h" class="chip !h-6">{{ h }}</span>
      </div>
      <div v-if="expanded === d.id && d.model" class="text-[11px] text-ink-3 mt-2">{{ d.source === 'hub' ? '云端写的' : '这台设备写的' }} · {{ d.model }}</div>
    </article>
    <p v-if="!list.length" class="text-center text-ink-3 text-[13px] py-6 m-0">
      {{ character.name }}还没写过日记。{{ enabled ? `今晚 ${DIARY_TIME_LABEL} 会写第一篇，也可以让${character.pronoun}现在写。` : `打开上面的开关，或者让${character.pronoun}现在写一篇。` }}
    </p>

    <van-action-sheet v-model:show="actionOpen" :actions="actions" cancel-text="取消" close-on-click-action @select="onAction" />
  </div>
</template>

<style scoped>
.diary-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.mini-link {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  text-decoration: none;
}
.note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.note.warn {
  color: var(--warn);
}
.diary {
  display: block;
  padding: 14px 16px;
  border-radius: 20px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.diary.unread {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 1px var(--accent-line);
}
.more {
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  color: var(--ink-3);
  flex-shrink: 0;
}
.mood-chip {
  padding: 1px 8px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  white-space: nowrap;
}
.diary-text {
  margin: 10px 0 0;
  font-size: 15px;
  line-height: 1.9;
  color: var(--ink);
  white-space: pre-line;
  cursor: pointer;
}
.diary-text.clamp {
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.polaroid {
  position: relative;
  display: block;
  width: min(72%, 260px);
  aspect-ratio: 3 / 4;
  margin: 12px auto 4px;
  padding: 8px 8px 26px;
  border-radius: 6px;
  background: #fbfaf7;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.14);
  transform: rotate(-1.5deg);
  overflow: hidden;
}
.polaroid :deep(.asset-img),
.polaroid :deep(.asset-missing) {
  border-radius: 2px;
}
.redrawing {
  position: absolute;
  inset: auto 8px 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 4px 0;
  border-radius: 8px;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 12px;
}
.pending-img {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
}
</style>
