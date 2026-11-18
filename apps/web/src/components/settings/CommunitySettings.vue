<script setup lang="ts">
import { COMMUNITY_LIMITS } from '@app/shared';
import { computed, watch } from 'vue';
import { communityStatus } from '@/services/community';
import { useCommunityStore } from '@/stores/community';
import { useHubStore } from '@/stores/hub';

/**
 * 社群设置（"我的 → 社媒"）：
 * - 你加入的社群每天最多更新几次、每次网友发几帖（云端每天在随机的时间发）；
 * - 你邀请进社群的角色每天最多发几帖；
 * - 给模型看最近几帖、聊天时带最近几帖、每个社群本机保留多少帖；
 * - 帖子的配图自动画、有新帖时通知。
 * 能填的范围在 @app/shared 的 COMMUNITY_LIMITS 里，界面、本机和云端用同一份。
 */
const store = useCommunityStore();
const hub = useHubStore();

const status = computed(() => communityStatus());
const cloud = computed(() => {
  if (!hub.connected) return { ok: false, text: '云端还没接通：App 关着时社群不会更新（App 开着时照样按这套时间发）。在"云端与同步"接通自己的 Worker 后，每天在随机的时间自动发。' };
  if (!hub.supportsCommunity) return { ok: false, text: '云端的 Worker 是旧版：部署最新的 Worker 和数据库迁移（0005_community）后才会自动发。' };
  if (hub.status?.lastCommunityError) return { ok: false, text: `云端上一轮：${hub.status.lastCommunityError}` };
  if (hub.communityErrors.length) return { ok: false, text: `云端有 ${hub.communityErrors.length} 批没发出来：${hub.communityErrors[0]?.reason}` };
  return { ok: true, text: '云端已接通：App 关着社群也会更新，打开 App 时收到。' };
});

const STEPPERS = [
  { key: 'perDay', label: '每天最多更新几次', note: '每个你加入的社群，每天实际更新 1 到这么多次，时间在你醒着的时段里随机' },
  { key: 'batchSize', label: '每次网友发几帖', note: '一次更新里不同的网友各发一帖' },
  { key: 'memberPerDay', label: '角色每天最多发几帖', note: '你邀请进社群的角色，每天在每个社群里发 0 到这么多帖；0 = 不自己发，只在你点"发一帖"时发' },
  { key: 'contextPosts', label: '给模型看最近几帖', note: '网友发帖、回应你时，把这个社群最近这么多帖发给模型（不重复、能接着聊）；越多越费 token，0 = 不给' },
  { key: 'chatPosts', label: '聊天时带最近几帖', note: '和Ta聊天时，Ta所在的每个社群带最近三天的这么多帖（你和Ta的优先）；0 = 只让Ta知道自己在哪些社群' },
  { key: 'keep', label: '每个社群保留最近几帖', note: '更早的从本机删掉（Ta们记住的不会跟着忘）' },
] as const;

// 调小"保留几帖"以后马上删掉超出的
watch(() => store.settings.keep, () => store.trim());
</script>

<template>
  <div class="sheet" data-sheet="community-settings">
    <div class="sheet-title">社群</div>
    <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="warn-line">{{ status.reason }} →</RouterLink>

    <div class="grid gap-2 mt-3">
      <div v-for="s in STEPPERS" :key="s.key" class="row">
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600">{{ s.label }}</div>
          <div class="text-[12px] text-ink-3 mt-0.5 leading-relaxed">{{ s.note }}</div>
        </div>
        <van-stepper v-model="store.settings[s.key]" :min="COMMUNITY_LIMITS[s.key].min" :max="COMMUNITY_LIMITS[s.key].max" integer :aria-label="s.label" />
      </div>
      <div class="row">
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600">配图自动画</div>
          <div class="text-[12px] text-ink-3 mt-0.5 leading-relaxed">帖子要配图时，收到就用"生图"画出来（用"社群配图"的生图预设）；关了就先显示要画的画面，点一下再画。</div>
        </div>
        <van-switch v-model="store.settings.autoImage" size="22" aria-label="配图自动画" />
      </div>
      <div class="row">
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600">有新帖时通知</div>
          <div class="text-[12px] text-ink-3 mt-0.5 leading-relaxed">云端替网友、替Ta们发了帖就推一条通知（要在"主动消息"里订阅过通知通道）。</div>
        </div>
        <van-switch v-model="store.settings.notify" size="22" aria-label="有新帖时通知" />
      </div>
    </div>
    <p class="note" :class="{ warn: !cloud.ok }">{{ cloud.text }}</p>
    <p class="note">现在加入了 {{ store.joined.length }} 个社群，本机一共 {{ store.posts.length }} 帖。发什么、多久配一次图和卡片、赞和顶给多少，都在"我的 → 预设 → 社媒 → 社群"用的那个预设里改。</p>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.note.warn {
  color: var(--warn);
}
.warn-line {
  display: block;
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
  text-decoration: none;
}
</style>
