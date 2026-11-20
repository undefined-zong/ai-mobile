<script setup lang="ts">
import type { BackgroundPlace, Character, ParsedReply } from '@app/shared';
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { BACKGROUND_GROUPS, BACKGROUND_PERIOD_LABEL, BACKGROUND_SETS, backgroundUrl, familyCover, type BackgroundAsset, type BackgroundFamily } from '@/backgrounds/library';
import { sceneText } from '@/services/prompt';
import { SLEEP_PRESET_PLACES, sleepSceneLayoutKey } from './places';
import type { SpeechQueue } from '@/services/speech';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { sleep } from '@/utils/id';
import { hhmm } from '@/utils/time';

/**
 * 哄睡 · 场景（设计文档 §9.4）：先挑一个睡前的地方，再进入像约会那样的沉浸画面，她陪你在那里慢慢睡着。
 * - 挑地方：现成的四个（夜行列车、温泉旅馆、夜航飞机、林间小屋），随机一个，或者从背景素材库里自己选一个系列；
 *   选中就把背景换过去（外壳按素材系列铺背景，立绘照常站在上面），上次选的记在这台设备上。
 *   每个地方下面一排是这个系列的每一张图：默认"自动"（按夜里的时段挑），点一张就固定用那一张（白天的、黄昏的、开灯关灯的都能挑）。
 *   立绘在每个地方怎么摆各记各的（layoutKey 交给外面，外面的"调立绘"按它存）。
 * - 沉浸画面：她一段一段地说（「陪伴 · 快速」+"哄睡 · 场景"预设：开场 sleep-scene-start、每一段 sleep-scene-turn、结束 sleep-scene-end），
 *   边生成边按行翻页，（旁白）和「台词」各一拍；台词用她的声音低声读出来，读完自己翻到下一句（可以关掉自动，自己点）；
 *   每段结尾给三个很轻的选项，也可以自己说；点"睡了"她说最后一段，然后和定时到点一样：声音慢慢变小，她也睡着。
 * 白噪音和音乐的按钮由外面放进 dock 插槽，在左下角。她的声音用外面给的那一路（speak：场景里同一时间只有一段）。
 */
const props = defineProps<{
  character: Character;
  chatId: string;
  userName: string;
  /** 新开一段她的声音（正在说的那段会停下） */
  speak: () => SpeechQueue;
  stopSpeech: () => void;
  /** 现在的情况（几点、灯、白噪音、在放什么歌），写进场景任务 */
  context: () => string;
}>();
const emit = defineEmits<{
  /** 背景换成哪个地方（place 交给外壳铺背景）；layoutKey：立绘在这个地方的位置记在哪；name：地方的名字 */
  (e: 'place', info: { place: BackgroundPlace; layoutKey: string; name: string }): void;
  /** 有动静：开始计时、不再算睡着 */
  (e: 'activity'): void;
  /** 她说完了最后一段，你点了晚安 */
  (e: 'night'): void;
}>();

const chars = useCharacterStore();
const chat = useChatStore();
const router = useRouter();

// —— 挑地方 ——
interface SleepPlace {
  /** 现成的四个是自己的 id，从素材库选的是系列 id */
  id: string;
  name: string;
  blurb: string;
  icon: string;
  family: BackgroundFamily;
  /** 固定用这个系列里的哪一张；null 是自动（按夜里的时段挑） */
  asset: BackgroundAsset | null;
}
const familyOf = (id: string) => BACKGROUND_SETS.find((f) => f.id === id);
const PRESETS: SleepPlace[] = SLEEP_PRESET_PLACES.flatMap((p) => {
  const family = familyOf(p.family);
  return family ? [{ ...p, family, asset: null }] : [];
});
/** 素材库里的一个系列当睡前的地方 */
function placeOf(family: BackgroundFamily): SleepPlace {
  const blurb = zt()('sleepScene.place.blurb', { scene: family.scene, style: family.style, place: zt()(family.indoor ? 'common.indoor' : 'common.outdoor') });
  return { id: family.id, name: family.style || family.scene, icon: 'i-lucide-image', family, asset: null, blurb };
}
/** 一张图是什么时候、什么灯光（缩略图上的小字） */
const shotLabel = (a: BackgroundAsset) => [BACKGROUND_PERIOD_LABEL[a.period], a.lighting].filter(Boolean).join(' · ');
/** 封面：黄昏的最看得清又有睡前的气氛，没有就用夜里的（进去以后背景按夜里铺） */
const coverUrl = (f: BackgroundFamily) => backgroundUrl(f.assets.find((a) => a.period === 'dusk') ?? f.assets.find((a) => a.period === 'night') ?? familyCover(f));

const SAVE_KEY = 'ai-mobile:sleep:scene';
/** 上次在哪、每个地方固定用的是哪一张图（地方 id → 素材 id；没有的是自动） */
function loadSaved(): { id?: string; shots: Record<string, string> } {
  try {
    const raw = localStorage.getItem(SAVE_KEY) ?? '';
    // 以前只存地方的 id（一个字符串）
    const saved = (raw.startsWith('{') ? JSON.parse(raw) : { id: raw }) as { id?: string; shots?: Record<string, string> };
    return { id: saved.id, shots: saved.shots && typeof saved.shots === 'object' ? saved.shots : {} };
  } catch {
    return { shots: {} };
  }
}
const saved = loadSaved();
const shots = reactive<Record<string, string>>(saved.shots);
/** 这个地方配上它固定用的那一张（换到别的地方再回来，挑过的那张还在） */
const withShot = (p: SleepPlace): SleepPlace => ({ ...p, asset: p.family.assets.find((a) => a.id === shots[p.id]) ?? null });
function initialPlace(): SleepPlace {
  const family = saved.id ? familyOf(saved.id) : undefined;
  return withShot(PRESETS.find((x) => x.id === saved.id) ?? (family ? placeOf(family) : undefined) ?? PRESETS[0] ?? placeOf(BACKGROUND_SETS[0]!));
}
const place = ref<SleepPlace>(initialPlace());
function choose(p: SleepPlace) {
  place.value = withShot(p);
}
watch(
  place,
  (p) => {
    emit('place', {
      place: { id: `sleep:${p.family.id}`, name: p.name, indoor: p.family.indoor, backgroundSet: p.family.id, ...(p.asset ? { backgroundAsset: p.asset.id } : {}) },
      layoutKey: sleepSceneLayoutKey(p.id),
      name: p.name,
    });
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ id: p.id, shots }));
    } catch {
      // 无痕模式
    }
  },
  { immediate: true },
);
/** 这个地方用哪一张图：null 回到自动 */
function setAsset(asset: BackgroundAsset | null) {
  if (asset) shots[place.value.id] = asset.id;
  else delete shots[place.value.id];
  place.value = { ...place.value, asset };
}
/** 随机：夜里看得过去的系列里挑一个（有夜间或室内通用的图），不挑现在这个 */
function pickRandom() {
  const pool = BACKGROUND_SETS.filter((f) => f.id !== place.value.family.id && f.assets.some((a) => a.period === 'night' || a.period === 'indoor'));
  const f = pool[Math.floor(Math.random() * pool.length)];
  if (f) choose(PRESETS.find((p) => p.family.id === f.id) ?? placeOf(f));
}
const libraryOpen = ref(false);
const group = ref(BACKGROUND_GROUPS[0] ?? '');
const libraryList = computed(() => BACKGROUND_SETS.filter((f) => !group.value || f.assets[0]?.group === group.value));
function pickFamily(f: BackgroundFamily) {
  choose(PRESETS.find((p) => p.family.id === f.id) ?? placeOf(f));
  libraryOpen.value = false;
}
const isPreset = computed(() => PRESETS.some((p) => p.id === place.value.id));

// —— 沉浸画面：她这一段，边生成边按行翻页 ——
const phase = ref<'pick' | 'play'>('pick');
const turns = ref(0);
const ending = ref(false);
interface Beat {
  kind: 'narration' | 'line';
  text: string;
  /** 这一拍在正文里结束的位置（按位置换表情） */
  end: number;
}
const visible = ref('');
const tags = ref<ParsedReply['tags']>([]);
const busy = ref(false);
const done = ref(false);
const failed = ref('');
const notConnected = ref('');
const choices = ref<string[]>([]);
const beatIdx = ref(0);
const ownOpen = ref(false);
const own = ref('');
const ownInput = ref<HTMLInputElement | null>(null);
/** 读完一句自己翻到下一句 */
const auto = ref(true);
let lastAsk: { task: string; lines: string[] } | null = null;
/** 每问一次加一：上一段还在读的那一拍作废 */
let turnSeq = 0;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function cleanLine(t: string): string {
  const s = t.replace(new RegExp(`^${escapeRe(props.character.name)}\\s*[:：]\\s*`), '');
  const m = /^「([^「」]*)」$/.exec(s) ?? /^“([^“”]*)”$/.exec(s) ?? /^"([^"]*)"$/.exec(s);
  return (m?.[1] ?? s).trim();
}
/** 一行一拍：整行在（）里的是旁白（流式时还没收尾的也算），其余是台词 */
const beats = computed<Beat[]>(() => {
  const out: Beat[] = [];
  let offset = 0;
  for (const raw of visible.value.split('\n')) {
    const end = offset + raw.length;
    offset = end + 1;
    const t = raw.trim();
    if (!t) continue;
    const narr = /^[（(]([^（()）]*)[）)]?$/.exec(t) ?? /^\*([^*]+)\*?$/.exec(t);
    if (narr?.[1]?.trim()) out.push({ kind: 'narration', text: narr[1].trim(), end });
    else out.push({ kind: 'line', text: cleanLine(t), end });
  }
  return out;
});
const shownIdx = computed(() => Math.min(beatIdx.value, beats.value.length - 1));
const beat = computed(() => beats.value[shownIdx.value] ?? null);
const atLast = computed(() => beatIdx.value >= beats.value.length - 1);
const streamingHere = computed(() => busy.value && atLast.value && beats.value.length > 0);
const showChoices = computed(() => done.value && atLast.value && !ending.value && !failed.value);
const showFinale = computed(() => ending.value && done.value && atLast.value && !failed.value);

function advance() {
  if (!atLast.value) beatIdx.value += 1;
}

/** 翻到哪一拍就换成那一拍的表情（这一拍之前最后一个 [expr:]） */
let baseExpr = 'sleepy';
watch([beatIdx, () => beats.value.length, done], () => {
  const b = beat.value;
  if (!b) return;
  const e = [...tags.value].reverse().find((t) => t.tag.kind === 'expr' && t.at <= b.end);
  chars.setExpression(props.character.id, e && 'value' in e.tag ? e.tag.value : baseExpr);
});

/**
 * 翻到一拍、而且这一拍写完了（后面已经有下一拍，或者整段写完）：台词低声读出来，旁白按字数停一会儿；
 * 之后还停在这一拍、开着自动，就翻到下一句
 */
let presented = '';
watch([shownIdx, () => beats.value.length, done], () => {
  const i = shownIdx.value;
  const b = beats.value[i];
  if (!b || !(done.value || i < beats.value.length - 1)) return;
  const key = `${turnSeq}:${i}`;
  if (key === presented) return;
  presented = key;
  void present(b, key);
});
async function present(b: Beat, key: string) {
  if (b.kind === 'line') {
    const q = props.speak();
    q.push(b.text);
    q.end();
    await q.drained();
    // 被别的声音顶掉了（定时到了说晚安）：不往下翻
    if (q.stopped) return;
    await sleep(450);
  } else {
    props.stopSpeech();
    await sleep(1400 + b.text.length * 170);
  }
  if (presented === key && auto.value) advance();
}

/** 这个场景的程序文字（"哄睡 · 场景"用途的预设里的 sleepScene.immersion.*） */
function zt() {
  return sceneText('sleep-scene', props.character);
}
function contextLines(): string[] {
  const p = place.value;
  const t = zt();
  return [
    t('sleepScene.immersion.place', { name: p.name, blurb: p.blurb }),
    t('sleepScene.immersion.together', { user: props.userName, char: props.character.name }),
    props.context(),
    t('sleepScene.immersion.turn', { n: turns.value + 1 }),
  ];
}

async function ask(task: string, lines: string[], userText?: string): Promise<boolean> {
  if (!props.chatId) return false;
  lastAsk = { task, lines };
  const seq = (turnSeq += 1);
  presented = '';
  baseExpr = chars.expression[props.character.id] ?? 'sleepy';
  visible.value = '';
  tags.value = [];
  choices.value = [];
  beatIdx.value = 0;
  done.value = false;
  failed.value = '';
  ownOpen.value = false;
  busy.value = true;
  emit('activity');
  const r = await chat.sceneReply(props.chatId, {
    task,
    input: lines.filter(Boolean).join('\n'),
    userText,
    cue: ending.value ? '晚安' : '睡前场景',
    use: 'sleep-scene',
    allowedTags: ['expr', 'choice'],
    onParsed: (p) => {
      visible.value = p.visible;
      tags.value = p.tags;
    },
  });
  // 这一段被停掉了（定时到了、换地方、点了睡了）：画面已经是后来的，不再动
  if (seq !== turnSeq) return false;
  busy.value = false;
  if (!r.ok) {
    if (r.notConnected) notConnected.value = r.reason;
    failed.value = r.reason;
    return false;
  }
  notConnected.value = '';
  if (!visible.value.trim()) visible.value = r.message.text;
  const choice = [...tags.value].reverse().find((t) => t.tag.kind === 'choice')?.tag;
  choices.value = (choice?.kind === 'choice' ? choice.options : (r.message.meta.choices ?? [])).map((c) => c.trim()).filter(Boolean).slice(0, 4);
  // 选项只在这里用；聊天里不再显示成快捷回复
  r.message.meta.choices = undefined;
  done.value = true;
  turns.value += 1;
  return true;
}
function retry() {
  if (!lastAsk || busy.value) return;
  void ask(lastAsk.task, lastAsk.lines);
}

function start() {
  phase.value = 'play';
  turns.value = 0;
  ending.value = false;
  chars.setExpression(props.character.id, 'sleepy');
  void ask('sleep-scene-start', [...contextLines(), zt()('sleepScene.immersion.start')]);
}
function pick(c: string) {
  if (!showChoices.value) return;
  void ask('sleep-scene-turn', [...contextLines(), zt()('sleepScene.immersion.picked', { user: props.userName, choice: c })], c);
}
async function toggleOwn() {
  ownOpen.value = !ownOpen.value;
  if (!ownOpen.value) return;
  await nextTick();
  ownInput.value?.focus();
}
function sendOwn() {
  const text = own.value.trim();
  if (!text || !showChoices.value) return;
  own.value = '';
  void ask('sleep-scene-turn', [...contextLines(), zt()('sleepScene.immersion.said', { user: props.userName, text })], text);
}
/** 睡了：她说最后一段（不给选项），说完你点晚安 */
async function finish() {
  if (ending.value) return;
  if (!turns.value && !busy.value) {
    emit('night');
    return;
  }
  await halt();
  ending.value = true;
  void ask('sleep-scene-end', [...contextLines().slice(0, 3), zt()('sleepScene.immersion.end', { user: props.userName, turns: turns.value })]);
}
function changePlace() {
  void halt();
  props.stopSpeech();
  phase.value = 'pick';
  ending.value = false;
  visible.value = '';
  choices.value = [];
  failed.value = '';
}

/** 停下正在写的那一段（定时到了、换地方、离开），读到一半的那一拍不再往下翻 */
async function halt() {
  presented = `halt:${(turnSeq += 1)}`;
  if (busy.value) {
    busy.value = false;
    failed.value = '先停下了，点重试接着来';
  }
  const id = props.chatId;
  if (!id || !chat.streams[id]) return;
  chat.stop(id);
  for (let i = 0; i < 40 && chat.streams[id]; i += 1) await sleep(50);
}
defineExpose({ halt });
onBeforeUnmount(() => void halt());
</script>

<template>
  <div class="imm" data-testid="sleep-immersion">
    <div class="shade bottom" aria-hidden="true" />

    <!-- 左上：在哪、几点、第几段，和没接通的提示 -->
    <div v-if="phase === 'play'" class="info-col">
      <button type="button" class="info-card" aria-label="换一个地方" @click="changePlace">
        <span :class="place.icon" class="shrink-0 text-accent-ink" />
        <span class="truncate">{{ place.name }}</span>
        <span class="dot" /><span class="shrink-0">{{ hhmm(Date.now()) }}</span>
        <template v-if="turns"><span class="dot" /><span class="shrink-0">第 {{ turns }} 段</span></template>
        <span class="i-lucide-repeat-2 shrink-0 text-ink-3" />
      </button>
      <div v-if="notConnected" class="mini-notice">
        <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
        <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
      </div>
    </div>

    <!-- 挑地方 -->
    <div v-if="phase === 'pick'" class="bottom">
      <section class="picker" data-testid="sleep-scene-picker">
        <div class="text-[15px] font-600">今晚在哪儿睡？</div>
        <div class="grid grid-cols-2 gap-2 mt-2.5">
          <button v-for="p in PRESETS" :key="p.id" type="button" class="spot press" :class="{ on: place.id === p.id }" :data-scene="p.id" @click="choose(p)">
            <img :src="coverUrl(p.family)" alt="" loading="lazy" decoding="async" />
            <span class="spot-name"><span :class="p.icon" />{{ p.name }}</span>
          </button>
        </div>
        <div class="flex gap-2 mt-2">
          <button type="button" class="opt press" data-testid="sleep-scene-random" @click="pickRandom"><span class="i-lucide-dices" />随机一个</button>
          <button type="button" class="opt press" :class="{ on: !isPreset }" data-testid="sleep-scene-library" @click="libraryOpen = true"><span class="i-lucide-images" />从背景里选</button>
        </div>
        <!-- 这个地方的每一张图：自动，或者固定用某一张 -->
        <div class="shots no-scrollbar" role="group" :aria-label="`${place.name}用哪一张图`" data-testid="sleep-scene-shots">
          <button type="button" class="shot auto" :class="{ on: !place.asset }" :aria-pressed="!place.asset" @click="setAsset(null)">
            <span class="i-lucide-moon-star text-[16px]" /><span>自动</span>
          </button>
          <button
            v-for="a in place.family.assets"
            :key="a.id"
            type="button"
            class="shot"
            :class="{ on: place.asset?.id === a.id }"
            :aria-pressed="place.asset?.id === a.id"
            :aria-label="`用这一张：${shotLabel(a)}`"
            :data-shot="a.id"
            @click="setAsset(a)"
          >
            <img :src="backgroundUrl(a)" alt="" loading="lazy" decoding="async" />
            <span class="shot-tag">{{ shotLabel(a) }}</span>
          </button>
        </div>
        <p class="text-[12.5px] text-ink-2 mt-2 mb-0">
          <b class="font-600">{{ place.name }}</b> · {{ place.blurb }}
          <span class="text-ink-3">（{{ place.asset ? `固定用选的这一张：${shotLabel(place.asset)}` : '自动按夜里的时段挑图，也可以在上面点一张固定下来' }}）</span>
        </p>
        <van-button type="primary" round block class="!mt-3" data-testid="sleep-scene-start" @click="start">和{{ character.name }}去{{ place.name }}</van-button>
      </section>
      <div class="bar"><slot name="dock" /></div>
    </div>

    <!-- 沉浸画面：选项 + 对话框 -->
    <div v-else class="bottom">
      <div v-if="showChoices" class="choices" data-testid="sleep-scene-choices">
        <template v-if="!ownOpen">
          <button v-for="c in choices" :key="c" type="button" class="choice press" @click="pick(c)">{{ c }}</button>
          <p v-if="!choices.length" class="no-choice">{{ character.pronoun }}这段没给选项，自己说一句吧</p>
        </template>
        <form v-else class="own" @submit.prevent="sendOwn">
          <input ref="ownInput" v-model="own" class="own-input" maxlength="200" :placeholder="`小声跟${character.pronoun}说…`" enterkeyhint="send" aria-label="自己说" />
          <button type="submit" class="own-send" :disabled="!own.trim()" aria-label="说出去"><span class="i-lucide-send-horizontal" /></button>
        </form>
      </div>
      <div v-else-if="showFinale" class="choices">
        <button type="button" class="choice finale press" data-testid="sleep-scene-night" @click="emit('night')"><span class="i-lucide-moon-star" />晚安</button>
      </div>

      <div class="box" :class="beat?.kind ?? 'line'" role="button" tabindex="0" :aria-label="atLast ? '对话' : '下一句'" data-testid="sleep-scene-box" @click="advance" @keydown.enter.prevent="advance" @keydown.space.prevent="advance">
        <span v-if="!beat || beat.kind === 'line'" class="name"><span class="i-lucide-moon text-[11px]" />{{ character.name }}</span>
        <p v-if="failed && !busy" class="text error">没说出来：{{ failed }}</p>
        <p v-else-if="!beat" class="text">
          <span class="inline-flex gap-1 text-accent-ink"><span class="typing-dot" /><span class="typing-dot" /><span class="typing-dot" /></span>
        </p>
        <p v-else class="text" :class="{ 'stream-caret': streamingHere }">{{ beat.text }}</p>
        <span v-if="!atLast" class="next" aria-hidden="true"><span class="i-lucide-chevron-down" /></span>
      </div>

      <div class="bar">
        <slot name="dock" />
        <span class="flex-1" />
        <button v-if="failed && !busy" type="button" class="bar-btn on" @click="retry"><span class="i-lucide-rotate-ccw" />重试</button>
        <button v-else-if="showChoices" type="button" class="bar-btn" :class="{ on: ownOpen || !choices.length }" data-testid="sleep-scene-own" @click="toggleOwn">
          <span :class="ownOpen ? 'i-lucide-list' : 'i-lucide-pencil-line'" />{{ ownOpen ? '选一个' : '自己说' }}
        </button>
        <button type="button" class="bar-btn icon" :class="{ on: auto }" :aria-pressed="auto" :aria-label="auto ? '自动翻到下一句：开' : '自动翻到下一句：关'" @click="auto = !auto">
          <span :class="auto ? 'i-lucide-circle-play' : 'i-lucide-pointer'" />
        </button>
        <button v-if="!ending" type="button" class="bar-btn end" data-testid="sleep-scene-finish" @click="finish"><span class="i-lucide-moon-star" />睡了</button>
      </div>
    </div>

    <!-- 从背景素材库里选一个系列 -->
    <van-popup v-model:show="libraryOpen" position="bottom" round :style="{ height: '72%' }">
      <div class="lib">
        <div class="lib-head">
          <span class="text-[15px] font-600">从背景里选</span>
          <select v-model="group" class="lib-group" aria-label="场景分类">
            <option value="">全部分类</option>
            <option v-for="g in BACKGROUND_GROUPS" :key="g" :value="g">{{ g }}</option>
          </select>
        </div>
        <div class="lib-scroll">
          <div class="lib-grid">
            <button v-for="f in libraryList" :key="f.id" type="button" class="lib-item" :class="{ on: place.family.id === f.id }" @click="pickFamily(f)">
              <img :src="coverUrl(f)" alt="" loading="lazy" decoding="async" />
              <span class="lib-name">{{ f.style || f.scene }}</span>
              <span class="lib-scene">{{ f.scene }}</span>
            </button>
          </div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.imm {
  position: absolute;
  inset: 0;
  overflow: hidden;
}
.shade.bottom {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 320px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.5), transparent);
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
.mini-notice {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 12px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1.4;
}

.bottom {
  position: absolute;
  z-index: 10;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 10px calc(var(--safe-bottom) + 10px);
}
/* 最下面一排：左边是白噪音和音乐，右边是这一刻能做的事；浮出来的面板按这一排定位 */
.bar {
  position: relative;
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 38px;
}
.bar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 38px;
  height: 38px;
  padding: 0 12px;
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

/* —— 挑地方 —— */
.picker {
  /* 小屏上放不下时自己滚，不把顶栏顶出去 */
  max-height: calc(100vh - var(--safe-top) - var(--safe-bottom) - 130px);
  overflow-y: auto;
  padding: 14px;
  border-radius: 22px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  animation: rise 0.3s var(--ease) both;
}
.spot {
  position: relative;
  aspect-ratio: 16 / 9;
  border-radius: 14px;
  overflow: hidden;
  background: var(--panel);
  outline: 2px solid transparent;
  outline-offset: -2px;
}
.spot.on {
  outline-color: var(--accent);
}
.spot img,
.lib-item img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.spot-name {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 14px 9px 6px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
}
.opt {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 38px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13.5px;
}
.opt.on {
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}

/* 一个地方的每一张图：横着划 */
.shots {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
}
.shot {
  position: relative;
  flex-shrink: 0;
  width: 78px;
  height: 50px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
  outline: 2px solid transparent;
  outline-offset: -2px;
}
.shot.on {
  outline-color: var(--accent);
}
.shot img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.shot.auto {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  width: 54px;
  color: var(--ink-2);
  font-size: 11.5px;
}
.shot.auto.on {
  color: var(--accent-ink);
}
.shot-tag {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 8px 4px 2px;
  background: linear-gradient(to top, rgba(0, 0, 0, 0.7), transparent);
  color: #fff;
  font-size: 10px;
  line-height: 1.2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* —— 对话框和选项 —— */
.choices {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.choice {
  width: 100%;
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  color: var(--ink);
  font-size: 14.5px;
  line-height: 1.45;
  text-align: left;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  animation: rise 0.28s var(--ease) both;
}
.choice:nth-child(2) {
  animation-delay: 40ms;
}
.choice:nth-child(3) {
  animation-delay: 80ms;
}
.choice.finale {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-color: var(--accent-line);
  color: var(--accent-ink);
  font-weight: 600;
}
.no-choice {
  margin: 0;
  padding: 8px 12px;
  border-radius: 14px;
  background: var(--glass);
  color: var(--ink-2);
  font-size: 13px;
  text-align: center;
}
.own {
  display: flex;
  gap: 8px;
}
.own-input {
  flex: 1;
  min-width: 0;
  height: 44px;
  padding: 0 16px;
  border-radius: 22px;
  border: 1px solid var(--accent-line);
  background: var(--glass-strong);
  color: var(--ink);
  outline: none;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.own-send {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
}
.own-send:disabled {
  opacity: 0.5;
}
.box {
  position: relative;
  padding: 14px 16px 12px;
  border-radius: 22px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  cursor: pointer;
  user-select: none;
}
.box .name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 4px;
  color: var(--accent-ink);
  font-weight: 600;
  font-size: 14px;
}
.box .text {
  margin: 0;
  min-height: 3.3em;
  max-height: 30vh;
  overflow-y: auto;
  font-size: 16px;
  line-height: 1.65;
  letter-spacing: 0.02em;
  white-space: pre-wrap;
  word-break: break-word;
}
.box.narration .text {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--ink-2);
  font-size: 15px;
  font-style: italic;
  text-align: center;
}
.box .text.error {
  color: var(--bad);
  font-size: 14px;
}
.next {
  position: absolute;
  right: 14px;
  bottom: 8px;
  color: var(--accent-ink);
  animation: bob 1.2s ease-in-out infinite;
}
@keyframes bob {
  50% {
    transform: translateY(3px);
  }
}

/* —— 素材库 —— */
.lib {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 14px 14px 0;
}
.lib-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}
.lib-group {
  height: 32px;
  padding: 0 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--ink);
  font-size: 16px;
}
.lib-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
/* 网格自己不定高：定了高的网格会把每一行压扁去凑高度 */
.lib-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  padding-bottom: calc(var(--safe-bottom) + 14px);
}
.lib-item {
  position: relative;
  aspect-ratio: 16 / 10;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
  outline: 2px solid transparent;
  outline-offset: -2px;
  text-align: left;
}
.lib-item.on {
  outline-color: var(--accent);
}
.lib-name,
.lib-scene {
  position: absolute;
  left: 8px;
  right: 8px;
  color: #fff;
  text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.lib-name {
  bottom: 18px;
  font-size: 12.5px;
  font-weight: 600;
}
.lib-scene {
  bottom: 5px;
  font-size: 10.5px;
  opacity: 0.85;
}
</style>
