<script setup lang="ts">
import { characterPronoun } from '@app/shared';
import { expressionField, lrcIndexAt, type MessagePart } from '@app/shared';
import { showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import FlyingDanmaku from '@/components/scene/FlyingDanmaku.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import Avatar from '@/components/common/Avatar.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { danmaku as demoDanmaku, songs as demoSongs } from '@/mock/music';
import { services, type SongInfo, type SongList } from '@/services';
import { ambience, NOISE_KINDS, NOISE_LABEL, type NoiseKind, type NoiseMix } from '@/services/ambience';
import { extractId } from '@/services/music';
import { isLiked as likedSong, musicLibrary, removeList as dropList, saveList, toggleLike as flipLike } from '@/services/musicLibrary';
import {
  clearQueue,
  current,
  cycleMode,
  enqueue,
  next,
  onPlayerEvent,
  player,
  playList,
  playSong,
  prev,
  prime,
  removeAt,
  seek,
  setVolume,
  toggle,
  volumeLocked,
} from '@/services/musicPlayer';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useServicesStore } from '@/stores/services';
import { clock, listTime } from '@/utils/time';

/**
 * 一起听歌：网易云音乐（同 SleepTogether：你自己部署的 Netease_url Worker，"我的 → 地图、天气、音乐"里填地址）。
 * - 搜歌、贴歌单 / 专辑链接导入、播放列表、单曲循环 / 随机；地址播放前现取，出错重取（services/musicPlayer.ts）；
 * - 歌词逐行滚动（带译文），点一行跳过去；
 * - 她按歌词发"弹幕"：每首歌开始时「陪伴 · 快速」按"一起听歌"预设的"批量写弹幕"一次写好几句，唱到那一行时从右往左飘过唱片（FlyingDanmaku），也记进聊天；
 * - 边听边跟她说一句，她回一句（可能用 [music:歌名-歌手] 推荐下一首，点一下就放），回的话也飘过去；
 * - 右上角一列：音量（音乐的音量记在网易云的设置里，开着白噪音时一起调）、白噪音（本机合成，和歌叠着放，services/ambience.ts）、
 *   这首歌的弹幕（从聊天记录里按歌名找，以前听这首时她说的也在）；
 * - 去聊天、打电话时歌还在放；离开这件事时停。
 * 没填 Worker 地址时是示例歌曲（虚构的歌、原创占位歌词、不出声）。
 */
const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const svc = useServicesStore();
const route = useRoute();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

const real = computed(() => svc.musicReady);
const song = computed(() => current());
const lineIdx = computed(() => lrcIndexAt(player.lines, player.posMs));
const durationMs = computed(() => player.durationMs || song.value?.durationMs || 0);
const progress = computed({
  get: () => Math.min(player.posMs, durationMs.value || player.posMs),
  set: (v: number) => seek(v),
});

/** 示例歌曲的 id（s1–s6）：接上网易云以后，列表里留着的示例歌放不出来，清掉 */
const isDemoSong = (s: SongInfo) => demoSongs.some((d) => d.id === s.id);

onMounted(() => {
  if (real.value && player.queue.some(isDemoSong)) clearQueue();
  // 还没有在放的：演示时把示例歌放进列表；带着 ?q= 进来（聊天里她分享的歌）就搜这首放
  const q = typeof route.query.q === 'string' ? route.query.q.trim() : '';
  if (q) void searchAndPlay(q);
  else if (!player.queue.length && !real.value) void playList(demoSongs, 0);
  else if (!song.value && player.queue.length) player.index = 0;
  else if (!player.queue.length) searchOpen.value = true;
  void nextTick(() => scrollToLine(lineIdx.value, false));
});

// —— 歌词滚动 ——
const lyricsBox = ref<HTMLElement | null>(null);
function scrollToLine(i: number, smooth = true) {
  const box = lyricsBox.value;
  const el = box?.querySelector<HTMLElement>(`[data-line="${i}"]`);
  if (el && box) box.scrollTo({ top: el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2, behavior: smooth ? 'smooth' : 'auto' });
}
watch(lineIdx, async (i) => {
  await nextTick();
  scrollToLine(i);
});
watch(
  () => player.lines,
  async () => {
    await nextTick();
    scrollToLine(lineIdx.value, false);
  },
);

// —— 她的弹幕 ——
interface Reaction {
  at: number;
  line: number;
  text: string;
  expr?: string;
  done: boolean;
}
let reactions: Reaction[] = [];
/** 这首歌的弹幕排好了没有（按歌 id） */
const plannedFor = ref('');
/** 正在写弹幕的请求数（换歌时上一首的可能还没回来） */
const planning = ref(0);
const notConnected = ref('');
const herSaid: string[] = [];
const flyEl = ref<InstanceType<typeof FlyingDanmaku> | null>(null);
const herLine = ref('');

/** 作词作曲这类署名行不交给她 */
const CREDIT = /^(作词|作曲|编曲|制作人|混音|母带|和声|吉他|贝斯|鼓|弦乐|录音|监制|出品|演唱|原唱|翻唱|词|曲|OP|SP|Lyricist|Composer|Arranger|Producer)\s*[:：]/i;

function lyricLines(): { i: number; t: number; text: string; tr?: string }[] {
  return player.lines
    .map((l, i) => ({ i, t: l.timeMs, text: l.text.trim(), tr: l.translation }))
    .filter((l) => l.text && !CREDIT.test(l.text))
    .slice(0, 90);
}

function parseBatch(valid: Set<number>) {
  return (v: unknown): { line: number; text: string; expr?: string }[] | null => {
    if (!v || typeof v !== 'object') return null;
    const list = (v as { reactions?: unknown }).reactions;
    if (!Array.isArray(list)) return null;
    return list
      .map((x) => x as { line?: unknown; text?: unknown; expr?: unknown })
      .filter((x) => valid.has(Number(x.line)) && typeof x.text === 'string' && x.text.trim())
      .map((x) => ({ line: Number(x.line), text: String(x.text).trim().slice(0, 40), ...expressionField(x.expr, her.value.portraits) }));
  };
}

/** 一首歌开始、歌词到了：让她一次写好这首歌的弹幕（「陪伴 · 快速」+"一起听歌"预设的"批量写弹幕"） */
async function planReactions() {
  const s = song.value;
  if (!s || player.lyricState !== 'ok' || plannedFor.value === s.id || !chatId.value) return;
  plannedFor.value = s.id;
  reactions = [];
  const lines = lyricLines();
  if (!lines.length) return;
  // 演示歌曲、「陪伴 · 快速」没接通：用写好的示例弹幕（上一首还在写也不等：写好了发现换歌了就丢掉）
  if (notConnected.value) {
    if (player.demo) reactions = Object.entries(demoDanmaku).map(([i, text]) => ({ at: (player.lines[Number(i)]?.timeMs ?? 0) + 300, line: Number(i), text, done: false }));
    return;
  }
  planning.value += 1;
  const r = await chat.sceneJson(
    chatId.value,
    {
      name: 'music-batch',
      input: [
        `歌：《${s.title}》- ${s.artist}${s.album ? `（专辑《${s.album}》）` : ''}${player.demo ? '（示例歌曲，虚构的）' : ''}`,
        durationMs.value ? `时长：${clock(durationMs.value / 1000)}` : '',
        '话量：适中（这首歌说 2–4 句，不想说也可以一句都不说）',
        herSaid.length ? `你刚才说过：${herSaid.slice(-4).join(' / ')}` : '',
        '歌词（编号 时间 歌词 / 译文）：',
        ...lines.map((l) => `#${l.i} ${clock(l.t / 1000)} ${l.text}${l.tr ? ` / ${l.tr}` : ''}`),
      ]
        .filter(Boolean)
        .join('\n'),
    },
    parseBatch(new Set(lines.map((l) => l.i))),
  );
  planning.value -= 1;
  if (song.value?.id !== s.id) return;
  if (!r.ok) {
    if (r.notConnected) {
      notConnected.value = r.reason;
      if (player.demo) reactions = Object.entries(demoDanmaku).map(([i, text]) => ({ at: (player.lines[Number(i)]?.timeMs ?? 0) + 300, line: Number(i), text, done: false }));
    } else showToast(`${her.value.name}这首没写出弹幕：${r.reason}`);
    return;
  }
  reactions = r.value.map((x) => ({ at: (player.lines[x.line]?.timeMs ?? 0) + 300, line: x.line, text: x.text, expr: x.expr, done: player.posMs > (player.lines[x.line]?.timeMs ?? 0) + 300 }));
}
watch(() => [song.value?.id, player.lyricState], () => void planReactions(), { immediate: true });

/** 她说了一句：弹幕从右往左飘过唱片；回你的话（line）也留在上面那行 */
function say(text: string, expr?: string, line = false) {
  if (line) herLine.value = text;
  herSaid.push(text);
  flyEl.value?.push('her', text);
  if (expr) chars.setExpression(her.value.id, expr);
}

/** 唱到那一行：她说出来，也记进你们的聊天（带上是哪首歌的哪一句） */
watch(
  () => player.posMs,
  (t) => {
    for (const r of reactions) {
      if (r.done || t < r.at) continue;
      r.done = true;
      // 拖过头了的不补
      if (t - r.at > 8000) continue;
      const s = song.value;
      const lyric = player.lines[r.line]?.text ?? '';
      if (chatId.value && s) {
        chat.push(chatId.value, 'assistant', [{ type: 'text', text: r.text }], {
          meta: { scene: 'music', cue: `《${s.title}》「${lyric.slice(0, 20)}」`, agent: 'companion' },
          expression: r.expr ?? null,
        });
      }
      say(r.text, r.expr);
    }
  },
);

// 换歌、拖进度：没出现的弹幕按新位置算
const offPlayer = onPlayerEvent((e) => {
  if (e.kind === 'track') {
    reactions = [];
    if (e.song.id !== plannedFor.value) plannedFor.value = '';
  } else if (e.kind === 'seek') {
    for (const r of reactions) r.done = player.posMs > r.at + 1000;
  }
});
onBeforeUnmount(offPlayer);

// —— 跟她说一句 ——
const talk = ref('');
const talking = ref(false);
const talkError = ref('');
const suggestion = ref<{ title: string; artist: string } | null>(null);
async function sendTalk() {
  const text = talk.value.trim();
  const s = song.value;
  if (!text || talking.value || !chatId.value) return;
  talk.value = '';
  talking.value = true;
  talkError.value = '';
  herLine.value = '';
  const lyric = player.lines[lineIdx.value]?.text ?? '';
  const r = await chat.sceneReply(chatId.value, {
    task: 'music-chat',
    input: [
      s ? `正在放：《${s.title}》- ${s.artist}${player.demo ? '（示例歌曲）' : ''}` : '还没在放歌',
      s ? `放到 ${clock(player.posMs / 1000)}${lyric ? `，唱到"${lyric}"` : ''}` : '',
      herSaid.length ? `你刚才说过：${herSaid.slice(-4).join(' / ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    userText: text,
    cue: s ? `《${s.title}》${clock(player.posMs / 1000)}` : undefined,
    allowedTags: ['expr', 'music'],
    onText: (text) => { herLine.value = text; },
  });
  talking.value = false;
  if (!r.ok) {
    talkError.value = r.notConnected ? `${r.reason}（${characterPronoun(her.value)}要接通「陪伴 · 快速」才能回你）` : `${her.value.name}没回上：${r.reason}`;
    return;
  }
  say(r.message.text || '……', r.message.expression ?? undefined, true);
  const rec = r.message.parts.find((p): p is Extract<MessagePart, { type: 'music' }> => p.type === 'music');
  suggestion.value = rec ? { title: rec.title, artist: rec.artist } : null;
}

// —— 搜歌、导入歌单 ——
const searchOpen = ref(false);
const searchTab = ref<'search' | 'import'>('search');
const keyword = ref('');
const results = ref<SongInfo[]>([]);
const searching = ref(false);
const searchError = ref('');
async function search() {
  const k = keyword.value.trim();
  if (!k && real.value) return;
  searching.value = true;
  searchError.value = '';
  try {
    results.value = await services.music.search(k, 40);
    if (!results.value.length) searchError.value = '没搜到，换个关键词试试';
  } catch (e) {
    results.value = [];
    searchError.value = e instanceof Error ? e.message : String(e);
  } finally {
    searching.value = false;
  }
}
function openSearch() {
  searchOpen.value = true;
  if (!real.value && !results.value.length) void search();
}
/** 点搜到的一首：同 SleepTogether，这一页搜到的歌成为播放列表，从这首开始放（下一首就是搜到的下一首） */
function pick(s: SongInfo) {
  prime();
  const i = results.value.findIndex((x) => x.id === s.id);
  void (i >= 0 ? playList(results.value, i) : playSong(s));
  searchOpen.value = false;
}
function addOne(s: SongInfo) {
  const n = enqueue([s]);
  showToast(n ? `加进播放列表了：${s.title}` : '已经在播放列表里了');
}

/** 搜这首歌放第一首（聊天里她分享的歌、她在这里推荐的歌） */
async function searchAndPlay(q: string) {
  keyword.value = q;
  searching.value = true;
  searchError.value = '';
  try {
    const list = await services.music.search(q, 10);
    results.value = list;
    const first = list[0];
    if (first) await playSong(first);
    else {
      searchError.value = `没搜到"${q}"`;
      searchOpen.value = true;
    }
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : String(e);
    searchOpen.value = true;
  } finally {
    searching.value = false;
  }
}
function playSuggestion() {
  const s = suggestion.value;
  if (!s) return;
  prime();
  suggestion.value = null;
  void searchAndPlay(`${s.title} ${s.artist}`.trim());
}

const importType = ref<'playlist' | 'album'>('playlist');
const importText = ref('');
const imported = ref<(SongList & { key: string; type: 'playlist' | 'album' }) | null>(null);
const importing = ref(false);
const importError = ref('');
async function doImport() {
  const v = importText.value.trim();
  if (!v) return;
  if (/163cn\.tv|y\.music\.163\.com\/m\/s/i.test(v) && extractId(v) === v) {
    importError.value = '这是网易云的短链接，网页里展不开：在网易云 App 里"复制链接"后贴带 id= 的那种，或者直接贴歌单 id';
    return;
  }
  importing.value = true;
  importError.value = '';
  try {
    const list = importType.value === 'playlist' ? await services.music.playlist(v) : await services.music.album(v);
    imported.value = { ...list, key: `${importType.value}:${extractId(v)}`, type: importType.value };
    if (!list.songs.length) importError.value = '解析到了，但里面没有歌';
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e);
  } finally {
    importing.value = false;
  }
}

// —— 我们的歌单：喜欢的歌、导入过的歌单（和哄睡的音乐共用一份，services/musicLibrary.ts） ——
const liked = computed(() => musicLibrary.liked);
const lists = computed(() => musicLibrary.lists);
const isLiked = computed(() => !!song.value && likedSong(song.value.id));
const STORAGE_FULL = '存不下了（浏览器存储满了或者被禁用了）';
function toggleLike() {
  const s = song.value;
  if (s && !flipLike(s)) showToast(STORAGE_FULL);
}
function saveImported() {
  const l = imported.value;
  if (!l) return;
  showToast(saveList(l) ? `存进我们的歌单了：${l.name}` : STORAGE_FULL);
}
function removeList(key: string) {
  if (!dropList(key)) showToast(STORAGE_FULL);
}
function playAll(songs: SongInfo[], start = 0) {
  if (!songs.length) return;
  prime();
  void playList(songs, start);
  searchOpen.value = false;
  listOpen.value = false;
}

const listOpen = ref(false);
const listTab = ref<'queue' | 'ours'>('queue');

// —— 播放控制（在点击里先解锁 <audio>，iPhone 才能在取到地址后出声） ——
function onToggle() {
  prime();
  void toggle();
}
function onNext() {
  prime();
  void next();
}
function onPrev() {
  prime();
  void prev();
}
function jumpTo(i: number) {
  const l = player.lines[i];
  if (l) seek(l.timeMs);
}
const MODE = {
  list: { icon: 'i-lucide-repeat', label: '列表循环' },
  single: { icon: 'i-lucide-repeat-1', label: '单曲循环' },
  shuffle: { icon: 'i-lucide-shuffle', label: '随机播放' },
} as const;

// —— 右上角一列：音量、白噪音、这首歌的弹幕（同出逃、戳戳乐：竖着排在顶栏下面，面板在左边展开，同一时间只开一个） ——
type Pop = 'volume' | 'noise' | 'danmaku';
const pop = ref<Pop | null>(null);
function togglePop(p: Pop) {
  pop.value = pop.value === p ? null : p;
}

/**
 * 这首歌她发过的弹幕（唱到某一句时的、回你的话），新的在上面。弹幕和回话都记在聊天里，位置写成"《歌名》「那句歌词」"或"《歌名》02:13"，
 * 按歌名从聊天记录里找：以前听这首时说的也在，聊天里删掉的这里也没了
 */
const songDanmaku = computed(() => {
  const s = song.value;
  if (!s || !chatId.value) return [];
  const head = `《${s.title}》`;
  return chat
    .list(chatId.value)
    .filter((m) => m.role === 'assistant' && m.meta.scene === 'music' && m.meta.cue?.startsWith(head) && !m.meta.error && m.text.trim())
    .map((m) => ({ id: m.id, text: m.text, at: m.meta.cue!.slice(head.length), when: m.createdAt }))
    .reverse();
});

/** 音乐的音量 0–100：记在网易云的设置里（跟着同步），进来就按它放 */
const musicVolume = computed({
  get: () => Math.round(svc.netease.volume * 100),
  set: (v: number) => (svc.netease.volume = v / 100),
});
watch(() => svc.netease.volume, (v) => setVolume(v), { immediate: true });
const volumeIcon = computed(() => {
  const v = svc.netease.volume;
  return v === 0 ? 'i-lucide-volume-x' : v < 0.5 ? 'i-lucide-volume-1' : 'i-lucide-volume-2';
});

/** 白噪音：选哪种、多响记在本机；开没开不记（浏览器要点一下才让出声）。第一次用是雨声，比歌小声 */
const NOISE_SAVE = 'ai-mobile:music:noise';
const NOISE_DEFAULT: { kind: NoiseKind; volume: number } = { kind: 'rain', volume: 40 };
function readNoise(): { kind: NoiseKind; volume: number } {
  try {
    const v = JSON.parse(localStorage.getItem(NOISE_SAVE) ?? 'null') as { kind?: string; volume?: number } | null;
    return {
      kind: NOISE_KINDS.find((k) => k === v?.kind) ?? NOISE_DEFAULT.kind,
      volume: typeof v?.volume === 'number' ? Math.max(0, Math.min(100, v.volume)) : NOISE_DEFAULT.volume,
    };
  } catch {
    return { ...NOISE_DEFAULT };
  }
}
const savedNoise = readNoise();
const noise = ref<NoiseKind>(savedNoise.kind);
const noiseVolume = ref(savedNoise.volume);
watch([noise, noiseVolume], ([kind, volume]) => {
  try {
    localStorage.setItem(NOISE_SAVE, JSON.stringify({ kind, volume }));
  } catch {
    // 存不了：下次用默认的
  }
});
const noisePlaying = computed(() => ambience.state.playing && !ambience.state.fading);
const mixOf = (kind: NoiseKind, v: number) => Object.fromEntries(NOISE_KINDS.map((k) => [k, k === kind ? v : 0])) as NoiseMix;
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
  if (noisePlaying.value) ambience.setMix(mixOf(noise.value, v));
});
// 离开这一页歌就停了（chat.leaveScene），白噪音也停
onBeforeUnmount(() => ambience.stop());

const line = computed(() => {
  if (talking.value) return herLine.value;
  // 她的弹幕正飘着：上面那行先收起来，不重复
  if (flyEl.value?.count) return '';
  if (herLine.value) return herLine.value;
  if (!song.value) return real.value ? '想听什么？搜一首，我们一起听。' : '这首歌，我们一起听吧。';
  return `在听《${song.value.title}》……`;
});
const subtitle = computed(() => {
  const s = song.value;
  if (!s) return '';
  return [s.artist, s.album, player.demo ? '示例歌曲' : '网易云', player.level ? player.level : ''].filter(Boolean).join(' · ');
});
</script>

<template>
  <SceneShell class="music-shell" scene-id="music" hide-figure :line="line" :typing="talking">
    <template #actions>
      <button class="pill-btn" aria-label="搜歌" @click="openSearch"><span class="i-lucide-search" /></button>
      <button class="pill-btn" aria-label="播放列表和我们的歌单" @click="listOpen = true"><span class="i-lucide-list-music" /></button>
    </template>

    <template #overlay>
      <div class="vinyl-wrap">
        <div class="vinyl" :class="{ spin: player.playing }" :style="{ '--hue': song?.hue ?? 210 }">
          <img v-if="song?.cover" :src="`${song.cover}?param=300y300`" class="label-img" alt="" referrerpolicy="no-referrer" />
          <span v-else class="label" />
        </div>
      </div>
      <!-- 她的弹幕：从右往左飘过唱片 -->
      <div class="dm-zone">
        <FlyingDanmaku ref="flyEl" :character="her" :top="0" :fill="1" />
      </div>

      <!-- 右上角一列：音量、白噪音、这首歌的弹幕，竖着排在顶栏下面；面板在这一列左边展开，点空白处收起 -->
      <div class="side-tools">
        <button type="button" class="pill-btn" :aria-expanded="pop === 'volume'" aria-label="音量" data-testid="music-volume-btn" @click="togglePop('volume')">
          <span :class="volumeIcon" />
        </button>
        <button
          type="button"
          class="pill-btn"
          :class="{ on: noisePlaying }"
          :aria-expanded="pop === 'noise'"
          :aria-label="`白噪音：${noisePlaying ? NOISE_LABEL[noise].label : '关'}`"
          data-testid="music-noise-btn"
          @click="togglePop('noise')"
        >
          <span :class="ambience.state.loading ? 'i-lucide-loader-circle spin-icon' : noisePlaying ? NOISE_LABEL[noise].icon : 'i-lucide-audio-lines'" />
        </button>
        <button
          type="button"
          class="pill-btn relative"
          :aria-expanded="pop === 'danmaku'"
          :aria-label="`这首歌的弹幕：${songDanmaku.length} 条`"
          data-testid="music-danmaku-btn"
          @click="togglePop('danmaku')"
        >
          <span class="i-lucide-message-square-text" />
          <span v-if="songDanmaku.length" class="badge num">{{ songDanmaku.length > 99 ? '99+' : songDanmaku.length }}</span>
        </button>
      </div>
      <div v-if="pop" class="pop-catcher" @click="pop = null" />
      <div v-if="pop === 'volume'" class="side-pop" role="dialog" aria-label="音量" data-testid="music-volume">
        <div class="mix-row">
          <span class="i-lucide-music-2 text-ink-3" />
          <span class="mix-label">音乐</span>
          <van-slider v-if="!volumeLocked" v-model="musicVolume" class="flex-1" bar-height="4px" button-size="16px" aria-label="音乐音量" />
          <span v-else class="flex-1 text-[12px] text-ink-3">用手机侧面的音量键调</span>
        </div>
        <div v-if="noisePlaying" class="mix-row">
          <span :class="NOISE_LABEL[noise].icon" class="text-ink-3" />
          <span class="mix-label">{{ NOISE_LABEL[noise].label }}</span>
          <van-slider v-model="noiseVolume" class="flex-1" bar-height="4px" button-size="16px" aria-label="白噪音音量" />
        </div>
      </div>
      <div v-if="pop === 'noise'" class="side-pop" role="dialog" aria-label="白噪音" data-testid="music-noise">
        <div class="flex gap-2 flex-wrap">
          <button type="button" class="chip" :class="{ on: !noisePlaying }" :aria-pressed="!noisePlaying" @click="pickNoise(null)"><span class="i-lucide-volume-x" />关</button>
          <button v-for="k in NOISE_KINDS" :key="k" type="button" class="chip" :class="{ on: noisePlaying && noise === k }" :aria-pressed="noisePlaying && noise === k" :data-noise="k" @click="pickNoise(k)">
            <span :class="NOISE_LABEL[k].icon" />{{ NOISE_LABEL[k].label }}
          </button>
        </div>
        <div class="mix-row mt-2">
          <span class="i-lucide-volume-2 text-ink-3" />
          <van-slider v-model="noiseVolume" class="flex-1" bar-height="4px" button-size="16px" aria-label="白噪音音量" />
        </div>
        <p v-if="ambience.state.error" class="text-[12px] text-bad mt-2 mb-0">{{ ambience.state.error }}</p>
        <p class="text-[11.5px] text-ink-3 mt-2 mb-0">和歌叠着放；在这台设备上合成，不联网、不用流量</p>
      </div>
      <div v-if="pop === 'danmaku'" class="side-pop" role="dialog" aria-label="这首歌的弹幕" data-testid="music-danmaku">
        <div class="flex items-center gap-2 mb-1">
          <Avatar :character="her" :size="22" />
          <span class="flex-1 min-w-0 truncate text-[13.5px] font-600">{{ song ? `《${song.title}》的弹幕` : '弹幕' }}</span>
          <span class="text-[12px] text-ink-3 shrink-0">{{ songDanmaku.length }} 条</span>
        </div>
        <p v-if="!songDanmaku.length" class="text-[12.5px] text-ink-3 py-3 m-0">{{ song ? `${her.name}还没给这首歌发过弹幕` : '还没在放歌' }}</p>
        <div v-for="d in songDanmaku" :key="d.id" class="dm-row">
          <div class="flex items-center gap-2 text-[11.5px] text-ink-3">
            <span class="flex-1 min-w-0 truncate">{{ d.at }}</span>
            <span class="num shrink-0">{{ listTime(d.when) }}</span>
          </div>
          <div class="text-[14px] leading-snug break-words">{{ d.text }}</div>
        </div>
      </div>
    </template>

    <div class="text-center min-w-0">
      <div class="text-[19px] font-700 truncate">{{ song?.title ?? '还没在放歌' }}</div>
      <div class="text-[13px] text-ink-3 truncate">{{ subtitle || (real ? '点右上角的放大镜搜一首' : '示例歌曲') }}</div>
    </div>

    <div v-if="!real" class="notice">
      <span class="i-lucide-plug text-[15px] shrink-0" />
      <span class="flex-1 min-w-0">没接网易云：现在是示例歌曲，不出声</span>
      <RouterLink to="/me/services" class="notice-link">去接入</RouterLink>
    </div>
    <ErrorDetails v-else-if="player.error" class="mt-1.5" :detail="player.error" :title="player.error" max-height="120px" />
    <button v-if="player.needsTap" class="notice tap" @click="onToggle"><span class="i-lucide-play" />浏览器要你点一下才能出声 · 点这里播放</button>

    <div ref="lyricsBox" class="lyrics hide-scrollbar" data-testid="lyrics">
      <div v-if="player.loading && !player.lines.length" class="lyric">正在取歌曲地址…</div>
      <div v-else-if="player.lyricState === 'loading'" class="lyric">歌词加载中…</div>
      <div v-else-if="player.lyricState === 'none' || player.lyricState === 'error'" class="lyric">{{ player.lyricState === 'none' ? '这首没有歌词（纯音乐？）' : '歌词没取到' }}</div>
      <button v-for="(l, i) in player.lines" :key="i" type="button" class="lyric" :class="{ on: i === lineIdx }" :data-line="i" @click="jumpTo(i)">
        <div>{{ l.text || '♪' }}</div>
        <div v-if="l.translation" class="tr">{{ l.translation }}</div>
      </button>
    </div>

    <div class="flex items-center gap-2 text-[11.5px] text-ink-3 num">
      <span>{{ clock(player.posMs / 1000) }}</span>
      <van-slider v-model="progress" :max="Math.max(1, durationMs)" class="flex-1" bar-height="3px" button-size="12px" :disabled="!song" />
      <span>{{ clock(durationMs / 1000) }}</span>
    </div>
    <div class="controls">
      <button class="ctl" :aria-label="isLiked ? '取消喜欢' : '喜欢'" :disabled="!song" @click="toggleLike"><span :class="isLiked ? 'i-lucide-heart text-accent' : 'i-lucide-heart'" /></button>
      <button class="ctl" aria-label="上一首" :disabled="!player.queue.length" @click="onPrev"><span class="i-lucide-skip-back" /></button>
      <button class="ctl main" :aria-label="player.playing ? '暂停' : '播放'" :disabled="!player.queue.length" @click="onToggle">
        <span v-if="player.loading" class="i-lucide-loader-circle spin-icon" />
        <span v-else :class="player.playing ? 'i-lucide-pause' : 'i-lucide-play'" />
      </button>
      <button class="ctl" aria-label="下一首" :disabled="!player.queue.length" @click="onNext"><span class="i-lucide-skip-forward" /></button>
      <button class="ctl" :aria-label="MODE[player.mode].label" :title="MODE[player.mode].label" @click="cycleMode"><span :class="MODE[player.mode].icon" /></button>
    </div>

    <button v-if="suggestion" class="suggest" @click="playSuggestion">
      <span class="i-lucide-music-2 text-accent-ink" /><span class="flex-1 min-w-0 truncate text-left">{{ her.name }}推荐：《{{ suggestion.title }}》{{ suggestion.artist }}</span><span class="text-accent-ink">听这首</span>
    </button>
    <form class="talk" @submit.prevent="sendTalk">
      <input v-model="talk" class="field" :placeholder="`边听边跟${her.name}说…`" :aria-label="`跟${her.name}说`" enterkeyhint="send" />
      <button type="submit" class="send" :disabled="!talk.trim() || talking" :aria-label="talking ? `${her.name}正在回复` : '发送'"><span :class="talking ? 'i-lucide-loader-circle spin-icon' : 'i-lucide-send-horizontal'" /></button>
    </form>
    <ErrorDetails v-if="talkError" :detail="talkError" title="回复失败" max-height="120px" />
    <p v-if="notConnected && !player.demo" class="hint">{{ her.name }}不会发弹幕：{{ notConnected }}</p>
    <p v-else-if="planning" class="hint">{{ her.name }}在听这首歌的歌词……</p>

    <!-- 搜歌 / 导入歌单 -->
    <van-popup v-model:show="searchOpen" position="bottom" round :style="{ height: '78%' }">
      <div class="sheet-body">
        <div class="flex items-center gap-2 mb-2">
          <div class="seg">
            <button :class="{ on: searchTab === 'search' }" @click="searchTab = 'search'">搜歌</button>
            <button :class="{ on: searchTab === 'import' }" @click="searchTab = 'import'">导入歌单 / 专辑</button>
          </div>
          <span class="flex-1" />
          <RouterLink to="/me/services" class="gear" aria-label="网易云设置"><span class="i-lucide-settings-2" /></RouterLink>
        </div>
        <template v-if="searchTab === 'search'">
          <form class="flex gap-2" @submit.prevent="search">
            <input v-model="keyword" class="field" :placeholder="real ? '搜歌名或歌手（网易云）' : '搜示例歌曲'" aria-label="搜歌" enterkeyhint="search" />
            <van-button type="primary" round size="small" native-type="submit" :loading="searching">搜索</van-button>
          </form>
          <p class="text-[12px] text-ink-3 my-2">
            {{ real ? '歌曲地址播放前现取（约 20 分钟过期）；在国外有的歌因为版权拿不到地址，会自动跳过' : '没接网易云：搜到的是示例歌曲。在"我的 → 地图、天气、音乐"里填 Worker 地址（和 SleepTogether 用同一个）' }}
          </p>
          <ErrorDetails v-if="searchError" :detail="searchError" :title="searchError" max-height="120px" />
          <div class="results">
            <div v-for="s in results" :key="s.id" class="song-row" :data-song="s.id">
              <button class="flex items-center gap-3 flex-1 min-w-0 text-left" @click="pick(s)">
                <img v-if="s.cover" :src="`${s.cover}?param=100y100`" class="cover" alt="" referrerpolicy="no-referrer" loading="lazy" />
                <span v-else class="cover" :style="{ '--hue': s.hue }" />
                <span class="flex-1 min-w-0">
                  <span class="block truncate text-[14.5px]" :class="{ 'text-accent-ink font-600': s.id === song?.id }">{{ s.title }}</span>
                  <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}{{ s.album ? ` · ${s.album}` : '' }}</span>
                </span>
              </button>
              <span class="num text-[12px] text-ink-3 shrink-0">{{ s.durationMs ? clock(s.durationMs / 1000) : '' }}</span>
              <button class="mini" aria-label="加进播放列表" @click="addOne(s)"><span class="i-lucide-list-plus" /></button>
            </div>
          </div>
        </template>
        <template v-else>
          <div class="flex gap-2">
            <select v-model="importType" class="field !flex-none !w-[84px]" aria-label="类型">
              <option value="playlist">歌单</option>
              <option value="album">专辑</option>
            </select>
            <input v-model="importText" class="field" placeholder="id 或链接，例如 music.163.com/playlist?id=…" aria-label="歌单或专辑的 id 或链接" @keydown.enter="doImport" />
          </div>
          <van-button class="!mt-2" type="primary" round block size="small" :loading="importing" :disabled="!real" @click="doImport">解析</van-button>
          <p v-if="!real" class="text-[12px] text-ink-3 mt-2">要先接网易云（填 Worker 地址）才能导入。</p>
          <ErrorDetails v-if="importError" class="mt-2" :detail="importError" :title="importError" max-height="120px" />
          <template v-if="imported && imported.songs.length">
            <div class="flex items-center gap-2 mt-3">
              <span class="flex-1 min-w-0 truncate font-600">{{ imported.name }}（{{ imported.songs.length }} 首）</span>
              <van-button size="mini" round @click="saveImported">存进我们的歌单</van-button>
              <van-button size="mini" round type="primary" @click="playAll(imported.songs)">全部播放</van-button>
            </div>
            <div class="results">
              <div v-for="(s, i) in imported.songs" :key="s.id" class="song-row">
                <button class="flex items-center gap-3 flex-1 min-w-0 text-left" @click="playAll(imported.songs, i)">
                  <img v-if="s.cover" :src="`${s.cover}?param=100y100`" class="cover" alt="" referrerpolicy="no-referrer" loading="lazy" />
                  <span v-else class="cover" :style="{ '--hue': s.hue }" />
                  <span class="flex-1 min-w-0">
                    <span class="block truncate text-[14.5px]">{{ s.title }}</span>
                    <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}</span>
                  </span>
                </button>
                <button class="mini" aria-label="加进播放列表" @click="addOne(s)"><span class="i-lucide-list-plus" /></button>
              </div>
            </div>
          </template>
        </template>
      </div>
    </van-popup>

    <!-- 播放列表 / 我们的歌单 -->
    <van-popup v-model:show="listOpen" position="bottom" round :style="{ height: '70%' }">
      <div class="sheet-body">
        <div class="flex items-center gap-2 mb-2">
          <div class="seg">
            <button :class="{ on: listTab === 'queue' }" @click="listTab = 'queue'">播放列表 {{ player.queue.length || '' }}</button>
            <button :class="{ on: listTab === 'ours' }" @click="listTab = 'ours'">我们的歌单</button>
          </div>
          <span class="flex-1" />
          <button v-if="listTab === 'queue' && player.queue.length" class="text-[12.5px] text-ink-3" @click="clearQueue">清空</button>
        </div>
        <div v-if="listTab === 'queue'" class="results">
          <p v-if="!player.queue.length" class="text-[13px] text-ink-3 py-6 text-center">播放列表是空的，去搜一首</p>
          <div v-for="(s, i) in player.queue" :key="`${s.id}-${i}`" class="song-row">
            <button class="flex items-center gap-3 flex-1 min-w-0 text-left" @click="(prime(), playSong(s))">
              <span class="num text-[12px] w-5 text-center shrink-0" :class="i === player.index ? 'text-accent-ink' : 'text-ink-3'">
                <span v-if="i === player.index" class="i-lucide-audio-lines" /><template v-else>{{ i + 1 }}</template>
              </span>
              <span class="flex-1 min-w-0">
                <span class="block truncate text-[14.5px]" :class="{ 'text-accent-ink font-600': i === player.index }">{{ s.title }}</span>
                <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}</span>
              </span>
            </button>
            <button class="mini" aria-label="从播放列表移除" @click="removeAt(i)"><span class="i-lucide-x" /></button>
          </div>
        </div>
        <div v-else class="results">
          <template v-if="!real">
            <div class="text-[12px] text-ink-3 mb-1">示例歌曲（虚构的）</div>
            <div v-for="(s, i) in demoSongs" :key="s.id" class="song-row">
              <button class="flex items-center gap-3 flex-1 min-w-0 text-left" @click="playAll(demoSongs, i)">
                <span class="cover" :style="{ '--hue': s.hue }" />
                <span class="flex-1 min-w-0">
                  <span class="block truncate text-[14.5px]">{{ s.title }}</span>
                  <span class="block truncate text-[12px] text-ink-3">{{ s.artist }}</span>
                </span>
              </button>
            </div>
          </template>
          <template v-else>
            <button class="list-row" :disabled="!liked.length" @click="playAll(liked)">
              <span class="cover heart"><span class="i-lucide-heart" /></span>
              <span class="flex-1 min-w-0 text-left">
                <span class="block text-[14.5px]">一起喜欢的歌</span>
                <span class="block text-[12px] text-ink-3">{{ liked.length }} 首 · 听歌时点 ♡ 加进来</span>
              </span>
              <span class="i-lucide-play text-ink-3" />
            </button>
            <div v-for="l in lists" :key="l.key" class="list-row">
              <button class="flex items-center gap-3 flex-1 min-w-0 text-left" @click="playAll(l.songs)">
                <img v-if="l.cover" :src="`${l.cover}?param=100y100`" class="cover" alt="" referrerpolicy="no-referrer" loading="lazy" />
                <span v-else class="cover" :style="{ '--hue': 200 }" />
                <span class="flex-1 min-w-0">
                  <span class="block truncate text-[14.5px]">{{ l.name }}</span>
                  <span class="block text-[12px] text-ink-3">{{ l.type === 'album' ? '专辑' : '歌单' }} · {{ l.songs.length }} 首</span>
                </span>
              </button>
              <button class="mini" aria-label="删掉这个歌单" @click="removeList(l.key)"><span class="i-lucide-x" /></button>
            </div>
            <p v-if="!lists.length" class="text-[12px] text-ink-3 mt-2">在"搜歌 → 导入歌单 / 专辑"里贴网易云的链接，存进来以后在这里一点就放。</p>
          </template>
        </div>
      </div>
    </van-popup>
  </SceneShell>
</template>

<style scoped>
.pill-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 17px;
}
.pill-btn.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
/* 她的那句话给右上角一列让出位置（按钮宽 38，两边各留 10） */
.music-shell {
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
/* 盖住她的那句话和底下的面板，不盖顶栏和这一列 */
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
  padding: 12px;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}
.badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 10.5px;
  line-height: 17px;
  text-align: center;
}
.dm-row {
  padding: 8px 2px;
  border-top: 1px solid var(--glass-line);
}
.mix-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 0 4px;
}
.mix-label {
  flex-shrink: 0;
  width: 2.4em;
  font-size: 13px;
  color: var(--ink-2);
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
.vinyl-wrap {
  position: absolute;
  z-index: 7;
  top: calc(var(--safe-top) + 92px);
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
}
.vinyl {
  position: relative;
  width: min(46vw, 190px);
  aspect-ratio: 1;
  border-radius: 50%;
  background:
    radial-gradient(circle, #111 0 6%, transparent 6.5%),
    radial-gradient(circle, hsl(var(--hue) 60% 62%) 0 30%, transparent 30.5%),
    repeating-radial-gradient(circle, #1d1822 0 2px, #0f0c13 2px 4px);
  box-shadow:
    0 0 0 6px rgba(255, 255, 255, 0.04),
    0 20px 50px rgba(0, 0, 0, 0.5);
}
.label-img {
  position: absolute;
  inset: 20%;
  width: 60%;
  height: 60%;
  border-radius: 50%;
  object-fit: cover;
  box-shadow: 0 0 0 3px #0f0c13;
}
.vinyl.spin {
  animation: spin 14s linear infinite;
}
/* 弹幕飘过的那一条：右上角那一列下面（一列从 56 开始，三个 38 的按钮、两个 8 的间隔），唱片中下部，三道（FlyingDanmaku 一道 34px） */
.dm-zone {
  position: absolute;
  z-index: 7;
  top: calc(var(--safe-top) + 194px);
  left: 0;
  right: 0;
  height: 102px;
  pointer-events: none;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 7px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink-2);
}
.notice.tap {
  width: 100%;
  justify-content: center;
  color: var(--accent-ink);
  border: 1px solid var(--accent-line);
}
.notice-link {
  color: var(--accent-ink);
  font-weight: 600;
  white-space: nowrap;
}
.lyrics {
  height: 120px;
  overflow-y: auto;
  margin: 10px 0 8px;
  text-align: center;
  mask-image: linear-gradient(transparent, #000 25%, #000 75%, transparent);
  -webkit-mask-image: linear-gradient(transparent, #000 25%, #000 75%, transparent);
}
.lyric {
  display: block;
  width: 100%;
  padding: 5px 0;
  font-size: 14.5px;
  color: var(--ink-3);
  transition:
    color 0.3s,
    transform 0.3s;
}
.lyric.on {
  color: var(--accent-ink);
  font-weight: 600;
  transform: scale(1.06);
}
.lyric .tr {
  font-size: 11.5px;
  opacity: 0.8;
}
.controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 6px;
  padding: 0 6px;
}
.ctl {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 21px;
  color: var(--ink);
}
.ctl:disabled {
  opacity: 0.4;
}
.ctl.main {
  width: 58px;
  height: 58px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 24px;
}
.spin-icon {
  animation: spin 1s linear infinite;
}
.suggest {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 14px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  font-size: 13px;
}
.talk {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  flex-shrink: 0;
}
.send:disabled {
  opacity: 0.45;
}
.hint {
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--ink-3);
  text-align: center;
}
.sheet-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 16px calc(12px + var(--safe-bottom));
}
.results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin-top: 6px;
}
.seg {
  display: inline-flex;
  padding: 3px;
  border-radius: 99px;
  background: var(--panel);
}
.seg button {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  font-size: 13px;
  color: var(--ink-2);
}
.seg button.on {
  background: var(--surface);
  color: var(--ink);
  font-weight: 600;
  box-shadow: var(--shadow-sm, 0 1px 3px rgba(0, 0, 0, 0.12));
}
.gear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 17px;
}
.song-row,
.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
}
.list-row:disabled {
  opacity: 0.5;
}
.mini {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  color: var(--ink-3);
  font-size: 17px;
  flex-shrink: 0;
}
.cover {
  width: 42px;
  height: 42px;
  border-radius: 10px;
  background: linear-gradient(135deg, hsl(var(--hue) 60% 65%), hsl(calc(var(--hue) + 40) 50% 40%));
  object-fit: cover;
  flex-shrink: 0;
}
.cover.heart {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 20px;
}
.field {
  flex: 1;
  min-width: 0;
  height: 36px;
  padding: 0 14px;
  border-radius: 18px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  outline: none;
}
</style>
