<script setup lang="ts">
import { previewImages } from '@/services/imageViewer';
import type { BackgroundPeriod, TimeOfDay } from '@app/shared';
import { computed, ref, watch } from 'vue';

import { BACKGROUND_ASSETS, BACKGROUND_GROUPS, BACKGROUND_PERIOD_LABEL, BACKGROUND_SETS, backgroundUrl, pickBackground, type BackgroundAsset } from '@/backgrounds/library';
import Segmented from '@/components/common/Segmented.vue';
import SceneBackdrop from '@/components/figure/SceneBackdrop.vue';
import PageHeader from '@/layouts/PageHeader.vue';

const placeName = ref('咖啡店');
const worldHint = ref('');
const time = ref<TimeOfDay>('afternoon');
const place = computed(() => ({ id: 'library-preview', name: placeName.value }));
const match = computed(() => pickBackground({ ...place.value, kind: 'room', context: worldHint.value }, time.value));
const query = ref('');
const group = ref('');
const period = ref<BackgroundPeriod | ''>('');
const visibleCount = ref(24);
const filtered = computed(() => {
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return BACKGROUND_ASSETS.filter((a) => (!group.value || a.group === group.value)
    && (!period.value || a.period === period.value)
    && words.every((word) => `${a.scene} ${a.style} ${a.lighting} ${a.id}`.toLowerCase().includes(word)));
});
const visible = computed(() => filtered.value.slice(0, visibleCount.value));
watch([query, group, period], () => { visibleCount.value = 24; });
function open(asset: BackgroundAsset) {
  previewImages([backgroundUrl(asset)]);
}
</script>

<template>
  <div class="page" data-page="background-library">
    <PageHeader title="场景素材库" fallback="/me/appearance" />
    <div class="page-scroll library-scroll">
      <p class="intro">{{ BACKGROUND_ASSETS.length }} 张背景，{{ BACKGROUND_SETS.length }} 个系列。进入地点后，背景会按地点、世界观和当前时段自动选择。</p>

      <h2>试试不同的地点</h2>
      <van-cell-group inset class="!mx-0">
        <van-field v-model="placeName" label="地点" placeholder="例如：校医室、藏经阁、港口" clearable />
        <van-field v-model="worldHint" label="世界观" placeholder="例如：日式、古典、赛博" clearable />
      </van-cell-group>
      <Segmented v-model="time" class="time-picker" :options="[
        { value: 'afternoon', label: '日间', icon: 'i-lucide-sun' },
        { value: 'dusk', label: '黄昏', icon: 'i-lucide-sunset' },
        { value: 'night', label: '夜间', icon: 'i-lucide-moon' },
        { value: 'late', label: '深夜', icon: 'i-lucide-moon-star' },
      ]" />
      <button class="scene-preview" :aria-label="`查看${match.asset.scene}背景大图`" @click="open(match.asset)">
        <SceneBackdrop kind="room" :location="place" :context="worldHint" :tod="time" />
      </button>
      <p class="match-caption">{{ match.asset.scene }} · {{ match.asset.style }} · {{ BACKGROUND_PERIOD_LABEL[match.asset.period] }}<template v-if="match.asset.lighting"> · {{ match.asset.lighting }}</template></p>
      <p v-if="match.periodFallback" class="period-note">这个地点没有{{ BACKGROUND_PERIOD_LABEL[match.requestedPeriod] }}素材，显示最接近的已有画面。</p>

      <h2>全部素材</h2>
      <label class="search-label">
        <span class="i-lucide-search" aria-hidden="true" />
        <input v-model="query" type="search" aria-label="搜索场景或风格" placeholder="搜索场景、风格或素材编号" />
      </label>
      <div class="filters">
        <label>场景分类<select v-model="group"><option value="">全部分类</option><option v-for="item in BACKGROUND_GROUPS" :key="item" :value="item">{{ item }}</option></select></label>
        <label>素材时段<select v-model="period"><option value="">全部时段</option><option v-for="(label, key) in BACKGROUND_PERIOD_LABEL" :key="key" :value="key">{{ label }}</option></select></label>
      </div>
      <p class="result-count" aria-live="polite">{{ filtered.length }} 张素材</p>
      <div class="asset-grid">
        <button v-for="asset in visible" :key="asset.id" class="asset" :aria-label="`查看${asset.scene} ${asset.style} ${BACKGROUND_PERIOD_LABEL[asset.period]}`" @click="open(asset)">
          <img :src="backgroundUrl(asset)" :width="asset.width" :height="asset.height" alt="" loading="lazy" decoding="async" />
          <span class="asset-name">{{ asset.scene }} · {{ asset.style }}</span>
          <span class="asset-period">{{ BACKGROUND_PERIOD_LABEL[asset.period] }}<template v-if="asset.lighting"> · {{ asset.lighting }}</template></span>
        </button>
      </div>
      <p v-if="!filtered.length" class="empty">没有找到这类素材，换一个场景名或清除筛选试试。</p>
      <button v-if="visible.length < filtered.length" class="more" @click="visibleCount += 24">再看 24 张 <span class="i-lucide-chevron-down" aria-hidden="true" /></button>
    </div>
  </div>
</template>

<style scoped>
.library-scroll { padding: 4px 16px calc(28px + var(--safe-bottom)); }
.intro, .period-note { color: var(--ink-2); font-size: 13px; line-height: 1.65; margin: 0 0 18px; }
h2 { font-size: 16px; font-weight: 600; margin: 26px 0 12px; }
.time-picker { margin: 12px 0; }
.scene-preview { position: relative; width: 100%; aspect-ratio: 16 / 10; overflow: hidden; border-radius: 12px; background: var(--surface); }
.match-caption { color: var(--ink-2); font-size: 13px; line-height: 1.5; margin: 8px 0; }
.search-label { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); color: var(--ink-2); }
.search-label input { width: 100%; min-width: 0; background: transparent; border: 0; color: var(--ink); font: inherit; font-size: 16px; }
.filters { display: flex; gap: 12px; margin: 14px 0 8px; }
.filters label { flex: 1; min-width: 0; font-size: 12px; color: var(--ink-2); }
.filters select { display: block; width: 100%; min-height: 40px; margin-top: 5px; padding: 6px 8px; border: 1px solid var(--border); border-radius: 8px; color: var(--ink); background: var(--surface); font: inherit; font-size: 16px; }
.result-count { color: var(--ink-2); font-size: 12px; margin: 10px 0; }
.asset-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 12px; }
.asset { display: flex; flex-direction: column; text-align: left; min-width: 0; }
.asset img { width: 100%; height: auto; aspect-ratio: 3 / 2; object-fit: cover; background: var(--surface); border-radius: 8px; }
.asset-name { font-size: 13px; color: var(--ink); line-height: 1.45; margin-top: 7px; }
.asset-period { font-size: 12px; color: var(--ink-2); margin-top: 3px; }
.more { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; width: 100%; margin-top: 24px; border: 1px solid var(--border); border-radius: 12px; color: var(--accent-ink); background: var(--surface); }
.empty { padding: 32px 8px; text-align: center; color: var(--ink-2); font-size: 14px; }
button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
@media (min-width: 720px) { .asset-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
</style>
