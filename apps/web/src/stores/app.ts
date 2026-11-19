import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { ThemeName } from '@/utils/color';

export type ThemeSetting = 'system' | 'dark' | 'light';

const THEME_KEY = 'ai-mobile:theme';

function readThemeSetting(): ThemeSetting {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    // 无痕模式等情况下 localStorage 不可用
  }
  return 'system';
}

/**
 * 主题（首页长什么样，和昼 / 夜配色无关）：
 * - classic 经典：消息是首页，"地图"页签里看她的世界、选活动
 * - pixel 像素小镇："世界"页签是首页，上面是她的像素小镇，下面一键直达
 * - focus 聚焦：打开就是她（她此刻在的地方、她刚说的话），上滑是完整对话，"一起"就地开始；别的页面放在两侧
 * 只存在这台设备上，和配色设置一样
 */
export type HomeTheme = 'classic' | 'pixel' | 'focus';
export const HOME_THEME_LABEL: Record<HomeTheme, string> = { classic: '经典', pixel: '像素小镇', focus: '聚焦' };
/** 各主题的首页 */
const HOME_PATH: Record<HomeTheme, string> = { classic: '/chats', pixel: '/world', focus: '/focus' };
/** 底部"地图"页签去哪：像素小镇是她的像素小镇，"我的世界"的真实地图仍是 /map（从像素小镇的切换面板进） */
const MAP_PATH: Record<HomeTheme, string> = { classic: '/map', pixel: '/world', focus: '/map' };
const HOME_THEME_KEY = 'ai-mobile:home-theme';

function readHomeTheme(): HomeTheme {
  try {
    const v = localStorage.getItem(HOME_THEME_KEY);
    if (v && Object.hasOwn(HOME_THEME_LABEL, v)) return v as HomeTheme;
  } catch {
    // 无痕模式等情况下 localStorage 不可用
  }
  return 'classic';
}

export interface Banner {
  id: number;
  characterId: string;
  title: string;
  text: string;
  /** 点横幅去哪 */
  to: string;
  icon?: string;
}

export const useAppStore = defineStore('app', () => {
  const root = document.documentElement;
  const themeSetting = ref<ThemeSetting>(readThemeSetting());
  /** 宿主页面（例如 Artifact 查看器）自己设的 data-theme，"跟随系统"时尊重它 */
  const hostTheme = ref<string | null>(root.getAttribute('data-theme'));
  const media = window.matchMedia?.('(prefers-color-scheme: dark)');
  const systemDark = ref(media ? media.matches : true);
  media?.addEventListener?.('change', (e) => {
    systemDark.value = e.matches;
  });

  new MutationObserver(() => {
    const v = root.getAttribute('data-theme');
    if (themeSetting.value === 'system') {
      hostTheme.value = v;
      return;
    }
    if (v !== themeSetting.value) {
      hostTheme.value = v;
      root.setAttribute('data-theme', themeSetting.value);
    }
  }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });

  const resolvedTheme = computed<ThemeName>(() => {
    if (themeSetting.value !== 'system') return themeSetting.value;
    if (hostTheme.value === 'dark' || hostTheme.value === 'light') return hostTheme.value;
    return systemDark.value ? 'dark' : 'light';
  });

  function applyTheme() {
    if (themeSetting.value === 'system') {
      if (hostTheme.value) root.setAttribute('data-theme', hostTheme.value);
      else root.removeAttribute('data-theme');
    } else {
      root.setAttribute('data-theme', themeSetting.value);
    }
  }

  function setTheme(t: ThemeSetting) {
    themeSetting.value = t;
    try {
      localStorage.setItem(THEME_KEY, t);
    } catch {
      // 忽略
    }
    applyTheme();
  }

  applyTheme();
  // 地址栏颜色（meta theme-color）跟着配色走，在 stores/appearance.ts 里设

  const homeTheme = ref<HomeTheme>(readHomeTheme());
  /** 首页在哪：经典是消息页，像素小镇是世界页，聚焦是她 */
  const homePath = computed(() => HOME_PATH[homeTheme.value]);
  const mapPath = computed(() => MAP_PATH[homeTheme.value]);
  function setHomeTheme(t: HomeTheme) {
    homeTheme.value = t;
    try {
      localStorage.setItem(HOME_THEME_KEY, t);
    } catch {
      // 忽略
    }
  }

  /** "一起"和"回忆"页当前陪着你的角色；启动时换成最近聊过的那个（main.ts） */
  const activeCharacterId = ref('suwan');
  /** 正在看的聊天（聊天页打开时设置）：主动消息发到这条聊天时不弹横幅、直接算已读 */
  const viewingChatId = ref<string | null>(null);

  /** 应用内横幅：在别的页面时收到主动消息 / 来电 */
  const banner = ref<Banner | null>(null);
  let bannerTimer: ReturnType<typeof setTimeout> | undefined;
  function showBanner(b: Omit<Banner, 'id'>, ms = 6000) {
    banner.value = { ...b, id: Date.now() };
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => {
      banner.value = null;
    }, ms);
  }
  function dismissBanner() {
    banner.value = null;
  }

  return {
    themeSetting,
    resolvedTheme,
    setTheme,
    homeTheme,
    homePath,
    mapPath,
    setHomeTheme,
    activeCharacterId,
    viewingChatId,
    banner,
    showBanner,
    dismissBanner,
  };
});
