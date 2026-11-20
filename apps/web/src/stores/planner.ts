import { errorReport, errorText, runPlanner } from '@app/ai';
import {
  choreSchedule,
  DEFAULT_PLANNER,
  plannerDate,
  shiftDate,
  textFn,
  type TextFn,
  weekStartOn,
  type ISODate,
  type Persona,
  type PlannerContext,
  type PlannerDayPlan,
  type PlannerItem,
  type PlannerRunResult,
  type PlannerSource,
  type PlannerWeekPlan,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { healthLines } from '@/services/homeBlock';
import { localOpener } from '@/services/mcp';
import { useAiStore } from './ai';
import { useCharacterStore } from './characters';
import { useEnvironmentStore } from './environment';
import { useHubStore } from './hub';
import { textsFor, useLibraryStore, withTexts } from './library';
import { usePersonaStore } from './personas';

/**
 * 日程计划（日程系统，设计文档 §9.15）：每个人设这周和每天的计划、你勾掉了哪些、每次查了什么。
 * 存在本机（settings 表的 planner 一项）：最近 8 周的周计划、30 天的日计划。
 * - 连了云端：每天到点由 Worker 排（App 关着也排），打开 App 时拉回来；"立即生成"也让 Worker 现在去排；
 * - 没连云端：打开 App 时补排今天的（过了每天排的时间、还没排过），"立即生成"在本机排（MCP 浏览器直连，对方要允许跨域）。
 */

export type PlannerResult<T> = { ok: true; value: T } | { ok: false; reason: string; detail?: string };

interface Saved {
  weeks?: PlannerWeekPlan[];
  days?: PlannerDayPlan[];
  /** `${人设}:${日期}` → 勾掉的时间线项（下标） */
  checks?: Record<string, number[]>;
  /** `${人设}:${日期}` → 这次查了什么、哪里没成 */
  runs?: Record<string, { sources: PlannerSource[]; errors: string[]; at: number }>;
  /** 云端结果拉到哪了 */
  cursor?: number;
}

const KEEP_WEEKS = 8;
const KEEP_DAYS = 30;

export const usePlannerStore = defineStore('planner', () => {
  const weeks = ref<PlannerWeekPlan[]>([]);
  const days = ref<PlannerDayPlan[]>([]);
  const checks = ref<Record<string, number[]>>({});
  const runs = ref<Record<string, { sources: PlannerSource[]; errors: string[]; at: number }>>({});
  const cursor = ref(0);
  /** 正在排（按人设）：现在在做哪一步 */
  const busy = reactive<Record<string, string | undefined>>({});
  /** 最近一次失败（只在内存里） */
  const errors = reactive<Record<string, { reason: string; detail?: string } | undefined>>({});
  /** 云端没排出来的（"云端与同步"、日程计划页里显示） */
  const cloudErrors = ref<{ personaId: string; date: string; reason: string }[]>([]);
  const ready = ref(false);

  const saver = autoSave(
    'settings',
    () => [{ key: 'planner', value: { weeks: weeks.value, days: days.value, checks: checks.value, runs: runs.value, cursor: cursor.value } }],
    () => [weeks.value, days.value, checks.value, runs.value, cursor.value],
    // 别的设备排的、勾掉的（同步）：放进来
    { apply: ([c]) => { if (c && !c.deleted) load(c.value as Saved); } },
  );

  function load(saved: Saved | null | undefined) {
    if (saved && typeof saved === 'object') {
      if (Array.isArray(saved.weeks)) weeks.value = saved.weeks.filter((w) => w && Array.isArray(w.days));
      if (Array.isArray(saved.days)) days.value = saved.days.filter((d) => d && Array.isArray(d.items));
      if (saved.checks && typeof saved.checks === 'object') checks.value = saved.checks;
      if (saved.runs && typeof saved.runs === 'object') runs.value = saved.runs;
      if (typeof saved.cursor === 'number') cursor.value = Math.max(cursor.value, saved.cursor);
    }
  }

  async function hydrate() {
    load(await getOne<Saved>('settings', 'planner'));
    saver.start();
    ready.value = true;
  }

  /** 只读（没开过日程系统的人设按默认值算，不往人设上加东西） */
  function settingsOf(p: Persona) {
    return p.planner ?? DEFAULT_PLANNER;
  }
  /** 这个人设现在算哪一天（到了每天排的时间才算新的一天） */
  function today(p: Persona): ISODate {
    return plannerDate(Date.now(), useEnvironmentStore().settings.timezone, settingsOf(p).runAt);
  }
  function weekStartFor(p: Persona, date = today(p)): ISODate {
    return weekStartOn(date, settingsOf(p).weekStart);
  }
  function weekOf(personaId: string, weekStart: ISODate): PlannerWeekPlan | undefined {
    return weeks.value.find((w) => w.personaId === personaId && w.weekStart === weekStart);
  }
  function dayOf(personaId: string, date: ISODate): PlannerDayPlan | undefined {
    return days.value.find((d) => d.personaId === personaId && d.date === date);
  }
  function doneOf(personaId: string, date: ISODate): Set<number> {
    return new Set(checks.value[`${personaId}:${date}`] ?? []);
  }
  function toggle(personaId: string, date: ISODate, index: number) {
    const key = `${personaId}:${date}`;
    const set = new Set(checks.value[key] ?? []);
    if (set.has(index)) set.delete(index);
    else set.add(index);
    checks.value[key] = [...set].sort((a, b) => a - b);
  }
  /** 改今天时间线上的一项（平行时空里改的直接改在计划上：日程计划页、聊天里她知道的都跟着变） */
  function editItem(personaId: string, date: ISODate, index: number, patch: Partial<Pick<PlannerItem, 'time' | 'minutes' | 'title' | 'note'>>) {
    const it = dayOf(personaId, date)?.items[index];
    if (it) Object.assign(it, patch);
  }
  /** 从今天的时间线上删掉一项：后面的下标往前挪，勾过的跟着挪 */
  function removeItem(personaId: string, date: ISODate, index: number) {
    const plan = dayOf(personaId, date);
    if (!plan?.items[index]) return;
    plan.items.splice(index, 1);
    const key = `${personaId}:${date}`;
    if (checks.value[key]) checks.value[key] = checks.value[key]!.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
  }
  /** 勾上 / 取消（和 toggle 不同：直接给要的状态，平行时空里和家务一起勾时用） */
  function setDone(personaId: string, date: ISODate, index: number, done: boolean) {
    if (doneOf(personaId, date).has(index) !== done) toggle(personaId, date, index);
  }
  function runOf(personaId: string, date: ISODate) {
    return runs.value[`${personaId}:${date}`];
  }

  /** 收下一次排好的（云端的、本机的）：同一周、同一天的换成新的；重排了今天的，勾过的清掉 */
  function ingest(r: PlannerRunResult) {
    if (r.week) {
      weeks.value = [r.week, ...weeks.value.filter((w) => !(w.personaId === r.personaId && w.weekStart === r.week!.weekStart))]
        .sort((a, b) => b.weekStart.localeCompare(a.weekStart))
        .slice(0, KEEP_WEEKS * Math.max(1, usePersonaStore().list.length));
    }
    if (r.day) {
      const old = dayOf(r.personaId, r.day.date);
      if (old && old.at !== r.day.at) delete checks.value[`${r.personaId}:${r.day.date}`];
      days.value = [r.day, ...days.value.filter((d) => !(d.personaId === r.personaId && d.date === r.day!.date))]
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, KEEP_DAYS * Math.max(1, usePersonaStore().list.length));
    }
    runs.value[`${r.personaId}:${r.date}`] = { sources: r.sources, errors: r.errors, at: r.at };
    const keep = new Set(days.value.map((d) => `${d.personaId}:${d.date}`));
    for (const k of Object.keys(checks.value)) if (!keep.has(k)) delete checks.value[k];
    for (const k of Object.keys(runs.value)) if (!keep.has(k) && k !== `${r.personaId}:${r.date}`) delete runs.value[k];
  }

  // —— 拼给「日程计划」的材料 ——

  /** 家务和健康（开了这两套系统时）：家务按每天、每周写；健康是目标和今天的计划 */
  /** 计划预设的程序文字 */
  function px(): TextFn {
    return textFn(textsFor(useLibraryStore().presetForUse('planner')));
  }

  function lifeText(p: Persona): string {
    const t = px();
    const parts: string[] = [];
    const hw = p.housework;
    if (hw?.enabled && hw.chores.length) {
      parts.push(t('planner.life.chores', { user: p.name, items: hw.chores.map((c) => t('planner.life.chore', { name: c.name, schedule: choreSchedule(c), minutes: c.minutes })) }));
    }
    const health = healthLines(p, t);
    if (health) parts.push(health);
    if (!parts.length) return '';
    const tz = useEnvironmentStore().settings.timezone;
    // 按半小时取整：上传云端的那份不会每分钟都算"变了"
    const step = 30 * 60_000;
    const at = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(Math.floor(Date.now() / step) * step);
    return t('planner.life', { at, parts });
  }

  /** 最近三天的计划和勾了哪些（排今天时把没做完的挪过来） */
  function recentText(p: Persona): string {
    const t = px();
    const date = today(p);
    const rows: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const d = shiftDate(date, -i);
      const plan = dayOf(p.id, d);
      if (!plan) continue;
      const done = doneOf(p.id, d);
      const left = plan.items.filter((_, j) => !done.has(j)).map((it) => it.title);
      rows.push(t('planner.recent.day', { date: d, summary: plan.summary || t('planner.recent.noSummary'), done: done.size, total: plan.items.length, left: left.slice(0, 8), todos: plan.todos.map((x) => x.title) }));
    }
    return rows.length ? rows.join('\n') : t('planner.recent.none');
  }

  /** 上传云端 / 本机排计划用的那一份；日程系统没开或者没有"计划"预设时为空 */
  function context(personaId: string): PlannerContext | null {
    const p = usePersonaStore().byId(personaId);
    if (!p?.planner?.enabled) return null;
    // 预设带上合好的程序文字（排计划时按它写输入）
    const preset = withTexts(useLibraryStore().presetForUse('planner'));
    if (!preset) return null;
    const s = p.planner;
    const c = useCharacterStore().byId(s.characterId);
    return {
      persona: { id: p.id, name: p.name, description: p.description },
      character: c ? { name: c.name, pronoun: c.pronoun, description: (c.card?.description ?? '').slice(0, 300) } : null,
      timezone: useEnvironmentStore().settings.timezone,
      // 工具清单云端每次现列，不上传
      settings: { ...s, servers: s.servers.map((x) => ({ ...x, tools: [] })) },
      preset,
      life: lifeText(p),
      recent: recentText(p),
    };
  }

  /** 这一天要不要排这周的（没有，或者设了每天重排） */
  function wantWeek(p: Persona, date: ISODate): boolean {
    return !weekOf(p.id, weekStartFor(p, date)) || settingsOf(p).weekRefresh === 'daily';
  }

  /**
   * 排计划：连了云端（新版 Worker）让 Worker 现在去排，否则在本机排。
   * want 不给时按设置（今天的一定排，这周的没有或者每天重排时排）
   */
  async function run(personaId: string, want?: { week: boolean; day: boolean }): Promise<PlannerResult<PlannerRunResult>> {
    const p = usePersonaStore().byId(personaId);
    if (!p?.planner?.enabled) return { ok: false, reason: '日程系统没开' };
    if (busy[personaId]) return { ok: false, reason: '正在排' };
    const date = today(p);
    const w = want ?? { day: true, week: wantWeek(p, date) };
    errors[personaId] = undefined;
    const hub = useHubStore();
    try {
      let result: PlannerRunResult;
      await hub.ensureStatus();
      if (hub.connected && hub.supportsPlanner) {
        busy[personaId] = '云端在排（连邮箱和日程、想想查什么、写计划）';
        // 先把这台设备上最新的设置、密钥传上去
        await hub.syncPlannerNow();
        result = await hub.runPlanner(personaId, w);
      } else {
        const ai = useAiStore();
        if (!ai.isLive('planner')) return { ok: false, reason: '先在"我的 → API 设置"里接通「日程计划」（默认跟随主对话）' };
        const ctx = context(personaId);
        if (!ctx) return { ok: false, reason: '没有"计划"预设：去"我的 → 预设 → 计划"里选一个' };
        busy[personaId] = '准备';
        const week = weekOf(personaId, weekStartFor(p, date)) ?? null;
        const lastAt = Math.max(0, ...Object.entries(runs.value).filter(([k]) => k.startsWith(`${personaId}:`)).map(([, v]) => v.at));
        result = await runPlanner(ai.system, { context: ctx, at: Date.now(), date, week, lastRunAt: lastAt || null, want: w, via: 'device' }, localOpener(AbortSignal.timeout(600_000)), {
          onStep: (step) => {
            busy[personaId] = step;
          },
        });
      }
      ingest(result);
      return { ok: true, value: result };
    } catch (e) {
      const reason = errorText(e);
      errors[personaId] = { reason, detail: errorReport(e) };
      return { ok: false, reason, detail: errorReport(e) };
    } finally {
      busy[personaId] = undefined;
    }
  }

  /** 没连云端时：打开 App 后，过了每天排的时间、今天还没排的人设补排一次 */
  async function catchUp() {
    const hub = useHubStore();
    if (hub.connected) return;
    for (const p of usePersonaStore().list) {
      if (!p.planner?.enabled || dayOf(p.id, today(p)) || errors[p.id]) continue;
      await run(p.id);
    }
  }

  return { weeks, days, checks, runs, cursor, busy, errors, cloudErrors, ready, hydrate, today, weekStartFor, weekOf, dayOf, doneOf, toggle, editItem, removeItem, setDone, runOf, ingest, context, run, catchUp };
});
