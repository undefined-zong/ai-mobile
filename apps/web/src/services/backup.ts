import { STORE_NAMES, beginRestore, flushAll, getKeys, getMany, msgKey, restoreRows, type StoreName } from '@/db/idb';
import { forgetSyncForRestore } from '@/services/sync';

/**
 * 整机备份：把本机 IndexedDB 的所有表（角色卡、预设、世界书、聊天、记忆、各项设置、API 与 Key……）
 * 和 localStorage 打成一个文件，换设备时整份导入。
 *
 * 文件是 JSON Lines：第一行是文件头，之后每行一条记录，读的时候按字节流式解析（见 readLines），
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

type Bin = Blob | Uint8Array;
/** 导出时二进制先在 JSON 里占位（d 的值），写文件时再在这个位置一段段写 base64 */
const HOLE = `@@bin-${Math.random().toString(36).slice(2)}-`;
const hole = (bins: Bin[], b: Bin) => `${HOLE}${bins.push(b) - 1}`;

/** 把 IndexedDB 里的值变成能 JSON 化的样子；二进制收进 bins，留占位符（d 必须是对象的最后一个键，导入时按这个顺序找） */
function encode(v: unknown, bins: Bin[]): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => encode(x, bins));
  if (v instanceof Blob) {
    const o: Record<string, unknown> = { $$t: 'blob', type: v.type };
    if (v instanceof File) { o.name = v.name; o.lastModified = v.lastModified; }
    o.d = hole(bins, v);
    return o;
  }
  if (v instanceof ArrayBuffer) return { $$t: 'buf', d: hole(bins, new Uint8Array(v)) };
  if (ArrayBuffer.isView(v)) {
    const name = v.constructor.name in VIEWS ? v.constructor.name : 'Uint8Array';
    return { $$t: 'view', c: name, d: hole(bins, new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
  }
  if (v instanceof Date) return { $$t: 'date', ms: v.getTime() };
  if (v instanceof Map) return { $$t: 'map', d: [...v].map((e) => encode(e, bins)) };
  if (v instanceof Set) return { $$t: 'set', d: [...v].map((e) => encode(e, bins)) };
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = encode(x, bins);
  return out;
}

/** 大的 base64 在读文件时已经解出来了（见 readLines），行里的 d 是占位符 "\u0000序号" */
function binary(d: unknown, bins: unknown[]): unknown {
  return typeof d === 'string' && d.charCodeAt(0) === 0 ? bins[Number(d.slice(1))] : undefined;
}
function bytesOf(d: unknown, bins: unknown[]): Uint8Array<ArrayBuffer> {
  const b = binary(d, bins);
  return b instanceof Uint8Array ? (b as Uint8Array<ArrayBuffer>) : fromBase64(String(d ?? ''));
}

function decode(v: unknown, bins: unknown[] = []): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decode(x, bins));
  const o = v as Record<string, unknown>;
  switch (o.$$t) {
    case 'buf': return bytesOf(o.d, bins).buffer;
    case 'view': {
      const bytes = bytesOf(o.d, bins);
      const C = VIEWS[o.c as ViewName] ?? Uint8Array;
      return C === DataView ? new DataView(bytes.buffer) : new (C as typeof Uint8Array)(bytes.buffer);
    }
    case 'blob': {
      const b = binary(o.d, bins);
      const body = b instanceof Blob ? b : bytesOf(o.d, bins);
      const type = String(o.type ?? '');
      return typeof o.name === 'string'
        ? new File([body], o.name, { type, lastModified: Number(o.lastModified) || Date.now() })
        : new Blob([body], { type });
    }
    case 'date': return new Date(Number(o.ms));
    case 'map': return new Map((o.d as unknown[]).map((x) => decode(x, bins)) as [unknown, unknown][]);
    case 'set': return new Set((o.d as unknown[]).map((x) => decode(x, bins)));
  }
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(o)) out[k] = decode(x, bins);
  return out;
}

// —— 导出 ——
// 以前整张表读出来、每个文件整段 arrayBuffer → base64 → 整行 JSON.stringify，最后所有行的字符串一起拼 Blob：
// 带 Live2D（一个模型几百 MB）时同一时刻页面里有好几份完整数据，iOS 直接把页面杀掉（闪退）。
// 现在一条条读，二进制每次切 3 MB 转 base64，写出的字符串攒到几 MB 就收进 Blob（交给浏览器存，不留在页面内存里）。

/** 每次转 base64 的字节数：3 的倍数，分段转出来拼起来和整段转的一样 */
const SLICE = 3 << 20;
/** 导出的字符串攒到这么长就收进 Blob */
const SPILL = 4 << 20;

class Sink {
  private parts: string[] = [];
  private held = 0;
  private blobs: Blob[] = [];
  push(s: string) {
    this.parts.push(s);
    this.held += s.length;
    if (this.held >= SPILL) this.spill();
  }
  private spill() {
    if (!this.parts.length) return;
    this.blobs.push(new Blob(this.parts));
    this.parts = [];
    this.held = 0;
  }
  end(): Blob[] {
    this.spill();
    return this.blobs;
  }
}

async function writeBase64(sink: Sink, bin: Bin) {
  const size = bin instanceof Blob ? bin.size : bin.length;
  for (let i = 0; i < size; i += SLICE) {
    const bytes = bin instanceof Blob ? new Uint8Array(await bin.slice(i, i + SLICE).arrayBuffer()) : bin.subarray(i, i + SLICE);
    sink.push(toBase64(bytes));
  }
}

/** 写一行：占位符的地方换成流式写出的 base64 */
async function writeRow(sink: Sink, row: Row, bins: Bin[]) {
  const json = JSON.stringify(row);
  let at = 0;
  if (bins.length) {
    for (const m of json.matchAll(new RegExp(`"${HOLE}(\\d+)"`, 'g'))) {
      sink.push(json.slice(at, m.index));
      sink.push('"');
      await writeBase64(sink, bins[Number(m[1])]!);
      sink.push('"');
      at = m.index + m[0].length;
    }
  }
  sink.push(`${json.slice(at)}\n`);
}

/** 一批批读表（素材表一次一条：值可能是几百 MB 的模型，不一次全读进内存） */
async function* storeRows(s: StoreName): AsyncGenerator<{ key: string; value: unknown }> {
  const keys = await getKeys(s);
  const step = MEDIA_STORES.includes(s) || s === 'books' ? 1 : 200;
  for (let i = 0; i < keys.length; i += step) {
    const part = keys.slice(i, i + step);
    const values = await getMany<unknown>(s, part);
    for (let j = 0; j < part.length; j++) if (values[j] !== undefined) yield { key: part[j]!, value: values[j] };
  }
}

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
  const sink = new Sink();
  const counts: Partial<Record<StoreName, number>> = {};
  for (const s of stores) {
    progress?.(`正在读取 ${s}…`);
    let n = 0;
    for await (const { key, value } of storeRows(s)) {
      if (s === 'secrets' && DEVICE_SECRETS.has(key)) continue;
      const bins: Bin[] = [];
      const v = encode(value, bins);
      await writeRow(sink, { s, k: key, v }, bins);
      n++;
      if (bins.length) progress?.(`正在读取 ${s}（${n}）…`);
    }
    counts[s] = n;
  }
  const ls = localEntries();
  for (const [k, v] of ls) sink.push(`${JSON.stringify({ ls: k, v } satisfies Row)}\n`);
  const header: BackupHeader = { format: FORMAT, version: VERSION, exportedAt: Date.now(), stores, counts, localStorage: ls.length };
  return { blob: new Blob([`${JSON.stringify(header)}\n`, ...sink.end()], { type: 'application/x-ndjson' }), header };
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

// 一行也可能很大：一个 Live2D 模型的所有贴图在同一条记录里，几十到几百 MB。整行拼成字符串再 JSON.parse 的话，
// 行字符串、解析出的 base64、解码后的字节同时在内存里，iOS 上页面直接被系统杀掉（Safari「重复出现问题」）。
// 所以按字节读：{"$$t":…, "d":"<base64>"} 里的 d 超过 BIG 就不进字符串，边读边解码（blob 每攒几 MB 收进 Blob，
// 数据交给浏览器存，不留在页面内存里），行里只留占位符，剩下的小 JSON 再 JSON.parse。

const CHUNK = 4 << 20;
/** base64 超过这么长就边读边解码 */
const BIG = 256 << 10;
/** blob 解出来的字节攒到这么多就收进 Blob */
const FOLD = 8 << 20;
const ENC = new TextEncoder();
const ASCII = new TextDecoder();
const TAG = ENC.encode('{"$$t":"');
const KEY = ENC.encode('"d":"');
const B64 = new Uint8Array(256);
for (const c of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=') B64[c.charCodeAt(0)] = 1;

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** 一个大 base64 值：一段段喂进来，按 4 个字符对齐解码 */
class Binary {
  private carry: Uint8Array = new Uint8Array(0);
  private parts: Uint8Array<ArrayBuffer>[] = [];
  private blobs: Blob[] = [];
  private held = 0;
  constructor(private readonly blob: boolean, private readonly keep: boolean) {}
  feed(ascii: Uint8Array) {
    if (!this.keep || !ascii.length) return;
    const all = this.carry.length ? concat([this.carry, ascii]) : ascii;
    const n = all.length - (all.length % 4);
    this.carry = all.slice(n);
    if (n) this.push(fromBase64(ASCII.decode(all.subarray(0, n))));
  }
  private push(bytes: Uint8Array<ArrayBuffer>) {
    this.parts.push(bytes);
    this.held += bytes.length;
    if (this.blob && this.held >= FOLD) { this.blobs.push(new Blob(this.parts)); this.parts = []; this.held = 0; }
  }
  end(): Blob | Uint8Array<ArrayBuffer> | null {
    if (!this.keep) return null;
    if (this.carry.length) this.push(fromBase64(ASCII.decode(this.carry)));
    return this.blob ? new Blob([...this.blobs, ...this.parts]) : concat(this.parts);
  }
}

interface Line {
  /** 去掉大 base64 后的 JSON */
  text: string;
  /** 占位符 "\u0000序号" 对应的数据（keep 为 false 时是 null） */
  bins: unknown[];
  /** 这一行在文件里的字节数 */
  size: number;
}

/** 按块读文件、按行给出。keep 为 false（第一遍检查）时大的 base64 只看字符、不解码 */
async function* readLines(file: File, keep: boolean): AsyncGenerator<Line> {
  const utf8 = new TextDecoder();
  let text: Uint8Array[] = [];
  let bins: unknown[] = [];
  let start = 0;
  let tagM = 0;
  let keyM = 0;
  /** 在 {"$$t":"… 对象里（之后没再遇到 { 或 }） */
  let tagged = false;
  /** 刚匹配完 TAG：1 等类型的第一个字母，2 等第二个 */
  let kind = 0;
  let firstLetter = 0;
  let isBlob = false;
  /** 正在读 d 的值，还不知道多长 */
  let val: Uint8Array[] | null = null;
  let valLen = 0;
  /** d 的值超过 BIG：边读边解码 */
  let bin: Binary | null = null;
  const finish = (end: number): Line => {
    const out = { text: utf8.decode(text.length === 1 ? text[0] : concat(text)), bins, size: end - start };
    text = []; bins = []; start = end + 1;
    tagM = keyM = kind = 0; tagged = false;
    return out;
  };

  for (let pos = 0; pos < file.size; pos += CHUNK) {
    const buf = new Uint8Array(await file.slice(pos, pos + CHUNK).arrayBuffer());
    let i = 0;
    /** buf 里从 seg 起的字节还没收进 text */
    let seg = 0;
    while (i < buf.length) {
      if (val || bin) {
        let j = i;
        while (j < buf.length && B64[buf[j]!]) j++;
        const run = buf.subarray(i, j);
        if (!bin && valLen + run.length >= BIG) {
          bin = new Binary(isBlob, keep);
          for (const p of val!) bin.feed(p);
          val = null;
        }
        if (j === buf.length) {
          if (bin) bin.feed(run);
          else { val!.push(run.slice()); valLen += run.length; }
          i = seg = j;
          break;
        }
        if (bin) {
          if (buf[j] !== 34) throw new Error('备份文件损坏（二进制数据不完整），请重新导出或重新下载');
          bin.feed(run);
          bins.push(bin.end());
          text.push(ENC.encode(`\\u0000${bins.length - 1}`));
          bin = null;
          seg = j;
        } else {
          // 不长（或不是 base64）：照原样留在 JSON 里
          text.push(...val!);
          val = null;
        }
        valLen = 0;
        i = j;
        continue;
      }
      for (; i < buf.length; i++) {
        const b = buf[i]!;
        if (b === 10) {
          text.push(buf.subarray(seg, i));
          seg = i + 1;
          const line = finish(pos + i);
          if (line.text.trim()) yield line;
          continue;
        }
        if (kind === 1) { firstLetter = b; kind = 2; } else if (kind === 2) { isBlob = firstLetter === 98 && b === 108; kind = 0; }
        if (b === 123 || b === 125) tagged = false;
        tagM = b === TAG[tagM] ? tagM + 1 : b === TAG[0] ? 1 : 0;
        if (tagM === TAG.length) { tagM = 0; tagged = true; kind = 1; }
        keyM = b === KEY[keyM] ? keyM + 1 : b === KEY[0] ? 1 : 0;
        if (keyM === KEY.length) {
          keyM = 0;
          if (tagged) { i++; text.push(buf.slice(seg, i)); seg = i; val = []; valLen = 0; break; }
        }
      }
    }
    if (seg < buf.length) text.push(buf.slice(seg));
  }
  // 文件在值中间断了：原样留着，JSON.parse 会报损坏
  if (val) text.push(...val);
  const line = finish(file.size);
  if (line.text.trim()) yield line;
}

/** 第一遍：检查整个文件，返回文件头（不解码、不留数据） */
export async function inspectBackup(file: File): Promise<BackupHeader> {
  let header: BackupHeader | null = null;
  const seen: Partial<Record<string, number>> = {};
  let local = 0;
  let n = 0;
  for await (const line of readLines(file, false)) {
    n++;
    let row: unknown;
    try { row = JSON.parse(line.text); } catch { throw new Error(`备份文件第 ${n} 行损坏，可能没下载完整`); }
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
  for await (const line of readLines(file, true)) {
    if (first) { first = false; continue; }
    const r = JSON.parse(line.text) as Row;
    if ('ls' in r) { if (typeof r.v === 'string') local.push([r.ls, r.v]); continue; }
    if (!include.has(storeOf(r.s)) || (r.s === 'secrets' && DEVICE_SECRETS.has(String(r.k)))) continue;
    if ((r.s as string) === 'messages') {
      const list = decode(r.v, line.bins);
      if (Array.isArray(list)) for (const m of list as { id?: unknown }[]) if (m && typeof m.id === 'string') batch.push({ store: 'chatMessages', key: msgKey(String(r.k), m.id), value: m });
    } else batch.push({ store: r.s, key: String(r.k), value: decode(r.v, line.bins) });
    bytes += line.size;
    if (bytes > 4 << 20 || batch.length >= 300) await commit();
  }
  await commit();
  try {
    for (const [k, v] of local) localStorage.setItem(k, v);
  } catch {
    // localStorage 不可用：主题等少量本机偏好不恢复，不影响主数据
  }
}
