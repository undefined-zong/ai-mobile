<script setup lang="ts">
import { computed } from 'vue';
import { useCommunityStore } from '@/stores/community';
import { useSocialStore } from '@/stores/social';

/**
 * 社媒（底部页签）：朋友圈和社群两页，各是一个子路由——从社群里返回时还停在社群那一页。
 * 右上角的按钮由当前那一页自己放进来（Teleport 到 #social-actions）。
 */
const social = useSocialStore();
const community = useCommunityStore();

const tabs = computed(() => [
  { to: '/social/moments', label: '朋友圈', icon: 'i-lucide-aperture', badge: social.unread },
  { to: '/social/communities', label: '社群', icon: 'i-lucide-users-round', badge: community.unread },
]);
</script>

<template>
  <div class="page" data-page="social">
    <header class="gutter pt-[calc(var(--safe-top)+14px)]">
      <div class="flex items-end gap-2">
        <h1 class="m-0 text-[28px] font-700 leading-tight flex-1 min-w-0">社媒</h1>
        <div id="social-actions" class="flex shrink-0" />
      </div>
      <nav class="seg" aria-label="社媒的两页">
        <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" replace class="seg-item" active-class="on">
          <span :class="t.icon" class="text-[15px]" />
          <span>{{ t.label }}</span>
          <span v-if="t.badge" class="badge num">{{ t.badge > 99 ? '99+' : t.badge }}</span>
        </RouterLink>
      </nav>
    </header>
    <RouterView />
  </div>
</template>

<style scoped>
.seg {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 4px;
  margin: 10px 0 8px;
  padding: 4px;
  border-radius: 14px;
  background: var(--panel);
}
.seg-item {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 34px;
  border-radius: 10px;
  color: var(--ink-3);
  font-size: 14px;
  text-decoration: none;
  transition:
    background 0.2s,
    color 0.2s;
}
.seg-item.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
.badge {
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 10.5px;
  font-weight: 400;
  line-height: 17px;
  text-align: center;
}
</style>
