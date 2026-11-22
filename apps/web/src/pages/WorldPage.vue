<script setup lang="ts">
import { hasOwnWorld, timeOfDay, worldOf, type Character, type LocationActivity, type MapLocation, type SceneId, type TimeOfDay } from '@app/shared';
import { showToast } from 'vant';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import PlaceChooser from '@/components/together/PlaceChooser.vue';
import TogetherTiles from '@/components/together/TogetherTiles.vue';
import PixelSprite from '@/components/town/PixelSprite.vue';
import TownView from '@/components/town/TownView.vue';
import { EXAMPLE_LOOKS } from '@/components/town/look';
import { useTogether, type TogetherTile } from '@/composables/useTogether';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useRhythmStore } from '@/stores/rhythm';
import { useWeatherStore } from '@/stores/weather';
import { hhmm } from '@/utils/time';

/**
 * 像素小镇主题的"地图"页签（首页）：上面是她的像素小镇，下面是"此刻"和一键直达的活动。
 * - 活动是三行格子（一行 4 个），常用的排前面；点一下直接去（镜头先推进到那栋楼），长按换地方；放不下的在"其他"里，也是同样的格子。
 * - 点小镇里的建筑 → 在那里能做什么；点小人 → 和她聊天。
 * - "我的世界"（真实地图）仍是原来的地图页。
 */
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const rhythm = useRhythmStore();
const weatherStore = useWeatherStore();

const now = ref(new Date());
let clock = 0;
onMounted(() => (clock = window.setInterval(() => (now.value = new Date()), 30_000)));
onBeforeUnmount(() => clearInterval(clock));

// —— 看谁的世界：所有角色都在；还没有小世界的，第一次打开时自动生成（rhythm.ensureWorld） ——
const worldOwners = computed(() => chars.list);
const worldKey = computed(() => {
  const q = route.query.world as string | undefined;
  if (q && chars.byId(q)) return q;
  if (chars.byId(app.activeCharacterId)) return app.activeCharacterId;
  return chars.list[0]?.id ?? '';
});
const owner = computed(() => chars.byId(worldKey.value) ?? null);
/** rhythm.worlds 是响应式的：生成好了这里就变 true */
const hasWorld = (id: string) => (void Object.keys(rhythm.worlds).length, rhythm.hasWorld(id) || hasOwnWorld(id));
const ready = computed(() => !!owner.value && hasWorld(owner.value.id));
const building = computed(() => !!owner.value && !ready.value);
watch(
  owner,
  async (c) => {
    if (!c || hasWorld(c.id)) return;
    const how = await rhythm.ensureWorld(c.id);
    if (how === 'starter') showToast(`给${c.name}生成了一个小世界（本机按角色卡生成，可以在「我的 → 节律」里重建）`);
    else if (how === 'model') showToast(`「节律」按角色卡给${c.name}建好了小世界`);
  },
  { immediate: true },
);
function worldName(c: Character) {
  return hasWorld(c.id) ? worldOf(c.id).name : `${c.name}的小世界 · 打开时生成`;
}
function switchWorld(id: string) {
  pickerOpen.value = false;
  app.activeCharacterId = id;
  void router.replace({ query: { world: id } });
}

// —— 时段、天气；小镇长什么样：AI 按世界观写的蓝图，没画过时按地名猜一份示例（切换面板里能临时换示例、换时段预览） ——
const todOverride = ref<TimeOfDay | null>(null);
const previewLook = ref<string | null>(null);
const tod = computed<TimeOfDay>(() => todOverride.value ?? timeOfDay(now.value.getHours()));
const design = computed(() => (owner.value ? rhythm.townOf(owner.value.id) : null));

// —— 让 AI 按世界观画小镇（地点、作息不动） ——
const ai = useAiStore();
const rhythmLive = computed(() => ai.status('rhythm').live);
const drawing = computed(() => !!owner.value && rhythm.busy[owner.value.id] === 'town');
async function drawTown() {
  const c = owner.value;
  if (!c) return;
  previewLook.value = null;
  const r = await rhythm.drawTown(c.id);
  if (r.ok) showToast(`按${c.name}的世界观重画好了`);
  else showToast(`没画成：${r.reason}`);
}
const weather = computed(() => (owner.value ? weatherStore.forCharacter(owner.value) : weatherStore.mine));
const rain = computed(() => /rain|drizzle|storm|lightning/.test(weather.value?.icon ?? ''));
const weatherText = computed(() => (weather.value ? weatherStore.short(weather.value) : ''));
const TOD_PREVIEW: { key: TimeOfDay | null; label: string }[] = [
  { key: null, label: '现在' },
  { key: 'morning', label: '白天' },
  { key: 'dusk', label: '黄昏' },
  { key: 'night', label: '夜里' },
];

// —— 她此刻、一起做点什么（和聚焦主题的"一起"共用） ——
const { world, here, placesFor, activityAt, nowAction, tiles } = useTogether(owner, go, now);
function lastLine(c: Character): string {
  const ch = chat.chatOfCharacter(c.id);
  const m = ch ? chat.list(ch.id).at(-1) : undefined;
  const text = m?.role !== 'user' ? m?.text?.replace(/\s+/g, ' ').trim() : '';
  if (text) return text.length > 14 ? `${text.slice(0, 13)}…` : text;
  return c.status || '';
}
const bubbles = computed(() => (owner.value ? { [owner.value.id]: lastLine(owner.value) } : {}));

/** 三行格子（一行 4 个）：常用的排前面，放不下时最后一格是"其他"，其余的在"其他"里也是同样的格子 */
const GRID_N = 12;
const shown = computed(() => (tiles.value.length <= GRID_N ? tiles.value : tiles.value.slice(0, GRID_N - 1)));
const others = computed(() => tiles.value.slice(shown.value.length));

const town = ref<InstanceType<typeof TownView>>();
const busy = ref(false);
async function go(loc: MapLocation, activity: LocationActivity) {
  const c = owner.value;
  if (!c || busy.value) return;
  busy.value = true;
  locOpen.value = false;
  allOpen.value = false;
  chooser.value = null;
  app.activeCharacterId = c.id;
  await town.value?.flyTo(loc.id);
  await router.push({ path: `/scene/${activity.sceneId}`, query: { at: loc.id } });
  busy.value = false;
}
function pickTile(t: TogetherTile) {
  allOpen.value = false;
  t.run();
}
// 长按换地方
const chooser = ref<SceneId | null>(null);

// —— 面板 ——
const pickerOpen = ref(false);
const allOpen = ref(false);
const locOpen = ref(false);
const selectedLoc = ref<MapLocation | null>(null);
function openLoc(l: MapLocation) {
  selectedLoc.value = l;
  locOpen.value = true;
}
const whoHere = computed(() => chars.list.filter((c) => c.locationId === selectedLoc.value?.id));
function openChat(c: Character) {
  const ch = chat.chatOfCharacter(c.id);
  if (ch) void router.push(`/chat/${ch.id}`);
}
// 回到这一页时镜头复位
watch(
  () => route.fullPath,
  (p) => {
    if (p.startsWith('/world')) town.value?.resetCamera();
  },
);
</script>

<template>
  <div class="world-page" data-page="world">
    <div class="town-area">
      <!-- 还没有小世界：正在生成 -->
      <div v-if="building && owner" class="town-building" role="status">
        <PixelSprite :character="owner" :scale="5" class="bob" />
        <div class="text-[15px] font-600 mt-3">正在给{{ owner.name }}生成小世界…</div>
        <div class="text-[12.5px] mt-1 opacity-70">{{ rhythm.busy[owner.id] === 'build' ? '「节律」在读角色卡和世界书' : '按角色卡里的设定排地点和作息' }}</div>
      </div>
      <TownView
        v-if="owner && ready"
        ref="town"
        :world="world"
        :characters="[owner]"
        :design="design"
        :preview="previewLook"
        :tod="tod"
        :rain="rain"
        :focus-id="owner.id"
        :bubbles="bubbles"
        @select-location="openLoc"
        @select-character="openChat"
      />
      <div class="hud">
        <button v-if="owner" class="pill press" aria-label="换一个世界" @click="pickerOpen = true">
          <Avatar :character="owner" :size="26" />
          <span class="truncate">{{ ready ? world.name : `${owner.name}的小世界` }}</span>
          <span class="i-lucide-chevron-down text-[15px] opacity-60" />
        </button>
        <span class="pill num">
          <span :class="weather?.icon ?? 'i-lucide-clock'" class="text-[15px] opacity-70" />{{ hhmm(now.getTime()) }}<template v-if="weatherText"> · {{ weatherText }}</template>
        </span>
      </div>
    </div>

    <!-- 下半：样式沿用原来地图页的"此刻"卡片和活动格子，只放两行 -->
    <section v-if="owner && ready" class="sheet-card">
      <button v-if="nowAction" class="suggest mx-4 press" :disabled="busy" @click="go(nowAction.loc, nowAction.activity)">
        <Avatar :character="owner" :size="40" live />
        <div class="flex-1 min-w-0 text-left">
          <div class="text-[14px] leading-snug truncate">{{ owner.name }}<template v-if="here">在{{ here.name }}</template><template v-if="owner.status"> · {{ owner.status }}</template></div>
          <div class="text-[12px] text-ink-3 mt-0.5 truncate"><span class="i-lucide-map-pin" /> {{ nowAction.loc.name }} · {{ nowAction.activity.label }}</div>
        </div>
        <span class="go">去陪{{ owner.pronoun }}</span>
      </button>

      <TogetherTiles class="acts" :tiles="shown" :disabled="busy" :more="others.length" @pick="pickTile" @choose="(id) => (chooser = id)" @more="allOpen = true" />
    </section>

    <!-- 换世界 + AI 画小镇 + 预览示例、时段 -->
    <van-popup v-model:show="pickerOpen" position="bottom" round>
      <div class="sheet">
        <div class="sheet-title">去谁的世界</div>
        <div class="grid gap-2 mt-3">
          <button v-for="c in worldOwners" :key="c.id" class="row-btn press" :class="{ on: c.id === worldKey }" :data-world="c.id" @click="switchWorld(c.id)">
            <Avatar :character="c" :size="32" />
            <span class="flex-1 min-w-0 text-left truncate">{{ worldName(c) }}</span>
            <PixelSprite :character="c" :scale="2" />
            <span v-if="c.id === worldKey" class="i-lucide-check text-accent-ink" />
          </button>
          <RouterLink to="/map?world=me" class="row-btn press">
            <span class="globe"><span class="i-lucide-earth" /></span>
            <span class="flex-1 text-left">我的世界（真实地图）</span>
            <span class="i-lucide-chevron-right text-ink-3" />
          </RouterLink>
        </div>
        <template v-if="owner && ready">
          <div class="field-label">小镇的样子</div>
          <div class="town-src">
            <div class="flex-1 min-w-0">
              <div class="text-[14px]">{{ design ? 'AI 按世界观画的' : '还没让 AI 画过' }}</div>
              <div class="text-[12px] text-ink-3 mt-0.5 leading-snug">
                {{ design ? `${design.model ?? '模型'} 写的蓝图，程序照着画。地点和作息不受影响。` : '现在是按地名猜的样子。AI 会读角色卡和世界书，用小镇的零件设计地面、水、四周、每栋楼。' }}
              </div>
            </div>
            <button v-if="rhythmLive" class="draw-btn press" :disabled="drawing" @click="drawTown">{{ drawing ? '正在画…' : design ? '重画' : '让 AI 画' }}</button>
            <RouterLink v-else to="/me/api" class="draw-btn press">先接通「节律」</RouterLink>
          </div>
        </template>
        <div class="field-label">预览 · 示例的样子（不保存）</div>
        <div class="seg">
          <button :class="{ on: !previewLook }" @click="previewLook = null">{{ design ? 'AI 的' : '按世界' }}</button>
          <button v-for="(ex, k) in EXAMPLE_LOOKS" :key="k" :class="{ on: previewLook === k }" @click="previewLook = String(k)">{{ ex.label }}</button>
        </div>
        <div class="field-label">预览 · 时段</div>
        <div class="seg">
          <button v-for="t in TOD_PREVIEW" :key="t.label" :class="{ on: todOverride === t.key }" @click="todOverride = t.key">{{ t.label }}</button>
        </div>
      </div>
    </van-popup>

    <!-- 其他：格子里没放下的，同样一行 4 个 -->
    <van-popup v-model:show="allOpen" position="bottom" round :style="{ maxHeight: '80%' }">
      <div v-if="owner" class="sheet">
        <div class="sheet-title">其他</div>
        <div class="text-[12.5px] text-ink-3 mt-1">点一下直接去 · 长按活动可以换地方</div>
        <TogetherTiles class="mt-3" :tiles="others" :disabled="busy" @pick="pickTile" @choose="(id) => (chooser = id)" />
      </div>
    </van-popup>

    <!-- 长按：换个地方 -->
    <PlaceChooser v-if="owner" :scene="chooser" :places="chooser ? placesFor(chooser) : []" :here-id="here?.id" :owner="owner" @go="(l) => chooser && go(l, activityAt(l, chooser))" @close="chooser = null" />

    <!-- 点建筑 -->
    <van-popup v-model:show="locOpen" position="bottom" round>
      <div v-if="selectedLoc && owner" class="sheet">
        <div class="flex items-center gap-3">
          <div class="flex-1 min-w-0">
            <div class="sheet-title">{{ selectedLoc.name }}</div>
            <div class="text-[12.5px] text-ink-3 truncate">{{ selectedLoc.blurb }}</div>
          </div>
          <div class="flex -space-x-2">
            <Avatar v-for="c in whoHere" :key="c.id" :character="c" :size="30" live />
          </div>
        </div>
        <div class="text-[12.5px] text-ink-2 mt-3">
          {{ whoHere.length ? `${whoHere.map((c) => c.name).join('、')}现在在这里` : `${owner.name}现在不在这里，约${owner.pronoun}过来` }}
        </div>
        <div class="list mt-3">
          <button v-for="a in selectedLoc.activities" :key="a.label" class="list-row press" @click="go(selectedLoc, a)">
            <span class="flex-1 text-left">{{ a.label }}</span>
            <span class="i-lucide-chevron-right text-ink-3" />
          </button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.world-page {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.town-area {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
}
.town-building {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding-bottom: 40px;
  background: #7ec26b;
  background-image: radial-gradient(#98d580 1px, transparent 1px);
  background-size: 8px 8px;
  color: #1f3a1c;
  text-align: center;
}
.bob {
  animation: sprite-bob 0.9s steps(2) infinite;
}
@keyframes sprite-bob {
  50% {
    transform: translateY(-3px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .bob {
    animation: none;
  }
}
.hud {
  position: absolute;
  top: calc(var(--safe-top) + 10px);
  left: 12px;
  right: 12px;
  display: flex;
  justify-content: space-between;
  gap: 8px;
  pointer-events: none;
}
.pill {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: 36px;
  padding: 0 12px 0 5px;
  border-radius: 99px;
  border: 0;
  background: rgba(255, 255, 255, 0.92);
  color: #2a2230;
  font-size: 13.5px;
  font-weight: 600;
  box-shadow: 0 2px 0 rgba(0, 0, 0, 0.18);
}
span.pill {
  padding: 0 12px;
  font-weight: 500;
  flex-shrink: 0;
}
/* 下半和原来地图页同一个底色，卡片、格子的样式也照搬原来的（.suggest / .acts / .act） */
.sheet-card {
  position: relative;
  z-index: 2;
  margin-top: -18px;
  padding: 14px 0 12px;
  border-radius: 20px 20px 0 0;
  background: var(--bg);
  box-shadow: 0 -6px 18px rgba(0, 0, 0, 0.14);
}
.suggest {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% - 32px);
  padding: 12px 14px;
  border-radius: 20px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: inherit;
}
.go {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 600;
  line-height: 32px;
  flex-shrink: 0;
}
/* 三行放得下：没有小标题，格子比原来地图页的矮（格子本身在 TogetherTiles 里） */
.acts {
  margin-top: 12px;
  padding: 0 16px;
}
.suggest:disabled {
  opacity: 0.6;
}
.sheet {
  padding: 18px 16px calc(18px + var(--safe-bottom));
}
.sheet-title {
  font-size: 17px;
  font-weight: 650;
}
.field-label {
  margin: 18px 0 8px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.row-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 0;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 15px;
  text-decoration: none;
}
.row-btn.on {
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
.globe {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--panel-2);
  color: var(--ink-2);
}
.town-src {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border-radius: 14px;
  background: var(--panel);
}
.draw-btn {
  flex-shrink: 0;
  height: 34px;
  padding: 0 14px;
  border: 0;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
  font-weight: 600;
  line-height: 34px;
  text-decoration: none;
  white-space: nowrap;
}
.draw-btn:disabled {
  opacity: 0.6;
}
.seg {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 12px;
  background: var(--panel);
}
.seg button {
  flex: 1;
  height: 34px;
  border: 0;
  border-radius: 9px;
  background: none;
  color: var(--ink-2);
  font-size: 13.5px;
}
.seg button.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.12);
}
.list {
  display: grid;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
}
.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 14px;
  border: 0;
  border-top: 1px solid var(--border);
  background: none;
  color: var(--ink);
  font-size: 15px;
  text-decoration: none;
}
.list-row:first-child {
  border-top: 0;
}
</style>
