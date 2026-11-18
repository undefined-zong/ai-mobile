<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { showToast } from 'vant';
import PageHeader from '@/layouts/PageHeader.vue';
import { getKeys } from '@/db/idb';
import { assetCache, CACHE_DAYS, cleanAssetCache, setCacheDays, type CacheDays } from '@/services/assetCache';
import { syncState } from '@/services/sync';
import { useHubStore } from '@/stores/hub';

/** 我的 → 图片缓存：这台设备上生成的图片、语音留几天（云端有一份，清掉的用到时再下载） */
const hub = useHubStore();
// 和别的页一样包一层 computed（模板里直接用模块里的 reactive 会被 vue-tsc 当成 ref）
const cache = computed(() => assetCache);
const sync = computed(() => syncState);
const count = ref<number | null>(null);
const usage = ref<number | null>(null);

const label = (d: CacheDays) => (d ? `保留 ${d} 天` : '一直保留');
/** 能清：连着云端、开着多设备同步、和这个 Worker 同步过 */
const active = computed(() => hub.connected && sync.value.supported && sync.value.enabled && sync.value.joined);
const why = computed(() => !hub.connected ? '还没连云端：清掉的图片没地方再下载，现在一张都不清。' : !sync.value.supported ? '云端的 Worker 还没有多设备同步，更新 Worker 后才能清。'
  : !sync.value.enabled ? '这台设备关了多设备同步，现在一张都不清。' : !sync.value.joined ? '和云端第一次同步完以后才开始清。' : '');
const mb = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`);

async function refresh() {
  try { count.value = (await getKeys('assets')).length; } catch { count.value = null; }
  try { usage.value = (await navigator.storage?.estimate?.())?.usage ?? null; } catch { usage.value = null; }
}
onMounted(refresh);

async function choose(days: CacheDays) {
  if (days === assetCache.days) return;
  await setCacheDays(days);
  showToast(days ? `超过 ${days} 天没看过的会从这台设备清掉` : '这台设备上的图片一直留着');
}

async function cleanNow() {
  const removed = await cleanAssetCache();
  await refresh();
  showToast(removed ? `清掉了 ${removed} 个，用到时会从云端下载回来` : '没有要清的');
}
</script>

<template>
  <div class="page" data-page="cache">
    <PageHeader title="图片缓存" subtitle="这台设备上的图片、语音留几天" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">留多久</div>
      <van-cell-group inset>
        <van-cell v-for="d in CACHE_DAYS" :key="d" :title="label(d)" clickable :data-days="d" @click="choose(d)">
          <template #right-icon><span v-if="cache.days === d" class="i-lucide-check text-accent-ink text-[18px]" /></template>
        </van-cell>
      </van-cell-group>
      <p class="note">连着云端时，生成的图片、语音和拍的照片在云端都有一份。这台设备只留最近用过的：超过上面的天数没看过的从本机清掉，下次看到时自动从云端下载回来。角色的立绘一直留着。</p>
      <p class="note">只清云端已经有完整一份的；清掉的只是这台设备上的，不会从云端和别的设备上删掉。每台设备各自设置。清掉的不在本机，导出备份时不会带上（云端还有）。</p>
      <p v-if="why" class="note text-warn">{{ why }}</p>

      <div class="group-title">这台设备</div>
      <van-cell-group inset>
        <van-cell title="本机的图片和语音" :value="count === null ? '—' : `${count} 个`" />
        <van-cell title="App 一共占用" :value="usage === null ? '—' : `约 ${mb(usage)}`" label="包括聊天记录和所有本机数据" />
        <van-cell v-if="cache.last" title="上次清理" :value="`${new Date(cache.last.at).toLocaleString()} · ${cache.last.removed} 个`" />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="cache.cleaning" :disabled="!active || !cache.days" data-testid="cache-clean" @click="cleanNow">现在清理</van-button>
      </div>
      <p class="note">打开 App 一分钟后和之后每 6 小时会自动清一次。</p>
    </div>
  </div>
</template>
