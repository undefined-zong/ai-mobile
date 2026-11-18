<script setup lang="ts">
import { previewImages } from '@/services/imageViewer';
import { expressionField, expressionMood, isDecorPreset, parseControlTags, type MessagePart, type PresetUseId } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue';
import { useRouter } from 'vue-router';
import { putAsset } from '@/services/assets';
import { personaOf } from '@/services/prompt';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useDecorStore } from '@/stores/decor';
import { useLibraryStore } from '@/stores/library';
import { useServicesStore } from '@/stores/services';
import PresetPicker from '@/components/settings/PresetPicker.vue';
import { uid } from '@/utils/id';
import AvatarEditor from './AvatarEditor.vue';
import { describeAvatar, describeAvatarOptions, parseAvatar, type Avatar } from './avatar';
import { DecorEngine } from './engine';
import { LIGHTING, type LightingMode } from './ambience';
import { applyHomeStyle, HOME_ROOM_TYPES, ROOM_STYLES, type RoomStyle } from './styles';
import RoomStylePicker from './RoomStylePicker.vue';
import DecorRadio from './DecorRadio.vue';
import { decorRadio, operateRadio } from './radio';
import { useRoomLife } from './useRoomLife';
import { idleActivity, type BubbleAnchors, type Resident } from './activities';
import RoomBubbles from './RoomBubbles.vue';
import {
  addItem,
  applyPlan,
  CATALOG,
  catalogItem,
  CATEGORIES,
  colorName,
  describeCatalog,
  describeRoom,
  duplicateItem,
  FLOOR_FINISHES,
  itemColor,
  MAX_ROOMS,
  moveItem,
  PALETTE,
  parsePlanActions,
  removeItem,
  resizeRoom,
  ROOM_SIZES,
  ROOM_TYPES,
  roomType,
  turnItem,
  WALL_FINISHES,
  type DecorCategory,
  type DecorRoom,
  type PlanAction,
} from './model';

/**
 * 一起游戏 · 装修小屋（设计文档 §9.11）：
 * - 一套小屋好几个房间（一开始主卧、次卧、客厅、厨房、洗手间、书房，能自己再添，最多 10 个），上面一排标签换房间，一次看一间。
 * - 3D 小屋（engine.ts）：布置时点家具选中、拖着挪、转向、换色、复制、收起；每间的墙纸地面、大小、名字；撤销重做。逛逛时你的小人走动、坐下、躺下。
 *   转视角用两根手指（一起拖或者拧着转），捏合缩放。
 * - 捏人（AvatarEditor.vue）：你和她的 Q 版小人（发型、发顶、刘海、渐变、套装、花纹、能多选的配饰）；她能给自己捏、帮你捏。
 * - 她：看看屋子说想法（decor-look）、动手布置（decor-plan，按格式写要添要挪的，程序照着摆、放不下的找附近空地）、
 *   捏小人（decor-avatar）、边装边聊（decor-chat）、收工时的话（decor-end）。每一步的规则都在"一起游戏 · 装修小屋"预设里。
 * 屋子和小人存在本机（stores/decor.ts），下次来还在。收工时拍一张照片，和对局卡片一起发进聊天。
 */
export type DecorPhase = 'menu' | 'playing' | 'end';

const USE: PresetUseId = 'game-decor';
const NIGHT_KEY = 'ai-mobile:decor-night';
const LIGHTING_KEY = 'ai-mobile:decor-lighting';
const WISHES = ['温馨一点', '多放点绿植', '弄个看电影的角落', '换个颜色', '给我们添张床'];

const line = defineModel<string>('line', { required: true });
const phase = defineModel<DecorPhase>('phase', { required: true });
const emit = defineEmits<{
  fail: [r: { reason: string; notConnected?: boolean }];
  progress: [summary: string | null];
  done: [summary: string];
}>();

const app = useAppStore();
const chars = useCharacterStore();
const chat = useChatStore();
const lib = useLibraryStore();
const decor = useDecorStore();
const servicesConfig = useServicesStore();
const router = useRouter();
const her = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(her.value.id)?.id ?? '');
const userName = computed(() => personaOf(chat.chatById(chatId.value)).name);

decor.homeOf(her.value.id);
const home = computed(() => decor.homes[her.value.id] ?? decor.homeOf(her.value.id));
const rooms = computed(() => home.value.rooms);
const room = computed(() => rooms.value[home.value.current] ?? rooms.value[0]!);
const presetReady = computed(() => isDecorPreset(lib.presetForUse(USE, her.value)));

// —— 3D ——
const canvas = ref<HTMLCanvasElement | null>(null);
const engine = shallowRef<DecorEngine | null>(null);
const mode = ref<'edit' | 'live'>('edit');
const selectedId = ref<string | null>(null);
const selected = computed(() => room.value.items.find((i) => i.id === selectedId.value) ?? null);
const selectedCat = computed(() => (selected.value ? catalogItem(selected.value.kind) : undefined));
function readLighting(): LightingMode {
  try {
    const saved = localStorage.getItem(LIGHTING_KEY);
    return saved === 'morning' || saved === 'day' || saved === 'sunset' || saved === 'night' ? saved : localStorage.getItem(NIGHT_KEY) === '1' ? 'night' : 'day';
  } catch {
    return 'day';
  }
}
const lighting = ref<LightingMode>(readLighting());
const lightingOpen = ref(false);
const radioOpen = ref(false);
const hasRadio = computed(() => room.value.items.some((i) => i.kind === 'radio'));
const radioSong = computed(() => decorRadio.current());
watch(() => room.value.id, () => { radioOpen.value = false; });
const webglFailed = ref(false);
const lifeOpen = ref(false);
const lifePresetOpen = ref(false);
const residentStates = ref({ you: idleActivity(), her: idleActivity() });
const bubbleAnchors = shallowRef<BubbleAnchors>({ you: { x: 0, y: 0, visible: false }, her: { x: 0, y: 0, visible: false } });
const bubbles = ref<Record<Resident, string>>({ you: '', her: '' });
const bubbleTimers: Partial<Record<Resident, ReturnType<typeof setTimeout>>> = {};
function bubble(who: Resident, text: string) {
  clearTimeout(bubbleTimers[who]);
  bubbles.value[who] = clean(text, 100);
  bubbleTimers[who] = setTimeout(() => { bubbles.value[who] = ''; }, Math.min(15000, 6000 + text.length * 90));
}
watch(() => room.value.id, () => { bubbles.value = { you: '', her: '' }; });

onMounted(() => {
  if (!canvas.value) return;
  try {
    const e = new DecorEngine(canvas.value, {
      select: (id) => select(id),
      interact: () => { radioOpen.value = true; },
      move: (id, to) => {
        const res = moveItem(room.value, id, to);
        if (!res.ok) return showToast(res.reason);
        const name = catalogItem(room.value.items.find((i) => i.id === id)?.kind ?? '')?.name ?? '';
        commit(res.room, `挪了${name}`);
      },
      invalid: (reason) => showToast(reason),
      tapChibi: () => undefined,
      act: (text) => { log.value.push(`${userName.value}：${text}`); bubble('you', text); },
      activity: (who, state) => { residentStates.value[who] = state; },
      anchors: (anchors) => { bubbleAnchors.value = anchors; },
      device: operateRadio,
    });
    e.setRoom(room.value);
    e.setAvatars(home.value.you, home.value.her);
    e.setLighting(lighting.value);
    e.setManagedLife(true);
    e.start();
    engine.value = e;
  } catch (err) {
    console.error('装修小屋的 3D 画面打不开：', err);
    webglFailed.value = true;
  }
});
onActivated(() => engine.value?.start());
onDeactivated(() => engine.value?.stop());
onBeforeUnmount(() => {
  alive = false;
  abort.abort();
  Object.values(bubbleTimers).forEach(clearTimeout);
  engine.value?.dispose();
  engine.value = null;
});
watch(room, (r) => engine.value?.setRoom(r));
watch(
  () => [home.value.you, home.value.her] as const,
  ([y, h]) => engine.value?.setAvatars(y, h),
);
watch(mode, (m) => {
  engine.value?.setMode(m);
  if (m === 'live') selectedId.value = null;
});
watch(() => [engine.value, servicesConfig.musicReady, decorRadio.state.playing, radioSong.value?.title, decorRadio.state.queue.length] as const, () => {
  engine.value?.setRadioState({ playing: decorRadio.state.playing, ready: servicesConfig.musicReady, title: radioSong.value?.title ?? '', hasQueue: !!decorRadio.state.queue.length });
});
function enterLive() {
  decorRadio.prime();
  mode.value = 'live';
  phase.value = 'playing';
}
function setLighting(value: LightingMode) {
  lighting.value = value;
  lightingOpen.value = false;
  engine.value?.setLighting(value);
  try {
    localStorage.setItem(LIGHTING_KEY, value);
    localStorage.setItem(NIGHT_KEY, value === 'night' ? '1' : '0');
  } catch {
    // 存不了就只管这一次
  }
}
function select(id: string | null) {
  selectedId.value = id;
  engine.value?.select(id);
}

// —— 改屋子：撤销、重做、这一次改了什么 ——
interface HomeSnapshot { rooms: DecorRoom[]; current: number }
const undoStack = ref<HomeSnapshot[]>([]);
const redoStack = ref<HomeSnapshot[]>([]);
watch(() => her.value.id, () => {
  undoStack.value = [];
  redoStack.value = [];
});
/** 这一次的改动（给她看） */
const log = ref<string[]>([]);
/** 这一次新放的（收工时还在的算"添了几件"）、其中她放的 */
const addedIds = ref<Set<string>>(new Set());
const herIds = ref<Set<string>>(new Set());

function clone(r: DecorRoom): DecorRoom {
  return JSON.parse(JSON.stringify(r)) as DecorRoom;
}
function snapshotHome(): HomeSnapshot {
  return { rooms: rooms.value.map(clone), current: home.value.current };
}
function rememberHome() {
  undoStack.value = [...undoStack.value.slice(-49), snapshotHome()];
  redoStack.value = [];
}
function commit(next: DecorRoom, what?: string) {
  rememberHome();
  decor.setRoom(her.value.id, next);
  if (what) log.value.push(what);
  if (phase.value !== 'playing') phase.value = 'playing';
  emit('progress', `装修小屋「${next.name}」`);
}
function undo() {
  const prev = undoStack.value.at(-1);
  if (!prev) return;
  undoStack.value = undoStack.value.slice(0, -1);
  redoStack.value = [...redoStack.value, snapshotHome()];
  select(null);
  decor.setRooms(her.value.id, prev.rooms, prev.current);
}
function redo() {
  const next = redoStack.value.at(-1);
  if (!next) return;
  redoStack.value = redoStack.value.slice(0, -1);
  undoStack.value = [...undoStack.value, snapshotHome()];
  select(null);
  decor.setRooms(her.value.id, next.rooms, next.current);
}

// —— 房间：换一间、添一间、拆掉一间 ——
const addRoomOpen = ref(false);
function goRoom(index: number) {
  if (index === home.value.current || busy.value) return;
  select(null);
  decor.setCurrent(her.value.id, index);
  log.value.push(`${userName.value}去了${room.value.name}`);
}
function addRoom(type: string) {
  if (busy.value) return;
  select(null);
  const made = decor.addRoom(her.value.id, type);
  addRoomOpen.value = false;
  if (!made) return showToast(`最多 ${MAX_ROOMS} 个房间`);
  undoStack.value = [];
  redoStack.value = [];
  log.value.push(`${userName.value}添了一间新房间「${made.name}」`);
  if (phase.value !== 'playing') phase.value = 'playing';
  emit('progress', `装修小屋「${made.name}」`);
}
async function removeRoom() {
  if (busy.value || rooms.value.length <= 1) return;
  const target = room.value;
  try {
    await showConfirmDialog({ title: `拆掉「${target.name}」？`, message: `里面的 ${target.items.length} 件家具会一起收走，拆了就找不回来了。` });
  } catch {
    return;
  }
  // 名字的草稿清掉：关面板时别把这个名字安到下一间头上
  nameDraft.value = '';
  finishOpen.value = false;
  select(null);
  undoStack.value = [];
  redoStack.value = [];
  if (decor.removeRoom(her.value.id, target.id)) log.value.push(`${userName.value}把「${target.name}」拆掉了`);
}

// —— 选中的那件 ——
function turnSelected() {
  if (!selected.value) return;
  const res = turnItem(room.value, selected.value.id);
  if (!res.ok) return showToast(res.reason);
  commit(res.room, `把${selectedCat.value?.name}转了个方向`);
}
function recolor(hex: string) {
  const it = selected.value;
  if (!it || itemColor(it) === hex) return;
  commit({ ...room.value, items: room.value.items.map((i) => (i.id === it.id ? { ...i, color: hex } : i)) }, `把${selectedCat.value?.name}换成了${colorName(hex)}`);
}
function duplicate() {
  if (!selected.value) return;
  const res = duplicateItem(room.value, selected.value.id);
  if (!res) return showToast('旁边放不下了');
  commit(res.room, `又放了一个${selectedCat.value?.name}`);
  addedIds.value.add(res.item.id);
  select(res.item.id);
  engine.value?.pop([res.item.id]);
}
function stash() {
  const it = selected.value;
  if (!it) return;
  const name = selectedCat.value?.name ?? '';
  select(null);
  commit(removeItem(room.value, it.id), `收起了${name}`);
}

// —— 家具目录 ——
const catalogOpen = ref(false);
const cat = ref<DecorCategory | 'all'>('all');
const catalogStyle = ref('all');
const catalogSearch = ref('');
const thumbs = ref<Record<string, string>>({});
const catItems = computed(() => CATALOG.filter((c) =>
  (cat.value === 'all' || c.cat === cat.value) &&
  (catalogStyle.value === 'all' || (catalogStyle.value === 'common' ? !c.style : c.style === catalogStyle.value)) &&
  (!catalogSearch.value.trim() || c.name.includes(catalogSearch.value.trim())),
));
let thumbnailFrame = 0;
function loadThumbs() {
  cancelAnimationFrame(thumbnailFrame);
  const e = engine.value;
  if (!e) return;
  // 一帧画几张，免得卡一下
  const todo = catItems.value.filter((c) => !thumbs.value[c.id]);
  const step = () => {
    const next = todo.splice(0, 3);
    if (!next.length || !catalogOpen.value) return;
    const add: Record<string, string> = {};
    for (const c of next) add[c.id] = e.thumbnail(c.id, c.colors[0]!);
    thumbs.value = { ...thumbs.value, ...add };
    thumbnailFrame = requestAnimationFrame(step);
  };
  thumbnailFrame = requestAnimationFrame(step);
}
watch([catalogOpen, catItems], ([open]) => {
  if (open) loadThumbs();
  else cancelAnimationFrame(thumbnailFrame);
});
onBeforeUnmount(() => cancelAnimationFrame(thumbnailFrame));
function openCatalog() {
  cat.value = 'all';
  catalogStyle.value = 'all';
  catalogSearch.value = '';
  catalogOpen.value = true;
}
function addFromCatalog(kind: string) {
  const res = addItem(room.value, kind, { by: 'you' });
  const c = catalogItem(kind);
  if (!res) return showToast(`没地方放${c?.name ?? ''}了，先收起点东西`);
  catalogOpen.value = false;
  if (mode.value !== 'edit') mode.value = 'edit';
  commit(res.room, `添了${c?.name}`);
  addedIds.value.add(res.item.id);
  select(res.item.id);
  engine.value?.pop([res.item.id]);
}

// —— 墙和地面、屋子 ——
const finishOpen = ref(false);
const homeStyle = computed(() => HOME_ROOM_TYPES.every((type) => rooms.value.some((r) => r.type === type && r.style === room.value.style)) ? room.value.style : undefined);
function applyStyle(style: RoomStyle) {
  const next = applyHomeStyle(rooms.value, style);
  const current = Math.max(0, next.findIndex((r) => r.type === room.value.type));
  rememberHome();
  select(null);
  nameDraft.value = '';
  decor.setRooms(her.value.id, next, current);
  log.value.push(`把整套六个房间布置成了「${style.name}」`);
  for (const r of next) for (const item of r.items) addedIds.value.add(item.id);
  if (phase.value !== 'playing') phase.value = 'playing';
  emit('progress', `装修整套小屋「${style.name}」`);
  finishOpen.value = false;
  showToast(`已布置${style.name}的六个房间，可整体撤销`);
}
function setFinish(key: 'wall' | 'floor', patch: { finish?: string; color?: string }) {
  const next = { ...room.value[key], ...patch };
  if (next.finish === room.value[key].finish && next.color === room.value[key].color) return;
  const list = key === 'wall' ? WALL_FINISHES : FLOOR_FINISHES;
  commit({ ...room.value, [key]: next }, `把${key === 'wall' ? '墙' : '地面'}换成了${colorName(next.color)}${list.find((f) => f.id === next.finish)?.name ?? ''}`);
}
function setSize(w: number, d: number) {
  if (w === room.value.w && d === room.value.d) return;
  const res = resizeRoom(room.value, w, d);
  commit(res.room, `把房间改成了 ${w} × ${d} 格`);
  if (res.dropped) showToast(`放不下的 ${res.dropped} 件先收起来了，可以撤销`);
}
const nameDraft = ref('');
watch(finishOpen, (open) => {
  if (open) nameDraft.value = room.value.name;
  else {
    const n = nameDraft.value.trim().slice(0, 16);
    if (n && n !== room.value.name) commit({ ...room.value, name: n }, `把房间的名字改成了「${n}」`);
  }
});

// —— 捏人 ——
const avatarOpen = ref(false);
const avatarWho = ref<'you' | 'her'>('you');
function openAvatar(who: 'you' | 'her') {
  avatarWho.value = who;
  avatarOpen.value = true;
}
function saveAvatar(who: 'you' | 'her', a: Avatar) {
  decor.setAvatar(her.value.id, who, a);
  log.value.push(`${who === 'you' ? `${userName.value}换了自己的样子` : `${userName.value}给${her.value.name}换了个样子`}：${describeAvatar(a)}`);
  if (who === 'her') engine.value?.herReact('blush');
}

// —— 她 ——
type Busy = '' | 'look' | 'plan' | 'avatar' | 'chat' | 'end';
const busy = ref<Busy>('');
const talkText = ref('');
const planOpen = ref(false);
const wish = ref('');
let alive = true;
const abort = new AbortController();

function fail(r: { reason: string; notConnected?: boolean }) {
  if (alive) emit('fail', r);
}

const togetherLine = computed(() => {
  const m = chat.chatById(chatId.value)?.togetherMode;
  if (m === 'visit') return `${userName.value}来你这边了，坐在你旁边，一起在平板上装修`;
  if (m === 'bring') return `你在${userName.value}这边，一起在平板上装修`;
  return `连线（${userName.value}在自己那边，你在你那边，一起装修同一间小屋）`;
});

/** 这一次的输入，只放数据：怎么在一起、屋子现在的样子、你们俩的小人、这一次改了什么，加上这一步的情况 */
function decorInput(extra: (string | false)[]): string {
  return [
    `你们怎么在一起：${togetherLine.value}`,
    describeRoom(room.value, { you: userName.value, her: her.value.name }, rooms.value),
    `小人：${userName.value}是${describeAvatar(home.value.you)}；你是${describeAvatar(home.value.her)}`,
    engine.value ? `当前小人状态：${JSON.stringify(engine.value.observe().residents)}` : false,
    log.value.length ? `这一次改了什么（按先后）：\n${log.value.slice(-14).join('\n')}` : '这一次还没动过',
    ...extra,
  ]
    .filter(Boolean)
    .join('\n');
}

function clean(v: unknown, max: number): string {
  return typeof v === 'string' ? parseControlTags(v, []).visible.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function say(role: 'user' | 'assistant' | 'narrator', text: string, extra: { expression?: string; agent?: boolean; cue?: string } = {}) {
  chat.push(chatId.value, role, [{ type: 'text', text }], {
    meta: { scene: 'game', cue: extra.cue ?? '装修小屋', ...(extra.agent ? { agent: 'companion' as const } : {}) },
    expression: extra.expression ?? null,
  });
  if (extra.expression) chars.setExpression(her.value.id, extra.expression);
}

const life = useRoomLife({
  engine,
  roomId: () => room.value.id,
  characterId: () => her.value.id,
  chatId: () => chatId.value,
  active: () => mode.value === 'live' && phase.value !== 'end',
  blocked: () => !!busy.value || radioOpen.value || lifeOpen.value || lifePresetOpen.value || catalogOpen.value || finishOpen.value || avatarOpen.value || planOpen.value,
  context: () => decorInput([]),
  reply: (decision) => {
    const expr = expressionField(decision.expr, her.value.portraits).expr;
    if (decision.line) {
      line.value = decision.line;
      bubble('her', decision.line);
      chat.push(chatId.value, 'assistant', [{ type: 'text', text: decision.line }], { meta: { scene: 'game', cue: '小屋生活', agent: 'decor' }, expression: expr ?? null });
    }
    if (expr) chars.setExpression(her.value.id, expr);
    engine.value?.herReact(expressionMood(expr ?? 'smile', her.value.portraits));
  },
  result: (text) => { log.value.push(`${her.value.name}：${text}`); },
});
const { enabled: lifeEnabled, interval: lifeInterval, connected: lifeConnected, preset: lifePreset, requesting: lifeThinking, error: lifeError } = life;
const lifeMessage = computed(() => lifeError.value || (mode.value === 'edit' ? '进入逛逛，让小人在房间里生活' : !lifeConnected.value ? '连接小屋 API，开启自主生活' : !lifeEnabled.value ? `自主活动已暂停 · ${residentStates.value.her.label}` : lifeThinking.value ? `${her.value.name}正在观察房间…` : `${her.value.name} · ${residentStates.value.her.label}`));
function toggleLife() { decorRadio.prime(); lifeEnabled.value = !lifeEnabled.value; }

/** 她说一段（看看屋子、聊天、收工）：流式显示，存进聊天 */
async function herReply(task: string, userText: string | undefined, extra: (string | false)[], cue = '装修小屋'): Promise<boolean> {
  busy.value = task === 'decor-end' ? 'end' : userText ? 'chat' : 'look';
  line.value = '';
  try {
    const r = await chat.sceneReply(chatId.value, {
      task,
      input: decorInput(extra),
      userText,
      cue,
      use: USE,
      allowedTags: ['expr'],
      onText: (t) => {
        if (alive) line.value = t;
      },
    });
    if (!r.ok) {
      fail(r);
      return false;
    }
    if (alive) {
      line.value = r.message.text;
      bubble('her', r.message.text);
      engine.value?.herReact(expressionMood(r.message.expression ?? chars.expression[her.value.id], her.value.portraits));
    }
    return true;
  } finally {
    busy.value = '';
  }
}

async function look() {
  if (busy.value || !chatId.value) return;
  await herReply('decor-look', undefined, []);
}

async function talk() {
  const t = talkText.value.trim();
  if (!t || busy.value || !chatId.value) return;
  talkText.value = '';
  bubble('you', t);
  if (mode.value === 'live') {
    say('user', t, { cue: '小屋生活' });
    await life.request(t);
    return;
  }
  await herReply('decor-chat', t, []);
}

function parsePlan(v: unknown): { line: string; expr?: string; actions: PlanAction[] } | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const actions = parsePlanActions(o.actions);
  const l = clean(o.line, 60);
  if (!actions.length && !l) return null;
  return { line: l, actions, ...expressionField(o.expr, her.value.portraits) };
}

async function herPlan() {
  if (busy.value || !chatId.value) return;
  const w = wish.value.trim();
  planOpen.value = false;
  wish.value = '';
  busy.value = 'plan';
  line.value = '';
  try {
    if (w) say('user', `帮我布置一下：${w}`);
    const res = await chat.sceneJson(
      chatId.value,
      {
        name: 'decor-plan',
        input: decorInput([
          w ? `${userName.value}想要：${w}` : `${userName.value}说：你来布置一下吧`,
          `能摆的家具（id（名字，占地））：\n${describeCatalog()}`,
          `墙纸：${WALL_FINISHES.map((f) => `${f.id}=${f.name}`).join('、')}；地面：${FLOOR_FINISHES.map((f) => `${f.id}=${f.name}`).join('、')}`,
          `调色盘：${PALETTE.map((p) => p.name).join('、')}`,
        ]),
      },
      parsePlan,
      abort.signal,
      { use: USE },
    );
    if (!alive) return;
    if (!res.ok) return fail(res);
    const plan = res.value;
    const out = applyPlan(room.value, plan.actions);
    const said = plan.line || (out.done.length ? '弄好啦，你看看～' : '');
    if (said) {
      line.value = said;
      say('assistant', said, { expression: plan.expr, agent: true });
    }
    engine.value?.herReact(expressionMood(plan.expr ?? 'smile', her.value.portraits));
    if (!out.done.length) {
      showToast(out.skipped.length ? `${her.value.pronoun}想放的${out.skipped.join('、')}` : `${her.value.pronoun}这次没动`);
      return;
    }
    commit(out.room);
    log.value.push(`${her.value.name}${out.done.join('、')}`);
    say('narrator', `${her.value.name}${out.done.join('、')}${out.skipped.length ? `（${out.skipped.join('、')}）` : ''}`);
    for (const id of out.added) {
      addedIds.value.add(id);
      herIds.value.add(id);
    }
    engine.value?.pop(out.added);
    const first = out.added[0] ?? out.touched[0];
    if (first) engine.value?.herVisit(first);
    if (out.added.length === 1) select(out.added[0]!);
  } finally {
    busy.value = '';
  }
}

async function design(who: 'you' | 'her'): Promise<Avatar | null> {
  if (!chatId.value) return null;
  if (busy.value) {
    showToast(`${her.value.pronoun}还在忙上一件事`);
    return null;
  }
  busy.value = 'avatar';
  try {
    const base = who === 'you' ? home.value.you : home.value.her;
    const res = await chat.sceneJson(
      chatId.value,
      {
        name: 'decor-avatar',
        input: decorInput([
          who === 'her' ? `给谁捏：你自己（现在是${describeAvatar(base)}）` : `给谁捏：${userName.value}（现在是${describeAvatar(base)}）`,
          `能挑的选项：\n${describeAvatarOptions()}`,
        ]),
      },
      (v) => {
        const o = v as { avatar?: unknown; line?: unknown; expr?: unknown } | null;
        if (!o || typeof o.avatar !== 'object' || !o.avatar) return null;
        return { avatar: parseAvatar(o.avatar, base), line: clean(o.line, 50), ...expressionField(o.expr, her.value.portraits) };
      },
      abort.signal,
      { use: USE },
    );
    if (!alive) return null;
    if (!res.ok) {
      fail(res);
      if (res.notConnected) showToast(res.reason);
      return null;
    }
    const { avatar, line: l, expr } = res.value;
    if (l) {
      line.value = l;
      say('assistant', l, { expression: expr, agent: true });
    }
    say('narrator', `${her.value.name}${who === 'her' ? '给自己' : `给${userName.value}`}捏了个小人：${describeAvatar(avatar)}`);
    engine.value?.herReact(expr ?? 'smile');
    return avatar;
  } finally {
    busy.value = '';
  }
}

// —— 拍照、收工 ——
function photo() {
  const url = engine.value?.snapshot();
  if (url) previewImages([url]);
}

async function finish() {
  if (busy.value || !chatId.value) return;
  select(null);
  life.cancel();
  mode.value = 'edit';
  let key: string | undefined;
  try {
    const url = engine.value?.snapshot('card');
    if (url) {
      const bin = atob(url.split(',')[1] ?? '');
      const bytes = new Uint8Array(new ArrayBuffer(bin.length));
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      key = await putAsset(bytes, 'image/jpeg');
    }
  } catch {
    // 拍不了照也照样收工
  }
  const ids = new Set(room.value.items.map((i) => i.id));
  const added = [...addedIds.value].filter((id) => ids.has(id)).length;
  const herAdded = [...herIds.value].filter((id) => ids.has(id)).length;
  const card: MessagePart = { type: 'game', logId: uid('game'), game: 'decor', room: room.value.name, items: room.value.items.length, added, herAdded, ...(key ? { photo: key } : {}) };
  chat.postCard(chatId.value, 'user', card);
  emit('done', `装修小屋「${room.value.name}」`);
  emit('progress', null);
  phase.value = 'end';
  const changes = [...log.value];
  await herReply('decor-end', undefined, [changes.length ? '' : '（这一次没怎么改，就是来看看）'], '收工');
  // 接着装就是新的一次
  log.value = [];
  addedIds.value = new Set();
  herIds.value = new Set();
  phase.value = 'menu';
}

const hint = computed(() =>
  mode.value === 'edit'
    ? '点家具选中；双指拖动或拧转换视角，捏合缩放'
    : '点家具使用，点地面起身走动；也可以直接和角色说',
);
</script>

<template>
  <div class="decor" data-game="decor">
    <div v-if="!presetReady" class="warn">
      <span class="i-lucide-triangle-alert shrink-0" />
      <span class="flex-1 min-w-0">"一起游戏 · 装修小屋"选的预设里没有装修的几步，{{ her.pronoun }}的布置方案会读不出来</span>
      <button type="button" class="text-accent-ink shrink-0" @click="router.push('/me/presets')">去看看</button>
    </div>

    <div class="rooms" role="tablist" aria-label="房间">
      <button v-for="(r, i) in rooms" :key="r.id" type="button" role="tab" class="room-tab" :class="{ on: i === home.current }" :aria-selected="i === home.current" :data-room="r.type" @click="goRoom(i)">
        <span :class="roomType(r.type).icon" />{{ r.name }}
      </button>
      <button v-if="rooms.length < MAX_ROOMS" type="button" class="room-tab add" aria-label="添一个房间" @click="addRoomOpen = true"><span class="i-lucide-plus" />添房间</button>
    </div>

    <div class="view" :data-lighting="lighting" :style="{ '--room-bg': LIGHTING[lighting].background, '--room-sky': LIGHTING[lighting].skyBottom }">
      <canvas ref="canvas" class="block w-full h-full" aria-label="3D 小屋：点家具选中，拖着挪；两根手指拖动或拧转换视角" />
      <RoomBubbles :anchors="bubbleAnchors" :messages="bubbles" :names="{ you: userName, her: her.name }" />
      <div v-if="webglFailed" class="fallback">这台设备打不开 3D 画面（WebGL），装修小屋玩不了</div>
      <div class="view-top">
        <div class="modes" role="tablist">
          <button type="button" role="tab" :aria-selected="mode === 'edit'" :class="{ on: mode === 'edit' }" @click="mode = 'edit'"><span class="i-lucide-hammer" />布置</button>
          <button type="button" role="tab" :aria-selected="mode === 'live'" :class="{ on: mode === 'live' }" @click="enterLive"><span class="i-lucide-footprints" />逛逛</button>
        </div>
        <span class="flex-1" />
        <button type="button" class="round light-button" :aria-label="`房间光照：${LIGHTING[lighting].label}`" @click="lightingOpen = true"><span :class="LIGHTING[lighting].icon" /><span>{{ LIGHTING[lighting].label }}</span></button>
        <button type="button" class="round" aria-label="视角回到正面" @click="engine?.resetView()"><span class="i-lucide-locate-fixed" /></button>
        <button type="button" class="round" aria-label="拍一张" @click="photo"><span class="i-lucide-camera" /></button>
      </div>
      <div v-if="!(selected && mode === 'edit')" class="hint">{{ hint }}</div>
      <!-- 选中的家具 -->
      <div v-if="selected && selectedCat && mode === 'edit'" class="sel" data-panel="selected">
        <div class="flex items-center gap-2">
          <span class="min-w-0">
            <span class="block font-600 text-[14px] truncate">{{ selectedCat.name }}<span v-if="selected.by" class="text-[11.5px] text-ink-3 font-400"> · {{ selected.by === 'her' ? `${her.pronoun}放的` : '你放的' }}</span></span>
            <span class="block text-[11px] text-ink-3 truncate">按住它拖着挪</span>
          </span>
          <span class="flex-1" />
          <button v-if="selected.kind === 'radio'" type="button" class="tool-sm" aria-label="打开收音机" @click="radioOpen = true"><span class="i-lucide-music-2" /></button>
          <button v-if="selectedCat.place !== 'wall'" type="button" class="tool-sm" aria-label="转个方向" @click="turnSelected"><span class="i-lucide-rotate-cw" /></button>
          <button type="button" class="tool-sm" aria-label="再放一个" @click="duplicate"><span class="i-lucide-copy" /></button>
          <button type="button" class="tool-sm" aria-label="收起来" @click="stash"><span class="i-lucide-trash-2" /></button>
          <button type="button" class="tool-sm on" aria-label="好了" @click="select(null)"><span class="i-lucide-check" /></button>
        </div>
        <div class="swatches">
          <button
            v-for="c in selectedCat.colors"
            :key="c"
            type="button"
            class="swatch"
            :class="{ on: itemColor(selected) === c }"
            :style="{ background: c }"
            :aria-label="colorName(c)"
            :title="colorName(c)"
            @click="recolor(c)"
          />
          <label class="swatch custom" aria-label="自己调颜色"><input type="color" :value="itemColor(selected)" @change="recolor(($event.target as HTMLInputElement).value)" /><span class="i-lucide-plus" /></label>
        </div>
      </div>
    </div>

    <div class="life-bar">
      <span class="life-dot" :class="{ awake: mode === 'live' && lifeEnabled && lifeConnected, thinking: lifeThinking }" aria-hidden="true" />
      <span class="life-copy" role="status">{{ lifeMessage }}</span>
      <button v-if="lifeError && lifeConnected && mode === 'live'" type="button" class="life-link" @click="life.request()">重试</button>
      <button type="button" class="life-link" aria-label="小屋生活 API 与预设" @click="lifeOpen = true"><span class="i-lucide-sliders-horizontal" />生活设置</button>
    </div>
    <div class="tools">
      <button type="button" class="tool" @click="openCatalog"><span class="i-lucide-armchair" />家具</button>
      <button type="button" class="tool" @click="finishOpen = true"><span class="i-lucide-paint-roller" />房间</button>
      <button type="button" class="tool" @click="openAvatar('you')"><span class="i-lucide-user-round-pen" />捏人</button>
      <button type="button" class="tool icon" :disabled="!undoStack.length" aria-label="撤销" @click="undo"><span class="i-lucide-undo-2" /></button>
      <button type="button" class="tool icon" :disabled="!redoStack.length" aria-label="重做" @click="redo"><span class="i-lucide-redo-2" /></button>
    </div>

    <button v-if="hasRadio" type="button" class="room-radio" @click="radioOpen = true">
      <span class="i-lucide-radio" aria-hidden="true" /><span><strong>{{ decorRadio.state.playing ? radioSong?.title : '小屋收音机' }}</strong><small>{{ decorRadio.state.playing ? radioSong?.artist : '选择网易云歌单，让音乐留在房间里' }}</small></span><span :class="decorRadio.state.playing ? 'i-lucide-volume-2' : 'i-lucide-chevron-right'" aria-hidden="true" />
    </button>
    <DecorRadio v-if="hasRadio" :key="room.id" v-model="radioOpen" />

    <!-- 她 -->
    <div class="her-row">
      <van-button size="small" round :loading="busy === 'look'" :disabled="!!busy && busy !== 'look'" @click="look">问问{{ her.pronoun }}</van-button>
      <van-button size="small" round :loading="busy === 'plan'" loading-text="在摆…" :disabled="!!busy && busy !== 'plan'" @click="planOpen = true">让{{ her.pronoun }}布置</van-button>
      <van-button size="small" round type="primary" :loading="busy === 'end'" :disabled="!!busy && busy !== 'end'" @click="finish">收工</van-button>
    </div>
    <div class="flex gap-2 mt-2">
      <input v-model="talkText" class="field" :placeholder="mode === 'live' ? '和角色说，例如「去做点饭吧」…' : `边装边和${her.pronoun}说…`" aria-label="说的话" @keydown.enter="talk" />
      <van-button size="small" round :loading="busy === 'chat' || lifeThinking" :disabled="!talkText.trim() || (!!busy && busy !== 'chat')" @click="talk">说</van-button>
    </div>

    <van-popup v-model:show="lifeOpen" position="bottom" round teleport="body" :style="{ maxHeight: '85%', width: 'min(100%, 480px)', left: 'max(0px, calc((100% - 480px) / 2))' }">
      <section class="sheet life-settings" aria-label="小屋生活设置">
        <div class="life-heading"><div><div class="sheet-title">小屋里的日常</div><p>看见彼此，做一点自己的事。</p></div><button type="button" class="tool-sm" aria-label="关闭生活设置" @click="lifeOpen = false"><span class="i-lucide-x" /></button></div>
        <div class="life-setting"><div><strong>自主活动</strong><small>逛逛时观察房间、使用家具并说话</small></div><button type="button" role="switch" :aria-checked="lifeEnabled" aria-label="自主活动" class="life-switch" :class="{ on: lifeEnabled }" @click="toggleLife"><span /></button></div>
        <label class="life-setting"><span><strong>观察间隔</strong><small>每次行动结束后，再等一会儿</small></span><select v-model="lifeInterval" aria-label="观察间隔"><option :value="20">20 秒</option><option :value="40">40 秒</option><option :value="90">90 秒</option></select></label>
        <RouterLink to="/me/api?feature=decor" class="life-setting" @click="lifeOpen = false"><span><strong>小屋 · 角色生活 API</strong><small>{{ lifeConnected ? '已连接 · 可独立选择渠道和模型' : '待连接 · 设置地址、Key 和模型' }}</small></span><span class="i-lucide-chevron-right" /></RouterLink>
        <button type="button" class="life-setting" @click="lifeOpen = false; lifePresetOpen = true"><span><strong>角色生活预设</strong><small>{{ lifePreset?.name ?? '选择一个行为预设' }}</small></span><span class="i-lucide-chevron-right" /></button>
        <RouterLink v-if="lifePreset" :to="`/me/presets/${lifePreset.id}`" class="life-edit" @click="lifeOpen = false">编辑行为习惯、说话方式和模型参数 <span class="i-lucide-arrow-up-right" /></RouterLink>
        <p class="life-note">模型能看到当前房间、家具空位、双方小人的姿态和设备状态。切到布置、离开页面或收工时会暂停自主活动。收音机使用你配置的网易云音乐服务。</p>
        <p v-if="lifeError" class="life-note" role="alert">{{ lifeError }}</p>
      </section>
    </van-popup>
    <van-popup v-model:show="lifePresetOpen" position="bottom" round teleport="body" :style="{ maxHeight: '85%', width: 'min(100%, 480px)', left: 'max(0px, calc((100% - 480px) / 2))' }">
      <section class="sheet"><div class="life-heading"><div class="sheet-title">角色生活预设</div><button type="button" class="tool-sm" aria-label="关闭生活预设" @click="lifePresetOpen = false"><span class="i-lucide-x" /></button></div><PresetPicker :model-value="lib.useChoice('decor-life')" category="feature" :first="p => p.id === 'preset-decor-life'" @update:model-value="id => { lib.setUse('decor-life', id); lifePresetOpen = false; }" @edit="lifePresetOpen = false" /></section>
    </van-popup>

    <!-- 家具目录 -->
    <van-popup v-model:show="catalogOpen" position="bottom" round teleport="body" :style="{ height: '86%', width: 'min(100%, 480px)', left: 'max(0px, calc((100% - 480px) / 2))' }">
      <div class="sheet catalog-sheet" data-sheet="catalog">
        <div class="catalog-heading"><div class="sheet-title">家具库 <span>{{ CATALOG.length }} 件</span></div><button type="button" class="catalog-close" aria-label="关闭家具库" @click="catalogOpen = false"><span class="i-lucide-x" /></button></div>
        <label class="catalog-search"><span class="i-lucide-search" aria-hidden="true" /><input v-model="catalogSearch" type="search" placeholder="搜索家具，如课桌、浴池、收音机" aria-label="搜索家具" /></label>
        <div class="catalog-filters"><label for="decor-style-filter">家具风格</label><select id="decor-style-filter" v-model="catalogStyle"><option value="all">全部风格</option><option v-for="s in ROOM_STYLES" :key="s.id" :value="s.id">{{ s.name }}</option><option value="common">通用家具</option></select></div>
        <div class="cats" aria-label="家具分类">
          <button type="button" class="cat" :class="{ on: cat === 'all' }" :aria-pressed="cat === 'all'" @click="cat = 'all'">全部</button>
          <button v-for="c in CATEGORIES" :key="c.id" type="button" class="cat" :class="{ on: cat === c.id }" :aria-pressed="cat === c.id" @click="cat = c.id"><span :class="c.icon" />{{ c.label }}</button>
        </div>
        <div class="catalog-results" aria-live="polite">{{ catItems.length }} 件家具<span>点击摆入当前房间</span></div>
        <div class="catalog-list">
          <div v-if="catItems.length" class="grid">
            <button v-for="c in catItems" :key="c.id" type="button" class="cell press" :data-kind="c.id" @click="addFromCatalog(c.id)">
              <img v-if="thumbs[c.id]" :src="thumbs[c.id]" alt="" class="thumb" />
              <span v-else class="thumb ph" :style="{ background: c.colors[0] }" />
              <span class="cell-name">{{ c.name }}</span>
            </button>
          </div>
          <p v-else class="catalog-empty">这里没有匹配的家具。试试其他分类或清空搜索。</p>
        </div>
      </div>
    </van-popup>

    <!-- 墙和地面 -->
    <van-popup v-model:show="finishOpen" position="bottom" round teleport="body" :style="{ maxHeight: '88%', width: 'min(100%, 480px)', left: 'max(0px, calc((100% - 480px) / 2))' }">
      <div class="sheet" data-sheet="finishes">
        <RoomStylePicker :key="`${room.id}:${finishOpen}`" :current="homeStyle" @apply="applyStyle" />
        <div class="sheet-title">房间设置</div>
        <div class="label">房间的名字</div>
        <input v-model="nameDraft" class="field w-full" maxlength="16" :placeholder="roomType(room.type).name" aria-label="房间的名字" />
        <div class="label">房间大小</div>
        <div class="chips">
          <button v-for="s in ROOM_SIZES" :key="s.label" type="button" class="chip-btn" :class="{ on: room.w === s.w && room.d === s.d }" @click="setSize(s.w, s.d)">{{ s.label }}（{{ s.w }} × {{ s.d }}）</button>
        </div>
        <template v-for="key in ['wall', 'floor'] as const" :key="key">
          <div class="label">{{ key === 'wall' ? '墙纸' : '地面' }}</div>
          <div class="chips">
            <button v-for="f in key === 'wall' ? WALL_FINISHES : FLOOR_FINISHES" :key="f.id" type="button" class="chip-btn" :class="{ on: room[key].finish === f.id }" @click="setFinish(key, { finish: f.id })">{{ f.name }}</button>
          </div>
          <div class="swatches mt-2">
            <button
              v-for="p in PALETTE"
              :key="p.hex"
              type="button"
              class="swatch"
              :class="{ on: room[key].color === p.hex }"
              :style="{ background: p.hex }"
              :aria-label="p.name"
              :title="p.name"
              @click="setFinish(key, { color: p.hex })"
            />
          </div>
        </template>
        <button v-if="rooms.length > 1" type="button" class="danger" @click="removeRoom"><span class="i-lucide-trash-2" />拆掉这个房间</button>
      </div>
    </van-popup>

    <van-popup v-model:show="lightingOpen" position="bottom" round teleport="body">
      <div class="sheet" data-sheet="lighting">
        <div class="sheet-title">留住喜欢的光</div>
        <div class="light-options">
          <button v-for="(p, key) in LIGHTING" :key="key" type="button" class="light-option" :aria-pressed="lighting === key" @click="setLighting(key)">
            <span class="light-preview" :style="{ background: `linear-gradient(${p.skyTop}, ${p.skyBottom})` }"><span :class="p.icon" /></span>
            {{ p.label }}
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 添一个房间 -->
    <van-popup v-model:show="addRoomOpen" position="bottom" round teleport="body">
      <div class="sheet" data-sheet="add-room">
        <div class="sheet-title">添一个什么房间？</div>
        <div class="text-[12.5px] text-ink-3">现在 {{ rooms.length }} 间，最多 {{ MAX_ROOMS }} 间；添好会先摆上几件家具，名字、大小、墙纸之后都能改</div>
        <div class="grid mt-2.5">
          <button v-for="t in ROOM_TYPES" :key="t.id" type="button" class="cell press" :data-type="t.id" @click="addRoom(t.id)">
            <span class="type-icon"><span :class="t.icon" /></span>
            <span class="cell-name">{{ t.name }}</span>
          </button>
        </div>
      </div>
    </van-popup>

    <!-- 让她布置：想要什么 -->
    <van-popup v-model:show="planOpen" position="bottom" round teleport="body">
      <div class="sheet" data-sheet="plan">
        <div class="sheet-title">想让{{ her.pronoun }}怎么布置？</div>
        <div class="text-[12.5px] text-ink-3">可以不写，{{ her.pronoun }}按自己的喜好来；{{ her.pronoun }}一次改几样，放不下的会在附近找空地</div>
        <div class="chips mt-2.5">
          <button v-for="w in WISHES" :key="w" type="button" class="chip-btn" :class="{ on: wish === w }" @click="wish = wish === w ? '' : w">{{ w }}</button>
        </div>
        <input v-model="wish" class="field w-full mt-2.5" placeholder="比如：窗边放张书桌" aria-label="想要什么" @keydown.enter="herPlan" />
        <van-button type="primary" round block class="!mt-3" @click="herPlan">交给{{ her.pronoun }}</van-button>
      </div>
    </van-popup>

    <AvatarEditor v-model:show="avatarOpen" :you="home.you" :her="home.her" :her-name="her.name" :her-pronoun="her.pronoun" :start="avatarWho" :design="design" @save="saveAvatar" />
  </div>
</template>

<style scoped>
.life-bar { display: flex; flex: none; align-items: center; gap: 7px; min-height: 38px; padding: 7px 2px 3px; }
.life-dot { width: 6px; height: 6px; flex: none; border-radius: 50%; background: var(--ink-3); opacity: .45; }
.life-dot.awake { background: #6c926a; opacity: 1; }
.life-dot.thinking { animation: life-pulse 1.4s ease-in-out infinite; }
.life-copy { flex: 1; min-width: 0; font-size: 11px; color: var(--ink-2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.life-link { display: inline-flex; align-items: center; gap: 4px; flex: none; min-height: 32px; font-size: 11px; color: var(--accent-ink); }
.life-heading { display: flex; align-items: start; justify-content: space-between; margin-bottom: 18px; }
.life-heading p { font-size: 12px; color: var(--ink-3); margin: 5px 0 0; }
.life-setting { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 16px 0; text-align: left; border-bottom: 1px solid var(--border); color: var(--ink); }
.life-setting strong { display: block; font-size: 14px; font-weight: 600; }
.life-setting small { display: block; font-size: 12px; color: var(--ink-3); line-height: 1.5; margin-top: 4px; }
.life-setting select { border: 1px solid var(--border); padding: 8px; border-radius: 8px; background: var(--panel); font-size: 13px; }
.life-switch { flex: none; width: 44px; height: 26px; padding: 3px; border-radius: 99px; background: var(--border); }
.life-switch span { display: block; width: 20px; height: 20px; border-radius: 50%; background: white; box-shadow: 0 1px 3px #0002; transition: transform .15s; }
.life-switch.on { background: #6e8c6a; }
.life-switch.on span { transform: translateX(18px); }
.life-edit { display: inline-flex; align-items: center; gap: 4px; margin-top: 16px; color: var(--accent-ink); font-size: 12px; }
.life-note { font-size: 12px; line-height: 1.75; color: var(--ink-3); margin-top: 22px; }
@keyframes life-pulse { 50% { opacity: .3; } }
@media (prefers-reduced-motion: reduce) { .life-dot.thinking { animation: none; } .life-switch span { transition: none; } }
.decor {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}
.warn {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.rooms {
  display: flex;
  /* 横向能滑就成了滚动容器，min-height 变成 0；不写 flex: none 的话手机上高度不够时会被 3D 画面挤成 0 高，标签整排看不见 */
  flex: none;
  gap: 6px;
  margin-bottom: 8px;
  overflow-x: auto;
  scrollbar-width: none;
}
.rooms::-webkit-scrollbar {
  display: none;
}
.room-tab {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.room-tab.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
  outline-offset: -1px;
}
.room-tab.add {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--ink-3);
}
.type-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  border-radius: 14px;
  background: var(--surface);
  color: var(--accent-ink);
  font-size: 20px;
}
.danger {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  flex: none;
  height: 38px;
  margin-top: 18px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--bad);
  font-size: 13.5px;
}
.view {
  position: relative;
  flex: 1;
  min-height: 240px;
  border-radius: 20px;
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 25%, color-mix(in srgb, var(--room-sky) 24%, var(--room-bg)), var(--room-bg) 75%);
  border: 1px solid var(--border);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
}
@supports not (background: color-mix(in srgb, red 10%, transparent)) {
  .view {
    background: var(--panel);
  }
}
.fallback {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  text-align: center;
  color: var(--ink-3);
  font-size: 13px;
}
.view-top {
  position: absolute;
  top: 8px;
  left: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.view-top > * {
  pointer-events: auto;
}
.modes {
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 99px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
}
.modes button {
  white-space: nowrap;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border-radius: 99px;
  font-size: 12.5px;
  color: var(--ink-2);
}
.modes button.on {
  background: var(--accent);
  color: var(--on-accent);
}
.round {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  color: var(--ink);
  font-size: 16px;
}
.light-button {
  white-space: nowrap;
  flex: none;
  width: auto;
  gap: 5px;
  padding: 0 11px;
  border-radius: 99px;
  font-size: 12px;
}
.light-button > :first-child {
  font-size: 15px;
}
.room-radio { display: flex; align-items: center; width: 100%; gap: 12px; padding: 10px 2px 13px; text-align: left; border-bottom: 1px solid var(--border); margin-bottom: 12px; }
.room-radio > :first-child { font-size: 24px; color: var(--accent-ink); flex: none; }
.room-radio > span:nth-child(2) { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1; }
.room-radio strong { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.room-radio small { font-size: 11px; color: var(--ink-2); }
.room-radio:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 2px; }
.light-option[aria-pressed='true'] { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.light-options {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.light-option {
  padding: 6px 6px 10px;
  border: 1px solid var(--border);
  border-radius: 14px;
  color: var(--ink);
  font-size: 13px;
}
.light-preview {
  display: grid;
  place-items: center;
  height: 64px;
  margin-bottom: 8px;
  border-radius: 9px;
  color: #fff8e9;
  font-size: 26px;
}
.hint {
  position: absolute;
  left: 50%;
  bottom: 8px;
  transform: translateX(-50%);
  max-width: calc(100% - 16px);
  padding: 3px 10px;
  border-radius: 99px;
  background: var(--glass);
  color: var(--ink-3);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.tools {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.sel {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  touch-action: manipulation;
}
.tool {
  display: inline-flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  height: 36px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink);
  font-size: 13px;
  white-space: nowrap;
}
.tool.icon {
  flex: 0 0 36px;
}
.tool:disabled {
  opacity: 0.4;
}
.tool-sm {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--ink);
  font-size: 16px;
}
.tool-sm.on {
  background: var(--accent);
  border-color: transparent;
  color: var(--on-accent);
}
.swatches {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.swatch {
  position: relative;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 1px solid var(--border);
}
.swatch.on {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.swatch.custom {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  background: conic-gradient(#f4b6c2, #f6e09a, #b5dfc9, #a9c4e0, #c9b8e8, #f4b6c2);
  color: #fff;
}
.swatch.custom input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.her-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  gap: 6px;
  margin-top: 10px;
}
.her-row :deep(.van-button) {
  padding: 0 6px;
  white-space: nowrap;
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.sheet {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px 16px calc(var(--safe-bottom) + 16px);
  overflow-y: auto;
}
.sheet .field {
  flex: none;
}
.sheet-title {
  margin-bottom: 8px;
  font-size: 15px;
  font-weight: 600;
}
.label {
  margin: 14px 0 6px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.chip-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.chip-btn.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.cats {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 3px 1px;
}
.cat {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  min-height: 34px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.cat.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
  margin-top: 10px;
}
.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 8px 4px;
  border-radius: 14px;
  background: var(--panel);
}
.thumb {
  width: 72px;
  height: 72px;
  object-fit: contain;
}
.thumb.ph {
  width: 44px;
  height: 44px;
  margin: 14px;
  border-radius: 12px;
  opacity: 0.6;
}
.cell-name {
  font-size: 12.5px;
  color: var(--ink-2);
}

.catalog-sheet { overflow: hidden; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
.catalog-heading { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.catalog-heading .sheet-title { margin: 0; }
.catalog-heading .sheet-title span { font-size: 12px; font-weight: 400; color: var(--ink-2); margin-left: 6px; }
.catalog-close { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%; background: var(--panel); color: var(--ink-2); }
.catalog-search { display: flex; align-items: center; gap: 8px; min-height: 42px; padding: 0 12px; background: var(--panel); border-radius: 10px; color: var(--ink-2); }
.catalog-search input { min-width: 0; width: 100%; background: transparent; border: 0; font-size: 13px; color: var(--ink); padding: 11px 0; }
.catalog-filters { display: flex; gap: 12px; align-items: center; margin: 12px 0 10px; font-size: 12px; color: var(--ink-2); }
.catalog-filters select { flex: 1; min-width: 0; min-height: 38px; border: 1px solid var(--border); border-radius: 8px; background: var(--panel); color: var(--ink); padding: 0 10px; }
.catalog-results { display: flex; justify-content: space-between; gap: 8px; padding: 12px 0 4px; color: var(--ink-2); font-size: 12px; }
.catalog-results > span { font-size: 11px; }
.catalog-list { min-height: 0; overflow-y: auto; flex: 1; overscroll-behavior: contain; padding: 2px 2px 12px; scrollbar-color: var(--accent-line) transparent; scrollbar-width: thin; }
.catalog-empty { padding: 35px 20px; text-align: center; color: var(--ink-2); font-size: 13px; line-height: 1.7; }
.catalog-sheet > :not(.catalog-list) { flex-shrink: 0; }
.catalog-sheet button:focus-visible, .catalog-filters select:focus-visible, .catalog-search:focus-within { outline: 2px solid var(--accent-ink); outline-offset: 2px; }
</style>
