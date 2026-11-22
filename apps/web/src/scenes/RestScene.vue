<script setup lang="ts">
import {
  BACKGROUND_KINDS,
  BREATH_PATTERNS,
  BREATH_PHASE_LABEL,
  REST_ACTIVITIES,
  breathAt,
  characterPronoun,
  pronounText,
  restActivity,
  type BackgroundPlace,
  type Character,
  type EscapeView,
  type RestKind,
  type RestNoise,
} from '@app/shared';
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import EscapeBackdrop from '@/components/scene/escape/EscapeBackdrop.vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import TimerButton from '@/components/scene/TimerButton.vue';
import TimerPop from '@/components/scene/TimerPop.vue';
import { SCENE_FIGURE_LAYOUTS, SCENE_LOCATION } from '@/components/scene/location';
import { BACKGROUND_ASSETS, backgroundUrl } from '@/backgrounds/library';
import { useSceneTimer } from '@/composables/useSceneTimer';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseMix } from '@/services/ambience';
import { restMusic } from '@/services/musicPlayer';
import { restSearches } from '@/services/playlistSearches';
import { pexelsMedia } from '@/services/previewMedia';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';

/**
 * 休息：午睡、散步、泡澡、静坐、听音乐（每种的背景、姿势、计时可选的时长在 @app/shared 的 rest.ts）。
 * - 先选怎么休息（选的时候背景就换过去），点开始；面板只留在哪、和她说话、换一幅 / 换个方式。
 * - 午睡、散步、泡澡、静坐的背景会动（同出逃：Pexels 的实拍视频、素材库的插画叠热气 / 花瓣 / 光点），"换一幅"在几幅里轮换；午睡时再压暗。
 * - 右上角竖着一列：音乐（网易云歌单）、白噪音（本机合成）、计时器（要的时候才开：选几分钟，到点轻轻响铃、震一下，她叫你）。
 * - 静坐：画面中间是跟着呼吸的圆圈（放松 4-6、方块 4-4-4-4、4-7-8）。
 * - 听音乐：去"一起听歌"（一个人时是它的一个人模式，中间的唱片能用手拨着转）。
 * - 一个人（?solo=1）：不记进任何聊天，随时能"叫上谁一起"；和她一起：她也在做同样的事（午睡也躺下、一分钟后睡着；
 *   静坐坐在呼吸圈旁边），开始、换了画面、到点各说一句，也能打字跟她说；午睡、静坐时她不主动说话，输入框收起来。
 *   聊天里记"来到…"（ScenePage）。她说的话用"休息"这一项 API（默认跟随「陪伴 · 快速」）和"休息"功能预设。
 */
const route = useRoute();
const router = useRouter();
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const location = inject(SCENE_LOCATION, ref(null));

const solo = computed(() => route.query.solo === '1' || !chars.list.length);
const her = computed<Character | null>(() => chars.byId(app.activeCharacterId) ?? chars.list[0] ?? null);
const chatId = computed(() => (solo.value || !her.value ? undefined : chat.chatOfCharacter(her.value.id)?.id));
const pronoun = computed(() => characterPronoun(her.value));

// —— 记在这台设备上：上次选的休息方式、每种的白噪音、看的哪一幅、计时选的几分钟，音量、呼吸节奏 ——
const SAVE_KEY = 'ai-mobile:rest:v1';
interface Saved {
  kind?: string;
  minutes?: Partial<Record<RestKind, number>>;
  noise?: Partial<Record<RestKind, RestNoise | null>>;
  view?: Partial<Record<RestKind, string>>;
  volume?: number;
  breath?: string;
}
function load(): Saved {
  try {
    return (JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null) ?? {};
  } catch {
    return {};
  }
}
const saved = load();
const isNoise = (v: unknown): v is RestNoise => (NOISE_KINDS as readonly unknown[]).includes(v);

const kind = ref<RestKind>(restActivity(route.query.do as string)?.id ?? restActivity(saved.kind)?.id ?? 'nap');
const activity = computed(() => restActivity(kind.value)!);
const minutesOf = reactive(
  Object.fromEntries(REST_ACTIVITIES.map((a) => [a.id, a.minutes.includes(saved.minutes?.[a.id] ?? -1) ? saved.minutes![a.id]! : a.defaultMinutes])) as Record<RestKind, number>,
);
const noiseOf = reactive(
  Object.fromEntries(
    REST_ACTIVITIES.map((a) => {
      const v = saved.noise?.[a.id];
      return [a.id, v === null ? null : isNoise(v) ? v : a.noise];
    }),
  ) as Record<RestKind, RestNoise | null>,
);
const viewOf = reactive<Partial<Record<RestKind, string>>>({ ...(saved.view ?? {}) });
const noiseVolume = ref(typeof saved.volume === 'number' ? Math.max(0, Math.min(100, saved.volume)) : 55);
const breathId = ref(BREATH_PATTERNS.some((p) => p.id === saved.breath) ? saved.breath! : BREATH_PATTERNS[0]!.id);
const pattern = computed(() => BREATH_PATTERNS.find((p) => p.id === breathId.value) ?? BREATH_PATTERNS[0]!);
watch(
  () => [kind.value, { ...minutesOf }, { ...noiseOf }, { ...viewOf }, noiseVolume.value, breathId.value] as const,
  ([k, minutes, noise, view, volume, breath]) => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ kind: k, minutes, noise, view, volume, breath }));
    } catch {
      /* 无痕模式：下次用默认的 */
    }
  },
);

// —— 先选，再开始 ——
type Phase = 'setup' | 'resting';
const phase = ref<Phase>('setup');
const startedAt = ref(0);

/** 在点击里调用：开白噪音要点击当下 */
function start() {
  if (kind.value === 'music') {
    goMusic();
    return;
  }
  phase.value = 'resting';
  startedAt.value = Date.now();
  doneNote.value = '';
  const n = noiseOf[kind.value];
  if (n && shownNoise.value !== n) playNoise(n);
  if (her.value && !solo.value) chars.setExpression(her.value.id, activity.value.expression);
  breathLoop();
  void speak('rest-start');
}
/** 听音乐就去"一起听歌"：一个人时是它的一个人模式 */
function goMusic() {
  void router.push({ path: '/scene/music', query: solo.value ? { solo: '1' } : {} });
}
function backToSetup() {
  phase.value = 'setup';
  line.value = '';
  doneNote.value = '';
  talkOpen.value = false;
  clearTimeout(remarkTimer);
  timer.cancel();
}

// —— 会动的背景：午睡、散步、泡澡、静坐有几幅画面 ——
const views = computed<EscapeView[]>(() => activity.value.views ?? []);
const view = computed<EscapeView | null>(() => views.value.find((v) => v.id === viewOf[kind.value]) ?? views.value[0] ?? null);
function show(id: string) {
  viewOf[kind.value] = id;
  pickerOpen.value = false;
  scheduleRemark();
}
function nextView() {
  const list = views.value;
  if (!list.length || !view.value) return;
  const i = list.findIndex((v) => v.id === view.value!.id);
  show(list[(i + 1) % list.length]!.id);
}
const pickerOpen = ref(false);
function thumbOf(v: EscapeView): string {
  if (v.kind === 'video') return pexelsMedia(v.poster);
  const asset = BACKGROUND_ASSETS.find((a) => a.id === v.image);
  return asset ? backgroundUrl(asset) : '';
}

// —— 计时器：右上角白噪音下面，要的时候才开 ——
const doneNote = ref('');
const timer = useSceneTimer({
  chimes: () => (kind.value === 'nap' ? 4 : 2),
  onEnd: (m) => {
    doneNote.value = `到点了 · ${activity.value.doneVerb} ${m} 分钟`;
    // 白噪音慢慢小下去；午睡、静坐的音乐也停（散步、泡澡的歌接着放）
    if (noisePlaying.value) void ambience.fadeOut(6);
    if ((kind.value === 'nap' || kind.value === 'sit') && restMusic.state.playing) void restMusic.fadeOut(6);
    if (her.value && !solo.value) chars.setExpression(her.value.id, 'smile');
    void speak('rest-end', m);
  },
});
// 记下这种休息上次选的几分钟，下次面板里先亮着它
watch(
  () => timer.state.startedAt,
  () => {
    if (timer.running.value) minutesOf[kind.value] = timer.state.minutes;
  },
);
const timerHint = computed(() => {
  const base = kind.value === 'nap' ? '到点轻轻响几声铃、震一下' : '到点响两声，白噪音慢慢停';
  return !solo.value && her.value ? `${base}，${her.value.name}${kind.value === 'nap' ? '叫你起来' : '跟你说一声'}` : base;
});

// —— 静坐：跟着圆圈呼吸 ——
const breathT = ref(0);
let breathRaf = 0;
function breathLoop() {
  cancelAnimationFrame(breathRaf);
  if (kind.value !== 'sit' || phase.value !== 'resting') return;
  const step = () => {
    if (kind.value !== 'sit' || phase.value !== 'resting') return;
    breathT.value = (Date.now() - startedAt.value) / 1000;
    breathRaf = requestAnimationFrame(step);
  };
  step();
}
const breath = computed(() => breathAt(pattern.value, breathT.value));
const breathScale = computed(() => {
  const { phase: p, progress: x } = breath.value;
  const ease = (v: number) => 0.5 - Math.cos(Math.PI * v) / 2;
  if (p === 'in') return 0.55 + 0.45 * ease(x);
  if (p === 'out') return 1 - 0.45 * ease(x);
  return p === 'hold' ? 1 : 0.55;
});

// —— 白噪音：本机合成，一次放一种 ——
const noisePlaying = computed(() => ambience.state.playing && !ambience.state.fading);
const playingNoise = ref<RestNoise | null>(null);
const mixOf = (k: RestNoise, v: number): NoiseMix => ({ rain: 0, fire: 0, waves: 0, fan: 0, [k]: v });
function playNoise(k: RestNoise) {
  playingNoise.value = k;
  void ambience.start(mixOf(k, noiseVolume.value));
}
/** 在点击里调用：选了就放，记成这种休息的白噪音；null 是关掉 */
function pickNoise(k: RestNoise | null) {
  noiseOf[kind.value] = k;
  if (!k) {
    ambience.stop();
    playingNoise.value = null;
    return;
  }
  playNoise(k);
}
watch(noiseVolume, (v) => {
  if (noisePlaying.value && playingNoise.value) ambience.setMix(mixOf(playingNoise.value, v));
});
const shownNoise = computed<RestNoise | null>(() => (noisePlaying.value ? playingNoise.value : null));

// —— 右上角一列：音乐、白噪音、计时器，面板同一时间只开一个 ——
type Pop = 'music' | 'noise' | 'timer';
const pop = ref<Pop | null>(null);
function togglePop(p: Pop) {
  pop.value = pop.value === p ? null : p;
}
const musicPlaying = computed(() => restMusic.state.playing && !restMusic.state.fading);

onBeforeUnmount(() => {
  cancelAnimationFrame(breathRaf);
  clearTimeout(remarkTimer);
  ambience.stop();
  restMusic.stop();
});

// —— 她说话 ——
const line = ref('');
const typing = ref(false);
const failed = ref('');
const notConnected = ref('');
const said: string[] = [];
const mins = (sec: number) => Math.max(1, Math.round(sec / 60));
const userName = computed(() => personaOf(chatId.value ? chat.chatById(chatId.value) : undefined).name);

function sceneInput(endedMinutes?: number): string {
  const a = activity.value;
  const you = userName.value;
  const lines = [`${you}在休息：${a.name}`, `你也在${a.name}，陪着${you}`];
  if (view.value) lines.push(`眼前：${view.value.desc}`);
  if (phase.value === 'resting' && startedAt.value) lines.push(`已经歇了 ${mins((Date.now() - startedAt.value) / 1000)} 分钟`);
  if (timer.running.value) lines.push(`定了 ${timer.state.minutes} 分钟的计时，还剩 ${mins(timer.remainSec.value)} 分钟`);
  if (endedMinutes) lines.push(`计时到点了：${a.doneVerb} ${endedMinutes} 分钟`);
  if (a.id === 'sit') lines.push(`呼吸节奏：${pattern.value.name}（${pattern.value.desc}）`);
  if (shownNoise.value) lines.push(`开着白噪音：${NOISE_LABEL[shownNoise.value].label}`);
  const song = restMusic.current();
  if (song && musicPlaying.value) lines.push(`在听歌：《${song.title}》- ${song.artist}${restMusic.state.demo ? '（示例歌曲）' : ''}`);
  if (said.length) lines.push(`你刚才说过：${said.slice(-3).join(' / ')}`);
  return lines.join('\n');
}
function sayIt(text: string, expr?: string | null) {
  line.value = text;
  said.push(text);
  if (expr && her.value) chars.setExpression(her.value.id, expr);
}
async function speak(task: 'rest-start' | 'rest-check' | 'rest-end', endedMinutes?: number) {
  const id = chatId.value;
  if (!id || typing.value) return;
  typing.value = true;
  failed.value = '';
  const r = await chat.sceneReply(id, { task, input: sceneInput(endedMinutes), cue: `休息 · ${activity.value.name}`, allowedTags: ['expr'], agent: 'rest' });
  typing.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    // 换了画面那句没说上就算了
    else if (task !== 'rest-check') failed.value = r.reason;
    return;
  }
  notConnected.value = '';
  sayIt(r.message.text || '……', r.message.expression);
}

/** 散步、泡澡换了一幅画面：等画面停下来一会儿她再说一句（一直在翻就不说；午睡、静坐不打扰） */
let remarkTimer = 0;
let lastTalkAt = 0;
function scheduleRemark() {
  clearTimeout(remarkTimer);
  if (!chatId.value || phase.value !== 'resting' || activity.value.quiet) return;
  remarkTimer = window.setTimeout(() => {
    if (Date.now() - lastTalkAt < 30_000) return;
    void speak('rest-check');
  }, 2400);
}

const talk = ref('');
/** 午睡、静坐时输入框收起来，点"小声说一句"才出来 */
const talkOpen = ref(false);
const showTalk = computed(() => !solo.value && !!her.value && phase.value === 'resting' && (!activity.value.quiet || talkOpen.value));
async function sendTalk() {
  const text = talk.value.trim();
  const id = chatId.value;
  if (!text || !id || typing.value) return;
  clearTimeout(remarkTimer);
  talk.value = '';
  lastTalkAt = Date.now();
  typing.value = true;
  failed.value = '';
  const r = await chat.sceneReply(id, { task: 'rest-chat', input: sceneInput(), userText: text, cue: `休息 · ${activity.value.name}`, allowedTags: ['expr'], agent: 'rest' });
  typing.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else failed.value = r.reason;
    return;
  }
  notConnected.value = '';
  sayIt(r.message.text || '……', r.message.expression);
}

// —— 一个人 ⇄ 叫上她 ——
const inviteOpen = ref(false);
function wantTogether() {
  if (!solo.value) return;
  if (chars.list.length === 1) invite(chars.list[0]!);
  else inviteOpen.value = true;
}
function invite(c: Character) {
  inviteOpen.value = false;
  app.activeCharacterId = c.id;
  const { solo: _solo, ...rest } = route.query;
  void router.replace({ query: rest });
}
function goSolo() {
  if (solo.value) return;
  clearTimeout(remarkTimer);
  line.value = '';
  failed.value = '';
  notConnected.value = '';
  talkOpen.value = false;
  void router.replace({ query: { ...route.query, solo: '1' } });
}
// 歇到一半叫上了她：她说一句
watch(chatId, (id, old) => {
  if (id && id !== old && phase.value === 'resting') void speak('rest-start');
});

// —— 画面：背景、她躺着还是坐着、午睡时暗下来 ——
const backgroundPlace = computed<BackgroundPlace>(() => {
  const a = activity.value;
  return {
    id: `${location.value?.id ?? 'real:home'}:${a.backdrop}`,
    name: BACKGROUND_KINDS[a.backdrop].label,
    backdrop: a.backdrop,
    indoor: a.indoor,
    ...(a.backgroundSet ? { backgroundSet: a.backgroundSet } : {}),
  };
});
const layoutKey = computed(() => {
  if (phase.value === 'resting' && kind.value === 'nap') return 'rest:nap';
  if (phase.value === 'resting' && kind.value === 'sit') return 'rest:sit';
  return view.value ? 'rest:view' : 'rest';
});
const layout = computed(() => SCENE_FIGURE_LAYOUTS.find((s) => s.id === layoutKey.value)!.layout!);
const pose = computed(() => (phase.value === 'setup' && kind.value === 'nap' ? 'sit' : activity.value.pose));
/** 午睡一分钟以后她也睡着了（到点她先醒，叫你）；顺便给面板上的钟用 */
const now = ref(Date.now());
const nowTick = window.setInterval(() => (now.value = Date.now()), 15_000);
onBeforeUnmount(() => clearInterval(nowTick));
const expression = computed(() => (phase.value === 'resting' && kind.value === 'nap' && !doneNote.value && now.value - startedAt.value > 60_000 ? 'sleep' : undefined));
const dim = computed(() => (phase.value === 'resting' && kind.value === 'nap' && !doneNote.value ? 0.45 : 0));
/** 顶栏要给"连线 / 坐在旁边"和聊天记录让地方：休息中只写在做什么 */
const title = computed(() => (phase.value === 'setup' ? '休息' : activity.value.name));
const herDoing = computed(() => (her.value ? pronounText(activity.value.together, her.value) : ''));
const placeLabel = computed(() => view.value?.label ?? BACKGROUND_KINDS[activity.value.backdrop].label);
const clockText = computed(() => {
  const d = new Date(now.value);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
});
</script>

<template>
  <SceneShell
    class="rest-shell"
    scene-id="rest"
    :title="title"
    :backdrop="activity.backdrop"
    :background-location="backgroundPlace"
    :rain="shownNoise === 'rain' && !view"
    :dim="dim"
    :pose="pose"
    :outfit="activity.outfit"
    :expression="expression"
    :line="solo ? undefined : line"
    :typing="!solo && typing && !line"
    :hide-figure="solo"
    :hide-mode="solo"
    :layout="layout"
    :layout-key="layoutKey"
  >
    <template v-if="view" #backdrop>
      <EscapeBackdrop :view="view" />
      <!-- 午睡：会动的背景上再压暗一点（素材库的背景由外壳的 dim 压暗） -->
      <div v-if="dim" class="dim-layer" :style="{ opacity: dim }" />
    </template>
    <template #overlay>
      <!-- 右上角：音乐、白噪音、计时器，竖着排在顶栏下面（同出逃） -->
      <div class="side-tools">
        <button
          type="button"
          class="tool"
          :class="{ on: musicPlaying }"
          :aria-expanded="pop === 'music'"
          :aria-label="musicPlaying ? `音乐：${restMusic.current()?.title ?? '正在播放'}` : '音乐'"
          data-testid="rest-music-btn"
          @click="togglePop('music')"
        >
          <span :class="restMusic.state.loading ? 'i-lucide-loader-circle spin' : musicPlaying ? 'i-lucide-disc-3 spin-slow' : 'i-lucide-music'" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ on: noisePlaying }"
          :aria-expanded="pop === 'noise'"
          :aria-label="`白噪音：${shownNoise ? NOISE_LABEL[shownNoise].label : '关'}`"
          data-testid="rest-noise-btn"
          @click="togglePop('noise')"
        >
          <span :class="[shownNoise ? NOISE_LABEL[shownNoise].icon : 'i-lucide-audio-lines', { spin: ambience.state.loading }]" />
        </button>
        <TimerButton class="tool" :timer="timer" :aria-expanded="pop === 'timer'" @click="togglePop('timer')" />
      </div>
      <div v-if="pop" class="pop-catcher" @click="pop = null" />
      <div v-if="pop === 'music'" class="side-pop" role="dialog" aria-label="音乐">
        <PlaylistMusic :player="restMusic" :searches="restSearches" test-id="rest-music" />
      </div>
      <div v-if="pop === 'noise'" class="side-pop pad" role="dialog" aria-label="白噪音" data-testid="rest-noise">
        <div class="flex gap-2 flex-wrap">
          <button type="button" class="chip" :class="{ on: !shownNoise }" @click="pickNoise(null)"><span class="i-lucide-volume-x" />关</button>
          <button v-for="k in NOISE_KINDS" :key="k" type="button" class="chip" :class="{ on: shownNoise === k }" :aria-pressed="shownNoise === k" :data-noise="k" @click="pickNoise(k)">
            <span :class="NOISE_LABEL[k].icon" />{{ NOISE_LABEL[k].label }}
          </button>
        </div>
        <div class="flex items-center gap-3 mt-3 px-1">
          <span class="i-lucide-volume-2 text-ink-3 shrink-0" />
          <van-slider v-model="noiseVolume" class="flex-1" bar-height="4px" button-size="16px" aria-label="白噪音音量" />
        </div>
        <p v-if="ambience.state.error" class="text-[12px] text-bad mt-2 mb-0">{{ ambience.state.error }}</p>
        <p class="text-[11.5px] text-ink-3 mt-2 mb-0">在这台设备上合成，不联网、不用流量；选了的下次{{ activity.name }}时自动开</p>
      </div>
      <div v-if="pop === 'timer'" class="side-pop pad" role="dialog" aria-label="计时器">
        <TimerPop :timer="timer" :options="activity.minutes" :preferred="minutesOf[kind]" :hint="timerHint" />
      </div>

      <!-- 静坐：跟着呼吸的圆圈 -->
      <div v-if="phase === 'resting' && kind === 'sit'" class="breath-wrap" :class="{ beside: !solo }" aria-live="polite" data-testid="rest-breath">
        <div class="breath-halo" :style="{ transform: `scale(${breathScale})` }" />
        <div class="breath-core" :style="{ transform: `scale(${0.6 + breathScale * 0.4})` }">
          <span class="breath-word">{{ BREATH_PHASE_LABEL[breath.phase] }}</span>
          <span class="num breath-count">{{ breath.left }}</span>
        </div>
      </div>
    </template>

    <div v-if="!solo && notConnected" class="mini-notice" data-testid="rest-not-connected">
      <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ her?.name }}说不了话：{{ notConnected }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=rest')">去设置</button>
    </div>
    <div v-else-if="!solo && failed" class="mini-notice">
      <span class="i-lucide-circle-alert shrink-0" /><span class="flex-1 min-w-0">{{ pronoun }}没回上来：{{ failed }}</span>
    </div>

    <!-- 选怎么休息 -->
    <template v-if="phase === 'setup'">
      <div class="head">
        <span class="text-[15px] font-600">怎么休息</span>
        <span class="flex-1" />
        <div class="seg" role="radiogroup" aria-label="一个人还是一起">
          <button type="button" role="radio" :aria-checked="solo" :class="{ on: solo }" data-testid="rest-solo" @click="goSolo"><span class="i-lucide-user-round" />一个人</button>
          <button type="button" role="radio" :aria-checked="!solo" :class="{ on: !solo }" :disabled="!chars.list.length" data-testid="rest-together" @click="wantTogether">
            <Avatar v-if="her" :character="her" :size="18" />{{ !solo && her ? `和${her.name}` : '叫上谁' }}
          </button>
        </div>
      </div>

      <div class="kinds" role="radiogroup" aria-label="休息方式">
        <button
          v-for="a in REST_ACTIVITIES"
          :key="a.id"
          type="button"
          role="radio"
          class="kind"
          :class="{ on: kind === a.id }"
          :aria-checked="kind === a.id"
          :data-kind="a.id"
          @click="kind = a.id"
        >
          <span class="kind-icon"><span :class="a.icon" /></span>
          <span class="kind-name">{{ a.name }}</span>
        </button>
      </div>
      <p class="blurb">{{ activity.blurb }}</p>

      <div v-if="kind === 'sit'" class="chips">
        <button v-for="p in BREATH_PATTERNS" :key="p.id" type="button" class="chip" :class="{ on: breathId === p.id }" :aria-pressed="breathId === p.id" @click="breathId = p.id">
          {{ p.name }}<span class="text-ink-3 text-[11px]">{{ p.desc }}</span>
        </button>
      </div>
      <div v-if="!solo && her && kind !== 'music'" class="her-row">
        <Avatar :character="her" :size="26" />
        <span class="truncate">{{ herDoing }}</span>
      </div>
      <button type="button" class="primary" data-testid="rest-start" @click="start">
        <span :class="activity.icon" />{{ kind === 'music' ? (solo ? '去听音乐' : `去和${her?.name ?? 'Ta'}一起听歌`) : `开始${activity.name}` }}
      </button>
    </template>

    <!-- 休息中：只留在哪、和她说话、换一幅 / 换个方式 -->
    <template v-else>
      <div v-if="doneNote" class="done" data-testid="rest-done">
        <span class="i-lucide-alarm-clock-check shrink-0" />
        <span class="flex-1 min-w-0">{{ doneNote }}</span>
        <button type="button" class="text-ink-3 shrink-0" aria-label="知道了" @click="doneNote = ''"><span class="i-lucide-x" /></button>
      </div>
      <div class="where">
        <span :class="activity.icon" class="shrink-0" />
        <span class="shrink-0">{{ activity.name }}</span>
        <button v-if="views.length" type="button" class="place" aria-haspopup="dialog" :aria-label="`换个画面（现在是${placeLabel}）`" data-testid="rest-picker-btn" @click="pickerOpen = true">
          <span class="truncate">· {{ placeLabel }}</span><span class="i-lucide-chevron-down shrink-0" />
        </button>
        <span v-else class="text-ink-3 truncate">· {{ placeLabel }}</span>
        <span class="flex-1" />
        <span class="num text-ink-3 shrink-0">{{ clockText }}</span>
      </div>
      <p v-if="!solo && her" class="her-line"><Avatar :character="her" :size="18" /><span class="truncate">{{ herDoing }}</span></p>

      <form v-if="showTalk && her" class="talk" @submit.prevent="sendTalk">
        <input
          v-model="talk"
          class="field"
          :placeholder="activity.quiet ? `小声跟${her.name}说…` : `跟${her.name}说…`"
          :aria-label="`跟${her.name}说`"
          enterkeyhint="send"
          data-testid="rest-talk"
        />
        <button type="submit" class="send" :disabled="!talk.trim() || typing" aria-label="发送"><span class="i-lucide-send" /></button>
      </form>

      <div class="row">
        <button v-if="views.length" type="button" class="act" data-testid="rest-next" @click="nextView"><span class="i-lucide-refresh-cw" />换一幅</button>
        <button v-if="!solo && her && activity.quiet && !talkOpen" type="button" class="act" @click="talkOpen = true"><span class="i-lucide-message-circle" />小声说一句</button>
        <button type="button" class="act" data-testid="rest-change" @click="backToSetup"><span class="i-lucide-leaf" />换个方式</button>
        <button v-if="solo" type="button" class="act" :disabled="!chars.list.length" data-testid="rest-invite" @click="wantTogether"><span class="i-lucide-user-plus" />叫上谁</button>
        <button v-else type="button" class="act" data-testid="rest-go-solo" @click="goSolo"><span class="i-lucide-user-round" />一个人歇</button>
      </div>
    </template>

    <!-- 换个画面 -->
    <van-popup v-model:show="pickerOpen" position="bottom" round teleport="body" :style="{ maxHeight: '70%' }">
      <div class="picker" data-testid="rest-picker">
        <div class="text-[15px] font-600">{{ activity.name }} · 换个画面</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-0">实拍是 Pexels 的视频（要联网，画面里没有人）；插画是场景素材库里的图，和立绘一个画风。</p>
        <div class="thumbs">
          <button
            v-for="v in views"
            :key="v.id"
            type="button"
            class="thumb"
            :class="{ on: v.id === view?.id }"
            :aria-label="`${v.label}（${v.kind === 'video' ? '实拍' : '插画'}）`"
            :aria-pressed="v.id === view?.id"
            :data-view="v.id"
            @click="show(v.id)"
          >
            <img :src="thumbOf(v)" alt="" loading="lazy" />
            <span class="tag">{{ v.kind === 'video' ? '实拍' : '插画' }}</span>
            <span class="label">{{ v.label }}</span>
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 叫上谁 -->
    <van-popup v-model:show="inviteOpen" position="bottom" round teleport="body" :style="{ maxHeight: '70%' }">
      <div class="picker" data-testid="rest-invite-sheet">
        <div class="text-[15px] font-600">叫上谁一起{{ activity.name }}</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-2">Ta也会{{ activity.name }}，陪着你；这一段记进你们的聊天。</p>
        <button v-for="c in chars.list" :key="c.id" type="button" class="who" :data-char="c.id" @click="invite(c)">
          <Avatar :character="c" :size="40" />
          <span class="flex-1 min-w-0 text-left">
            <span class="block font-600 truncate">{{ c.name }}</span>
            <span class="block text-[12px] text-ink-3 truncate">{{ c.status || '在自己那边' }}</span>
          </span>
          <span class="i-lucide-chevron-right text-ink-3" />
        </button>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
/* 她的那句话给右上角竖排的按钮让出位置 */
.rest-shell {
  --companion-right: 58px;
}
.tool {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 16px;
}
.tool.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.spin {
  animation: spin 1s linear infinite;
}
.spin-slow {
  animation: spin 4s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.side-tools {
  position: absolute;
  /* 比点空白处收起面板的那一层高：面板开着时再点一下按钮就收起 */
  z-index: 10;
  top: calc(var(--safe-top) + 56px);
  right: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pop-catcher {
  position: absolute;
  inset: 0;
  z-index: 9;
}
.side-pop {
  position: absolute;
  z-index: 11;
  top: calc(var(--safe-top) + 56px);
  left: 10px;
  right: 58px;
  max-height: 60%;
  overflow-y: auto;
  padding: 4px 14px 14px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}
.side-pop.pad {
  padding: 12px;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
  padding: 1px;
}

.dim-layer {
  position: absolute;
  inset: 0;
  background: #05060c;
  pointer-events: none;
  transition: opacity 1.2s ease;
}

/* —— 选怎么休息 —— */
.head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.seg {
  display: inline-flex;
  padding: 2px;
  border-radius: 99px;
  background: var(--panel);
}
.seg button {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  color: var(--ink-2);
  font-size: 12.5px;
  white-space: nowrap;
}
.seg button.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
.seg button:disabled {
  opacity: 0.5;
}
.kinds {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 6px;
  margin-top: 12px;
}
.kind {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 0 8px;
  border-radius: 16px;
  background: var(--panel);
  color: var(--ink-2);
  transition: transform 0.15s var(--ease);
}
.kind:active {
  transform: scale(0.96);
}
.kind-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--tint) 22%, transparent);
  color: var(--ink);
  font-size: 19px;
}
.kind-name {
  font-size: 13px;
}
.kind.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1.5px solid var(--accent-line);
}
.kind.on .kind-icon {
  background: var(--accent);
  color: var(--on-accent);
}
.blurb {
  margin: 10px 2px 0;
  font-size: 13px;
  color: var(--ink-2);
}
.her-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 7px 10px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
  color: var(--ink-2);
}
.primary {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  height: 46px;
  margin-top: 14px;
  border-radius: 14px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 15.5px;
  font-weight: 600;
}

/* —— 休息中 —— */
.done {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13.5px;
  font-weight: 600;
}
.where {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
}
.place {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  min-width: 0;
  padding: 0;
  background: none;
  color: var(--ink-3);
  font-size: inherit;
}
.her-line {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  font-size: 12.5px;
  color: var(--ink-3);
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.act {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 36px;
  padding: 0 6px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}
.act:disabled {
  opacity: 0.5;
}

/* 静坐：呼吸圈 */
.breath-wrap {
  position: absolute;
  z-index: 5;
  left: 50%;
  top: 22%;
  width: 220px;
  height: 220px;
  margin-left: -110px;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
.breath-wrap.beside {
  left: 36%;
  width: 180px;
  height: 180px;
  margin-left: -90px;
}
.breath-halo {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(circle, color-mix(in srgb, var(--tint) 70%, transparent) 0%, color-mix(in srgb, var(--tint) 45%, transparent) 55%, color-mix(in srgb, var(--tint) 12%, transparent) 70%);
  border: 1.5px solid color-mix(in srgb, #fff 55%, transparent);
  box-shadow: 0 0 40px color-mix(in srgb, var(--tint) 60%, transparent);
  will-change: transform;
}
.breath-core {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 56%;
  aspect-ratio: 1;
  border-radius: 50%;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  box-shadow: var(--shadow-sm);
  will-change: transform;
}
.breath-word {
  font-size: 17px;
  font-weight: 600;
}
.breath-count {
  margin-top: 2px;
  font-size: 13px;
  color: var(--ink-3);
}

/* —— 跟她说、换人 —— */
.talk {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.field {
  flex: 1;
  min-width: 0;
  height: 38px;
  padding: 0 14px;
  border-radius: 19px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 16px;
}
.field:focus {
  border-color: var(--accent-line);
}
.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 16px;
  flex-shrink: 0;
}
.send:disabled {
  opacity: 0.5;
}
.mini-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 10px;
  padding: 6px 10px;
  border-radius: 12px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}
.picker {
  padding: 16px 16px calc(var(--safe-bottom) + 16px);
}
.thumbs {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 8px;
  margin-top: 12px;
}
.thumb {
  position: relative;
  aspect-ratio: 9 / 16;
  border-radius: 12px;
  overflow: hidden;
  padding: 0;
  border: 2px solid transparent;
  background: var(--panel);
}
.thumb.on {
  border-color: var(--accent);
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.thumb .tag {
  position: absolute;
  top: 4px;
  left: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.5);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
}
.thumb .label {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 12px 5px 4px;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.6));
  color: #fff;
  font-size: 11px;
  line-height: 1.3;
  text-align: left;
}
.who {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 4px;
  border-bottom: 1px solid var(--border);
  background: none;
  color: var(--ink);
}
</style>
