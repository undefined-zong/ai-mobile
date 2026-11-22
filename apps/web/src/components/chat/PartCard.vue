<script setup lang="ts">
import { characterPronoun } from '@app/shared';
import { previewImages } from '@/services/imageViewer';
import { shotViewerImages } from '@/services/redraw';
import { getScene, inviteGameLabel, pokeHow, pokeLine, restActivity, type Character, type MessagePart, type VideoHit } from '@app/shared';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import { showToast } from 'vant';
import { assetUrl } from '@/services/assets';
import AssetImg from '@/components/common/AssetImg.vue';
import { useChatStore } from '@/stores/chat';
import { useToyStore } from '@/stores/toys';
import { searchBili } from '@/services/bilibili';
import { parseVideoLink, PLATFORM_LABEL } from '@/utils/videoLink';
import GenImage from '@/components/figure/GenImage.vue';
import RichText from '@/components/common/RichText.vue';
import { clock } from '@/utils/time';

/** 消息里各种"卡片"的渲染（文字以外的 part） */
const props = defineProps<{ part: MessagePart; character: Character; mine: boolean }>();
const emit = defineEmits<{ (e: 'open-music', part: MessagePart): void; (e: 'answer-date', ok: boolean): void; (e: 'open-image'): void }>();

const showTranscript = ref(false);
const chatStore = useChatStore();
/** 照片：识图正在看 / 看到了 / 没看成 */
const photoState = computed<'looking' | 'seen' | 'failed' | 'idle'>(() => {
  const p = props.part;
  if (p.type !== 'image' || !p.photo) return 'idle';
  if (p.seen) return 'seen';
  if (p.assetKey && chatStore.lookingKeys.has(p.assetKey)) return 'looking';
  return p.seenError ? 'failed' : 'idle';
});
const playing = ref(false);
const MEAL: Record<string, string> = { breakfast: '早饭', lunch: '午饭', dinner: '晚饭', snack: '加餐' };

/** 配图卡片右下角：画到哪一步；画好的写实际出图的模型，没有真图的（演示聊天里的）写"示意图" */
const imageState = computed<'error' | 'drawing' | 'done' | 'placeholder'>(() => {
  const p = props.part;
  if (p.type !== 'image' || p.error) return 'error';
  if (!p.generated) return 'drawing';
  return p.assetKey ? 'done' : 'placeholder';
});
const imageLabel = computed(() => {
  const p = props.part;
  if (p.type !== 'image') return '';
  return { error: '点开重画', drawing: '生成中', done: p.model || '已生成', placeholder: '示意图' }[imageState.value];
});

const bars = computed(() => {
  if (props.part.type !== 'voice') return [];
  const n = Math.min(18, Math.max(6, Math.round(props.part.durationMs / 600)));
  return Array.from({ length: n }, (_, i) => 30 + ((i * 37) % 60));
});

/** 装修小屋的照片：点开看大图 */
async function previewPhoto() {
  const p = props.part;
  if (p.type !== 'game' || p.game !== 'decor' || !p.photo) return;
  const url = await assetUrl(p.photo);
  if (url) previewImages([url]);
  else showToast('本机找不到这张照片了');
}

/** 创意工坊给她看的画：点开看大图 */
async function previewWork() {
  const p = props.part;
  if (p.type !== 'game' || p.game !== 'workshop' || !p.photo) return;
  const url = await assetUrl(p.photo);
  if (url) previewImages([url]);
  else showToast('本机找不到这张画了');
}

/** 饭卡里你拍的饭照：点开看大图 */
async function previewMealPhoto() {
  const p = props.part;
  if (p.type !== 'meal' || !p.photo) return;
  const url = await assetUrl(p.photo);
  if (url) previewImages([url]);
  else showToast('本机找不到这张照片了');
}
const WAY: Record<string, string> = { cook: '自己做', buy: '去买', bento: '带便当' };
/** 饭卡上"怎么吃的"：共同吃饭 / 各吃各的，按计划怎么来的 */
const mealHow = computed(() => {
  const p = props.part;
  if (p.type !== 'meal' || !p.how) return '';
  if (p.how === 'solo') return '各吃各的';
  return p.plan ? `共同吃饭 · 按计划${WAY[p.plan.way] ?? ''}` : '共同吃饭';
});

/** 约会回忆：每种回法选了几次 */
const datePicks = computed(() => {
  const p = props.part;
  if (p.type !== 'date' || !p.picks) return '';
  return Object.entries(p.picks)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
});

/** 学习卡片、饭卡、约会回忆里这次画的图：点一张从它开始翻 */
async function previewShots(start: number) {
  const p = props.part;
  if ((p.type !== 'study' && p.type !== 'meal' && p.type !== 'date') || !p.images?.length) return;
  // 图库里还有的那几张能重新生成（重画后卡片跟着换）
  const { images, start: at } = await shotViewerImages(p.images, Math.min(start, p.images.length - 1), { characterId: props.character.id, scene: p.type });
  if (images.length) previewImages(images, { startPosition: at });
  else showToast('本机找不到这几张图了');
}

let audio: HTMLAudioElement | null = null;
let playback = 0;
function stopVoice() {
  playback += 1;
  audio?.pause();
  audio = null;
  playing.value = false;
}
onBeforeUnmount(stopVoice);

async function playVoice() {
  if (playing.value) return stopVoice();
  if (props.part.type !== 'voice' || !props.part.assetKey) {
    showToast('这条语音没有录音文件');
    return;
  }
  const current = ++playback;
  playing.value = true;
  try {
    const url = await assetUrl(props.part.assetKey);
    if (current !== playback) return;
    if (!url) throw new Error('找不到这条语音的录音文件');
    audio = new Audio(url);
    audio.onended = stopVoice;
    audio.onerror = () => { stopVoice(); showToast('无法播放这条录音'); };
    await audio.play();
  } catch (e) {
    if (current !== playback) return;
    stopVoice();
    showToast(e instanceof Error ? e.message : '无法播放这条录音');
  }
}

const router = useRouter();
const toys = useToyStore();
const chatIdOf = () => chatStore.chatOfCharacter(props.character.id)?.id ?? '';

// —— 来电卡：响到 ringUntil，过了还没接就成了未接来电 ——
const now = ref(Date.now());
const ringing = computed(() => props.part.type === 'call-log' && !props.part.answered && (props.part.ringUntil ?? 0) > now.value);
const ringTimer = ringing.value && props.part.type === 'call-log' ? setTimeout(() => (now.value = Date.now()), (props.part.ringUntil ?? 0) - Date.now() + 100) : undefined;
onBeforeUnmount(() => clearTimeout(ringTimer));
function answerCall() {
  void router.push(`/call/${props.character.id}?incoming=1`);
}
function callBack() {
  void router.push({ path: `/call/${props.character.id}`, query: props.part.type === 'call-log' && props.part.video ? { video: '1' } : {} });
}

// —— 邀请卡：接受 → 去对应的陪伴场景或平行时空；下次吧 → 回她一句 ——
const invite = computed(() => {
  const p = props.part;
  if (p.type !== 'invite') return null;
  if (p.kind === 'study') return { head: '陪伴学习邀请', title: p.task || '一起专注一会儿', sub: p.minutes ? `倒计时 ${p.minutes} 分钟` : '番茄钟', icon: 'i-lucide-book-open', tone: '#8fb3f0', yes: '一起学' };
  if (p.kind === 'watch') {
    const parsed = p.link ? parseVideoLink(p.link) : null;
    return { head: '一起观影邀请', title: p.title ? `《${p.title}》` : '一起看片', sub: parsed?.ok ? PLATFORM_LABEL[parsed.link.platform] : '点"一起看"去 B 站找片源', icon: 'i-lucide-clapperboard', tone: '#b9a3e6', yes: '一起看' };
  }
  if (p.kind === 'sleep') return { head: '哄睡邀请', title: '陪你慢慢睡着', sub: '连麦、听故事，或去一个睡前场景', icon: 'i-lucide-moon-star', tone: '#9b8cf0', yes: '陪我睡' };
  if (p.kind === 'exercise') return { head: '一起运动邀请', title: '一起动一动', sub: '照今天的计划练，或者随便动动', icon: 'i-lucide-dumbbell', tone: '#7fd1b1', yes: '一起练' };
  if (p.kind === 'parallel') return { head: '平行时空邀请', title: '看看我们今天的安排', sub: '各自的一天，也能给彼此留句话', icon: 'i-lucide-orbit', tone: '#8fb3f0', yes: '去看看' };
  if (p.kind === 'rest') {
    const a = restActivity(p.activity);
    const rest = getScene('rest');
    return {
      head: '休息邀请',
      title: a ? `一起${a.name}吧` : '一起歇会儿吧',
      sub: a ? a.blurb : '午睡、散步、泡澡、静坐、听音乐，进去再选',
      icon: a?.icon ?? rest.icon,
      tone: rest.tint,
      yes: a ? `一起${a.name}` : '歇会儿',
    };
  }
  if (p.kind === 'home') {
    const home = getScene('home');
    return { head: '共同的家邀请', title: p.chore || '今天的家务', sub: p.chore ? '回家一起做，做的时候能聊天、放歌' : '照今天的清单一件件来，做的时候能聊天、放歌', icon: home.icon, tone: home.tint, yes: '这就去' };
  }
  return { head: '一起游戏邀请', title: inviteGameLabel(p.game), sub: '去一起游戏里开一局', icon: 'i-lucide-gamepad-2', tone: '#e7b46a', yes: '来玩' };
});
function answerInvite(ok: boolean) {
  const p = props.part;
  if (p.type !== 'invite') return;
  if (!ok) {
    p.answer = 'no';
    const id = chatIdOf();
    if (id) void chatStore.send(id, '这次先不了，下次吧');
    return;
  }
  if (p.kind === 'watch' && !p.link) return void pickVideo();
  p.answer = 'yes';
  if (p.kind === 'study') void router.push({ path: '/scene/study', query: { ...(p.task ? { task: p.task } : {}), ...(p.minutes ? { min: String(p.minutes) } : {}) } });
  else if (p.kind === 'watch') void router.push({ path: '/scene/watch', query: { link: p.link, ...(p.title ? { title: p.title } : {}) } });
  else if (p.kind === 'game') void router.push({ path: '/scene/game', query: { g: p.game } });
  else if (p.kind === 'parallel') void router.push(`/parallel/${encodeURIComponent(props.character.id)}`);
  else if (p.kind === 'rest') void router.push({ path: '/scene/rest', query: p.activity ? { do: p.activity } : {} });
  // 共同的家在你的家（真实世界的家）；她点名了哪件，进去先摆出那一件
  else if (p.kind === 'home') void router.push({ path: '/scene/home', query: { at: 'real:home', ...(p.chore ? { chore: p.chore } : {}) } });
  else void router.push(`/scene/${p.kind}`);
}

// 看片邀请只有片名：搜 B 站（连着 Hub 时真的搜，没连在每小时更新的片单里找）
const picking = ref(false);
const searching = ref(false);
const searchError = ref('');
const hits = ref<VideoHit[]>([]);
async function pickVideo() {
  const p = props.part;
  if (p.type !== 'invite' || p.kind !== 'watch') return;
  picking.value = true;
  searching.value = true;
  searchError.value = '';
  hits.value = [];
  try {
    hits.value = (await searchBili(p.title)).videos;
  } catch (e) {
    searchError.value = e instanceof Error ? e.message : String(e);
  } finally {
    searching.value = false;
  }
}
function chooseVideo(h: VideoHit) {
  const p = props.part;
  if (p.type !== 'invite' || p.kind !== 'watch') return;
  p.link = h.url;
  picking.value = false;
  answerInvite(true);
}
/** 去一起观影里逛 B 站片单、或者自己贴链接 */
function watchWithoutLink() {
  const p = props.part;
  if (p.type !== 'invite' || p.kind !== 'watch') return;
  p.answer = 'yes';
  picking.value = false;
  void router.push({ path: '/scene/watch', query: p.title ? { q: p.title } : {} });
}

// —— 玩具卡：没连上时在这里直接连（地址用心跳里设的） ——
async function connectToys() {
  if (!(await toys.connect())) showToast({ message: toys.error || '连不上 Intiface Central', duration: 4000 });
}
</script>

<template>
  <!-- 语音 -->
  <div v-if="part.type === 'voice'" class="pcard voice" :class="{ mine }">
    <button class="flex items-center gap-2 w-full" :aria-label="playing ? '正在播放' : '播放语音'" @click="playVoice">
      <span :class="playing ? 'i-lucide-pause' : 'i-lucide-play'" class="text-[18px] text-accent-ink" />
      <span class="flex items-center gap-[2px] h-6 flex-1">
        <span v-for="(h, i) in bars" :key="i" class="bar" :class="{ live: playing }" :style="{ height: `${h}%`, animationDelay: `${i * 60}ms` }" />
      </span>
      <span class="num text-[12.5px] text-ink-2">{{ Math.round(part.durationMs / 1000) }}″</span>
    </button>
    <button class="text-[12px] text-ink-3 mt-1.5" @click="showTranscript = !showTranscript">
      {{ showTranscript ? '收起文字' : '转文字' }}
    </button>
    <p v-if="showTranscript" class="text-[13.5px] text-ink-2 mt-1">{{ part.transcript }}</p>
  </div>

  <!-- 照片：你拍的、相册里选的 -->
  <button v-else-if="part.type === 'image' && part.photo" class="pcard photo" :class="{ mine }" :data-photo-state="photoState" @click="emit('open-image')">
    <GenImage :part="part" :character="character" class="rounded-[12px]" />
    <div class="photo-note" :class="{ bad: photoState === 'failed' }">
      <span :class="{ looking: 'i-lucide-loader-circle spin-icon', seen: 'i-lucide-scan-eye', failed: 'i-lucide-eye-off', idle: 'i-lucide-scan-eye' }[photoState]" class="shrink-0" />
      <span class="truncate">{{ { looking: '识图在看这张照片…', seen: `识图：${part.seen}`, failed: part.seenError, idle: '还没识图 · 点开重试' }[photoState] }}</span>
    </div>
  </button>

  <!-- 图片 / 配图 -->
  <button v-else-if="part.type === 'image'" class="pcard image" :data-image-state="imageState" @click="emit('open-image')">
    <GenImage :part="part" :character="character" class="rounded-[14px]" />
    <div class="flex items-center gap-1.5 mt-2 text-[12.5px] text-ink-2">
      <span class="i-lucide-wand-sparkles text-accent-ink shrink-0" />
      <span class="truncate">{{ part.title || part.caption }}</span>
      <span class="ml-auto shrink-0 max-w-[48%] truncate" :class="part.error ? 'text-bad' : 'text-ink-3'">{{ imageLabel }}</span>
    </div>
  </button>

  <!-- 歌曲 -->
  <div v-else-if="part.type === 'music'" class="pcard music">
    <span class="disc" />
    <div class="flex-1 min-w-0">
      <div class="font-600 text-[14.5px] truncate">{{ part.title }}</div>
      <div class="text-[12.5px] text-ink-3 truncate">{{ part.artist }} · 网易云</div>
    </div>
    <button class="listen" @click="emit('open-music', part)">
      <span class="i-lucide-headphones" />一起听
    </button>
  </div>

  <!-- 拍一拍 -->
  <div v-else-if="part.type === 'poke'" class="poke">
    <span :class="pokeHow(part.how)?.icon ?? 'i-lucide-hand'" class="text-[13px]" />
    {{ pokeLine(part, '你', character.name) }}
  </div>

  <!-- 通话记录；她在聊天里打来的先响一会儿（能接），没接就是能回拨的未接来电 -->
  <div v-else-if="part.type === 'call-log'" class="pcard row-card">
    <span class="icon-wrap" :class="{ ringing }"><span :class="ringing ? 'i-lucide-phone-incoming' : part.video ? 'i-lucide-video' : 'i-lucide-phone'" /></span>
    <div class="flex-1">
      <div class="text-[14.5px]">
        <template v-if="ringing">{{ character.name }}打来电话…</template>
        <template v-else-if="part.missed">{{ mine ? '已取消' : part.answered ? '来电 · 已接起' : '未接来电' }}</template>
        <template v-else>{{ part.video ? '视频通话' : '语音通话' }} <span class="num">{{ clock(part.durationSec) }}</span></template>
      </div>
      <div v-if="part.scene" class="text-[12px] text-ink-3">{{ part.scene }}</div>
    </div>
    <button v-if="ringing" class="listen" @click="answerCall"><span class="i-lucide-phone" />接听</button>
    <button v-else-if="part.missed && !mine && !part.answered" class="listen" @click="callBack"><span class="i-lucide-phone-outgoing" />回拨</button>
  </div>

  <!-- 她发的邀请：学习 / 观影 / 游戏 / 哄睡 / 运动 / 平行时空 -->
  <div v-else-if="part.type === 'invite' && invite" class="pcard" :style="{ '--tone': invite.tone }">
    <div class="flex items-center gap-2">
      <span class="icon-wrap" style="color: var(--tone)"><span :class="invite.icon" /></span>
      <div class="flex-1 min-w-0">
        <div class="text-[12.5px] text-ink-3">{{ invite.head }}</div>
        <div class="font-600 text-[14.5px] truncate">{{ invite.title }}</div>
        <div class="text-[12px] text-ink-3 truncate">{{ invite.sub }}</div>
      </div>
    </div>
    <div v-if="!part.answer && !mine" class="flex gap-2 mt-2.5">
      <button class="flex-1 h-9 rounded-full bg-accent text-[var(--on-accent)] text-[13.5px] font-600 press" @click="answerInvite(true)">{{ invite.yes }}</button>
      <button class="flex-1 h-9 rounded-full bg-panel text-[13.5px] press" @click="answerInvite(false)">下次吧</button>
    </div>
    <button v-else-if="part.answer === 'yes'" class="text-[12.5px] text-ink-3 mt-2 press" @click="answerInvite(true)">已答应 · 点这里再去</button>
    <div v-else-if="part.answer === 'no'" class="text-[12.5px] text-ink-3 mt-2">这次没去</div>
    <!-- 看片邀请只有片名：搜 B 站的真实视频，挑一个去一起观影 -->
    <van-popup v-if="part.kind === 'watch'" v-model:show="picking" position="bottom" round teleport="body" :style="{ maxHeight: '80%' }">
      <div class="p-4">
        <div class="font-600 text-[15px] mb-1">找《{{ part.title }}》的片源</div>
        <div class="text-[12px] text-ink-3 mb-3">B 站的真实视频，点一个就去一起观影；没连云端 Hub 时只在每小时更新的片单里找</div>
        <div v-if="searching" class="text-[13px] text-ink-3 py-6 text-center">在 B 站搜…</div>
        <div v-else-if="searchError" class="text-[13px] text-bad mb-3">{{ searchError }}</div>
        <button v-for="h in hits" :key="h.bvid" class="hit press" @click="chooseVideo(h)">
          <img referrerpolicy="no-referrer" loading="lazy" :src="h.cover" alt="" />
          <div class="flex-1 min-w-0 text-left">
            <div class="text-[13.5px] leading-snug line-clamp-2">{{ h.title }}</div>
            <div class="text-[12px] text-ink-3 truncate">{{ h.author }} · {{ h.duration }} · {{ h.plays.toLocaleString('zh-CN') }} 播放</div>
          </div>
        </button>
        <div v-if="!searching && !hits.length && !searchError" class="text-[13px] text-ink-3 py-4 text-center">片单里没有，换个办法：</div>
        <div v-if="!searching" class="flex gap-2 mt-3">
          <a class="flex-1 h-9 rounded-full bg-panel text-ink text-[13px] press flex items-center justify-center" :href="`https://search.bilibili.com/all?keyword=${encodeURIComponent(part.title)}`" target="_blank" rel="noopener">去 B 站搜</a>
          <a class="flex-1 h-9 rounded-full bg-panel text-ink text-[13px] press flex items-center justify-center" :href="`https://www.youtube.com/results?search_query=${encodeURIComponent(part.title)}`" target="_blank" rel="noopener">去 YouTube 搜</a>
          <button class="flex-1 h-9 rounded-full bg-panel text-[13px] press" @click="watchWithoutLink">逛片单 / 贴链接</button>
        </div>
      </div>
    </van-popup>
  </div>

  <!-- 她在聊天里写的玩具指令：连着时读到那里已经自动执行 -->
  <div v-else-if="part.type === 'toy'" class="pcard" style="--tone: #ff7a93">
    <div class="flex items-center gap-2">
      <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-heart-pulse" /></span>
      <div class="flex-1 min-w-0">
        <div class="text-[14.5px]">{{ part.text }}</div>
        <div class="text-[12px] text-ink-3">{{ toys.ready ? `连着玩具 · ${characterPronoun(character)}的指令读到这里时执行` : toys.live ? '模拟模式 · 没有真的玩具' : '玩具没连上，没有执行' }}</div>
      </div>
    </div>
    <div class="flex gap-2 mt-2.5">
      <template v-if="toys.live">
        <button class="flex-1 h-8 rounded-full bg-accent text-[var(--on-accent)] text-[13px] font-600 press" @click="toys.apply(part.command, 'you')">再来一次</button>
        <button class="flex-1 h-8 rounded-full bg-panel text-[13px] press" @click="toys.stopAll()">停下</button>
      </template>
      <template v-else>
        <button class="flex-1 h-8 rounded-full bg-accent text-[var(--on-accent)] text-[13px] font-600 press" :disabled="toys.status === 'connecting'" @click="connectToys">{{ toys.status === 'connecting' ? '连接中…' : '连接玩具' }}</button>
        <button class="flex-1 h-8 rounded-full bg-panel text-[13px] press" @click="router.push('/scene/heart')">去心跳设置</button>
      </template>
    </div>
  </div>

  <!-- 运动 -->
  <div v-else-if="part.type === 'workout'" class="pcard activity" style="--tone: #7fd1b1">
    <div class="flex items-center gap-2 text-[12.5px] text-ink-2">
      <span :class="part.mode === 'plan' ? 'i-lucide-dumbbell' : 'i-lucide-footprints'" style="color: var(--tone)" />
      <span class="truncate">{{ part.mode === 'plan' && part.plan ? `健身 · ${part.plan.title}` : `运动记录 · ${part.sport}` }}</span>
      <span v-if="part.source === 'watch'" class="ml-auto shrink-0 inline-flex items-center gap-1 text-[11.5px] text-ink-3" :title="part.watch?.note"><span class="i-lucide-watch" />{{ part.watch?.device || '手表' }}</span>
    </div>
    <div class="grid grid-cols-3 gap-2 mt-2">
      <div><div class="big num">{{ clock(part.durationSec) }}</div><div class="label">用时</div></div>
      <div v-if="part.plan"><div class="big num">{{ part.plan.done }}/{{ part.plan.total }}</div><div class="label">动作</div></div>
      <div v-if="part.distanceKm != null"><div class="big num">{{ part.distanceKm }}</div><div class="label">公里</div></div>
      <div v-if="part.pace && part.distanceKm"><div class="big num">{{ part.pace }}</div><div class="label">配速</div></div>
      <div v-if="part.kcal"><div class="big num">{{ part.kcal }}</div><div class="label">千卡</div></div>
      <div v-if="part.heartRate?.avg"><div class="big num">{{ part.heartRate.avg }}</div><div class="label">平均心率{{ part.heartRate.max ? ` · 最高 ${part.heartRate.max}` : '' }}</div></div>
      <div v-if="part.steps"><div class="big num">{{ part.steps.toLocaleString('zh-CN') }}</div><div class="label">步</div></div>
    </div>
  </div>

  <!-- 家务（共同的家） -->
  <div v-else-if="part.type === 'chore'" class="pcard row-card" style="--tone: #f2c38b">
    <span class="icon-wrap" style="color: var(--tone)"><span :class="part.status === 'done' ? 'i-lucide-circle-check' : 'i-lucide-hourglass'" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">{{ part.status === 'done' ? `做完了：${part.name}` : `晚点再做：${part.name}` }}</div>
      <div class="text-[12px] text-ink-3 truncate">
        共同的家<template v-if="part.minutes"> · 做了 {{ part.minutes }} 分钟</template><template v-if="part.later"> · {{ part.status === 'done' ? `之前拖了 ${part.later} 次` : `拖了 ${part.later} 次` }}</template>
      </div>
    </div>
  </div>

  <!-- 一起吃饭：一顿饭（照片、怎么吃的、这次画的她） -->
  <div v-else-if="part.type === 'meal'" class="pcard meal">
    <button v-if="part.photo" type="button" class="meal-photo has-photo" aria-label="看大图：这顿饭" @click="previewMealPhoto">
      <AssetImg :asset-key="part.photo" :alt="part.food" />
    </button>
    <div v-else class="meal-photo"><span class="i-lucide-soup text-[34px]" /></div>
    <div class="p-3">
      <div class="text-[12.5px] text-ink-3">{{ MEAL[part.meal] ?? '一顿饭' }}<template v-if="mealHow"> · {{ mealHow }}</template></div>
      <div class="font-600 text-[14.5px]">{{ part.food }}</div>
      <div v-if="part.herMeal || part.cheers" class="text-[12px] text-ink-3 mt-0.5">
        <template v-if="part.herMeal">{{ character.pronoun }}吃的{{ part.herMeal }}</template><template v-if="part.herMeal && part.cheers"> · </template><template v-if="part.cheers">碰了 {{ part.cheers }} 次杯</template>
      </div>
      <div v-if="part.images?.length" class="shots">
        <button v-for="(img, i) in part.images" :key="i" type="button" class="shot" :aria-label="`看大图：${img.title}`" @click="previewShots(i)">
          <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.title" />
        </button>
      </div>
    </div>
  </div>

  <!-- 学习 -->
  <div v-else-if="part.type === 'read'" class="pcard row-card" style="--tone: #d9a77a">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-book-open-text" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">一起读《{{ part.title }}》</div>
      <div class="text-[12px] text-ink-3 truncate">{{ part.chapter }} · 全书 {{ part.progress }}%<template v-if="part.notes"> · {{ part.notes }} 条批注</template></div>
      <div v-if="part.quote" class="text-[12.5px] text-ink-2 mt-0.5">「<RichText :text="part.quote" />」</div>
    </div>
  </div>
  <div v-else-if="part.type === 'game' && part.game === 'brawl'" class="pcard row-card" style="--tone: #d9a75d">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-swords" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px]">大乱斗 · {{ part.result.winner === 'draw' ? '平局' : `${part.result.winner === 'you' ? part.result.you : part.result.opponent}获胜` }}</div>
      <div class="text-[12px] text-ink-3">{{ part.result.you }} vs {{ part.result.opponent }} · {{ part.result.seconds }} 秒</div>
      <div class="text-[12.5px] text-ink-2 mt-0.5">造成 {{ part.result.damage }} 伤害 · 最高 {{ part.result.combo }} 连击</div>
    </div>
  </div>
  <div v-else-if="part.type === 'game' && part.game === 'truthdare'" class="pcard row-card" style="--tone: #b9a3e6">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-bottle-wine" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">真心话大冒险<template v-if="part.level"> · {{ part.level }}</template></div>
      <div class="text-[12px] text-ink-3">玩了 {{ part.rounds }} 轮</div>
      <div class="text-[12.5px] text-ink-2 mt-0.5">
        你：真心话 {{ part.you.truth }} · 大冒险 {{ part.you.dare }}<template v-if="part.you.skipped"> · 认罚 {{ part.you.skipped }}</template>
      </div>
      <div class="text-[12.5px] text-ink-2">
        {{ character.pronoun }}：真心话 {{ part.her.truth }} · 大冒险 {{ part.her.dare }}<template v-if="part.her.skipped"> · 认罚 {{ part.her.skipped }}</template>
      </div>
    </div>
  </div>
  <div v-else-if="part.type === 'game' && part.game === 'decor'" class="pcard row-card" style="--tone: #e7b46a">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-sofa" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">装修小屋 · {{ part.room }}</div>
      <div class="text-[12px] text-ink-3">
        现在摆了 {{ part.items }} 件<template v-if="part.added"> · 这次添了 {{ part.added }} 件</template><template v-if="part.herAdded"> · {{ character.pronoun }}放了 {{ part.herAdded }} 件</template>
      </div>
      <div v-if="part.photo" class="shots">
        <button type="button" class="shot wide" :aria-label="`看大图：${part.room}`" @click="previewPhoto">
          <AssetImg :asset-key="part.photo" :alt="part.room" />
        </button>
      </div>
    </div>
  </div>
  <div v-else-if="part.type === 'game' && part.game === 'workshop'" class="pcard row-card" style="--tone: #7fc8a9">
    <span class="icon-wrap" style="color: var(--tone)"><span :class="part.kind === 'image' ? 'i-lucide-palette' : 'i-lucide-feather'" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">创意工坊 · {{ part.kind === 'image' ? `「${part.title}」` : `《${part.title}》` }}</div>
      <div class="text-[12px] text-ink-3 truncate">
        {{ part.kind === 'image' ? `给${character.pronoun}看了一张画` : (part.chapter ?? '小说') }}<template v-if="part.verdict"> · 想听{{ part.verdict === 'cheer' ? '夸' : '吐槽' }}</template>
      </div>
      <div v-if="part.excerpt" class="text-[12.5px] text-ink-2 mt-1 line-clamp-2">{{ part.excerpt }}…</div>
      <div v-if="part.photo" class="shots">
        <button type="button" class="shot" :aria-label="`看大图：${part.title}`" @click="previewWork">
          <AssetImg :asset-key="part.photo" :alt="part.title" />
        </button>
      </div>
    </div>
  </div>
  <div v-else-if="part.type === 'game' && part.game === 'flight'" class="pcard row-card" style="--tone: #b9a3e6">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-dice-5" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">飞行棋 · {{ part.board }}</div>
      <div class="text-[12px] text-ink-3">
        掷了 {{ part.turns }} 次骰子<template v-if="part.winner"> · {{ part.winner === 'you' ? '你' : character.pronoun }}先到终点</template>
      </div>
      <div class="text-[12.5px] text-ink-2 mt-0.5">你走到第 {{ part.you }} 格 · {{ character.pronoun }}走到第 {{ part.her }} 格（共 {{ part.size }} 格）</div>
    </div>
  </div>
  <div v-else-if="part.type === 'game'" class="pcard row-card" style="--tone: #b9a3e6">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-puzzle" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">海龟汤 · 《{{ part.title }}》</div>
      <div class="text-[12px] text-ink-3">
        {{ { solved: '猜出来了', partial: '猜对了一半', 'gave-up': '认输了' }[part.result] }} · 问了 {{ part.questions }} 个问题<template v-if="part.hints"> · 提示 {{ part.hints }} 次</template>
      </div>
      <div v-if="part.truth" class="text-[12.5px] text-ink-2 mt-0.5">汤底：{{ part.truth }}</div>
    </div>
  </div>
  <div v-else-if="part.type === 'watch'" class="pcard row-card" style="--tone: #e07a7a">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-ticket" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">票根 · 《{{ part.title }}》</div>
      <div class="text-[12px] text-ink-3">
        一起看了 {{ part.minutes }} 分钟<template v-if="part.yourScore"> · 你 {{ part.yourScore }}/5</template><template v-if="part.herScore"> · {{ character.pronoun }} {{ part.herScore }}/5</template>
      </div>
      <div v-for="(h, i) in part.highlights ?? []" :key="i" class="text-[12.5px] text-ink-2 mt-0.5 truncate">「{{ h }}」</div>
      <a v-if="part.link" :href="part.link" target="_blank" rel="noopener noreferrer" class="block text-[12px] text-accent-ink mt-1 truncate">{{ part.link }}</a>
    </div>
  </div>
  <div v-else-if="part.type === 'study'" class="pcard row-card" style="--tone: #8fb3f0">
    <span class="icon-wrap" style="color: var(--tone)"><span class="i-lucide-book-open" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px]">
        陪伴学习 · <template v-if="!part.timer || part.timer === 'pomodoro'">{{ part.pomodoros }} 个番茄</template><template v-else>{{ part.timer === 'countdown' ? '倒计时' : '正计时' }}</template><template v-if="part.together === false"> · 各自专注</template>
      </div>
      <div class="text-[12px] text-ink-3">
        专注 {{ part.minutes }} 分钟<template v-if="part.tasks?.length"> · 完成 {{ part.tasks.filter((t) => t.done).length }} / {{ part.tasks.length }} 个任务</template><template v-if="part.promise"> · 约定{{ part.promise.kept ? '做到了' : '没做到' }}</template>
      </div>
      <div v-if="part.diary" class="text-[12.5px] text-ink-2 mt-1">{{ part.diary }}</div>
      <div v-if="part.images?.length" class="shots">
        <button v-for="(img, i) in part.images" :key="i" type="button" class="shot" :aria-label="`看大图：${img.title}`" @click="previewShots(i)">
          <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.title" />
        </button>
      </div>
    </div>
  </div>

  <!-- 约会回忆 -->
  <div v-else-if="part.type === 'date' && part.status === 'memory'" class="pcard row-card date-memory" style="--tone: #ff9fa8">
    <span class="icon-wrap self-start" style="color: var(--tone)"><span class="i-lucide-heart-handshake" /></span>
    <div class="flex-1 min-w-0">
      <div class="text-[14.5px] truncate">约会回忆 · {{ part.place }}</div>
      <div class="text-[12px] text-ink-3">
        {{ part.when }}<template v-if="part.turns"> · 走了 {{ part.turns }} 段</template><template v-if="part.minutes"> · {{ part.minutes }} 分钟</template>
      </div>
      <div v-if="datePicks" class="text-[12px] text-ink-2 mt-0.5">{{ datePicks }}</div>
      <div v-if="part.farewell" class="text-[12.5px] text-ink-2 mt-1">「{{ part.farewell }}」</div>
      <div v-if="part.images?.length" class="shots">
        <button v-for="(img, i) in part.images" :key="i" type="button" class="shot" :aria-label="`看大图：${img.title}`" @click="previewShots(i)">
          <AssetImg :asset-key="img.assetKey" :url="img.url" :alt="img.title" />
        </button>
      </div>
    </div>
  </div>

  <!-- 约会邀请 -->
  <div v-else-if="part.type === 'date'" class="pcard date">
    <div class="flex items-center gap-2">
      <span class="icon-wrap" style="color: #ff9fa8"><span class="i-lucide-heart-handshake" /></span>
      <div class="flex-1 min-w-0">
        <div class="text-[12.5px] text-ink-3">约会邀请</div>
        <div class="font-600 text-[14.5px] truncate">{{ part.when }} · {{ part.place }}</div>
      </div>
    </div>
    <div v-if="part.status === 'invite' && !mine" class="flex gap-2 mt-2.5">
      <button class="flex-1 h-9 rounded-full bg-accent text-[var(--on-accent)] text-[13.5px] font-600 press" @click="emit('answer-date', true)">答应{{ characterPronoun(character) }}</button>
      <button class="flex-1 h-9 rounded-full bg-panel text-[13.5px] press" @click="emit('answer-date', false)">再想想</button>
    </div>
    <div v-else class="text-[12.5px] text-ink-3 mt-2">{{ part.status === 'accepted' ? `已答应 · 到时候${characterPronoun(character)}会提醒你` : part.status === 'memory' ? '已存进回忆' : '' }}</div>
  </div>

  <!-- 场景分段：和她一起去了某个地点 / 离开 -->
  <div v-else-if="part.type === 'scene'" class="scene-mark" :class="part.event">
    <span class="line" />
    <span class="label">
      <span :class="part.event === 'enter' ? 'i-lucide-map-pin' : 'i-lucide-footprints'" />
      {{ part.title }}<template v-if="part.summary"> · {{ part.summary }}</template>
    </span>
    <span class="line" />
  </div>

  <div v-else-if="part.type === 'gift'" class="pcard row-card">
    <span class="icon-wrap"><span class="i-lucide-gift" /></span>
    <div class="text-[14.5px]">送出礼物：{{ part.name }}</div>
  </div>
</template>

<style scoped>
.pcard {
  display: block;
  width: 100%;
  max-width: 260px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--bubble-ai);
  border: 1px solid var(--border);
  color: var(--ink);
  text-align: left;
}
.voice {
  min-width: 170px;
}
.voice.mine {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.bar {
  width: 3px;
  border-radius: 2px;
  background: var(--accent-ink);
  opacity: 0.55;
}
.bar.live {
  animation: typing 0.9s infinite;
  opacity: 1;
}
.image {
  padding: 6px 6px 8px;
  width: 210px;
}
.photo {
  padding: 4px 4px 6px;
  width: 190px;
}
.photo.mine {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.photo-note {
  display: flex;
  align-items: center;
  gap: 5px;
  margin: 5px 4px 0;
  font-size: 11.5px;
  color: var(--ink-3);
}
.photo-note.bad {
  color: var(--warn);
}
.spin-icon {
  animation: spin 1s linear infinite;
}
.music {
  display: flex;
  align-items: center;
  gap: 10px;
}
.disc {
  width: 42px;
  height: 42px;
  border-radius: 50%;
  flex-shrink: 0;
  background:
    radial-gradient(circle, var(--bubble-ai) 0 4px, transparent 5px),
    repeating-radial-gradient(circle, #2a2233 0 2px, #1a1522 2px 4px);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.listen {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 30px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 12.5px;
  font-weight: 600;
  flex-shrink: 0;
}
.poke {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 12px;
}
.row-card {
  display: flex;
  align-items: center;
  gap: 10px;
}
.icon-wrap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--accent-ink);
  font-size: 18px;
  flex-shrink: 0;
}
.activity .big {
  font-size: 19px;
  font-weight: 700;
  line-height: 1.1;
}
.activity .label {
  font-size: 11px;
  color: var(--ink-3);
}
.meal {
  padding: 0;
  overflow: hidden;
  width: 200px;
}
.scene-mark {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 340px;
  margin: 8px 0 2px;
  color: var(--accent-ink);
  font-size: 12px;
}
.scene-mark.leave {
  color: var(--ink-3);
}
.scene-mark .line {
  flex: 1;
  height: 1px;
  background: currentColor;
  opacity: 0.35;
}
.scene-mark .label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 78%;
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--panel);
  text-align: center;
}
.meal-photo {
  height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: linear-gradient(135deg, #e8a86c, #b8603f);
}
.meal-photo.has-photo {
  position: relative;
  width: 100%;
  height: 140px;
  padding: 0;
  overflow: hidden;
  cursor: zoom-in;
}
.shots {
  display: flex;
  gap: 6px;
  margin-top: 8px;
  overflow-x: auto;
}
.shot {
  flex-shrink: 0;
  width: 54px;
  height: 72px;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.shot.wide {
  width: 160px;
  height: 120px;
}
/* 她打来的电话还在响 */
.icon-wrap.ringing {
  color: #fff;
  background: #4cc38a;
  animation: ring 1.1s ease-in-out infinite;
}
@keyframes ring {
  0%, 100% { transform: rotate(0); }
  20%, 60% { transform: rotate(-12deg); }
  40%, 80% { transform: rotate(12deg); }
}
/* 搜到的 B 站视频 */
.hit {
  display: flex;
  gap: 10px;
  width: 100%;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  align-items: center;
}
.hit img {
  width: 96px;
  height: 60px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--panel);
  flex-shrink: 0;
}
</style>
