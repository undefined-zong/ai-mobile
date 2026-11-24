import { SYNC_PUSH_MAX_BYTES, SYNC_PUSH_MAX_RECORDS, type SyncPullResult, type SyncPushRecord, type SyncPushResult, type SyncRecord } from '@app/shared';
import { reactive } from 'vue';
import {
  applyRemote, clearStore, databaseState, flushAll, getAll, getChatMessages, getEntries, getKeys, getMany, getOne, hasKeys, msgKey, outboxKey, removeOutbox, setSyncHooks, splitMsgKey, STORES, write,
  type OutboxEntry, type RemoteChange, type StoreName,
} from '@/db/idb';
import { BlobClient, BlobSkipped, decodeBinary, encodeBinary, hasBinary, hasBinRef, isBinRef, isBlobRef, packJson, unpackJson, type SyncApi } from './blobs';
import { canonical, hashText, mergeValue } from './merge';

/**
 * 多设备同步（设计文档 §12）：连着同一个 Worker 的设备有同一份数据。
 *
 * 本机写库时（db/idb 的 write）在同一个事务里把改了的记录记进发件箱；这里定时（改动后几秒、每 20 秒、回到前台）：
 * 1. 拉：按 seq 增量拉别的设备推上来的记录，写进本机库，交给内存里的 store（界面马上变）。
 *    这条本机也改了、还没推：有底稿时三方合并（对象按键、带 id 的列表按 id），没底稿时以云端为准；
 * 2. 推：发件箱里的记录和上次同步的样子比，变了的推上去（带上见过的 seq；云端被别的设备改过就退回来，合并后再推）。
 *
 * - 聊天消息按条存、按条同步（本机 chatMessages 表一条一行，线上 kind 'message'，parent 是聊天 id）：长聊天加一条只比、只传这一条；
 * - 新设备第一次同步时每个聊天只拉最近 RECENT 条，更早的在聊天里往上翻时再从云端取（loadOlder）；
 * - 图片、语音、Live2D 模型、书的原文件按 SHA-256 存进同步用的大文件：拉到记录时先不下载，用到时再取；
 * - 第一次连上一个 Worker：先把云端有的全拉下来（同一条以云端为准），再把这台设备独有的推上去；空设备不会清掉云端；
 * - 不同步：Key（secrets 表）、云端连接本身（settings 的 hub）、这台设备此刻的状态（正开着的场景、角色此刻的位置）；
 * - 回复生成中不同步（生成完再同步）。
 */

const DELETED = '-';
const META = '@meta';
/** 只在这台设备上的表 */
// requestLog：请求记录只在这台设备上看，不同步
const LOCAL_STORES = new Set<string>(['secrets', 'syncState', 'syncOutbox', 'requestLog']);
/**
 * settings 表里只在这台设备上的：云端连接（地址、各种游标）、正在进行的授权、早就迁移掉的旧格式，
 * 图片缓存留几天和每张图上次用到是哪天（每台设备各自的）
 */
const LOCAL_SETTINGS = new Set(['hub', 'mcp-oauth-pending', 'connections', 'routes', 'apiSlots', 'assetCache', 'assetUsed']);
/** settings 表里只在打开 App 时读一次的（迁移、放进来过的标记）：别的设备改了不用重新打开 */
const STARTUP_SETTINGS = new Set(['envWeatherV2', 'memorySeeded', 'seededPresetFiles', 'presetUpgrades', 'seededLorebookFiles', 'lorebookUpgrades', 'seededSoupFiles',
  'proactiveBudgetCleared', 'summaryBudgetCleared', 'memoryConsolidatedAt']);
/**
 * 只是这台设备此刻的状态：只改了它们不推；收到别的设备的版本时保留本机的
 * （聊天：正开着的场景、在哪、怎么在一起；角色：按作息每分钟算的此刻在哪、在做什么）
 */
const SOFT: Partial<Record<StoreName, { fields: string[]; reset?: Record<string, unknown> }>> = {
  chats: { fields: ['currentScene', 'togetherAt', 'togetherMode'], reset: { currentScene: null, togetherAt: null, togetherMode: null } },
  characters: { fields: ['locationId', 'status'] },
};
/** 一条记录的 JSON 超过这些 UTF-8 字节就存成大文件；底稿仍按本机字符串长度保留（合并用） */
const PACK_BYTES = 900_000;
const BASE_CHARS = 200_000;
const encoder = new TextEncoder();
const PUSH_ENVELOPE_BYTES = encoder.encode('{"records":[]}').byteLength;
/** 新设备第一次同步时每个聊天先拉最近几条（更早的用到时再取） */
const RECENT = 500;
const OLDER_PAGE = 200;

interface RecordState {
  /** 上次同步到的 seq */
  s: number;
  /** 那一版的指纹（去掉只在本机的字段）；DELETED 表示删了 */
  h: string;
  /** 那一版的 JSON（底稿，合并用；太大的不留） */
  b?: string;
  /** 大文件的记录（图片、模型……）：还没下载时留着引用，用到时再取 */
  lazy?: unknown;
}
/** 旧版（v10 之前）一个聊天里每条消息上次同步到的 [指纹, seq]：打开时迁成每条消息一行 */
interface ChatState { m: Record<string, [string, number]> }
/** 云端还有更早的消息没拉的聊天：从哪往前取（createdAt, seq） */
type Older = Record<string, [number, number]>;
/**
 * restored：刚从备份恢复过（本机的数据整个换了，记账作废）：下次同步时本机的每一条都当成改动，
 * 和云端同一条按字段合并、同一处以本机（导入的）为准
 */
interface Meta {
  hub: string; cursor: number; joined: boolean; enabled: boolean; parked?: number; restored?: boolean;
  /** 第一次同步只拉最近的：拉到 head 之前，每个聊天 createdAt 不超过 at[聊天] 的消息先不拉 */
  cut?: { head: number; at: Record<string, number> };
  older?: Older;
}

const stateKey = (store: string, key: string) => `r\u0000${store}\u0000${key}`;
/** 本机的表和键 → 线上的 kind / parent / id（聊天消息是 'message'，parent 是聊天 id） */
function wire(store: StoreName, key: string): { kind: string; parent: string; id: string } {
  const m = store === 'chatMessages' ? splitMsgKey(key) : null;
  return m ? { kind: 'message', parent: m[0], id: m[1] } : { kind: store, parent: '', id: key };
}
const parkKey = (r: SyncRecord) => `p\u0000${r.kind}\u0000${r.parent}\u0000${r.id}`;

/** 界面上显示的同步状态 */
export const syncState = reactive({
  /** 这台设备开着多设备同步 */
  enabled: true,
  /** 连着的 Worker 支持同步 */
  supported: false,
  /** 和这个 Worker 同步过（第一次的全量对齐做完了） */
  joined: false,
  running: false,
  phase: '' as '' | 'pull' | 'push' | 'scan',
  /** 发件箱里还有几条没推 */
  pending: 0,
  /** 拉到哪了 / 云端一共到哪了（第一次同步显示进度） */
  cursor: 0,
  head: 0,
  lastAt: null as number | null,
  error: '',
  /** 大文件没传上去的原因（云端空间满了、文件太大） */
  blobNote: '',
  /** 别的设备改了只在打开 App 时读的东西：重新打开才显示 */
  needsReload: false,
  /** 云端还有更早消息没拉下来的聊天 */
  older: {} as Record<string, true>,
  /**
   * 本机没有的图片、语音可以再去云端取一次了（每次加一）：别的设备的文件传上来了、刚连上云端、上次没取成的到了重试的时候。
   * 显示不出来的图（components 里的 AssetImg、GenImage）看着它，变了就再取一次，不用重新打开页面
   */
  arrivals: 0,
});

let api: SyncApi | null = null;
let blobs: BlobClient | null = null;
let hubUrl = '';
let meta: Meta = { hub: '', cursor: 0, joined: false, enabled: true };
let metaLoaded: Promise<void> | null = null;
let tracking = false;
let running: Promise<void> | null = null;
let again = false;
let parkedChecked = false;
/** 生成回复中（不同步）、这一条现在不能推（这个聊天正在生成） */
let busy: () => boolean = () => false;
let held: (store: StoreName, key: string) => boolean = () => false;
/** 这次打开 App 以来传不上去的大文件记录（不每轮重试） */
const skipped = new Set<string>();
const isStore = (kind: string): kind is StoreName => (STORES as readonly string[]).includes(kind);

/** 这条记录要不要同步 */
export function isSynced(store: string, key: string): boolean {
  return isStore(store) && !LOCAL_STORES.has(store) && !(store === 'settings' && LOCAL_SETTINGS.has(key)) && !(store === 'chatMessages' && !splitMsgKey(key));
}

/** 大文件（拉到记录时不下载，用到时再取） */
function isLazy(store: string, key: string): boolean {
  return store === 'assets' || store === 'live2d' || (store === 'books' && key.startsWith('file:'));
}

/** 不在内存里的（用到时才读库的）：别的设备改了不用重新打开 */
function memoryless(store: StoreName, key: string): boolean {
  return isLazy(store, key) || (store === 'books' && key.includes(':')) || (store === 'settings' && STARTUP_SETTINGS.has(key));
}

function strip(store: StoreName, value: unknown): unknown {
  const soft = SOFT[store];
  if (!soft || !value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out = { ...(value as Record<string, unknown>) };
  for (const f of soft.fields) delete out[f];
  return out;
}

/** 别的设备的版本放进本机：只在本机的字段用本机的（本机没有这条时，聊天的场景状态清空） */
function keepSoft(store: StoreName, incoming: unknown, local: unknown): unknown {
  const soft = SOFT[store];
  if (!soft || !incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return incoming;
  const out = { ...(incoming as Record<string, unknown>) };
  const mine = local && typeof local === 'object' ? (local as Record<string, unknown>) : null;
  for (const f of soft.fields) {
    if (mine && f in mine) out[f] = mine[f];
    else if (soft.reset && f in soft.reset) out[f] = soft.reset[f];
  }
  return out;
}

const fingerprint = (store: StoreName, value: unknown) => hashText(canonical(strip(store, value)));

function loadMeta(): Promise<void> {
  return (metaLoaded ??= (async () => {
    const saved = await getOne<Meta>('syncState', META, { local: true });
    if (saved) meta = { ...meta, ...saved };
    await migrateLedger();
    Object.assign(syncState, { enabled: meta.enabled, joined: meta.joined && !!meta.hub, cursor: meta.cursor });
    showOlder();
  })().catch((e) => {
    metaLoaded = null;
    throw e;
  }));
}

function showOlder() {
  syncState.older = Object.fromEntries(Object.keys(meta.older ?? {}).map((k) => [k, true as const]));
}

/**
 * 旧版的账本（一个聊天一行、发件箱里一个聊天一条）迁成一条消息一行：
 * 发件箱里的聊天展开成它的每条消息（推的时候和账本比，没变的不推；账本里有、本机没了的推删除）
 */
async function migrateLedger() {
  const [stateKeys, outKeys] = await Promise.all([getKeys('syncState'), getKeys('syncOutbox')]);
  const chatStates = stateKeys.filter((k) => k.startsWith('c\u0000'));
  const oldOut = outKeys.filter((k) => k.startsWith('messages\u0000'));
  if (!chatStates.length && !oldOut.length) return;
  const states = await getMany<ChatState>('syncState', chatStates);
  const puts: { key: string; value: RecordState }[] = [];
  const known = new Map<string, string[]>();
  chatStates.forEach((k, i) => {
    const chatId = k.slice(2);
    const ids = Object.keys(states[i]?.m ?? {});
    for (const id of ids) {
      const [h, s] = states[i]!.m[id]!;
      puts.push({ key: stateKey('chatMessages', msgKey(chatId, id)), value: { s, h } });
    }
    known.set(chatId, ids);
  });
  const outbox: { key: string; value: OutboxEntry }[] = [];
  let n = 0;
  for (const e of await getMany<OutboxEntry>('syncOutbox', oldOut)) {
    if (!e) continue;
    const chatId = e.key;
    const keys = new Set([...(await getChatMessages<unknown>(chatId)).map((x) => x.key), ...(known.get(chatId) ?? []).map((id) => msgKey(chatId, id))]);
    for (const key of keys) outbox.push({ key: outboxKey('chatMessages', key), value: { store: 'chatMessages', key, at: e.at, n: ++n, ...(e.join ? { join: true } : {}) } });
  }
  for (let i = 0; i < puts.length; i += 500) await write('syncState', puts.slice(i, i + 500), [], { sync: true });
  for (let i = 0; i < outbox.length; i += 500) await write('syncOutbox', outbox.slice(i, i + 500), [], { sync: true });
  await write('syncState', [], chatStates, { sync: true });
  await write('syncOutbox', [], oldOut, { sync: true });
}

async function saveMeta() {
  syncState.cursor = meta.cursor;
  syncState.joined = meta.joined;
  showOlder();
  await write('syncState', [{ key: META, value: { ...meta } }], [], { sync: true });
}

function hooks() {
  // 首次对齐的扫描期间也要记账：assets 扫过以后才画好的图不能漏出发件箱。
  const on = tracking && meta.enabled;
  setSyncHooks({
    track: on ? isSynced : null,
    changed: on ? soon : undefined,
    miss: fetchMissing,
  });
  noteReachable();
}

/** 现在能不能从云端取大文件（fetchMissing 的条件） */
const canFetch = () => !!api && !!blobs && meta.enabled && !!meta.hub && meta.hub === hubUrl;
let reachable = false;
/** 刚能从云端取大文件（打开 App 后连上了 Worker、第一次对齐完）：之前取不到的图再取一次 */
function noteReachable() {
  const now = canFetch();
  if (now && !reachable) syncState.arrivals++;
  reachable = now;
}

// —— 对外 ——

/**
 * 打开 App、本机数据都读完以后调用：开始记录本机的改动（读库时的整理、补的默认值不算改动）。
 * busy：正在生成回复（这时不同步）；hold：这条记录现在不能推（这个聊天正在生成）
 */
export async function startSyncTracking(opts: { busy: () => boolean; hold: (store: StoreName, key: string) => boolean }) {
  busy = opts.busy;
  held = opts.hold;
  await loadMeta();
  tracking = true;
  hooks();
  // 旧版首次扫描期间生成的素材可能只有本机文件、没有同步账本和发件箱。
  // 每次启动只补这些漏记的素材；已同步过的只读键和账本，不重传图片。
  if (meta.enabled && meta.joined) await scanAll(false, ['assets']);
  void countPending();
}

/** 连上 / 换了 / 断开 Worker 时调用（api 为空 = 没连） */
export async function configureSync(opts: { api: SyncApi | null; hub: string; supported: boolean; blobStore?: 'r2' | 'd1' }) {
  await loadMeta();
  api = opts.api;
  hubUrl = opts.hub;
  syncState.supported = opts.supported;
  blobs = opts.api && opts.supported ? new BlobClient(opts.api, opts.blobStore ?? 'd1') : null;
  if (!blobs) syncState.blobNote = '';
  hooks();
}

/** 这台设备开 / 关多设备同步（关了以后改动不再记，再打开时把关着时的改动补上） */
export async function setSyncEnabled(on: boolean) {
  await loadMeta();
  if (meta.enabled === on) return;
  meta.enabled = on;
  syncState.enabled = on;
  // 关着的时候改的东西没记进发件箱：再打开时重新比一遍
  if (on) meta.joined = false;
  await saveMeta();
  hooks();
  if (on) void runSync().catch(() => undefined);
}

/**
 * 要从备份恢复了（之后整页重新加载）：这台设备的同步记账作废。恢复写库时不经过发件箱，
 * 下次同步时把导入的数据整个比一遍，和云端合并（同一处以导入的为准），再推给别的设备
 */
export async function forgetSyncForRestore() {
  await loadMeta();
  tracking = false;
  hooks();
  if (running) await running.catch(() => undefined);
  await Promise.all([clearStore('syncState'), clearStore('syncOutbox')]);
  meta = { hub: meta.hub, cursor: 0, joined: false, enabled: meta.enabled, restored: true };
  await saveMeta();
}

/** 从头和云端对齐：忘掉同步到哪了，全部重新拉（同一条以云端为准），再把这台设备独有的推上去 */
export async function resetSync() {
  await loadMeta();
  if (running) await running.catch(() => undefined);
  await clearSyncLedger(meta.hub);
  hooks();
  await runSync();
}

/** 同步一轮（同时只跑一轮；跑着时又叫了，跑完再来一轮） */
export function runSync(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await cycle();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

let timer: ReturnType<typeof setTimeout> | undefined;
let firstChangeAt = 0;
/** 本机改了东西：停下来 2.5 秒再同步（一直在改时最多等 15 秒） */
function soon() {
  void countPending();
  const now = Date.now();
  if (!timer) firstChangeAt = now;
  clearTimeout(timer);
  const wait = Math.max(0, Math.min(2500, firstChangeAt + 15_000 - now));
  timer = setTimeout(() => {
    timer = undefined;
    void runSync().catch(() => undefined);
  }, wait);
}

let counting: ReturnType<typeof setTimeout> | undefined;
async function countPending() {
  clearTimeout(counting);
  counting = setTimeout(async () => {
    try { syncState.pending = (await getKeys('syncOutbox')).length; } catch { /* 读不了就不显示 */ }
  }, 300);
}

// —— 一轮 ——

async function cycle() {
  await loadMeta();
  if (!api || !syncState.supported || !meta.enabled || !hubUrl || databaseState.status !== 'ready') return;
  if (busy()) return;
  syncState.running = true;
  syncState.error = '';
  try {
    if (meta.hub !== hubUrl) await clearSyncLedger(hubUrl);
    if (!meta.joined) {
      // 第一次（或关了又开）：本机的记录都记进发件箱再拉。第一次连上时，云端也有的同一条以云端为准（演示数据、自带的预设不会盖掉云端的）；
      // 关了又开时，关着时本机改的和云端改的按底稿合并
      syncState.phase = 'scan';
      if (meta.cursor === 0 && !meta.cut && !meta.restored) await planRecent();
      await scanAll(meta.cursor === 0 && !meta.restored);
      meta.joined = true;
      delete meta.restored;
      await saveMeta();
      hooks();
    }
    if (!(await pullAll())) return;
    if (!parkedChecked && meta.parked) await retryParked();
    parkedChecked = true;
    for (let round = 0; round < 3; round++) {
      if (busy()) break;
      if (!(await pushAll())) break;
    }
    syncState.lastAt = Date.now();
    retryMisses();
  } catch (e) {
    syncState.error = e instanceof Error ? e.message : String(e);
    throw e;
  } finally {
    syncState.running = false;
    syncState.phase = '';
    void countPending();
  }
}

/** 换了 Worker（或者要从头对齐）：同步的账本清掉，重新开始 */
async function clearSyncLedger(hub: string) {
  await Promise.all([clearStore('syncState'), clearStore('syncOutbox')]);
  // 刚从备份恢复过的，换了 Worker 也照样以导入的为准
  meta = { hub, cursor: 0, joined: false, enabled: meta.enabled, ...(meta.restored ? { restored: true } : {}) };
  skipped.clear();
  syncState.head = 0;
  syncState.needsReload = false;
  await saveMeta();
}

// —— 新设备只拉最近的，更早的用到时再取 ——

/** 第一次同步前问云端：每个聊天最近 RECENT 条之前从哪开始（旧版 Worker 没有这个接口就全拉） */
async function planRecent() {
  try {
    const { cut, head } = await api!.json<{ cut: Record<string, [number, number]>; head: number }>(`/v1/sync/recent?keep=${RECENT}`);
    if (!Object.keys(cut).length) return;
    meta.cut = { head, at: Object.fromEntries(Object.entries(cut).map(([k, v]) => [k, v[0]])) };
    // 往前取从 (createdAt, 无穷大) 开始：createdAt 不超过它的都还在云端
    meta.older = Object.fromEntries(Object.entries(cut).map(([k, v]) => [k, [v[0], Number.MAX_SAFE_INTEGER]]));
    await saveMeta();
  } catch {
    // 旧版 Worker：照旧全拉
  }
}

/** 这个聊天云端还有更早的消息：往前取一页，放进本机（返回取到几条） */
export async function loadOlder(chatId: string): Promise<number> {
  await loadMeta();
  const from = meta.older?.[chatId];
  if (!from || !api) return 0;
  if (running) await running.catch(() => undefined);
  const page = await api.json<{ records: SyncRecord[]; more: boolean }>(
    `/v1/sync/older?parent=${encodeURIComponent(chatId)}&at=${from[0]}&seq=${from[1]}&limit=${OLDER_PAGE}`, { timeout: 60_000 });
  if (page.records.length) await applyRecords(page.records);
  const last = page.records.at(-1) as (SyncRecord & { createdAt?: number }) | undefined;
  if (page.more && last && Number.isFinite(last.createdAt)) meta.older![chatId] = [last.createdAt!, last.seq];
  else delete meta.older![chatId];
  await saveMeta();
  return page.records.length;
}

// —— 拉 ——

/** 拉到最新；中途开始生成回复就停下（返回 false），下一轮接着拉 */
async function pullAll(): Promise<boolean> {
  syncState.phase = 'pull';
  for (;;) {
    if (meta.cut && meta.cursor >= meta.cut.head) delete meta.cut;
    const page = meta.cut
      ? await api!.json<SyncPullResult>('/v1/sync/pull', { method: 'POST', body: { since: meta.cursor, limit: 300, cut: meta.cut.at }, timeout: 60_000 })
      : await api!.json<SyncPullResult>(`/v1/sync/pull?since=${meta.cursor}&limit=300`, { timeout: 60_000 });
    syncState.head = page.head;
    if (page.records.length) await applyRecords(page.records);
    meta.cursor = Math.max(meta.cursor, page.next);
    await saveMeta();
    if (!page.more) return true;
    if (busy()) return false;
  }
}

/** 云端的记录放进本机（拉到的、推的时候被退回来的） */
async function applyRecords(records: SyncRecord[]) {
  // 本机内存里刚改、还没写进库的先写掉：这样它们在发件箱里，合并时不会被云端的盖掉
  await flushAll();
  const stores = new Map<StoreName, SyncRecord[]>();
  const park: SyncRecord[] = [];
  for (const r of records) {
    if (r.kind === 'message') {
      const list = stores.get('chatMessages') ?? [];
      list.push({ ...r, id: msgKey(r.parent, r.id) });
      stores.set('chatMessages', list);
    } else if (r.kind !== 'chatMessages' && isStore(r.kind)) {
      if (!isSynced(r.kind, r.id)) continue;
      const list = stores.get(r.kind) ?? [];
      list.push(r);
      stores.set(r.kind, list);
    } else park.push(r);
  }
  for (const [store, list] of stores) await applyStore(store, list);
  if (park.length) {
    // 新版 App 才有的数据：先收着，这台设备更新以后再放进去
    await write('syncState', park.map((r) => ({ key: parkKey(r), value: r })), [], { sync: true });
    meta.parked = (meta.parked ?? 0) + park.length;
  }
}

function newest(list: SyncRecord[]): SyncRecord[] {
  const out = new Map<string, SyncRecord>();
  for (const r of list) {
    const cur = out.get(r.id);
    if (!cur || r.seq > cur.seq) out.set(r.id, r);
  }
  return [...out.values()];
}

/** 整条记录存成了大文件的先取回来；记录里的二进制引用留着（大文件的表用到时再下载） */
async function expand(data: unknown): Promise<unknown> {
  return isBlobRef(data) ? unpackJson(data, blobs!) : data;
}

async function applyStore(store: StoreName, list: SyncRecord[]) {
  const recs = newest(list);
  const ids = recs.map((r) => r.id);
  // 先把要下载的（存成大文件的记录）都取回来，再读本机的：读和写之间不等网络，本机刚改的不会被盖掉
  const resolved = new Map<string, { encoded: unknown; remote: unknown }>();
  for (const r of recs) {
    if (r.deleted || isLazy(store, r.id)) continue;
    const encoded = await expand(r.data);
    resolved.set(r.id, { encoded, remote: hasBinRef(encoded) ? await decodeBinary(encoded, blobs!) : encoded });
  }
  // 大文件只问本机有没有（不把图片、模型都读进内存），别的读出来合并用
  const lazyIds = ids.filter((id) => isLazy(store, id));
  const eagerIds = ids.filter((id) => !isLazy(store, id));
  const [states, pend, have, values] = await Promise.all([
    getMany<RecordState>('syncState', ids.map((id) => stateKey(store, id))),
    getMany<OutboxEntry>('syncOutbox', ids.map((id) => outboxKey(store, id))),
    hasKeys(store, lazyIds),
    getMany<unknown>(store, eagerIds),
  ]);
  const exists = new Map(lazyIds.map((id, i) => [id, have[i]!]));
  const locals = new Map(eagerIds.map((id, i) => [id, values[i]]));
  const puts: { key: string; value: unknown }[] = [];
  const dels: string[] = [];
  const statePuts: { key: string; value: RecordState }[] = [];
  const settled: OutboxEntry[] = [];
  const changes: RemoteChange[] = [];
  /** 本机没有的大文件到了云端（另一台设备刚传上来的图） */
  let arrived = false;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    const st = states[i];
    if (st && st.s >= r.seq) continue;
    const pending = pend[i];
    if (isLazy(store, r.id)) {
      // 同一个键的大文件内容不变（素材按内容哈希、模型和书的文件按 id）：本机有就留着
      if (r.deleted) {
        if (exists.get(r.id)) {
          dels.push(r.id);
          changes.push({ key: r.id, deleted: true });
        }
        statePuts.push({ key: stateKey(store, r.id), value: { s: r.seq, h: DELETED } });
        if (pending) settled.push(pending);
      } else {
        statePuts.push({ key: stateKey(store, r.id), value: { s: r.seq, h: hashText(canonical(r.data)), ...(exists.get(r.id) ? {} : { lazy: r.data }) } });
        if (pending) settled.push(pending);
        if (!exists.get(r.id)) {
          // 之前去云端取过、那时还没有的（朋友圈先到、图后到）：不用等重试的时间，马上能取
          const id = missKey(store, r.id);
          notThere.delete(id);
          if (fetching.has(id)) landed.add(id);
          arrived = true;
        }
      }
      continue;
    }
    const local = locals.get(r.id);
    const { encoded, remote } = resolved.get(r.id) ?? { encoded: undefined, remote: undefined };
    const remoteHash = encoded === undefined ? DELETED : fingerprint(store, encoded);
    let final: unknown;
    if (!pending || (!st && pending.join)) {
      // 本机没改；或者是第一次连上时本机原有的、云端也有的同一条：以云端为准
      final = remote === undefined ? undefined : keepSoft(store, remote, local);
      if (pending) settled.push(pending);
    } else {
      // 两边都改了：有底稿按底稿合并；没有（两台设备各自第一次写同一条）按字段并起来，同一处以后改的为准
      const preferLocal = pending.at > r.updatedAt;
      const base = st?.b !== undefined ? (JSON.parse(st.b) as unknown) : undefined;
      if (remote === undefined) {
        // 云端删了：本机在上次同步之后改过就留着（改的比删的重要），没改就删
        final = local !== undefined && (base === undefined ? preferLocal || !st : fingerprint(store, base) !== fingerprint(store, local)) ? local : undefined;
      } else if (local === undefined) {
        // 本机删了、云端改了：留云端改的
        final = keepSoft(store, remote, undefined);
      } else {
        final = keepSoft(store, st && base === undefined ? (preferLocal ? local : remote) : mergeValue(base, local, remote, preferLocal), local);
      }
      if ((final === undefined ? DELETED : fingerprint(store, final)) === remoteHash) settled.push(pending);
    }
    if (final === undefined) {
      if (local !== undefined) {
        dels.push(r.id);
        changes.push({ key: r.id, deleted: true });
      }
    } else if (local === undefined || canonical(local) !== canonical(final)) {
      puts.push({ key: r.id, value: final });
      changes.push({ key: r.id, value: final, deleted: false });
    }
    const json = encoded === undefined ? '' : JSON.stringify(encoded);
    statePuts.push({ key: stateKey(store, r.id), value: { s: r.seq, h: remoteHash, ...(json && keepBase(store, json) && !hasBinRef(encoded) ? { b: json } : {}) } });
  }
  if (!(await write(store, puts, dels, { sync: true }))) throw new Error('同步的数据写不进本机存储');
  await write('syncState', statePuts, [], { sync: true });
  // 引用记下了再告诉界面：显示不出来的图这时再取就取得到
  if (arrived) syncState.arrivals++;
  if (settled.length) await removeOutbox(settled);
  if (changes.length) {
    const unhandled = applyRemote(store, changes).filter((key) => !memoryless(store, key));
    if (unhandled.length) syncState.needsReload = true;
  }
}

/** 留不留底稿（合并用）：消息不留（长聊天每条再存一份太占地方），同一条两边都改了时后改的为准 */
function keepBase(store: StoreName, json: string): boolean {
  return store !== 'chatMessages' && json.length <= BASE_CHARS;
}

/** 以前收着的新版数据：这台设备更新以后认得了就放进去 */
async function retryParked() {
  const keys = (await getKeys('syncState')).filter((k) => k.startsWith('p\u0000'));
  const records = (await getMany<SyncRecord>('syncState', keys)).filter((r): r is SyncRecord => !!r);
  const known = records.filter((r) => r.kind === 'message' || (r.kind !== 'chatMessages' && isStore(r.kind)));
  if (known.length) await applyRecords(known);
  const done = new Set(known.map((r) => parkKey(r)));
  await write('syncState', [], keys.filter((k) => done.has(k)), { sync: true });
  meta.parked = keys.length - done.size;
  await saveMeta();
}

// —— 第一次加入（或关了又开）：本机有、和上次同步不一样的都记进发件箱 ——

async function scanAll(join: boolean, stores: readonly StoreName[] = STORES) {
  const now = Date.now();
  let n = 0;
  const outbox: { key: string; value: OutboxEntry }[] = [];
  const add = (store: StoreName, key: string) => outbox.push({ key: outboxKey(store, key), value: { store, key, at: now, n: ++n, ...(join ? { join: true } : {}) } });
  for (const store of stores) {
    if (LOCAL_STORES.has(store)) continue;
    if (store === 'assets' || store === 'live2d' || store === 'books') {
      // 大文件只看键：同步过的不再比内容（同一个键内容不变）；书目和正文推的时候再比
      const keys = (await getKeys(store)).filter((k) => isSynced(store, k));
      const states = await getMany<RecordState>('syncState', keys.map((k) => stateKey(store, k)));
      keys.forEach((k, i) => {
        if (!states[i] || !isLazy(store, k)) add(store, k);
      });
    } else {
      const entries = (await getEntries<unknown>(store)).filter((e) => isSynced(store, e.key));
      const states = await getMany<RecordState>('syncState', entries.map((e) => stateKey(store, e.key)));
      entries.forEach((e, i) => {
        const st = states[i];
        if (!st || hasBinary(e.value) || st.h !== fingerprint(store, e.value)) add(store, e.key);
      });
    }
  }
  for (let i = 0; i < outbox.length; i += 500) await write('syncOutbox', outbox.slice(i, i + 500), [], { sync: true });
}

// —— 推 ——

interface Out {
  rec: SyncPushRecord;
  item: Item;
  applied(seq: number): void;
}
interface Item {
  entry: OutboxEntry;
  waiting: number;
  conflicted: boolean;
  finish(): Promise<void>;
}

/** 推发件箱。返回 true：有记录被退回来合并了，要再推一轮 */
async function pushAll(): Promise<boolean> {
  syncState.phase = 'push';
  const entries = (await getAll<OutboxEntry>('syncOutbox')).filter((e) => e && typeof e.key === 'string');
  // 文字先推，大文件（要先传文件）最后
  entries.sort((a, b) => Number(isLazy(a.store, a.key)) - Number(isLazy(b.store, b.key)) || a.at - b.at);
  let queue: Out[] = [];
  let bytes = PUSH_ENVELOPE_BYTES;
  let conflicts: SyncRecord[] = [];
  const open: Item[] = [];
  const drop: OutboxEntry[] = [];

  async function send() {
    if (!queue.length) return;
    const batch = queue;
    queue = [];
    bytes = PUSH_ENVELOPE_BYTES;
    const result = await api!.json<SyncPushResult>('/v1/sync/push', { method: 'POST', body: { records: batch.map((o) => o.rec) }, timeout: 60_000 });
    const applied = new Map(result.applied.map((a) => [`${a.kind}\n${a.parent}\n${a.id}`, a.seq]));
    for (const o of batch) {
      const seq = applied.get(`${o.rec.kind}\n${o.rec.parent}\n${o.rec.id}`);
      if (seq !== undefined) o.applied(seq);
      else o.item.conflicted = true;
      o.item.waiting--;
    }
    conflicts = conflicts.concat(result.conflicts);
    for (const item of open.filter((x) => x.waiting === 0)) {
      open.splice(open.indexOf(item), 1);
      await item.finish();
    }
  }

  let failure: unknown = null;
  let textDone = false;
  for (const entry of entries) {
    if (busy()) break;
    if (!isSynced(entry.store, entry.key)) {
      drop.push(entry);
      continue;
    }
    if (held(entry.store, entry.key) || skipped.has(outboxKey(entry.store, entry.key))) continue;
    // 文字都推上去了再传大文件：图片传不上去也不耽误聊天记录
    if (!textDone && isLazy(entry.store, entry.key)) {
      textDone = true;
      await send();
    }
    let outs: Omit<Out, 'item'>[] | null;
    let finish: (item: Item, applied: Map<string, number>) => Promise<void>;
    const applied = new Map<string, number>();
    try {
      ({ outs, finish } = await recordOuts(entry, applied));
    } catch (e) {
      if (e instanceof BlobSkipped) {
        // 云端放不下这个文件：这次打开 App 不再试，别的照常同步
        syncState.blobNote = e.message;
        skipped.add(outboxKey(entry.store, entry.key));
      } else failure ??= e;
      // 这一条下一轮再试，别的照常推
      continue;
    }
    if (!outs) {
      drop.push(entry);
      continue;
    }
    if (!outs.length) continue;
    const item: Item = { entry, waiting: outs.length, conflicted: false, finish: () => finish(item, applied) };
    open.push(item);
    for (const o of outs) {
      const size = encoder.encode(JSON.stringify(o.rec)).byteLength;
      if (queue.length && (queue.length >= SYNC_PUSH_MAX_RECORDS || bytes + 1 + size > SYNC_PUSH_MAX_BYTES)) await send();
      bytes += size + (queue.length ? 1 : 0);
      queue.push({ ...o, item });
    }
  }
  await send();
  if (drop.length) await removeOutbox(drop);
  // 被退回来的：云端那一份按拉到的处理（合并），合并出来和云端不一样的下一轮再推
  if (conflicts.length) await applyRecords(conflicts);
  if (failure) throw failure;
  return conflicts.length > 0;
}

/** 一条普通记录要推的（没变返回 null：从发件箱拿掉） */
async function recordOuts(entry: OutboxEntry, applied: Map<string, number>): Promise<{ outs: Omit<Out, 'item'>[] | null; finish: (item: Item, applied: Map<string, number>) => Promise<void> }> {
  const { store, key } = entry;
  const [raw, st] = await Promise.all([
    getOne<unknown>(store, key, { local: true }),
    getOne<RecordState>('syncState', stateKey(store, key), { local: true }),
  ]);
  let next: RecordState;
  const finish = async (item: Item) => {
    const seq = applied.get(key);
    if (item.conflicted || seq === undefined) return;
    await write('syncState', [{ key: stateKey(store, key), value: { ...next, s: seq } }], [], { sync: true });
    await removeOutbox([entry]);
  };
  if (raw === undefined) {
    if (!st || st.h === DELETED) return { outs: null, finish };
    next = { s: 0, h: DELETED };
    return { outs: [{ rec: { ...wire(store, key), updatedAt: entry.at, deleted: true, data: null, base: st.s }, applied: (seq) => applied.set(key, seq) }], finish };
  }
  // 大文件的表：拉到过、还没下载的（lazy）本机却有了，说明是这台设备自己存的同一个文件，也不用推
  const encoded = hasBinary(raw) ? await encodeBinary(raw, blobs!) : raw;
  const h = fingerprint(store, encoded);
  if (st && st.h === h) return { outs: null, finish };
  const json = JSON.stringify(encoded);
  const data = encoder.encode(json).byteLength > PACK_BYTES ? await packJson(json, blobs!) : encoded;
  next = { s: 0, h, ...(keepBase(store, json) && !isLazy(store, key) && !hasBinary(raw) ? { b: json } : {}) };
  // 消息带上时间：存成大文件的云端也知道它是什么时候的（新设备只拉最近的）
  const createdAt = store === 'chatMessages' ? Number((raw as { createdAt?: unknown }).createdAt) : NaN;
  return {
    outs: [{ rec: { ...wire(store, key), updatedAt: entry.at, deleted: false, data, base: st?.s ?? 0, ...(Number.isFinite(createdAt) ? { createdAt } : {}) }, applied: (seq) => applied.set(key, seq) }],
    finish,
  };
}

/**
 * 这些素材云端有没有完整的一份（推上去过、之后本机没再改）：有的话本机这份可以清掉（图片缓存），用到时再下载。
 * 没开同步、换了 Worker 还没对齐时一律算没有
 */
export async function cloudBackedAssets(keys: string[]): Promise<boolean[]> {
  if (!keys.length) return [];
  await loadMeta();
  if (!meta.enabled || !meta.joined || !meta.hub || meta.hub !== hubUrl || !syncState.supported) return keys.map(() => false);
  const [states, pend] = await Promise.all([
    getMany<RecordState>('syncState', keys.map((k) => stateKey('assets', k))),
    getMany<OutboxEntry>('syncOutbox', keys.map((k) => outboxKey('assets', k))),
  ]);
  return keys.map((_, i) => {
    const st = states[i];
    return !!st && st.s > 0 && st.h !== DELETED && !pend[i];
  });
}

// —— 用到时再下载 ——

const fetching = new Map<string, Promise<unknown>>();
/**
 * 去云端没取成的（云端还没有：另一台设备先推了朋友圈、图还在传；下载出错）：until 之前不再去取。
 * 一直取不到时越等越久（30 秒起，每次翻倍，最多 30 分钟）；这个文件同步过来了就马上能取（applyStore 里清掉）。
 * told：到了重试的时间、已经告诉界面再取一次了
 */
const notThere = new Map<string, { until: number; wait: number; told?: boolean }>();
const MISS_FIRST = 30_000;
const MISS_MAX = 30 * 60_000;
const missKey = (store: string, key: string) => `${store}\u0000${key}`;
/** 正在取的时候同步过来了的：这次没取到也不用等，界面马上再取 */
const landed = new Set<string>();
let downloads = 0;
const waiters: (() => void)[] = [];

/** 每张图上次没取到的原因（同步检查里显示） */
const missWhy = new Map<string, string>();

function missedAgain(id: string, why: string) {
  missWhy.set(id, why);
  if (landed.delete(id)) return;
  const wait = Math.min(MISS_MAX, (notThere.get(id)?.wait ?? MISS_FIRST / 2) * 2);
  notThere.set(id, { until: Date.now() + wait, wait });
}

/** 同步完一轮：上次没取成、到了重试时间的，让界面上显示不出来的图再取一次 */
function retryMisses() {
  const now = Date.now();
  let due = false;
  for (const m of notThere.values()) {
    if (m.told || m.until > now) continue;
    m.told = true;
    due = true;
  }
  if (due) syncState.arrivals++;
}

/** 本机读不到的大文件（图片、模型、书的原文件）：在别的设备上同步过的话从云端取回来 */
async function fetchMissing(store: StoreName, key: string): Promise<unknown> {
  if (!isLazy(store, key) || !api || !blobs || !meta.enabled || !meta.hub || meta.hub !== hubUrl) return undefined;
  const id = missKey(store, key);
  const running = fetching.get(id);
  if (running) return running;
  if ((notThere.get(id)?.until ?? 0) > Date.now()) return undefined;
  const job = (async () => {
    // 同时最多下载 3 个
    if (downloads >= 3) await new Promise<void>((resolve) => waiters.push(resolve));
    downloads++;
    try {
      const st = await getOne<RecordState>('syncState', stateKey(store, key), { local: true });
      if (st?.h === DELETED) return undefined;
      let ref = st?.lazy;
      if (ref === undefined) {
        // 记录还没拉到（别的设备先推了消息、后推的图）：单独问一下
        const { record } = await api!.json<{ record: SyncRecord | null }>(`/v1/sync/record?kind=${encodeURIComponent(store)}&parent=&id=${encodeURIComponent(key)}`);
        if (!record || record.deleted) {
          missedAgain(id, record?.deleted ? '云端这张图被删掉了' : '云端还没有这张图的记录（画它的设备没传上来）');
          return undefined;
        }
        ref = record.data;
      }
      const value = await decodeBinary(await expand(ref), blobs!);
      await write(store, [{ key, value }], [], { sync: true });
      if (st) await write('syncState', [{ key: stateKey(store, key), value: { s: st.s, h: st.h } }], [], { sync: true });
      notThere.delete(id);
      landed.delete(id);
      missWhy.delete(id);
      return value;
    } catch (e) {
      console.warn(`同步：取不回 ${store} ${key}`, e);
      missedAgain(id, `下载失败：${e instanceof Error ? e.message : String(e)}`);
      return undefined;
    } finally {
      downloads--;
      waiters.shift()?.();
    }
  })().finally(() => fetching.delete(id));
  fetching.set(id, job);
  return job;
}

/**
 * 这台设备上的图，账本记着推过，云端真的有吗（按文件哈希一次问 100 张）：没有的（同步漏掉了、云端丢了）账本作废、放回发件箱重传。
 * 打开 App 后查一次最近用到的图（services/assetCache）。返回放回去几张
 */
export async function verifyUploaded(keys: string[]): Promise<number> {
  await loadMeta();
  if (!canFetch() || !meta.joined) return 0;
  // 素材的 key 就是文件的 SHA-256，和云端存文件用的哈希是同一个
  const hex = [...new Set(keys)].filter((k) => /^[0-9a-f]{64}$/.test(k));
  if (!hex.length) return 0;
  const [have, states, outs] = await Promise.all([
    hasKeys('assets', hex),
    getMany<RecordState>('syncState', hex.map((k) => stateKey('assets', k))),
    getMany<OutboxEntry>('syncOutbox', hex.map((k) => outboxKey('assets', k))),
  ]);
  const mine = hex.filter((_, i) => have[i] && states[i] && states[i]!.h !== DELETED && !states[i]!.lazy && !outs[i]);
  if (!mine.length) return 0;
  const missing = await blobs!.missing(mine);
  const redo = mine.filter((k) => missing.has(k));
  if (!redo.length) return 0;
  console.warn(`同步：${redo.length} 张图账本记着推过、云端却没有，重新上传`);
  await write('syncState', [], redo.map((k) => stateKey('assets', k)), { sync: true });
  const at = Date.now();
  await write('syncOutbox', redo.map((key, n) => ({ key: outboxKey('assets', key), value: { store: 'assets', key, at, n } satisfies OutboxEntry })), [], { sync: true });
  void runSync().catch(() => undefined);
  return redo.length;
}

// —— 查一张图：本机、发件箱、云端的记录和文件、能不能下载 ——

export interface AssetCheck {
  /** 一句话：卡在哪一步 */
  verdict: string;
  /** 每一步看到的（可以复制给别人看） */
  lines: string[];
  /** 这次检查顺手从云端取回来了（界面再取一次就显示） */
  fixed: boolean;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);
const when = (t: number | null | undefined) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');

/**
 * 一张图（素材 key）在这台设备和云端是什么状态：本机有没有、同步账本和发件箱怎么记的、云端有没有这条记录和文件、能不能下载。
 * 别的设备的图显示不出来、或者这台设备画的图别的设备看不到时，点一下就知道卡在哪一步；本机没有、云端下载得下来时顺手存进本机
 */
export async function checkAsset(key: string): Promise<AssetCheck> {
  await loadMeta();
  const lines: string[] = [];
  let verdict = '';
  let fixed = false;
  const id = missKey('assets', key);
  const [local, st, out] = await Promise.all([
    getOne<{ mime?: string; data?: ArrayBuffer }>('assets', key, { local: true }).catch(() => undefined),
    getOne<RecordState>('syncState', stateKey('assets', key), { local: true }).catch(() => undefined),
    getOne<OutboxEntry>('syncOutbox', outboxKey('assets', key), { local: true }).catch(() => undefined),
  ]);
  lines.push(`图：${key.slice(0, 16)}…`);
  lines.push(local ? `本机：有（${local.mime ?? '?'}，${kb(local.data?.byteLength ?? 0)}）` : '本机：没有');
  lines.push(!st ? '同步账本：没有这张图（这台设备没推过、也没收到过它的记录）'
    : st.h === DELETED ? `同步账本：已删除（seq ${st.s}）`
      : `同步账本：seq ${st.s}${st.lazy ? '，收到了记录、还没下载' : ''}`);
  lines.push(out ? `发件箱：在等着上传（记下于 ${when(out.at)}）` : '发件箱：没有');
  lines.push(`这台设备的同步：${meta.enabled ? '开着' : '关着'}，${api ? (syncState.supported ? '连着云端' : '连着的 Worker 不支持同步') : '没连上云端'}，上次同步 ${when(syncState.lastAt)}，发件箱 ${syncState.pending} 条`);
  if (syncState.error) lines.push(`上次同步的错误：${syncState.error}`);
  if (syncState.blobNote) lines.push(`传图片的提示：${syncState.blobNote}`);
  const why = missWhy.get(id);
  if (why) lines.push(`上次取图：${why}`);
  if (!canFetch()) {
    lines.push('云端：这台设备现在连不上（看上面的同步状态）');
    return { verdict: local ? '本机有这张图，但这台设备没连上云端，没法传给别的设备' : '这台设备没连上云端，取不到别的设备画的图', lines, fixed };
  }
  try {
    const { record } = await api!.json<{ record: SyncRecord | null }>(`/v1/sync/record?kind=assets&parent=&id=${encodeURIComponent(key)}`);
    if (!record) {
      lines.push('云端记录：没有');
      if (local && !out) {
        // 本机有、云端没有、也不在发件箱里（同步漏掉了它；或者账本记着推过、云端却没有）：账本作废，放回发件箱马上重传
        await write('syncState', [], [stateKey('assets', key)], { sync: true });
        await write('syncOutbox', [{ key: outboxKey('assets', key), value: { store: 'assets', key, at: Date.now(), n: 0 } satisfies OutboxEntry }], [], { sync: true });
        void runSync().catch(() => undefined);
        lines.push(st ? '处理：账本记着推过、云端却没有，已经作废、放回发件箱重新上传' : '处理：已经放回发件箱重新上传');
        fixed = true;
        verdict = '这张图没传上云端（同步漏掉了它），已经放回发件箱重新上传，过一会儿别的设备就能看到';
      } else {
        verdict = local
          ? '这张图还在这台设备的发件箱里，没传上云端：看上面的同步错误'
          : '云端没有这张图：画它的那台设备没把它传上来（在那台设备上点这张图的「同步检查」看原因）';
      }
      return { verdict, lines, fixed };
    }
    lines.push(record.deleted ? `云端记录：已删除（seq ${record.seq}，${when(record.updatedAt)}）` : `云端记录：有（seq ${record.seq}，${when(record.updatedAt)}）`);
    if (record.deleted) return { verdict: '这张图在云端被删掉了', lines, fixed };
    const data = (isBlobRef(record.data) ? await unpackJson(record.data, blobs!) : record.data) as { data?: unknown } | null;
    const ref = data && typeof data === 'object' ? data.data : undefined;
    if (!isBinRef(ref)) {
      lines.push('云端记录里没有文件引用');
      return { verdict: '云端的记录不完整', lines, fixed };
    }
    lines.push(`文件：${ref.$bin.slice(0, 16)}…，${kb(ref.size)}`);
    const missing = await blobs!.missing([ref.$bin]);
    if (missing.has(ref.$bin)) {
      lines.push('云端文件：没有');
      return { verdict: '云端有记录、没有文件（传到一半？）', lines, fixed };
    }
    lines.push(`云端文件：有（存在 ${blobs!.store === 'r2' ? 'R2' : 'D1'}）`);
    try {
      const value = await decodeBinary(data, blobs!);
      lines.push('下载：成功，哈希对得上');
      if (!local) {
        await write('assets', [{ key, value }], [], { sync: true });
        if (st) await write('syncState', [{ key: stateKey('assets', key), value: { s: st.s, h: st.h } }], [], { sync: true });
        notThere.delete(id);
        missWhy.delete(id);
        fixed = true;
        syncState.arrivals++;
      }
      verdict = local ? '这张图本机和云端都有，同步正常' : '刚从云端取回来了，现在应该显示出来';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      lines.push(`下载：失败（${msg}）`);
      verdict = `云端有这张图，这台设备下载失败：${msg}`;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    lines.push(`问云端：失败（${msg}）`);
    verdict = `问云端出错：${msg}`;
  }
  return { verdict, lines, fixed };
}
