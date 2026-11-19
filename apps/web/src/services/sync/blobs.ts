import { SYNC_BIN_REF, SYNC_BLOB_PART_CHARS, SYNC_BLOB_REF, syncBlobParts, type SyncBlobCheck, type SyncBlobInfo, type SyncBlobStore } from '@app/shared';
import { sha256Hex } from '@/utils/sha256';

/**
 * 同步用的大文件：图片、语音、Live2D 模型、书的原文件，和太大的记录（存成 gzip 过的 JSON）。
 * 按 SHA-256 存一份（同一个文件只传一次）；记录里只留引用：
 * - { $bin: 哈希, type, mime, size }：记录里的二进制（Blob / ArrayBuffer / Uint8Array）
 * - { $blob: 哈希, size, gzip }：整条记录
 * 云端绑了 R2 时整个文件一次传；没绑时转成 base64 分块存进 D1（Worker 不用解码）。下载后核对哈希。
 */

/** 和自己的 Worker 说话（带登录令牌） */
export interface SyncApi {
  json<T>(path: string, init?: { method?: string; body?: unknown; timeout?: number }): Promise<T>;
  raw(path: string, init?: { method?: string; body?: BodyInit; headers?: Record<string, string>; timeout?: number }): Promise<Response>;
}

export interface BinRef { $bin: string; type: 'Blob' | 'ArrayBuffer' | 'Uint8Array'; mime?: string; size: number }
export interface BlobRef { $blob: string; size: number; gzip?: boolean }

/** 云端放不下（空间满了、文件太大）：这一个先不传，别的照常同步 */
export class BlobSkipped extends Error {}

type Binary = Blob | ArrayBuffer | ArrayBufferView;
const PART_BYTES = (SYNC_BLOB_PART_CHARS / 4) * 3;
/** R2 整个文件一次传的上限；D1 已按块上传，不限制整个文件的大小。 */
const MAX_R2 = 90 * 1024 * 1024;

export function isBinary(v: unknown): v is Binary {
  return v instanceof ArrayBuffer || ArrayBuffer.isView(v) || (typeof Blob !== 'undefined' && v instanceof Blob);
}

export function isBinRef(v: unknown): v is BinRef {
  return !!v && typeof v === 'object' && typeof (v as BinRef)[SYNC_BIN_REF] === 'string';
}

export function isBlobRef(v: unknown): v is BlobRef {
  return !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as BlobRef)[SYNC_BLOB_REF] === 'string' && Object.keys(v).length <= 3;
}

/** 有没有二进制（Blob、ArrayBuffer……）要换成引用 */
export function hasBinary(v: unknown, depth = 0): boolean {
  if (isBinary(v)) return true;
  if (!v || typeof v !== 'object' || depth > 40) return false;
  if (Array.isArray(v)) return v.some((x) => hasBinary(x, depth + 1));
  for (const k in v as Record<string, unknown>) if (hasBinary((v as Record<string, unknown>)[k], depth + 1)) return true;
  return false;
}

export function hasBinRef(v: unknown, depth = 0): boolean {
  if (isBinRef(v)) return true;
  if (!v || typeof v !== 'object' || depth > 40) return false;
  if (Array.isArray(v)) return v.some((x) => hasBinRef(x, depth + 1));
  for (const k in v as Record<string, unknown>) if (hasBinRef((v as Record<string, unknown>)[k], depth + 1)) return true;
  return false;
}

export function sha256(bytes: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return sha256Hex(bytes);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function bytesOf(v: Binary): Promise<Uint8Array<ArrayBuffer>> {
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer);
  return new Uint8Array(await v.arrayBuffer());
}

/** 一台 Worker 上的大文件：问有没有、传、下载（同一个文件同时只做一次） */
export class BlobClient {
  /** 这次打开 App 以来确认过云端有的 */
  private known = new Map<string, SyncBlobInfo>();
  private uploads = new Map<string, Promise<void>>();

  constructor(private api: SyncApi, readonly store: SyncBlobStore) {}

  /** 哪些云端还没有（一次最多问 100 个） */
  async missing(hashes: string[]): Promise<Set<string>> {
    const ask = [...new Set(hashes)].filter((h) => !this.known.has(h));
    for (let i = 0; i < ask.length; i += 100) {
      const { blobs } = await this.api.json<SyncBlobCheck>('/v1/sync/blobs/check', { method: 'POST', body: { hashes: ask.slice(i, i + 100) } });
      for (const [h, info] of Object.entries(blobs)) this.known.set(h, info);
    }
    return new Set(hashes.filter((h) => !this.known.has(h)));
  }

  async upload(hash: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<void> {
    if (this.known.has(hash)) return;
    const running = this.uploads.get(hash);
    if (running) return running;
    const job = this.send(hash, bytes, mime).finally(() => this.uploads.delete(hash));
    this.uploads.set(hash, job);
    return job;
  }

  private async send(hash: string, bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<void> {
    if (this.store === 'r2' && bytes.byteLength > MAX_R2) throw new BlobSkipped(`有个文件 ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB，超过云端单个文件的上限（${MAX_R2 / 1024 / 1024} MB），没有同步`);
    const type = mime || 'application/octet-stream';
    const check = async (res: Response) => {
      if (res.ok) return;
      const text = await res.text().catch(() => '');
      let message = text;
      try { message = (JSON.parse(text) as { error?: string }).error ?? text; } catch { /* 不是 JSON */ }
      if (res.status === 507 || res.status === 413) throw new BlobSkipped(message || '云端放不下这个文件');
      throw new Error(message || `上传文件失败 HTTP ${res.status}`);
    };
    if (this.store === 'r2') {
      await check(await this.api.raw(`/v1/sync/blobs/${hash}`, { method: 'PUT', body: bytes, headers: { 'Content-Type': type }, timeout: 300_000 }));
    } else {
      const parts = syncBlobParts(bytes.byteLength);
      for (let part = 0; part < parts; part++) {
        const chunk = toBase64(bytes.subarray(part * PART_BYTES, Math.min(bytes.byteLength, (part + 1) * PART_BYTES)));
        await check(await this.api.raw(`/v1/sync/blobs/${hash}?part=${part}&parts=${parts}&size=${bytes.byteLength}`,
          { method: 'PUT', body: chunk, headers: { 'Content-Type': 'text/plain', 'X-Blob-Type': type }, timeout: 120_000 }));
      }
    }
    this.known.set(hash, { mime: type, size: bytes.byteLength, parts: this.store === 'r2' ? 0 : syncBlobParts(bytes.byteLength) });
  }

  async download(hash: string): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
    let info = this.known.get(hash);
    if (!info) {
      await this.missing([hash]);
      info = this.known.get(hash);
    }
    if (!info) throw new Error('云端没有这个文件（另一台设备可能还没传完）');
    let bytes: Uint8Array<ArrayBuffer>;
    if (info.parts === 0) {
      const res = await this.api.raw(`/v1/sync/blobs/${hash}`, { timeout: 300_000 });
      if (!res.ok) throw new Error(`下载文件失败 HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else {
      bytes = new Uint8Array(info.size);
      let offset = 0;
      for (let part = 0; part < info.parts; part++) {
        const res = await this.api.raw(`/v1/sync/blobs/${hash}?part=${part}`, { timeout: 120_000 });
        if (!res.ok) throw new Error(`下载文件失败 HTTP ${res.status}`);
        const chunk = fromBase64(await res.text());
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      if (offset !== info.size) throw new Error('下载的文件大小不对');
    }
    if (await sha256(bytes) !== hash) throw new Error('下载的文件和记录对不上（哈希不一致）');
    return { bytes, mime: info.mime };
  }
}

/** 把记录里的二进制换成引用（先把云端没有的传上去） */
export async function encodeBinary(value: unknown, client: BlobClient): Promise<unknown> {
  const found: { bytes: Uint8Array<ArrayBuffer>; hash: string; mime: string }[] = [];
  async function walk(v: unknown, depth: number): Promise<unknown> {
    if (isBinary(v)) {
      const bytes = await bytesOf(v);
      const hash = await sha256(bytes);
      const mime = typeof Blob !== 'undefined' && v instanceof Blob ? v.type : '';
      found.push({ bytes, hash, mime });
      const type: BinRef['type'] = v instanceof ArrayBuffer ? 'ArrayBuffer' : ArrayBuffer.isView(v) ? 'Uint8Array' : 'Blob';
      return { [SYNC_BIN_REF]: hash, type, ...(mime ? { mime } : {}), size: bytes.byteLength } satisfies BinRef;
    }
    if (!v || typeof v !== 'object' || depth > 40) return v;
    if (Array.isArray(v)) return Promise.all(v.map((x) => walk(x, depth + 1)));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await walk(x, depth + 1);
    return out;
  }
  const encoded = await walk(value, 0);
  const missing = await client.missing(found.map((f) => f.hash));
  for (const f of found) if (missing.has(f.hash)) await client.upload(f.hash, f.bytes, f.mime);
  return encoded;
}

/** 把引用换回二进制（下载） */
export async function decodeBinary(value: unknown, client: BlobClient): Promise<unknown> {
  async function walk(v: unknown, depth: number): Promise<unknown> {
    if (isBinRef(v)) {
      const { bytes, mime } = await client.download(v.$bin);
      if (v.type === 'ArrayBuffer') return bytes.buffer;
      if (v.type === 'Uint8Array') return bytes;
      return new Blob([bytes], { type: v.mime ?? mime });
    }
    if (!v || typeof v !== 'object' || depth > 40) return v;
    if (Array.isArray(v)) return Promise.all(v.map((x) => walk(x, depth + 1)));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = await walk(x, depth + 1);
    return out;
  }
  return walk(value, 0);
}

async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

/** 太大的记录：JSON 压缩后存成一个大文件 */
export async function packJson(json: string, client: BlobClient): Promise<BlobRef> {
  const raw = new TextEncoder().encode(json);
  const gzip = typeof CompressionStream !== 'undefined';
  const bytes = gzip ? await pipe(raw, new CompressionStream('gzip')) : raw;
  const hash = await sha256(bytes);
  if ((await client.missing([hash])).has(hash)) await client.upload(hash, bytes, gzip ? 'application/gzip' : 'application/json');
  return { [SYNC_BLOB_REF]: hash, size: raw.byteLength, ...(gzip ? { gzip: true } : {}) } as BlobRef;
}

export async function unpackJson(ref: BlobRef, client: BlobClient): Promise<unknown> {
  const { bytes } = await client.download(ref.$blob);
  if (ref.gzip && typeof DecompressionStream === 'undefined') throw new Error('这个浏览器解不开压缩过的同步记录，请更新浏览器');
  const raw = ref.gzip ? await pipe(bytes, new DecompressionStream('gzip')) : bytes;
  return JSON.parse(new TextDecoder().decode(raw));
}
