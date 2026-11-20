<script setup lang="ts">
import type { Character } from '@app/shared';
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useCommunityStore } from '@/stores/community';
import { useSocialStore } from '@/stores/social';

const route = useRoute();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const social = useSocialStore();
const community = useCommunityStore();

interface Tab {
  to: string;
  label: string;
  icon: string;
  badge: number;
  dot?: boolean;
  /** 页签图标换成她的头像（聚焦主题的第一个页签） */
  avatar?: Character;
  /** 除了自己的路径，这些路径也算在这个页签下 */
  also?: string[];
}
const focused = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]);
const tabs = computed((): Tab[] => {
  const chats: Tab = { to: '/chats', label: '消息', icon: 'i-lucide-message-circle', badge: chat.totalUnread };
  // 社媒（朋友圈 + 社群）：有没看过的（她们新发的、新回你的，你加入的社群里的新帖）时显示条数
  const socialTab: Tab = { to: '/social', label: '社媒', icon: 'i-lucide-aperture', badge: social.unread + community.unread };
  const tail: Tab[] = [
    { to: '/memories', label: '回忆', icon: 'i-lucide-book-heart', badge: 0, dot: true },
    { to: '/me', label: '我的', icon: 'i-lucide-user-round', badge: 0 },
  ];
  // 主题（我的 → 主题）：三种主题页签顺序一样；"地图"去哪见 app.mapPath
  const map: Tab = { to: app.mapPath, label: '地图', icon: 'i-lucide-map', badge: 0, also: ['/map', '/world'] };
  // 聚焦：第一个页签是她（头像 + 名字），消息列表收在她页面的"换人"面板里，也算在这个页签下
  if (app.homeTheme === 'focus') {
    const her: Tab = { to: '/focus', label: focused.value?.name ?? '消息', icon: 'i-lucide-message-circle', badge: chat.totalUnread, avatar: focused.value, also: ['/chats'] };
    return [her, socialTab, map, ...tail];
  }
  return [chats, socialTab, map, ...tail];
});
function isActive(t: Tab): boolean {
  return [t.to, ...(t.also ?? [])].some((p) => route.path === p || route.path.startsWith(`${p}/`));
}
/** 聚焦主题的首页铺满整屏：两侧的按钮代替页签 */
const immersive = computed(() => app.homeTheme === 'focus' && route.path === '/focus');
</script>

<template>
  <div class="tab-layout">
    <main class="tab-main">
      <RouterView />
    </main>
    <nav v-show="!immersive" class="tabbar" aria-label="主导航">
      <RouterLink v-for="t in tabs" :key="t.to" :to="t.to" class="tab-item" :class="{ 'is-active': isActive(t) }">
        <span class="relative">
          <Avatar v-if="t.avatar" :character="t.avatar" :size="24" class="tab-avatar" />
          <span v-else :class="t.icon" class="text-[22px]" />
          <span v-if="t.badge" class="badge num">{{ t.badge > 99 ? '99+' : t.badge }}</span>
          <span v-else-if="t.dot" class="dot" />
        </span>
        <span class="tab-label text-[11px] mt-0.5">{{ t.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>

<style scoped>
.tab-layout {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
}
.tab-main {
  position: relative;
  flex: 1;
  min-height: 0;
}
.tabbar {
  flex-shrink: 0;
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  height: calc(var(--tabbar-h) + var(--safe-bottom));
  padding-bottom: var(--safe-bottom);
  background: var(--glass-strong);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border-top: 1px solid var(--glass-line);
}
.tab-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--ink-3);
  text-decoration: none;
  transition: color 0.2s;
}
.tab-item.is-active {
  color: var(--accent-ink);
}
.tab-avatar {
  display: block;
  opacity: 0.72;
  transition: opacity 0.2s;
}
.is-active .tab-avatar {
  opacity: 1;
  box-shadow: 0 0 0 1.5px var(--accent);
}
.tab-label {
  max-width: 100%;
  padding: 0 2px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.badge {
  position: absolute;
  top: -4px;
  left: 14px;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 10.5px;
  line-height: 17px;
  text-align: center;
}
.dot {
  position: absolute;
  top: -1px;
  right: -3px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
}
</style>
