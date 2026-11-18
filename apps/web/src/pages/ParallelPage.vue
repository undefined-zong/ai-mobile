<script setup lang="ts">
import { errorText } from '@app/ai';
import { dayMinute, entryLabel, nowDayMinute, shiftDate, PARALLEL_PER_DAY_MAX, PARALLEL_USER, WEEKDAY_LABEL, toMinutes, zonedParts, type ParallelEntry, type ParallelEntryKind, type ParallelNote, type ParallelRef, type ParallelSide } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import {
  arrangeDay,
  arrangedState,
  decideRequest,
  editEntry,
  hiddenEntries,
  herTimeline,
  myEntries,
  parallelStatus,
  parallelToday,
  personaFor,
  planStatus,
  postNote,
  removeEntry,
  replyTo,
  requestChange,
  restoreEntry,
  sendNote,
  toggleCheck,
  toggleEntry,
  userReply,
  type EntryEdit,
} from '@/services/parallel';
import { calendarState, linkToCalendar, syncItemCalendar, unlinkCalendar } from '@/services/calendarSync';
import { applyCapture, captureStatus, draftCapture, type CaptureResult } from '@/services/parallelCapture';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useEnvironmentStore } from '@/stores/environment';
import { useHubStore } from '@/stores/hub';
import { useParallelStore } from '@/stores/parallel';
import { usePlannerStore } from '@/stores/planner';
import { useRhythmStore } from '@/stores/rhythm';
import { uid } from '@/utils/id';

/**
 * 平行时空（设计文档 §9.16）：她今天的节律在左，你今天的安排在右，排在同一条时间线上（照着一左一右的时间轴：
 * 内容在自己那一边，时间在对面；过去的线是实线，还没到的是虚线，中间标出现在）。
 * 先看此刻：顶上一张"此刻"卡，左边她这会儿在做什么、右边你接下来那件，她最近的留言钉在下面；
 * 时间线只展开"现在"前后（最近一小时、她此刻那段、你正在做的，和之后三小时），其余收起来，点开看全天；不定时的收在"随时"里。
 * - 你的那一边：每天到点（设置里改）把日程计划、家务、健康计划整理成的一份计划（还没整理时几份直接列出来）和你自己记的事；
 *   点圆圈或勾勾掉（整理好的一项把它合成的那几项一起勾），点开改、删，"＋"记一件：自己填，或者随口说一句让 AI 记
 *   （整理成要做的事、避开这几天的安排和 Google 日历里的排进去，你看过再记）；开着同步时新记的写进 Google 日历；
 * - 留言也排在时间线上（她留的在左、你留的在右）：你可以给她留言、请她改今天的日程（她可能不答应），点开看来回的回复；
 * - 她也会自己给你留言：云端每天在随机的时间留（App 关着也留），没连云端时 App 开着按同样的时间留。右上角设置里改。
 */
const route = useRoute();
const app = useAppStore();
const chars = useCharacterStore();
const parallel = useParallelStore();
const rhythm = useRhythmStore();
const env = useEnvironmentStore();
const hub = useHubStore();

const character = computed(() => chars.byId(route.params.charId as string) ?? chars.byId(app.activeCharacterId) ?? chars.list[0] ?? null);
const persona = computed(() => personaFor(character.value?.id ?? ''));
const pronoun = computed(() => character.value?.pronoun ?? '她');
const today = computed(() => parallelToday());
const status = computed(() => parallelStatus(character.value ?? undefined));
const cloud = computed(() => hub.connected && hub.supportsParallel);

// 每分钟往前走一格："现在"、她此刻那一段、过了时间没做的家务跟着变
const tick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => (tick.value = Date.now()), 60_000);
});
onBeforeUnmount(() => clearInterval(timer));
const nowMin = computed(() => (void tick.value, nowDayMinute(Date.now(), env.settings.timezone)));

const her = computed(() => (void tick.value, character.value ? herTimeline(character.value.id) : []));
const mine = computed(() => (void tick.value, myEntries(persona.value)));
const hidden = computed(() => (void tick.value, hiddenEntries(persona.value)));
const herNow = computed(() => her.value.find((e) => e.now));
const herDay = computed(() => (character.value ? rhythm.todayOf(character.value.id) : null));
const doneCount = computed(() => mine.value.filter((e) => e.done).length);
const arranged = computed(() => (void tick.value, arrangedState(persona.value)));
const planCheck = computed(() => planStatus());
async function arrangeNow() {
  const r = await arrangeDay(persona.value);
  showToast(r.ok ? '整理好了' : { message: r.reason, duration: 3000 });
}
const todayNotes = computed(() => (character.value ? parallel.notesOf(character.value.id, today.value) : []));
const olderNotes = computed(() => (character.value ? parallel.notesOf(character.value.id).filter((n) => n.date < today.value).reverse() : []));
const cloudError = computed(() => hub.parallelErrors.find((e) => e.characterId === character.value?.id && e.date === today.value));
const dateText = computed(() => {
  const d = today.value;
  return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${WEEKDAY_LABEL[new Date(`${d}T12:00:00Z`).getUTCDay()]}`;
});

// —— 时间线：两边的事和今天的留言按时间排；不定时的（你的待办、随时做的家务）排在最前面 ——

interface Row {
  id: string;
  side: ParallelSide;
  min: number | null;
  past: boolean;
  entry?: ParallelEntry;
  note?: ParallelNote;
}
function noteMinute(n: ParallelNote): number {
  const p = zonedParts(n.at, env.settings.timezone);
  return dayMinute(p.hour * 60 + p.minute);
}
const rows = computed(() => {
  const now = nowMin.value;
  const list: Row[] = [
    ...her.value.map((e): Row => ({ id: e.key, side: 'her', min: e.start, past: (e.end ?? e.start ?? 0) <= now, entry: e })),
    ...mine.value.map((e): Row => ({ id: e.key, side: 'me', min: e.start, past: e.start !== null && (e.end ?? e.start) <= now, entry: e })),
    ...todayNotes.value.map((n): Row => ({ id: n.id, side: n.authorId === PARALLEL_USER ? 'me' : 'her', min: noteMinute(n), past: true, note: n })),
  ];
  return {
    untimed: list.filter((r) => r.min === null),
    timed: list.filter((r) => r.min !== null).sort((a, b) => (a.min as number) - (b.min as number)),
  };
});
/** "现在"那条线插在第几行前面 */
const nowIndex = computed(() => {
  const i = rows.value.timed.findIndex((r) => (r.min as number) > nowMin.value);
  return i < 0 ? rows.value.timed.length : i;
});
/**
 * 默认只展开"现在"前后：之前的留最近一小时、她此刻那段、你正在做的，其余收成一条；之后的放三小时（至少三项），其余也收成一条。
 * 点开看全天，再点收起
 */
const RECENT_MIN = 60;
const AHEAD_MIN = 180;
const AHEAD_ROWS = 3;
const showPast = ref(false);
const showLater = ref(false);
function keepPast(r: Row, now: number): boolean {
  // 她最近那条留言已经钉在此刻卡片下面了，收起来时不再重复
  if (r.note) return r.note.id !== herLatest.value?.id && (r.min as number) >= now - RECENT_MIN;
  if ((r.min as number) >= now - RECENT_MIN) return true;
  const e = r.entry;
  if (!e) return false;
  return !!e.now || (r.side === 'me' && !e.done && e.end !== null && now < e.end);
}
const split = computed(() => {
  const now = nowMin.value;
  const timed = rows.value.timed;
  const cut = nowIndex.value;
  const past = timed.slice(0, cut);
  const future = timed.slice(cut);
  const pastFolded = past.filter((r) => !keepPast(r, now));
  let n = future.findIndex((r) => (r.min as number) >= now + AHEAD_MIN);
  if (n < 0) n = future.length;
  n = Math.max(n, Math.min(AHEAD_ROWS, future.length));
  return {
    past: showPast.value ? past : past.filter((r) => keepPast(r, now)),
    pastFolded,
    future: showLater.value ? future : future.slice(0, n),
    laterFolded: future.slice(n),
  };
});
/** 收起来的那一条写什么：之前几件、你做完几件、几条留言 */
const pastFoldText = computed(() => {
  const list = split.value.pastFolded;
  const entries = list.filter((r) => r.entry);
  const minePast = entries.filter((r) => r.side === 'me');
  const notes = list.length - entries.length;
  return [
    entries.length ? `之前 ${entries.length} 件` : '',
    minePast.length ? `你做完 ${minePast.filter((r) => r.entry!.done).length}/${minePast.length}` : '',
    notes ? `${notes} 条留言` : '',
  ].filter(Boolean).join(' · ');
});
const laterFoldText = computed(() => `之后还有 ${split.value.laterFolded.length} 件`);

/**
 * 时间线分成"现在"之前、之后两段，每段从头到尾画一整条中轴线（之前实线、之后虚线），节点都压在这条线上：
 * 不靠一行一行拼线，收起来的那一条、"现在"那条线经过的地方也不断
 */
type LaneItem = { type: 'fold'; id: 'past' | 'later'; open: boolean; text: string } | { type: 'now'; id: string } | { type: 'row'; id: string; row: Row; future: boolean };
const lanes = computed(() => {
  const s = split.value;
  const before: LaneItem[] = [
    ...(s.pastFolded.length ? [{ type: 'fold' as const, id: 'past' as const, open: showPast.value, text: showPast.value ? '收起之前的' : pastFoldText.value }] : []),
    ...s.past.map((r): LaneItem => ({ type: 'row', id: r.id, row: r, future: false })),
    ...(rows.value.timed.length ? [{ type: 'now' as const, id: 'now' }] : []),
  ];
  const after: LaneItem[] = [
    ...s.future.map((r): LaneItem => ({ type: 'row', id: r.id, row: r, future: true })),
    ...(s.laterFolded.length ? [{ type: 'fold' as const, id: 'later' as const, open: showLater.value, text: showLater.value ? '收起之后的' : laterFoldText.value }] : []),
  ];
  return [
    { key: 'before', items: before },
    { key: 'after', items: after },
  ].filter((l) => l.items.length);
});
function toggleFold(id: 'past' | 'later') {
  if (id === 'past') showPast.value = !showPast.value;
  else showLater.value = !showLater.value;
}

// —— 随时：不定时的（你的待办、随时做的家务、没写时间的）收在此刻卡片下面一条里 ——
const anytime = computed(() => rows.value.untimed.filter((r) => r.entry));
const anytimeOpen = ref(false);
const anytimeText = computed(() => anytime.value.map((r) => r.entry!.title).join(' · '));
const anytimeDone = computed(() => anytime.value.filter((r) => r.entry!.done).length);

// —— 此刻：她这会儿在做什么、你接下来那件 ——
/** "1 小时 40 分" / "25 分钟" */
function spanText(min: number): string {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} 小时 ${m % 60} 分` : `${h} 小时`;
}
const herNext = computed(() => her.value.find((e) => e.start !== null && e.start > nowMin.value) ?? null);
const herLeft = computed(() => (herNow.value?.end != null ? herNow.value.end - nowMin.value : null));
/** 你这边此刻该看的那件：正在进行的 → 接下来最近的 → 不定时的；都做完了为空 */
const myFocus = computed(() => {
  const now = nowMin.value;
  const open = mine.value.filter((e) => !e.done);
  const timed = open.filter((e) => e.start !== null).sort((a, b) => (a.start as number) - (b.start as number));
  return timed.find((e) => (e.start as number) <= now && e.end !== null && now < e.end) ?? timed.find((e) => (e.start as number) > now) ?? open.find((e) => e.start === null) ?? null;
});
const focusState = computed((): { label: string; when: string } => {
  const e = myFocus.value;
  if (!e) return { label: '', when: '' };
  if (e.start === null) return { label: '随时可以做', when: '' };
  const now = nowMin.value;
  if (e.start <= now) return { label: '现在', when: e.end !== null ? `还有 ${spanText(e.end - now)}` : '' };
  // 三小时以内写还有多久，再远只写几点
  const gap = e.start - now;
  return { label: '接下来', when: gap < AHEAD_MIN ? `${clockOf(e.start)} · ${spanText(gap)}后` : clockOf(e.start) };
});
const nowText = computed(() => {
  const p = zonedParts(tick.value, env.settings.timezone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
});

function iconOf(r: Row): string {
  if (r.note) return r.note.authorId !== PARALLEL_USER ? 'i-lucide-message-circle-heart' : r.note.kind === 'request' ? 'i-lucide-calendar-sync' : 'i-lucide-message-square-heart';
  const e = r.entry!;
  return e.icon || kindIcon(e.kind === 'merged' ? (e.via ?? 'plan') : e.kind, e);
}
function kindIcon(kind: ParallelEntryKind, e: ParallelEntry): string {
  switch (kind) {
    case 'slot':
      return 'i-lucide-map-pin';
    case 'plan':
      return e.fixed ? 'i-lucide-calendar-clock' : 'i-lucide-calendar-check';
    case 'chore':
      return 'i-lucide-house';
    case 'workout':
      return 'i-lucide-dumbbell';
    case 'meal':
      return 'i-lucide-utensils';
    case 'todo':
      return 'i-lucide-list-checks';
    default:
      return e.checklist ? 'i-lucide-list-todo' : 'i-lucide-sticky-note';
  }
}
function timeOf(r: Row): { main: string; sub: string } {
  if (r.note) return { main: r.min !== null ? clockOf(r.min) : '', sub: '' };
  const t = r.entry!.time;
  const [a, b] = t.split('–');
  return r.side === 'her' && b ? { main: a ?? '', sub: `到 ${b}` } : { main: t, sub: '' };
}
function clockOf(min: number): string {
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

// —— 勾 ——

function toggle(e: ParallelEntry) {
  const why = toggleEntry(persona.value, e);
  if (why) showToast(why);
}
function tapNode(r: Row) {
  if (r.note) return openThread(r.note);
  const e = r.entry!;
  if (r.side === 'me' && e.kind !== 'todo') toggle(e);
  else openEntry(e);
}

// —— 一项的面板：她的看看、请她改；你的改、删、勾 ——

interface Draft {
  time: string;
  untimed: boolean;
  title: string;
  minutes: number;
  note: string;
  checklist: { id: string; text: string; done: boolean }[];
}
const entrySheet = ref<ParallelEntry | null>(null);
const adding = ref(false);
const draft = ref<Draft>({ time: '', untimed: true, title: '', minutes: 0, note: '', checklist: [] });
const editable = computed(() => adding.value || (entrySheet.value?.side === 'me' && entrySheet.value.kind !== 'todo'));
const SOURCE_HINT = computed((): Partial<Record<ParallelEntry['kind'], string>> => ({
  merged: `每天 ${parallel.settings.planAt} 从几份计划整理出来的一项：勾掉会把它合成的那几项（家务、日程计划、健康计划、待办）一起勾掉；在这里改的时间、名字、删掉只影响平行时空。`,
  plan: `日程计划里的事：改了、删了都改在今天的计划上，日程计划页和聊天里${pronoun.value}知道的跟着变。`,
  chore: `家务系统里的事：勾在"共同的家"里；在这里改的时间、删掉只影响平行时空（删了就是今天不做，${pronoun.value}也知道）。`,
  workout: '健康计划里今天的健身：有运动记录就算练过了；在这里改的时间、删掉只影响平行时空。',
  meal: '健康计划里今天的饭：勾掉就是吃过了；在这里改的时间、删掉只影响平行时空。',
  todo: '日程计划里今天的待办：一件件勾掉。',
}));
/** 这一项原来的"补一句"：自己记的、日程计划的是它自己的备注，家务健康是在平行时空里补的那句 */
function noteOf(e: ParallelEntry): string {
  if (e.kind === 'item') return parallel.itemOf(persona.value.id, today.value, e.key.slice('item:'.length))?.note ?? '';
  if (e.kind === 'plan' && e.planIndex !== undefined) {
    const planner = usePlannerStore();
    return planner.dayOf(persona.value.id, planner.today(persona.value))?.items[e.planIndex]?.note ?? '';
  }
  return parallel.overrideOf(persona.value.id, today.value, e.key)?.note ?? '';
}
function openEntry(e: ParallelEntry) {
  adding.value = false;
  entrySheet.value = e;
  const start = e.start;
  draft.value = {
    time: start !== null ? clockOf(start) : '',
    untimed: start === null,
    title: e.title,
    minutes: e.start !== null && e.end !== null ? e.end - e.start : 0,
    note: e.side === 'me' ? noteOf(e) : '',
    checklist: (e.checklist ?? []).map((c) => ({ id: c.key, text: c.text, done: c.done })),
  };
}
function openAdd() {
  entrySheet.value = null;
  adding.value = true;
  draft.value = { time: clockOf(Math.min(nowMin.value + 60, 1439 + 240)), untimed: false, title: '', minutes: 0, note: '', checklist: [] };
  resetAi();
  addMode.value = capture.value.ok ? 'ai' : 'manual';
}
function closeEntry() {
  entrySheet.value = null;
  adding.value = false;
  resetAi();
}

// —— 记一件事：AI 记（随口说一句，整理成要做的事、避开冲突排进去）/ 自己填 ——

type AddMode = 'ai' | 'manual';
const addMode = ref<AddMode>('ai');
const ADD_MODES = [
  { value: 'ai' as const, label: 'AI 记', icon: 'i-lucide-sparkles' },
  { value: 'manual' as const, label: '自己填', icon: 'i-lucide-pencil' },
];
const capture = computed(() => captureStatus());
const calState = computed(() => calendarState(persona.value));
/** 这一次新记的写不写进 Google 日历 */
const syncCalendar = computed(() => parallel.settings.calendarSync && calState.value.ok);
const aiText = ref('');
const aiBusy = ref(false);
const aiError = ref('');
const aiResult = ref<Extract<CaptureResult, { ok: true }> | null>(null);
const aiPick = ref<{ items: boolean[]; moves: boolean[] }>({ items: [], moves: [] });
let aiAbort: AbortController | null = null;
const aiChosen = computed(() => aiPick.value.items.filter(Boolean).length + aiPick.value.moves.filter(Boolean).length);
function resetAi(keepText = false) {
  aiAbort?.abort();
  aiAbort = null;
  aiBusy.value = false;
  aiError.value = '';
  aiResult.value = null;
  if (!keepText) aiText.value = '';
}
async function runCapture() {
  if (aiBusy.value || !aiText.value.trim()) return;
  const ctrl = new AbortController();
  aiAbort = ctrl;
  aiBusy.value = true;
  aiError.value = '';
  const r = await draftCapture(persona.value, aiText.value, { calendar: syncCalendar.value, signal: ctrl.signal });
  // 中途关掉、重新来过的不管
  if (aiAbort !== ctrl) return;
  aiAbort = null;
  aiBusy.value = false;
  if (!r.ok) {
    aiError.value = r.reason;
    return;
  }
  aiResult.value = r;
  aiPick.value = { items: r.plan.items.map(() => true), moves: r.plan.moves.map(() => true) };
}
/** "今天" / "明天" / "11/20 周五" */
function dayLabel(date: string): string {
  if (date === today.value) return '今天';
  if (date === shiftDate(today.value, 1)) return '明天';
  if (date === shiftDate(today.value, 2)) return '后天';
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))} ${WEEKDAY_LABEL[new Date(`${date}T12:00:00Z`).getUTCDay()]}`;
}
async function confirmCapture() {
  const r = aiResult.value;
  if (!r || !aiChosen.value) return;
  const pick = { items: [...aiPick.value.items], moves: [...aiPick.value.moves] };
  const later = r.plan.items.filter((it, i) => pick.items[i] && it.date !== today.value).length;
  const sync = syncCalendar.value;
  const p = persona.value;
  closeEntry();
  const res = await applyCapture(p, r.plan, { ...pick, calendar: sync });
  const done = [
    res.added ? `记上了 ${res.added} 件${later ? `（${later} 件在之后几天，到那天出现在时间线上）` : ''}` : '',
    res.moved ? `挪了 ${res.moved} 件` : '',
    res.synced ? `${res.synced} 件写进了 Google 日历` : '',
  ].filter(Boolean).join('，') || '没有改动';
  showToast({ message: res.calendarError ? `${done}；Google 日历没写成：${res.calendarError}` : done, duration: res.calendarError || later ? 3500 : 2000 });
}
function addCheck() {
  draft.value.checklist.push({ id: uid('pc'), text: '', done: false });
}
function saveEntry() {
  const d = draft.value;
  const title = d.title.trim();
  if (!title) return showToast('写上做什么');
  const time = d.untimed ? '' : d.time;
  const checklist = d.checklist.map((c) => ({ ...c, text: c.text.trim() })).filter((c) => c.text);
  if (adding.value) {
    const it = parallel.addItem(persona.value.id, today.value, { time, minutes: Math.max(0, Math.round(d.minutes) || 0), title, note: d.note.trim(), checklist });
    if (syncCalendar.value) {
      void linkToCalendar(persona.value, today.value, it.id).then(
        () => showToast('记上了，也写进了 Google 日历'),
        (err: unknown) => showToast({ message: `记上了；Google 日历没写成：${errorText(err)}`, duration: 3500 }),
      );
    } else showToast('记上了');
    return closeEntry();
  }
  const e = entrySheet.value;
  if (!e) return;
  const patch: Partial<EntryEdit> = {};
  const oldTime = e.start !== null ? clockOf(e.start) : '';
  if (time !== oldTime) patch.time = time;
  if (title !== e.title) patch.title = title;
  if (d.note.trim() !== noteOf(e)) patch.note = d.note.trim();
  if ((e.kind === 'plan' || e.kind === 'item') && d.minutes !== (e.start !== null && e.end !== null ? e.end - e.start : 0)) patch.minutes = Math.max(0, Math.round(d.minutes) || 0);
  const itemId = e.kind === 'item' ? e.key.slice('item:'.length) : '';
  const itemNow = () => {
    const it = itemId ? parallel.itemOf(persona.value.id, today.value, itemId) : undefined;
    return it ? JSON.stringify([it.time, it.minutes, it.title, it.note, it.checklist.map((c) => c.text)]) : '';
  };
  const before = itemNow();
  editEntry(persona.value, e, patch);
  if (itemId) {
    parallel.updateItem(persona.value.id, today.value, itemId, { checklist });
    // 同步过 Google 日历的：日历里那一条跟着改
    if (parallel.itemOf(persona.value.id, today.value, itemId)?.calendar && itemNow() !== before) {
      void syncItemCalendar(persona.value, today.value, itemId).catch((err: unknown) => showToast({ message: `Google 日历没跟着改：${errorText(err)}`, duration: 3500 }));
    }
  }
  closeEntry();
}
/** 正在看的这一件自己记的事同步过 Google 日历 */
const entryLinked = computed(() => {
  const e = entrySheet.value;
  return !!e && e.kind === 'item' && !!parallel.itemOf(persona.value.id, today.value, e.key.slice('item:'.length))?.calendar;
});
async function deleteEntry() {
  const e = entrySheet.value;
  if (!e) return;
  const what = e.kind === 'plan' ? '从今天的日程计划里删掉' : e.kind === 'item' ? '删掉' : '从今天拿掉（以后在设置里能放回来）';
  const item = e.kind === 'item' ? parallel.itemOf(persona.value.id, today.value, e.key.slice('item:'.length)) : undefined;
  const linked = item?.calendar ? (JSON.parse(JSON.stringify(item)) as typeof item) : null;
  const ok = await showConfirmDialog({ title: `「${e.title}」`, message: `${what}？${linked ? '\nGoogle 日历里那一条也一起删掉。' : ''}`, confirmButtonText: '删掉' }).then(() => true, () => false);
  if (!ok) return;
  const p = persona.value;
  removeEntry(p, e);
  closeEntry();
  if (linked) void unlinkCalendar(p, linked).catch((err: unknown) => showToast({ message: `Google 日历里那一条没删掉：${errorText(err)}`, duration: 3500 }));
}
function refOf(e: ParallelEntry): ParallelRef {
  return { side: e.side, key: e.key, label: entryLabel(e) };
}

// —— 留言 ——

type ComposeMode = 'note' | 'request';
const composing = ref(false);
const composeMode = ref<ComposeMode>('note');
const composeAbout = ref<ParallelRef | null>(null);
const composeText = ref('');
const composeInput = ref<HTMLTextAreaElement | null>(null);
const COMPOSE_MODES = computed(() => [
  { value: 'note' as const, label: '留言', icon: 'i-lucide-message-square-heart' },
  { value: 'request' as const, label: `请${pronoun.value}改日程`, icon: 'i-lucide-calendar-sync' },
]);
function openCompose(mode: ComposeMode, about: ParallelRef | null = null) {
  composeMode.value = mode;
  composeAbout.value = about;
  composeText.value = '';
  closeEntry();
  composing.value = true;
  void nextTick(() => composeInput.value?.focus());
}
function sendCompose() {
  const c = character.value;
  const text = composeText.value.trim();
  if (!c || !text) return;
  if (composeMode.value === 'request' && !herDay.value) return showToast(`${c.name}还没有节律，改不了日程`);
  const about = composeAbout.value ?? undefined;
  const note = composeMode.value === 'request' ? requestChange(c.id, text, about) : sendNote(c.id, text, about);
  composing.value = false;
  if (note && !status.value.ok) showToast({ message: status.value.reason, duration: 3000 });
}

const thread = ref<ParallelNote | null>(null);
const replyText = ref('');
const threadNote = computed(() => (thread.value ? (parallel.noteById(thread.value.id) ?? null) : null));
function openThread(n: ParallelNote) {
  thread.value = n;
  replyText.value = '';
  n.unread = false;
}
function sendReply() {
  const n = threadNote.value;
  const text = replyText.value.trim();
  if (!n || !text) return;
  userReply(n.id, text);
  replyText.value = '';
}
function retry(n: ParallelNote) {
  if (n.kind === 'request' && !n.request) void decideRequest(n.id);
  else void replyTo(n.id);
}
async function deleteNote(n: ParallelNote) {
  const ok = await showConfirmDialog({ title: '删掉这条留言？', message: '下面的回复一起删掉（写进记忆的那条还在）', confirmButtonText: '删掉' }).then(() => true, () => false);
  if (!ok) return;
  parallel.removeNote(n.id);
  thread.value = null;
}
function nameOf(id: string): string {
  return id === PARALLEL_USER ? persona.value.name : (chars.byId(id)?.name ?? '已删除的角色');
}
/** 这一条在等她（回复、决定改不改）、没做成的原因 */
function pendingOf(n: ParallelNote): { busy: boolean; failure?: string } {
  const key = n.kind === 'request' && !n.request ? `request:${n.id}` : `reply:${n.id}`;
  return { busy: !!parallel.busy[key], failure: parallel.failures[key] };
}
function lastReply(n: ParallelNote) {
  return n.replies.at(-1);
}
function stampOf(at: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone: env.settings.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}

// —— 设置 ——

const settingsOpen = ref(false);
const charSettings = computed(() => (character.value ? parallel.characterSettings(character.value.id) : null));
/** 每天几点整理你的一天：写对了才存 */
function setPlanAt(v: string) {
  if (toMinutes(v) !== null) parallel.settings.planAt = v;
}
async function askNow() {
  const c = character.value;
  if (!c) return;
  const r = await postNote(c.id);
  if (r.ok) {
    settingsOpen.value = false;
    showToast(`${c.name}留了一句`);
  } else showToast({ message: r.reason, duration: 3000 });
}

// 看着这一页时，新来的留言算看过了；算看过之前先记下哪几条是新的（钉在此刻卡片下面的那条带红点）
const fresh = reactive(new Set<string>());
watch(
  () => [character.value?.id, todayNotes.value.length],
  () => {
    if (!character.value) return;
    for (const n of todayNotes.value) if (n.unread) fresh.add(n.id);
    parallel.markRead(character.value.id);
  },
  { immediate: true },
);
/** 钉在此刻卡片下面的：她今天最近的一条留言 */
const herLatest = computed(() => [...todayNotes.value].reverse().find((n) => n.authorId !== PARALLEL_USER) ?? null);
</script>

<template>
  <div class="page" data-page="parallel">
    <PageHeader title="平行时空" :subtitle="character ? `${character.name}和${persona.name}的今天 · ${dateText}` : ''" fallback="/map">
      <template #right>
        <button v-if="character" class="icon-btn" aria-label="平行时空设置" data-testid="parallel-settings" @click="settingsOpen = true"><span class="i-lucide-settings-2 text-[20px]" /></button>
      </template>
    </PageHeader>

    <div v-if="!character" class="page-scroll">
      <div class="empty">
        <span class="i-lucide-orbit text-[40px] text-ink-3" />
        <p class="text-[14px] text-ink-2 mt-3">还没有角色：先导入一张角色卡</p>
      </div>
    </div>

    <div v-else class="page-scroll pb-28" :style="{ '--her': character.accent }">
      <RouterLink v-if="!herDay" to="/me/rhythm" class="notice mx-4 mt-3">
        <span class="i-lucide-calendar-clock shrink-0" />
        <span class="flex-1 min-w-0">{{ character.name }}还没有节律：去"我的 → 节律"建世界，{{ pronoun }}的一天才排得出来</span>
      </RouterLink>
      <RouterLink v-if="!status.ok" to="/me/api?feature=parallel" class="notice mx-4 mt-2">
        <span class="i-lucide-plug-zap shrink-0" />
        <span class="flex-1 min-w-0">{{ status.reason }}（{{ pronoun }}看不到你的留言、也不会自己留言；时间线照样能用）</span>
      </RouterLink>
      <div v-if="cloudError" class="notice mx-4 mt-2">
        <span class="i-lucide-cloud-alert shrink-0" />
        <span class="flex-1 min-w-0">{{ cloudError.reason }}</span>
      </div>

      <!-- 此刻：左边她这会儿在做什么，右边你接下来那件 -->
      <section class="now-card mx-4 mt-3" data-testid="parallel-now-card">
        <div class="now-head"><span class="num">此刻 {{ nowText }}</span></div>
        <div class="now-grid">
          <button
            type="button"
            class="half side-her"
            :disabled="!herNow"
            :aria-label="herNow ? `${character.name}这会儿：${herNow.title}` : undefined"
            data-testid="parallel-her-now"
            @click="herNow && openEntry(herNow)"
          >
            <span class="who"><Avatar :character="character" :size="28" live :status="herNow ? 'online' : null" /><span class="truncate">{{ character.name }}</span></span>
            <template v-if="herNow">
              <span class="big">{{ herNow.title }}</span>
              <span v-if="herNow.place" class="meta"><span class="i-lucide-map-pin shrink-0" /><span class="truncate">{{ herNow.place }}</span></span>
              <span v-if="herNow.end !== null" class="meta num">到 {{ clockOf(herNow.end) }}<template v-if="herLeft !== null && herLeft > 0"> · 还有 {{ spanText(herLeft) }}</template></span>
            </template>
            <template v-else>
              <span class="big muted">{{ herDay ? '这会儿没有安排' : '还没有节律' }}</span>
              <span v-if="herNext && herNext.start !== null" class="meta num">接下来 {{ clockOf(herNext.start) }} {{ herNext.title }}</span>
            </template>
            <span v-if="herDay && (herDay.outfits.daily || herDay.task)" class="tags">
              <span v-if="herDay.outfits.daily" class="tag-chip"><span class="i-lucide-shirt shrink-0" /><span class="truncate">{{ herDay.outfits.daily.name }}</span></span>
              <span v-if="herDay.task" class="tag-chip"><span class="i-lucide-pen-line shrink-0" /><span class="truncate">{{ herDay.task }}</span></span>
            </span>
          </button>
          <span class="orbit" aria-hidden="true"><span class="i-lucide-orbit" /></span>
          <div class="half side-me" data-testid="parallel-my-next">
            <span class="who">
              <PersonaAvatar :persona="persona" :size="28" />
              <span class="truncate">{{ persona.name }}</span>
              <span v-if="mine.length" class="count num">{{ doneCount }}/{{ mine.length }}</span>
            </span>
            <template v-if="myFocus">
              <span class="label">{{ focusState.label }}</span>
              <span class="big-line">
                <button type="button" class="big" @click="openEntry(myFocus)">{{ myFocus.title }}</button>
                <button v-if="myFocus.kind !== 'todo'" type="button" class="fcheck" :aria-label="`${myFocus.title}：做完了`" data-testid="parallel-focus-check" @click="toggle(myFocus)" />
              </span>
              <span v-if="focusState.when" class="meta num">{{ focusState.when }}</span>
              <span v-else-if="myFocus.sub" class="meta"><span class="truncate">{{ myFocus.sub }}</span></span>
            </template>
            <template v-else>
              <span class="label">&nbsp;</span>
              <span class="big muted">{{ mine.length ? '今天的都做完了' : '今天还没有安排' }}</span>
            </template>
          </div>
        </div>
        <!-- 她最近的一条留言：钉在这里，新来的带红点 -->
        <button v-if="herLatest" type="button" class="pin-note" :class="{ fresh: fresh.has(herLatest.id) }" data-testid="parallel-her-note" @click="openThread(herLatest)">
          <span class="pin-text"><b>{{ character.name }}：</b>{{ herLatest.text }}</span>
          <span class="pin-meta num">{{ stampOf(herLatest.at) }}<template v-if="herLatest.replies.length"> · {{ herLatest.replies.length }} 条回复</template></span>
        </button>
      </section>

      <!-- 随时：不定时的收在这一条里 -->
      <div v-if="anytime.length" class="anytime mx-4 mt-2" data-testid="parallel-anytime">
        <button type="button" class="any-head" :aria-expanded="anytimeOpen" @click="anytimeOpen = !anytimeOpen">
          <span class="i-lucide-clock shrink-0" />
          <span class="shrink-0 text-ink-2">随时</span>
          <span class="flex-1 min-w-0 truncate">{{ anytimeText }}</span>
          <span class="num shrink-0">{{ anytimeDone }}/{{ anytime.length }}</span>
          <span :class="anytimeOpen ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" class="shrink-0" />
        </button>
        <div v-if="anytimeOpen" class="any-list">
          <div v-for="r in anytime" :key="r.id" class="entry any-row" :class="{ done: r.entry!.done }" :data-key="r.id">
            <div class="title-line">
              <button v-if="r.entry!.kind !== 'todo'" type="button" class="check" :class="{ on: r.entry!.done }" :aria-label="r.entry!.done ? '改回没做' : '做完了'" @click="toggle(r.entry!)"><span v-if="r.entry!.done" class="i-lucide-check" /></button>
              <span v-else class="any-icon" :class="iconOf(r)" />
              <button type="button" class="title" @click="openEntry(r.entry!)">{{ r.entry!.title }}</button>
            </div>
            <div v-if="r.entry!.sub" class="sub">{{ r.entry!.sub }}</div>
            <div v-if="r.entry!.checklist?.length" class="checklist">
              <label v-for="c in r.entry!.checklist" :key="c.key" class="ck" :class="{ on: c.done }">
                <input type="checkbox" :checked="c.done" @change="toggleCheck(persona, r.entry!, c.key)" />
                <span>{{ c.text }}</span>
              </label>
            </div>
          </div>
        </div>
      </div>

      <!-- 时间线：只展开现在前后 -->
      <div class="timeline" data-testid="parallel-timeline">
        <div v-for="lane in lanes" :key="lane.key" class="lane" :class="lane.key">
          <template v-for="it in lane.items" :key="it.id">
            <button v-if="it.type === 'fold'" type="button" class="fold" :aria-expanded="it.open" :data-testid="`parallel-fold-${it.id}`" @click="toggleFold(it.id)">
              <span>{{ it.text }}<span :class="it.open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'" /></span>
            </button>
            <div v-else-if="it.type === 'now'" class="now-line" data-testid="parallel-now"><span>现在 {{ nowText }}</span></div>
            <!-- 哪一边写成 side-her / side-me：不能直接叫 me，UnoCSS 会把 .me 当成 margin-inline-end 的原子类，这一行就窄了一截 -->
            <div
              v-else
              class="row"
              :class="[`side-${it.row.side}`, { past: it.row.past, current: it.row.entry?.now, focus: !!it.row.entry && it.row.entry.key === myFocus?.key, future: it.future }]"
              :data-key="it.row.id"
            >
              <div class="body">
                <!-- 留言 -->
                <button v-if="it.row.note" type="button" class="note-card" :class="{ unread: fresh.has(it.row.note.id) }" @click="openThread(it.row.note)">
                  <div class="note-head">
                    {{ it.row.note.authorId === PARALLEL_USER ? (it.row.note.kind === 'request' ? `请${pronoun}改日程` : '你的留言') : `${character.name}的留言` }}
                    <span v-if="it.row.note.request" class="tag" :class="it.row.note.request.status === 'accepted' ? 'good' : 'bad'">{{ it.row.note.request.status === 'accepted' ? '答应了' : '没答应' }}</span>
                  </div>
                  <div class="note-text">{{ it.row.note.text }}</div>
                  <div v-if="it.row.note.about" class="about"><span class="i-lucide-corner-down-right" />{{ it.row.note.about.label }}</div>
                  <div v-if="it.row.note.authorId === PARALLEL_USER && lastReply(it.row.note) && lastReply(it.row.note)!.authorId !== PARALLEL_USER" class="answer">{{ lastReply(it.row.note)!.text }}</div>
                  <div v-if="pendingOf(it.row.note).busy" class="pending"><van-loading size="12px" />{{ character.name }}在{{ it.row.note.kind === 'request' && !it.row.note.request ? '想' : '回' }}…</div>
                  <div v-else-if="pendingOf(it.row.note).failure" class="pending warn">没回成：{{ pendingOf(it.row.note).failure }}</div>
                  <div v-else-if="it.row.note.replies.length" class="replies-count"><span class="i-lucide-message-circle" /> {{ it.row.note.replies.length }}</div>
                </button>
                <!-- 一件事 -->
                <div v-else-if="it.row.entry" class="entry" :class="{ done: it.row.entry.done }">
                  <div class="title-line">
                    <button v-if="it.row.side === 'me' && it.row.entry.kind !== 'todo'" type="button" class="check" :class="{ on: it.row.entry.done }" :aria-label="it.row.entry.done ? '改回没做' : '做完了'" @click="toggle(it.row.entry)"><span v-if="it.row.entry.done" class="i-lucide-check" /></button>
                    <button type="button" class="title" @click="openEntry(it.row.entry)">{{ it.row.entry.title }}</button>
                    <span v-if="it.row.entry.fixed" class="i-lucide-lock text-[11px] text-ink-3 shrink-0" aria-label="定死的" />
                  </div>
                  <div v-if="it.row.entry.sub" class="sub">{{ it.row.entry.sub }}</div>
                  <div v-if="it.row.entry.now" class="tag-now">现在</div>
                  <div v-else-if="it.row.entry.overdue" class="tag bad">过了时间</div>
                  <div v-if="it.row.entry.checklist?.length" class="checklist">
                    <label v-for="c in it.row.entry.checklist" :key="c.key" class="ck" :class="{ on: c.done }">
                      <input type="checkbox" :checked="c.done" @change="toggleCheck(persona, it.row.entry, c.key)" />
                      <span>{{ c.text }}</span>
                    </label>
                  </div>
                </div>
              </div>
              <button type="button" class="node" :class="{ done: it.row.entry?.done, msg: !!it.row.note }" :aria-label="it.row.note ? '看留言' : it.row.entry?.title" @click="tapNode(it.row)">
                <span :class="iconOf(it.row)" />
              </button>
              <div class="time">
                <span class="t-main num">{{ timeOf(it.row).main }}</span>
                <span v-if="timeOf(it.row).sub" class="t-sub num">{{ timeOf(it.row).sub }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>

      <div v-if="!mine.length" class="hint-card mx-4 mt-2">
        你今天还没有安排：在"我的人设"里打开家务、健康、日程系统，或者点下面的"记一件事"。
      </div>

      <div class="arrange mx-4 mt-3" data-testid="parallel-arrange">
        <span class="i-lucide-list-checks shrink-0" />
        <span v-if="arranged.busy" class="flex-1 min-w-0">在把你的几份计划整理成一份…</span>
        <span v-else-if="arranged.plan" class="flex-1 min-w-0">
          你这边是 {{ stampOf(arranged.plan.at) }}{{ arranged.plan.via === 'hub' ? '云端' : '' }}整理好的一份计划<template v-if="arranged.stale">；之后几份计划有变化，新出来的接在后面</template>
        </span>
        <span v-else class="flex-1 min-w-0">
          {{ arranged.failure ? `没整理成：${arranged.failure}` : `每天 ${parallel.settings.planAt} 把日程计划、家务、健康计划整理成一份；还没整理，先直接列出来` }}
        </span>
        <button v-if="!arranged.busy && planCheck.ok && (!arranged.plan || arranged.stale)" type="button" class="chip" @click="arrangeNow"><span class="i-lucide-refresh-cw" />{{ arranged.plan ? '重新整理' : '现在整理' }}</button>
      </div>

      <!-- 以前的留言 -->
      <template v-if="olderNotes.length">
        <div class="group-title">以前的留言</div>
        <div class="mx-4 older">
          <button v-for="n in olderNotes.slice(0, 30)" :key="n.id" type="button" class="older-row" @click="openThread(n)">
            <span class="num text-[12px] text-ink-3 shrink-0">{{ n.date.slice(5) }}</span>
            <span class="flex-1 min-w-0 truncate text-[13.5px]">{{ nameOf(n.authorId) }}：{{ n.text }}</span>
            <span v-if="n.replies.length" class="text-[12px] text-ink-3 shrink-0">{{ n.replies.length }} 条回复</span>
          </button>
        </div>
      </template>
    </div>

    <!-- 底栏 -->
    <div v-if="character" class="bottom-bar">
      <van-button round icon="plus" data-testid="parallel-add" @click="openAdd">记一件事</van-button>
      <van-button round type="primary" icon="chat-o" data-testid="parallel-compose" @click="openCompose('note')">给{{ pronoun }}留言</van-button>
    </div>

    <!-- 一项：看看 / 改 / 新记一件 -->
    <van-popup :show="!!entrySheet || adding" position="bottom" round teleport="body" :style="{ maxHeight: '90%' }" @update:show="(v: boolean) => !v && closeEntry()">
      <div v-if="entrySheet || adding" class="sheet" data-sheet="parallel-entry">
        <!-- 她的一段 -->
        <template v-if="entrySheet && entrySheet.side === 'her'">
          <div class="sheet-title">{{ entrySheet.title }}</div>
          <p class="text-[13px] text-ink-2 mt-1 num">{{ entrySheet.time }}<template v-if="entrySheet.sub"> · {{ entrySheet.sub }}</template></p>
          <p v-if="entrySheet.fixed" class="sheet-note"><span class="i-lucide-lock" /> 这是{{ character?.name }}固定的事，{{ pronoun }}一般不会挪</p>
          <div class="grid gap-2 mt-4">
            <van-button round type="primary" block icon="calendar-o" @click="openCompose('request', refOf(entrySheet))">请{{ pronoun }}改这段</van-button>
            <van-button round block icon="chat-o" @click="openCompose('note', refOf(entrySheet))">留言说这个</van-button>
          </div>
        </template>

        <!-- 你的一件 -->
        <template v-else>
          <div class="flex items-center gap-2">
            <div class="sheet-title flex-1">{{ adding ? '记一件事' : '改一下' }}</div>
            <button v-if="entrySheet && entrySheet.kind !== 'todo'" type="button" class="chip" :class="{ on: entrySheet.done }" @click="toggle(entrySheet); closeEntry()">
              <span :class="entrySheet.done ? 'i-lucide-undo-2' : 'i-lucide-check'" />{{ entrySheet.done ? '改回没做' : '做完了' }}
            </button>
          </div>
          <Segmented v-if="adding" v-model="addMode" class="mt-3" :options="ADD_MODES" />
          <p v-if="entrySheet && SOURCE_HINT[entrySheet.kind]" class="sheet-note">{{ SOURCE_HINT[entrySheet.kind] }}</p>
          <p v-if="entryLinked" class="sheet-note"><span class="i-lucide-calendar-check align-[-2px]" /> 已同步到 Google 日历：改时间、名字、补充会跟着改，删掉也一起删。</p>

          <!-- AI 记：随口说一句，整理成要做的事、避开冲突排进去；先看一遍再记 -->
          <template v-if="adding && addMode === 'ai'">
            <template v-if="!aiResult">
              <textarea
                v-model="aiText"
                class="textarea mt-3"
                maxlength="400"
                :disabled="aiBusy"
                data-testid="parallel-ai-input"
                placeholder="随口说，比如：明天下午找个时间去趟超市，顺便取快递；周五前把报告交了"
              />
              <p class="sheet-note">AI 把它整理成要做的事，看着这几天的安排{{ syncCalendar ? '和 Google 日历' : '' }}找空档排进去，必要时挪一挪能挪的（定死的不动）；记进去之前你先看一遍。</p>
              <RouterLink v-if="!capture.ok" :to="capture.fix" class="warn-line">{{ capture.reason }} →</RouterLink>
              <p v-if="aiError" class="warn-line">没整理成：{{ aiError }}</p>
            </template>
            <div v-else class="ai-review" data-testid="parallel-ai-review">
              <p v-if="aiResult.plan.summary" class="ai-summary"><span class="i-lucide-sparkles shrink-0 mt-[3px]" /><span>{{ aiResult.plan.summary }}</span></p>
              <p v-if="aiResult.calendarNote" class="warn-line">{{ aiResult.calendarNote }}</p>
              <template v-if="aiResult.plan.items.length">
                <div class="field-label">要新记的</div>
                <label v-for="(it, i) in aiResult.plan.items" :key="`i${i}`" class="ai-row" :class="{ off: !aiPick.items[i] }">
                  <input v-model="aiPick.items[i]" type="checkbox" />
                  <span class="ai-body">
                    <span class="ai-when num">{{ dayLabel(it.date) }} · {{ it.time || '不定时' }}<template v-if="it.minutes"> · {{ it.minutes }} 分钟</template></span>
                    <span class="ai-title">{{ it.title }}</span>
                    <span v-if="it.note" class="ai-sub">{{ it.note }}</span>
                    <span v-if="it.checklist.length" class="ai-sub">清单：{{ it.checklist.join('、') }}</span>
                    <span v-if="it.why" class="ai-why">{{ it.why }}</span>
                    <span v-if="it.shifted" class="tag warn">{{ it.shifted }}</span>
                    <span v-if="it.conflict" class="tag bad">{{ it.conflict }}</span>
                  </span>
                </label>
              </template>
              <template v-if="aiResult.plan.moves.length">
                <div class="field-label">为了排开要挪的</div>
                <label v-for="(m, i) in aiResult.plan.moves" :key="`m${i}`" class="ai-row" :class="{ off: !aiPick.moves[i] }">
                  <input v-model="aiPick.moves[i]" type="checkbox" />
                  <span class="ai-body">
                    <span class="ai-when num">{{ dayLabel(m.ref.date) }} · {{ m.ref.entry.time }} → {{ m.time }}</span>
                    <span class="ai-title">{{ m.ref.entry.title }}</span>
                    <span v-if="m.why" class="ai-why">{{ m.why }}</span>
                    <span v-if="m.shifted" class="tag warn">{{ m.shifted }}</span>
                  </span>
                </label>
              </template>
              <p v-if="!aiResult.plan.items.length && !aiResult.plan.moves.length" class="sheet-note">没有要新记的。</p>
              <p v-for="(d, i) in aiResult.plan.dropped" :key="`d${i}`" class="sheet-note">{{ d }}</p>
            </div>
          </template>

          <template v-else-if="editable">
            <label class="field-label">做什么</label>
            <input v-model="draft.title" class="input" maxlength="60" placeholder="例如：去超市买菜" data-testid="parallel-title" />
            <label class="field-label">什么时候</label>
            <div class="flex items-center gap-2">
              <input v-model="draft.time" type="time" class="input flex-1" :disabled="draft.untimed" data-testid="parallel-time" />
              <label class="flex items-center gap-1.5 text-[13px] text-ink-2 shrink-0"><input v-model="draft.untimed" type="checkbox" />不定时</label>
            </div>
            <template v-if="adding || entrySheet?.kind === 'plan' || entrySheet?.kind === 'item'">
              <label class="field-label">大概多久（分钟，可以不写）</label>
              <input v-model.number="draft.minutes" type="number" min="0" step="5" class="input" />
            </template>
            <label class="field-label">补一句（可以不写）</label>
            <input v-model="draft.note" class="input" maxlength="80" placeholder="带什么、和谁、在哪" />
            <template v-if="adding || entrySheet?.kind === 'item'">
              <label class="field-label">清单（可以不写）</label>
              <div v-for="(c, j) in draft.checklist" :key="c.id" class="flex items-center gap-2 mb-1.5">
                <input v-model="c.done" type="checkbox" />
                <input v-model="c.text" class="input flex-1 !h-9" maxlength="40" placeholder="一样东西、一件小事" />
                <button type="button" class="icon-btn !w-8 !h-8" aria-label="去掉" @click="draft.checklist.splice(j, 1)"><span class="i-lucide-x" /></button>
              </div>
              <button type="button" class="chip" @click="addCheck"><span class="i-lucide-plus" />加一项</button>
            </template>
          </template>

          <!-- 新记的同步到 Google 日历（人设日程系统里接的那台） -->
          <template v-if="adding">
            <label v-if="calState.ok" class="cal-row">
              <input v-model="parallel.settings.calendarSync" type="checkbox" data-testid="parallel-calendar-sync" />
              <span class="i-lucide-calendar-plus shrink-0" />
              <span>新记的同步到 Google 日历</span>
            </label>
            <RouterLink v-else :to="calState.fix" class="cal-row muted">
              <span class="i-lucide-calendar-x shrink-0" />
              <span class="flex-1 min-w-0">{{ calState.reason }}：接上就能同步到 Google 日历</span>
              <span class="i-lucide-chevron-right shrink-0" />
            </RouterLink>
          </template>

          <div class="grid gap-2 mt-4">
            <template v-if="adding && addMode === 'ai'">
              <van-button v-if="!aiResult" round type="primary" block :loading="aiBusy" loading-text="在整理…" :disabled="!aiText.trim() || !capture.ok" data-testid="parallel-ai-run" @click="runCapture">让 AI 整理</van-button>
              <template v-else>
                <van-button round type="primary" block :disabled="!aiChosen" data-testid="parallel-ai-confirm" @click="confirmCapture">{{ aiChosen ? `记上（${aiChosen} 项）` : '都没选' }}</van-button>
                <van-button round block @click="resetAi(true)">重新说</van-button>
              </template>
            </template>
            <van-button v-else-if="editable" round type="primary" block data-testid="parallel-save" @click="saveEntry">{{ adding ? '记上' : '保存' }}</van-button>
            <van-button v-if="entrySheet" round block icon="chat-o" @click="openCompose('note', refOf(entrySheet))">留言给{{ pronoun }}说这个</van-button>
            <van-button v-if="entrySheet" round block plain type="danger" @click="deleteEntry">{{ entrySheet.kind === 'plan' || entrySheet.kind === 'item' ? '删掉' : '从今天拿掉' }}</van-button>
          </div>
        </template>
      </div>
    </van-popup>

    <!-- 留言 / 请她改日程 -->
    <van-popup v-model:show="composing" position="bottom" round teleport="body" :style="{ maxHeight: '90%' }">
      <form v-if="composing && character" class="sheet" data-sheet="parallel-compose" @submit.prevent="sendCompose">
        <Segmented v-model="composeMode" :options="COMPOSE_MODES" />
        <div v-if="composeAbout" class="about-chip mt-3">
          <span class="i-lucide-corner-down-right shrink-0" />
          <span class="flex-1 min-w-0 truncate">说的是 {{ composeAbout.side === 'her' ? character.name : '你' }}的 {{ composeAbout.label }}</span>
          <button type="button" class="shrink-0" aria-label="不针对这一项" @click="composeAbout = null"><span class="i-lucide-x" /></button>
        </div>
        <textarea
          ref="composeInput"
          v-model="composeText"
          class="textarea mt-3"
          maxlength="400"
          data-testid="parallel-compose-input"
          :placeholder="composeMode === 'request' ? `想让${character.name}今天怎么改？例如：下午三点能不能陪我去超市` : `想跟${character.name}说的`"
        />
        <p class="sheet-note">
          {{ composeMode === 'request'
            ? `${character.name}按自己的性格和今天的安排决定答不答应（固定的事不挪、只改今天的），答应了${pronoun}的节律跟着改。`
            : `留在你们俩的时间线上，${character.name}看到会回你。` }}
        </p>
        <RouterLink v-if="!status.ok" to="/me/api?feature=parallel" class="warn-line">{{ status.reason }} →</RouterLink>
        <p v-else-if="composeMode === 'request' && !herDay" class="warn-line">{{ character.name }}还没有节律，改不了日程</p>
        <van-button class="mt-3" round block type="primary" native-type="submit" :disabled="!composeText.trim() || (composeMode === 'request' && !herDay)" data-testid="parallel-send">
          {{ composeMode === 'request' ? `请${pronoun}改` : '留言' }}
        </van-button>
      </form>
    </van-popup>

    <!-- 一条留言和下面的回复 -->
    <van-popup :show="!!threadNote" position="bottom" round teleport="body" :style="{ maxHeight: '90%' }" @update:show="(v: boolean) => !v && (thread = null)">
      <div v-if="threadNote && character" class="sheet" data-sheet="parallel-thread">
        <div class="flex items-center gap-2">
          <div class="sheet-title flex-1">{{ threadNote.authorId === PARALLEL_USER ? (threadNote.kind === 'request' ? `请${pronoun}改日程` : '你的留言') : `${character.name}的留言` }}</div>
          <span class="text-[12px] text-ink-3 num">{{ threadNote.date.slice(5) }} {{ stampOf(threadNote.at) }}</span>
          <button type="button" class="icon-btn !w-8 !h-8" aria-label="删掉这条留言" @click="deleteNote(threadNote)"><span class="i-lucide-trash-2 text-[16px]" /></button>
        </div>
        <p class="thread-text">{{ threadNote.text }}</p>
        <div v-if="threadNote.about" class="about"><span class="i-lucide-corner-down-right" />{{ threadNote.about.label }}</div>
        <div v-if="threadNote.request" class="result" :class="threadNote.request.status">
          <div class="font-600 text-[13.5px]">{{ threadNote.request.status === 'accepted' ? `${character.name}答应了` : `${character.name}没答应` }}</div>
          <p v-for="(ch, j) in threadNote.request.changes" :key="`c${j}`" class="text-[12.5px] mt-1 num">{{ ch }}</p>
          <p v-for="(f, j) in threadNote.request.fixes ?? []" :key="`f${j}`" class="text-[12px] text-ink-3 mt-1">{{ f }}</p>
        </div>
        <div class="replies">
          <div v-for="rp in threadNote.replies" :key="rp.id" class="reply" :class="{ mine: rp.authorId === PARALLEL_USER }">
            <span class="who">{{ nameOf(rp.authorId) }}</span>
            <span class="said">{{ rp.text }}</span>
          </div>
          <div v-if="pendingOf(threadNote).busy" class="pending"><van-loading size="12px" />{{ character.name }}在{{ threadNote.kind === 'request' && !threadNote.request ? '想' : '回' }}…</div>
          <div v-else-if="pendingOf(threadNote).failure" class="pending warn">
            没回成：{{ pendingOf(threadNote).failure }}
            <button type="button" class="text-accent-ink ml-1" @click="retry(threadNote)">再试一次</button>
          </div>
        </div>
        <form class="reply-bar" @submit.prevent="sendReply">
          <input v-model="replyText" class="input flex-1" maxlength="300" enterkeyhint="send" :placeholder="`回${character.name}`" data-testid="parallel-reply-input" />
          <van-button round type="primary" size="small" native-type="submit" :disabled="!replyText.trim()">回复</van-button>
        </form>
      </div>
    </van-popup>

    <!-- 设置 -->
    <van-popup v-model:show="settingsOpen" position="bottom" round teleport="body" :style="{ maxHeight: '90%' }">
      <div v-if="settingsOpen && character && charSettings" class="sheet" data-sheet="parallel-settings">
        <div class="sheet-title">平行时空</div>
        <van-cell-group inset class="!mx-0 mt-3">
          <van-cell center :title="`${character.name}自己会给你留言`" :label="cloud ? '云端每天在随机的时间留，App 关着也留' : '没连云端：App 开着时按同样的随机时间留'">
            <template #right-icon>
              <van-switch :model-value="charSettings.enabled" size="22" @update:model-value="(v: boolean) => parallel.setCharacter(character!.id, { enabled: v })" />
            </template>
          </van-cell>
          <van-cell v-if="charSettings.enabled" center title="每天最多几条" :label="`每天 1 到这么多条，落在${pronoun}醒着的时段里`">
            <template #right-icon>
              <van-stepper :model-value="charSettings.perDay" :min="1" :max="PARALLEL_PER_DAY_MAX" integer @update:model-value="(v: string | number) => parallel.setCharacter(character!.id, { perDay: Number(v) })" />
            </template>
          </van-cell>
          <van-cell center title="写进聊天" :label="`你在平行时空里自己记的事、拿掉的事，聊天、通话、主动消息里${pronoun}都知道`">
            <template #right-icon>
              <van-switch v-model="parallel.settings.inChat" size="22" />
            </template>
          </van-cell>
          <van-cell center title="新记的事同步到 Google 日历" :label="calState.ok ? '用日程系统里接的 Google 日历（主日历）：改时间、名字、删掉时跟着改；AI 记的时候也避开日历里已有的' : calState.reason">
            <template #right-icon>
              <van-switch v-model="parallel.settings.calendarSync" size="22" :disabled="!calState.ok" data-testid="parallel-calendar-setting" />
            </template>
          </van-cell>
        </van-cell-group>
        <div class="field-label">每天几点整理你的一天</div>
        <div class="flex items-center gap-2">
          <input :value="parallel.settings.planAt" type="time" class="input flex-1" data-testid="parallel-plan-at" @change="setPlanAt(($event.target as HTMLInputElement).value)" />
          <van-button round size="small" :loading="arranged.busy" :disabled="!planCheck.ok" loading-text="在整理…" @click="arrangeNow">现在整理</van-button>
        </div>
        <p class="sheet-note">
          到点把日程计划、家务、健康计划（有几份用几份）交给"平行时空 · 整理你的一天"预设，说的是同一件事的合成一项。设在日程计划排好之后；{{ cloud ? '云端到点就整理，App 关着也整理' : '没连云端：App 开着、到点后整理' }}。
        </p>
        <RouterLink v-if="!planCheck.ok" :to="planCheck.fix" class="warn-line">{{ planCheck.reason }} →</RouterLink>
        <van-button class="mt-3" round block :loading="!!parallel.busy[`post:${character.id}`]" :disabled="!status.ok" loading-text="在写…" @click="askNow">让{{ pronoun }}现在留一句</van-button>
        <p v-if="parallel.failures[`post:${character.id}`]" class="warn-line">{{ parallel.failures[`post:${character.id}`] }}</p>
        <template v-if="hidden.length">
          <div class="field-label">今天拿掉的</div>
          <div v-for="e in hidden" :key="e.key" class="flex items-center gap-2 py-1.5">
            <span class="flex-1 min-w-0 truncate text-[13.5px]">{{ entryLabel(e) }}</span>
            <button type="button" class="chip" @click="restoreEntry(persona, e.key)"><span class="i-lucide-undo-2" />放回来</button>
          </div>
        </template>
        <div class="links">
          <RouterLink to="/me/presets?cat=parallel" class="chip"><span class="i-lucide-sliders-horizontal" />平行时空预设</RouterLink>
          <RouterLink to="/me/api?feature=parallel" class="chip"><span class="i-lucide-plug-zap" />API 设置</RouterLink>
          <RouterLink to="/me/rhythm" class="chip"><span class="i-lucide-calendar-clock" />{{ pronoun }}的节律</RouterLink>
          <RouterLink :to="`/me/personas/${persona.id}/planner`" class="chip"><span class="i-lucide-calendar-check" />你的日程系统</RouterLink>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 80px 32px;
  text-align: center;
}
/* —— 此刻：左边她、右边你 —— */
.now-card {
  padding: 12px;
  border-radius: 22px;
  background: var(--surface);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-sm);
}
.now-head {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-2);
}
.now-head::before,
.now-head::after {
  content: '';
  flex: 1;
  border-top: 1px solid var(--border);
}
.now-grid {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
  margin-top: 10px;
}
.half {
  position: relative;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 10px 10px 11px;
  border-radius: 16px;
  text-align: left;
}
.half.side-her {
  background: color-mix(in srgb, var(--her) 15%, var(--panel));
  border: 1px solid color-mix(in srgb, var(--her) 45%, transparent);
}
.half.side-her:disabled {
  opacity: 1;
}
.half.side-me {
  background: var(--panel);
  border: 1px solid var(--border);
}
.half .who {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  margin-bottom: 4px;
  font-size: 13px;
  font-weight: 600;
}
.half .count {
  margin-left: auto;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--ink-3);
}
.half .label {
  font-size: 11.5px;
  color: var(--ink-3);
}
.half .big {
  min-width: 0;
  font-size: 17px;
  font-weight: 700;
  line-height: 1.35;
  text-align: left;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.half .big.muted {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--ink-3);
}
.big-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
}
.big-line .big {
  flex: 1;
}
.fcheck {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  margin-top: 1px;
  border-radius: 50%;
  border: 1.5px solid var(--ink-3);
}
.half .meta {
  display: flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-3);
}
.half .tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  max-width: 100%;
  margin-top: 5px;
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  padding: 1px 7px;
  border-radius: 99px;
  background: color-mix(in srgb, var(--her) 14%, transparent);
  color: var(--ink-2);
  font-size: 11px;
  line-height: 18px;
}
/* 两张卡中间的一枚小星轨：两个人的今天连在一起 */
.orbit {
  position: absolute;
  top: 18px;
  left: 50%;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  margin-left: -12px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--ink-3);
  font-size: 13px;
}
.pin-note {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  min-width: 0;
  margin-top: 10px;
  padding: 8px 11px;
  border-radius: 4px 14px 14px 14px;
  background: var(--panel);
  border: 1px solid var(--border);
  text-align: left;
}
.pin-note.fresh {
  background: color-mix(in srgb, var(--her) 16%, var(--panel));
  border-color: color-mix(in srgb, var(--her) 50%, transparent);
}
.pin-note.fresh::after {
  content: '';
  position: absolute;
  top: -4px;
  right: -4px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--bad);
  box-shadow: 0 0 0 2px var(--surface);
}
.pin-text {
  font-size: 13px;
  line-height: 1.5;
  word-break: break-word;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.pin-text b {
  font-weight: 600;
}
.pin-meta {
  font-size: 11px;
  color: var(--ink-3);
}

/* —— 随时 —— */
.anytime {
  border-radius: 14px;
  background: var(--panel);
}
.any-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  font-size: 13px;
  color: var(--ink-3);
  text-align: left;
}
.any-list {
  display: grid;
  gap: 8px;
  padding: 0 12px 12px;
}
.any-list .any-row {
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--surface);
}
.any-icon {
  flex-shrink: 0;
  margin-top: 2px;
  font-size: 16px;
  color: var(--ink-3);
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.5;
  text-decoration: none;
}
.arrange {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.5;
}
/* —— 时间线：内容在自己那一边、时间在对面，中间一条线 —— */
.timeline {
  --node: 40px;
  --gap: 10px;
  --pad: 8px;
  --axis: 2px;
  /* 两边各占的宽度：用算好的长度，不交给 fr 去分（有的浏览器会按内容分得不一样宽，节点就错开了） */
  --side: calc(50% - var(--node) / 2 - var(--gap));
  padding: 6px 12px 12px;
}
/* 每一段从头到尾画一整条中轴线："现在"之前实线，之后虚线 */
.lane {
  position: relative;
}
.lane::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 50%;
  margin-left: calc(var(--axis) / -2);
  border-left: var(--axis) solid color-mix(in srgb, var(--ink-3) 55%, var(--bg));
}
.lane.after::before {
  border-left-style: dashed;
  border-left-color: var(--border);
}
.row {
  position: relative;
  display: grid;
  grid-template-columns: var(--side) var(--side);
  justify-content: space-between;
  align-items: start;
  min-height: calc(var(--node) + var(--pad) * 2);
  padding: var(--pad) 0;
}
.row > * {
  grid-row: 1;
}
.row.side-her .body {
  grid-column: 1;
  text-align: right;
}
.row.side-her .time {
  grid-column: 2;
  text-align: left;
}
.row.side-me .body {
  grid-column: 2;
  text-align: left;
}
.row.side-me .time {
  grid-column: 1;
  text-align: right;
}
/* 节点压在中轴线正中（和线用同一个 50%），不跟着两边的内容走 */
.node {
  --fill: var(--ink-2);
  position: absolute;
  top: var(--pad);
  left: 50%;
  margin-left: calc(var(--node) / -2);
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  width: var(--node);
  height: var(--node);
  border-radius: 50%;
  background: var(--fill);
  color: var(--surface);
  font-size: 18px;
  box-shadow: 0 0 0 4px var(--bg);
}
.row.side-her .node {
  --fill: var(--her);
}
/* 过去的淡一点：混进底色而不是调透明度，线不会从节点里透出来 */
.row.past .node {
  background: color-mix(in srgb, var(--fill) 60%, var(--bg));
}
.row.current .node {
  box-shadow: 0 0 0 4px var(--bg), 0 0 0 7px var(--her);
}
.node.msg {
  border-radius: 14px;
}
.node.done::after {
  content: '';
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--good);
  box-shadow: 0 0 0 2px var(--bg);
}
.time {
  display: flex;
  flex-direction: column;
  padding-top: 9px;
}
.row.side-her .time {
  align-items: flex-start;
}
.row.side-me .time {
  align-items: flex-end;
}
.t-main {
  font-size: 13px;
  color: var(--ink-3);
}
.row.future .t-main,
.row.current .t-main {
  color: var(--accent-ink);
}
.t-sub {
  font-size: 11px;
  color: var(--ink-3);
}
.fold,
.now-line {
  position: relative;
  display: flex;
  justify-content: center;
  width: 100%;
  padding: 6px 0;
}
.fold > span,
.now-line span {
  position: relative;
  z-index: 1;
  padding: 2px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  background: var(--panel);
  color: var(--ink-3);
}
/* 收起来的那一条：比"现在"安静，但看得出能点 */
.fold > span {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 4px 12px;
  border: 1px solid var(--border);
  font-size: 12px;
  color: var(--ink-2);
}
.now-line::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  right: 0;
  border-top: 1px solid var(--accent-line);
}
.now-line span {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
}

/* —— 一件事 —— */
.entry {
  padding-top: 4px;
  min-width: 0;
}
/* 她此刻那段、你此刻那件：时间线上也亮一点 */
.row.current .entry,
.row.focus .entry {
  margin-top: -2px;
  padding: 6px 10px 7px;
  border-radius: 12px;
}
.row.current .entry {
  background: color-mix(in srgb, var(--her) 14%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--her) 40%, transparent);
}
.row.focus .entry {
  background: var(--panel);
  box-shadow: inset 0 0 0 1px var(--border);
}
.row.focus .node {
  box-shadow: 0 0 0 4px var(--bg), 0 0 0 7px var(--ink-3);
}
.title-line {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.row.side-her .title-line {
  justify-content: flex-end;
}
.title {
  min-width: 0;
  font-size: 14.5px;
  line-height: 1.45;
  text-align: inherit;
  word-break: break-word;
}
.entry.done .title {
  color: var(--ink-3);
  text-decoration: line-through;
}
.check {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  margin-top: 2px;
  border-radius: 5px;
  border: 1.5px solid var(--ink-3);
  font-size: 13px;
  color: var(--on-accent);
}
.check.on {
  background: var(--good);
  border-color: var(--good);
}
.sub {
  margin-top: 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--ink-3);
  word-break: break-word;
}
.tag-now {
  display: inline-block;
  margin-top: 4px;
  padding: 0 8px;
  border-radius: 999px;
  font-size: 11px;
  line-height: 18px;
  background: var(--her);
  color: var(--surface);
}
.checklist {
  display: grid;
  gap: 4px;
  margin-top: 6px;
}
.ck {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 13px;
  line-height: 1.45;
  color: var(--ink-2);
}
.ck input {
  margin-top: 3px;
  flex-shrink: 0;
}
.ck.on span {
  color: var(--ink-3);
  text-decoration: line-through;
}

/* —— 留言 —— */
.note-card {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  text-align: inherit;
}
.row.side-her .note-card {
  border-top-right-radius: 4px;
}
.row.side-me .note-card {
  border-top-left-radius: 4px;
}
.note-card.unread {
  border-color: var(--accent-line);
  background: var(--accent-soft);
}
.note-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ink-3);
}
.row.side-her .note-head {
  justify-content: flex-end;
}
.note-text {
  margin-top: 3px;
  font-size: 13.5px;
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 4;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.about {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 4px;
  font-size: 11.5px;
  color: var(--ink-3);
}
.row.side-her .about {
  justify-content: flex-end;
}
.answer {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--border);
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink-2);
}
.pending,
.replies-count {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--ink-3);
}
.row.side-her .replies-count {
  justify-content: flex-end;
}
.pending.warn {
  color: var(--warn);
}
.hint-card {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
}
.older {
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 2px 12px;
}
.older-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 0;
  text-align: left;
}
.older-row + .older-row {
  border-top: 1px solid var(--border);
}

.bottom-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  display: flex;
  gap: 10px;
  padding: 10px 16px calc(var(--safe-bottom) + 10px);
  background: var(--glass);
  backdrop-filter: blur(18px);
  -webkit-backdrop-filter: blur(18px);
  border-top: 1px solid var(--glass-line);
}
.bottom-bar > * {
  flex: 1;
}

/* —— 面板 —— */
.sheet-note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.warn-line {
  display: block;
  margin-top: 8px;
  font-size: 12.5px;
  color: var(--warn);
  text-decoration: none;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.about-chip {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--panel);
  font-size: 12.5px;
  color: var(--ink-2);
}
.thread-text {
  margin: 10px 0 0;
  font-size: 15px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.result {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
}
.result.accepted {
  border-left: 3px solid var(--good);
}
.result.declined {
  border-left: 3px solid var(--bad);
}
.replies {
  display: grid;
  gap: 8px;
  margin-top: 12px;
}
.reply {
  justify-self: start;
  max-width: 85%;
  padding: 7px 11px;
  border-radius: 14px;
  border-top-left-radius: 4px;
  background: var(--panel);
}
.reply.mine {
  justify-self: end;
  border-top-left-radius: 14px;
  border-top-right-radius: 4px;
  background: var(--accent-soft);
}
.reply .who {
  display: block;
  font-size: 11px;
  color: var(--ink-3);
}
.reply .said {
  font-size: 14px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}
.reply-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
}
.links {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
/* —— AI 记 —— */
.ai-review {
  margin-top: 12px;
}
.ai-summary {
  display: flex;
  gap: 8px;
  margin: 0;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 13.5px;
  line-height: 1.6;
}
.ai-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 9px 2px;
}
.ai-row + .ai-row {
  border-top: 1px solid var(--border);
}
.ai-row > input {
  flex-shrink: 0;
  margin-top: 4px;
}
.ai-row.off .ai-body {
  opacity: 0.45;
}
.ai-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  min-width: 0;
}
.ai-when {
  font-size: 12px;
  color: var(--accent-ink);
}
.ai-title {
  font-size: 14.5px;
  font-weight: 600;
  line-height: 1.45;
  word-break: break-word;
}
.ai-sub,
.ai-why {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-2);
  word-break: break-word;
}
.ai-why {
  color: var(--ink-3);
}
.ai-body .tag {
  margin-top: 3px;
  white-space: normal;
  text-align: left;
}
.cal-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 13px;
  color: var(--ink-2);
  text-decoration: none;
}
.cal-row.muted {
  color: var(--ink-3);
  font-size: 12.5px;
}
.links .chip {
  text-decoration: none;
}
</style>
