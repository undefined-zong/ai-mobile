import { AgentSystem, AiError, buildHealthMessages, samplerRequest, searchFoodPlaces, searchGroceryStores, type HealthFill } from '@app/ai';
import {
  healthDayAsk,
  healthNearbyText,
  healthSpot,
  healthTodayText,
  healthWeekAsk,
  healthWeekText,
  parseHealthDay,
  parseHealthWeek,
  plannerDate,
  rhythmDate,
  shiftDate,
  weekStartOf,
  type HealthDayPlan,
  type HealthPlanContext,
  type HealthRunResult,
  type HealthWeekPlan,
  matchHealthSpots,
  type NearbyBlock,
  type NearbyFound,
  type ProactiveCredentials,
  textFn,
} from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { setMeta } from './scheduler.ts';

/**
 * 健康计划（"健康计划"的 API 和"健康"预设）：每个开了健康系统的人设，每天到了健康设置里的时间（默认 04:00，按手机同步来的时区），
 * 云端排今天的健身和三顿饭（这周的计划还没有就先排这周）。PWA 关着也会跑；结果存进 D1，手机打开时拉回去
 * （手机收下时把外食对上附近的店、把要提前做的发到家务里）。
 * - 材料是手机拼好传上来的（健康设置、最近的运动和饭）；手机没传那天的（好几天没开 App）只带日期和健康设置排；
 * - 附近的店：你给了云端 Google 地图 Key、手机传了家的坐标时，云端到点自己查家附近能吃饭的地方和超市；
 *   没给 Key、没查到时用手机上次查到的；
 * - 每个人设、每一天单独领取（租约），重叠的 Cron 不会重复排；失败在后面的 Cron 里重试；
 * - 不检查每日 token 预算（一天排一次，同日程计划）。
 */

interface ContextRow { persona_id: string; revision: number; data: string }
const LEASE_MS = 300_000;

/** 给云端的 Google 地图 Key（没给为空） */
async function mapsKeyOf(env: Env): Promise<string | null> {
  const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'maps'").first<{ ciphertext: string; iv: string }>();
  return sealed ? (await unseal<{ key: string }>(env.KEK, sealed)).key : null;
}

/** 家附近能吃饭的地方和超市（云端自己查）：没 Key、没家的坐标时为空；一项没查到写明原因 */
async function nearbyAtHome(ctx: HealthPlanContext, key: string | null, signal: AbortSignal): Promise<NearbyFound | null> {
  if (!key || !ctx.home) return null;
  const at = { lat: ctx.home.lat, lng: ctx.home.lng };
  const [f, g] = await Promise.allSettled([searchFoodPlaces(at, key, signal), searchGroceryStores(at, key, signal)]);
  const food = f.status === 'fulfilled' ? f.value.slice(0, 20) : [];
  const stores = g.status === 'fulfilled' ? g.value : [];
  const failed = [f, g].find((r): r is PromiseRejectedResult => r.status === 'rejected');
  const why = failed ? (failed.reason instanceof Error ? failed.reason.message : String(failed.reason)) : '';
  const country = ctx.home.country;
  if (!food.length && !stores.length) return failed ? null : { food, stores, label: '家附近', why: '', none: '家附近没搜到能吃饭的地方和超市', ...(country ? { country } : {}) };
  return { food, stores, label: '家附近', why, ...(country ? { country } : {}) };
}

async function credentialsOf(env: Env): Promise<ProactiveCredentials | null> {
  const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'health'").first<{ ciphertext: string; iv: string }>();
  return sealed ? unseal<ProactiveCredentials>(env.KEK, sealed) : null;
}

/** 这周的计划：手机上有的优先，没有用云端最近排的 */
async function weekOf(env: Env, ctx: HealthPlanContext, weekStart: string): Promise<HealthWeekPlan | null> {
  const own = ctx.weeks.find((w) => w.weekStart === weekStart);
  if (own) return own;
  const rows = await env.DB.prepare('SELECT result FROM health_jobs WHERE persona_id = ? AND date >= ? AND result IS NOT NULL ORDER BY date DESC')
    .bind(ctx.persona.id, weekStart).all<{ result: string }>();
  for (const r of rows.results) {
    const week = (JSON.parse(r.result) as HealthRunResult).week;
    if (week?.weekStart === weekStart) return week;
  }
  return null;
}

/** 排一个人设到点的那一天；还不到、排过了、没有预设时什么都不做 */
export async function healthFor(env: Env, row: ContextRow, credentials: ProactiveCredentials, now: number, mapsKey: string | null = null): Promise<HealthRunResult | null> {
  const ctx = JSON.parse(row.data) as HealthPlanContext;
  if (!ctx.preset) return null;
  const preset = ctx.preset;
  const id = row.persona_id;
  const date = plannerDate(now, ctx.timezone, ctx.runAt);
  // 还没到今天的时间时算出来的是昨天：过去的日子不补
  if (date < rhythmDate(new Date(now), ctx.timezone)) return null;
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare(`INSERT INTO health_jobs(persona_id, date, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, 1) ON CONFLICT(persona_id, date) DO UPDATE SET
      lease = excluded.lease, lease_until = excluded.lease_until, attempts = health_jobs.attempts + 1
    WHERE health_jobs.lease_until <= ? AND health_jobs.result IS NULL AND health_jobs.retry_at <= ? RETURNING attempts`)
    .bind(id, date, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return null;
  try {
    const system = new AgentSystem({
      config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null, textObfuscation: () => credentials.textObfuscation },
      outputFilters: credentials.outputFilters,
      jsonRetry: () => ctx.preset?.texts?.['common.jsonRetry'],
    });
    const signal = AbortSignal.timeout(LEASE_MS - 30_000);
    const day = ctx.days.find((d) => d.date === date);
    // 附近的店：云端自己查到的优先，没有用手机上次查到的（那一份没有店的列表，对不上外食）
    const found = await nearbyAtHome(ctx, mapsKey, signal);
    // 说明文字都在健康预设的程序文字里（手机上传时合好了自带预设文件里的）
    const tx = textFn(preset.texts);
    const nearby = (task: 'plan-week' | 'plan-day'): NearbyBlock => (found ? healthNearbyText(found, task, date, tx) : { text: day?.nearby ?? '', food: [], stores: [], near: day?.near ?? '' });
    const shared: Partial<Record<HealthFill, string>> = { ...ctx.base, healthToday: day?.today ?? healthTodayText(date, tx), healthRecent: day?.recent ?? '' };
    const ask = <T>(task: 'plan-week' | 'plan-day', fills: Partial<Record<HealthFill, string>>, parse: (v: unknown) => T | null) =>
      system.json('health', { messages: buildHealthMessages({ task, userName: ctx.persona.name, characterName: ctx.characterName, pronoun: ctx.pronoun, fills }, preset), ...samplerRequest(preset.sampler) }, parse, { signal });
    const weekStart = weekStartOf(date);
    let week = await weekOf(env, ctx, weekStart);
    let fresh: HealthWeekPlan | undefined;
    if (!week) {
      const nb = nearby('plan-week');
      const { value, result } = await ask('plan-week', { ...shared, healthNearby: nb.text, healthAsk: healthWeekAsk(date, weekStart, tx) }, parseHealthWeek);
      fresh = {
        ...value, personaId: id, weekStart,
        ...(nb.stores.length ? { stores: nb.stores.map(healthSpot) } : {}),
        ...(nb.country ? { country: nb.country } : {}),
        ...(nb.near ? { near: nb.near } : {}),
        model: result.model, at: Date.now(),
      };
      week = fresh;
    }
    const nb = nearby('plan-day');
    const { value, result } = await ask('plan-day', { ...shared, healthNearby: nb.text, healthWeek: healthWeekText(week, date, tx), healthAsk: healthDayAsk(date, week, ctx.weekMinutes, tx) }, parseHealthDay);
    matchHealthSpots(value, nb.food);
    const plan: HealthDayPlan = { ...value, personaId: id, date, ...(nb.near ? { near: nb.near } : {}), model: result.model, at: Date.now() };
    const out: HealthRunResult = { personaId: id, date, ...(fresh ? { week: fresh } : {}), day: plan, at: Date.now() };
    await env.DB.prepare(`UPDATE health_jobs SET result = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL, done_at = ?
      WHERE persona_id = ? AND date = ? AND lease = ?`)
      .bind(JSON.stringify(out), Date.now(), id, date, lease).run();
    return out;
  } catch (e) {
    // 服务商的报错里可能有 Key 或响应原文：存进 D1 的只是安全的摘要
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.message.slice(0, 120) : 'Error';
    await env.DB.prepare('UPDATE health_jobs SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE persona_id = ? AND date = ? AND lease = ?')
      .bind(now + Math.min(60, 5 * 2 ** Math.min(claim.attempts - 1, 4)) * 60_000, `健康计划没排出来（${reason}），云端将自动重试`, id, date, lease).run();
    throw e;
  }
}

/** 每 5 分钟的 Cron 里跑：到了各自设的时间就排当天的；失败的、到点后才接通的都会补上 */
export async function runHealthScheduled(env: Env, now = Date.now()) {
  const rows = await env.DB.prepare('SELECT persona_id, revision, data FROM health_contexts').all<ContextRow>();
  if (!rows.results.length) {
    await setMeta(env, 'lastHealthError', null);
    return;
  }
  const credentials = await credentialsOf(env);
  if (!credentials) {
    await setMeta(env, 'lastHealthError', '未设置云端健康计划 API，请打开 App 同步');
    return;
  }
  const mapsKey = await mapsKeyOf(env);
  const results = await Promise.allSettled(rows.results.map((row) => healthFor(env, row, credentials, now, mapsKey)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  await Promise.all([
    env.DB.prepare('DELETE FROM health_jobs WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
    setMeta(env, 'lastHealthError', failed ? `${failed} 个人设的健康计划没排出来，下一轮继续` : null),
  ]);
}
