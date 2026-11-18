<script setup lang="ts">
import { hasOwnWorld, type Character, type LocationActivity, type MapLocation, type SceneId } from '@app/shared';
import { showToast } from 'vant';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Composer from '@/components/chat/Composer.vue';
import Avatar from '@/components/common/Avatar.vue';
import { figureLayoutFor } from '@/components/scene/location';
import StageView from '@/components/stage/StageView.vue';
import PlaceChooser from '@/components/together/PlaceChooser.vue';
import TogetherTiles from '@/components/together/TogetherTiles.vue';
import { useHerPlace } from '@/composables/useHerPlace';
import { usePoke } from '@/composables/usePoke';
import { useTogether, type TogetherTile } from '@/composables/useTogether';
import { useVoiceSend } from '@/composables/useVoiceSend';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useCommunityStore } from '@/stores/community';
import { useParallelStore } from '@/stores/parallel';
import { useRhythmStore } from '@/stores/rhythm';
import { useSocialStore } from '@/stores/social';
import { showErrorDialog } from '@/utils/errors';
import { messagePreview, splitActions } from '@/utils/messagePreview';
import { hhmm } from '@/utils/time';

/**
 * 聚焦主题的首页：打开就是她，不是一张列表。
 * - 整屏是她此刻在的地方（背景按她的地点、时段、天气）和她（立绘位置在「立绘设置 → 各场景的位置和大小 → 聚焦主题 · 首页」里调），能戳；
 * - 下面是她刚说的那句（点开 / 上滑 = 完整对话），她给的选项，直接回她的输入栏；输入栏最前面的「一起」就地挑一件事去做；
 * - 左边一列去别处（地图、回忆、我的），右边一列她们的动态和找她（社媒、电话、视频、平行时空），两列顶端对齐；
 * - 左上角换人（也是消息列表：谁说了什么、几条没看），在她身上左右划也能换；中间是她在哪、几点，右上角是那边的天气。
 */
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const rhythm = useRhythmStore();
const social = useSocialStore();
const community = useCommunityStore();
const parallel = useParallelStore();

const now = ref(new Date());
let clock = 0;
onMounted(() => (clock = window.setInterval(() => (now.value = new Date()), 30_000)));
onBeforeUnmount(() => clearInterval(clock));

// —— 聚焦的是谁（和"一起""回忆"用的是同一个人） ——
const cast = computed(() => chars.list);
const her = computed<Character | null>(() => chars.byId(app.activeCharacterId) ?? cast.value[0] ?? null);
const herIndex = computed(() => cast.value.findIndex((c) => c.id === her.value?.id));
const whoOpen = ref(false);
function focusOn(c: Character) {
  app.activeCharacterId = c.id;
  whoOpen.value = false;
}
function step(d: 1 | -1) {
  const n = cast.value.length;
  if (n < 2) return;
  focusOn(cast.value[(herIndex.value + d + n) % n] as Character);
}

// —— 她的聊天：首页显示她最后说的那句；在这儿看到了就算读过 ——
const thread = computed(() => (her.value ? (chat.chatOfCharacter(her.value.id) ?? null) : null));
const messages = computed(() => (thread.value ? chat.list(thread.value.id) : []));
const stream = computed(() => (thread.value ? chat.streams[thread.value.id] : undefined));
const lastAi = computed(() => [...messages.value].reverse().find((m) => m.role === 'assistant'));
const line = computed(() => (her.value ? messagePreview(lastAi.value, her.value) : ''));
const choices = computed(() => (stream.value ? [] : (lastAi.value?.meta.choices ?? [])));
const failed = computed(() => !stream.value && !!lastAi.value?.meta.error);
/** 进来之前她连着发了几条（首页只露最后一句，提醒上滑看完整的） */
const unseen = ref(0);
function seeAll() {
  const t = thread.value;
  if (!t) return;
  const n = chat.unread(t.id);
  if (!n) return;
  unseen.value += n;
  chat.markRead(t.id);
}
watch(
  thread,
  (t, old) => {
    unseen.value = 0;
    if (old && app.viewingChatId === old.id) app.viewingChatId = null;
    // 正在看她：她这时发来的主动消息直接算已读、不弹横幅
    if (t) app.viewingChatId = t.id;
    seeAll();
  },
  { immediate: true },
);
watch(() => messages.value.length, seeAll);
onBeforeUnmount(() => {
  if (app.viewingChatId === thread.value?.id) app.viewingChatId = null;
});
/** 别人那里有没看的消息：换人的按钮上亮个点 */
const othersUnread = computed(() =>
  cast.value.reduce((n, c) => {
    if (c.id === her.value?.id) return n;
    const t = chat.chatOfCharacter(c.id);
    return n + (t ? chat.unread(t.id) : 0);
  }, 0),
);
function unreadOf(c: Character) {
  const t = chat.chatOfCharacter(c.id);
  return t ? chat.unread(t.id) : 0;
}
function previewOf(c: Character) {
  const t = chat.chatOfCharacter(c.id);
  return messagePreview(t ? chat.list(t.id).at(-1) : undefined, c);
}

/** 没有聊天的（不该有，导入时都会开一条）发消息前补一条 */
function ensureThread(): string | null {
  const c = her.value;
  if (!c) return null;
  return (thread.value ?? chat.startChat(c)).id;
}
function send(text: string) {
  const id = ensureThread();
  if (!id) return;
  unseen.value = 0;
  void chat.send(id, text);
}
function stop() {
  if (thread.value) chat.stop(thread.value.id);
}
const { recognizing, onVoice } = useVoiceSend(() => thread.value?.id);
function openChat() {
  const id = ensureThread();
  if (!id) return;
  unseen.value = 0;
  void router.push(`/chat/${id}`);
}

// —— 舞台：她在哪、穿什么、站哪儿 ——
const { loc, placeKnown, mapLink, backdrop, rain, weather, weatherText, weatherEntry } = useHerPlace(her);
const placeLine = computed(() => [placeKnown.value ? loc.value.name : '', hhmm(now.value.getTime())].filter(Boolean).join(' · '));
/** 右上角的天气：取到了写天气，还在取、没取到也写出来（点开去「环境与作息」设置城市，没取到的原因放在 title 里） */
const weatherChip = computed(() => {
  if (weatherText.value) return { icon: weather.value?.icon ?? 'i-lucide-cloud-sun', text: weatherText.value, title: weather.value?.place ?? '' };
  const e = weatherEntry.value;
  return { icon: e.error ? 'i-lucide-cloud-off' : 'i-lucide-cloud', text: e.error ? '天气没取到' : '天气加载中', title: e.error };
});
const expression = computed(() => chars.expression[her.value?.id ?? ''] ?? 'neutral');
const outfit = computed(() => (her.value ? rhythm.outfitFor(her.value.id, null) : undefined));
const layout = computed(() => figureLayoutFor('focus', her.value?.portraits?.sceneLayouts?.focus));
const { bubble, combo, onPoke } = usePoke(
  () => her.value?.id ?? '',
  () => thread.value?.id,
);

// —— 手势：在她身上左右划换人；在她那句话上往上划看完整对话 ——
const SWIPE = 56;
let press: { x: number; y: number; id: number } | null = null;
function pressDown(e: PointerEvent) {
  press = { x: e.clientX, y: e.clientY, id: e.pointerId };
}
function moved(e: PointerEvent) {
  if (!press || press.id !== e.pointerId) return null;
  const d = { x: e.clientX - press.x, y: e.clientY - press.y };
  press = null;
  return d;
}
function stageUp(e: PointerEvent) {
  const d = moved(e);
  if (d && Math.abs(d.x) > SWIPE && Math.abs(d.x) > Math.abs(d.y) * 1.5) step(d.x < 0 ? 1 : -1);
}
function lineUp(e: PointerEvent) {
  const d = moved(e);
  if (d && -d.y > SWIPE * 0.75 && -d.y > Math.abs(d.x)) openChat();
}

// —— 两侧：左边去别处，右边她们的动态和找她 ——
interface RailItem {
  key: string;
  to: string;
  label: string;
  icon: string;
  badge: number;
}
const leftRail = computed((): RailItem[] => [
  { key: 'map', to: her.value ? `/map?world=${her.value.id}` : '/map', label: '地图', icon: 'i-lucide-map', badge: 0 },
  { key: 'memories', to: '/memories', label: '回忆', icon: 'i-lucide-book-heart', badge: 0 },
  { key: 'me', to: '/me', label: '我的', icon: 'i-lucide-user-round', badge: 0 },
]);
const rightRail = computed((): RailItem[] => {
  const c = her.value;
  if (!c) return [];
  return [
    { key: 'social', to: '/social', label: '社媒', icon: 'i-lucide-aperture', badge: social.unread + community.unread },
    { key: 'call', to: `/call/${c.id}`, label: '电话', icon: 'i-lucide-phone', badge: 0 },
    { key: 'video', to: `/call/${c.id}?video=1`, label: '视频', icon: 'i-lucide-video', badge: 0 },
    { key: 'parallel', to: `/parallel/${encodeURIComponent(c.id)}`, label: '平行时空', icon: 'i-lucide-orbit', badge: parallel.unreadOf(c.id) },
  ];
});

// —— 一起：就地挑一件事（她此刻在的地方能做的排前面、亮着），长按换地方 ——
const togetherOpen = ref(false);
const chooser = ref<SceneId | null>(null);
const busy = ref(false);
async function go(l: MapLocation, a: LocationActivity) {
  const c = her.value;
  if (!c || busy.value) return;
  busy.value = true;
  togetherOpen.value = false;
  chooser.value = null;
  app.activeCharacterId = c.id;
  await router.push({ path: `/scene/${a.sceneId}`, query: { at: l.id } });
  busy.value = false;
}
const { here, placesFor, activityAt, tiles } = useTogether(her, go, now);
const sortedTiles = computed(() => [...tiles.value].sort((a, b) => Number(!!b.near) - Number(!!a.near)));
const nearCount = computed(() => tiles.value.filter((t) => t.near).length);
function pickTile(t: TogetherTile) {
  togetherOpen.value = false;
  t.run();
}
/** 打开"一起"时她还没有小世界就先建一个（和地图页一样） */
async function openTogether() {
  togetherOpen.value = true;
  const c = her.value;
  if (!c || rhythm.hasWorld(c.id) || hasOwnWorld(c.id)) return;
  const how = await rhythm.ensureWorld(c.id);
  if (how === 'starter') showToast(`给${c.name}生成了一个小世界（本机按角色卡生成，可以在「我的 → 节律」里重建）`);
  else if (how === 'model') showToast(`「节律」按角色卡给${c.name}建好了小世界`);
}
</script>

<template>
  <div class="focus-page" data-page="focus">
    <template v-if="her">
      <div class="stage-wrap" @pointerdown="pressDown" @pointerup="stageUp" @pointercancel="press = null">
        <StageView :character="her" :expression="expression" :day-outfit="outfit" :backdrop="backdrop" :location="loc" :rain="rain" :layout="layout" pokeable @poke="onPoke" />
      </div>

      <!-- 上面：换人、她在哪、那边的天气 -->
      <header class="top">
        <button class="who press" :aria-label="`现在是${her.name}，换一个人`" @click="whoOpen = true">
          <Avatar :character="her" :size="28" live />
          <span class="truncate">{{ her.name }}</span>
          <span class="i-lucide-chevron-down text-[15px] opacity-70 shrink-0" />
          <span v-if="othersUnread" class="who-dot" :aria-label="`别人那里有 ${othersUnread} 条没看`" />
        </button>
        <div class="place">
          <RouterLink v-if="placeKnown" :to="mapLink" class="place-chip num" aria-label="在地图上看她在哪">{{ placeLine }}</RouterLink>
          <span v-else class="place-chip num">{{ placeLine }}</span>
          <div v-if="cast.length > 1" class="dots" aria-hidden="true">
            <span v-for="c in cast" :key="c.id" :class="{ on: c.id === her.id }" />
          </div>
        </div>
        <RouterLink to="/me/environment" class="weather-chip num" data-testid="focus-weather" :title="weatherChip.title" :aria-label="`天气：${weatherChip.text}`">
          <span :class="weatherChip.icon" class="text-[15px] shrink-0" />
          <span class="truncate">{{ weatherChip.text }}</span>
        </RouterLink>
      </header>

      <!-- 左边去别处，右边她们的动态和找她；两列顶端对齐 -->
      <nav class="rail rail-left" aria-label="去别处">
        <RouterLink v-for="r in leftRail" :key="r.key" :to="r.to" class="rail-item press" :data-rail="r.key">
          <span class="rail-icon"><span :class="r.icon" /><span v-if="r.badge" class="rail-badge num">{{ r.badge > 99 ? '99+' : r.badge }}</span></span>
          <span class="rail-label">{{ r.label }}</span>
        </RouterLink>
      </nav>
      <nav class="rail rail-right" :aria-label="`社媒和找${her.name}`">
        <RouterLink v-for="r in rightRail" :key="r.key" :to="r.to" class="rail-item press" :data-rail="r.key">
          <span class="rail-icon"><span :class="r.icon" /><span v-if="r.badge" class="rail-badge num">{{ r.badge > 99 ? '99+' : r.badge }}</span></span>
          <span class="rail-label">{{ r.label }}</span>
        </RouterLink>
      </nav>

      <Transition name="pop">
        <div v-if="bubble" :key="bubble.id" class="poke-bubble">{{ bubble.text }}</div>
      </Transition>
      <div v-if="combo > 1" class="combo num">连击 ×{{ combo }}</div>

      <!-- 下面：她刚说的、她给的选项、回她 -->
      <section class="bottom">
        <button class="line-card" data-testid="focus-line" aria-label="看完整对话" @pointerdown="pressDown" @pointerup="lineUp" @pointercancel="press = null" @click="openChat">
          <span class="grab" aria-hidden="true" />
          <span class="name-tag">
            {{ her.name }}
            <span v-if="stream && (stream.thinking || !line)" class="inline-flex gap-1 ml-1">
              <span class="typing-dot !w-1 !h-1" /><span class="typing-dot !w-1 !h-1" /><span class="typing-dot !w-1 !h-1" />
            </span>
          </span>
          <span class="line" :class="{ 'stream-caret': stream && !stream.thinking && line }">
            <span v-for="(s, i) in splitActions(line)" :key="i" :class="{ action: s.action }">{{ s.text }}</span>
          </span>
          <span v-if="failed" class="line-note bad">回复没出来 · 点开对话重试</span>
          <span v-else-if="unseen > 1" class="line-note">{{ her.pronoun }}发来 {{ unseen }} 条 · 上滑看完整对话</span>
        </button>
        <div v-if="choices.length" class="choices">
          <button v-for="c in choices" :key="c" class="choice press" @click="send(c)">{{ c }}</button>
        </div>
        <Composer
          :key="her.id"
          compact
          class="focus-composer"
          :placeholder="`回${her.pronoun}…`"
          :busy="!!stream"
          :voice-busy="recognizing > 0"
          @send="send"
          @stop="stop"
          @voice="onVoice"
          @voice-error="(e) => showErrorDialog('录音失败', e)"
        >
          <template #lead>
            <button class="together-btn press" data-testid="focus-together" :aria-label="`和${her.name}一起做点什么`" @click="openTogether">
              <span class="i-lucide-sparkles text-[16px]" />
              <span>一起</span>
            </button>
          </template>
        </Composer>
      </section>
    </template>

    <div v-else class="empty">
      <span class="i-lucide-user-round-plus text-[34px] opacity-60" />
      <div class="text-[15px] mt-3">还没有角色</div>
      <RouterLink to="/import" class="empty-btn press">导入角色卡</RouterLink>
    </div>

    <!-- 换人：也是消息列表 -->
    <van-popup v-model:show="whoOpen" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
      <div class="sheet" data-sheet="focus-who">
        <div class="sheet-title">和谁在一起</div>
        <div class="who-list mt-3">
          <button v-for="c in cast" :key="c.id" class="who-row press" :class="{ on: c.id === her?.id }" :data-who="c.id" @click="focusOn(c)">
            <Avatar :character="c" :size="44" :ring="unreadOf(c) > 0" />
            <div class="flex-1 min-w-0 text-left">
              <div class="flex items-center gap-2">
                <span class="text-[15.5px] font-600 truncate">{{ c.name }}</span>
                <span v-if="c.status" class="text-[12px] text-ink-3 truncate">{{ c.status }}</span>
              </div>
              <div class="text-[13px] text-ink-2 truncate mt-0.5">{{ previewOf(c) }}</div>
            </div>
            <span v-if="unreadOf(c)" class="who-unread num">{{ unreadOf(c) }}</span>
            <span v-else-if="c.id === her?.id" class="i-lucide-check text-accent-ink shrink-0" />
          </button>
        </div>
        <RouterLink to="/chats" class="all-chats press" @click="whoOpen = false">全部聊天<span class="i-lucide-arrow-right" /></RouterLink>
      </div>
    </van-popup>

    <!-- 一起 -->
    <van-popup v-model:show="togetherOpen" position="bottom" round teleport="body" :style="{ maxHeight: '78%' }" :overlay-style="{ background: 'rgba(0, 0, 0, 0.3)' }">
      <div v-if="her" class="sheet" data-sheet="focus-together">
        <div class="sheet-title">{{ here ? `在${here.name}，可以一起…` : `和${her.name}一起…` }}</div>
        <div class="text-[12.5px] text-ink-3 mt-1">{{ nearCount && here ? `亮着的在${here.name}就能做 · ` : '' }}点一下就去 · 长按活动可以换地方</div>
        <TogetherTiles class="mt-3" :tiles="sortedTiles" :disabled="busy" mark-near @pick="pickTile" @choose="(id) => (chooser = id)" />
        <RouterLink :to="`/map?world=${her.id}`" class="all-chats press" @click="togetherOpen = false">看看{{ her.pronoun }}的世界地图<span class="i-lucide-arrow-right" /></RouterLink>
      </div>
    </van-popup>
    <PlaceChooser v-if="her" :scene="chooser" :places="chooser ? placesFor(chooser) : []" :here-id="here?.id" :owner="her" @go="(l) => chooser && go(l, activityAt(l, chooser))" @close="chooser = null" />
  </div>
</template>

<style scoped>
.focus-page {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #000;
  color: var(--ink);
}
.stage-wrap {
  position: absolute;
  inset: 0;
}
/* 字直接压在画面上的地方（点点、两侧的小字）：白字加阴影，白天、夜里的配色都看得清 */
.top {
  position: absolute;
  z-index: 12;
  top: calc(var(--safe-top) + 10px);
  left: 12px;
  right: 12px;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  pointer-events: none;
}
.who {
  position: relative;
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 38%;
  height: 38px;
  padding: 0 10px 0 5px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 15px;
  font-weight: 600;
  flex-shrink: 0;
}
.who-dot {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bad);
  box-shadow: 0 0 0 2px var(--glass-strong);
}
.place {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding-top: 2px;
}
.place-chip {
  pointer-events: auto;
  max-width: 100%;
  overflow: hidden;
  padding: 6px 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 12.5px;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-decoration: none;
}
.weather-chip {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 34%;
  height: 38px;
  padding: 0 12px 0 10px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 13px;
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
}
.dots {
  display: flex;
  gap: 5px;
}
.dots span {
  width: 6px;
  height: 6px;
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.45);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  transition:
    width 0.25s var(--ease),
    background 0.25s;
}
.dots span.on {
  width: 14px;
  background: var(--accent);
}
.rail {
  position: absolute;
  z-index: 12;
  top: calc(var(--safe-top) + 68px);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.rail-left {
  left: 8px;
}
.rail-right {
  right: 8px;
}
.rail-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 50px;
  text-decoration: none;
}
.rail-icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 18px;
}
.rail-badge {
  position: absolute;
  top: -3px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.rail-label {
  color: #fff;
  font-size: 10.5px;
  white-space: nowrap;
  text-shadow:
    0 1px 2px rgba(0, 0, 0, 0.75),
    0 0 6px rgba(0, 0, 0, 0.45);
}
.poke-bubble {
  position: absolute;
  z-index: 13;
  top: 24%;
  left: 50%;
  transform: translateX(-50%);
  max-width: 64%;
  padding: 9px 14px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--accent-line);
  box-shadow: var(--shadow-sm);
  font-size: 15px;
  text-align: center;
}
.combo {
  position: absolute;
  z-index: 13;
  top: calc(24% - 34px);
  right: 18%;
  color: var(--accent-ink);
  font-weight: 700;
  font-size: 15px;
  transform: rotate(-8deg);
}
.pop-enter-active {
  transition:
    transform 0.25s var(--ease),
    opacity 0.25s;
}
.pop-leave-active {
  transition: opacity 0.3s;
}
.pop-enter-from {
  opacity: 0;
  transform: translate(-50%, 8px) scale(0.92);
}
.pop-leave-to {
  opacity: 0;
}
/* 下面一块压在画面上：底下垫一层渐暗，台词卡和输入栏是毛玻璃 */
.bottom {
  position: absolute;
  z-index: 11;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 36px 12px 0;
  background: linear-gradient(to bottom, transparent, rgba(0, 0, 0, 0.42) 46%);
  pointer-events: none;
}
.bottom > * {
  pointer-events: auto;
}
.line-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  width: 100%;
  padding: 6px 16px 13px;
  border-radius: 22px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow-sm);
  color: var(--ink);
  text-align: left;
  touch-action: pan-x;
}
.grab {
  align-self: center;
  width: 34px;
  height: 4px;
  margin-bottom: 8px;
  border-radius: 2px;
  background: var(--ink-3);
  opacity: 0.5;
}
.name-tag {
  display: inline-flex;
  align-items: center;
  height: 22px;
  margin-bottom: 6px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12.5px;
  font-weight: 650;
}
.line {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  min-height: 1.6em;
  font-size: 16px;
  line-height: 1.6;
  letter-spacing: 0.02em;
  white-space: pre-wrap;
  word-break: break-word;
}
.action {
  opacity: 0.6;
  font-style: italic;
}
.line-note {
  margin-top: 6px;
  color: var(--ink-3);
  font-size: 12px;
}
.line-note.bad {
  color: var(--bad);
}
.choices {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  overflow-x: auto;
  scrollbar-width: none;
}
.choices::-webkit-scrollbar {
  display: none;
}
.choice {
  flex-shrink: 0;
  max-width: 80%;
  height: 36px;
  padding: 0 14px;
  overflow: hidden;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--accent-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 14px;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* 输入栏不要整条的底，只留输入框和按钮 */
.bottom .focus-composer {
  margin: 0 -12px;
  padding-bottom: calc(var(--safe-bottom) + 4px);
  background: none;
  border-top: 0;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
.bottom .focus-composer :deep(.bar) {
  align-items: center;
  padding: 8px 12px;
}
.bottom .focus-composer :deep(.field),
.bottom .focus-composer :deep(.hold) {
  background: var(--glass);
  border-color: var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.bottom .focus-composer :deep(.icon-btn) {
  color: #fff;
}
.together-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 1px;
  width: 46px;
  height: 46px;
  margin-right: 2px;
  border-radius: 50%;
  background: var(--glass);
  border: 1px solid var(--accent-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--accent-ink);
  font-size: 11px;
  font-weight: 650;
  flex-shrink: 0;
}
.empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: var(--bg);
  color: var(--ink-2);
}
.empty-btn {
  margin-top: 14px;
  height: 38px;
  padding: 0 18px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 14px;
  font-weight: 600;
  line-height: 38px;
  text-decoration: none;
}
.who-list {
  display: grid;
  gap: 2px;
}
.who-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 10px;
  border-radius: 14px;
  color: var(--ink);
}
.who-row.on {
  background: var(--panel);
}
.who-unread {
  min-width: 20px;
  height: 20px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 11.5px;
  line-height: 20px;
  text-align: center;
  flex-shrink: 0;
}
.all-chats {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 44px;
  margin-top: 12px;
  border-top: 1px solid var(--border);
  color: var(--ink-2);
  font-size: 14px;
  text-decoration: none;
}
</style>
