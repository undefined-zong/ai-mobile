/**
 * 读模型输出、算随机时间时共用的小工具（朋友圈和社群都用）。
 */

/** 32 位 FNV-1a：按文字算一个可重复的数（同一个角色同一天算出来的时间一样） */
export function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

/** 模型把"没有"写成 null / none / 无 的都算空 */
export function nullable(v: unknown): string | null {
  const s = str(v);
  return s && !/^(null|none|无|没有)$/i.test(s) ? s : null;
}

/** 模型有时把整页 HTML 包在 ``` 里，或者带着 <!DOCTYPE>：拿出里面的内容 */
export function cleanHtml(v: unknown): string | null {
  let s = nullable(v);
  if (!s) return null;
  s = s.replace(/^```(?:html)?\s*/i, '').replace(/```\s*$/, '').trim();
  // 不是 HTML（没有任何标签）的不要
  return /<[a-z][\s\S]*>/i.test(s) ? s.slice(0, 20_000) : null;
}

/** 非负整数（模型把数写成字符串、小数、负数时收一收） */
export function count(v: unknown, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(0, Math.round(n))) : 0;
}

/** "11/14 12:30" 这样的时间（写进提示词）；timeZone 不给按本机 */
export function shortStamp(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
}

/** "11月14日" 这样的日期（写进记忆） */
export function shortDay(at: number, timeZone?: string): string {
  return new Intl.DateTimeFormat('zh-CN', { timeZone, month: 'numeric', day: 'numeric' }).format(new Date(at));
}
