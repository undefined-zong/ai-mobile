import { createMemoryHistory, createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router';
import TabLayout from '@/layouts/TabLayout.vue';
import CallPage from '@/pages/CallPage.vue';
import ChatPage from '@/pages/ChatPage.vue';
import ChatsPage from '@/pages/ChatsPage.vue';
import ImportPage from '@/pages/ImportPage.vue';
import MemoriesPage from '@/pages/MemoriesPage.vue';
import CommunitiesPage from '@/pages/CommunitiesPage.vue';
import CommunityPage from '@/pages/CommunityPage.vue';
import MomentsPage from '@/pages/MomentsPage.vue';
import SocialPage from '@/pages/SocialPage.vue';
import MePage from '@/pages/MePage.vue';
import PromptInspectorPage from '@/pages/PromptInspectorPage.vue';
import MapPage from '@/pages/MapPage.vue';
import ParallelPage from '@/pages/ParallelPage.vue';
import WorldPage from '@/pages/WorldPage.vue';
import FocusPage from '@/pages/FocusPage.vue';
import { useAppStore } from '@/stores/app';
import ScenePage from '@/pages/ScenePage.vue';
import ApiPage from '@/pages/me/ApiPage.vue';
import AppearancePage from '@/pages/me/AppearancePage.vue';
import AssistantPage from '@/pages/me/AssistantPage.vue';
import CharacterEditPage from '@/pages/me/CharacterEditPage.vue';
import CharactersPage from '@/pages/me/CharactersPage.vue';
import EnvironmentPage from '@/pages/me/EnvironmentPage.vue';
import InstallPage from '@/pages/me/InstallPage.vue';
import LorebookEditPage from '@/pages/me/LorebookEditPage.vue';
import LorebooksPage from '@/pages/me/LorebooksPage.vue';
import MessagesPage from '@/pages/me/MessagesPage.vue';
import ObfuscationPage from '@/pages/me/ObfuscationPage.vue';
import PersonasPage from '@/pages/me/PersonasPage.vue';
import PersonaHealthPage from '@/pages/me/PersonaHealthPage.vue';
import PersonaHouseworkPage from '@/pages/me/PersonaHouseworkPage.vue';
import HealthPlanPage from '@/pages/me/HealthPlanPage.vue';
import PersonaPlannerPage from '@/pages/me/PersonaPlannerPage.vue';
import PersonaImagePage from '@/pages/me/PersonaImagePage.vue';
import PlannerPage from '@/pages/me/PlannerPage.vue';
import PresetEditPage from '@/pages/me/PresetEditPage.vue';
import PresetsPage from '@/pages/me/PresetsPage.vue';
import ProactivePage from '@/pages/me/ProactivePage.vue';
import RhythmPage from '@/pages/me/RhythmPage.vue';
import ServicesPage from '@/pages/me/ServicesPage.vue';
import SyncPage from '@/pages/me/SyncPage.vue';
import BackupPage from '@/pages/me/BackupPage.vue';
import CachePage from '@/pages/me/CachePage.vue';
import VoicePage from '@/pages/me/VoicePage.vue';
import WatchSettingsPage from '@/pages/me/WatchSettingsPage.vue';
import ReadSettingsPage from '@/pages/me/ReadSettingsPage.vue';

/** 社媒上次停在哪一页（朋友圈 / 社群）：从别的页签回来时还在那一页 */
let lastSocial = '/social/moments';

export const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: TabLayout,
    // 首页跟着主题走：经典是消息页，像素小镇是世界页，聚焦是她
    redirect: () => useAppStore().homePath,
    children: [
      { path: 'world', component: WorldPage, meta: { title: '地图' } },
      { path: 'focus', component: FocusPage, meta: { title: 'Ta' } },
      { path: 'chats', component: ChatsPage, meta: { title: '消息' } },
      {
        path: 'social',
        component: SocialPage,
        redirect: () => lastSocial,
        children: [
          { path: 'moments', component: MomentsPage, meta: { title: '朋友圈' } },
          { path: 'communities', component: CommunitiesPage, meta: { title: '社群' } },
        ],
      },
      { path: 'map', component: MapPage, meta: { title: '地图' } },
      { path: 'memories', component: MemoriesPage, meta: { title: '回忆' } },
      { path: 'me', component: MePage, meta: { title: '我的' } },
    ],
  },
  { path: '/together', redirect: '/map' },
  // 以前的朋友圈页签（旧通知里的链接）
  { path: '/moments', redirect: '/social/moments' },
  { path: '/community/:id', component: CommunityPage, meta: { title: '社群' } },
  { path: '/chat/:id', component: ChatPage, meta: { title: '聊天' } },
  { path: '/chat/:id/inspect', component: PromptInspectorPage, meta: { title: '查看提示词' } },
  { path: '/call/:charId', component: CallPage, meta: { title: '语音通话' } },
  { path: '/scene/:sceneId', component: ScenePage, meta: { title: '场景' } },
  // 平行时空：她今天的节律和你今天的安排一左一右（地图上她的世界"一起做点什么"里紧挨着心跳）
  { path: '/parallel/:charId', component: ParallelPage, meta: { title: '平行时空' } },
  { path: '/me/characters', component: CharactersPage, meta: { title: '角色卡' } },
  { path: '/me/characters/:id', component: CharacterEditPage, meta: { title: '编辑角色' } },
  { path: '/me/personas', component: PersonasPage, meta: { title: '我的人设' } },
  { path: '/me/personas/:id/housework', component: PersonaHouseworkPage, meta: { title: '家务系统' } },
  { path: '/me/personas/:id/health', component: PersonaHealthPage, meta: { title: '健康系统' } },
  { path: '/me/health', component: HealthPlanPage, meta: { title: '健康计划' } },
  { path: '/me/personas/:id/planner', component: PersonaPlannerPage, meta: { title: '日程系统' } },
  { path: '/me/personas/:id/image', component: PersonaImagePage, meta: { title: '生图' } },
  { path: '/me/planner', component: PlannerPage, meta: { title: '日程计划' } },
  { path: '/me/lorebooks', component: LorebooksPage, meta: { title: '世界书' } },
  { path: '/me/lorebooks/:id', component: LorebookEditPage, meta: { title: '编辑世界书' } },
  { path: '/me/presets', component: PresetsPage, meta: { title: '预设' } },
  { path: '/me/presets/:id', component: PresetEditPage, meta: { title: '编辑预设' } },
  { path: '/me/messages', component: MessagesPage, meta: { title: '消息设置' } },
  { path: '/me/obfuscation', component: ObfuscationPage, meta: { title: '混淆设置' } },
  { path: '/me/api', component: ApiPage, meta: { title: 'API 设置' } },
  { path: '/me/voice', component: VoicePage, meta: { title: '语音' } },
  { path: '/me/proactive', component: ProactivePage, meta: { title: '主动消息' } },
  { path: '/me/rhythm', component: RhythmPage, meta: { title: '节律' } },
  { path: '/me/environment', component: EnvironmentPage, meta: { title: '环境与作息' } },
  { path: '/me/services', component: ServicesPage, meta: { title: '地图、天气、音乐' } },
  { path: '/me/watch', component: WatchSettingsPage, meta: { title: '观影设置' } },
  { path: '/me/read', component: ReadSettingsPage, meta: { title: '看书设置' } },
  { path: '/me/sync', component: SyncPage, meta: { title: '云端与同步' } },
  { path: '/me/backup', component: BackupPage, meta: { title: '导出与导入' } },
  { path: '/me/cache', component: CachePage, meta: { title: '图片缓存' } },
  { path: '/me/install', component: InstallPage, meta: { title: '装成 App' } },
  { path: '/me/appearance', component: AppearancePage, meta: { title: '外观' } },
  // 随主程序加载，避免发布后旧页面请求已被替换的助手分块而打不开。
  { path: '/me/assistant', component: AssistantPage, meta: { title: '助手' } },
  { path: '/me/backgrounds', component: () => import('@/pages/me/BackgroundLibraryPage.vue'), meta: { title: '场景素材库' } },
  { path: '/import', component: ImportPage, meta: { title: '导入' } },
  { path: '/:pathMatch(.*)*', redirect: () => useAppStore().homePath },
];

/** 预览页（Claude Artifact）不支持 #/path 形式的地址，改用内存路由；正式版用 hash 路由 */
const isPreview = import.meta.env.MODE === 'preview';

export const router = createRouter({
  history: isPreview ? createMemoryHistory() : createWebHashHistory(),
  routes,
  scrollBehavior: () => ({ top: 0 }),
});

/**
 * 内存路由没有"上一页"信息，自己记一个栈：
 * 同一路径只改查询参数（例如切换 IM / 剧场模式）时替换栈顶，返回时出栈。
 */
const stack: string[] = [];
let goingBack = false;

router.afterEach((to, _from, failure) => {
  if (failure) return;
  if (to.path.startsWith('/social/')) lastSocial = to.path;
  if (goingBack) {
    goingBack = false;
    return;
  }
  const top = stack.at(-1);
  if (top && top.split('?')[0] === to.path) stack[stack.length - 1] = to.fullPath;
  else stack.push(to.fullPath);
});

/** 返回上一页；没有上一页（例如从通知直接打开）时去逻辑上的父页面 */
export function goBack(fallback: string) {
  if (isPreview) {
    if (stack.length > 1) {
      stack.pop();
      goingBack = true;
      void router.replace(stack.at(-1) as string);
    } else {
      void router.replace(fallback);
    }
    return;
  }
  if (window.history.state?.back) router.back();
  else void router.replace(fallback);
}

/** 截图脚本和"关于"页用：列出所有可访问的页面 */
export function listRoutePaths(): string[] {
  return router
    .getRoutes()
    .filter((r) => !r.redirect)
    .map((r) => r.path)
    .filter((p) => p !== '/' && !p.includes('pathMatch'));
}
