import { buildHealthMessages, errorReport, errorText, samplerRequest, type HealthFill } from '@app/ai';
import {
  bmiOf,
  FIT_TIME_LABEL,
  healthDayAsk,
  healthNearbyText,
  healthSpot,
  healthTodayText,
  healthWeekAsk,
  healthWeekText,
  MEAL_KEYS,
  MEAL_LABEL,
  parseHealthDay,
  parseHealthWeek,
  parseShopping,
  plannerDate,
  rhythmDate,
  shiftDate,
  weatherLine,
  weekdayOf,
  weekStartOf,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  type HealthDayPlan,
  type HealthPlanContext,
  matchHealthSpots,
  type NearbyBlock,
  type NearbyFound,
  type HealthRunResult,
  type HealthSettings,
  type HealthTask,
  type HealthWeekPlan,
  type ExtraChore,
  type ISODate,
  type MealSpot,
  type Persona,
  type PrepTask,
  matchWatchLog,
  mergeWatch,
  overlapShare,
  watchSportName,
  type WatchSource,
  type WatchWorkout,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { services } from '@/services';
import { loadFitnessSession, sessionSpan } from '@/services/fitnessSession';
import { countryAt } from '@/utils/shopping';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { useEnvironmentStore } from './environment';
import { useHomeStore } from './home';
import { useLibraryStore } from './library';
import { usePersonaStore } from './personas';
import { useRealWorldStore } from './realworld';
import { useWeatherStore } from './weather';

/**
 * 健康计划（设计文档 §9.13）：按你人设里的健康设置，「健康计划」用「健康」预设排这周和今天的健身计划、饮食计划；
 * "健身"里照着今天的计划一个动作一个动作地练，练完的记录也记在这里（按人设，和哪个角色一起练的都算）。
 * 存在本机（settings 表的 health 一项）：最近 6 周的周计划、30 天的日计划、90 条运动记录。
 * 每天到点（健康设置里的 runAt，默认 04:00）自动排今天的（这周的还没排就先排这周）：连了云端时云端排（PWA 关着也排，
 * 材料是手机拼好传上去的，见 cloudContext），没连时 App 开着到点在手机上排；打开健康计划、"健身"里选"按照计划"时没排过的也会排。
 * 接了 Google 地图（健康设置里没关"参考附近的店"）时，排之前先搜附近能吃饭的地方和超市（缓存一天）：
 * 外食只从这些真实的店里挑，要买的东西按这些超市和你那里能用的网店（美国：Amazon、Kroger、Walmart……）真能买到的写。
 * 发给模型的是店名、种类、距离、价位、评分、营业时间，不发地址和坐标。
 * 做饭时间是 0 的那顿可以带提前做好的便当：排今天时写出今天要提前做的事（prep），开了家务系统就发到今天的家务里
 * （"共同的家"能开始、打勾、拖），每件带没来得及做的备案；第二天排计划时看昨天那件做没做，没做就照备案。
 */

export type HealthResult<T> = { ok: true; value: T } | { ok: false; reason: string; detail?: string; notConnected?: boolean };

/** 一次运动的记录（"健身"结束时记） */
export interface WorkoutLog {
  id: string;
  personaId: string;
  characterId: string | null;
  /** 家务日（凌晨 4 点算起） */
  date: ISODate;
  startedAt: number;
  /** 结束的时刻（旧记录没有：按开始 + 时长算） */
  endedAt?: number;
  durationSec: number;
  mode: 'plan' | 'free';
  /** 随便动动的方式（跑步、跳绳……），照计划练的是计划的标题 */
  sport: string;
  plan?: { title: string; done: number; total: number };
  outdoor: boolean;
  distanceKm?: number;
  steps?: number;
  hrAvg?: number;
  hrMax?: number;
  kcal?: number;
  /** 这些数从哪来：auto 安卓自动记的 / manual 手动填的 / estimate 估的 / watch 手表的（快捷指令、Health Auto Export 推来的） */
  source: 'auto' | 'manual' | 'estimate' | 'watch';
  /** 对上了手表的运动（或者是只在手表上练的那次） */
  watch?: WorkoutWatchInfo;
}

/** 一条运动记录用了哪次手表的运动、怎么用的 */
export interface WorkoutWatchInfo {
  id: string;
  source: WatchSource;
  device?: string;
  /** 用了手表的数没有（手表忘了停、又没有逐分钟的数时没用） */
  used: boolean;
  note?: string;
  /** 没开 App、只在手表上练的：这条记录是照手表那次记的 */
  only?: boolean;
  /** 用的是那次的哪个版本（同一次再推来、数变了要重新用） */
  sig: string;
}

/** 手表的数据从哪来（"我的 → 手表数据"） */
export type WatchMode = 'off' | 'shortcut' | 'hae';
export interface WatchSettings {
  mode: WatchMode;
  /** 快捷指令叫什么（"用手表的数据更新"按这个名字打开它） */
  shortcutName: string;
  /** 什么时候开的：这之前的、只在手表上练的不单独记（Health Auto Export 第一次会把以前的都推上来） */
  since: number;
}
export const DEFAULT_WATCH: WatchSettings = { mode: 'off', shortcutName: '运动回填', since: 0 };

/** 对手表的运动的结果（横幅里说一句） */
export interface WatchOutcome {
  kind: 'updated' | 'created';
  log: WorkoutLog;
  workout: WatchWorkout;
}

interface Saved {
  weeks?: HealthWeekPlan[];
  days?: HealthDayPlan[];
  logs?: WorkoutLog[];
  watch?: WatchSettings;
  /** 最近收到的手表运动（对上的、没对上的都留着，"手表数据"页里看得到） */
  watchInbox?: WatchWorkout[];
}

const KEEP_INBOX = 40;
/** 只在手表上练的：结束 2 小时以后还没有对得上的 App 记录，才单独记一条（留时间在 App 里发给她） */
const WATCH_ONLY_AFTER_MS = 2 * 3600_000;
/** 太久以前的不单独记 */
const WATCH_ONLY_WITHIN_MS = 3 * 86_400_000;

/** 同一次手表运动的"版本"：这些数变了就要重新用 */
export const watchSig = (w: WatchWorkout) => JSON.stringify([w.startedAt, w.endedAt, w.durationSec, w.kcal, w.km, w.steps, w.hrAvg, w.hrMax, w.minutes?.length ?? 0]);

function hashId(s: string): string {
  let h = 5381;
  for (const ch of s) h = ((h << 5) + h + ch.codePointAt(0)!) >>> 0;
  return h.toString(36);
}

const KEEP_WEEKS = 6;
const KEEP_DAYS = 30;
const KEEP_LOGS = 90;

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/** 要提前做的事在家务里的 id：同名的同一件（重新排时做过的记录留着） */
function prepId(name: string): string {
  let h = 5381;
  for (const ch of name.trim()) h = ((h << 5) + h + ch.codePointAt(0)!) >>> 0;
  return `hp-${h.toString(36)}`;
}

/** 要提前做的事发到家务里时用的那一件 */
export function prepExtra(t: PrepTask): ExtraChore {
  return {
    id: prepId(t.name),
    name: t.name,
    kind: 'cooking',
    slot: t.when,
    minutes: t.minutes,
    source: 'health',
    ...(t.meal ? { meal: t.meal } : {}),
    ...(t.steps.length ? { steps: t.steps } : {}),
    ...(t.backup ? { backup: t.backup } : {}),
    ...(t.backupSpot ? { backupSpot: t.backupSpot } : {}),
  };
}

/** "11-12 跑步 25 分钟 · 3.1 公里 · 平均心率 142 · 约 260 千卡" */
export function workoutLine(l: WorkoutLog, withDate = true): string {
  const parts = [
    `${l.mode === 'plan' && l.plan ? `照计划练「${l.plan.title}」（做完 ${l.plan.done}/${l.plan.total} 个动作）` : l.sport} ${Math.max(1, Math.round(l.durationSec / 60))} 分钟`,
    l.distanceKm ? `${l.distanceKm.toFixed(2)} 公里` : '',
    l.steps ? `${l.steps} 步` : '',
    l.hrAvg ? `平均心率 ${l.hrAvg}${l.hrMax ? `，最高 ${l.hrMax}` : ''}` : '',
    l.kcal ? `约 ${l.kcal} 千卡` : '',
  ].filter(Boolean);
  return `${withDate ? `${l.date.slice(5)} ` : ''}${parts.join(' · ')}`;
}

export const useHealthStore = defineStore('health', () => {
  const weeks = ref<HealthWeekPlan[]>([]);
  const days = ref<HealthDayPlan[]>([]);
  const logs = ref<WorkoutLog[]>([]);
  const watch = ref<WatchSettings>({ ...DEFAULT_WATCH });
  const watchInbox = ref<WatchWorkout[]>([]);
  /** 正在排（按人设） */
  const busy = reactive<Record<string, 'week' | 'day' | undefined>>({});
  /** 最近一次排失败的原因（只在内存里） */
  const errors = reactive<Record<string, { reason: string; detail?: string; notConnected?: boolean } | undefined>>({});

  // 别的设备排的健康计划、运动记录（同步）：放进来
  const saver = autoSave('settings', () => [{ key: 'health', value: { weeks: weeks.value, days: days.value, logs: logs.value, watch: watch.value, watchInbox: watchInbox.value } }], () => [weeks.value, days.value, logs.value, watch.value, watchInbox.value],
    { apply: ([c]) => { if (c && !c.deleted) load(c.value as Saved); } });

  async function hydrate() {
    load(await getOne<Saved>('settings', 'health'));
    saver.start();
  }

  function load(saved: Saved | null | undefined) {
    if (saved && typeof saved === 'object') {
      // 以前存的"要买的东西"是一行一行的文字：读成现在的格式（名字、多少、在哪买、搜什么）
      if (Array.isArray(saved.weeks)) weeks.value = saved.weeks.filter((w) => w && Array.isArray(w.days)).map((w) => ({ ...w, shopping: parseShopping(w.shopping) }));
      if (Array.isArray(saved.days)) days.value = saved.days.filter((d) => d && d.meals && typeof d.date === 'string');
      if (Array.isArray(saved.logs)) logs.value = saved.logs.filter((l) => l && typeof l.durationSec === 'number');
      if (saved.watch && typeof saved.watch === 'object') watch.value = { ...DEFAULT_WATCH, ...saved.watch };
      if (Array.isArray(saved.watchInbox)) watchInbox.value = saved.watchInbox.filter((w) => w && typeof w.id === 'string' && typeof w.startedAt === 'number');
    }
  }

  function today(): ISODate {
    return useHomeStore().today || rhythmDate(new Date(), useEnvironmentStore().settings.timezone);
  }

  function weekOf(personaId: string, weekStart = weekStartOf(today())): HealthWeekPlan | undefined {
    return weeks.value.find((w) => w.personaId === personaId && w.weekStart === weekStart);
  }
  function dayOf(personaId: string, date = today()): HealthDayPlan | undefined {
    return days.value.find((d) => d.personaId === personaId && d.date === date);
  }
  function logsOf(personaId: string, sinceDate?: ISODate): WorkoutLog[] {
    return logs.value.filter((l) => l.personaId === personaId && (!sinceDate || l.date >= sinceDate)).sort((a, b) => b.startedAt - a.startedAt);
  }

  // —— 拼「健康」要的输入 ——

  function profileText(name: string, h: HealthSettings): string {
    const body = [h.heightCm ? `身高 ${h.heightCm} cm` : '', h.weightKg ? `体重 ${h.weightKg} kg` : '', bmiOf(h) ? `BMI ${bmiOf(h)}` : '', h.targetWeightKg ? `目标体重 ${h.targetWeightKg} kg` : '', h.age ? `${h.age} 岁` : '', h.sex ? (h.sex === 'male' ? '男' : '女') : '']
      .filter(Boolean)
      .join('，');
    return [`${name}：${body || '身高体重没填'}`, `目标：${h.goal.trim() || '没写（按保持健康、慢慢变好来排）'}`, h.note.trim() ? `身体情况：${h.note.trim()}` : ''].filter(Boolean).join('\n');
  }
  function timeText(h: HealthSettings): string {
    const week = WEEKDAY_ORDER.map((d) => `${WEEKDAY_LABEL[d]} ${h.weekMinutes[d] ? `${h.weekMinutes[d]} 分钟` : '不练'}`).join('、');
    return [`能接受的健身方式：${h.methods.join('、') || '没写（按在家就能做的来）'}`, `一周里每天能练多久：${week}`, `一般在${FIT_TIME_LABEL[h.timeOfDay]}练${h.timeOfDay === 'any' ? '（什么时候都行）' : ''}`, h.timeNote.trim() ? `补充：${h.timeNote.trim()}` : ''].filter(Boolean).join('\n');
  }
  function kitchenText(h: HealthSettings): string {
    const zero = h.bento === 'off' ? ' 0 分钟（这顿不做饭，外食）' : ' 0 分钟（这顿不做饭：外食，或者吃提前做好带去的）';
    const cook = MEAL_KEYS.map((k) => `${MEAL_LABEL[k]}${h.cookMinutes[k] ? ` ${h.cookMinutes[k]} 分钟` : zero}`).join('；');
    const bento = h.bento === 'off' ? '不带' : h.bento === 'cold' ? '能带，但带去了热不了（挑凉着也好吃的）' : '能带，带去了能用微波炉热';
    return [
      `家里常有的食材：${h.ingredients.join('、') || '没写'}`,
      `忌口 / 过敏：${h.avoid.trim() || '没有'}`,
      `每顿能花多久做饭：${cook}`,
      MEAL_KEYS.some((k) => !h.cookMinutes[k]) ? `带便当：${bento}` : '',
      `有的厨具：${h.tools.join('、') || '没写'}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  /** "今天"那一块：今天的带上现在的天气（以后的那天不知道天气） */
  function todayText(date: ISODate): string {
    const w = date === today() ? useWeatherStore().envInput(null).weather : null;
    return healthTodayText(date, w ? weatherLine(w) : '');
  }
  function recentText(personaId: string, date: ISODate): string {
    const since = shiftDate(date, -7);
    const ls = logsOf(personaId, since).filter((l) => l.date < date || l.date === date);
    const persona = usePersonaStore().byId(personaId);
    const cooked: string[] = [];
    if (persona) {
      const home = useHomeStore();
      for (const d of Object.values(home.history(personaId))) {
        if (d.date < since) continue;
        for (const [k, m] of Object.entries(d.marks)) {
          const chore = persona.housework?.chores.find((c) => k.startsWith(`${c.id}:`));
          if (chore?.kind === 'cooking' && m.status === 'done') cooked.push(`${d.date.slice(5)}${m.note ? ` ${m.note}` : ' 做了饭'}`);
        }
      }
    }
    // 昨天排的饭：昨晚顺手备了今天的便当，今天就吃那份
    const y = dayOf(personaId, shiftDate(date, -1));
    const yMeals = y
      ? (['breakfast', 'lunch', 'dinner', 'snack'] as const)
          .map((k) => {
            const m = y.meals[k];
            if (!m) return '';
            const how = m.bento ? '（吃提前做好的）' : !m.cook && m.place ? `（在${m.place}吃）` : '';
            return `${MEAL_LABEL[k]} ${m.name}${how}`;
          })
          .filter(Boolean)
      : [];
    // 昨天要提前做的（便当、隔夜燕麦）：家务里勾了没有；没开家务系统的不知道做没做
    const yd = shiftDate(date, -1);
    const home = useHomeStore();
    const published = home.extrasOf(personaId, yd).filter((x) => x.source === 'health');
    const yPrep = published.length
      ? published.map((x) => {
          const done = home.markOn(personaId, yd, `extra:${x.id}`)?.status === 'done';
          return `- ${x.name}${x.meal ? `（给${x.meal}）` : ''}：${done ? '做了' : `没做（在家务里没勾）${x.backup ? `，备案：${x.backup}` : ''}`}`;
        })
      : (y?.prep ?? []).map((t) => `- ${t.name}${t.meal ? `（给${t.meal}）` : ''}：不知道做没做（没开家务系统）${t.backup ? `，备案：${t.backup}` : ''}`);
    return [
      ls.length ? `最近 7 天的运动：\n${ls.map((l) => `- ${workoutLine(l)}`).join('\n')}` : '最近 7 天没有运动记录',
      cooked.length ? `最近自己做的饭：${cooked.join('；')}` : '',
      yMeals.length ? `昨天排的饭：${yMeals.join('；')}` : '',
      yPrep.length ? `昨天要提前做的：\n${yPrep.join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  // —— 附近能吃的、能买的（接了 Google 地图时） ——

  /** 排计划前搜附近、写成给模型看的那一块（见 searchNearby） */
  async function nearbyFor(persona: Persona, task: HealthTask, date: ISODate): Promise<NearbyBlock> {
    const found = await searchNearby(persona, task);
    // 家附近的那一份留着：云端到点排的时候用（云端查不了 Google 地图，Key 只在这台设备上）
    if (found.home) nearbyMemo[persona.id] = { at: Date.now(), found };
    return healthNearbyText(found, task, date);
  }

  /** 每个人设上次按家搜到的附近的店（只在内存里，地图那边本来缓存一天） */
  const nearbyMemo = reactive<Record<string, { at: number; found: Found } | undefined>>({});
  /** 搜到的附近的店，home = 按家搜的 */
  type Found = NearbyFound & { home: boolean };

  /**
   * 排计划前搜附近：排今天时你出门了（打开 App 时定位到不在家）按你现在在的地方，不然按家。
   * 没接 Google 地图、健康设置里关了时什么都不搜（这一块不发，外食照旧写怎么选）
   */
  async function searchNearby(persona: Persona, task: HealthTask): Promise<Found> {
    const nothing = (why: string): Found => ({ food: [], stores: [], label: '', why: '', home: false, none: why });
    if (persona.health?.nearby === false) return nothing('');
    const real = useRealWorldStore();
    if (!real.mapsReady) return nothing('');
    const here = real.here;
    const useHere = !!here && (!real.homeGeo || (task === 'plan-day' && !real.atHome));
    const center = useHere ? here : real.homeGeo;
    if (!center) return nothing('附近的店没查：家的地址还没换成坐标（在"我的世界"里填家的地址，或者打开定位）');
    const label = useHere ? '你现在在的地方附近' : '家附近';
    const country = countryAt(useHere ? real.hereCountry : real.homeGeo?.countryCode, center);
    const at = { lat: center.lat, lng: center.lng };
    const [f, g] = await Promise.allSettled([services.maps.food(at), services.maps.groceries(at)]);
    const food = f.status === 'fulfilled' ? f.value.slice(0, 20) : [];
    const stores = g.status === 'fulfilled' ? g.value : [];
    const failed = [f, g].find((r): r is PromiseRejectedResult => r.status === 'rejected');
    const why = failed ? errorText(failed.reason) : '';
    if (!food.length && !stores.length) return { ...nothing(why ? `附近的店没查到：${why}` : `${label}没搜到能吃饭的地方和超市`), ...(country ? { country } : {}), home: !useHere };
    return { food, stores, ...(country ? { country } : {}), label, why, home: !useHere };
  }

  /** 调「健康计划」：按「健康」预设拼提示词，读回 JSON */
  async function call<T>(persona: Persona, task: 'plan-week' | 'plan-day', fills: Partial<Record<HealthFill, string>>, parse: (v: unknown) => T | null): Promise<HealthResult<{ value: T; model: string }>> {
    const ai = useAiStore();
    const status = ai.status('health');
    if (!status.live) return { ok: false, reason: `「健康计划」还没接通：${status.reason}`, notConnected: true };
    const preset = useLibraryStore().presetForUse('health');
    if (!preset) return { ok: false, reason: '没有健康预设：去"我的 → 预设 → 健康"导入或恢复一个' };
    try {
      const character = useCharacterStore().byId(useAppStore().activeCharacterId);
      const messages = buildHealthMessages({ task, userName: persona.name, characterName: character?.name, pronoun: character?.pronoun, fills }, preset);
      const { value, result } = await ai.system.json('health', { messages, ...samplerRequest(preset.sampler) }, parse);
      return { ok: true, value: { value, model: result.model } };
    } catch (e) {
      return { ok: false, reason: errorText(e), detail: errorReport(e) };
    }
  }

  function base(persona: Persona): Partial<Record<HealthFill, string>> | null {
    const h = persona.health;
    if (!h?.enabled) return null;
    return { healthProfile: profileText(persona.name, h), healthTime: timeText(h), healthKitchen: kitchenText(h) };
  }

  /** 排这周（force：排过了也重新排） */
  async function planWeek(persona: Persona, opts: { force?: boolean } = {}): Promise<HealthResult<HealthWeekPlan>> {
    const date = today();
    const weekStart = weekStartOf(date);
    const have = weekOf(persona.id, weekStart);
    if (have && !opts.force) return { ok: true, value: have };
    const fills = base(persona);
    if (!fills) return { ok: false, reason: '健康系统还没打开：在"我的人设 → 健康"里打开' };
    if (busy[persona.id]) return { ok: false, reason: '正在排' };
    busy[persona.id] = 'week';
    try {
      const nearby = await nearbyFor(persona, 'plan-week', date);
      const r = await call(persona, 'plan-week', {
        ...fills,
        healthNearby: nearby.text,
        healthToday: todayText(date),
        healthRecent: recentText(persona.id, date),
        healthAsk: healthWeekAsk(date, weekStart),
      }, parseHealthWeek);
      if (!r.ok) {
        errors[persona.id] = { reason: r.reason, detail: r.detail, notConnected: r.notConnected };
        return r;
      }
      const plan: HealthWeekPlan = {
        ...r.value.value,
        personaId: persona.id,
        weekStart,
        ...(nearby.stores.length ? { stores: nearby.stores.map(healthSpot) } : {}),
        ...(nearby.country ? { country: nearby.country } : {}),
        ...(nearby.near ? { near: nearby.near } : {}),
        model: r.value.model,
        at: Date.now(),
      };
      weeks.value = [plan, ...weeks.value.filter((w) => !(w.personaId === persona.id && w.weekStart === weekStart))].slice(0, KEEP_WEEKS * 4);
      delete errors[persona.id];
      return { ok: true, value: plan };
    } finally {
      delete busy[persona.id];
    }
  }

  /** 排今天：这周还没排就先排这周（today 照这周的计划来） */
  async function planDay(persona: Persona, opts: { force?: boolean } = {}): Promise<HealthResult<HealthDayPlan>> {
    const date = today();
    const have = dayOf(persona.id, date);
    if (have && !opts.force) return { ok: true, value: have };
    const fills = base(persona);
    if (!fills) return { ok: false, reason: '健康系统还没打开：在"我的人设 → 健康"里打开' };
    let week = weekOf(persona.id);
    if (!week) {
      const w = await planWeek(persona);
      if (!w.ok) return w;
      week = w.value;
    }
    if (busy[persona.id]) return { ok: false, reason: '正在排' };
    busy[persona.id] = 'day';
    try {
      const nearby = await nearbyFor(persona, 'plan-day', date);
      const r = await call(persona, 'plan-day', {
        ...fills,
        healthNearby: nearby.text,
        healthToday: todayText(date),
        healthWeek: healthWeekText(week, date),
        healthRecent: recentText(persona.id, date),
        healthAsk: healthDayAsk(date, week, persona.health?.weekMinutes ?? []),
      }, parseHealthDay);
      if (!r.ok) {
        errors[persona.id] = { reason: r.reason, detail: r.detail, notConnected: r.notConnected };
        return r;
      }
      const value = r.value.value;
      matchHealthSpots(value, nearby.food);
      const plan: HealthDayPlan = { ...value, personaId: persona.id, date, ...(nearby.near ? { near: nearby.near } : {}), model: r.value.model, at: Date.now() };
      days.value = [plan, ...days.value.filter((d) => !(d.personaId === persona.id && d.date === date))].slice(0, KEEP_DAYS * 2);
      delete errors[persona.id];
      syncPrep(persona);
      return { ok: true, value: plan };
    } finally {
      delete busy[persona.id];
    }
  }

  // —— 每天到点自动排：云端排（材料是这里拼好传上去的）/ 没连云端时 App 开着在这里排 ——

  /** 云端排计划要的（开着健康系统、接通了「健康计划」、有健康预设时才有）：今天、明天的材料都拼好 */
  function cloudContext(persona: Persona): HealthPlanContext | null {
    const h = persona.health;
    const fills = base(persona);
    const preset = useLibraryStore().presetForUse('health');
    if (!h || !fills || !preset || !useAiStore().isLive('health')) return null;
    const date = today();
    const memo = nearbyMemo[persona.id]?.found;
    const character = useCharacterStore().byId(useAppStore().activeCharacterId);
    return {
      persona: { id: persona.id, name: persona.name },
      ...(character ? { characterName: character.name, pronoun: character.pronoun } : {}),
      timezone: useEnvironmentStore().settings.timezone,
      runAt: h.runAt,
      preset,
      base: { healthProfile: fills.healthProfile ?? '', healthTime: fills.healthTime ?? '', healthKitchen: fills.healthKitchen ?? '' },
      weekMinutes: [...h.weekMinutes],
      home: homeFor(persona),
      days: [date, shiftDate(date, 1)].map((d) => {
        const nearby = memo ? healthNearbyText(memo, 'plan-day', d) : null;
        return { date: d, today: todayText(d), recent: recentText(persona.id, d), nearby: nearby?.text ?? '', near: nearby?.near ?? '' };
      }),
      weeks: [weekOf(persona.id, weekStartOf(date)), weekOf(persona.id, weekStartOf(shiftDate(date, 7)))].filter((w): w is HealthWeekPlan => !!w),
    };
  }

  /** 家在哪（云端自己查家附近的店用）：关了"参考附近的店"、家的地址还没换成坐标时为空 */
  function homeFor(persona: Persona): HealthPlanContext['home'] {
    const geo = useRealWorldStore().homeGeo;
    if (persona.health?.nearby === false || !geo) return null;
    const country = countryAt(geo.countryCode, geo);
    return { lat: geo.lat, lng: geo.lng, ...(country ? { country } : {}) };
  }

  /** 云端没排出来的（今天的） */
  const cloudErrors = ref<{ personaId: string; date: string; reason: string }[]>([]);

  /** 收下云端排好的：手机上后来重新排过的不覆盖；外食对上附近的店，要提前做的发到家务里 */
  function ingestCloud(r: HealthRunResult) {
    const haveWeek = r.week ? weekOf(r.personaId, r.week.weekStart) : undefined;
    if (r.week && !(haveWeek && haveWeek.at > r.week.at)) {
      weeks.value = [r.week, ...weeks.value.filter((w) => !(w.personaId === r.personaId && w.weekStart === r.week!.weekStart))].slice(0, KEEP_WEEKS * 4);
    }
    const have = dayOf(r.personaId, r.date);
    if (have && have.at > r.day.at) return;
    const plan = clone(r.day);
    const memo = nearbyMemo[r.personaId]?.found;
    if (memo) matchHealthSpots(plan, memo.food);
    days.value = [plan, ...days.value.filter((d) => !(d.personaId === r.personaId && d.date === r.date))].slice(0, KEEP_DAYS * 2);
    const persona = usePersonaStore().byId(r.personaId);
    if (persona) syncPrep(persona);
  }

  /**
   * App 开着时每隔一会儿看一眼：附近的店按家搜一次留着（云端排的时候用）；云端不排（没连、Worker 是旧版）时到点就在这里排今天的。
   * 每个人设每天只试一次，没排成的在健康计划里"重新排"
   */
  async function tickSchedule(cloudPlans: boolean) {
    const tz = useEnvironmentStore().settings.timezone;
    for (const persona of usePersonaStore().list) {
      const h = persona.health;
      if (!h?.enabled) continue;
      // 一天搜一次就够（地图那边本来也缓存一天）
      const memo = nearbyMemo[persona.id];
      if (!memo || rhythmDate(new Date(memo.at), tz) !== today()) await nearbyFor(persona, 'plan-week', today()).catch(() => undefined);
      if (cloudPlans || !useAiStore().isLive('health')) continue;
      const date = plannerDate(Date.now(), tz, h.runAt);
      const tried = `${persona.id}:${date}`;
      if (date !== today() || dayOf(persona.id, date) || scheduleTried.has(tried)) continue;
      scheduleTried.add(tried);
      await planDay(persona);
    }
  }
  const scheduleTried = new Set<string>();

  /**
   * 今天要提前做的发到家务里（开了家务系统时；重新排了就换成新的）。
   * 排完马上发一次；打开"共同的家"、健康计划时再对一次（排的时候家务系统还没开的，开了以后补上）
   */
  function syncPrep(persona: Persona) {
    if (!persona.housework?.enabled || !persona.health?.enabled) return;
    const date = today();
    const day = dayOf(persona.id, date);
    if (!day) return;
    const home = useHomeStore();
    const want = (day.prep ?? []).map(prepExtra);
    const have = home.extrasOf(persona.id, date).filter((x) => x.source === 'health');
    if (JSON.stringify(have) !== JSON.stringify(want)) home.setExtras(persona.id, date, want);
  }

  /** 一件要提前做的事在家务里怎么样了：没发（没开家务系统）/ 还没做 / 拖着 / 做完了 */
  function prepState(persona: Persona, t: PrepTask, date = today()): 'off' | 'todo' | 'doing' | 'later' | 'done' {
    if (!persona.housework?.enabled) return 'off';
    const m = useHomeStore().markOn(persona.id, date, `extra:${prepId(t.name)}`);
    return m?.status ?? 'todo';
  }

  function putLog(l: WorkoutLog) {
    logs.value = [clone(l), ...logs.value.filter((x) => x.id !== l.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, KEEP_LOGS);
  }
  /** 记一次运动（"健身"发给她的时候）；收件箱里有对得上的手表运动就马上用上 */
  function addLog(l: WorkoutLog): WatchOutcome[] {
    putLog(l);
    return reconcileWatch();
  }
  function updateLog(id: string, patch: Partial<WorkoutLog>) {
    const l = logs.value.find((x) => x.id === id);
    if (l) Object.assign(l, patch);
  }
  function removeLog(id: string) {
    logs.value = logs.value.filter((l) => l.id !== id);
  }

  // —— 手表的运动数据（"我的 → 手表数据"；services/watchWorkouts 见 packages/shared/src/watchWorkout.ts） ——

  function setWatch(patch: Partial<WatchSettings>) {
    const next = { ...watch.value, ...patch };
    // 第一次打开时记下时刻：这之前、只在手表上练的不单独记
    if (next.mode !== 'off' && !next.since) next.since = Date.now();
    next.shortcutName = next.shortcutName.trim() || DEFAULT_WATCH.shortcutName;
    watch.value = next;
  }

  /** 把手表的数用到 App 记的这一次上（记录和聊天里的运动卡片一起改） */
  function applyWatch(log: WorkoutLog, w: WatchWorkout): WorkoutLog {
    const m = mergeWatch(log, w);
    const info: WorkoutWatchInfo = { id: w.id, source: w.source, used: m.used, sig: watchSig(w), ...(w.device ? { device: w.device } : {}), ...(m.note ? { note: m.note } : {}) };
    const patch: Partial<WorkoutLog> = { watch: info };
    if (m.used) {
      patch.source = 'watch';
      if (m.durationSec) patch.durationSec = m.durationSec;
      if (m.endedAt) patch.endedAt = m.endedAt;
      if (m.kcal !== undefined) patch.kcal = m.kcal;
      if (m.distanceKm !== undefined) patch.distanceKm = m.distanceKm;
      if (m.steps !== undefined) patch.steps = m.steps;
      if (m.hrAvg !== undefined) patch.hrAvg = m.hrAvg;
      if (m.hrMax !== undefined) patch.hrMax = m.hrMax;
    }
    updateLog(log.id, patch);
    const next = logs.value.find((l) => l.id === log.id) ?? { ...log, ...patch };
    if (m.used) useChatStore().patchWorkoutCard(log.id, next);
    return next;
  }

  /** 只在手表上练的（没开 App）：照手表那次单独记一条（记在默认人设上，她平时聊天也知道你练了） */
  function logFromWatch(w: WatchWorkout, existing?: WorkoutLog): WorkoutLog {
    const log: WorkoutLog = {
      id: existing?.id ?? `watch-${hashId(w.id)}`,
      personaId: existing?.personaId ?? usePersonaStore().defaultPersona.id,
      characterId: existing?.characterId ?? null,
      date: rhythmDate(new Date(w.startedAt), useEnvironmentStore().settings.timezone),
      startedAt: w.startedAt,
      endedAt: w.endedAt,
      durationSec: w.durationSec,
      mode: 'free',
      sport: watchSportName(w.name),
      outdoor: w.indoor === false,
      ...(w.km !== undefined ? { distanceKm: w.km } : {}),
      ...(w.steps !== undefined ? { steps: w.steps } : {}),
      ...(w.hrAvg !== undefined ? { hrAvg: w.hrAvg } : {}),
      ...(w.hrMax !== undefined ? { hrMax: w.hrMax } : {}),
      ...(w.kcal !== undefined ? { kcal: Math.round(w.kcal) } : {}),
      source: 'watch',
      watch: { id: w.id, source: w.source, used: true, only: true, sig: watchSig(w), ...(w.device ? { device: w.device } : {}) },
    };
    putLog(log);
    return log;
  }

  /**
   * 把收件箱里的手表运动和运动记录对一遍：
   * - 对上了 App 记的那一次（带了 logId 的按 id，否则按时间重叠）：用手表的数（mergeWatch 管手表、App 谁忘了停）；
   *   同一次推来的数变了（Health Auto Export 后来补全了）就再用一次；先单独记了的那条删掉（App 那次后来发出来了）；
   * - 没对上：从 App 里按按钮跑的那种（带 logId）等那次发给她；只在手表上练的，结束 2 小时以后单独记一条。
   * 关着"手表数据"时不动
   */
  function reconcileWatch(): WatchOutcome[] {
    if (watch.value.mode === 'off' || !watchInbox.value.length) return [];
    const out: WatchOutcome[] = [];
    const session = loadFitnessSession();
    const busySpan = session ? sessionSpan(session) : null;
    const now = Date.now();
    for (const w of watchInbox.value) {
      const sig = watchSig(w);
      const own = logs.value.find((l) => l.watch?.id === w.id && l.watch.only);
      const match = matchWatchLog(w, logs.value.filter((l) => !l.watch?.only));
      if (match) {
        if (own) removeLog(own.id);
        if (match.watch?.id === w.id && match.watch.sig === sig) continue;
        // 这一次已经用了另一次手表的数（快捷指令和 Health Auto Export 都推了）：留着先用上的
        if (match.watch && match.watch.id !== w.id && match.watch.used) continue;
        out.push({ kind: 'updated', log: applyWatch(match, w), workout: w });
        continue;
      }
      if (own) {
        if (own.watch?.sig !== sig) out.push({ kind: 'updated', log: logFromWatch(w, own), workout: w });
        continue;
      }
      if (w.logId) continue;
      const since = watch.value.since;
      if (!since || w.startedAt < since - 10 * 60_000) continue;
      if (now - w.endedAt < WATCH_ONLY_AFTER_MS || now - w.endedAt > WATCH_ONLY_WITHIN_MS) continue;
      if (busySpan && overlapShare(busySpan[0], busySpan[1], w.startedAt, w.endedAt) >= 0.5) continue;
      out.push({ kind: 'created', log: logFromWatch(w), workout: w });
    }
    return out;
  }

  /** 云端拉来的手表运动：放进收件箱（同一次换成新的），再对一遍 */
  function ingestWatch(items: WatchWorkout[]): WatchOutcome[] {
    if (items.length) {
      const byId = new Map(watchInbox.value.map((w) => [w.id, w]));
      for (const w of items) byId.set(w.id, w);
      watchInbox.value = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, KEEP_INBOX);
    }
    return reconcileWatch();
  }

  /** "健身"练完还没发给她的这一次（logId、开始、结束）对得上的手表运动：练完页上先填进去 */
  function watchFor(logId: string, start: number, end: number): WatchWorkout | null {
    if (watch.value.mode === 'off') return null;
    const byId = watchInbox.value.find((w) => w.logId === logId);
    if (byId) return byId;
    const taken = new Set(logs.value.filter((l) => l.watch && !l.watch.only && l.id !== logId).map((l) => l.watch!.id));
    let best: WatchWorkout | null = null;
    let bestShare = 0.5;
    for (const w of watchInbox.value) {
      if (w.logId || taken.has(w.id)) continue;
      const share = overlapShare(start, end, w.startedAt, w.endedAt);
      if (share >= bestShare) {
        best = w;
        bestShare = share;
      }
    }
    return best;
  }

  return { weeks, days, logs, watch, watchInbox, busy, errors, cloudErrors, hydrate, today, weekOf, dayOf, logsOf, planWeek, planDay, syncPrep, prepState, addLog, updateLog, removeLog, setWatch, ingestWatch, reconcileWatch, watchFor, cloudContext, ingestCloud, tickSchedule };
});
