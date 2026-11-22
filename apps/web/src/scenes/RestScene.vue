<script setup lang="ts">
import {
  BACKGROUND_KINDS,
  BREATH_PATTERNS,
  BREATH_PHASE_LABEL,
  REST_ACTIVITIES,
  breathAt,
  characterPronoun,
  minutesLabel,
  pronounText,
  restActivity,
  type BackgroundPlace,
  type Character,
  type RestKind,
  type RestNoise,
} from '@app/shared';
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import TimerRing from '@/components/scene/TimerRing.vue';
import { SCENE_FIGURE_LAYOUTS, SCENE_LOCATION } from '@/components/scene/location';
import { goBack } from '@/router';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseMix } from '@/services/ambience';
import { prepareChime, type Chime } from '@/services/chime';
import { restMusic } from '@/services/musicPlayer';
import { restSearches } from '@/services/playlistSearches';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { clock } from '@/utils/time';

/**
 * 休息：午睡、散步、泡澡、静坐、听音乐（每种的时长、背景、姿势在 @app/shared 的 rest.ts）。
 * - 一个人（?solo=1）：只有画面、计时、白噪音和音乐，不记进任何聊天；随时可以"叫上"一个角色；
 * - 和她一起：她也在做同样的事（午睡也躺下、静坐坐在旁边），开始、中途、到点各说一句，也能跟她说话；
 *   午睡、静坐时她不主动说话，只在开始和结束时说一句。聊天里记"来到…"（ScenePage）。
 * - 先选怎么休息、多久、开什么白噪音，点开始；定了时长的到点响铃（本机合成）、震一下，她叫你。
 * - 静坐：跟着圆圈呼吸（放松 4-6、方块 4-4-4-4、4-7-8）。
 * - 白噪音（services/ambience.ts，本机合成）和音乐（网易云歌单 restMusic）可以叠着放；她说话时不压低（她只说一两句）。
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

// —— 记在这台设备上：上次选的休息方式、每种的时长和白噪音、音量、呼吸节奏 ——
const SAVE_KEY = 'ai-mobile:rest:v1';
interface Saved {
  kind?: string;
  minutes?: Partial<Record<RestKind, number>>;
  noise?: Partial<Record<RestKind, RestNoise | null>>;
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
const noiseVolume = ref(typeof saved.volume === 'number' ? Math.max(0, Math.min(100, saved.volume)) : 55);
const breathId = ref(BREATH_PATTERNS.some((p) => p.id === saved.breath) ? saved.breath! : BREATH_PATTERNS[0]!.id);
const pattern = computed(() => BREATH_PATTERNS.find((p) => p.id === breathId.value) ?? BREATH_PATTERNS[0]!);
watch(
  () => [kind.value, { ...minutesOf }, { ...noiseOf }, noiseVolume.value, breathId.value] as const,
  ([k, minutes, noise, volume, breath]) => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ kind: k, minutes, noise, volume, breath }));
    } catch {
      /* 无痕模式：下次用默认的 */
    }
  },
);

// —— 计时：选好 → 开始 → 到点（或自己结束） ——
type Phase = 'setup' | 'running' | 'done';
const phase = ref<Phase>('setup');
/** 这一次定的分钟数（0 是不计时）：开始时记下，中途改设置不影响 */
const runMinutes = ref(0);
const startedAt = ref(0);
const pausedTotal = ref(0);
const pausedAt = ref<number | null>(null);
const now = ref(Date.now());
const timed = computed(() => runMinutes.value > 0);
const elapsedSec = computed(() => (startedAt.value ? Math.max(0, ((pausedAt.value ?? now.value) - startedAt.value - pausedTotal.value) / 1000) : 0));
const totalSec = computed(() => runMinutes.value * 60);
const remainSec = computed(() => Math.max(0, totalSec.value - elapsedSec.value));
const progress = computed(() => (timed.value ? Math.min(1, elapsedSec.value / totalSec.value) : 0));
const finished = ref<{ sec: number; byTimer: boolean } | null>(null);

let ticker = 0;
let chime: Chime | null = null;
let midSaid = false;
let lastTalkAt = 0;

/** 在点击里调用：借好提示音、开白噪音都要点击当下 */
function start() {
  runMinutes.value = minutesOf[kind.value];
  startedAt.value = Date.now();
  now.value = startedAt.value;
  pausedTotal.value = 0;
  pausedAt.value = null;
  finished.value = null;
  midSaid = false;
  phase.value = 'running';
  chime?.dispose();
  chime = timed.value ? prepareChime() : null;
  const n = noiseOf[kind.value];
  if (n) playNoise(n);
  else if (noisePlaying.value) ambience.stop();
  if (her.value && !solo.value) chars.setExpression(her.value.id, activity.value.expression);
  clearInterval(ticker);
  ticker = window.setInterval(tick, 1000);
  breathLoop();
  void speak('rest-start');
}
function tick() {
  now.value = Date.now();
  if (phase.value !== 'running' || pausedAt.value) return;
  if (timed.value && remainSec.value <= 0) {
    finish(true);
    return;
  }
  midCheck();
}
function togglePause() {
  if (phase.value !== 'running') return;
  if (pausedAt.value) {
    pausedTotal.value += Date.now() - pausedAt.value;
    pausedAt.value = null;
    breathLoop();
  } else {
    pausedAt.value = Date.now();
  }
}
function finish(byTimer: boolean) {
  if (phase.value !== 'running') return;
  now.value = Date.now();
  // 到点的按定的时长算（切到后台时计时器会晚醒一会儿）
  finished.value = { sec: byTimer ? totalSec.value : elapsedSec.value, byTimer };
  phase.value = 'done';
  pausedAt.value = null;
  clearInterval(ticker);
  if (byTimer) chime?.ring(kind.value === 'nap' ? 4 : 2);
  // 到点了：白噪音慢慢小下去；午睡、静坐的音乐也停（散步、泡澡、听音乐的歌接着放）
  if (noisePlaying.value) void ambience.fadeOut(byTimer ? 6 : 2);
  if (byTimer && (kind.value === 'nap' || kind.value === 'sit') && restMusic.state.playing) void restMusic.fadeOut(6);
  if (her.value && !solo.value) chars.setExpression(her.value.id, 'smile');
  void speak('rest-end');
}
function again() {
  start();
}
function backToSetup() {
  phase.value = 'setup';
  finished.value = null;
  line.value = '';
}
onBeforeUnmount(() => {
  clearInterval(ticker);
  cancelAnimationFrame(breathRaf);
  chime?.dispose();
  ambience.stop();
  restMusic.stop();
});

/** 散步、泡澡、听音乐：一半的时候（不计时的到 10 分钟）她随口说一句；你刚说过话就不插嘴 */
function midCheck() {
  if (midSaid || activity.value.quiet || !chatId.value) return;
  const at = timed.value ? totalSec.value / 2 : 600;
  if (elapsedSec.value < at) return;
  midSaid = true;
  if (Date.now() - lastTalkAt < 60_000) return;
  void speak('rest-check');
}

// —— 静坐：跟着圆圈呼吸 ——
const breathT = ref(0);
let breathRaf = 0;
function breathLoop() {
  cancelAnimationFrame(breathRaf);
  if (kind.value !== 'sit' || phase.value !== 'running' || pausedAt.value) return;
  const step = () => {
    if (kind.value !== 'sit' || phase.value !== 'running' || pausedAt.value) return;
    breathT.value = (Date.now() - startedAt.value - pausedTotal.value) / 1000;
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
/** 在点击里调用：选了就放（选的时候能先听听），null 是关掉 */
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

// —— 音乐：网易云的歌单（听音乐时就在面板里，别的时候在右上角） ——
const musicPlaying = computed(() => restMusic.state.playing && !restMusic.state.fading);
const musicOpen = ref(false);
const noiseOpen = ref(false);
function toggleMusicPop() {
  noiseOpen.value = false;
  musicOpen.value = !musicOpen.value;
}
function toggleNoisePop() {
  musicOpen.value = false;
  noiseOpen.value = !noiseOpen.value;
}
function closePops() {
  musicOpen.value = false;
  noiseOpen.value = false;
}
const musicInPanel = computed(() => kind.value === 'music' && phase.value !== 'setup');

// —— 她说话 ——
const line = ref('');
const typing = ref(false);
const failed = ref('');
const notConnected = ref('');
const mins = (sec: number) => Math.max(0, Math.round(sec / 60));

const userName = computed(() => personaOf(chatId.value ? chat.chatById(chatId.value) : undefined).name);
function sceneInput(): string {
  const a = activity.value;
  const you = userName.value;
  const lines = [
    `${you}在休息：${a.name}${phase.value === 'setup' ? '' : timed.value ? `，定了 ${runMinutes.value} 分钟` : '，不计时'}`,
    `你也在${a.name}，陪着${you}`,
  ];
  if (phase.value === 'running') lines.push(`已经 ${mins(elapsedSec.value)} 分钟${timed.value ? `，还剩 ${Math.max(1, mins(remainSec.value))} 分钟` : ''}${pausedAt.value ? '（暂停了）' : ''}`);
  if (phase.value === 'done' && finished.value) lines.push(`${finished.value.byTimer ? '到点了' : `${you}自己结束了`}，一共 ${Math.max(1, mins(finished.value.sec))} 分钟`);
  if (a.id === 'sit') lines.push(`呼吸节奏：${pattern.value.name}（${pattern.value.desc}）`);
  if (shownNoise.value) lines.push(`开着白噪音：${NOISE_LABEL[shownNoise.value].label}`);
  const song = restMusic.current();
  if (song && musicPlaying.value) lines.push(`在听歌：《${song.title}》- ${song.artist}${restMusic.state.demo ? '（示例歌曲）' : ''}`);
  return lines.join('\n');
}
async function speak(task: 'rest-start' | 'rest-check' | 'rest-end') {
  const id = chatId.value;
  if (!id || typing.value) return;
  typing.value = true;
  failed.value = '';
  const r = await chat.sceneReply(id, { task, input: sceneInput(), cue: `休息 · ${activity.value.name}`, allowedTags: ['expr'] });
  typing.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    // 中途那句没说上就算了
    else if (task !== 'rest-check') failed.value = r.reason;
    return;
  }
  notConnected.value = '';
  line.value = r.message.text || '……';
  if (r.message.expression && her.value) chars.setExpression(her.value.id, r.message.expression);
}

const talk = ref('');
/** 午睡、静坐时输入框收起来，点"小声说一句"才出来 */
const talkOpen = ref(false);
const showTalk = computed(() => !solo.value && !!her.value && phase.value !== 'setup' && (!activity.value.quiet || talkOpen.value || phase.value === 'done'));
/** 一个人休息时画面中间有大计时圈，面板里就不再写一遍时间 */
const ringShown = computed(() => phase.value === 'running' && solo.value && kind.value !== 'sit');
async function sendTalk() {
  const text = talk.value.trim();
  const id = chatId.value;
  if (!text || !id || typing.value) return;
  talk.value = '';
  lastTalkAt = Date.now();
  typing.value = true;
  failed.value = '';
  const r = await chat.sceneReply(id, { task: 'rest-chat', input: sceneInput(), userText: text, cue: `休息 · ${activity.value.name}`, allowedTags: ['expr'] });
  typing.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else failed.value = r.reason;
    return;
  }
  notConnected.value = '';
  line.value = r.message.text || '……';
  if (r.message.expression && her.value) chars.setExpression(her.value.id, r.message.expression);
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
  line.value = '';
  failed.value = '';
  notConnected.value = '';
  talkOpen.value = false;
  void router.replace({ query: { ...route.query, solo: '1' } });
}
// 休息到一半叫上了她：她说一句"来了"
watch(chatId, (id, old) => {
  if (id && id !== old && phase.value === 'running') void speak('rest-start');
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
const layoutKey = computed(() => (phase.value === 'running' && kind.value === 'nap' ? 'rest:nap' : kind.value === 'sit' && phase.value === 'running' ? 'rest:sit' : 'rest'));
const layout = computed(() => SCENE_FIGURE_LAYOUTS.find((s) => s.id === layoutKey.value)!.layout!);
const pose = computed(() => (phase.value === 'setup' && kind.value === 'nap' ? 'sit' : activity.value.pose));
/** 午睡一分钟以后她也睡着了（到点她先醒，叫你） */
const expression = computed(() => (phase.value === 'running' && kind.value === 'nap' && elapsedSec.value > 60 ? 'sleep' : undefined));
const dim = computed(() => (phase.value === 'running' && kind.value === 'nap' ? 0.45 : 0));
const title = computed(() => (phase.value === 'setup' ? '休息' : `休息 · ${activity.value.name}`));
const herDoing = computed(() => (her.value ? pronounText(activity.value.together, her.value) : ''));
const doneText = computed(() => {
  const f = finished.value;
  if (!f) return '';
  const m = Math.max(1, mins(f.sec));
  return `${activity.value.doneVerb} ${m} 分钟`;
});
const startLabel = computed(() => `开始${activity.value.name}${minutesOf[kind.value] ? ` · ${minutesOf[kind.value]} 分钟` : ''}`);
</script>

<template>
  <SceneShell
    class="rest-shell"
    scene-id="rest"
    :title="title"
    :backdrop="activity.backdrop"
    :background-location="backgroundPlace"
    :rain="shownNoise === 'rain' && kind !== 'bath'"
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
    <template #overlay>
      <!-- 右上角：音乐、白噪音，竖着排在顶栏下面（同出逃） -->
      <div class="side-tools">
        <button
          v-if="!musicInPanel"
          type="button"
          class="tool"
          :class="{ on: musicPlaying }"
          :aria-expanded="musicOpen"
          :aria-label="musicPlaying ? `音乐：${restMusic.current()?.title ?? '正在播放'}` : '音乐'"
          data-testid="rest-music-btn"
          @click="toggleMusicPop"
        >
          <span :class="restMusic.state.loading ? 'i-lucide-loader-circle spin' : musicPlaying ? 'i-lucide-disc-3 spin-slow' : 'i-lucide-music'" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ on: noisePlaying }"
          :aria-expanded="noiseOpen"
          :aria-label="`白噪音：${shownNoise ? NOISE_LABEL[shownNoise].label : '关'}`"
          data-testid="rest-noise-btn"
          @click="toggleNoisePop"
        >
          <span :class="[shownNoise ? NOISE_LABEL[shownNoise].icon : 'i-lucide-audio-lines', { spin: ambience.state.loading }]" />
        </button>
      </div>
      <div v-if="musicOpen || noiseOpen" class="pop-catcher" @click="closePops" />
      <div v-if="musicOpen" class="side-pop" role="dialog" aria-label="音乐">
        <PlaylistMusic :player="restMusic" :searches="restSearches" test-id="rest-music" />
      </div>
      <div v-if="noiseOpen" class="side-pop noise" role="dialog" aria-label="白噪音" data-testid="rest-noise">
        <div class="flex gap-2 flex-wrap">
          <button type="button" class="chip" :class="{ on: !shownNoise }" @click="pickNoise(null)"><span class="i-lucide-volume-x" />关</button>
          <button v-for="k in NOISE_KINDS" :key="k" type="button" class="chip" :class="{ on: shownNoise === k }" :aria-pressed="shownNoise === k" @click="pickNoise(k)">
            <span :class="NOISE_LABEL[k].icon" />{{ NOISE_LABEL[k].label }}
          </button>
        </div>
        <div class="flex items-center gap-3 mt-3 px-1">
          <span class="i-lucide-volume-2 text-ink-3 shrink-0" />
          <van-slider v-model="noiseVolume" class="flex-1" bar-height="4px" button-size="16px" aria-label="白噪音音量" />
        </div>
        <p v-if="ambience.state.error" class="text-[12px] text-bad mt-2 mb-0">{{ ambience.state.error }}</p>
        <p class="text-[11.5px] text-ink-3 mt-2 mb-0">在这台设备上合成，不联网、不用流量</p>
      </div>

      <!-- 画面中间：一个人时的大计时圈；静坐时的呼吸圈 -->
      <div v-if="phase === 'running' && kind === 'sit'" class="breath-wrap" :class="{ beside: !solo }" aria-live="polite" data-testid="rest-breath">
        <div class="breath-halo" :style="{ transform: `scale(${breathScale})` }" />
        <div class="breath-core" :style="{ transform: `scale(${0.6 + breathScale * 0.4})` }">
          <span class="breath-word">{{ pausedAt ? '暂停' : BREATH_PHASE_LABEL[breath.phase] }}</span>
          <span v-if="!pausedAt" class="num breath-count">{{ breath.left }}</span>
        </div>
      </div>
      <div v-else-if="ringShown" class="center-ring" :class="{ nap: kind === 'nap' }">
        <TimerRing
          :remain-sec="timed ? remainSec : elapsedSec"
          :total-sec="timed ? totalSec : 3600"
          :count-up="!timed"
          :size="196"
          tone="var(--tint)"
          :label="pausedAt ? '暂停中' : timed ? `${activity.name} · 还剩` : `${activity.name} · 已经`"
        />
      </div>
    </template>

    <div v-if="!solo && notConnected" class="mini-notice" data-testid="rest-not-connected">
      <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ her?.name }}说不了话：{{ notConnected }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
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

      <div class="opt">
        <span class="opt-label">多久</span>
        <div class="chips">
          <button v-for="m in activity.minutes" :key="m" type="button" class="chip" :class="{ on: minutesOf[kind] === m }" :aria-pressed="minutesOf[kind] === m" @click="minutesOf[kind] = m">
            {{ minutesLabel(m) }}
          </button>
        </div>
      </div>
      <div v-if="kind === 'sit'" class="opt">
        <span class="opt-label">呼吸</span>
        <div class="chips">
          <button v-for="p in BREATH_PATTERNS" :key="p.id" type="button" class="chip" :class="{ on: breathId === p.id }" :aria-pressed="breathId === p.id" @click="breathId = p.id">
            {{ p.name }}<span class="text-ink-3 text-[11px]">{{ p.desc }}</span>
          </button>
        </div>
      </div>
      <div class="opt">
        <span class="opt-label">白噪音</span>
        <div class="chips">
          <button type="button" class="chip" :class="{ on: !noiseOf[kind] }" @click="pickNoise(null)">关</button>
          <button v-for="k in NOISE_KINDS" :key="k" type="button" class="chip" :class="{ on: noiseOf[kind] === k }" :aria-pressed="noiseOf[kind] === k" :data-noise="k" @click="pickNoise(k)">
            <span :class="NOISE_LABEL[k].icon" />{{ NOISE_LABEL[k].label }}
          </button>
        </div>
      </div>

      <div v-if="!solo && her" class="her-row">
        <Avatar :character="her" :size="26" />
        <span class="truncate">{{ herDoing }}</span>
      </div>
      <button type="button" class="primary" data-testid="rest-start" @click="start"><span :class="activity.icon" />{{ startLabel }}</button>
    </template>

    <!-- 休息中 -->
    <template v-else-if="phase === 'running'">
      <div class="run-head">
        <span class="run-icon"><span :class="activity.icon" /></span>
        <div v-if="ringShown" class="flex-1 min-w-0">
          <div class="text-[16px] font-600">{{ activity.name }}{{ pausedAt ? ' · 暂停中' : '' }}</div>
          <div class="text-[12.5px] text-ink-3">{{ timed ? `定了 ${runMinutes} 分钟` : '不计时，想停就停' }}</div>
        </div>
        <div v-else class="flex-1 min-w-0">
          <div class="text-[13px] text-ink-3">{{ pausedAt ? '暂停中' : timed ? `${activity.name} · 还剩` : `${activity.name} · 已经` }}</div>
          <div class="num run-time">{{ clock(timed ? remainSec : elapsedSec) }}</div>
        </div>
        <button type="button" class="round" :aria-label="pausedAt ? '继续' : '暂停'" data-testid="rest-pause" @click="togglePause"><span :class="pausedAt ? 'i-lucide-play' : 'i-lucide-pause'" /></button>
        <button type="button" class="round end" aria-label="结束" data-testid="rest-end" @click="finish(false)"><span class="i-lucide-square" /></button>
      </div>
      <div v-if="timed" class="bar" aria-hidden="true"><span :style="{ width: `${progress * 100}%` }" /></div>

      <div v-if="!solo && her" class="her-row">
        <Avatar :character="her" :size="26" />
        <span class="flex-1 min-w-0 truncate">{{ herDoing }}</span>
        <button v-if="activity.quiet && !talkOpen" type="button" class="text-accent-ink text-[12.5px] shrink-0" @click="talkOpen = true">小声说一句</button>
      </div>
      <p v-else-if="activity.tip" class="tip"><span class="i-lucide-lightbulb shrink-0" />{{ activity.tip }}</p>

      <div v-if="musicInPanel" class="music-box">
        <PlaylistMusic :player="restMusic" :searches="restSearches" test-id="rest-music" />
      </div>
    </template>

    <!-- 结束了 -->
    <template v-else>
      <div class="done" data-testid="rest-done">
        <span class="done-icon"><span class="i-lucide-check" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[17px] font-700">{{ doneText }}</div>
          <div class="text-[12.5px] text-ink-3">{{ finished?.byTimer ? (kind === 'nap' ? '到点了，起来伸个懒腰' : '到点了') : '提前结束也没关系' }}</div>
        </div>
      </div>
      <div v-if="musicInPanel" class="music-box">
        <PlaylistMusic :player="restMusic" :searches="restSearches" test-id="rest-music" />
      </div>
      <div class="row">
        <button type="button" class="act" data-testid="rest-again" @click="again"><span class="i-lucide-rotate-ccw" />再来一次</button>
        <button type="button" class="act" @click="backToSetup"><span class="i-lucide-leaf" />换个方式</button>
        <button type="button" class="act" @click="goBack(app.mapPath)"><span class="i-lucide-log-out" />回去</button>
      </div>
    </template>

    <!-- 跟她说（午睡、静坐时收起来） -->
    <form v-if="showTalk && her" class="talk" @submit.prevent="sendTalk">
      <input v-model="talk" class="field" :placeholder="activity.quiet && phase === 'running' ? `小声跟${her.name}说…` : `跟${her.name}说…`" :aria-label="`跟${her.name}说`" enterkeyhint="send" data-testid="rest-talk" />
      <button type="submit" class="send" :disabled="!talk.trim() || typing" aria-label="发送"><span class="i-lucide-send" /></button>
    </form>
    <div v-if="phase === 'running'" class="switch">
      <button v-if="solo" type="button" :disabled="!chars.list.length" data-testid="rest-invite" @click="wantTogether"><span class="i-lucide-user-plus" />叫上谁一起</button>
      <button v-else type="button" data-testid="rest-go-solo" @click="goSolo"><span class="i-lucide-user-round" />一个人歇会儿</button>
    </div>

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
.side-pop.noise {
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
.opt {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-top: 12px;
}
.opt-label {
  flex-shrink: 0;
  width: 3.2em;
  line-height: 30px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  padding: 1px;
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
.run-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.run-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--tint) 26%, transparent);
  font-size: 20px;
  flex-shrink: 0;
}
.run-time {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.01em;
}
.round {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink);
  font-size: 17px;
  flex-shrink: 0;
}
.round.end {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.bar {
  height: 4px;
  margin-top: 12px;
  border-radius: 99px;
  background: var(--panel-2);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--tint);
  transition: width 0.9s linear;
}
.tip {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 12px 2px 0;
  font-size: 12.5px;
  color: var(--ink-3);
}
.music-box {
  margin-top: 8px;
}
.center-ring {
  position: absolute;
  z-index: 5;
  left: 0;
  right: 0;
  top: 22%;
  display: flex;
  justify-content: center;
  pointer-events: none;
  --ring-track: color-mix(in srgb, var(--ink) 12%, transparent);
}
.center-ring :deep(.timer-ring) {
  border-radius: 50%;
  background: var(--glass);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
.center-ring.nap {
  opacity: 0.8;
}

/* 静坐：呼吸圈 */
.breath-wrap {
  position: absolute;
  z-index: 5;
  left: 50%;
  top: 20%;
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

/* —— 结束 —— */
.done {
  display: flex;
  align-items: center;
  gap: 12px;
}
.done-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--tint);
  color: #fff;
  font-size: 22px;
  flex-shrink: 0;
}
.row {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}
.act {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 38px;
  padding: 0 8px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}

/* —— 跟她说、换人 —— */
.talk {
  display: flex;
  gap: 8px;
  margin-top: 12px;
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
.switch {
  display: flex;
  justify-content: center;
  margin-top: 10px;
}
.switch button {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  color: var(--ink-2);
  font-size: 12.5px;
}
.switch button:disabled {
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
