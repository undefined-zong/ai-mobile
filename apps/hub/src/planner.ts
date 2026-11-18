import { AgentSystem, AiError, openMcpSession, runPlanner, type PlannerOpen } from '@app/ai';
import { plannerDate, shiftDate, weekStartOn, type McpServerSecret, type PlannerContext, type PlannerRunResult, type PlannerWeekPlan, type ProactiveCredentials } from '@app/shared';
import { seal, unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { setMeta } from './scheduler.ts';

/**
 * 日程系统（"日程计划"的 API 和"计划"预设）：每个开了日程系统的人设，每天到了它设的时间（默认 04:00，按手机同步来的时区）
 * 云端连上它接的 MCP 服务器（Gmail、日历……）查新邮件和日程，排今天的计划（这周的计划在一周第一天排，或者每天重排）。
 * PWA 关着也会跑；结果存进 D1，手机打开时拉回去。
 * - 每个人设、每一天单独领取（租约），重叠的 Cron 不会重复排；失败在后面的 Cron 里重试；
 * - MCP 的地址和 Token 加密存在 planner_mcp；OAuth 的 Token 快过期时刷新，新的写回去（手机上不再保存连了云端后授权的 Token）；
 * - 不检查每日 token 预算（一天排一次）。
 */

interface ContextRow { persona_id: string; revision: number; data: string }
/** 连 MCP、几轮查询、排两份：给足时间 */
const LEASE_MS = 600_000;

export async function mcpSecret(env: Env, serverId: string): Promise<McpServerSecret | null> {
  const row = await env.DB.prepare('SELECT ciphertext, iv FROM planner_mcp WHERE server_id = ?').bind(serverId).first<{ ciphertext: string; iv: string }>();
  return row ? unseal<McpServerSecret>(env.KEK, row) : null;
}

export async function saveMcpSecret(env: Env, serverId: string, secret: McpServerSecret): Promise<void> {
  const sealed = await seal(env.KEK, secret);
  await env.DB.prepare(`INSERT INTO planner_mcp(server_id, ciphertext, iv, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, updated_at = excluded.updated_at`)
    .bind(serverId, sealed.ciphertext, sealed.iv, Date.now()).run();
}

/** 云端怎么连一台服务器：密钥从 D1 解出来，刷新后的 Token 写回 D1 */
export function hubOpener(env: Env, signal?: AbortSignal): PlannerOpen {
  return async (server) => {
    const secret = await mcpSecret(env, server.id);
    if (!secret && server.auth !== 'none') throw new Error('云端没有它的登录信息：在手机上重新授权（或打开 App 同步一次）');
    return openMcpSession(server, secret ?? { url: server.url }, { onUpdate: (s) => saveMcpSecret(env, server.id, s), signal });
  };
}

async function credentialsOf(env: Env): Promise<ProactiveCredentials | null> {
  const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'planner'").first<{ ciphertext: string; iv: string }>();
  return sealed ? unseal<ProactiveCredentials>(env.KEK, sealed) : null;
}

/** 这周排好的那一份（最近的、weekStart 对得上的） */
async function weekOf(env: Env, personaId: string, weekStart: string): Promise<PlannerWeekPlan | null> {
  const rows = await env.DB.prepare('SELECT result FROM planner_jobs WHERE persona_id = ? AND date >= ? AND result IS NOT NULL ORDER BY date DESC')
    .bind(personaId, weekStart).all<{ result: string }>();
  for (const r of rows.results) {
    const week = (JSON.parse(r.result) as PlannerRunResult).week;
    if (week?.weekStart === weekStart) return week;
  }
  return null;
}

/**
 * 排一个人设这一天的计划。want 不给时按设置（今天的一定排；这周的没有或者设了每天重排才排）；
 * 给了 want（手机上点"立即生成"）时今天已经排过也重排，没排的那一份留着原来的
 */
export async function planFor(env: Env, row: ContextRow, credentials: ProactiveCredentials, now: number, force?: { week: boolean; day: boolean }): Promise<PlannerRunResult | null> {
  const ctx = JSON.parse(row.data) as PlannerContext;
  if (!ctx.settings.enabled) return null;
  const id = row.persona_id;
  const date = plannerDate(now, ctx.timezone, ctx.settings.runAt);
  const lease = crypto.randomUUID();
  const claim = await env.DB.prepare(`INSERT INTO planner_jobs(persona_id, date, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, 1) ON CONFLICT(persona_id, date) DO UPDATE SET
      lease = excluded.lease, lease_until = excluded.lease_until, attempts = planner_jobs.attempts + 1
    WHERE planner_jobs.lease_until <= ? AND (? = 1 OR (planner_jobs.result IS NULL AND planner_jobs.retry_at <= ?)) RETURNING attempts, result, done_at`)
    .bind(id, date, lease, now + LEASE_MS, now, force ? 1 : 0, now).first<{ attempts: number; result: string | null; done_at: number | null }>();
  if (!claim) {
    if (force) throw new Error('云端正在排这个人设的计划，稍等一会儿再试');
    return null;
  }
  const previous = claim.result ? (JSON.parse(claim.result) as PlannerRunResult) : null;
  try {
    const weekStart = weekStartOn(date, ctx.settings.weekStart);
    const week = previous?.week?.weekStart === weekStart ? previous.week : await weekOf(env, id, weekStart);
    const last = await env.DB.prepare('SELECT MAX(done_at) AS at FROM planner_jobs WHERE persona_id = ? AND done_at IS NOT NULL').bind(id).first<{ at: number | null }>();
    const want = force ?? { day: true, week: !week || ctx.settings.weekRefresh === 'daily' };
    const system = new AgentSystem({
      config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null },
      outputFilters: credentials.outputFilters,
    });
    const signal = AbortSignal.timeout(LEASE_MS - 30_000);
    const fresh = await runPlanner(system, { context: ctx, at: now, date, week, lastRunAt: last?.at ?? null, want, via: 'hub' }, hubOpener(env, signal), { signal });
    // 只重排了其中一份：另一份留着原来的
    const result: PlannerRunResult = { ...fresh, week: fresh.week ?? previous?.week, day: fresh.day ?? previous?.day };
    await env.DB.prepare(`UPDATE planner_jobs SET result = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = ?, done_at = ?
      WHERE persona_id = ? AND date = ? AND lease = ?`)
      .bind(JSON.stringify(result), fresh.errors.length ? fresh.errors.join('；').slice(0, 300) : null, Date.now(), id, date, lease).run();
    return result;
  } catch (e) {
    // 服务商的报错里可能有 Key 或响应原文：存进 D1 的只是安全的摘要
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.message.slice(0, 120) : 'Error';
    await env.DB.prepare('UPDATE planner_jobs SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE persona_id = ? AND date = ? AND lease = ?')
      .bind(now + Math.min(60, 5 * 2 ** Math.min(claim.attempts - 1, 4)) * 60_000, `日程计划没排出来（${reason}），云端将自动重试`, id, date, lease).run();
    throw e;
  }
}

/** 手机上点"立即生成"：现在就排（今天排过也重排） */
export async function runPlannerNow(env: Env, personaId: string, want: { week: boolean; day: boolean }): Promise<PlannerRunResult> {
  const row = await env.DB.prepare('SELECT persona_id, revision, data FROM planner_contexts WHERE persona_id = ?').bind(personaId).first<ContextRow>();
  if (!row) throw new Error('云端还没有这个人设的日程设置，先同步一次');
  const credentials = await credentialsOf(env);
  if (!credentials) throw new Error('云端还没有"日程计划"的 API，先同步一次');
  const result = await planFor(env, row, credentials, Date.now(), want);
  if (!result) throw new Error('这个人设的日程系统没开');
  return result;
}

/** 每 5 分钟的 Cron 里跑：到了各自设的时间就排当天的；失败的、到点后才接通的都会补上 */
export async function runPlannerScheduled(env: Env, now = Date.now()) {
  const rows = await env.DB.prepare('SELECT persona_id, revision, data FROM planner_contexts').all<ContextRow>();
  if (!rows.results.length) return;
  const credentials = await credentialsOf(env);
  if (!credentials) {
    await setMeta(env, 'lastPlannerError', '未设置云端日程计划 API，请打开 App 同步');
    return;
  }
  const results = await Promise.allSettled(rows.results.map((row) => planFor(env, row, credentials, now)));
  const failed = results.filter((r) => r.status === 'rejected').length;
  await Promise.all([
    env.DB.prepare('DELETE FROM planner_jobs WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
    setMeta(env, 'lastPlannerError', failed ? `${failed} 个人设的日程计划没排出来，下一轮继续` : null),
  ]);
}
