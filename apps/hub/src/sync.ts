import { SYNC_BLOB_PART_CHARS, syncBlobParts, type SyncBlobCheck, type SyncBlobInfo, type SyncPushRecord, type SyncPushResult } from '@app/shared';
import type { Env } from './env.ts';
import { assert, HttpError, json, readJson } from './http.ts';

/**
 * 多设备同步（设计文档 §12）：连着同一个 Worker 的设备看到同一份聊天、朋友圈、社群、记忆、角色和设置。
 *
 * - 本机库的每条记录在 sync_records 里一行（聊天消息按条，parent 是聊天 id），推送时服务器在一个 D1 batch 里分配全局递增的 seq，
 *   手机按 seq 增量拉取，不依赖设备时钟；删除留墓碑。
 * - 推送带上这台设备上一次见到的 seq（base）：云端那条已经被别的设备改过（seq 不同）就不写，把云端那一份退回去，手机合并后再推。
 *   所以两台设备同时改同一条，谁也不会悄悄盖掉谁。
 * - 大文件（图片、语音、Live2D 模型、书的原文件、太大的记录）按 SHA-256 存一份：绑了 R2（SYNC_BUCKET）放 R2，
 *   没绑时手机传 base64 分块存进 D1（Worker 不用解码，几乎不占 CPU）；D1 里占的空间可以设上限（SYNC_BLOB_QUOTA_MB），满了不再收（文字记录照样同步）。
 * - Worker 不解读记录的内容，也不存任何 Key（Key 只在各自的设备上）。
 */

const KIND = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const HASH = /^[0-9a-f]{64}$/;
/** 一次推送最多几条、请求体多大（手机按这个分批） */
const PUSH_MAX_RECORDS = 100;
const PUSH_MAX_BYTES = 1_800_000;
/** 一条记录的 JSON 最多多大（D1 一行最多 2 MB）：更大的手机先存成大文件，记录里只放引用 */
const RECORD_MAX_CHARS = 1_000_000;
/** 一次拉取最多几条、多少字节 */
const PULL_MAX_RECORDS = 500;
const PULL_MAX_CHARS = 2_000_000;
/** 带 cut 拉取时一次最多往后扫多少个 seq（跳过的老消息多时分几次，免得一次查询扫完整张表） */
const PULL_SCAN = 20_000;
/** 大文件的上限：D1（base64 分块）和 R2 */
const D1_BLOB_MAX = 24 * 1024 * 1024;
const R2_BLOB_MAX = 90 * 1024 * 1024;
/** 没绑 R2 时同步的大文件在 D1 里最多占多少字节：wrangler 配置的 SYNC_BLOB_QUOTA_MB（MB）；没配就不限 */
function blobQuota(env: Env): number | null {
  if (env.SYNC_BUCKET) return null;
  const mb = Number(env.SYNC_BLOB_QUOTA_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : null;
}

/** /v1/status 里给 App 看的：有同步、大文件存在哪 */
export function syncStatus(env: Env) {
  return { sync: true, syncBlobs: env.SYNC_BUCKET ? 'r2' : 'd1', syncBlobQuota: blobQuota(env) } as const;
}

function validRecord(r: SyncPushRecord): boolean {
  return !!r && typeof r === 'object' && typeof r.kind === 'string' && KIND.test(r.kind)
    && typeof r.id === 'string' && r.id.length >= 1 && r.id.length <= 512
    && typeof r.parent === 'string' && r.parent.length <= 512
    && typeof r.deleted === 'boolean' && Number.isFinite(r.updatedAt) && r.updatedAt >= 0
    && Number.isSafeInteger(r.base) && r.base >= 0
    && (r.deleted || r.data !== undefined);
}

interface Row { kind: string; parent: string; id: string; seq: number; updated_at: number; deleted: number; data: string | null }

/** 一行 → 回给手机的 JSON（data 本来就是 JSON 文本，直接拼进去，不用再解析一遍） */
function rowJson(r: Row): string {
  return `{"kind":${JSON.stringify(r.kind)},"parent":${JSON.stringify(r.parent)},"id":${JSON.stringify(r.id)},"seq":${r.seq},"updatedAt":${r.updated_at},"deleted":${r.deleted ? 'true' : 'false'},"data":${r.deleted ? 'null' : (r.data ?? 'null')}}`;
}

async function push(request: Request, env: Env, deviceId: string): Promise<Response> {
  const { records } = await readJson<{ records: SyncPushRecord[] }>(request, PUSH_MAX_BYTES);
  assert(Array.isArray(records) && records.length <= PUSH_MAX_RECORDS, `一次最多推 ${PUSH_MAX_RECORDS} 条`);
  const seen = new Set<string>();
  const rows = records.map((r) => {
    assert(validRecord(r), '同步记录无效');
    const key = `${r.kind}\n${r.parent}\n${r.id}`;
    assert(!seen.has(key), '同一条记录推了两次');
    seen.add(key);
    const data = r.deleted ? null : JSON.stringify(r.data);
    assert(data === null || data.length <= RECORD_MAX_CHARS, '同步记录太大（应先存成大文件）');
    // 消息的时间（新设备只拉最近的、往上翻时按时间往前取）：data 里有就用，存成大文件的看手机带上的
    const at = r.kind === 'message' && !r.deleted ? Number((r.data as { createdAt?: unknown } | null)?.createdAt ?? r.createdAt) : NaN;
    return { ...r, data, createdAt: Number.isFinite(at) ? Math.round(at) : null };
  });
  if (!rows.length) return json({ applied: [], conflicts: [] } satisfies SyncPushResult);
  // 一个 batch 里按顺序写（D1 的 batch 是一个事务）：每条拿 MAX(seq) + 1，云端那条的 seq 和手机见过的一样才覆盖
  const results = await env.DB.batch<{ seq: number }>(rows.map((r) => env.DB.prepare(`INSERT INTO sync_records (kind, parent, id, seq, updated_at, deleted, device_id, data, created_at)
    SELECT ?1, ?2, ?3, COALESCE((SELECT MAX(seq) FROM sync_records), 0) + 1, ?4, ?5, ?6, ?7, ?9 WHERE 1
    ON CONFLICT (kind, parent, id) DO UPDATE SET seq = excluded.seq, updated_at = excluded.updated_at, deleted = excluded.deleted,
      device_id = excluded.device_id, data = excluded.data, created_at = excluded.created_at
    WHERE sync_records.seq = ?8
    RETURNING seq`).bind(r.kind, r.parent, r.id, Math.round(r.updatedAt), r.deleted ? 1 : 0, deviceId, r.data, r.base, r.createdAt)));
  const applied: SyncPushResult['applied'] = [];
  const lost: typeof rows = [];
  rows.forEach((r, i) => {
    const seq = results[i]?.results?.[0]?.seq;
    if (typeof seq === 'number') applied.push({ kind: r.kind, parent: r.parent, id: r.id, seq });
    else lost.push(r);
  });
  let conflicts = '';
  if (lost.length) {
    const current = await env.DB.batch<Row>(lost.map((r) => env.DB.prepare('SELECT kind, parent, id, seq, updated_at, deleted, data FROM sync_records WHERE kind = ? AND parent = ? AND id = ?')
      .bind(r.kind, r.parent, r.id)));
    conflicts = current.flatMap((c) => c.results ?? []).map(rowJson).join(',');
  }
  return new Response(`{"applied":${JSON.stringify(applied)},"conflicts":[${conflicts}]}`, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/**
 * 增量拉取。POST 时可以带 cut（{ 聊天 id: createdAt }）：这些聊天里 createdAt 不超过它的消息先不给
 * （新设备第一次同步只拉每个聊天最近的；跳过的老消息多时一次最多扫 PULL_SCAN 个 seq，没扫完 more 照样是 true）
 */
async function pull(request: Request, env: Env, url: URL): Promise<Response> {
  const body = request.method === 'POST' ? await readJson<{ since?: number; limit?: number; cut?: Record<string, number> }>(request, 1_000_000) : null;
  const since = Number(body ? body.since : url.searchParams.get('since') ?? 0);
  const limit = Number(body ? body.limit ?? 300 : url.searchParams.get('limit') ?? 300);
  assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
  assert(Number.isInteger(limit) && limit >= 1 && limit <= PULL_MAX_RECORDS, 'limit 无效');
  const cut = body?.cut && typeof body.cut === 'object' && Object.keys(body.cut).length ? body.cut : null;
  assert(!cut || Object.values(cut).every((v) => Number.isFinite(v)), 'cut 无效');
  const [rows, head] = await env.DB.batch([
    cut
      ? env.DB.prepare(`SELECT kind, parent, id, seq, updated_at, deleted, data FROM sync_records WHERE seq > ?1 AND seq <= ?2
        AND NOT (kind = 'message' AND COALESCE(created_at, 9e15) <= COALESCE((SELECT value FROM json_each(?3) WHERE key = sync_records.parent), -1))
        ORDER BY seq LIMIT ?4`).bind(since, since + PULL_SCAN, JSON.stringify(cut), limit)
      : env.DB.prepare('SELECT kind, parent, id, seq, updated_at, deleted, data FROM sync_records WHERE seq > ? ORDER BY seq LIMIT ?').bind(since, limit),
    env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM sync_records'),
  ]);
  const list = (rows?.results ?? []) as Row[];
  // 按字节截一页（至少一条）：大记录多的时候分几次拉
  const out: string[] = [];
  let chars = 0;
  let next = since;
  for (const r of list) {
    const text = rowJson(r);
    if (out.length && chars + text.length > PULL_MAX_CHARS) break;
    out.push(text);
    chars += text.length;
    next = r.seq;
  }
  const top = (head?.results?.[0] as { head?: number } | undefined)?.head ?? next;
  let more = out.length < list.length || list.length === limit;
  // 带 cut：这一段扫完了、没满一页，下次从这段末尾接着扫
  if (cut && !more) {
    next = Math.min(since + PULL_SCAN, top);
    more = next < top;
  }
  return new Response(`{"records":[${out.join(',')}],"next":${next},"more":${more},"head":${top}}`, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/**
 * 新设备第一次同步前问：每个聊天最近 keep 条之前的那条消息的 [createdAt, seq]（消息不到 keep 条的聊天不列）。
 * 一条查询，每个聊天沿 (kind, parent, created_at, seq) 索引只读 keep 行左右
 */
async function recent(env: Env, url: URL): Promise<Response> {
  const keep = Number(url.searchParams.get('keep') ?? 500);
  assert(Number.isInteger(keep) && keep >= 1 && keep <= 10_000, 'keep 无效');
  const [rows, head] = await env.DB.batch([
    env.DB.prepare(`SELECT c.id AS parent,
        (SELECT m.created_at FROM sync_records m WHERE m.kind = 'message' AND m.parent = c.id AND m.deleted = 0 AND m.created_at IS NOT NULL
          ORDER BY m.created_at DESC, m.seq DESC LIMIT 1 OFFSET ?1) AS at
      FROM sync_records c WHERE c.kind = 'chats' AND c.parent = '' AND c.deleted = 0`).bind(keep),
    env.DB.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM sync_records'),
  ]);
  const cut: Record<string, [number, number]> = {};
  for (const r of (rows?.results ?? []) as { parent: string; at: number | null }[]) if (typeof r.at === 'number') cut[r.parent] = [r.at, Number.MAX_SAFE_INTEGER];
  return json({ cut, head: (head?.results?.[0] as { head?: number } | undefined)?.head ?? 0 });
}

/** 一个聊天里 (createdAt, seq) 在 (at, seq) 之前的消息，新的在前（往上翻时一页一页取） */
async function older(env: Env, url: URL): Promise<Response> {
  const parent = url.searchParams.get('parent') ?? '';
  const at = Number(url.searchParams.get('at'));
  const seq = Number(url.searchParams.get('seq'));
  const limit = Number(url.searchParams.get('limit') ?? 200);
  assert(parent && parent.length <= 512 && Number.isFinite(at) && Number.isFinite(seq), '参数无效');
  assert(Number.isInteger(limit) && limit >= 1 && limit <= PULL_MAX_RECORDS, 'limit 无效');
  const { results } = await env.DB.prepare(`SELECT kind, parent, id, seq, updated_at, deleted, data, created_at FROM sync_records
    WHERE kind = 'message' AND parent = ?1 AND deleted = 0 AND (created_at < ?2 OR (created_at = ?2 AND seq < ?3))
    ORDER BY created_at DESC, seq DESC LIMIT ?4`).bind(parent, at, seq, limit + 1).all<Row & { created_at: number }>();
  const list = results.slice(0, limit);
  const out: string[] = [];
  let chars = 0;
  for (const r of list) {
    const text = `${rowJson(r).slice(0, -1)},"createdAt":${r.created_at}}`;
    if (out.length && chars + text.length > PULL_MAX_CHARS) break;
    out.push(text);
    chars += text.length;
  }
  const more = out.length < results.length;
  return new Response(`{"records":[${out.join(',')}],"more":${more}}`, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

/** 单独取一条（图片在别的设备上已经有了、这台还没拉到它的记录时） */
async function one(env: Env, url: URL): Promise<Response> {
  const kind = url.searchParams.get('kind') ?? '';
  const parent = url.searchParams.get('parent') ?? '';
  const id = url.searchParams.get('id') ?? '';
  assert(KIND.test(kind) && id && id.length <= 512 && parent.length <= 512, '参数无效');
  const row = await env.DB.prepare('SELECT kind, parent, id, seq, updated_at, deleted, data FROM sync_records WHERE kind = ? AND parent = ? AND id = ?').bind(kind, parent, id).first<Row>();
  return new Response(`{"record":${row ? rowJson(row) : 'null'}}`, { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

async function blobRow(env: Env, hash: string) {
  return env.DB.prepare('SELECT mime, size, parts FROM sync_blobs WHERE hash = ?').bind(hash).first<SyncBlobInfo>();
}

function cleanMime(value: string | null): string {
  const mime = (value ?? '').split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime) && mime.length <= 100 ? mime : 'application/octet-stream';
}

async function checkQuota(env: Env, size: number) {
  const quota = blobQuota(env);
  if (quota === null) return;
  const used = await env.DB.prepare('SELECT COALESCE(SUM(size), 0) AS used FROM sync_blobs').first<{ used: number }>();
  if ((used?.used ?? 0) + size > quota) throw new HttpError(507, `云端存图片和文件的空间满了（D1 最多 ${Math.round(quota / 1024 / 1024)} MB）：绑定 R2 后可以继续同步图片，文字记录不受影响`);
}

/**
 * 存一个大文件。
 * - 绑了 R2：请求体就是文件本身（Content-Type 是它的类型），一次传完。
 * - 没绑：手机把文件转成 base64 分块传（?part=第几块&parts=一共几块&size=字节数，类型放 X-Blob-Type），最后一块到了才算存好。
 */
async function putBlob(request: Request, env: Env, url: URL, hash: string): Promise<Response> {
  const existing = await blobRow(env, hash);
  if (existing) return json({ ok: true, existed: true });
  if (env.SYNC_BUCKET) {
    const length = Number(request.headers.get('Content-Length') ?? NaN);
    assert(!Number.isFinite(length) || length <= R2_BLOB_MAX, '文件太大');
    const bytes = await request.arrayBuffer();
    assert(bytes.byteLength <= R2_BLOB_MAX, '文件太大');
    const mime = cleanMime(request.headers.get('Content-Type'));
    await env.SYNC_BUCKET.put(`sync/${hash}`, bytes, { httpMetadata: { contentType: mime } });
    await env.DB.prepare('INSERT OR IGNORE INTO sync_blobs (hash, mime, size, parts, created_at) VALUES (?, ?, ?, 0, ?)').bind(hash, mime, bytes.byteLength, Date.now()).run();
    return json({ ok: true });
  }
  const part = Number(url.searchParams.get('part'));
  const parts = Number(url.searchParams.get('parts'));
  const size = Number(url.searchParams.get('size'));
  assert(Number.isInteger(parts) && parts >= 1 && Number.isInteger(part) && part >= 0 && part < parts, '分块参数无效');
  assert(Number.isInteger(size) && size >= 0 && size <= D1_BLOB_MAX, `文件太大（没绑 R2 时最多 ${D1_BLOB_MAX / 1024 / 1024} MB）`);
  assert(parts === syncBlobParts(size), '分块数和大小对不上');
  const text = await request.text();
  assert(text.length <= SYNC_BLOB_PART_CHARS && /^[A-Za-z0-9+/]*={0,2}$/.test(text), '分块不是 base64');
  if (part === 0) await checkQuota(env, size);
  const mime = cleanMime(request.headers.get('X-Blob-Type'));
  const [, count] = await env.DB.batch<{ n: number }>([
    env.DB.prepare('INSERT OR REPLACE INTO sync_blob_parts (hash, part, data) VALUES (?, ?, ?)').bind(hash, part, text),
    env.DB.prepare('SELECT COUNT(*) AS n FROM sync_blob_parts WHERE hash = ? AND part < ?').bind(hash, parts),
  ]);
  const done = (count?.results?.[0]?.n ?? 0) >= parts;
  if (done) await env.DB.prepare('INSERT OR IGNORE INTO sync_blobs (hash, mime, size, parts, created_at) VALUES (?, ?, ?, ?, ?)').bind(hash, mime, size, parts, Date.now()).run();
  return json({ ok: true, done });
}

async function getBlob(env: Env, url: URL, hash: string): Promise<Response> {
  const info = await blobRow(env, hash);
  if (!info) throw new HttpError(404, '云端没有这个文件');
  const headers = { 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Blob-Type': info.mime };
  if (info.parts === 0) {
    if (!env.SYNC_BUCKET) throw new HttpError(503, '这个文件存在 R2，但 Worker 现在没绑 SYNC_BUCKET');
    const object = await env.SYNC_BUCKET.get(`sync/${hash}`);
    if (!object) throw new HttpError(404, '云端没有这个文件');
    return new Response(object.body, { headers: { ...headers, 'Content-Type': info.mime } });
  }
  const part = Number(url.searchParams.get('part') ?? 0);
  assert(Number.isInteger(part) && part >= 0 && part < info.parts, '分块参数无效');
  const row = await env.DB.prepare('SELECT data FROM sync_blob_parts WHERE hash = ? AND part = ?').bind(hash, part).first<{ data: string }>();
  if (!row) throw new HttpError(404, '云端这个文件缺了一块');
  return new Response(row.data, { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
}

/** 哪些大文件云端已经有了（传之前问一下，同一个文件只传一次；拉之前问分了几块） */
async function checkBlobs(request: Request, env: Env): Promise<Response> {
  const { hashes } = await readJson<{ hashes: string[] }>(request, 100_000);
  assert(Array.isArray(hashes) && hashes.length <= 100 && hashes.every((h) => typeof h === 'string' && HASH.test(h)), 'hashes 无效');
  const unique = [...new Set(hashes)];
  const blobs: SyncBlobCheck['blobs'] = {};
  if (unique.length) {
    const rows = await env.DB.prepare(`SELECT hash, mime, size, parts FROM sync_blobs WHERE hash IN (${unique.map(() => '?').join(',')})`).bind(...unique).all<SyncBlobInfo & { hash: string }>();
    for (const r of rows.results) blobs[r.hash] = { mime: r.mime, size: r.size, parts: r.parts };
  }
  return json({ blobs } satisfies SyncBlobCheck);
}

export async function syncApi(request: Request, env: Env, url: URL, deviceId: string): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/v1/sync/push' && method === 'POST') return push(request, env, deviceId);
  if (path === '/v1/sync/pull' && (method === 'GET' || method === 'POST')) return pull(request, env, url);
  if (path === '/v1/sync/recent' && method === 'GET') return recent(env, url);
  if (path === '/v1/sync/older' && method === 'GET') return older(env, url);
  if (path === '/v1/sync/record' && method === 'GET') return one(env, url);
  if (path === '/v1/sync/blobs/check' && method === 'POST') return checkBlobs(request, env);
  const blob = path.match(/^\/v1\/sync\/blobs\/([0-9a-f]{64})$/);
  if (blob) {
    if (method === 'PUT') return putBlob(request, env, url, blob[1]!);
    if (method === 'GET') return getBlob(env, url, blob[1]!);
  }
  throw new HttpError(404, '接口不存在');
}

