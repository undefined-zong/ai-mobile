// 别的 App 分享过来的链接：要在路由创建之前处理（见 shareTarget.ts）
import './shareTarget';
import { createPinia } from 'pinia';
import { createApp } from 'vue';
// Vant 的函数式组件（Toast / Dialog / ImagePreview）不会被自动引入样式，这里手动引入
import 'vant/es/toast/style';
import 'vant/es/dialog/style';
import 'vant/es/image-preview/style';
import './styles/tokens.css';
import './styles/base.css';
import './styles/vant.css';
import 'virtual:uno.css';
import App from './App.vue';
import { initPwa } from './pwa';
import { router } from './router';
import { splitMsgKey } from './db/idb';
import { resumeAudioContext, unlockAudio } from './services/audio';
import { useAiStore } from './stores/ai';
import { useAppStore } from './stores/app';
import { useCharacterStore } from './stores/characters';
import { useChatStore } from './stores/chat';
import { useLibraryStore } from './stores/library';
import { useProactiveStore } from './stores/proactive';
import { useSoupStore } from './stores/soups';
import { useDecorStore } from './stores/decor';
import { useWorkshopStore } from './stores/workshop';
import { useBrawlStore } from './stores/brawl';
import { useKingdomStore } from './stores/kingdom';
import { useBookStore } from './stores/books';
import { useHubStore } from './stores/hub';
import { useEnvironmentStore } from './stores/environment';
import { useGalleryStore } from './stores/gallery';
import { useRhythmStore } from './stores/rhythm';
import { useVoiceStore } from './stores/voice';
import { useMessageSettingsStore } from './stores/messageSettings';
import { useMemoryStore } from './stores/memory';
import { usePersonaStore } from './stores/personas';
import { useHomeStore } from './stores/home';
import { useHealthStore } from './stores/health';
import { usePlannerStore } from './stores/planner';
import { finishOAuth, isOAuthReturn } from './services/mcp';
import { showToast } from 'vant';
import { useSocialStore } from '@/stores/social';
import { useParallelStore } from '@/stores/parallel';
import { startHealthSchedule } from '@/services/healthSchedule';
import { startParallelSchedule } from '@/services/parallel';
import { useAssistantStore } from '@/stores/assistant';
import { useCommunityStore } from '@/stores/community';
import { startSocialSchedule } from '@/services/social';
import { startCommunitySchedule } from '@/services/community';
import { maybeAutoConsolidate } from './services/consolidate';
import { useServicesStore } from './stores/services';
import { useRealWorldStore } from './stores/realworld';
import { useWeatherStore } from './stores/weather';
import { startup } from './startup';
import { startSyncTracking } from './services/sync';
import { startAssetCache } from './services/assetCache';

if (import.meta.env.MODE === 'preview') {
  // Claude Artifact 预览：外层已处理安全区
  document.documentElement.classList.add('is-artifact');
}

try {
  // 申请持久化存储，减少 iOS / 浏览器清理本地数据的概率（M1 起本地库存在 IndexedDB）
  navigator.storage?.persist?.().catch(() => undefined);
} catch {
  // 忽略
}

// 装成 App：正式构建注册 Service Worker（断网也能打开），接住浏览器的"可以安装"事件（单文件预览版不注册）
initPwa(import.meta.env.PROD && import.meta.env.MODE !== 'preview');

const app = createApp(App).use(createPinia()).use(router);

// 先读本机数据库（导入的角色、世界书、预设、聊天），再挂载：刷新后直接打开导入角色的聊天也找得到
// 所有 store 仍并发读取；升级阻塞或读取失败时展示恢复入口，不能挂载可编辑的空数据页面。
const hydrated = Promise.allSettled([
  useAiStore().hydrate(),
  // 地图、天气、音乐的 Key 和地址（真实世界、天气要先读出来）
  useServicesStore().hydrate(),
  useLibraryStore().hydrate(),
  useCharacterStore().hydrate(),
  useChatStore().hydrate(),
  useHubStore().hydrate(),
  useEnvironmentStore().hydrate(),
  useSoupStore().hydrate(),
  // 一起游戏 · 装修小屋：每个角色的小屋和你们俩的小人
  useDecorStore().hydrate(),
  // 一起游戏 · 创意工坊：你写的小说和画的画
  useWorkshopStore().hydrate(),
  useBrawlStore().hydrate(),
  useKingdomStore().hydrate(),
  useBookStore().hydrate(),
  // 节律要先读出来：导入角色"建世界"生成的世界要在打开地图、场景之前登记好
  useRhythmStore().hydrate(),
  useGalleryStore().hydrate(),
  useVoiceStore().hydrate(),
  // 消息设置：发送条数、显示条数、HTML 渲染、总结
  useMessageSettingsStore().hydrate(),
  // 记忆：事实记忆、故事片段、时间线、画像卡
  useMemoryStore().hydrate(),
  // 我的人设（含家务系统、健康系统的设置）、家务的记录、健康计划和运动记录
  usePersonaStore().hydrate(),
  useHomeStore().hydrate(),
  useHealthStore().hydrate(),
  // 日程计划（日程系统）：这周和每天的计划、勾掉了哪些
  usePlannerStore().hydrate(),
  // 平行时空：你每天自己记的事和改过的地方、和她们的留言
  useParallelStore().hydrate(),
  // 朋友圈：她们发的、你发的，和朋友圈的设置
  useSocialStore().hydrate(),
  // 社群：自带的、搜出来的社群，里面的帖子，和社群的设置
  useCommunityStore().hydrate(),
  // 我的 → 助手：和助手的对话、选着的对象、应用过的修改（能撤销）
  useAssistantStore().hydrate(),
]);

// iPhone 上只有用户点过屏幕后"解锁"的 <audio> 才能在网络请求之后播放语音：第一次点屏幕时解锁
const unlock = () => {
  if (unlockAudio()) document.removeEventListener('pointerdown', unlock, true);
};
document.addEventListener('pointerdown', unlock, true);
// 之后每次点屏幕顺手恢复被挂起的 AudioContext（切后台回来、iPhone 来电之后白噪音和通话的说话检测会停）；
// 切回前台时也恢复一次（白噪音、iPhone 上接进 Web Audio 的音乐不用等你点屏幕）
document.addEventListener('pointerdown', resumeAudioContext, true);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && resumeAudioContext());

/** "一起""回忆"、地图默认陪着你的角色：最近聊过的那个（不是固定的第一个） */
function followLatestChat() {
  const chars = useCharacterStore();
  const latest = [...useChatStore().chats].filter((c) => chars.byId(c.characterId)).sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
  if (latest) useAppStore().activeCharacterId = latest.characterId;
}

app.mount('#app');
void hydrated.then(async (results) => {
  if (results.some((r) => r.status === 'rejected')) {
    startup.error = true;
    return;
  }
  // 旧摘要持久化后再开放页面、结束场景，避免和场景结束时触发的自动总结重叠。
  const chats = useChatStore();
  await useMemoryStore().migrateChatSummaries(chats.chats, chats.list);
  chats.endLeftoverScenes();
  followLatestChat();
  startup.ready = true;
  // 多设备同步：从这以后本机的改动记进发件箱（读库时的整理不算）；生成回复时不同步，正在生成的聊天先不推
  await startSyncTracking({
    busy: () => Object.values(chats.streams).some(Boolean),
    hold: (store, key) => (store === 'chats' && !!chats.streams[key]) || (store === 'chatMessages' && !!chats.streams[splitMsgKey(key)?.[0] ?? '']),
  });
  // 图片缓存：这台设备上很久没看过、云端有一份的图片和语音清掉（用到时再下载）
  void startAssetCache();
  useRhythmStore().start();
  useHomeStore().start();
  void useRealWorldStore().start().finally(() => useWeatherStore().start());
  useProactiveStore().start();
  useHubStore().start();
  // 云端没接通时，App 开着也按同样的随机时间替她们发朋友圈、替网友和她们在社群里发帖
  startSocialSchedule();
  startCommunitySchedule();
  // 平行时空：云端没接通时，App 开着也按同样的随机时间让她们给你留言
  startParallelSchedule();
  // 健康计划：每天到点自动排（云端排；没连云端时 App 开着在这里排）
  startHealthSchedule();
  void maybeAutoConsolidate(useHubStore().connected);
  void afterOAuth().finally(() => usePlannerStore().catchUp());
}).catch(() => { startup.error = true; });

/** 日程系统的 OAuth 授权跳回来（地址上带 ?code=&state=）：换成 Token，回到那个人设的日程系统页 */
async function afterOAuth() {
  const href = location.href;
  if (!isOAuthReturn(href)) return;
  // 先把地址上的授权码去掉（刷新、分享时不再带着）
  history.replaceState(history.state, '', `${location.pathname}${location.hash}`);
  try {
    const { personaId } = await finishOAuth(href);
    showToast('授权好了');
    void router.replace(`/me/personas/${encodeURIComponent(personaId)}/planner`);
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), duration: 4000 });
  }
}
