<script setup lang="ts">
import { previewImages } from '@/services/imageViewer';
import { shotViewerImage } from '@/services/redraw';
import type { BackgroundPlace } from '@app/shared';
import { showToast } from 'vant';
import { computed, inject, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Waveform from '@/components/call/Waveform.vue';
import AssetImg from '@/components/common/AssetImg.vue';
import FigureAdjustPanel from '@/components/scene/FigureAdjustPanel.vue';
import { SCENE_LOCATION, SLEEP_FULL_LAYOUT } from '@/components/scene/location';
import SceneShell from '@/components/scene/SceneShell.vue';
import SleepAudioDock from '@/components/scene/sleep/SleepAudioDock.vue';
import SleepImmersion from '@/components/scene/sleep/SleepImmersion.vue';
import { useMicLink } from '@/composables/useMicLink';
import { ttsLiveFor } from '@/services/ai';
import { ambience } from '@/services/ambience';
import { sleepMusic } from '@/services/musicPlayer';
import { personaOf } from '@/services/prompt';
import { sleepAudio } from '@/services/sleepAudio';
import { SentenceStream, SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { useGalleryStore, type GalleryItem } from '@/stores/gallery';
import { useRhythmStore } from '@/stores/rhythm';
import { sleep } from '@/utils/id';
import { clock, hhmm } from '@/utils/time';

/**
 * 哄睡（设计文档 §9.4）：先在卧室里选怎么睡，再进入全屏的画面。三种：
 * - 连麦：全屏是"生图 · 哄睡"画的她（NovelAI，没画好、没接通时是立绘），躺着说话她就听得到、小声回你（composables/useMicLink.ts）；
 * - 故事：全屏背景 + 立绘，她现编睡前故事、边写边读，故事的字半透明地浮在画面上；能点题材，开着麦时说一句"换一个科幻的"就换；
 * - 场景：挑一个睡前的地方（列车、温泉、飞机、林间小屋，随机，或者从背景素材库里选），像约会那样沉浸地陪你睡着
 *   （components/scene/sleep/SleepImmersion.vue，用"哄睡 · 场景"预设）。
 * 三种画面的左下角都是白噪音（可以叠男声 / 女声的呼吸声）和音乐（components/scene/sleep/SleepAudioDock.vue），换画面时声音不断。
 * 立绘在每种画面里怎么摆各记各的（连麦、故事各一条，场景里每个睡前的地方各一条）：右上角"调立绘"对着真正的背景拖，
 * 也能在"立绘设置 → 各场景的位置和大小"里调。
 * 定时到点她说最后一句晚安、挂断连麦、白噪音和音乐慢慢变小、她也睡着；第二天早上她来电叫醒你（主动消息的"叫醒来电"）。
 * 她说的话都由「陪伴 · 快速」按功能预设写，用"语音合成"的 API 读出来，同一时间只有一段；她说话时白噪音和音乐压低一点。
 * 没接通时写明原因，不出演示台词；语音合成没接通时字幕照常、不出声。
 */
type Mode = 'home' | 'mic' | 'story' | 'scene';
const MODES: { id: Exclude<Mode, 'home'>; label: string; icon: string; desc: string }[] = [
  { id: 'mic', label: '连麦', icon: 'i-lucide-headphones', desc: '躺着说，小声回你' },
  { id: 'story', label: '故事', icon: 'i-lucide-book-heart', desc: '现编，说一句换题材' },
  { id: 'scene', label: '场景', icon: 'i-lucide-tent-tree', desc: '挑个地方慢慢睡着' },
];
/** 故事的题材：点一个，或者开着麦说出来（words 是听口令时认的词） */
const GENRES: { label: string; words: RegExp }[] = [
  { label: '童话', words: /童话|公主|王子|精灵/ },
  { label: '治愈日常', words: /治愈|日常|温馨|温暖/ },
  { label: '奇幻', words: /奇幻|魔法|幻想/ },
  { label: '科幻', words: /科幻|太空|宇宙|飞船|机器人|未来/ },
  { label: '古风', words: /古风|古代|武侠|仙侠|江湖/ },
  { label: '旅行', words: /旅行|旅途|远方|公路/ },
  { label: '小动物', words: /动物|小猫|小狗|兔子|狐狸|小熊/ },
  { label: '森林与海', words: /森林|大海|海边|海洋|星空|星星|月亮|下雪/ },
];

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const ai = useAiStore();
const env = useEnvironmentStore();
const gallery = useGalleryStore();
const rhythm = useRhythmStore();
const router = useRouter();
const location = inject(SCENE_LOCATION, ref(null));
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
/** 场景任务里的输入不替换宏：直接写你的名字 */
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

// —— 记住定时、低语开关、故事里开不开麦（只是这台设备的方便） ——
const SAVE_KEY = 'ai-mobile:sleep';
interface Saved {
  timerMin?: number | null;
  whispers?: boolean;
  voiceCmd?: boolean;
}
function loadSaved(): Saved {
  try {
    return JSON.parse(localStorage.getItem(SAVE_KEY) ?? '{}') as Saved;
  } catch {
    return {};
  }
}
const saved = loadSaved();
const mode = ref<Mode>('home');
const lightsOff = ref(false);
/** 定时到了、或者你说了晚安：画面暗下来，她说完最后一句就睡着 */
const night = ref(false);
const asleep = ref(false);
const timerMin = ref<number | null>(saved.timerMin === undefined ? 30 : saved.timerMin);
/** 连麦时你安静久了，她偶尔低语一句 */
const whispers = ref(saved.whispers ?? true);
/** 故事里开着麦听口令 */
const voiceCmd = ref(saved.voiceCmd ?? true);
watch([timerMin, whispers, voiceCmd], () => {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ timerMin: timerMin.value, whispers: whispers.value, voiceCmd: voiceCmd.value }));
  } catch {
    // 无痕模式
  }
});

// —— 接没接通 ——
const companionStatus = computed(() => ai.status('companion'));
const voiceLive = computed(() => ttsLiveFor(her.value));
const voiceError = ref('');

// —— 她说话：同一时间只有一段（连麦里回你、低语、故事、场景里的台词、晚安） ——
const level = ref(0);
const line = ref('');
const writing = ref(false);
let speech: SpeechQueue | null = null;
/** 新开一段她的声音，停掉正在说的那段；她说话时白噪音和音乐压低，说完回来 */
function newSpeech(opts: { speedFactor?: number; onSentence?(text: string, i: number): void } = {}): SpeechQueue {
  speech?.stop();
  const q = new SpeechQueue({
    characterId: her.value.id,
    // 低语：映射成"很轻、像在耳边小声说话"的情绪
    expression: () => 'sleep',
    speedFactor: opts.speedFactor ?? 0.88,
    onLevel: (l) => (level.value = l),
    onSentence: opts.onSentence,
    onError: (msg) => (voiceError.value = msg),
  });
  speech = q;
  ambience.duck(true);
  sleepMusic.duck(true);
  void q.drained().then(() => {
    if (speech !== q) return;
    ambience.duck(false);
    sleepMusic.duck(false);
  });
  return q;
}
function stopSpeech() {
  speech?.stop();
  speech = null;
  ambience.duck(false);
  sleepMusic.duck(false);
}
const speaking = computed(() => level.value > 0.02);

/** 有动静（连上麦、开始讲、放起了声音）：不再算睡着，开始计时 */
function onActivity() {
  asleep.value = false;
  armTimer();
}

/** 聊天里还有一条在写（故事、场景的一段）：停掉，等它收尾 */
async function stopWriting() {
  const id = chatId.value;
  if (!id || !chat.streams[id]) return;
  chat.stop(id);
  for (let i = 0; i < 40 && chat.streams[id]; i += 1) await sleep(50);
}

/** 让她按"哄睡"功能预设说一段（流式）：onText 每次拿到目前为止的正文。没接通、失败时写明原因 */
async function askHer(
  task: string,
  input: string,
  opts: { userText?: string; cue?: string; onText(full: string): void },
): Promise<{ text: string; interrupted: boolean } | null> {
  if (!chatId.value) return null;
  voiceError.value = '';
  onActivity();
  writing.value = true;
  const r = await chat.sceneReply(chatId.value, { task, input, userText: opts.userText, cue: opts.cue, allowedTags: ['expr'], onText: opts.onText });
  writing.value = false;
  if (r.ok) return { text: r.message.text, interrupted: !!r.message.meta.interrupted };
  // 没接通的原因在提示条里
  if (!r.notConnected) line.value = `（${r.reason}）`;
  return null;
}

/** 她说一小段（晚安）：边生成边分句读 */
async function herSays(task: string, input: string, opts: { cue?: string; speedFactor?: number } = {}): Promise<void> {
  const q = newSpeech({ speedFactor: opts.speedFactor });
  const stream = new SentenceStream();
  const r = await askHer(task, input, {
    ...opts,
    onText: (full) => {
      line.value = full;
      if (!q.stopped) q.pushAll(stream.feed(full));
    },
  });
  if (r === null) {
    q.stop();
    return;
  }
  line.value = r.text;
  if (!q.stopped) q.pushAll(stream.flush(r.text));
  q.end();
  await q.drained();
}

/** 现在的情况：写进她这一次的场景任务 */
function nowLine() {
  const parts = [`现在 ${hhmm(Date.now())}`, lightsOff.value ? '已经熄灯了' : '灯还开着'];
  if (sleepAudio.noiseActive.value) parts.push('开着白噪音');
  const s = sleepMusic.current();
  if (s && sleepMusic.state.playing) parts.push(`在放《${s.title}》- ${s.artist}${sleepMusic.state.demo ? '（示例歌曲）' : ''}`);
  return `${parts.join('，')}。`;
}

// —— 故事：她现编，边写边读；可以暂停（继续时从停下的那句读）、换题材 ——
const story = reactive({ title: '', genre: '', sentences: [] as string[], index: -1, playing: false, done: false });
const told: { title: string; genre: string }[] = [];
const genreOpen = ref(false);
/** 正在读故事的队列（暂停时停掉，继续时新开一个） */
let storyQueue: SpeechQueue | null = null;
/** 每次新故事一个，旧故事的流式回调作废 */
let storyRun = 0;

/** 正文第一行是《故事名》：标题齐了才开始读；还没写完标题时返回 null */
function splitTitle(full: string): { title: string; body: string } | null {
  const t = full.trimStart();
  if (!t) return null;
  if (!t.startsWith('《')) return { title: '', body: t };
  const m = /^《([^》\n]{1,40})》[ \t]*\n?/.exec(t);
  if (m) return m[0].endsWith('\n') || t.length > m[0].length ? { title: m[1]!, body: t.slice(m[0].length) } : null;
  return t.length > 48 ? { title: '', body: t } : null;
}

/** 从第 index 句读起；故事还在写时，后面写出来的句子接着排进这个队列 */
function readFrom(index: number) {
  const start = Math.max(0, index);
  const q = newSpeech({
    speedFactor: 0.9,
    onSentence: (t, i) => {
      story.index = start + i;
      // 开着麦时记下来：麦克风听到的是她自己在念，不当成你在说话
      link.noteHerLine(t);
    },
  });
  storyQueue = q;
  story.playing = true;
  q.pushAll(story.sentences.slice(start));
  if (story.done) q.end();
  void q.drained().then(() => {
    if (storyQueue === q && story.done && !q.stopped) {
      story.playing = false;
      story.index = -1;
    }
  });
}
const storyLive = () => !!storyQueue && storyQueue === speech && !storyQueue.stopped;

/** 讲一个新的：genre 是点的题材；request 是你说的原话（开着麦说的"换一个科幻的"），存进聊天、交给她照着来 */
async function newStory(want: { genre?: string; request?: string } = {}) {
  const run = (storyRun += 1);
  genreOpen.value = false;
  // 她在连麦里正回着、上一个故事还在写：先停下来（只留说出口的）
  await link.interrupt();
  await stopWriting();
  if (run !== storyRun) return;
  line.value = '';
  Object.assign(story, { title: '', genre: want.genre ?? '', sentences: [], index: -1, playing: true, done: false });
  const stream = new SentenceStream();
  const genres = [...new Set(told.map((t) => t.genre).filter(Boolean))];
  const input = [
    nowLine(),
    '讲一个新的睡前故事。',
    want.request ? `${userName.value}刚才说："${want.request}"。照这句话的意思来。` : '',
    want.genre ? `题材：${want.genre}。` : want.request ? '' : `题材你来挑${genres.length ? `，和今晚讲过的（${genres.join('、')}）不一样` : ''}。`,
    told.length ? `今晚已经讲过：${told.map((t) => `《${t.title}》`).join('、')}，不要重复。` : '',
  ]
    .filter(Boolean)
    .join('\n');
  readFrom(0);
  const r = await askHer('sleep-story', input, {
    cue: '睡前故事',
    userText: want.request,
    onText: (full) => {
      const parts = run === storyRun ? splitTitle(full) : null;
      if (!parts) return;
      story.title = parts.title;
      const fresh = stream.feed(parts.body);
      story.sentences.push(...fresh);
      // 暂停时只攒着，继续时从停下的那句读
      if (storyLive()) storyQueue!.pushAll(fresh);
    },
  });
  if (run !== storyRun) return;
  if (r === null) {
    story.playing = false;
    storyQueue?.stop();
    return;
  }
  const parts = splitTitle(r.text) ?? { title: story.title, body: r.text };
  story.title = parts.title;
  const rest = stream.flush(parts.body);
  story.sentences.push(...rest);
  story.done = true;
  if (!story.sentences.length) {
    story.playing = false;
    storyQueue?.stop();
    // 只写出了标题：回复被截断了。你开口打断的不算
    if (!r.interrupted) line.value = '（故事只写出了标题就停了：回复被截断了。可以在"我的 → 预设 → 功能 → 哄睡"里调大"最长回复"再试）';
    return;
  }
  if (story.title) told.push({ title: story.title, genre: story.genre });
  if (storyLive()) {
    storyQueue!.pushAll(rest);
    storyQueue!.end();
  }
}

function toggleStory() {
  if (story.playing) {
    story.playing = false;
    stopSpeech();
    return;
  }
  if (!story.sentences.length || (story.done && story.index < 0)) {
    void newStory();
    return;
  }
  onActivity();
  readFrom(story.index < 0 ? 0 : story.index);
}
const storyEl = ref<HTMLElement | null>(null);
watch(
  () => story.index,
  (i) => {
    const el = storyEl.value?.querySelector<HTMLElement>(`[data-s="${i}"]`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
);

/**
 * 故事里开着麦时你说的话只当口令：换一个（可以带题材）、先停一下、接着讲。她不开口回你，故事照常讲。
 * 没听出是哪种就提示一句怎么说
 */
const voiceHint = ref('');
let hintTimer: ReturnType<typeof setTimeout> | undefined;
function hint(text: string) {
  voiceHint.value = text;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => (voiceHint.value = ''), 4000);
}
function storyCommand(said: string): boolean {
  const t = said.replace(/\s+/g, '');
  const genre = GENRES.find((g) => t.includes(g.label) || g.words.test(t))?.label;
  if (genre || /换|再(讲|来|说)|另(一|外)|下一个|别的|重新/.test(t)) {
    hint(genre ? `好，换一个${genre}的` : '好，换一个');
    void newStory({ genre, request: said.trim() });
  } else if (/暂停|停一下|停一停|先停|别讲|不想听|不听了|安静/.test(t)) {
    if (story.playing) toggleStory();
    hint('先停在这儿，说"接着讲"就继续');
  } else if (/继续|接着(讲|说)|往下(讲|说)/.test(t)) {
    if (!story.playing) toggleStory();
  } else if (/讲个|讲一个|来个|来一个|说个|想听|要听|故事/.test(t)) {
    hint('好，换一个');
    void newStory({ request: said.trim() });
  } else {
    hint('想换故事可以说"换一个科幻的"，想停就说"先停一下"');
  }
  return true;
}

// —— 连麦：说话她就听得到，小声回你；故事里只听口令 ——
const link = useMicLink({
  chatId,
  character: her,
  userName,
  newSpeech: (o) => newSpeech({ onSentence: o.onSentence }),
  context: nowLine,
  herBusy: () => story.playing,
  onInterrupt: () => {
    if (story.playing) toggleStory();
  },
  autoWhisper: () => mode.value === 'mic' && whispers.value,
  onActivity,
  greet: () => mode.value === 'mic',
  onHeard: (text) => (mode.value === 'story' ? storyCommand(text) : false),
});
const typed = ref('');
function sendTyped() {
  const t = typed.value.trim();
  if (!t) return;
  typed.value = '';
  void link.say(t);
}
const linkStatus = computed(() => {
  const s = link.state;
  const p = her.value.pronoun;
  if (!s.on) return '没连着';
  if (s.her === 'speaking') return `${p}在小声说……`;
  if (s.her === 'thinking') return `${p}在想……`;
  if (s.you === 'recognizing') return '在听清你说的话……';
  if (s.you === 'speaking') return '在听你说……';
  if (s.input === 'type') return `打字和${p}说`;
  if (s.muted) return '你闭麦了';
  return `说话${p}就听得到`;
});
/** 麦克风、语音识别哪一步没接通：写明原因，点了去设置 */
const linkIssues = computed(() => {
  const s = link.state;
  const out: { text: string; to: string; icon: string }[] = [];
  // 挂断以后上一次的报错不留着（换到故事里没开麦时不该还挂着一条）
  if (!s.on) return out;
  if (s.micIssue) out.push({ text: s.micIssue, to: '/me/voice', icon: 'i-lucide-mic-off' });
  else if (s.sttIssue) out.push({ text: s.sttIssue, to: '/me/api?feature=stt', icon: 'i-lucide-ear-off' });
  return out;
});
const lastHerCaption = computed(() => [...link.state.captions].reverse().find((c) => c.who === 'her')?.text ?? '');
/** 故事里：开着麦、真的在听 */
const listening = computed(() => link.state.on && link.state.input === 'auto');
/** 在点击里调用：麦克风权限要用户点过 */
function toggleVoiceCmd() {
  if (listening.value) {
    voiceCmd.value = false;
    void link.hangUp();
    return;
  }
  voiceCmd.value = true;
  if (link.state.on) link.setInput('auto');
  else link.connect();
}
const voiceLine = computed(() => {
  if (voiceHint.value) return voiceHint.value;
  if (!listening.value) return '';
  if (link.state.you === 'recognizing') return '在听清你说的话……';
  if (link.state.you === 'speaking') return '在听你说……';
  return '开着麦：说"换一个科幻的"就换，说"先停一下"就停';
});

// —— 连麦的画面："生图 · 哄睡"，竖图铺满整屏；没画好、没接通时是立绘 ——
const art = ref<GalleryItem | null>(null);
const artIssue = ref<{ text: string; settings: boolean } | null>(null);
const drawingNow = computed(() => gallery.isDrawing(her.value.id, 'sleep'));
const drawingText = computed(() => {
  const d = drawingNow.value;
  if (!d) return null;
  const what = d.moment === 'now' ? '这一刻' : '连麦的画面';
  return d.stage === 'queued' ? `${what}：排队等前一张画完` : d.stage === 'prompt' ? `${what}：正在写 tags` : `${what}：正在画`;
});
let autoNoted = false;
async function drawMoment(moment: 'mic' | 'now', priority: 'user' | 'auto', caption: string): Promise<void> {
  if (priority === 'auto') {
    const chk = gallery.autoCheck();
    if (!chk.ok) {
      // 没接通、自动画停着：只提示一次，不打扰
      if (!autoNoted && chk.reason !== '自动画关着') artIssue.value = { text: `画面先用立绘：${chk.reason}`, settings: /没接通|API 设置/.test(chk.reason) };
      autoNoted = true;
      return;
    }
  }
  const r = await gallery.draw({
    characterId: her.value.id,
    sceneId: 'sleep',
    moment,
    caption,
    priority,
    locationId: location.value?.id ?? null,
    expression: 'sleepy',
    recent: chatId.value ? chat.recentLines(chatId.value, 4) : [],
    size: 'portrait',
  });
  if (!r.ok) {
    if (!r.busy) artIssue.value = { text: `没画出来：${r.reason}`, settings: /没接通/.test(r.reason) };
    return;
  }
  artIssue.value = null;
  art.value = r.item;
}
const lightLine = () => (lightsOff.value ? '已经熄灯了，只有一点月光' : '床头灯还亮着');
/** 连上麦：今天同一身睡衣画过的直接用，没有就画一张 */
function ensureArt() {
  if (art.value || drawingNow.value) return;
  const outfit = rhythm.outfitFor(her.value.id, 'sleep')?.name ?? null;
  const found = gallery.find(her.value.id, 'sleep', { moment: 'mic', today: true, outfit, size: 'portrait' })[0];
  if (found) {
    art.value = found;
    return;
  }
  void drawMoment('mic', 'auto', `睡前，${her.value.name}躺在床上和${userName.value}连麦，刚连上，小声说着话；${lightLine()}`);
}
function snap() {
  if (drawingNow.value) {
    showToast('正在画上一张，等一下');
    return;
  }
  const said = lastHerCaption.value;
  void drawMoment('now', 'user', `睡前，${her.value.name}躺在床上和${userName.value}连麦，画${her.value.pronoun}此刻的样子${said ? `：${her.value.pronoun}刚小声说"${said.slice(0, 60)}"` : ''}；${lightLine()}`);
}
function toggleAutoDraw() {
  gallery.autoDraw = !gallery.autoDraw;
  showToast(gallery.autoDraw ? '自动画图开了：连上麦时画一张' : '自动画图关了：点相机才画');
  if (gallery.autoDraw && mode.value === 'mic') {
    autoNoted = false;
    artIssue.value = null;
    ensureArt();
  }
}
async function previewArt() {
  const a = art.value;
  if (!a) return;
  const img = await shotViewerImage(a);
  if (img) previewImages([img]);
  else showToast('本机找不到这张图了');
}

// —— 场景：背景换成挑的那个地方 ——
const scenePlace = ref<BackgroundPlace | null>(null);
/** 立绘在这个地方的位置记在哪、这个地方叫什么（挑地方时场景告诉这里） */
const sceneFigure = ref({ key: '', name: '' });
const immersion = ref<InstanceType<typeof SleepImmersion> | null>(null);
function onPlace(info: { place: BackgroundPlace; layoutKey: string; name: string }) {
  scenePlace.value = info.place;
  sceneFigure.value = { key: info.layoutKey, name: info.name };
}

// —— 立绘：每种画面各记各的位置和大小；右上角"调立绘"对着真正的背景调 ——
const figure = computed(() => {
  if (mode.value === 'mic') return { key: 'sleep:mic', label: '连麦' };
  if (mode.value === 'story') return { key: 'sleep:story', label: '故事' };
  if (mode.value === 'scene' && sceneFigure.value.key) return { key: sceneFigure.value.key, label: sceneFigure.value.name };
  return { key: 'sleep', label: '选怎么睡' };
});
const adjusting = ref(false);
/** 看得到立绘、而且她有自己的立绘（占位的小人没有地方存）时才能调；连麦画好了图就是图，没有立绘 */
const canAdjust = computed(() => mode.value !== 'home' && !night.value && !!her.value.portraits && !(mode.value === 'mic' && !!art.value));
watch(canAdjust, (ok) => {
  if (!ok) adjusting.value = false;
});

// —— 进入、离开一种画面 ——
/** 在点击里调用：麦克风权限、恢复音频都要用户点过 */
function enter(m: Exclude<Mode, 'home'>) {
  night.value = false;
  asleep.value = false;
  line.value = '';
  mode.value = m;
  if (m === 'mic') {
    link.connect();
    ensureArt();
  } else if (m === 'story') {
    // 语音识别没接通时不硬开麦（不然一进来就是一条报错），点题材一样能换
    if (voiceCmd.value && ai.status('stt').live) link.connect();
    void newStory();
  }
}
/** 回到卧室选别的：连麦挂断、故事和场景停下；白噪音和音乐照常 */
async function leave() {
  mode.value = 'home';
  night.value = false;
  scenePlace.value = null;
  sceneFigure.value = { key: '', name: '' };
  genreOpen.value = false;
  storyRun += 1;
  story.playing = false;
  await link.hangUp();
  stopSpeech();
  await stopWriting();
}
function reconnect() {
  night.value = false;
  link.connect();
  ensureArt();
}

// —— 白噪音、音乐开始放了就开始计时；渐弱时自动换下一首不算，渐弱时你点了播放（不再变小）算 ——
watch(
  () => (ambience.state.playing && !ambience.state.fading) || (sleepMusic.state.playing && !sleepMusic.state.fading),
  (on) => {
    if (on) onActivity();
  },
);

// —— 定时：到点她说最后一句晚安，挂断连麦，白噪音和音乐渐弱，她也睡着 ——
const sleepAt = ref<number | null>(null);
const now = ref(Date.now());
const clockTimer = setInterval(() => {
  now.value = Date.now();
  if (sleepAt.value !== null && now.value >= sleepAt.value) void goNight(true);
}, 1000);
function armTimer() {
  if (sleepAt.value === null && timerMin.value) sleepAt.value = Date.now() + timerMin.value * 60_000;
}
watch(timerMin, (m) => {
  if (sleepAt.value !== null || ambience.state.playing || story.playing || link.state.on || sleepMusic.state.playing || mode.value === 'scene') sleepAt.value = m ? Date.now() + m * 60_000 : null;
});
const remaining = computed(() => {
  if (sleepAt.value === null) return '';
  const s = Math.max(0, Math.round((sleepAt.value - now.value) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
/** say：她要不要再说一句晚安（定时到了要；场景里她已经说过最后一段了，不用） */
async function goNight(say: boolean) {
  sleepAt.value = null;
  night.value = true;
  genreOpen.value = false;
  storyRun += 1;
  story.playing = false;
  await immersion.value?.halt();
  // 连麦挂断（她说到一半的只留说出口的），麦克风关掉
  await link.hangUp();
  stopSpeech();
  await stopWriting();
  lightsOff.value = true;
  if (say) {
    line.value = '';
    if (companionStatus.value.live) await herSays('sleep-end', `${nowLine()}定时到了。`, { cue: '晚安', speedFactor: 0.8 });
  }
  // 说完晚安以后不再重新开始计时
  sleepAt.value = null;
  asleep.value = true;
  await Promise.all([ambience.fadeOut(45), sleepMusic.fadeOut(45)]);
}
/** 还醒着：画面回来（连麦已经挂了，要再连一次） */
function wake() {
  night.value = false;
  asleep.value = false;
}

// —— 明早叫醒：主动消息里这个角色的"叫醒来电" ——
const wakeCall = computed({
  get: () => {
    const p = her.value.proactive;
    return p.enabled && p.allowCalls && p.triggers.includes('wake-call');
  },
  set: (on: boolean) => {
    const p = her.value.proactive;
    if (on) {
      p.enabled = true;
      p.allowCalls = true;
      if (!p.triggers.includes('wake-call')) p.triggers.push('wake-call');
    } else {
      p.triggers = p.triggers.filter((t) => t !== 'wake-call');
    }
  },
});

onBeforeUnmount(() => {
  clearInterval(clockTimer);
  clearTimeout(hintTimer);
  link.dispose();
  if (chat.streams[chatId.value]) chat.stop(chatId.value);
  stopSpeech();
  ambience.stop();
  sleepMusic.stop();
});

/** 提示条：「陪伴 · 快速」没接通（三种画面都要用）；连麦里她没回上；没有声音 */
const notices = computed(() => {
  const out: { text: string; to: string; icon: string }[] = [];
  if (!companionStatus.value.live) out.push({ text: `「陪伴 · 快速」还没接通：${companionStatus.value.reason}`, to: '/me/api?feature=companion', icon: 'i-lucide-plug-zap' });
  else if (mode.value === 'mic' && link.state.llmIssue) out.push({ text: link.state.llmIssue, to: '/me/api?feature=companion', icon: 'i-lucide-plug-zap' });
  if (!voiceLive.value || voiceError.value) out.push({ text: voiceError.value || `没有声音：语音合成还没接通，或者还没给${her.value.name}选音色（字幕照常）`, to: '/me/voice', icon: 'i-lucide-volume-x' });
  return out;
});

const shownLine = computed(() => {
  if (asleep.value) return '（呼吸声）……';
  if (writing.value && !line.value) return '';
  return line.value || '今晚想怎么睡？';
});
const modeLabel = computed(() => MODES.find((m) => m.id === mode.value)?.label ?? '');
</script>

<template>
  <SceneShell
    scene-id="sleep"
    :bare="mode !== 'home'"
    :hide-mode="mode !== 'home'"
    :title="mode === 'home' ? undefined : `哄睡 · ${modeLabel}`"
    :back="mode === 'home' ? null : leave"
    :dim="lightsOff ? 0.55 : 0.15"
    :rain="mode !== 'scene' && sleepAudio.raining.value"
    :tod="mode === 'scene' ? (lightsOff ? 'late' : 'night') : undefined"
    :background-location="scenePlace ?? undefined"
    :expression="mode === 'scene' && !night ? undefined : asleep || lightsOff ? 'sleep' : 'sleepy'"
    :line="shownLine"
    :typing="writing && mode === 'home'"
    :layout="mode === 'home' ? { left: 50, bottom: 40, height: 50 } : SLEEP_FULL_LAYOUT"
    :layout-key="figure.key"
    :hide-figure="mode === 'mic' && !!art"
    :drawing="mode === 'mic' ? drawingText : null"
  >
    <template #actions>
      <button v-if="canAdjust" type="button" class="pill-btn" :class="{ off: !adjusting }" :aria-pressed="adjusting" :aria-label="`调立绘的位置和大小：${figure.label}`" data-testid="sleep-figure" @click="adjusting = !adjusting">
        <span class="i-lucide-move" />
      </button>
      <template v-if="mode === 'mic' && !night">
        <button
          type="button"
          class="pill-btn"
          :class="{ off: !gallery.autoDraw }"
          :aria-pressed="gallery.autoDraw"
          :aria-label="gallery.autoDraw ? '自动画图：开（点一下关掉）' : '自动画图：关（点一下打开）'"
          @click="toggleAutoDraw"
        >
          <span :class="gallery.autoDraw ? 'i-lucide-image' : 'i-lucide-image-off'" />
        </button>
        <button type="button" class="pill-btn" :disabled="drawingNow?.priority === 'user'" :aria-label="`画${her.pronoun}此刻的样子`" data-testid="sleep-snap" @click="snap">
          <span :class="drawingNow?.priority === 'user' ? 'i-lucide-loader-circle spin' : 'i-lucide-camera'" />
        </button>
      </template>
      <button class="lamp" :class="{ off: lightsOff }" :aria-label="lightsOff ? '开灯' : '熄灯'" @click="lightsOff = !lightsOff">
        <span :class="lightsOff ? 'i-lucide-lamp' : 'i-lucide-lamp-desk'" />{{ lightsOff ? '开灯' : '熄灯' }}
      </button>
    </template>

    <!-- 全屏的三种画面 -->
    <template v-if="mode !== 'home'" #overlay>
      <!-- 场景：挑地方 + 沉浸画面 -->
      <SleepImmersion
        v-if="mode === 'scene'"
        v-show="!night && !adjusting"
        ref="immersion"
        :character="her"
        :chat-id="chatId"
        :user-name="userName"
        :speak="() => newSpeech({ speedFactor: 0.9 })"
        :stop-speech="stopSpeech"
        :context="nowLine"
        @place="onPlace"
        @activity="onActivity"
        @night="goNight(false)"
      >
        <template #dock><SleepAudioDock compact /></template>
      </SleepImmersion>

      <div v-else-if="!night" v-show="!adjusting" class="full" :data-testid="`sleep-${mode}`">
        <!-- 连麦：画好的图铺满整屏 -->
        <Transition name="art-swap">
          <button v-if="mode === 'mic' && art" :key="art.id" type="button" class="full-art" :aria-label="`看大图：${art.title}`" @click="previewArt">
            <AssetImg :asset-key="art.assetKey" :url="art.url" :alt="art.title" />
          </button>
        </Transition>
        <div class="shade bottom" aria-hidden="true" />

        <!-- 左上：在做什么、还剩多久，和没接通之类的提示 -->
        <div class="info-col">
          <div class="info-card">
            <template v-if="mode === 'mic'">
              <span v-if="link.state.on" class="live-dot" />
              <span class="shrink-0">{{ link.state.on ? '连麦中' : '连麦' }}</span>
              <span v-if="link.state.on" class="num shrink-0">{{ clock(link.state.seconds) }}</span>
              <span class="dot" /><span class="truncate" data-testid="mic-status">{{ linkStatus }}</span>
            </template>
            <template v-else>
              <span class="i-lucide-book-heart shrink-0 text-accent-ink" />
              <span class="truncate">{{ story.title ? `《${story.title}》` : '睡前故事' }}</span>
              <template v-if="story.genre"><span class="dot" /><span class="shrink-0">{{ story.genre }}</span></template>
            </template>
            <template v-if="remaining"><span class="dot" /><span class="num shrink-0">还剩 {{ remaining }}</span></template>
          </div>
          <button v-for="(x, i) in notices" :key="`n${i}`" type="button" class="mini-notice" @click="router.push(x.to)">
            <span :class="x.icon" class="shrink-0" /><span class="flex-1 min-w-0 text-left">{{ x.text }}</span><span class="text-accent-ink shrink-0">去设置</span>
          </button>
          <button v-for="(x, i) in linkIssues" :key="`l${i}`" type="button" class="mini-notice bad" @click="router.push(x.to)">
            <span :class="x.icon" class="shrink-0" /><span class="flex-1 min-w-0 text-left">{{ x.text }}</span><span class="shrink-0 underline">去设置</span>
          </button>
          <button v-if="mode === 'mic' && artIssue" type="button" class="mini-notice" :disabled="!artIssue.settings" @click="router.push('/me/api?feature=image')">
            <span class="i-lucide-image-off shrink-0" /><span class="flex-1 min-w-0 text-left">{{ artIssue.text }}</span><span v-if="artIssue.settings" class="text-accent-ink shrink-0">去设置</span>
          </button>
        </div>

        <!-- 连麦 -->
        <div v-if="mode === 'mic'" class="bottom">
          <div v-if="link.state.on" class="captions" aria-live="polite">
            <p v-for="c in link.state.captions.slice(-3)" :key="c.id" :class="[c.who, { pending: c.pending }]">
              <b>{{ c.who === 'her' ? her.name : '我' }}：</b>{{ c.text }}
            </p>
            <p v-if="!link.state.captions.length" class="you">{{ her.pronoun }}在听……</p>
          </div>
          <p v-if="link.state.hint" class="float-line">{{ link.state.hint }}</p>
          <button v-if="link.state.on && link.state.needTap && link.state.input !== 'type'" type="button" class="tap" @click="link.tapToListen()">
            <span class="i-lucide-mic" />浏览器要先点一下才能听你说话：点这里
          </button>
          <form v-if="link.state.on && link.state.input === 'type'" class="own" @submit.prevent="sendTyped">
            <input v-model="typed" class="own-input" :placeholder="`小声跟${her.pronoun}说……`" :aria-label="`跟${her.name}说`" enterkeyhint="send" />
            <button type="submit" class="own-send" :disabled="!typed.trim()" aria-label="说"><span class="i-lucide-send-horizontal" /></button>
          </form>
          <Waveform
            v-if="link.state.on"
            :level="link.state.her === 'speaking' ? level : link.state.muted ? 0 : link.state.youLevel"
            :tone="link.state.her === 'speaking' ? 'var(--accent)' : 'rgba(255,255,255,0.7)'"
            :bars="25"
          />
          <div class="bar">
            <SleepAudioDock compact />
            <span class="flex-1" />
            <template v-if="link.state.on">
              <button type="button" class="round" :class="{ on: link.state.muted }" :disabled="link.state.input === 'type'" :aria-label="link.state.muted ? '开麦' : '闭麦'" @click="link.setMuted(!link.state.muted)">
                <span :class="link.state.muted ? 'i-lucide-mic-off' : 'i-lucide-mic'" />
              </button>
              <button type="button" class="round" :aria-label="link.state.input === 'type' ? '改成说话' : '打字'" data-testid="mic-input" @click="link.setInput(link.state.input === 'type' ? 'auto' : 'type')">
                <span :class="link.state.input === 'type' ? 'i-lucide-audio-lines' : 'i-lucide-keyboard'" />
              </button>
              <button type="button" class="round hang" aria-label="挂断连麦" data-testid="mic-hangup" @click="link.hangUp()"><span class="i-lucide-phone-off" /></button>
            </template>
            <button v-else type="button" class="bar-btn end" data-testid="mic-connect" @click="reconnect"><span class="i-lucide-headphones" />和{{ her.name }}连麦</button>
          </div>
        </div>

        <!-- 故事：字半透明地浮在画面上 -->
        <div v-else class="bottom">
          <div ref="storyEl" class="story serif" :class="{ idle: !story.playing }">
            <template v-if="story.sentences.length">
              <span v-for="(s, i) in story.sentences" :key="i" :data-s="i" :class="{ now: i === story.index, read: story.index >= 0 && i < story.index }">{{ s }}</span>
            </template>
            <span v-else-if="writing">{{ her.pronoun }}在想今晚讲什么……</span>
            <span v-else>{{ line || `点 ▶ 让${her.pronoun}现编一个睡前故事，一边写一边读给你听。` }}</span>
          </div>
          <div v-if="genreOpen" class="genres" role="group" aria-label="换一个题材">
            <button type="button" class="genre" @click="newStory()"><span class="i-lucide-dices" />随便</button>
            <button v-for="g in GENRES" :key="g.label" type="button" class="genre" :class="{ on: story.genre === g.label }" @click="newStory({ genre: g.label })">{{ g.label }}</button>
          </div>
          <p v-if="voiceLine" class="float-line" data-testid="story-voice">{{ voiceLine }}</p>
          <Waveform v-if="story.playing && speaking" :level="level" tone="rgba(255,255,255,0.7)" />
          <div class="bar">
            <SleepAudioDock />
            <span class="flex-1" />
            <button type="button" class="bar-btn icon" :class="{ on: listening }" :aria-pressed="listening" :aria-label="listening ? '语音口令：开着（说一句就换故事）' : '语音口令：关着'" data-testid="story-mic" @click="toggleVoiceCmd">
              <span :class="listening ? 'i-lucide-mic' : 'i-lucide-mic-off'" />
            </button>
            <button type="button" class="bar-btn" :class="{ on: genreOpen }" :aria-expanded="genreOpen" data-testid="story-genre" @click="genreOpen = !genreOpen"><span class="i-lucide-shuffle" />换一个</button>
            <button type="button" class="round play" :aria-label="story.playing ? '暂停' : '播放'" data-testid="story-play" @click="toggleStory">
              <span :class="story.playing ? 'i-lucide-pause' : 'i-lucide-play'" />
            </button>
          </div>
        </div>
      </div>

      <!-- 调立绘：对着这个画面真正的背景拖（这时别的按钮先收起来，看得到整个人） -->
      <FigureAdjustPanel v-if="adjusting && canAdjust" :character="her" :layout-key="figure.key" :label="figure.label" @close="adjusting = false" />

      <!-- 定时到了、说了晚安：暗下来，她说完最后一句就睡着 -->
      <Transition name="fade">
        <div v-if="night" class="night" data-testid="sleep-night">
          <p class="night-line serif">{{ line || (asleep ? '（呼吸声）……' : '……') }}</p>
          <p v-if="asleep" class="night-sub">晚安。声音会慢慢变小。</p>
          <button type="button" class="bar-btn" @click="wake"><span class="i-lucide-sun-dim" />我还醒着</button>
        </div>
      </Transition>
    </template>

    <!-- 卧室：选怎么睡 -->
    <button v-for="(x, i) in notices" :key="i" type="button" class="notice" @click="router.push(x.to)">
      <span :class="x.icon" class="shrink-0" />
      <span class="flex-1 min-w-0 text-left">{{ x.text }}</span>
      <span class="text-accent-ink shrink-0">去设置</span>
    </button>
    <div class="modes">
      <button v-for="m in MODES" :key="m.id" type="button" class="mode press" :data-mode="m.id" @click="enter(m.id)">
        <span class="mode-icon"><span :class="m.icon" /></span>
        <span class="text-[14.5px] font-600">{{ m.label }}</span>
        <span class="mode-desc">{{ m.desc }}</span>
      </button>
    </div>
    <p class="text-[12px] text-ink-3 mt-2 mb-0">进去以后白噪音（能叠呼吸声）和音乐在左下角，换着玩声音不断。</p>

    <div class="mt-3.5">
      <div class="text-[12.5px] text-ink-3 mb-1.5">
        定时（到点{{ her.pronoun }}说晚安、挂断连麦，声音慢慢变小，{{ her.pronoun }}也会睡着）<span v-if="remaining" class="num text-accent-ink"> · 还剩 {{ remaining }}</span>
      </div>
      <div class="flex gap-2">
        <button v-for="t in [15, 30, 60]" :key="t" class="chip-opt num" :class="{ on: timerMin === t }" @click="timerMin = t">{{ t }} 分钟</button>
        <button class="chip-opt" :class="{ on: timerMin === null }" @click="timerMin = null">不定时</button>
      </div>
    </div>
    <label class="flex items-center justify-between gap-3 mt-3.5">
      <span class="text-[14px]">连麦时你安静久了，{{ her.pronoun }}偶尔小声说一句</span>
      <van-switch v-model="whispers" size="22px" />
    </label>
    <div class="flex items-center justify-between gap-3 mt-3.5">
      <div>
        <div class="text-[14px]">明早 {{ env.settings.wakeTime }} {{ her.pronoun }}打电话叫醒你</div>
        <div class="text-[12px] text-ink-3">主动消息里的"叫醒来电"；安卓：精确闹钟 + 全屏来电，iPhone：推送点开接听</div>
      </div>
      <van-switch v-model="wakeCall" size="22px" />
    </div>
  </SceneShell>
</template>

<style scoped>
.lamp {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 13px;
  color: #f2c98a;
}
.lamp.off {
  color: var(--ink-3);
}
.pill-btn {
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
  color: var(--accent-ink);
  font-size: 16px;
}
.pill-btn.off {
  color: var(--ink-3);
}
.pill-btn:disabled {
  opacity: 0.7;
}

/* —— 卧室：选怎么睡 —— */
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  margin-bottom: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
/* 三种睡法排成一行 */
.modes {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}
.mode {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  min-width: 0;
  padding: 12px 6px 10px;
  border-radius: 16px;
  background: var(--panel);
  color: var(--ink);
  text-align: center;
}
.mode-desc {
  max-width: 100%;
  font-size: 11px;
  line-height: 1.35;
  color: var(--ink-3);
}
.mode-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 20px;
  flex-shrink: 0;
}
.chip-opt {
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip-opt.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}

/* —— 全屏的画面 —— */
.full {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.full-art {
  position: absolute;
  inset: 0;
  display: block;
  padding: 0;
  border: 0;
  background: #000;
  cursor: zoom-in;
  overflow: hidden;
}
.full-art :deep(.asset-img) {
  object-position: 50% 22%;
  transform-origin: 50% 30%;
  animation: drift 40s ease-in-out infinite alternate;
}
@keyframes drift {
  to {
    transform: scale(1.06);
  }
}
.art-swap-enter-active,
.art-swap-leave-active {
  transition: opacity 1s ease;
}
.art-swap-enter-from,
.art-swap-leave-to,
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.8s ease;
}
.shade.bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 340px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.55), transparent);
  pointer-events: none;
}
.info-col {
  position: absolute;
  z-index: 9;
  top: calc(var(--safe-top) + 58px);
  left: 12px;
  right: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}
.info-card {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 11px;
  border-radius: 99px;
  background: var(--veil);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  font-size: 12px;
  color: var(--ink-2);
}
.info-card .dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.5;
  flex-shrink: 0;
}
.live-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--good);
  flex-shrink: 0;
  animation: live 1.6s ease-in-out infinite;
}
@keyframes live {
  50% {
    opacity: 0.35;
  }
}
.mini-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 12px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}
.mini-notice.bad {
  border-color: color-mix(in srgb, var(--bad) 45%, transparent);
  color: var(--ink);
}

.bottom {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 10px calc(var(--safe-bottom) + 10px);
}
/* 最下面一排：左边是白噪音和音乐，右边是这种画面自己的按钮；浮出来的面板按这一排定位 */
.bar {
  position: relative;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
}
.bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 38px;
  height: 38px;
  padding: 0 13px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.bar-btn.icon {
  padding: 0;
  font-size: 16px;
}
.bar-btn.on {
  color: var(--accent-ink);
  border-color: var(--accent-line);
}
.bar-btn.end {
  color: var(--on-accent);
  background: var(--accent);
  border-color: transparent;
  font-weight: 600;
}
.round {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 20px;
  flex-shrink: 0;
}
.round.on {
  background: var(--ink);
  color: var(--bg);
}
.round.hang {
  background: #e5484d;
  border-color: transparent;
  color: #fff;
}
.round.play {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
}
.round:disabled {
  opacity: 0.45;
}

/* 连麦的字幕、故事的正文：半透明，压在画面上 */
.captions,
.story {
  padding: 10px 14px;
  border-radius: 18px;
  background: rgba(12, 12, 22, 0.34);
  border: 1px solid rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  color: rgba(255, 255, 255, 0.9);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5);
}
.captions {
  max-height: 26vh;
  overflow-y: auto;
}
.captions p {
  margin: 0 0 4px;
  font-size: 14px;
  line-height: 1.6;
}
.captions p:last-child {
  margin-bottom: 0;
}
.captions p.you {
  color: rgba(255, 255, 255, 0.62);
}
.captions p.pending {
  opacity: 0.6;
}
.captions b {
  font-weight: 600;
}
.story {
  max-height: 34vh;
  overflow-y: auto;
  font-size: 15.5px;
  line-height: 1.95;
  color: rgba(255, 255, 255, 0.62);
  /* 上下两头淡出去：字像浮在画面上，而不是装在框里 */
  -webkit-mask-image: linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent);
  mask-image: linear-gradient(to bottom, transparent, #000 14%, #000 86%, transparent);
  padding-block: 20px;
  scrollbar-width: none;
}
.story::-webkit-scrollbar {
  display: none;
}
.story .read {
  color: rgba(255, 255, 255, 0.42);
}
.story .now {
  color: #fff;
}
.story.idle {
  color: rgba(255, 255, 255, 0.8);
}
.genres {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  animation: rise 0.2s var(--ease) both;
}
.genre {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 13px;
}
.genre.on {
  border-color: var(--accent-line);
  color: var(--accent-ink);
}
.float-line {
  margin: 0;
  padding: 0 4px;
  font-size: 12.5px;
  line-height: 1.5;
  color: rgba(255, 255, 255, 0.78);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
}
.tap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  padding: 9px 14px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 13px;
}
.own {
  display: flex;
  gap: 8px;
}
.own-input {
  flex: 1;
  min-width: 0;
  height: 42px;
  padding: 0 16px;
  border-radius: 21px;
  border: 1px solid var(--glass-line);
  background: var(--glass-strong);
  color: var(--ink);
  outline: none;
  font-size: 16px;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.own-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  flex-shrink: 0;
}
.own-send:disabled {
  opacity: 0.5;
}

/* —— 睡着了 —— */
.night {
  position: absolute;
  z-index: 30;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 0 28px calc(var(--safe-bottom) + 56px);
  background: linear-gradient(to top, rgba(0, 0, 0, 0.82), rgba(0, 0, 0, 0.5));
  text-align: center;
}
.night-line {
  margin: 0;
  font-size: 17px;
  line-height: 1.8;
  color: rgba(255, 255, 255, 0.86);
}
.night-sub {
  margin: 0 0 8px;
  font-size: 12.5px;
  color: rgba(255, 255, 255, 0.5);
}
.spin {
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
