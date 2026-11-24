import { reactive, watch, type WatchSource } from 'vue';

/**
 * 本机数据库（IndexedDB）。导入的角色卡、世界书、预设，以及和导入角色的聊天都存在这里，刷新、离线后还在。
 * 演示角色和聊天在首次打开时初始化，之后也持久化，避免丢失真实云端消息。
 * 先用一个很薄的封装；做同步（发件箱、seq）时再换成设计文档里的 Dexie 表结构。
 */

const DB_NAME = 'ai-mobile';
const VERSION = 13;
/**
 * - settings：API 设置（按功能）、回复修剪等设置（以后随同步走）
 * - secrets：API Key，只存这台设备，永远不进同步数据
 * - assets：生成的图片、语音（按内容哈希存；以后同步时传到 R2）
 * - rhythm：节律（每个角色的设置和模板、每天的作息穿着、"建世界"生成的世界）
 * - gallery：图库（一起做事时画的图：哪个角色、哪个场景、哪个时刻、穿的什么）
 * - memories / slices / summaries / profiles：记忆（事实记忆、故事片段、时间线、画像卡），按条写入，不整表比较
 * - moments：朋友圈（她们发的、你发的，连同点赞和评论），一条一条存
 * - communities / communityPosts：社群（自带的、搜出来的）和社群里的帖子（网友的、她们的、你的），一条一条存
 * - chatMessages：聊天消息一条一行（键是 msgKey(聊天 id, 消息 id)）：长聊天改一条只写一条。v10 之前是 messages 表（一个聊天整个数组一行），升级时拆开。
 *   索引 chat（[chatId, createdAt]）：打开 App 只把每个聊天最近的读进内存，往上翻再按时间往前读（v11）
 * - diaries：角色的日记（主动写日记每晚 22:00 写的、回忆页里让她现在写的），一篇一条（v12）
 * - album：相册（你从生成的图里存下来的，能删、能拖动排序），一张一条（v12）
 * - syncState / syncOutbox：多设备同步（services/sync）：每条记录上次同步到哪一版、本机改了还没传的记录（发件箱）
 */
export const STORES = ['characters', 'lorebooks', 'presets', 'chats', 'chatMessages', 'settings', 'secrets', 'assets', 'books', 'rhythm', 'gallery', 'memories', 'slices', 'summaries', 'profiles', 'live2d', 'moments', 'communities', 'communityPosts', 'diaries', 'album', 'syncState', 'syncOutbox', 'requestLog'] as const;
export type StoreName = (typeof STORES)[number];

export const databaseState = reactive({ status: 'opening' as 'opening' | 'blocked' | 'ready' | 'error' | 'outdated' });
let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  // 别的页面已升级：这页的内存快照可能过时，重新加载前不能再写回。
  if (databaseState.status === 'outdated') return Promise.reject(new Error('请重新打开 App 以读取更新后的本机数据'));
  if (opening) return opening;
  databaseState.status = 'opening';
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    function request(version?: number) {
      try {
        const req = version === undefined ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
          const cm = req.transaction!.objectStore('chatMessages');
          if (!cm.indexNames.contains('chat')) cm.createIndex('chat', ['chatId', 'createdAt']);
          // v10：旧的 messages 表（一个聊天一个数组）拆成一条消息一行，拆完删掉旧表（旧版本页面会提示更新，不会再写回数组）
          if (db.objectStoreNames.contains('messages')) {
            const tx = req.transaction!;
            const to = tx.objectStore('chatMessages');
            const cursor = tx.objectStore('messages').openCursor();
            cursor.onsuccess = () => {
              const c = cursor.result;
              if (!c) {
                db.deleteObjectStore('messages');
                return;
              }
              const chatId = String(c.key);
              if (Array.isArray(c.value)) {
                // chatId 补上（按聊天、按时间读的索引靠它）
                for (const m of c.value as { id?: unknown; chatId?: unknown }[]) if (m && typeof m.id === 'string') to.put(m.chatId === chatId ? m : { ...m, chatId }, msgKey(chatId, m.id));
              }
              c.continue();
            };
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          // 旧缓存页面也能读已经升级的库，但绝不降级、删库或重建已有表。
          if (STORES.some((s) => !db.objectStoreNames.contains(s))) {
            db.close();
            reject(new Error('本机数据需要更新版本的 App 才能读取'));
            return;
          }
          db.onversionchange = () => {
            db.close();
            if (opening === pending) opening = null;
            databaseState.status = 'outdated';
          };
          db.onclose = () => {
            if (opening === pending) {
              opening = null;
              databaseState.status = 'error';
            }
          };
          databaseState.status = 'ready';
          resolve(db);
        };
        req.onerror = () => {
          if (version !== undefined && req.error?.name === 'VersionError') request();
          else reject(req.error ?? new Error('无法打开本机数据'));
        };
        // 占用解除后同一个请求会继续，不能把 blocked 当成一个空数据库。
        req.onblocked = () => { databaseState.status = 'blocked'; };
      } catch (error) {
        reject(error);
      }
    }
    request(VERSION);
  });
  opening = pending;
  void pending.catch(() => {
    if (opening === pending) {
      opening = null;
      databaseState.status = 'error';
    }
  });
  return pending;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** 读失败必须向上传递；只有成功读完事务才能把不存在的记录当成空数据。 */
async function read<T>(store: StoreName, request: (os: IDBObjectStore) => () => T): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const result = request(tx.objectStore(store));
    tx.oncomplete = () => resolve(result());
    tx.onerror = () => reject(tx.error ?? new Error('本机数据读取失败'));
    tx.onabort = () => reject(tx.error ?? new Error('本机数据读取中断'));
  });
}

export function getAll<T>(store: StoreName): Promise<T[]> {
  return read(store, (os) => {
    const req = os.getAll();
    return () => req.result as T[];
  });
}

/**
 * 读一条。本机没有、而它在别的设备上同步过来过（图片、语音、Live2D 模型、书的原文件按需下载）时，
 * 交给同步去云端取（local: true 只看本机）
 */
export async function getOne<T>(store: StoreName, key: string, opts: { local?: boolean } = {}): Promise<T | undefined> {
  const value = await read(store, (os) => {
    const req = os.get(key);
    return () => req.result as T | undefined;
  });
  if (value === undefined && !opts.local && missHandler) return (await missHandler(store, key)) as T | undefined;
  return value;
}

/** 一次读几条（同一个事务）：没有的是 undefined */
export function getMany<T>(store: StoreName, keys: string[]): Promise<(T | undefined)[]> {
  if (!keys.length) return Promise.resolve([]);
  return read(store, (os) => {
    const reqs = keys.map((k) => os.get(k));
    return () => reqs.map((r) => r.result as T | undefined);
  });
}

/** 这几个键本机有没有（不读内容） */
export function hasKeys(store: StoreName, keys: string[]): Promise<boolean[]> {
  if (!keys.length) return Promise.resolve([]);
  return read(store, (os) => {
    const reqs = keys.map((k) => os.getKey(k));
    return () => reqs.map((r) => r.result !== undefined);
  });
}

/** 清空一张表（同步换了 Worker 时清自己的账本） */
export async function clearStore(store: StoreName): Promise<void> {
  const db = await open();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).clear();
  await done(tx);
}

/** 只读键（大文件多的表不用把内容全读出来） */
export function getKeys(store: StoreName): Promise<string[]> {
  return read(store, (os) => {
    const req = os.getAllKeys();
    return () => req.result.map(String);
  });
}

/** 读出整张表：键和值一起（getAll 只给值） */
export function getEntries<T>(store: StoreName): Promise<{ key: string; value: T }[]> {
  return read(store, (os) => {
    const keysReq = os.getAllKeys();
    const valuesReq = os.getAll();
    return () => (valuesReq.result as T[]).map((value, i) => ({ key: String(keysReq.result[i]), value }));
  });
}

/** 只读键符合条件的那些记录（同一张表里还存着大的正文、文件时，不用全读出来） */
export function getEntriesWhere<T>(store: StoreName, keep: (key: string) => boolean): Promise<{ key: string; value: T }[]> {
  return read(store, (os) => {
    const out: { key: string; value: T }[] = [];
    const keysReq = os.getAllKeys();
    keysReq.onsuccess = () => {
      for (const k of keysReq.result) {
        const key = String(k);
        if (!keep(key)) continue;
        const req = os.get(k);
        req.onsuccess = () => out.push({ key, value: req.result as T });
      }
    };
    return () => out;
  });
}

export const STORE_NAMES: readonly StoreName[] = STORES;

/** chatMessages 表的键：聊天 id + 消息 id */
export const msgKey = (chatId: string, msgId: string) => `${chatId}\u0000${msgId}`;
/** 拆开 chatMessages 的键（不是这种键返回 null） */
export function splitMsgKey(key: string): [chatId: string, msgId: string] | null {
  const i = key.indexOf('\u0000');
  return i < 0 ? null : [key.slice(0, i), key.slice(i + 1)];
}

/**
 * 一个聊天的消息，从新往旧按 createdAt 读（chat 索引），返回时从旧到新：
 * 读够 n 条；给了 until 再接着读到它为真的那条为止（最多 cap 条）。
 * before：只读 createdAt 不晚于它的（往前翻页；同一时间的可能读到已经有的，skip 里的键不算数）。
 * more：后面（更早）还有
 */
export function recentMessages<T>(chatId: string, opts: { n: number; cap?: number; before?: number; skip?: Set<string>; until?: (value: T) => boolean }): Promise<{ items: { key: string; value: T }[]; more: boolean }> {
  return read('chatMessages', (os) => {
    const out: { key: string; value: T }[] = [];
    let more = false;
    let found = !opts.until;
    const cap = Math.max(opts.n, opts.cap ?? opts.n);
    const req = os.index('chat').openCursor(IDBKeyRange.bound([chatId, -Infinity], [chatId, opts.before ?? Infinity]), 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const key = String(c.primaryKey);
      if (opts.skip?.has(key)) return c.continue();
      if (out.length >= cap || (out.length >= opts.n && found)) {
        more = true;
        return;
      }
      out.push({ key, value: c.value as T });
      if (!found && opts.until!(c.value as T)) found = true;
      c.continue();
    };
    return () => ({ items: out.reverse(), more });
  });
}

/** 一个聊天在本机的全部消息的键（删聊天时连同没读进内存的一起删） */
export function chatMessageKeys(chatId: string): Promise<string[]> {
  return read('chatMessages', (os) => {
    const req = os.getAllKeys(IDBKeyRange.bound(`${chatId}\u0000`, `${chatId}\u0000\uffff`));
    return () => req.result.map(String);
  });
}

/** 一个聊天的全部消息（按键的范围读，不扫别的聊天） */
export function getChatMessages<T>(chatId: string): Promise<{ key: string; value: T }[]> {
  return read('chatMessages', (os) => {
    const range = IDBKeyRange.bound(`${chatId}\u0000`, `${chatId}\u0000\uffff`);
    const keysReq = os.getAllKeys(range);
    const valuesReq = os.getAll(range);
    return () => (valuesReq.result as T[]).map((value, i) => ({ key: String(keysReq.result[i]), value }));
  });
}

/** 整库恢复后置为 true：这页内存里的旧数据不能再写回去，直到重新加载。 */
let frozen = false;

/**
 * 整库恢复（导入备份）开始：停掉自动保存，清空这些表、删掉指定的记录。
 * 之后用 restoreRows 分批写入；完成后调用方必须重新加载页面。
 */
export async function beginRestore(clear: StoreName[], drop: [StoreName, string][] = []): Promise<void> {
  const db = await open();
  frozen = true;
  const tx = db.transaction([...new Set([...clear, ...drop.map(([s]) => s)])], 'readwrite');
  for (const s of clear) tx.objectStore(s).clear();
  for (const [s, k] of drop) tx.objectStore(s).delete(k);
  await done(tx);
}

/** 恢复时分批写入：每批一个事务，内存里只留这一批（整份备份一次写进去，大素材会把手机内存撑爆） */
export async function restoreRows(rows: { store: StoreName; key: string; value: unknown }[]): Promise<void> {
  if (!rows.length) return;
  const db = await open();
  const tx = db.transaction([...new Set(rows.map((r) => r.store))], 'readwrite');
  for (const r of rows) tx.objectStore(r.store).put(r.value, r.key);
  await done(tx);
}

// —— 多设备同步的钩子（services/sync 设置）——

/**
 * 发件箱里的一条：本机改了这条记录（at 是改的时间，n 区分同一毫秒里的两次）。
 * join：第一次连上这个 Worker 时整理出来的本机记录（不是真的改动）：云端也有同一条时以云端为准
 */
export interface OutboxEntry { store: StoreName; key: string; at: number; n: number; join?: boolean }
export const outboxKey = (store: string, key: string) => `${store}\u0000${key}`;
/** 这次写入要不要记进发件箱（同步关着、只在本机的记录不记） */
let tracker: ((store: StoreName, key: string) => boolean) | null = null;
let onTracked: (() => void) | null = null;
let writeCount = 0;
let missHandler: ((store: StoreName, key: string) => Promise<unknown>) | null = null;

export function setSyncHooks(hooks: { track: ((store: StoreName, key: string) => boolean) | null; changed?: () => void; miss?: ((store: StoreName, key: string) => Promise<unknown>) | null }) {
  tracker = hooks.track;
  onTracked = hooks.changed ?? null;
  missHandler = hooks.miss ?? null;
}

/**
 * 写进本机库。本机的改动在同一个事务里记进同步发件箱（写成功才算改了，写失败发件箱也不会多一条）；
 * opts.sync：这是同步从云端拿来的，不再记进发件箱
 */
export async function write(store: StoreName, puts: { key: string; value: unknown }[], dels: string[] = [], opts: { sync?: boolean } = {}): Promise<boolean> {
  try {
    await writeOrThrow(store, puts, dels, opts);
    return true;
  } catch {
    return false;
  }
}

/** 同 write，写不进去时抛出原因（存图片这种丢了就找不回来的，要让调用的地方知道） */
export async function writeOrThrow(store: StoreName, puts: { key: string; value: unknown }[], dels: string[] = [], opts: { sync?: boolean } = {}): Promise<void> {
  if (!puts.length && !dels.length) return;
  if (frozen) throw new Error('正在恢复备份，重新打开 App 后再试');
  const db = await open();
  const track = !opts.sync && tracker ? tracker : null;
  const tracked = track ? [...new Set([...puts.map((p) => p.key), ...dels])].filter((k) => track(store, k)) : [];
  const tx = db.transaction(tracked.length ? [store, 'syncOutbox'] : [store], 'readwrite');
  const os = tx.objectStore(store);
  for (const p of puts) os.put(p.value, p.key);
  for (const k of dels) os.delete(k);
  if (tracked.length) {
    const outbox = tx.objectStore('syncOutbox');
    const at = Date.now();
    for (const key of tracked) outbox.put({ store, key, at, n: ++writeCount } satisfies OutboxEntry, outboxKey(store, key));
  }
  await done(tx);
  if (tracked.length) onTracked?.();
}

/** 导入的聊天和消息一起提交，保存失败时整批回滚；同步也使用同一份发件箱。 */
export async function writeTogether(rows: { store: StoreName; key: string; value: unknown }[]): Promise<void> {
  if (frozen) throw new Error('正在恢复备份，请重新打开 App 后导入');
  const db = await open();
  const tracked = rows.filter((r) => tracker?.(r.store, r.key));
  const stores = [...new Set<StoreName>([...rows.map((r) => r.store), ...(tracked.length ? ['syncOutbox' as const] : [])])];
  const tx = db.transaction(stores, 'readwrite');
  for (const r of rows) tx.objectStore(r.store).put(r.value, r.key);
  if (tracked.length) {
    const outbox = tx.objectStore('syncOutbox');
    const at = Date.now();
    for (const { store, key } of tracked) outbox.put({ store, key, at, n: ++writeCount } satisfies OutboxEntry, outboxKey(store, key));
  }
  await done(tx);
  if (tracked.length) onTracked?.();
}

/** 从发件箱拿掉这些（推上去了、合并完了）：拿之前这条记录又被改过（at / n 变了）就留着 */
export async function removeOutbox(entries: OutboxEntry[]): Promise<void> {
  if (!entries.length) return;
  const db = await open();
  const tx = db.transaction('syncOutbox', 'readwrite');
  const os = tx.objectStore('syncOutbox');
  for (const e of entries) {
    const key = outboxKey(e.store, e.key);
    const req = os.get(key);
    req.onsuccess = () => {
      const cur = req.result as OutboxEntry | undefined;
      if (cur && cur.at === e.at && cur.n === e.n) os.delete(key);
    };
  }
  await done(tx);
}

/**
 * 别的设备改了、同步写进本机库的记录：交给内存里的 store（界面马上看到）。
 * removed：整条换掉的列表里（一个聊天的消息）这次被别的设备删掉的 id；列表里没有、又不在这里面的是本机刚加的，要留着
 */
export interface RemoteChange { key: string; value?: unknown; deleted: boolean; removed?: string[] }
const appliers: { store: StoreName; owns: (key: string) => boolean; apply: (changes: RemoteChange[]) => void }[] = [];

/** 注册：这张表（owns 认领的键）在别的设备上改了时怎么放进内存 */
export function onRemote(store: StoreName, apply: (changes: RemoteChange[]) => void, owns: (key: string) => boolean = () => true) {
  appliers.push({ store, owns, apply });
}

/** 交给认领的 store；返回没人认领的键（这些要重新打开 App 才显示） */
export function applyRemote(store: StoreName, changes: RemoteChange[]): string[] {
  const unhandled = new Set(changes.map((c) => c.key));
  for (const a of appliers) {
    if (a.store !== store) continue;
    const mine = changes.filter((c) => a.owns(c.key));
    if (!mine.length) continue;
    try {
      a.apply(mine);
      for (const c of mine) unhandled.delete(c.key);
    } catch (e) {
      console.error(`同步：${store} 放不进内存`, e);
    }
  }
  return [...unhandled];
}

const flushers = new Set<() => Promise<void>>();
let listening = false;

/** 不用 autoSave 的 store（自己防抖写库的）也登记一下：同步拉取前先把内存里没写完的写掉 */
export function registerFlusher(flush: () => Promise<unknown> | unknown) {
  flushers.add(async () => { await flush(); });
}

/** 把所有 store 内存里还没写进库的改动写掉（导出备份前；同步合并前：本机刚改的要先进发件箱） */
export async function flushAll(): Promise<void> {
  await Promise.all([...flushers].map((f) => f().catch(() => undefined)));
}

export interface AutoSaveOptions {
  /** 防抖（毫秒），默认 400 */
  wait?: number;
  /** 别的设备改了这些记录（同步已经写进库）：放进内存。不给时这张表的改动要重新打开 App 才显示 */
  apply?: (changes: RemoteChange[]) => void;
  /** 认领哪些键：默认 settings 表只认 source 里有的键，别的表全认 */
  owns?: (key: string) => boolean;
}

/**
 * 自动保存：source 变了就（防抖后）把有变化的记录写进 store，消失的记录删掉。
 * 值按 JSON 存（去掉 Vue 的响应式代理），所以只放能 JSON 化的数据。
 */
export function autoSave(store: StoreName, source: () => { key: string; value: unknown }[], watchSource: WatchSource, options: number | AutoSaveOptions = 400) {
  const opts: AutoSaveOptions = typeof options === 'number' ? { wait: options } : options;
  const wait = opts.wait ?? 400;
  const last = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = true;
  let saving = 0;
  let revision = 0;
  let committed = 0;
  const pendingKeys = new Set<string>();
  /** 只是从内存里拿掉了（库里还在）：不当成删除 */
  const forgotten = new Set<string>();

  async function flush() {
    clearTimeout(timer);
    timer = undefined;
    // pagehide / 切后台也会调用 flush，不能绕过 hydrate 前的暂停状态。
    if (paused || frozen || databaseState.status === 'outdated') return;
    const puts: { key: string; value: unknown }[] = [];
    const snapshot = new Map<string, string>();
    for (const { key, value } of source()) {
      const json = JSON.stringify(value);
      snapshot.set(key, json);
      if (forgotten.size) forgotten.delete(key);
      // 前一次写入未完成时仍提交最新快照，包含用户迅速撤回的改动。
      if (!saving && last.get(key) === json) continue;
      puts.push({ key, value: JSON.parse(json) });
    }
    const dels = [...new Set([...last.keys(), ...pendingKeys])].filter((k) => !snapshot.has(k) && !forgotten.has(k));
    if (!puts.length && !dels.length) return;
    const current = ++revision;
    saving++;
    for (const { key } of puts) pendingKeys.add(key);
    const saved = await write(store, puts, dels);
    saving--;
    if (saved && current > committed) {
      committed = current;
      last.clear();
      for (const [key, json] of snapshot) if (!forgotten.has(key)) last.set(key, json);
    }
    if (!saving) pendingKeys.clear();
  }

  watch(
    watchSource,
    () => {
      if (paused) return;
      clearTimeout(timer);
      timer = setTimeout(() => void flush(), wait);
    },
    { deep: true },
  );
  flushers.add(flush);
  if (!listening && typeof document !== 'undefined') {
    listening = true;
    // 切到后台 / 关掉页面前把没写完的写掉
    const all = () => flushers.forEach((f) => void f());
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && all());
    window.addEventListener('pagehide', all);
  }

  /** 这些键在内存里的样子就是库里的样子（同步刚写进库、又放进了内存）：不用再写回去 */
  function settle(keys: string[]) {
    const want = new Set(keys);
    const current = new Map(source().filter((r) => want.has(r.key)).map((r) => [r.key, JSON.stringify(r.value)]));
    for (const key of want) {
      forgotten.delete(key);
      const json = current.get(key);
      if (json === undefined) last.delete(key);
      else last.set(key, json);
    }
  }

  if (opts.apply) {
    const apply = opts.apply;
    const owns = opts.owns ?? (store === 'settings' ? (key: string) => source().some((r) => r.key === key) : () => true);
    onRemote(store, (changes) => {
      apply(changes);
      if (!paused) settle(changes.map((c) => c.key));
    }, owns);
  }

  return {
    /** 读完库以后调用：记下现在的内容（不用再写回去），之后开始自动保存 */
    start() {
      for (const { key, value } of source()) last.set(key, JSON.stringify(value));
      paused = false;
    },
    flush,
    settle,
    /** 这些键只是从内存里拿掉（库里留着，用到时再读）：不要当成删除写进库 */
    forget(keys: string[]) {
      for (const key of keys) {
        forgotten.add(key);
        last.delete(key);
        pendingKeys.delete(key);
      }
    },
  };
}
