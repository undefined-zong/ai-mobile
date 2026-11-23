/**
 * 同步用的纯函数：键排好序的 JSON（同一份内容在哪台设备上算出来都一样）、快的哈希、三方合并。
 * 不依赖浏览器。
 */

/** 像 JSON.stringify，但对象的键排好序 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const s = JSON.stringify(value);
    return s === undefined ? 'null' : s;
  }
  const withJson = value as { toJSON?: () => unknown };
  if (typeof withJson.toJSON === 'function') return canonical(withJson.toJSON());
  if (Array.isArray(value)) {
    return `[${value.map((x) => (x === undefined || typeof x === 'function' || typeof x === 'symbol' ? 'null' : canonical(x))).join(',')}]`;
  }
  const parts: string[] = [];
  for (const k of Object.keys(value).sort()) {
    const x = (value as Record<string, unknown>)[k];
    if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${canonical(x)}`);
  }
  return `{${parts.join(',')}}`;
}

/** cyrb53：53 位的字符串哈希，判断内容变没变够用（不是安全用途）；带上长度，再少一点撞车 */
export function hashText(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${text.length.toString(36)}.${(4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)}`;
}

const ABSENT: unique symbol = Symbol('absent');
type Slot = unknown | typeof ABSENT;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  return canonical(a) === canonical(b);
}

function slot(o: Record<string, unknown>, k: string): Slot {
  return Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined ? o[k] : ABSENT;
}

/** 每个元素都是带字符串 id 的对象，id 不重复（消息、留言、帖子、人设……） */
function idArray(a: unknown[]): a is { id: string }[] {
  const seen = new Set<string>();
  for (const x of a) {
    if (!isPlainObject(x) || typeof x.id !== 'string' || seen.has(x.id)) return false;
    seen.add(x.id);
  }
  return true;
}

function primitives(a: unknown[]): boolean {
  return a.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x));
}

/** 一边有一边没有的那一格：有底稿时分得清是加的还是删的 */
function mergeSlot(base: Slot, local: Slot, remote: Slot, preferLocal: boolean, hasBase: boolean): Slot {
  if (local === ABSENT && remote === ABSENT) return ABSENT;
  if (local === ABSENT) {
    // 没底稿：两边都留；底稿里没有：云端加的；云端没改：本机删的；云端改了：留改的
    if (!hasBase || base === ABSENT) return remote;
    return same(base, remote) ? ABSENT : remote;
  }
  if (remote === ABSENT) {
    if (!hasBase || base === ABSENT) return local;
    return same(base, local) ? ABSENT : local;
  }
  return mergeValue(base === ABSENT ? undefined : base, local, remote, preferLocal);
}

function mergeById(base: { id: string }[] | undefined, local: { id: string }[], remote: { id: string }[], preferLocal: boolean): unknown[] {
  const bm = base ? new Map(base.map((x) => [x.id, x])) : undefined;
  const lm = new Map(local.map((x) => [x.id, x]));
  const rm = new Map(remote.map((x) => [x.id, x]));
  // 顺序：按云端的；本机新加的接在本机里它前面那一条后面
  const after = new Map<string | null, string[]>();
  let prev: string | null = null;
  for (const x of local) {
    if (!rm.has(x.id)) {
      const list = after.get(prev) ?? [];
      list.push(x.id);
      after.set(prev, list);
    } else prev = x.id;
  }
  const order: string[] = [...(after.get(null) ?? [])];
  for (const x of remote) order.push(x.id, ...(after.get(x.id) ?? []));
  const out: unknown[] = [];
  for (const id of order) {
    const v = mergeSlot(bm ? (bm.has(id) ? bm.get(id) : ABSENT) : ABSENT, lm.has(id) ? lm.get(id) : ABSENT, rm.has(id) ? rm.get(id) : ABSENT, preferLocal, !!bm);
    if (v !== ABSENT) out.push(v);
  }
  return out;
}

/** 不重复的字符串（删掉的 id、放进来过的文件、标签……）：当成集合合并 */
function mergeSet(base: string[] | undefined, local: string[], remote: string[]): string[] {
  const b = new Set(base ?? []);
  const l = new Set(local);
  const r = new Set(remote);
  const out = remote.filter((x) => !(base && b.has(x) && !l.has(x)));
  for (const x of local) if (!r.has(x) && !(base && b.has(x))) out.push(x);
  return out;
}

function uniqueStrings(a: unknown[]): a is string[] {
  return a.every((x) => typeof x === 'string') && new Set(a).size === a.length;
}

/**
 * 三方合并：base 是上次同步时的样子（不知道时为 undefined），local 是本机改过的，remote 是别的设备改过的。
 * - 只有一边改了：用改了的那边；
 * - 对象按键、带 id 的数组按 id 逐个合并（一边加的、一边删的都保留下来）；
 * - 长度不变的简单数组、长度不变的没有 id 的对象数组按位置合并，不重复的字符串数组按集合合并；
 * - 没有底稿时一边是 null、一边有值：留有值的；
 * - 同一个值两边改得不一样：preferLocal（本机改得更晚）时用本机的，否则用云端的。
 */
export function mergeValue(base: unknown, local: unknown, remote: unknown, preferLocal: boolean): unknown {
  if (same(local, remote)) return local;
  if (base !== undefined) {
    if (same(base, local)) return remote;
    if (same(base, remote)) return local;
  } else {
    // 没底稿（两台设备各自写下的同一处）：一边还是空的、一边有了值，留有值的（同一条朋友圈一台画好了图、一台还没有）
    if (local === null) return remote;
    if (remote === null) return local;
  }
  if (isPlainObject(local) && isPlainObject(remote)) {
    const b = isPlainObject(base) ? base : undefined;
    const out: Record<string, unknown> = {};
    const keys = new Set([...Object.keys(remote), ...Object.keys(local), ...(b ? Object.keys(b) : [])]);
    for (const k of keys) {
      const v = mergeSlot(b ? slot(b, k) : ABSENT, slot(local, k), slot(remote, k), preferLocal, !!b);
      if (v !== ABSENT) out[k] = v;
    }
    return out;
  }
  if (Array.isArray(local) && Array.isArray(remote)) {
    const b = Array.isArray(base) ? base : undefined;
    if ((local.length || remote.length) && idArray(local) && idArray(remote) && (!b || idArray(b))) return mergeById(b, local, remote, preferLocal);
    // 长度没变、没有 id 的对象数组（朋友圈、帖子的配图）：按位置逐个合并。
    // 一台设备画好了这张图、另一台记下了没画出来的原因时两样都留下，图不会被整组换掉
    if (local.length && local.length === remote.length && (!b || b.length === local.length)
      && local.every(isPlainObject) && remote.every(isPlainObject) && (!b || b.every(isPlainObject))) {
      return local.map((x, i) => mergeValue(b?.[i], x, remote[i], preferLocal));
    }
    if (primitives(local) && primitives(remote) && (!b || primitives(b))) {
      if (b && b.length === local.length && b.length === remote.length) {
        return local.map((x, i) => (same(b[i], x) ? remote[i] : same(b[i], remote[i]) ? x : preferLocal ? x : remote[i]));
      }
      if (uniqueStrings(local) && uniqueStrings(remote) && (!b || uniqueStrings(b))) return mergeSet(b, local, remote);
    }
  }
  return preferLocal ? local : remote;
}
