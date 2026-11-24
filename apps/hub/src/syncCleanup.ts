import type { Env } from './env.ts';
import { getMeta, setMeta } from './scheduler.ts';

/**
 * 多设备同步的图片和文件每天清一次（只清云端，各设备本机已有的不动）：
 * - 没有任何记录用到的图（删掉的朋友圈、帖子、消息里的图，重新生成后被换掉的旧图）：放进云端满 2 天就删；
 * - 只被聊天消息、朋友圈、社群帖子、图库、日记用到的图：画好满 30 天删；
 * - 角色（立绘、头像）、人设和设置、相册、世界、社群、书、Live2D 模型……用到的一直留着；
 * - 同步用的大文件（图片的文件、存成大文件的记录）没有记录引用、放进来满 2 天的删掉。
 * 记录里引用素材写的是素材的 key（文件的 SHA-256，64 位十六进制），引用文件写的是 { $bin / $blob: 哈希 }：
 * 把每条记录里所有 64 位十六进制串都当成引用（宁可多留，不会误删）；整条存成大文件的记录解压了再找。
 */

const DAY = 86_400_000;
/** 图只被这些记录用到时，画好满 30 天就从云端删掉 */
const EXPIRING = new Set(['message', 'moments', 'communityPosts', 'gallery', 'diaries']);
const KEEP_DAYS = 30;
/** 刚放进来的不动：设备先推记录、后传文件，中间可能隔一会儿；离线很久的设备也有时间推上来 */
const GRACE = 2 * DAY;
const HEX = /[0-9a-f]{64}/g;
const PAGE = 200;

interface Row { kind: string; id: string; seq: number; updated_at: number; data: string | null }
interface Ref { important: boolean }

function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 读一个同步用的大文件（D1 分块或 R2）；没有时为空 */
async function readBlob(env: Env, hash: string): Promise<Uint8Array | null> {
  const info = await env.DB.prepare('SELECT parts FROM sync_blobs WHERE hash = ?').bind(hash).first<{ parts: number }>();
  if (!info) return null;
  if (info.parts === 0) {
    const object = await env.SYNC_BUCKET?.get(`sync/${hash}`);
    return object ? new Uint8Array(await object.arrayBuffer()) : null;
  }
  const rows = await env.DB.prepare('SELECT data FROM sync_blob_parts WHERE hash = ? AND part < ? ORDER BY part').bind(hash, info.parts).all<{ data: string }>();
  const chunks = rows.results.map((r) => fromBase64(r.data));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

/** 整条存成大文件的记录：取回来（gzip 的解压）当成文本 */
async function packedText(env: Env, ref: { $blob: string; gzip?: boolean }): Promise<string> {
  const bytes = await readBlob(env, ref.$blob);
  if (!bytes) return '';
  if (!ref.gzip) return new TextDecoder().decode(bytes);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

export interface CleanupResult { assets: number; blobs: number; bytes: number }

/** 清一次（每天最多一次：Cron 每 5 分钟叫一次，没到时间直接返回） */
export async function runSyncCleanup(env: Env, now = Date.now(), force = false): Promise<CleanupResult | null> {
  if (!force && now - await getMeta<number>(env, 'syncCleanupAt', 0) < DAY) return null;
  await setMeta(env, 'syncCleanupAt', now);

  // 1. 所有还在的记录里引用了哪些素材 / 文件；素材本身的记录另外记下（key → 文件哈希、画好的时间）
  const refs = new Map<string, Ref>();
  const assets: { id: string; bin: string | null; createdAt: number; updatedAt: number }[] = [];
  const note = (text: string, kind: string) => {
    const important = !EXPIRING.has(kind);
    for (const h of text.match(HEX) ?? []) {
      const cur = refs.get(h);
      if (!cur) refs.set(h, { important });
      else if (important) cur.important = true;
    }
  };
  let since = 0;
  for (;;) {
    const page = await env.DB.prepare('SELECT kind, id, seq, updated_at, data FROM sync_records WHERE seq > ? AND deleted = 0 ORDER BY seq LIMIT ?').bind(since, PAGE).all<Row>();
    const rows = page.results;
    for (const r of rows) {
      const text = r.data ?? '';
      if (r.kind === 'assets') {
        let data: { createdAt?: unknown; data?: { $bin?: unknown } } | null = null;
        try { data = JSON.parse(text); } catch { /* 认不出：当成没有文件 */ }
        const bin = typeof data?.data?.$bin === 'string' ? data.data.$bin : null;
        const createdAt = Number(data?.createdAt);
        assets.push({ id: r.id, bin, createdAt: Number.isFinite(createdAt) && createdAt > 0 ? createdAt : r.updated_at, updatedAt: r.updated_at });
        continue;
      }
      note(text, r.kind);
      // 整条存成了大文件的记录（角色、预设、世界书这种大的）：里面的引用也要算上
      if (text.length < 400 && text.includes('"$blob"')) {
        try {
          const ref = JSON.parse(text) as { $blob?: unknown; gzip?: boolean };
          if (typeof ref.$blob === 'string') note(await packedText(env, { $blob: ref.$blob, gzip: ref.gzip }), r.kind);
        } catch {
          // 读不出来：这条记录里的引用不知道，保守起见这次不删任何素材
          return { assets: 0, blobs: 0, bytes: 0 };
        }
      }
    }
    if (rows.length < PAGE) break;
    since = rows.at(-1)!.seq;
  }

  // 2. 要删的素材记录：没人用、放进来满 2 天；或者只被聊天、朋友圈、帖子、图库、日记用到、画好满 30 天
  const dropAssets = assets.filter((a) => {
    const ref = refs.get(a.id);
    if (!ref) return now - a.updatedAt > GRACE;
    return !ref.important && now - a.createdAt > KEEP_DAYS * DAY;
  });
  const dropped = new Set(dropAssets.map((a) => a.id));
  for (let i = 0; i < dropAssets.length; i += 90) {
    const ids = dropAssets.slice(i, i + 90).map((a) => a.id);
    await env.DB.prepare(`DELETE FROM sync_records WHERE kind = 'assets' AND parent = '' AND id IN (${ids.map(() => '?').join(',')})`).bind(...ids).run();
  }

  // 3. 要删的文件：留下的素材记录和别的记录都没引用、放进来满 2 天
  // 素材的 key 和它文件的哈希是同一个串：删掉的素材，朋友圈、消息里对它的引用不再保住文件
  const keep = new Set([...refs.keys()].filter((h) => !dropped.has(h)));
  for (const a of assets) if (!dropped.has(a.id) && a.bin) keep.add(a.bin);
  const blobs = await env.DB.prepare('SELECT hash, size, parts, created_at FROM sync_blobs').all<{ hash: string; size: number; parts: number; created_at: number }>();
  const dropBlobs = blobs.results.filter((b) => !keep.has(b.hash) && now - b.created_at > GRACE);
  for (let i = 0; i < dropBlobs.length; i += 90) {
    const list = dropBlobs.slice(i, i + 90);
    const marks = list.map(() => '?').join(',');
    const hashes = list.map((b) => b.hash);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM sync_blob_parts WHERE hash IN (${marks})`).bind(...hashes),
      env.DB.prepare(`DELETE FROM sync_blobs WHERE hash IN (${marks})`).bind(...hashes),
    ]);
    const r2 = list.filter((b) => b.parts === 0).map((b) => `sync/${b.hash}`);
    if (r2.length && env.SYNC_BUCKET) await env.SYNC_BUCKET.delete(r2);
  }

  const result = { assets: dropAssets.length, blobs: dropBlobs.length, bytes: dropBlobs.reduce((n, b) => n + b.size, 0) };
  await setMeta(env, 'syncCleanupLast', { at: now, ...result });
  return result;
}
