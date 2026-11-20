import { AgentSystem, AiError, parallelPlanMessages, samplerRequest } from '@app/ai';
import {
  parallelSources,
  parallelSourcesBasis,
  parseParallelPlan,
  plannerDate,
  rhythmDate,
  shiftDate,
  type HealthDayPlan,
  type HealthRunResult,
  type ParallelPlan,
  type ParallelPlanContext,
  type PlannerContext,
  type PlannerDayPlan,
  type PlannerRunResult,
  type ProactiveCredentials,
} from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { setMeta } from './scheduler.ts';

/**
 * 平行时空 · 整理你的一天：每个人设每天到了平行时空设置里的时间（默认 05:00，按手机同步来的时区），
 * 把那天的日程计划、健康计划（云端到点排好的那两份，没有用手机传上来的）、家务（手机传上来的）——有几份用几份——
 * 交给"平行时空 · 整理你的一天"预设，整理成平行时空里你的一份计划。PWA 关着也会跑；结果存进 D1，手机打开时拉回去。
 * - 云端在替这个人设排日程计划、健康计划，那天的还没排好也还没失败过：等它们排好再整理（失败了就不等，有几份用几份）；
 * - 每个人设、每一天单独领取（租约），重叠的 Cron 不会重复整理；失败在后面的 Cron 里重试；
 * - 不检查每日 token 预算（一天整理一次，同日程计划）。
 */

interface ContextRow { persona_id: string; revision: number; data: string }
const LEASE_MS = 300_000;

/** 云端有没有这个功能的 API（没有时它根本不会排，不用等） */
async function hasSecret(env: Env, id: 'planner' | 'health'): Promise<boolean> {
  return !!await env.DB.prepare('SELECT 1 FROM secrets WHERE id = ?').bind(id).first();
}

/** 日程计划还在排：开着日程系统、云端有它的 API、那天的还没排好、也还没失败过 */
async function plannerPending(env: Env, personaId: string, date: string): Promise<boolean> {
  const ctx = await env.DB.prepare('SELECT data FROM planner_contexts WHERE persona_id = ?').bind(personaId).first<{ data: string }>();
  if (!ctx || !(JSON.parse(ctx.data) as PlannerContext).settings.enabled || !await hasSecret(env, 'planner')) return false;
  const job = await env.DB.prepare('SELECT result, last_error FROM planner_jobs WHERE persona_id = ? AND date = ?').bind(personaId, date).first<{ result: string | null; last_error: string | null }>();
  return !job || (!job.result && !job.last_error);
}

/** 健康计划还在排：云端在替这个人设排（传了材料）、有它的 API、那天的还没排好、也还没失败过 */
async function healthPending(env: Env, personaId: string, date: string): Promise<boolean> {
  if (!await env.DB.prepare('SELECT 1 FROM health_contexts WHERE persona_id = ?').bind(personaId).first() || !await hasSecret(env, 'health')) return false;
  const job = await env.DB.prepare('SELECT result, last_error FROM health_jobs WHERE persona_id = ? AND date = ?').bind(personaId, date).first<{ result: string | null; last_error: string | null }>();
  return !job || (!job.result && !job.last_error);
}

/** 那天的健康计划：云端排好的优先，没有用手机传上来的 */
async function healthDay(env: Env, ctx: ParallelPlanContext, date: string): Promise<HealthDayPlan | null> {
  const row = await env.DB.prepare('SELECT result FROM health_jobs WHERE persona_id = ? AND date = ? AND result IS NOT NULL').bind(ctx.persona.id, date).first<{ result: string }>();
  return (row ? (JSON.parse(row.result) as HealthRunResult).day : undefined) ?? ctx.days.find((d) => d.date === date)?.health ?? null;
}

/** 那天的日程计划：云端排好的优先，没有用手机传上来的 */
async function plannerDay(env: Env, ctx: ParallelPlanContext, date: string): Promise<PlannerDayPlan | null> {
  const row = await env.DB.prepare('SELECT result FROM planner_jobs WHERE persona_id = ? AND date = ? AND result IS NOT NULL').bind(ctx.persona.id, date).first<{ result: string }>();
  return (row ? (JSON.parse(row.result) as PlannerRunResult).day : undefined) ?? ctx.days.find((d) => d.date === date)?.plan ?? null;
}

async function credentialsOf(env: Env): Promise<ProactiveCredentials | null> {
  const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'parallel'").first<{ ciphertext: string; iv: string }>();
  return sealed ? unseal<ProactiveCredentials>(env.KEK, sealed) : null;
}

/** 整理一个人设到点的那一天；还不到、整理过、在等日程计划、几份计划都是空的时什么都不做 */
export async function arrangeFor(env: Env, row: ContextRow, credentials: ProactiveCredentials, now: number): Promise<ParallelPlan | null> {
  const ctx = JSON.parse(row.data) as ParallelPlanContext;
  if (!ctx.preset) return null;
  const id = row.persona_id;
  const date = plannerDate(now, ctx.timezone, ctx.planAt);
  // 还没到今天的整理时间时算出来的是昨天：过去的日子不补
  if (date < rhythmDate(new Date(now), ctx.timezone)) return null;
  if (await env.DB.prepare('SELECT 1 FROM parallel_plans WHERE persona_id = ? AND date = ? AND result IS NOT NULL').bind(id, date).first()) return null;
  if (await plannerPending(env, id, date) || await healthPending(env, id, date)) return null;
  const day = ctx.days.find((d) => d.date === date);
  const sources = parallelSources({
    plan: await plannerDay(env, ctx, date), planDone: new Set(), chores: day?.chores ?? [], health: await healthDay(env, ctx, date), workedOut: false, fitTime: ctx.fitTime, env: ctx.env,
  });
  if (!sources.length) return null;
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare(`INSERT INTO parallel_plans(persona_id, date, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, 1) ON CONFLICT(persona_id, date) DO UPDATE SET
      lease = excluded.lease, lease_until = excluded.lease_until, attempts = parallel_plans.attempts + 1
    WHERE parallel_plans.lease_until <= ? AND parallel_plans.result IS NULL AND parallel_plans.retry_at <= ? RETURNING attempts`)
    .bind(id, date, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return null;
  try {
    const system = new AgentSystem({
      config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null, textObfuscation: () => credentials.textObfuscation },
      outputFilters: credentials.outputFilters,
      jsonRetry: () => ctx.preset?.texts?.['common.jsonRetry'],
    });
    const { value, result } = await system.json(
      'parallel',
      { messages: parallelPlanMessages({ userName: ctx.persona.name, date, now, timeZone: ctx.timezone, sources }, ctx.preset), ...samplerRequest(ctx.preset.sampler) },
      (v) => parseParallelPlan(v, sources, now.toString(36)),
      { signal: AbortSignal.timeout(LEASE_MS - 30_000) },
    );
    const plan: ParallelPlan = { personaId: id, date, items: value, basis: parallelSourcesBasis(sources), model: result.model, at: now, via: 'hub' };
    await env.DB.prepare(`UPDATE parallel_plans SET result = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL, done_at = ?
      WHERE persona_id = ? AND date = ? AND lease = ?`)
      .bind(JSON.stringify(plan), Date.now(), id, date, lease).run();
    return plan;
  } catch (e) {
    // 服务商的报错里可能有 Key 或响应原文：存进 D1 的只是安全的摘要
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.message.slice(0, 120) : 'Error';
    await env.DB.prepare('UPDATE parallel_plans SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE persona_id = ? AND date = ? AND lease = ?')
      .bind(now + Math.min(60, 5 * 2 ** Math.min(claim.attempts - 1, 4)) * 60_000, `平行时空的计划没整理出来（${reason}），云端将自动重试`, id, date, lease).run();
    throw e;
  }
}

/** 每 5 分钟的 Cron 里跑：到了各自设的时间就整理当天的；失败的、到点后才接通的、在等日程计划的都会补上 */
export async function runParallelPlanScheduled(env: Env, now = Date.now()) {
  const rows = await env.DB.prepare('SELECT persona_id, revision, data FROM parallel_plan_contexts').all<ContextRow>();
  if (!rows.results.length) {
    await setMeta(env, 'lastParallelPlanError', null);
    return;
  }
  const credentials = await credentialsOf(env);
  if (!credentials) {
    await setMeta(env, 'lastParallelPlanError', '未设置云端平行时空 API，请打开 App 同步');
    return;
  }
  const results = await Promise.allSettled(rows.results.map((row) => arrangeFor(env, row, credentials, now)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  await Promise.all([
    env.DB.prepare('DELETE FROM parallel_plans WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
    setMeta(env, 'lastParallelPlanError', failed ? `${failed} 个人设的平行时空计划没整理出来，下一轮继续` : null),
  ]);
}
