import { AgentSystem, AiError, buildParallelMessages, parallelPostInput, samplerRequest } from '@app/ai';
import {
  estimateTokens,
  hubParallelNoteId,
  myDayEntries,
  parallelDueTimes,
  parallelNames,
  parallelNoteText,
  parseParallelPost,
  resolveParallelRef,
  rhythmDate,
  shiftDate,
  zonedDateKey,
  type HubNotification,
  type ParallelContext,
  type ParallelEntry,
  type ParallelNote,
  type PlannerRunResult,
  type ProactiveCredentials,
  type SocialDay,
} from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { sendChannel, type Channel } from './push.ts';
import { release, releaseExpired, reserve, setMeta } from './scheduler.ts';
import { todayOf } from './social.ts';

/**
 * 平行时空（"平行时空"的 API 和预设）：每个角色每天在随机的时间给你留 1 到几句言，PWA 关着也留。
 * - 什么时候留：按角色和日期算出来的随机时间（@app/shared 的 parallelDueTimes，她醒着的时段里），到点的 Cron 领取那一条；
 * - 留什么：手机上传的角色卡、记忆、最近的聊天和留言，加上你们俩今天的安排——
 *   她的节律云端排过今天就用云端那份（手机上改过的以手机为准）；你的安排手机上传的是今天的就用它，
 *   不是（好几天没开 App）用云端今天排的日程计划；手机上传之后云端又留过的也带上，免得重复；
 * - 每个角色、每一天、每一条单独领取（租约），重叠的 Cron 不会重复留；失败在后面的 Cron 里重试，超过 3 小时的不补。
 */

interface ContextRow { character_id: string; revision: number; data: string; updated_at: number }
const LEASE_MS = 180_000;
const CATCH_UP_MS = 3 * 3_600_000;

/** 你今天的安排：手机上传的是今天的就用它；不是时用云端今天排的日程计划（只有计划，没有家务、健康的完成情况）；都没有为 null */
async function mineOf(env: Env, context: ParallelContext, now: number): Promise<ParallelEntry[] | null> {
  const date = rhythmDate(new Date(now), context.timezone);
  if (context.mine?.date === date) return context.mine.entries;
  const row = await env.DB.prepare('SELECT result FROM planner_jobs WHERE persona_id = ? AND date = ? AND result IS NOT NULL').bind(context.persona.id, date).first<{ result: string }>();
  const plan = row ? (JSON.parse(row.result) as PlannerRunResult).day : undefined;
  return plan ? myDayEntries({ plan, planDone: new Set(), chores: [], health: null, workedOut: false, fitTime: null, day: null, env: context.env }) : null;
}

export function parallelRequest(context: ParallelContext, now: number, her: SocialDay | null, mine: ParallelEntry[] | null) {
  if (!context.preset) throw new Error('没有平行时空预设');
  const built = parallelPostInput(context, now, her, mine);
  return { ...built, request: { messages: buildParallelMessages(built.input, context.preset), ...samplerRequest(context.preset.sampler) } };
}

export async function generateParallelNote(
  context: ParallelContext, credentials: ProactiveCredentials, id: string, date: string, now: number, her: SocialDay | null, mine: ParallelEntry[] | null,
): Promise<{ note: ParallelNote; tokens: number }> {
  // The scheduler reserves the user-configured budget in D1 across concurrent characters.
  const system = new AgentSystem({ config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null }, outputFilters: credentials.outputFilters });
  const built = parallelRequest(context, now, her, mine);
  const { value, result } = await system.json('parallel', built.request, parseParallelPost, { signal: AbortSignal.timeout(150_000) });
  const about = resolveParallelRef(value.about, built.her, built.mine);
  const note: ParallelNote = {
    id, characterId: context.character.id, date, authorId: context.character.id, text: value.text, kind: 'note',
    ...(about ? { about } : {}), replies: [], at: now, updatedAt: now, source: 'hub', model: result.model, unread: true,
  };
  return { note, tokens: system.usedToday('parallel') };
}

export type ParallelGenerator = typeof generateParallelNote;

function notificationFor(context: ParallelContext, note: ParallelNote): HubNotification {
  return {
    title: context.preview === 'hidden' ? 'AI 陪伴' : context.character.name,
    body: context.preview === 'full' ? `平行时空：${note.text.slice(0, 300)}` : context.preview === 'name-only' ? '在平行时空给你留言' : '平行时空有新留言',
    tag: note.id, route: `/parallel/${encodeURIComponent(context.character.id)}`,
  };
}

async function postOne(env: Env, row: ContextRow, slot: number, dueAt: number, date: string, credentials: ProactiveCredentials, now: number, generate: ParallelGenerator) {
  const context = JSON.parse(row.data) as ParallelContext;
  const id = row.character_id;
  const lease = crypto.randomUUID();
  // Each character/date/slot has its own atomic claim. Other characters start immediately.
  const claim = await env.DB.prepare(`INSERT INTO parallel_notes(character_id, date, slot, due_at, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(character_id, date, slot) DO UPDATE SET
      due_at = excluded.due_at, lease = excluded.lease, lease_until = excluded.lease_until, attempts = parallel_notes.attempts + 1
    WHERE parallel_notes.data IS NULL AND parallel_notes.lease_until <= ? AND parallel_notes.retry_at <= ? RETURNING attempts`)
    .bind(id, date, slot, dueAt, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return;
  let used = 0;
  try {
    const [her, mine, later] = await Promise.all([
      todayOf(env, { character: context.character, timezone: context.timezone, day: context.her }, now),
      mineOf(env, context, now),
      // 手机上传之后云端又留过的：手机没来得及拉的那几条也算"说过的"
      env.DB.prepare('SELECT data FROM parallel_notes WHERE character_id = ? AND done_at > ? AND data IS NOT NULL ORDER BY done_at DESC LIMIT 4')
        .bind(id, row.updated_at).all<{ data: string }>(),
    ]);
    const names = parallelNames(context.persona.name, () => context.character.name);
    const mineNotes = later.results.map((r) => parallelNoteText(JSON.parse(r.data) as ParallelNote, names, context.timezone)).reverse();
    const current: ParallelContext = { ...context, notes: [context.notes, ...mineNotes].filter(Boolean).join('\n') };
    const route = credentials.routes.find((r) => r.role === 'parallel');
    const request = parallelRequest(current, now, her, mine).request;
    const estimate = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? route?.params?.maxTokens ?? 0);
    if (!await reserve(env, lease, `parallel:${date}`, estimate, route?.dailyTokenBudget ?? 0, now)) throw new AiError('budget', '平行时空每日 token 预算已用完');
    const result = await generate(current, credentials, hubParallelNoteId(id, date, slot), date, now, her, mine);
    used = result.tokens;
    // A settings change/removal during the call invalidates the output, without blocking any other role.
    const saved = await env.DB.prepare(`UPDATE parallel_notes SET data = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL, done_at = ?
      WHERE character_id = ? AND date = ? AND slot = ? AND lease = ?
      AND EXISTS (SELECT 1 FROM parallel_contexts WHERE character_id = ? AND revision = ?)`)
      .bind(JSON.stringify(result.note), Date.now(), id, date, slot, lease, id, row.revision).run();
    if (!saved.meta.changes) throw new Error('生成期间平行时空设置更新');
    // 通知发一次就好：发不出去不重发（打开 App 就能看到），也不算这一条失败
    const channels = await env.DB.prepare('SELECT * FROM push_channels').all<Channel>();
    await Promise.allSettled(channels.results.map((ch) => sendChannel(env, ch, notificationFor(context, result.note))));
  } catch (e) {
    // Provider messages may contain keys or response bodies; sync only a safe failure summary.
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.name : 'Error';
    await env.DB.prepare(`UPDATE parallel_notes SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE character_id = ? AND date = ? AND slot = ? AND lease = ?`)
      .bind(now + Math.min(30, 5 * 2 ** Math.min(claim.attempts - 1, 3)) * 60_000, `留言生成失败（${reason}），云端将自动重试`, id, date, slot, lease).run();
  } finally {
    await release(env, lease, used);
  }
}

/** 这个角色现在到点、还在补发窗口里的那几条（昨天深夜的和今天的） */
function dueSlots(context: ParallelContext, now: number): { date: string; slot: number; dueAt: number }[] {
  if (!context.settings.enabled) return [];
  const today = zonedDateKey(now, context.timezone);
  return [shiftDate(today, -1), today].flatMap((date) =>
    parallelDueTimes({ characterId: context.character.id, date, perDay: context.settings.perDay, awake: context.awake, timezone: context.timezone })
      .map((dueAt, slot) => ({ date, slot, dueAt }))
      .filter((s) => s.dueAt <= now && now - s.dueAt < CATCH_UP_MS));
}

/** 每 5 分钟的 Cron 里跑；和主动消息的总开关无关，手机没开也留 */
export async function runParallelScheduled(env: Env, now = Date.now(), generate: ParallelGenerator = generateParallelNote) {
  try {
    const rows = await env.DB.prepare('SELECT character_id, revision, data, updated_at FROM parallel_contexts').all<ContextRow>();
    if (!rows.results.length) { await setMeta(env, 'lastParallelError', null); return; }
    const due = rows.results.flatMap((row) => dueSlots(JSON.parse(row.data) as ParallelContext, now).map((s) => ({ row, ...s })));
    if (due.length) {
      const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'parallel'").first<{ ciphertext: string; iv: string }>();
      if (!sealed) throw new Error('未设置云端平行时空 API，请打开 App 同步');
      const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
      await releaseExpired(env, now);
      const results = await Promise.allSettled(due.map((d) => postOne(env, d.row, d.slot, d.dueAt, d.date, credentials, now, generate)));
      if (results.some((r) => r.status === 'rejected')) throw new Error('部分留言任务失败，下一轮继续检测');
    }
    await Promise.all([
      env.DB.prepare('DELETE FROM parallel_notes WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
      setMeta(env, 'lastParallelError', null),
    ]);
  } catch (e) {
    await setMeta(env, 'lastParallelError', e instanceof Error ? e.message : '云端平行时空检测失败');
    throw e;
  }
}
