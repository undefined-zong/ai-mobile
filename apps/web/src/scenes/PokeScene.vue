<script setup lang="ts">
import { splitSentences } from '@app/ai';
import { isPokePreset, pokeHow, pokeLine, POKE_HOWS, POKE_LEVEL, presetLevels, type PokeHotspot, type PokeHow, type PokePart, type PresetUseId } from '@app/shared';
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import SceneShell from '@/components/scene/SceneShell.vue';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import { services } from '@/services';
import { ttsLiveFor } from '@/services/ai';
import { pokeMusic } from '@/services/musicPlayer';
import { pokeSearches } from '@/services/playlistSearches';
import { personaOf } from '@/services/prompt';
import { SentenceStream, SpeechQueue } from '@/services/speech';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useLibraryStore } from '@/stores/library';

/**
 * 戳戳乐（设计文档 §9.7）：用手戳、用嘴亲、蹭一蹭；点一下是一下，长按是久一点（摸着 / 亲着 / 蹭着不放）。
 * 画面上只有底下的三个碰法；顶栏右边是预设（预设、尺度、热区都在那一张里选），下面竖着排音乐、朗读。
 * - 碰到的那一下：立刻换表情、震动、冒个小图标，好感照常 +1（长按 +2，这里不显示）；
 * - 连着碰的几下合成一次（停手 0.8 秒，或者等她说完上一句）：先在聊天里记一条"你亲了亲她的脸，连着 3 下"，再让她回应。
 *   用"戳戳乐"这个用途的功能预设，三种碰法各是一个场景任务（poke-hand / poke-mouth / poke-rub），程序只填这一次碰了哪里、怎么碰、几下；
 *   「陪伴 · 快速」的模型，她写的 [expr:] / [pose:] 换成她自己的立绘；
 * - 尺度也在预设里：触发条件写了 poke-level:名字 的块（POKE_LEVEL），按块的顺序列出来，选了哪个就只发那一块；
 * - "身子"那块没有具体的部位，当作在她身上乱碰：有三成的可能碰到不该碰的地方（照 SleepTogether 的乱摸），怎么反应看尺度；
 * - 音乐：网易云的歌单（components/scene/PlaylistMusic.vue，播放器是 pokeMusic），自带的几个歌单能自己增删；她出声时压低；
 * - 朗读：开着时她的回复边生成边按句合成语音（语音合成的 API + 这个角色的音色），说完上一句才接着回应下一批；
 *   语音合成没接通、还没选音色时不打开，写明原因；
 * - 被碰多少下她都不会烦、不会生气。离开时那一段写"戳了 3 下、亲了 2 下"。
 */
const USE: PresetUseId = 'scene:poke';
/** 停手多久把攒着的这几下给她 */
const GATHER_MS = 800;
/** 在身上乱碰时碰到不该碰的地方的可能 */
const SENSITIVE_CHANCE = 0.3;
/** 没有具体部位、当作在身上乱碰的热区 */
const LOOSE_PARTS = new Set(['body']);
/** 上次选的碰法、尺度、开没开朗读（只记在这台设备上，下次进来接着用） */
const HOW_KEY = 'ai-mobile:poke-how';
const LEVEL_KEY = 'ai-mobile:poke-level';
const READ_KEY = 'ai-mobile:poke-read';
/** 长按时冒出来的图标（点一下用碰法自己的图标） */
const LONG_ICON: Record<PokeHow, string> = { hand: 'i-lucide-hand-heart', mouth: 'i-lucide-heart', rub: 'i-lucide-cat' };

interface Touch {
  label: string;
  part: string;
  how: PokeHow;
  hold: boolean;
  sensitive: boolean;
}

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const ai = useAiStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

function load(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 浏览器不让存：这次照样用，下次回到默认的
  }
}

// —— 怎么碰（底下的三个按钮） ——
const how = ref<PokeHow>(pokeHow(load(HOW_KEY))?.id ?? 'hand');
const howDef = computed(() => pokeHow(how.value) ?? POKE_HOWS[0]!);
const pokeAs = computed(() => ({ verb: howDef.value.verb, tap: howDef.value.icon, long: LONG_ICON[how.value] }));
function pickHow(id: PokeHow) {
  how.value = id;
  save(HOW_KEY, id);
}

// —— 预设和尺度（右上角的预设里选） ——
const settingsOpen = ref(false);
const preset = computed(() => lib.presetForUse(USE, her.value));
/** 选的预设里有没有戳戳乐的块（跟随对话预设、换成别的功能预设时没有：她照样回应，只是不分怎么碰、没有尺度） */
const presetReady = computed(() => isPokePreset(preset.value));
const pokeFirst = (p: { name: string }) => p.name.includes('戳戳乐');
/** 预设里的尺度，说明就是那一块的内容（开头的【…】标题不重复显示） */
const levels = computed(() =>
  presetLevels(preset.value, POKE_LEVEL).map(({ name, block }) => ({
    name,
    desc: block.content.replaceAll('{{user}}', userName.value).replaceAll('{{char}}', her.value.name).replace(/^【[^】]*】\s*/, '').trim(),
  })),
);
const picked = ref(load(LEVEL_KEY));
/** 选中的尺度：上次选的还在预设里就用它，不然用预设里的第一个；预设里没有尺度时为空。改了下一次回应就照新的 */
const level = computed(() => levels.value.find((l) => l.name === picked.value)?.name ?? levels.value[0]?.name ?? '');
function pickLevel(name: string) {
  picked.value = name;
  save(LEVEL_KEY, name);
}
const showZones = ref(false);

// —— 音乐：网易云的歌单（右上角） ——
const musicOpen = ref(false);
const musicPlaying = computed(() => pokeMusic.state.playing && !pokeMusic.state.fading);

// —— 朗读：开着时她的回复用她的声音读出来（右上角） ——
const reading = ref(load(READ_KEY) === '1');
const voiceError = ref('');
const noVoice = () => `没有声音：语音合成还没接通，或者还没给${her.value.name}选音色`;
let speech: SpeechQueue | null = null;
function newSpeech(): SpeechQueue {
  speech?.stop();
  const q = new SpeechQueue({ characterId: her.value.id, onError: (msg) => (voiceError.value = msg) });
  // 开着朗读时语音合成断了（换了 API、删了音色）：照样按字数停顿，写明原因
  if (!q.live) voiceError.value = noVoice();
  speech = q;
  pokeMusic.duck(true);
  void q.drained().then(() => {
    if (speech === q) pokeMusic.duck(false);
  });
  return q;
}
function stopSpeech() {
  speech?.stop();
  speech = null;
  pokeMusic.duck(false);
}
function toggleRead() {
  if (reading.value) {
    reading.value = false;
    voiceError.value = '';
    save(READ_KEY, '');
    stopSpeech();
    return;
  }
  if (!ttsLiveFor(her.value)) {
    voiceError.value = noVoice();
    return;
  }
  voiceError.value = '';
  reading.value = true;
  save(READ_KEY, '1');
  // 打开时她刚说完的那句先读一遍；她正在写的那句不读，从下一句读起
  if (line.value && !busy.value) {
    const q = newSpeech();
    q.pushAll(splitSentences(line.value));
    q.end();
  }
}

// —— 碰她 ——
const total = ref(0);
const byHow = ref<Partial<Record<PokeHow, number>>>({});
/** 攒着还没给她的几下 */
const pending: Touch[] = [];
const gathering = ref(0);
const busy = ref(false);
const line = ref('');
const notConnected = ref('');
const failed = ref('');
/** 上一次让她回应的请求（没回上来时重试用；碰的那几下已经记进聊天了） */
let lastAsk: { task: string; input: string; flags: string[] } | null = null;
let gatherTimer: ReturnType<typeof setTimeout> | undefined;
let alive = true;

/** 碰到的那一下先换的表情（程序说的情绪，按名字对到她自己的表情上）；她开口以后按她写的 [expr:] 换 */
function firstLook(h: PokeHotspot, t: Touch): string {
  if (t.sensitive) return 'surprised';
  if (t.how === 'mouth') return t.hold ? 'blush' : 'shy';
  if (t.how === 'rub') return t.hold ? 'laugh' : 'smile';
  return (t.hold && h.longPress ? h.longPress : h.tap).expression;
}

function poke(h: PokeHotspot, kind: 'tap' | 'long') {
  const t: Touch = { label: h.label, part: h.part, how: how.value, hold: kind === 'long', sensitive: LOOSE_PARTS.has(h.part) && Math.random() < SENSITIVE_CHANCE };
  services.native.vibrate(t.hold ? [12, 40, 12] : 14);
  chars.setExpression(her.value.id, firstLook(h, t));
  chars.bumpAffection(her.value.id, t.hold ? 2 : 1);
  total.value += 1;
  byHow.value[t.how] = (byHow.value[t.how] ?? 0) + 1;
  pending.push(t);
  gathering.value = pending.length;
  later();
}

function later() {
  clearTimeout(gatherTimer);
  gatherTimer = setTimeout(() => void send(), GATHER_MS);
}

/** 同样碰法、同一个地方的几下合成一条："你亲了亲她的脸，连着 3 下" */
function group(batch: Touch[]): PokePart[] {
  const out: PokePart[] = [];
  for (const t of batch) {
    const same = out.find((p) => p.target === t.label && p.how === t.how && !!p.hold === t.hold && !!p.sensitive === t.sensitive);
    if (same) same.times = (same.times ?? 1) + 1;
    else out.push({ type: 'poke', actor: 'user', target: t.label, how: t.how, ...(t.hold ? { hold: true } : {}), ...(t.sensitive ? { sensitive: true } : {}) });
  }
  return out;
}

const togetherLine = computed(() => {
  const mode = chat.chatById(chatId.value)?.togetherMode;
  if (mode === 'remote') return `连线（${userName.value}在自己那边，隔着屏幕逗你）`;
  if (mode === 'bring') return `你在${userName.value}那边，就在${userName.value}身边`;
  return `${userName.value}来你这边了，就在你身边`;
});

/** 这一次的输入，只放数据：怎么在一起、碰了哪里、怎么碰、几下、在放什么歌。她怎么回应、尺度写在预设的块里 */
function pokeInput(batch: Touch[], parts: PokePart[]): string {
  const you = userName.value;
  const loose = [...new Set(batch.filter((t) => LOOSE_PARTS.has(t.part)).map((t) => t.label))];
  const song = pokeMusic.state.playing ? pokeMusic.current() : null;
  return [
    `你们怎么在一起：${togetherLine.value}`,
    song ? `在放的歌：《${song.title}》- ${song.artist}${pokeMusic.state.demo ? '（示例歌曲）' : ''}` : '',
    `${you}这一次：\n${parts.map((p) => `- ${pokeLine(p, you, her.value.name)}`).join('\n')}`,
    loose.length ? `碰在"${loose.join('、')}"上的是没碰在具体的地方，在你身上乱碰` : '',
    `今天在戳戳乐里一共被碰了 ${total.value} 下`,
  ]
    .filter(Boolean)
    .join('\n');
}

/** 把攒着的这几下给她：先记进聊天，再让她回应；她还在写、还在读上一句时等她说完 */
async function send() {
  if (!alive || busy.value || !pending.length || !chatId.value) return;
  const status = ai.status('companion');
  if (!status.live) {
    pending.length = 0;
    gathering.value = 0;
    notConnected.value = `「陪伴 · 快速」还没接通：${status.reason}`;
    return;
  }
  // 聊天那边还在写别的回复、她还在读上一句：过一会儿再给她
  if (chat.streams[chatId.value] || speech?.busy) return later();
  const batch = pending.splice(0);
  gathering.value = 0;
  const parts = group(batch);
  chat.push(chatId.value, 'user', parts, { meta: { scene: 'poke' } });
  // 这一次最后那下的碰法是场景任务；中途换过碰法的，前面那几种的块也一起打开
  const tasks = [...new Set(batch.map((t) => pokeHow(t.how)?.task).filter((x): x is string => !!x))];
  const task = tasks.at(-1) ?? howDef.value.task;
  await ask({ task, input: pokeInput(batch, parts), flags: tasks.filter((x) => x !== task) });
  // 她说话的时候你又碰了的：接着给她
  if (alive && pending.length) later();
}

async function ask(req: { task: string; input: string; flags: string[] }) {
  lastAsk = req;
  busy.value = true;
  failed.value = '';
  line.value = '';
  // 开着朗读：边写边按句读
  const q = reading.value ? newSpeech() : null;
  const sentences = new SentenceStream();
  try {
    const r = await chat.sceneReply(chatId.value, {
      task: req.task,
      input: req.input,
      use: USE,
      // 尺度在回应时才定：改了尺度，下一次回应就照新的
      flags: [...req.flags, ...(level.value ? [`${POKE_LEVEL}${level.value}`] : [])],
      onText: (t) => {
        if (!alive) return;
        line.value = t;
        if (q && !q.stopped) q.pushAll(sentences.feed(t));
      },
    });
    if (!alive) return;
    if (r.ok) {
      notConnected.value = '';
      lastAsk = null;
      line.value = r.message.text;
      if (q && !q.stopped) {
        q.pushAll(sentences.flush(r.message.text));
        q.end();
      }
    } else {
      q?.stop();
      if (r.notConnected) notConnected.value = r.reason;
      else failed.value = r.reason;
    }
  } finally {
    busy.value = false;
  }
}

async function retry() {
  if (!lastAsk || busy.value) return;
  await ask(lastAsk);
  if (alive && pending.length) later();
}

const shown = computed(() => line.value || (busy.value ? '' : '戳戳看？……我才没有在期待。'));

/** 离开时那一段的总结："戳了 3 下、亲了 2 下" */
function leaveNote(): string | undefined {
  const bits = POKE_HOWS.filter((h) => byHow.value[h.id]).map((h) => `${h.verb}了 ${byHow.value[h.id]} 下`);
  return bits.length ? bits.join('、') : undefined;
}

onMounted(() => chat.setLeaveSummary(her.value.id, leaveNote));
onBeforeUnmount(() => {
  alive = false;
  clearTimeout(gatherTimer);
  chat.setLeaveSummary(her.value.id, null);
  stopSpeech();
  pokeMusic.stop();
});
</script>

<template>
  <SceneShell
    class="poke-shell"
    scene-id="poke"
    :line="shown"
    :typing="busy && !line"
    pokeable
    :show-hotspots="showZones"
    :poke-as="pokeAs"
    :layout="{ left: 50, bottom: 14, height: 76 }"
    @poke="poke"
  >
    <template #actions>
      <button type="button" class="tool" aria-haspopup="dialog" :aria-label="`预设和尺度：${preset?.name ?? '没有功能预设'}${level ? ` · ${level}` : ''}`" data-testid="poke-settings" @click="settingsOpen = true">
        <span class="i-lucide-sliders-horizontal" />
      </button>
    </template>
    <template #overlay>
      <div v-if="gathering > 1" class="combo num">{{ howDef.verb }} ×{{ gathering }}</div>
      <!-- 右上角：音乐、朗读，竖着排在顶栏下面 -->
      <div class="side-tools">
        <button
          type="button"
          class="tool"
          :class="{ on: musicPlaying }"
          :aria-expanded="musicOpen"
          :aria-label="musicPlaying ? `音乐：${pokeMusic.current()?.title ?? '正在播放'}` : '音乐'"
          data-testid="poke-music-btn"
          @click="musicOpen = !musicOpen"
        >
          <span :class="pokeMusic.state.loading ? 'i-lucide-loader-circle spin' : musicPlaying ? 'i-lucide-disc-3 spin-slow' : 'i-lucide-music'" />
        </button>
        <button
          type="button"
          class="tool"
          :class="{ on: reading }"
          :aria-pressed="reading"
          :aria-label="reading ? `朗读：开，${her.pronoun}的回复会读出来（点一下关掉）` : `朗读：关（点一下打开，${her.pronoun}的回复用${her.pronoun}的声音读出来）`"
          data-testid="poke-read"
          @click="toggleRead"
        >
          <span :class="reading ? 'i-lucide-volume-2' : 'i-lucide-volume-x'" />
        </button>
      </div>
      <!-- 音乐：在竖排按钮的左边展开，点空白处收起 -->
      <template v-if="musicOpen">
        <div class="pop-catcher" @click="musicOpen = false" />
        <div class="music-pop" role="dialog" aria-label="音乐">
          <PlaylistMusic :player="pokeMusic" :searches="pokeSearches" test-id="poke-music" />
        </div>
      </template>
    </template>

    <div v-if="notConnected" class="mini-notice" data-testid="poke-not-connected">
      <span class="i-lucide-plug-zap shrink-0" /><span class="flex-1 min-w-0">{{ notConnected }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/api?feature=companion')">去设置</button>
    </div>
    <div v-else-if="failed" class="mini-notice">
      <span class="i-lucide-circle-alert shrink-0" /><span class="flex-1 min-w-0">{{ her.pronoun }}没回上来：{{ failed }}</span>
      <button type="button" class="text-accent-ink shrink-0" :disabled="busy" @click="retry">重试</button>
    </div>
    <div v-if="voiceError" class="mini-notice" data-testid="poke-voice-error">
      <span class="i-lucide-volume-x shrink-0" /><span class="flex-1 min-w-0">{{ voiceError }}</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/voice')">去设置</button>
    </div>

    <!-- 怎么碰 -->
    <div class="hows" role="radiogroup" aria-label="怎么碰">
      <button
        v-for="h in POKE_HOWS"
        :key="h.id"
        type="button"
        role="radio"
        class="how press"
        :class="{ on: how === h.id }"
        :aria-checked="how === h.id"
        :data-how="h.id"
        @click="pickHow(h.id)"
      >
        <span :class="h.icon" class="text-[18px]" />{{ h.label }}
      </button>
    </div>

    <!-- 预设、尺度、热区：右上角点开。放到 body 下：场景面板有 backdrop-filter，弹层留在里面会被关在面板里 -->
    <van-popup v-model:show="settingsOpen" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
      <div class="p-4" data-testid="poke-settings-sheet">
        <div class="text-[15px] font-600">戳戳乐的预设和尺度</div>
        <p class="text-[12.5px] text-ink-3 mt-1 mb-0 leading-relaxed">
          底下选怎么碰，点一下是一下，长按是久一点（摸着、亲着、蹭着不放）；连着碰的几下合成一次，{{ her.pronoun }}每次都会回应，碰多少下都不会烦。
        </p>

        <div class="label">尺度</div>
        <div v-if="levels.length" class="grid gap-2" role="radiogroup" aria-label="尺度">
          <button
            v-for="l in levels"
            :key="l.name"
            type="button"
            role="radio"
            class="level"
            :class="{ on: level === l.name }"
            :aria-checked="level === l.name"
            :data-level="l.name"
            @click="pickLevel(l.name)"
          >
            <span class="dot"><span v-if="level === l.name" class="i-lucide-check" /></span>
            <span class="flex-1 min-w-0">
              <span class="block text-[14px] font-600">{{ l.name }}</span>
              <span class="level-desc">{{ l.desc }}</span>
            </span>
          </button>
        </div>
        <p v-else-if="presetReady" class="warn">这个预设里没有尺度：在预设里给一块填上"戳戳乐的尺度"，这里就能选。</p>
        <p v-else class="warn">这个预设里没有戳戳乐的块：{{ her.pronoun }}照样会回应，但不分用手、用嘴、蹭蹭，也没有尺度；换成"戳戳乐"或者从它复制一份。</p>

        <div class="label">预设</div>
        <p class="text-[12px] text-ink-3 mt-0 mb-2 leading-relaxed">
          用手、用嘴、蹭蹭各是一块，{{ her.pronoun }}怎么回应照那一块（「陪伴 · 快速」的模型）。尺度也是预设里的块：填了"戳戳乐的尺度"的那几块按顺序列在上面，改内容就改了这个尺度能到哪一步，加一块就多一个尺度。
        </p>
        <PresetPicker :model-value="lib.useChoice(USE)" category="feature" follow :first="pokeFirst" @update:model-value="(id) => lib.setUse(USE, id)" />

        <div class="label">热区</div>
        <label class="zone-row">
          <span class="flex-1 min-w-0">在{{ her.pronoun }}身上标出能碰的地方</span>
          <van-switch v-model="showZones" size="20px" />
        </label>
        <p class="text-[12px] text-ink-3 mt-1.5 mb-0">
          热区在 <RouterLink :to="`/me/characters/${her.id}?tab=sprite`" class="text-accent-ink" @click="settingsOpen = false">角色 → 立绘</RouterLink> 里调。
        </p>
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
.combo {
  position: absolute;
  z-index: 9;
  top: 30%;
  right: 10%;
  font-size: 20px;
  font-weight: 800;
  color: var(--accent-ink);
  transform: rotate(-10deg);
  text-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
}
/* 她的那句话给右上角竖排的按钮让出位置（按钮宽 38，两边各留 10） */
.poke-shell {
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
.music-pop {
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
.hows {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
}
.how {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 46px;
  border-radius: 14px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 14.5px;
}
.how.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
  font-weight: 600;
}
.label {
  margin: 16px 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-3);
}
.level {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  text-align: left;
}
.level.on {
  background: var(--accent-soft);
  outline: 1px solid var(--accent-line);
}
.dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  margin-top: 1px;
  border-radius: 99px;
  border: 1.5px solid var(--ink-3);
  font-size: 12px;
}
.level.on .dot {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--on-accent);
}
.level-desc {
  display: -webkit-box;
  margin-top: 2px;
  overflow: hidden;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-3);
}
.zone-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--panel);
  font-size: 13.5px;
}
.warn {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--warn);
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
</style>
