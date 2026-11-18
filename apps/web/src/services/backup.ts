import { STORE_NAMES, beginRestore, flushAll, getEntries, msgKey, restoreRows, type StoreName } from '@/db/idb';
import { forgetSyncForRestore } from '@/services/sync';

/**
 * 整机备份：把本机 IndexedDB 的所有表（角色卡、预设、世界书、聊天、记忆、各项设置、API 与 Key……）
 * 和 localStorage 打成一个文件，换设备时整份导入。
 *
 * 文件是 JSON Lines：第一行是文件头，之后每行一条记录，读的时候按行解析，
 * 不需要把几百 MB 的素材拼成一个大字符串。二进制（图片、语音、Live2D 模型）转成 base64。
 */

const FORMAT = 'ai-mobile-backup';
const VERSION = 1;

/** 体积大的素材表，可以选择不带 */
export const MEDIA_STORES: readonly StoreName[] = ['assets', 'live2d'];
/** 云端登录令牌绑定这台设备；新设备用备份里的密码重新连接一次即可 */
const DEVICE_SECRETS = new Set(['hub:token']);
/** 多设备同步的记账（每条记录同步到哪一版、还没推的）只对这台设备有效：不进备份，也不从备份里恢复 */
const LEDGER_STORES = new Set<string>(['syncState', 'syncOutbox']);

export interface BackupOptions {
  /** 带上生成的图片、语音、Live2D 模型 */
  media: boolean;
  /** 带上 API Key 等密钥 */
  secrets: boolean;
}

export interface BackupHeader {
  format: typeof FORMAT;
  version: number;
  exportedAt: number;
  stores: StoreName[];
  counts: Partial<Record<StoreName, number>>;
  localStorage: number;
}

type Row = { s: StoreName; k: string; v: unknown } | { ls: string; v: string };

// —— 二进制 ⇄ base64 ——

function toBase64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (native) return native.call(bytes);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array<ArrayBuffer> }).fromBase64;
  if (native) return native(text);
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const VIEWS = {
  Uint8Array, Uint8ClampedArray, Int8Array, Uint16Array, Int16Array, Uint32Array, Int32Array, Float32Array, Float64Array, DataView,
} as const;
type ViewName = keyof typeof VIEWS;

/** 把 IndexedDB 里的值变成能 JSON 化的样子；Blob 要异步读，先占位，读完填进去 */
function encode(v: unknown, pending: Promise<void>[]): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => encode(x, pending));
  if (v instanceof Blob) {
    const o: Record<string, unknown> = { $$t: 'blob', type: v.type };
    if (v instanceof File) { o.name = v.name; o.lastModified = v.lastModified; }
    pending.push(v.arrayBuffer().then((b) => { o.d = toBase64(new Uint8Array(b)); }));
    return o;
  }
  if (v instanceof ArrayBuffer) return { $$t: 'buf', d: toBase64(new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor.name in VIEWS ? v.constructor.name : 'Uint8Array';
    return { $$t: 'view', c: name, d: toBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof Date) return { $$t: 'date', ms: v.getTime() };
  if (v instanceof Map) return { $$t: 'map', d: [...v].map((e) => encode(e, pending)) };
  if (v instanceof Set) return { $$t: 'set', d: [...v].map((e) => encode(e, pending)) };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = encode(x, pending);
  return out;
}

function decode(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(decode);
  const o = v as Record<string, unknown>;
  switch (o.$$t) {
    case 'buf': return fromBase64(String(o.d)).buffer;
    case 'view': {
      const bytes = fromBase64(String(o.d));
      const C = VIEWS[o.c as ViewName] ?? Uint8Array;
      return C === DataView ? new DataView(bytes.buffer) : new (C as typeof Uint8Array)(bytes.buffer);
    }
    case 'blob': {
      const bytes = fromBase64(String(o.d ?? ''));
      const type = String(o.type ?? '');
      return typeof o.name === 'string'
        ? new File([bytes], o.name, { type, lastModified: Number(o.lastModified) || Date.now() })
        : new Blob([bytes], { type });
    }
    case 'date': return new Date(Number(o.ms));
    case 'map': return new Map((o.d as unknown[]).map(decode) as [unknown, unknown][]);
    case 'set': return new Set((o.d as unknown[]).map(decode));
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decode(x);
  return out;
}

// —— 导出 ——

function localEntries(): [string, string][] {
  try {
    const out: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      const v = k === null ? null : localStorage.getItem(k);
      if (k !== null && v !== null) out.push([k, v]);
    }
    return out;
  } catch {
    return [];
  }
}

export async function exportBackup(opts: BackupOptions, progress?: (text: string) => void): Promise<{ blob: Blob; header: BackupHeader }> {
  await flushAll();
  const stores = STORE_NAMES.filter((s) => !LEDGER_STORES.has(s) && (opts.media || !MEDIA_STORES.includes(s)) && (opts.secrets || s !== 'secrets'));
  const parts: string[] = [];
  const counts: Partial<Record<StoreName, number>> = {};
  for (const s of stores) {
    progress?.(`正在读取 ${s}…`);
    const rows = await getEntries<unknown>(s);
    let n = 0;
    for (const { key, value } of rows) {
      if (s === 'secrets' && DEVICE_SECRETS.has(key)) continue;
      const pending: Promise<void>[] = [];
      const v = encode(value, pending);
      if (pending.length) await Promise.all(pending);
      parts.push(`${JSON.stringify({ s, k: key, v } satisfies Row)}\n`);
      n++;
    }
    counts[s] = n;
  }
  const ls = localEntries();
  for (const [k, v] of ls) parts.push(`${JSON.stringify({ ls: k, v } satisfies Row)}\n`);
  const header: BackupHeader = { format: FORMAT, version: VERSION, exportedAt: Date.now(), stores, counts, localStorage: ls.length };
  parts.unshift(`${JSON.stringify(header)}\n`);
  return { blob: new Blob(parts, { type: 'application/x-ndjson' }), header };
}

export function downloadBlob(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

// —— 导入 ——
// 分两遍读文件：第一遍只检查（每行都能解析、条数和文件头一致，防止下载不完整的文件把本机清空），
// 第二遍边读边分批写。整份解码后一次写入时，带图片语音和 Live2D 的备份会把手机内存撑爆、页面被系统杀掉。

/** 按块读文件、按行给出（大文件也不会拼成一个超长字符串） */
async function* lines(file: File): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  const CHUNK = 4 << 20;
  let rest = '';
  for (let pos = 0; pos < file.size; pos += CHUNK) {
    rest += decoder.decode(await file.slice(pos, pos + CHUNK).arrayBuffer(), { stream: true });
    const cut = rest.lastIndexOf('\n');
    if (cut < 0) continue;
    const done = rest.slice(0, cut);
    rest = rest.slice(cut + 1);
    for (const line of done.split('\n')) if (line.trim()) yield line;
  }
  rest += decoder.decode();
  if (rest.trim()) yield rest;
}

/** 第一遍：检查整个文件，返回文件头（不解码、不留数据） */
export async function inspectBackup(file: File): Promise<BackupHeader> {
  let header: BackupHeader | null = null;
  const seen: Partial<Record<string, number>> = {};
  let local = 0;
  let n = 0;
  for await (const line of lines(file)) {
    n++;
    let row: unknown;
    try { row = JSON.parse(line); } catch { throw new Error(`备份文件第 ${n} 行损坏，可能没下载完整`); }
    if (!header) {
      const h = row as Partial<BackupHeader>;
      if (h?.format !== FORMAT) throw new Error('这不是本 App 导出的备份文件');
      if (Number(h.version) > VERSION) throw new Error('备份来自更新版本的 App，请先更新这台设备');
      header = h as BackupHeader;
      continue;
    }
    const r = row as Row;
    if ('ls' in r) local++;
    else seen[r.s] = (seen[r.s] ?? 0) + 1;
  }
  if (!header) throw new Error('备份文件是空的');
  const short = header.stores.some((s) => (seen[s] ?? 0) !== (header.counts[s] ?? 0)) || local !== header.localStorage;
  if (short) throw new Error('备份文件不完整（条数和导出时不一致），请重新导出或重新下载');
  return header;
}

/**
 * 第二遍：覆盖本机。备份里带了的表整表替换，没带的表（比如没带素材、没带 Key）保持不动。
 * 开始写入后自动保存就停了，无论成功失败，之后都要重新加载页面。
 */
export async function restoreBackup(file: File, header: BackupHeader, progress?: (done: number, total: number) => void): Promise<void> {
  const known = new Set<string>(STORE_NAMES);
  // 旧备份的聊天消息在 messages 表（一个聊天一个数组）：恢复成一条消息一行
  const storeOf = (s: string) => (s === 'messages' ? 'chatMessages' : s);
  const stores = [...new Set(header.stores.map(storeOf))].filter((s) => known.has(s) && !LEDGER_STORES.has(s)) as StoreName[];
  const include = new Set<string>(stores);
  const total = header.stores.filter((s) => include.has(storeOf(s))).reduce((sum, s) => sum + (header.counts[s] ?? 0), 0);
  // 云端登录令牌不在备份里；设置被备份覆盖后，这台设备原来的令牌和新设置对不上，一起清掉，到「云端与同步」重新连接一次
  const drop: [StoreName, string][] = include.has('settings') ? [...DEVICE_SECRETS].map((k) => ['secrets', k]) : [];
  // 开着多设备同步：本机的同步记账作废，下次同步时导入的数据和云端合并，同一处以导入的为准（再推给别的设备）
  await forgetSyncForRestore();
  await beginRestore(stores, drop);

  const local: [string, string][] = [];
  let batch: { store: StoreName; key: string; value: unknown }[] = [];
  let bytes = 0;
  let done = 0;
  let first = true;
  const commit = async () => {
    await restoreRows(batch);
    done += batch.length;
    progress?.(done, total);
    batch = [];
    bytes = 0;
  };
  for await (const line of lines(file)) {
    if (first) { first = false; continue; }
    const r = JSON.parse(line) as Row;
    if ('ls' in r) { if (typeof r.v === 'string') local.push([r.ls, r.v]); continue; }
    if (!include.has(storeOf(r.s)) || (r.s === 'secrets' && DEVICE_SECRETS.has(String(r.k)))) continue;
    if ((r.s as string) === 'messages') {
      const list = decode(r.v);
      if (Array.isArray(list)) for (const m of list as { id?: unknown }[]) if (m && typeof m.id === 'string') batch.push({ store: 'chatMessages', key: msgKey(String(r.k), m.id), value: m });
    } else batch.push({ store: r.s, key: String(r.k), value: decode(r.v) });
    bytes += line.length;
    if (bytes > 4 << 20 || batch.length >= 300) await commit();
  }
  await commit();
  try {
    for (const [k, v] of local) localStorage.setItem(k, v);
  } catch {
    // localStorage 不可用：主题等少量本机偏好不恢复，不影响主数据
  }
}
