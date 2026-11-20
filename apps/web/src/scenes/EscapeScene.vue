<script setup lang="ts">
import { characterPronoun } from '@app/shared';
import { ESCAPE_DESTINATIONS, escapeDestination, escapePlaceId, escapeView, type Character, type EscapeView } from '@app/shared';
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import EscapeBackdrop from '@/components/scene/escape/EscapeBackdrop.vue';
import MicLinkBar from '@/components/scene/MicLinkBar.vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import { SCENE_LOCATION } from '@/components/scene/location';
import { BACKGROUND_ASSETS, backgroundUrl } from '@/backgrounds/library';
import { useMicLink } from '@/composables/useMicLink';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseKind, type NoiseMix } from '@/services/ambience';
import { escapeMusic } from '@/services/musicPlayer';
import { escapeSearches } from '@/services/playlistSearches';
import { personaOf } from '@/services/prompt';
import { SpeechQueue } from '@/services/speech';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { clock as linkClock } from '@/utils/time';

/**
 * 出逃：去一个很远的地方待一会儿。
 * - 一个人（?solo=1）：只有画面，不记进任何聊天；随时可以"叫上"一个角色；
 * - 带她一起：她站在画面里，到了一个地方、换了一幅画面时说一句，也能跟她说话；聊天里记"和她来到海边 · 出逃"。
 *   "让她先回去"就变回一个人。
 * - 连麦（输入框左边，composables/useMicLink.ts，和一起吃饭、健身一样）：说话她就听得到、用她的声音回你（escape-call）；
 *   连着时打的字也走麦里那一路，换了画面她也用声音说一句（escape-arrive）。
 * - 音乐（网易云的歌单，播放器 escapeMusic）和白噪音（services/ambience.ts，本机合成）一个人、带她都能开，可以叠着放；她说话时压低。
 * 去哪（?at=escape:海边这样的地点）由 ScenePage 记进聊天；这里换去处时改 ?at=，换同一个去处里的画面不改。
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

// —— 去哪、看哪一幅 ——
const LAST_VIEW = 'escape:last-view';
function readLast(): string | null {
  try {
    return localStorage.getItem(LAST_VIEW);
  } catch {
    return null;
  }
}
function saveLast(id: string) {
  try {
    localStorage.setItem(LAST_VIEW, id);
  } catch {
    /* 隐私模式等存不了：下次从第一幅开始 */
  }
}
const dest = computed(() => escapeDestination(location.value?.id) ?? escapeDestination(escapeView(readLast())?.dest.id) ?? ESCAPE_DESTINATIONS[0]!);
const viewId = ref<string | null>(null);
/** 在这个去处里看哪一幅：选过的 → 上次看的（同一个去处时）→ 第一幅 */
const view = computed<EscapeView>(() => {
  const d = dest.value;
  return d.views.find((v) => v.id === viewId.value) ?? d.views.find((v) => v.id === readLast()) ?? d.views[0]!;
});
watch(
  () => view.value.id,
  (id) => saveLast(id),
  { immediate: true },
);

/** 没指定去处时把上次的去处写进地址，ScenePage 按它记"来到…" */
if (!escapeDestination(route.query.at as string | undefined)) {
  void router.replace({ query: { ...route.query, at: escapePlaceId(dest.value.id) } });
}

function show(id: string) {
  const next = escapeView(id);
  if (!next) return;
  viewId.value = id;
  if (next.dest.id !== dest.value.id) void router.replace({ query: { ...route.query, at: escapePlaceId(next.dest.id) } });
  pickerOpen.value = false;
}
/** 同一个去处里换下一幅 */
function nextView() {
  const list = dest.value.views;
  const i = list.findIndex((v) => v.id === view.value.id);
  show(list[(i + 1) % list.length]!.id);
}

const pickerOpen = ref(false);
function thumbOf(v: EscapeView): string {
  if (v.kind === 'video') return v.poster;
  const asset = BACKGROUND_ASSETS.find((a) => a.id === v.image);
  return asset ? backgroundUrl(asset) : '';
}

// —— 一个人 ⇄ 带她 ——
const inviteOpen = ref(false);
function invite(c: Character) {
  inviteOpen.value = false;
  app.activeCharacterId = c.id;
  const { solo: _solo, ...rest } = route.query;
  void router.replace({ query: { ...rest, at: escapePlaceId(dest.value.id) } });
}
function goSolo() {
  clearTimeout(remarkTimer);
  void link.hangUp();
  line.value = '';
  void router.replace({ query: { ...route.query, solo: '1' } });
}

// —— 她说话 ——
const line = ref('');
const typing = ref(false);
const failed = ref('');
const notConnected = ref('');
const said: string[] = [];

function sceneInput(): string {
  const d = dest.value;
  const v = view.value;
  return [`你们在：${d.name}（${d.tagline}）`, `眼前：${v.desc}`, ...soundLines(), said.length ? `你刚才说过：${said.slice(-4).join(' / ')}` : ''].filter(Boolean).join('\n');
}
/** 在听的歌、开着的白噪音：写进场景任务 */
function soundLines(): string[] {
  const lines: string[] = [];
  const song = escapeMusic.current();
  if (song && musicPlaying.value) lines.push(`在听歌：《${song.title}》- ${song.artist}${escapeMusic.state.demo ? '（示例歌曲）' : ''}`);
  if (noisePlaying.value) lines.push(`开着白噪音：${NOISE_LABEL[noise.value].label}`);
  return lines;
}
function sayIt(text: string, expr?: string | null) {
  line.value = text;
  said.push(text);
  if (expr && her.value) chars.setExpression(her.value.id, expr);
}

/** 到了 / 换了画面：等画面停下来一会儿再让她开口（一直在翻就不说） */
let remarkTimer = 0;
function scheduleRemark(delay = 2400) {
  clearTimeout(remarkTimer);
  if (!chatId.value) return;
  remarkTimer = window.setTimeout(() => void remark(), delay);
}
async function remark() {
  const id = chatId.value;
  if (!id || typing.value) return;
  // 连着麦：用她的声音说；她在说、你在说时这次就不插话
  if (link.state.on) {
    if (link.state.her === 'idle' && link.state.you === 'idle') link.announce('escape-arrive', sceneInput());
    return;
  }
  const v = view.value;
  typing.value = true;
  failed.value = '';
  const r = await chat.sceneReply(id, { task: 'escape-arrive', input: sceneInput(), cue: `${dest.value.name} · ${v.label}`, allowedTags: ['expr'] });
  typing.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    // 她还在回上一句之类的：这次就不说了
    return;
  }
  notConnected.value = '';
  // 等她想好时已经换走了：话照样留在聊天里，画面上不显示
  if (view.value.id === v.id) sayIt(r.message.text || '……', r.message.expression);
}
watch(
  () => [chatId.value, view.value.id] as const,
  ([id], old) => {
    if (!id) return;
    // 刚叫上她、刚进来时快一点
    scheduleRemark(old?.[0] === id ? 2400 : 1200);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(remarkTimer));

const talk = ref('');
async function sendTalk() {
  const text = talk.value.trim();
  const id = chatId.value;
  if (!text || !id) return;
  // 连着麦：打的字也走麦里那一路，她用声音回
  if (link.state.on) {
    clearTimeout(remarkTimer);
    talk.value = '';
    void link.say(text);
    return;
  }
  if (typing.value) return;
  clearTimeout(remarkTimer);
  talk.value = '';
  typing.value = true;
  failed.value = '';
  const r = await chat.sceneReply(id, {
    task: 'escape-chat',
    input: sceneInput(),
    userText: text,
    cue: `${dest.value.name} · ${view.value.label}`,
    allowedTags: ['expr'],
  });
  typing.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    else failed.value = r.reason;
    return;
  }
  notConnected.value = '';
  sayIt(r.message.text || '……', r.message.expression);
}

// —— 连麦：说话她就听得到，用她的声音回你（输入框左边） ——
const userName = computed(() => personaOf(chatId.value ? chat.chatById(chatId.value) : undefined).name);
let speech: SpeechQueue | null = null;
function newSpeech(o: { onSentence?(text: string, i: number): void }): SpeechQueue {
  speech?.stop();
  const q = new SpeechQueue({ characterId: her.value!.id, onSentence: o.onSentence });
  speech = q;
  escapeMusic.duck(true);
  ambience.duck(true);
  void q.drained().then(() => {
    if (speech !== q) return;
    escapeMusic.duck(false);
    ambience.duck(false);
  });
  return q;
}
const link = useMicLink({
  chatId: computed(() => chatId.value ?? ''),
  // 一个人时连麦按钮不出现，用不到她
  character: computed(() => her.value as Character),
  userName,
  newSpeech,
  context: sceneInput,
  herBusy: () => false,
  onInterrupt: () => undefined,
  autoWhisper: () => false,
  tasks: { reply: 'escape-call' },
  input: (kind, info) =>
    kind === 'open'
      ? `${info.context}\n你们刚连上麦，${userName.value}在这里用语音跟你说话。先开口说第一句，1–2 个短句。`
      : `${info.context}\n连麦中（已经连了 ${info.linked}）。回${userName.value}刚才说的话。`,
  onReply: (text) => {
    notConnected.value = '';
    failed.value = '';
    sayIt(text);
  },
});
function toggleLink() {
  if (link.state.on) {
    void link.hangUp();
    return;
  }
  clearTimeout(remarkTimer);
  link.connect();
}
// 换了人、变回一个人：挂断
watch(chatId, () => {
  if (link.state.on) void link.hangUp();
});
/** 连着麦时画面上显示她正在说的那句 */
const lastSpoken = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'her')?.text ?? '');
const shownLine = computed(() => (link.state.on && lastSpoken.value) || line.value);
const herThinking = computed(() => typing.value || link.state.her === 'thinking');

// —— 音乐：网易云的歌单（components/scene/PlaylistMusic.vue），和白噪音可以一起开 ——
const musicOpen = ref(false);
const musicPlaying = computed(() => escapeMusic.state.playing && !escapeMusic.state.fading);

// —— 白噪音：本机合成（services/ambience.ts），不联网、不用 API ——
const NOISE_SAVE = 'escape:noise';
function readNoise(): { kind: NoiseKind; volume: number } {
  try {
    const v = JSON.parse(localStorage.getItem(NOISE_SAVE) ?? 'null') as { kind?: string; volume?: number } | null;
    const kind = (NOISE_KINDS as readonly string[]).includes(v?.kind ?? '') ? (v!.kind as NoiseKind) : 'waves';
    const volume = typeof v?.volume === 'number' ? Math.max(0, Math.min(100, v.volume)) : 60;
    return { kind, volume };
  } catch {
    return { kind: 'waves', volume: 60 };
  }
}
const savedNoise = readNoise();
const noise = ref<NoiseKind>(savedNoise.kind);
const noiseVolume = ref(savedNoise.volume);
watch([noise, noiseVolume], ([kind, volume]) => {
  try {
    localStorage.setItem(NOISE_SAVE, JSON.stringify({ kind, volume }));
  } catch {
    /* 存不了：下次用默认的 */
  }
});
const noiseOpen = ref(false);
const noisePlaying = computed(() => ambience.state.playing && !ambience.state.fading);
function mixOf(kind: NoiseKind, v: number): NoiseMix {
  return { rain: 0, fire: 0, waves: 0, fan: 0, [kind]: v };
}
/** 在点击里调用（浏览器只允许点了以后出声）；null 是关掉 */
function pickNoise(kind: NoiseKind | null) {
  if (!kind) {
    ambience.stop();
    return;
  }
  noise.value = kind;
  void ambience.start(mixOf(kind, noiseVolume.value));
}
watch(noiseVolume, (v) => {
  if (ambience.state.playing) ambience.setMix(mixOf(noise.value, v));
});

/** 右上角两个面板同一时间只开一个 */
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

onBeforeUnmount(() => {
  link.dispose();
  speech?.stop();
  escapeMusic.stop();
  ambience.stop();
});

const title = computed(() => `${dest.value.name} · ${view.value.label}`);
const clock = ref(new Date());
const tick = window.setInterval(() => (clock.value = new Date()), 30_000);
onBeforeUnmount(() => clearInterval(tick));
const timeText = computed(() => `${String(clock.value.getHours()).padStart(2, '0')}:${String(clock.value.getMinutes()).padStart(2, '0')}`);
</script>

<template>
  <SceneShell
    class="escape-shell"
    scene-id="escape"
    :title="title"
    :line="solo ? undefined : shownLine"
    :typing="!solo && herThinking && !shownLine"
    :hide-figure="solo"
    hide-mode
    :layout="{ left: 66, bottom: 22, height: 60 }"
  >
    <template #backdrop>
      <EscapeBackdrop :view="view" />
    </template>
    <template #actions>
      <button type="button" class="tool" aria-haspopup="dialog" aria-label="换个地方" data-testid="escape-picker-btn" @click="pickerOpen = true">
        <span class="i-lucide-map-pinned" />
      </button>
    </template>
    <template #overlay>
      <!-- 右上角：音乐、白噪音，竖着排在顶栏下面（同戳戳乐） -->
      <div class="side-tools">
        <button
          type="button"
          class="tool"
          :class="{ on: musicPlaying }"
          :aria-expanded="musicOpen"
          :aria-label="musicPlaying ? `音乐：${escapeMusic.current()?.title ?? '正在播放'}` : '音乐'"
          data-testid="escape-music-btn"
          @click="toggleMusicPop"
        >
          <span :class="escapeMusic.state.loading ? 'i-lucide-loader-circle spin' : musicPlaying ? 'i-lucide-disc-3 spin-slow' : 'i-lucide-music'" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ on: noisePlaying }"
          :aria-expanded="noiseOpen"
          :aria-label="`白噪音：${noisePlaying ? NOISE_LABEL[noise].label : '关'}`"
          data-testid="escape-noise-btn"
          @click="toggleNoisePop"
        >
          <span :class="[noisePlaying ? NOISE_LABEL[noise].icon : 'i-lucide-audio-lines', { spin: ambience.state.loading }]" />
        </button>
      </div>
      <!-- 在竖排按钮的左边展开，点空白处收起 -->
      <div v-if="musicOpen || noiseOpen" class="pop-catcher" @click="closePops" />
      <div v-if="musicOpen" class="side-pop" role="dialog" aria-label="音乐">
        <PlaylistMusic :player="escapeMusic" :searches="escapeSearches" test-id="escape-music" />
      </div>
      <div v-if="noiseOpen" class="side-pop noise" role="dialog" aria-label="白噪音" data-testid="escape-noise">
        <div class="flex gap-2 flex-wrap">
          <button type="button" class="chip" :class="{ on: !noisePlaying }" @click="pickNoise(null)"><span class="i-lucide-volume-x" />关</button>
          <button v-for="k in NOISE_KINDS" :key="k" type="button" class="chip" :class="{ on: noisePlaying && noise === k }" :aria-pressed="noisePlaying && noise === k" :data-noise="k" @click="pickNoise(k)">
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
    </template>

    <MicLinkBar v-if="!solo && her && link.state.on" class="mb-2.5" :link="link" :pronoun="her.pronoun" data-testid="escape-link" />
    <div v-else-if="!solo && notConnected" class="mini-notice" data-testid="escape-not-connected">
      <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ her?.name }}说不了话：{{ notConnected }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>
    <div v-else-if="!solo && failed" class="mini-notice">
      <span class="i-lucide-circle-alert shrink-0" /><span class="flex-1 min-w-0">{{ her?.pronoun }}没回上来：{{ failed }}</span>
    </div>

    <div class="where">
      <span :class="dest.icon" class="shrink-0" />
      <span class="truncate">{{ dest.name }}</span>
      <span class="text-ink-3 truncate">· {{ view.label }}</span>
      <span class="flex-1" />
      <span class="num text-ink-3 shrink-0">{{ timeText }}</span>
    </div>

    <!-- 连麦（左）+ 跟她说（同一起吃饭、健身） -->
    <form v-if="!solo && her" class="talk" @submit.prevent="sendTalk">
      <button
        type="button"
        class="mic-pill"
        :class="{ live: link.state.on }"
        :aria-label="link.state.on ? `挂断连麦（已经连了 ${linkClock(link.state.seconds)}）` : `和${her.name}连麦：说话${her.pronoun}就听得到`"
        data-testid="escape-mic"
        @click="toggleLink"
      >
        <template v-if="link.state.on"><span class="i-lucide-phone-off shrink-0" /><span class="num">{{ linkClock(link.state.seconds) }}</span></template>
        <template v-else><span class="i-lucide-headphones shrink-0" />连麦</template>
      </button>
      <input v-model="talk" class="field" :placeholder="`跟${her.name}说…`" :aria-label="`跟${her.name}说`" enterkeyhint="send" data-testid="escape-talk" />
      <button type="submit" class="round-btn" :disabled="!talk.trim() || (!link.state.on && typing)" aria-label="发送"><span class="i-lucide-send" /></button>
    </form>

    <div class="row">
      <button type="button" class="act" data-testid="escape-next" @click="nextView"><span class="i-lucide-refresh-cw" />换一幅</button>
      <button type="button" class="act" @click="pickerOpen = true"><span class="i-lucide-map-pinned" />换个地方</button>
      <button v-if="solo" type="button" class="act" :disabled="!chars.list.length" data-testid="escape-invite" @click="inviteOpen = true">
        <span class="i-lucide-user-plus" />叫上谁
      </button>
      <button v-else type="button" class="act" data-testid="escape-solo" @click="goSolo"><span class="i-lucide-user-round" />一个人待会儿</button>
    </div>

    <!-- 去哪、看哪一幅 -->
    <van-popup v-model:show="pickerOpen" position="bottom" round teleport="body" :style="{ maxHeight: '82%' }">
      <div class="picker" data-testid="escape-picker">
        <div class="text-[15px] font-600">去哪儿</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-0">插画是场景素材库里的图，和立绘一个画风；实拍是 Pexels 的视频。</p>
        <section v-for="d in ESCAPE_DESTINATIONS" :key="d.id" class="dest">
          <div class="dest-head">
            <span :class="d.icon" />
            <span class="font-600">{{ d.name }}</span>
            <span class="text-ink-3 text-[12px] truncate">{{ d.tagline }}</span>
          </div>
          <div class="thumbs">
            <button
              v-for="v in d.views"
              :key="v.id"
              type="button"
              class="thumb"
              :class="{ on: v.id === view.id }"
              :aria-label="`${d.name} · ${v.label}（${v.kind === 'video' ? '实拍' : '插画'}）`"
              :aria-pressed="v.id === view.id"
              :data-view="v.id"
              @click="show(v.id)"
            >
              <img :src="thumbOf(v)" alt="" loading="lazy" />
              <span class="tag">{{ v.kind === 'video' ? '实拍' : '插画' }}</span>
              <span class="label">{{ v.label }}</span>
            </button>
          </div>
        </section>
      </div>
    </van-popup>

    <!-- 叫上谁 -->
    <van-popup v-model:show="inviteOpen" position="bottom" round teleport="body" :style="{ maxHeight: '70%' }">
      <div class="picker" data-testid="escape-invite-sheet">
        <div class="text-[15px] font-600">叫上谁一起</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-2">{{ characterPronoun(her) }}会来到{{ dest.name }}，站在你旁边；这一段记进你们的聊天。</p>
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
/* 她的那句话给右上角竖排的按钮让出位置（按钮宽 38，两边各留 10） */
.escape-shell {
  --companion-right: 58px;
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
/* 盖住她的那句话和底下的面板，不盖顶栏和竖排的按钮 */
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
.where {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13.5px;
}
.talk {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.mic-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  flex-shrink: 0;
  height: 38px;
  padding: 0 13px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13.5px;
  white-space: nowrap;
}
.mic-pill.live {
  background: var(--bad);
  color: #fff;
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
.round-btn {
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
.round-btn:disabled {
  opacity: 0.5;
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
  padding: 0 8px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}
.act:disabled {
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
.dest {
  margin-top: 14px;
}
.dest-head {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 14px;
}
.thumbs {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  overflow-x: auto;
  padding-bottom: 4px;
  scroll-snap-type: x proximity;
}
.thumb {
  position: relative;
  flex: 0 0 auto;
  width: 84px;
  aspect-ratio: 9 / 16;
  border-radius: 12px;
  overflow: hidden;
  padding: 0;
  border: 2px solid transparent;
  background: var(--panel);
  scroll-snap-align: start;
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
