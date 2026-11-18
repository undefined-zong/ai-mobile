import type { Ref } from 'vue';
import type { RemoteChange } from '@/db/idb';

/**
 * 别的设备的改动放进内存里的 store（同步已经写进本机库）。
 * 原来的对象原地换成新内容（正开着它的页面、拿着它的异步任务看得到新内容），新的加进去，删了的拿掉。
 */

/** 把 target 的内容换成 source 的（保留 target 这个对象） */
export function replaceInPlace(target: object, source: object) {
  const t = target as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!(k in source)) delete t[k];
  Object.assign(t, source);
}

/**
 * 按 id 的列表：改了的原地换，新的加上，删了的拿掉。
 * normalize：和读库时一样的整理（返回 null 不要这条）；keep：这条该不该在这个列表里（书架只要书目……）；sort：放完以后怎么排
 */
export function applyList<T extends { id: string }>(
  list: Ref<T[]>,
  changes: RemoteChange[],
  opts: { normalize?: (value: T) => T | null; sort?: (a: T, b: T) => number } = {},
) {
  const index = new Map(list.value.map((x, i) => [x.id, i]));
  const next: (T | null)[] = list.value.slice();
  for (const c of changes) {
    const i = index.get(c.key);
    if (c.deleted) {
      if (i !== undefined) next[i] = null;
      continue;
    }
    const raw = c.value as T | null | undefined;
    if (!raw || typeof raw !== 'object') continue;
    const value = opts.normalize ? opts.normalize(raw) : raw;
    if (!value) {
      if (i !== undefined) next[i] = null;
      continue;
    }
    if (i !== undefined && next[i]) replaceInPlace(next[i]!, value);
    else {
      index.set(value.id, next.length);
      next.push(value);
    }
  }
  const out = next.filter((x): x is T => !!x);
  if (opts.sort) out.sort(opts.sort);
  list.value = out;
}
