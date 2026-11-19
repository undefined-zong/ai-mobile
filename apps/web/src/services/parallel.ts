import { buildParallelMessages, errorText, herFill, isAbortError, mineFill, parallelPlanMessages, parallelPostInput, samplerRequest, socialCharacterFill, socialNowFill } from '@app/ai';
import {
  AGENT_META,
  applyScheduleChange,
  entryLabel,
  entryRef,
  getLocation,
  herEntries,
  hubParallelNoteId,
  locationResolver,
  myDayEntries,
  nowDayMinute,
  PARALLEL_USER,
  parallelDueTimes,
  parallelNames,
  parallelNoteMemory,
  parallelNoteText,
  parallelSources,
  parallelSourcesBasis,
  parseParallelPlan,
  parseParallelPost,
  parseParallelReply,
  parseParallelRequest,
  plannerDate,
  resolveParallelRef,
  shiftDate,
  TODO_KEY,
  worldOf,
  zonedDateKey,
  type Character,
  type ISODate,
  type MyDayInput,
  type ParallelContext,
  type ParallelEntry,
  type ParallelNote,
  type ParallelPlan,
  type ParallelPlanContext,
  type ParallelRef,
  type Persona,
  type Preset,
} from '@app/shared';
import { awakeOf, dayOf as socialDayOfCharacter, memoriesText } from './social';
import { MissingPresetError } from './prompt';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { useHealthStore } from '@/stores/health';
import { useHomeStore } from '@/stores/home';
import { useHubStore } from '@/stores/hub';
import { useLibraryStore } from '@/stores/library';
import { useMemoryStore } from '@/stores/memory';
import { useParallelStore } from '@/stores/parallel';
import { usePersonaStore } from '@/stores/personas';
import { usePlannerStore } from '@/stores/planner';
import { useRhythmStore } from '@/stores/rhythm';
import { uid } from '@/utils/id';

/**
 * 平行时空（设计文档 §9.16）要做的事：
 * - 拼你的一天（日程计划、家务、健康计划、你自己记的）和她的一天（今天的节律），勾、改、删都落到各自的来源上；
 * - 她给你留言（云端每天在随机的时间留，没连云端时 App 开着按同一套时间留，也能让她现在留一条）；
 * - 你留言、回她，她回你；你请她改今天的日程，她决定答不答应，答应了改进她今天的节律；
 * - 有你参与的留言写进她的记忆；今天的留言、你自己记的事写进聊天的提示词。
 */

// —— 谁、哪一天 ——

/** 平行时空的"今天"：节律日（凌晨 4 点起，"环境与作息"的时区） */
export function parallelToday(): ISODate {
  return useRhythmStore().today;
}

/** 在这个角色的平行时空里你是哪个人设：按和她那条聊天选的人设 */
export function personaFor(characterId: string): Persona {
  return usePersonaStore().forChat(useChatStore().chatOfCharacter(characterId));
}

function namesFor(characterId: string): (id: string) => string {
  const chars = useCharacterStore();
  return parallelNames(personaFor(characterId).name, (id) => chars.byId(id)?.name ?? '已删除的角色');
}

// —— 你的一天 ——

/**
 * 几份计划的材料（开着的系统才算）：不给日期时是各自的"今天"（日程计划按它排的时间、家务和健康按家务日）；
 * 给了日期取那一天的（整理你的一天、上传云端用）
 */
function sourceInput(persona: Persona, date?: ISODate): Omit<MyDayInput, 'day' | 'arranged'> {
  const planner = usePlannerStore();
  const health = useHealthStore();
  const plan = persona.planner?.enabled && planner.ready ? (planner.dayOf(persona.id, date ?? planner.today(persona)) ?? null) : null;
  const hDate = date ?? health.today();
  const healthOn = !!persona.health?.enabled;
  return {
    plan,
    planDone: plan ? planner.doneOf(persona.id, plan.date) : new Set<number>(),
    chores: persona.housework?.enabled ? (date ? useHomeStore().itemsOn(persona, date) : useHomeStore().itemsFor(persona)) : [],
    health: healthOn ? (health.dayOf(persona.id, hDate) ?? null) : null,
    workedOut: healthOn && health.logsOf(persona.id, hDate).some((l) => l.date === hDate),
    fitTime: healthOn ? persona.health!.timeOfDay : null,
    env: useEnvironmentStore().settings,
  };
}

/** 拼你的一天要的材料：几份计划、你在平行时空里记的改的、今天整理好的那一份 */
function myDayInput(persona: Persona, day = useParallelStore().dayOf(persona.id, parallelToday())): MyDayInput {
  return { ...sourceInput(persona), day, arranged: useParallelStore().planOf(persona.id, parallelToday()) };
}

/** 你今天的安排（时间线上右边那一列） */
export function myEntries(persona: Persona): ParallelEntry[] {
  return myDayEntries(myDayInput(persona));
}

/** 你某一天的安排：今天的就是时间线上那一列；别的日子按那天的几份计划（排了的才有）、你在平行时空里给那天记的拼（AI 记一件事查冲突用） */
export function myEntriesOn(persona: Persona, date: ISODate): ParallelEntry[] {
  if (date === parallelToday()) return myEntries(persona);
  const parallel = useParallelStore();
  return myDayEntries({ ...sourceInput(persona, date), day: parallel.dayOf(persona.id, date), arranged: parallel.planOf(persona.id, date) });
}

/** 从今天拿掉了的（"放回来"用）：名字 */
export function hiddenEntries(persona: Persona): ParallelEntry[] {
  const day = useParallelStore().dayOf(persona.id, parallelToday());
  const keys = Object.entries(day?.overrides ?? {}).filter(([, o]) => o.hidden).map(([k]) => k);
  if (!day || !keys.length) return [];
  const shown = { ...day, overrides: Object.fromEntries(Object.entries(day.overrides).map(([k, o]) => [k, { ...o, hidden: false }])) };
  return myDayEntries(myDayInput(persona, shown)).filter((e) => keys.includes(e.key));
}

/** 勾上 / 取消：家务勾在"共同的家"、计划勾在日程计划、吃饭健身待办勾在平行时空；对上了计划的一起勾；整理好的一项把它合成的那几项一起勾。返回不能勾的原因 */
export function toggleEntry(persona: Persona, e: ParallelEntry): string | void {
  return setEntryDone(persona, e, !e.done);
}

function setEntryDone(persona: Persona, e: ParallelEntry, done: boolean): string | void {
  const parallel = useParallelStore();
  const planner = usePlannerStore();
  const home = useHomeStore();
  const date = parallelToday();
  const syncPlan = () => {
    if (e.planIndex !== undefined) planner.setDone(persona.id, planner.today(persona), e.planIndex, done);
  };
  switch (e.kind) {
    case 'merged': {
      parallel.setOverride(persona.id, date, e.key, { done });
      const input = myDayInput(persona);
      const sources = parallelSources(input, input.day?.overrides);
      for (const k of e.parts ?? []) {
        const part = sources.find((x) => x.key === k);
        if (part && !!part.done !== done) setEntryDone(persona, part, done);
      }
      return;
    }
    case 'chore':
      if (!e.choreKey) return;
      if (done) home.finish(persona, e.choreKey);
      else home.undo(persona, e.choreKey);
      return syncPlan();
    case 'plan':
      return syncPlan();
    case 'workout':
      if (!done && myDayInput(persona).workedOut) return '今天有运动记录，算练过了';
      parallel.setOverride(persona.id, date, e.key, { done });
      return syncPlan();
    case 'meal':
      parallel.setOverride(persona.id, date, e.key, { done });
      return syncPlan();
    case 'todo': {
      // 待办那张清单整个勾；整理时拆开的一条（todo:标题）只勾这一条
      const checked = new Set(parallel.overrideOf(persona.id, date, TODO_KEY)?.checks ?? []);
      const titles = e.key === TODO_KEY ? (e.checklist ?? []).map((c) => c.key) : [e.key.slice('todo:'.length)];
      for (const t of titles) {
        if (done) checked.add(t);
        else checked.delete(t);
      }
      parallel.setOverride(persona.id, date, TODO_KEY, { checks: [...checked] });
      return;
    }
    case 'item':
      parallel.updateItem(persona.id, date, e.key.slice('item:'.length), { done });
      return;
    case 'slot':
      return;
  }
}

/** 勾清单里的一项 */
export function toggleCheck(persona: Persona, e: ParallelEntry, key: string) {
  const parallel = useParallelStore();
  const date = parallelToday();
  if (e.kind === 'item') {
    const it = parallel.itemOf(persona.id, date, e.key.slice('item:'.length));
    const c = it?.checklist.find((x) => x.id === key);
    if (c) c.done = !c.done;
    return;
  }
  const checked = new Set(parallel.overrideOf(persona.id, date, e.key)?.checks ?? []);
  if (checked.has(key)) checked.delete(key);
  else checked.add(key);
  parallel.setOverride(persona.id, date, e.key, { checks: [...checked] });
}

export interface EntryEdit {
  time: string;
  title: string;
  note: string;
  minutes: number;
}

/**
 * 改一项：日程计划的直接改在计划上；你自己记的改在平行时空；家务、健康、待办只改平行时空里怎么显示（做没做照旧）。
 * patch 只带改了的字段
 */
export function editEntry(persona: Persona, e: ParallelEntry, patch: Partial<EntryEdit>) {
  const date = parallelToday();
  if (e.kind === 'plan' && e.planIndex !== undefined) {
    const planner = usePlannerStore();
    return planner.editItem(persona.id, planner.today(persona), e.planIndex, patch);
  }
  if (e.kind === 'item') return useParallelStore().updateItem(persona.id, date, e.key.slice('item:'.length), patch);
  const { minutes: _minutes, ...rest } = patch;
  useParallelStore().setOverride(persona.id, date, e.key, rest);
}

/** 删一项：日程计划的从计划上删；你自己记的删掉；家务、健康、待办只从今天拿掉（"共同的家"里还在） */
export function removeEntry(persona: Persona, e: ParallelEntry) {
  const date = parallelToday();
  if (e.kind === 'plan' && e.planIndex !== undefined) {
    const planner = usePlannerStore();
    return planner.removeItem(persona.id, planner.today(persona), e.planIndex);
  }
  if (e.kind === 'item') return useParallelStore().removeItem(persona.id, date, e.key.slice('item:'.length));
  useParallelStore().setOverride(persona.id, date, e.key, { hidden: true });
}

/** 把拿掉的放回来 */
export function restoreEntry(persona: Persona, key: string) {
  useParallelStore().setOverride(persona.id, parallelToday(), key, { hidden: undefined });
}

// —— 整理你的一天：每天到点把日程计划、家务、健康计划（有几份用几份）整理成平行时空里你的一份计划 ——

/** 使用"整理你的一天"用途选中的预设。 */
export function planPreset(): Preset | undefined {
  return useLibraryStore().presetForUse('parallel-plan');
}

/** 能不能整理（API 接通了、有"平行时空 · 整理你的一天"预设）；不能时说明原因、去哪改 */
export function planStatus(): { ok: true } | { ok: false; reason: string; fix: string } {
  const s = useAiStore().status('parallel');
  if (!s.live) return { ok: false, reason: `「${AGENT_META.parallel.label}」的 API 还没接通：${s.reason}`, fix: '/me/api?feature=parallel' };
  if (!planPreset()) return { ok: false, reason: new MissingPresetError('平行时空 · 整理你的一天').message, fix: '/me/presets?cat=parallel' };
  return { ok: true };
}

/** 平行时空里会用到的人设（和各个角色聊天时选的） */
function parallelPersonas(): Persona[] {
  const seen = new Map<string, Persona>();
  for (const c of useCharacterStore().list) {
    const p = personaFor(c.id);
    seen.set(p.id, p);
  }
  return [...seen.values()];
}

/** 今天整理好的那份、整理之后几份计划有没有变（重排了、改了）、在不在整理、上次没整理成的原因 */
export function arrangedState(persona: Persona) {
  const parallel = useParallelStore();
  const date = parallelToday();
  const plan = parallel.planOf(persona.id, date);
  const key = `plan:${persona.id}`;
  return {
    plan,
    stale: !!plan && plan.basis !== parallelSourcesBasis(parallelSources(sourceInput(persona))),
    busy: !!parallel.busy[key],
    failure: parallel.failures[key] ?? parallel.planErrors.find((e) => e.personaId === persona.id && e.date === date)?.reason,
  };
}

/** 现在就整理（在手机上调 API）：今天整理过也重新整理 */
export async function arrangeDay(persona: Persona, date = parallelToday()): Promise<{ ok: true; plan: ParallelPlan } | { ok: false; reason: string }> {
  const parallel = useParallelStore();
  const key = `plan:${persona.id}`;
  if (parallel.busy[key]) return { ok: false, reason: '正在整理' };
  const status = planStatus();
  if (!status.ok) {
    parallel.failures[key] = status.reason;
    return status;
  }
  const sources = parallelSources(sourceInput(persona, date === parallelToday() ? undefined : date));
  if (!sources.length) {
    const reason = '日程计划、家务、健康计划里都还没有这一天的事';
    parallel.failures[key] = reason;
    return { ok: false, reason };
  }
  const preset = planPreset()!;
  const at = Date.now();
  parallel.busy[key] = true;
  delete parallel.failures[key];
  try {
    const { value, result } = await useAiStore().system.json(
      'parallel',
      {
        messages: parallelPlanMessages({ userName: persona.name, date, now: at, timeZone: useEnvironmentStore().settings.timezone, sources }, preset),
        ...samplerRequest(preset.sampler),
      },
      (v) => parseParallelPlan(v, sources, at.toString(36)),
    );
    const plan: ParallelPlan = { personaId: persona.id, date, items: value, basis: parallelSourcesBasis(sources), model: result.model, at, via: 'device' };
    parallel.setPlan(plan);
    return { ok: true, plan };
  } catch (e) {
    const reason = isAbortError(e) ? '取消了' : errorText(e);
    parallel.failures[key] = reason;
    return { ok: false, reason };
  } finally {
    delete parallel.busy[key];
  }
}

/** 云端替你整理要的（按人设）：今天、明天的几份计划（家务、健康计划在手机上；日程计划云端排好了用云端的）；不能整理时为空 */
export function parallelPlanCloudContext(persona: Persona): ParallelPlanContext | null {
  const preset = planPreset();
  if (!preset || !useAiStore().isLive('parallel')) return null;
  const parallel = useParallelStore();
  const env = useEnvironmentStore().settings;
  const today = parallelToday();
  return {
    persona: { id: persona.id, name: persona.name },
    timezone: env.timezone,
    planAt: parallel.settings.planAt,
    env: { wakeTime: env.wakeTime, sleepTime: env.sleepTime, meals: env.meals },
    fitTime: persona.health?.enabled ? persona.health.timeOfDay : null,
    days: [today, shiftDate(today, 1)].map((date) => {
      const input = sourceInput(persona, date);
      return { date, plan: input.plan, chores: input.chores, health: input.health };
    }),
    preset,
  };
}

/** 要上传云端的那几份（按人设 id） */
export function parallelPlanCloudContexts(): { id: string; context: ParallelPlanContext }[] {
  if (!useParallelStore().ready) return [];
  return parallelPersonas().flatMap((p) => {
    const context = parallelPlanCloudContext(p);
    return context ? [{ id: p.id, context }] : [];
  });
}

/**
 * 云端不整理（没连、Worker 是旧版）时，App 开着到点就在手机上整理：每个人设今天还没整理过、这次打开 App 还没试过才整理；
 * 没整理成的不在这里反复重试（平行时空设置里能"现在整理"）
 */
async function localArrange() {
  const hub = useHubStore();
  const parallel = useParallelStore();
  if (!parallel.ready || (hub.connected && (hub.supportsParallelPlan || !hub.status))) return;
  if (!planStatus().ok) return;
  const date = plannerDate(Date.now(), useEnvironmentStore().settings.timezone, parallel.settings.planAt);
  // 还没到今天的整理时间时算出来的是昨天：过去的日子不补
  if (date < parallelToday()) return;
  for (const p of parallelPersonas()) {
    const tried = `${p.id}:${date}`;
    if (parallel.planOf(p.id, date) || arrangeTried.has(tried)) continue;
    arrangeTried.add(tried);
    if (!parallelSources(sourceInput(p, date === parallelToday() ? undefined : date)).length) continue;
    await arrangeDay(p, date);
  }
}
const arrangeTried = new Set<string>();

// —— 她的一天 ——

/** 她今天的作息排成时间线（左边那一列，带地点 id 和地点的图标）；没有节律时为空 */
export function herTimeline(characterId: string): ParallelEntry[] {
  const day = useRhythmStore().todayOf(characterId);
  if (!day) return [];
  return herEntries({
    schedule: day.schedule.map((s) => {
      const loc = getLocation(s.locationId);
      return { from: s.from, to: s.to, place: loc?.name ?? s.locationId, status: s.status, ...(s.fixed ? { fixed: true } : {}), placeId: s.locationId, ...(loc?.icon ? { icon: loc.icon } : {}) };
    }),
    meals: day.meals,
    nowMin: nowDayMinute(Date.now(), useEnvironmentStore().settings.timezone),
  });
}

// —— 写进提示词 ——

/** 最近的留言写成文字：今天和昨天的最后几条；except：正在回的那条不算 */
function notesText(characterId: string, n = 6, except?: string): string {
  const parallel = useParallelStore();
  const today = parallelToday();
  const names = namesFor(characterId);
  const timeZone = useEnvironmentStore().settings.timezone;
  return parallel.notesOf(characterId).filter((x) => x.id !== except && x.date >= shiftDate(today, -1)).slice(-n).map((x) => parallelNoteText(x, names, timeZone, { replies: 4 })).join('\n');
}

/** 今天最后 4 条平行时空留言候选，由记忆拼装器按相关性和总预算选择。 */
export function parallelNotesLines(character: Character): { text: string; at: number }[] {
  const parallel = useParallelStore();
  if (!parallel.ready) return [];
  const list = parallel.notesOf(character.id, parallelToday()).slice(-4);
  if (!list.length) return [];
  const names = namesFor(character.id);
  const timeZone = useEnvironmentStore().settings.timezone;
  return list.map((n) => ({ text: parallelNoteText(n, names, timeZone, { replies: 4 }), at: n.at }));
}

/** "家务和健康"那一块里的平行时空：你自己记的今天的事、从今天拿掉的事（"写进聊天"关着、什么都没记时为空） */
export function parallelLines(persona: Persona): string {
  const parallel = useParallelStore();
  if (!parallel.ready || !parallel.settings.inChat) return '';
  const day = parallel.dayOf(persona.id, parallelToday());
  if (!day) return '';
  const own = day.items.map((it) => {
    const list = it.checklist.length ? `；清单：${it.checklist.map((c) => `${c.text}${c.done ? '✓' : ''}`).join('、')}` : '';
    return `- ${[it.time, it.title].filter(Boolean).join(' ')}${it.note ? `（${it.note}）` : ''}${list}${it.done ? ' ✓做完了' : ''}`;
  });
  const hidden = hiddenEntries(persona).map(entryLabel);
  return [
    own.length ? `【平行时空】${persona.name}自己记的今天的事：\n${own.join('\n')}` : '',
    hidden.length ? `${persona.name}在平行时空里把这些从今天拿掉了（今天不做了）：${hidden.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

// —— 能不能调模型 ——

export type ParallelResult = { ok: true; note: ParallelNote } | { ok: false; reason: string };

/** 使用"平行时空"用途选中的预设。 */
export function parallelPreset(character?: Character): Preset | undefined {
  const lib = useLibraryStore();
  return lib.withLorebooks(lib.presetForUse('parallel', character), character);
}

/** 能不能调模型（API 接通了、有平行时空预设）；不能时说明原因 */
export function parallelStatus(character?: Character): { ok: true } | { ok: false; reason: string } {
  const s = useAiStore().status('parallel');
  if (!s.live) return { ok: false, reason: `「${AGENT_META.parallel.label}」的 API 还没接通：${s.reason}` };
  if (!parallelPreset(character)) return { ok: false, reason: new MissingPresetError('平行时空').message };
  return { ok: true };
}

// —— 上传云端的那一份、她留言要的输入 ——

/** 她给你留言要的输入（按角色）：角色卡、两边今天的安排、记得的事、最近的聊天和留言 */
export function parallelContextOf(c: Character, preset: Preset | null, opts: { enabled?: boolean } = {}): ParallelContext {
  const parallel = useParallelStore();
  const persona = personaFor(c.id);
  const chat = useChatStore().chatOfCharacter(c.id);
  const env = useEnvironmentStore().settings;
  const her = socialDayOfCharacter(c.id);
  return {
    character: { id: c.id, name: c.name, pronoun: c.pronoun, card: c.card },
    persona: { id: persona.id, name: persona.name },
    timezone: env.timezone,
    settings: { enabled: opts.enabled ?? true, perDay: parallel.characterSettings(c.id).perDay },
    awake: awakeOf(her),
    env: { wakeTime: env.wakeTime, sleepTime: env.sleepTime, meals: env.meals },
    her,
    mine: { date: parallelToday(), entries: myEntries(persona) },
    memories: memoriesText(c, persona.name),
    recent: chat ? useChatStore().recentLines(chat.id, 12).join('\n') : '',
    notes: notesText(c.id),
    preset,
    preview: useHubStore().config.preview,
  };
}

/** 上传云端的那份：开着"她自己留言"、有平行时空预设的角色；不是时为空 */
export function parallelCloudContext(characterId: string): ParallelContext | null {
  const c = useCharacterStore().byId(characterId);
  const parallel = useParallelStore();
  if (!c || !parallel.ready || !parallel.characterSettings(characterId).enabled) return null;
  const preset = parallelPreset(c);
  return preset ? parallelContextOf(c, preset) : null;
}

// —— 写进记忆 ——

/** 有你参与的留言（你留的、你回过的）记进她的记忆：第一次写一条，之后来回多了改同一条；你删掉、归档过就不再动它 */
export function rememberNote(noteId: string) {
  const mem = useMemoryStore();
  const n = useParallelStore().noteById(noteId);
  if (!n || !mem.ready || !useCharacterStore().byId(n.characterId)) return;
  if (n.authorId !== PARALLEL_USER && !n.replies.some((r) => r.authorId === PARALLEL_USER)) return;
  const content = parallelNoteMemory(n, namesFor(n.characterId), useEnvironmentStore().settings.timezone);
  if (n.memoryId) {
    const old = mem.memoryById(n.memoryId);
    if (old && !old.deleted && old.status === 'active' && old.content !== content) mem.updateMemory(n.memoryId, { content, vector: null });
    return;
  }
  const now = Date.now();
  const id = uid('mem');
  mem.addMemory({
    id, characterId: n.characterId, chatId: useChatStore().chatOfCharacter(n.characterId)?.id, type: 'event', content,
    importance: n.kind === 'request' ? 4 : 3,
    pinned: false, status: 'active', dueAt: null, sourceMessageIds: [], happenedAt: n.at, vector: null, lastRecalledAt: null, recallCount: 0,
    createdAt: now, updatedAt: now,
  });
  n.memoryId = id;
}

// —— 她给你留言 ——

/** 让她现在留一条（手机上生成）；按排好的时间留的那条带着 id 和那天的日期，和云端算的一样，两边不会各留一条 */
export async function postNote(characterId: string, opts: { id?: string; date?: ISODate } = {}): Promise<ParallelResult> {
  const parallel = useParallelStore();
  const c = useCharacterStore().byId(characterId);
  if (!c) return { ok: false, reason: '找不到这个角色' };
  const status = parallelStatus(c);
  if (!status.ok) return status;
  const key = `post:${characterId}`;
  if (parallel.busy[key]) return { ok: false, reason: `${c.name}正在写` };
  const preset = parallelPreset(c)!;
  const context = parallelContextOf(c, preset);
  parallel.busy[key] = true;
  delete parallel.failures[key];
  try {
    const now = Date.now();
    const { input, her, mine } = parallelPostInput(context, now, context.her, context.mine?.entries ?? null);
    const { value, result } = await useAiStore().system.json('parallel', { messages: buildParallelMessages(input, preset), ...samplerRequest(preset.sampler) }, parseParallelPost);
    const about = resolveParallelRef(value.about, her, mine);
    const note = parallel.addNote({
      id: opts.id ?? uid('pnote'), characterId, date: opts.date ?? parallelToday(), authorId: c.id, text: value.text, kind: 'note',
      ...(about ? { about } : {}), replies: [], at: now, updatedAt: now, source: 'device', model: result.model,
      // 按时间自己留的算没看过；你点的那条就在眼前
      ...(opts.id ? { unread: true } : {}),
    });
    return { ok: true, note };
  } catch (e) {
    const reason = errorText(e);
    parallel.failures[key] = reason;
    return { ok: false, reason };
  } finally {
    delete parallel.busy[key];
  }
}

/** 云端留的：放进来 */
export function receiveHubNotes(list: ParallelNote[]): ParallelNote[] {
  return useParallelStore().ingest(list);
}

/**
 * 云端没接通（或者 Worker 是旧版）时，App 开着也替她们留：和云端同一套随机时间（parallelDueTimes），
 * 到点、还在 3 小时补发窗口里、这一条还没留过就留。云端接通后这里什么都不做
 */
async function localTick() {
  const hub = useHubStore();
  const parallel = useParallelStore();
  if (!parallel.ready || (hub.connected && (hub.supportsParallel || !hub.status))) return;
  if (!useAiStore().isLive('parallel')) return;
  const now = Date.now();
  const timezone = useEnvironmentStore().settings.timezone;
  const today = zonedDateKey(now, timezone);
  for (const c of useCharacterStore().list) {
    const settings = parallel.characterSettings(c.id);
    if (!settings.enabled) continue;
    const awake = awakeOf(socialDayOfCharacter(c.id));
    for (const date of [shiftDate(today, -1), today]) {
      for (const [slot, at] of parallelDueTimes({ characterId: c.id, date, perDay: settings.perDay, awake, timezone }).entries()) {
        const id = hubParallelNoteId(c.id, date, slot);
        if (at > now || now - at >= 3 * 3_600_000 || parallel.noteById(id) || parallel.removed.includes(id) || localTried.has(id)) continue;
        // 一条只试一次：失败了不在这里反复重试（平行时空里能"让她现在留一条"）
        localTried.add(id);
        await postNote(c.id, { id, date });
      }
    }
  }
}
const localTried = new Set<string>();
let scheduleStarted = false;

export function startParallelSchedule() {
  if (scheduleStarted) return;
  scheduleStarted = true;
  // 等云端状态同步回来再看要不要自己留
  setTimeout(() => void localTick().then(localArrange), 30_000);
  setInterval(() => void localTick().then(localArrange), 5 * 60_000);
}

// —— 你留言、你回她、你请她改日程 ——

/** 回你时的共同输入：角色、现在、两边今天的安排、记忆、最近的聊天和留言 */
function baseFills(c: Character, opts: { except?: string; ids?: boolean } = {}) {
  const persona = personaFor(c.id);
  const timeZone = useEnvironmentStore().settings.timezone;
  const chat = useChatStore().chatOfCharacter(c.id);
  const her = herTimeline(c.id);
  const mine = myEntries(persona);
  const day = socialDayOfCharacter(c.id);
  const notes = notesText(c.id, 6, opts.except);
  return {
    persona,
    her,
    mine,
    fills: {
      parallelCharacter: socialCharacterFill({ id: c.id, name: c.name, pronoun: c.pronoun, card: c.card }, persona.name),
      parallelNow: socialNowFill(Date.now(), timeZone).text,
      parallelHer: herFill(day, her, c.name, { ids: opts.ids }),
      parallelMine: mineFill(mine, persona.name),
      parallelMemories: memoriesText(c, persona.name),
      parallelRecent: chat ? `最近的聊天：\n${useChatStore().recentLines(chat.id, 8).join('\n')}` : '',
      parallelNotes: notes ? `之前的留言：\n${notes}` : '',
    },
  };
}

/** 说的是哪一项写成编号（"[C3] 15:00–17:00 写论文"），对不上时只写名字 */
function aboutText(about: ParallelRef | undefined, her: ParallelEntry[], mine: ParallelEntry[]): string {
  if (!about) return '';
  const list = about.side === 'her' ? her : mine;
  const i = list.findIndex((e) => e.key === about.key);
  return i >= 0 ? `[${entryRef(about.side, i)}] ${about.label}` : about.label;
}

/** 你留一条言：写进来，然后她回你（回复在后面慢慢来） */
export function sendNote(characterId: string, text: string, about?: ParallelRef): ParallelNote | undefined {
  const said = text.trim();
  if (!said) return undefined;
  const now = Date.now();
  const note = useParallelStore().addNote({
    id: uid('pnote'), characterId, date: parallelToday(), authorId: PARALLEL_USER, text: said, kind: 'note',
    ...(about ? { about } : {}), replies: [], at: now, updatedAt: now, source: 'user',
  });
  rememberNote(note.id);
  void replyTo(note.id);
  return note;
}

/** 你在一条留言下面回她：写进来，她再回你 */
export function userReply(noteId: string, text: string) {
  const parallel = useParallelStore();
  if (!parallel.addReply(noteId, PARALLEL_USER, text)) return;
  rememberNote(noteId);
  void replyTo(noteId);
}

/** 她回这一条留言（你留的，或者你在下面回了她） */
export async function replyTo(noteId: string): Promise<void> {
  const parallel = useParallelStore();
  const n = parallel.noteById(noteId);
  const c = useCharacterStore().byId(n?.characterId);
  if (!n || !c) return;
  const key = `reply:${noteId}`;
  if (parallel.busy[key]) return;
  const status = parallelStatus(c);
  if (!status.ok) {
    parallel.failures[key] = status.reason;
    return;
  }
  const preset = parallelPreset(c)!;
  const timeZone = useEnvironmentStore().settings.timezone;
  const names = namesFor(c.id);
  const { persona, her, mine, fills } = baseFills(c, { except: noteId });
  const lastMine = [...n.replies].reverse().find((r) => r.authorId === PARALLEL_USER);
  const about = aboutText(n.about, her, mine);
  const ask = lastMine
    ? `这一次：${persona.name}在这条留言下面说了「${lastMine.text}」，${c.name}回复这一句。`
    : `这一次：${persona.name}刚在平行时空里留了这条言${about ? `（说的是 ${about}）` : ''}，${c.name}回复。`;
  parallel.busy[key] = true;
  delete parallel.failures[key];
  try {
    const { value } = await useAiStore().system.json(
      'parallel',
      {
        messages: buildParallelMessages({
          task: 'parallel-reply', characterName: c.name, pronoun: c.pronoun, userName: persona.name, now: new Date(), timeZone,
          fills: { ...fills, parallelThread: `这一条留言和下面的回复：\n${parallelNoteText(n, names, timeZone, { replies: 12 })}`, parallelAsk: ask },
        }, preset),
        ...samplerRequest(preset.sampler),
      },
      parseParallelReply,
    );
    if (!parallel.noteById(noteId)) return;
    parallel.addReply(noteId, c.id, value.text);
    rememberNote(noteId);
  } catch (e) {
    if (!isAbortError(e)) parallel.failures[key] = errorText(e);
  } finally {
    delete parallel.busy[key];
  }
}

/** 你请她改今天的日程：写进来，然后她决定（在后面慢慢来） */
export function requestChange(characterId: string, text: string, about?: ParallelRef): ParallelNote | undefined {
  const said = text.trim();
  if (!said) return undefined;
  const now = Date.now();
  const note = useParallelStore().addNote({
    id: uid('pnote'), characterId, date: parallelToday(), authorId: PARALLEL_USER, text: said, kind: 'request',
    ...(about ? { about } : {}), replies: [], at: now, updatedAt: now, source: 'user',
  });
  rememberNote(note.id);
  void decideRequest(note.id);
  return note;
}

/**
 * 她决定答不答应：答应了把她写的那几段插进今天的节律（检查过：固定的事不挪、盖满一整天），
 * 她此刻在哪、聊天里她在做什么都跟着变；她回你一句。没做成时可以重试
 */
export async function decideRequest(noteId: string): Promise<void> {
  const parallel = useParallelStore();
  const rhythm = useRhythmStore();
  const n = parallel.noteById(noteId);
  const c = useCharacterStore().byId(n?.characterId);
  if (!n || !c || n.request) return;
  const key = `request:${noteId}`;
  if (parallel.busy[key]) return;
  const status = parallelStatus(c);
  if (!status.ok) {
    parallel.failures[key] = status.reason;
    return;
  }
  const template = rhythm.templateOf(c.id);
  if (!rhythm.todayOf(c.id) || !template) {
    parallel.failures[key] = `${c.name}还没有节律：先在"我的 → 节律"里建世界`;
    return;
  }
  const preset = parallelPreset(c)!;
  const timeZone = useEnvironmentStore().settings.timezone;
  const world = worldOf(c.id);
  const { persona, her, mine, fills } = baseFills(c, { except: noteId, ids: true });
  const about = aboutText(n.about, her, mine);
  parallel.busy[key] = true;
  delete parallel.failures[key];
  try {
    const { value } = await useAiStore().system.json(
      'parallel',
      {
        messages: buildParallelMessages({
          task: 'parallel-request', characterName: c.name, pronoun: c.pronoun, userName: persona.name, now: new Date(), timeZone,
          fills: {
            ...fills,
            parallelWorld: `${world.name}里的地点（地点 id：名字 · 室内或室外 · 一句话）：\n${world.locations.map((l) => `- ${l.id}：${l.name} · ${l.indoor ? '室内' : '室外'}${l.blurb ? ` · ${l.blurb}` : ''}`).join('\n')}`,
            parallelAsk: `这一次：${persona.name}请${c.name}改今天的日程：「${n.text}」${about ? `（说的是 ${about}）` : ''}。`,
          },
        }, preset),
        ...samplerRequest(preset.sampler),
      },
      parseParallelRequest,
    );
    const now = parallel.noteById(noteId);
    if (!now) return;
    const day = rhythm.todayOf(c.id);
    const change = value.accept && day && value.schedule.length
      ? applyScheduleChange(day.schedule, value.schedule, { template, resolve: locationResolver(world.locations, c.id), placeName: (id) => getLocation(id)?.name ?? id })
      : null;
    if (change) {
      const edit = rhythm.editToday(c.id);
      if (edit) edit.schedule = change.schedule;
      rhythm.tick();
    }
    now.request = value.accept
      ? { status: 'accepted', changes: change?.changes ?? [], ...(change?.fixes.length ? { fixes: change.fixes } : !change && value.schedule.length ? { fixes: ['写的时间、地点用不上，作息没变'] } : {}) }
      : { status: 'declined', changes: [] };
    parallel.addReply(noteId, c.id, value.text);
    rememberNote(noteId);
  } catch (e) {
    if (!isAbortError(e)) parallel.failures[key] = errorText(e);
  } finally {
    delete parallel.busy[key];
  }
}
