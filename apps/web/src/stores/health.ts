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
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { services } from '@/services';
import { countryAt } from '@/utils/shopping';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
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
  source: 'auto' | 'manual' | 'estimate';
}

interface Saved {
  weeks?: HealthWeekPlan[];
  days?: HealthDayPlan[];
  logs?: WorkoutLog[];
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
  /** 正在排（按人设） */
  const busy = reactive<Record<string, 'week' | 'day' | undefined>>({});
  /** 最近一次排失败的原因（只在内存里） */
  const errors = reactive<Record<string, { reason: string; detail?: string; notConnected?: boolean } | undefined>>({});

  // 别的设备排的健康计划、运动记录（同步）：放进来
  const saver = autoSave('settings', () => [{ key: 'health', value: { weeks: weeks.value, days: days.value, logs: logs.value } }], () => [weeks.value, days.value, logs.value],
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
      const messages = buildHealthMessages({ task, userName: persona.name, characterName: character?.name, fills }, preset);
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
      ...(character ? { characterName: character.name } : {}),
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

  function addLog(l: WorkoutLog) {
    logs.value = [clone(l), ...logs.value.filter((x) => x.id !== l.id)].slice(0, KEEP_LOGS);
  }
  function updateLog(id: string, patch: Partial<WorkoutLog>) {
    const l = logs.value.find((x) => x.id === id);
    if (l) Object.assign(l, patch);
  }

  return { weeks, days, logs, busy, errors, cloudErrors, hydrate, today, weekOf, dayOf, logsOf, planWeek, planDay, syncPrep, prepState, addLog, updateLog, cloudContext, ingestCloud, tickSchedule };
});
