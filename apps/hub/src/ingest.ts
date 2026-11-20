import { parseHaeWorkouts, parseShortcutWorkouts, watchWorkoutLine, type HubWatchWorkouts, type WatchWorkout } from '@app/shared';
import { digest } from './crypto.ts';
import type { Env } from './env.ts';
import { assert, HttpError, json, readJson } from './http.ts';
import { getMeta, setMeta } from './scheduler.ts';

/**
 * 手表的运动数据（设计文档 §9.1，表 workout_ingest）：
 * - iPhone 的快捷指令推到 POST /v1/ingest/workout（格式见 packages/shared/src/watchWorkout.ts 的 parseShortcutWorkouts），
 *   Health Auto Export 的 REST API 自动化推到 POST /v1/ingest/hae（它的 JSON，数据类型选 Workouts）；
 *   这两个用单独的上报令牌（请求头 Authorization: Bearer <令牌>），不用设备的登录令牌：令牌要填进快捷指令、别的 App 里，
 *   只能往里推运动数据，读不了别的。令牌只存哈希，App 里重新建一个旧的就失效。
 * - 手机用登录令牌拉：GET /v1/ingest/workouts?since=<seq>；建 / 换令牌 POST /v1/ingest/token，停用 DELETE /v1/ingest/token。
 * 只存读好的数（时间、心率、消耗、距离、步数，按分钟的明细），不存路线；留 120 天。
 */

interface IngestToken {
  hash: string;
  createdAt: number;
}

const KEEP_DAYS = 120;
const PAGE = 100;
/** Health Auto Export 开了按秒的明细、手动补传很多天时请求会很大 */
const MAX_BODY = 8_000_000;

export const INGEST_POST_PATHS: Record<string, 'workout' | 'hae'> = { '/v1/ingest/workout': 'workout', '/v1/ingest/hae': 'hae' };

const tokenOf = (env: Env) => getMeta<IngestToken | null>(env, 'ingestToken', null);

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function missingTable(e: unknown): boolean {
  return /no such table/i.test(e instanceof Error ? e.message : String(e));
}
const MIGRATE_HINT = '云端数据库还没升级：按 docs/CLOUDFLARE.md 重新部署一次（会跑数据库迁移 0012_workout_ingest）';

/** 快捷指令、Health Auto Export 推上来的 */
export async function ingestPost(request: Request, env: Env, kind: 'workout' | 'hae'): Promise<Response> {
  const token = await tokenOf(env);
  if (!token) throw new HttpError(403, '还没建上报令牌：在 App 的「我的 → 手表数据」里建一个');
  const given = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim() ?? '';
  if (!given || !sameText(await digest(given), token.hash)) throw new HttpError(401, '上报令牌不对：在 App 的「我的 → 手表数据」里复制，请求头写 Authorization: Bearer <令牌>');
  const parsed = kind === 'hae' ? parseHaeWorkouts(await readJson<unknown>(request, MAX_BODY)) : parseShortcutWorkouts(await readJson<unknown>(request, MAX_BODY));
  if (!parsed.workouts.length && parsed.errors.length) throw new HttpError(400, parsed.errors.join('；'));
  const now = Date.now();
  let saved = 0;
  let unchanged = 0;
  try {
    for (const w of parsed.workouts) {
      const data = JSON.stringify(w);
      const old = await env.DB.prepare('SELECT data FROM workout_ingest WHERE id = ?').bind(w.id).first<{ data: string }>();
      if (old?.data === data) {
        unchanged++;
        continue;
      }
      // 换一行（不是原地改）：seq 变大，手机下次会再拉到
      await env.DB.batch([
        env.DB.prepare('DELETE FROM workout_ingest WHERE id = ?').bind(w.id),
        env.DB.prepare('INSERT INTO workout_ingest(id, source, started_at, data, received_at) VALUES (?, ?, ?, ?, ?)').bind(w.id, w.source, w.startedAt, data, now),
      ]);
      saved++;
    }
    await env.DB.prepare('DELETE FROM workout_ingest WHERE started_at < ?').bind(now - KEEP_DAYS * 86_400_000).run();
  } catch (e) {
    if (missingTable(e)) throw new HttpError(503, MIGRATE_HINT);
    throw e;
  }
  await setMeta(env, 'lastIngestAt', now);
  // 快捷指令里"显示结果"能直接看到这一句
  const first = parsed.workouts[0];
  const message = !parsed.workouts.length ? '没有要存的运动' : `收到了${parsed.workouts.length > 1 ? ` ${parsed.workouts.length} 次运动` : ''}：${first ? watchWorkoutLine(first) : ''}${parsed.workouts.length > 1 ? ' 等' : ''}`;
  return json({ ok: true, message, saved, unchanged, errors: parsed.errors });
}

/** App（设备的登录令牌）：建 / 换 / 停用上报令牌，拉推上来的运动 */
export async function ingestApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  if (path === '/v1/ingest/token' && request.method === 'POST') {
    const token = `wk_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '')}`;
    const createdAt = Date.now();
    await setMeta(env, 'ingestToken', { hash: await digest(token), createdAt } satisfies IngestToken);
    return json({ token, createdAt });
  }
  if (path === '/v1/ingest/token' && request.method === 'DELETE') {
    await env.DB.prepare("DELETE FROM meta WHERE key = 'ingestToken'").run();
    return json({ ok: true });
  }
  if (path === '/v1/ingest/workouts' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    try {
      const [rows, token] = await Promise.all([
        env.DB.prepare('SELECT seq, data, received_at FROM workout_ingest WHERE seq > ? ORDER BY seq LIMIT ?').bind(since, PAGE + 1).all<{ seq: number; data: string; received_at: number }>(),
        tokenOf(env),
      ]);
      const page = rows.results.slice(0, PAGE);
      const body: HubWatchWorkouts = {
        workouts: page.map((r) => ({ seq: r.seq, receivedAt: r.received_at, workout: JSON.parse(r.data) as WatchWorkout })),
        next: page.at(-1)?.seq ?? since,
        more: rows.results.length > PAGE,
        tokenCreatedAt: token?.createdAt ?? null,
      };
      return json(body);
    } catch (e) {
      if (missingTable(e)) throw new HttpError(503, MIGRATE_HINT);
      throw e;
    }
  }
  throw new HttpError(404, '接口不存在');
}

/** /v1/status 里的几项：有没有这个功能、建没建令牌、上一次收到是什么时候 */
export async function ingestStatus(env: Env): Promise<{ ingest: true; ingestConfigured: boolean; lastIngestAt: number | null }> {
  const [token, lastIngestAt] = await Promise.all([tokenOf(env), getMeta<number | null>(env, 'lastIngestAt', null)]);
  return { ingest: true, ingestConfigured: !!token, lastIngestAt };
}
