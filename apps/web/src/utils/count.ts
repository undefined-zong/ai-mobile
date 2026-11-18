/** 人数、帖数这类数的短写法：1286 → "1286"，128600 → "12.9 万"，230000000 → "2.3 亿" */
export function countText(n: number): string {
  const short = (v: number) => v.toFixed(1).replace(/\.0$/, '');
  if (n >= 100_000_000) return `${short(n / 100_000_000)} 亿`;
  if (n >= 10_000) return `${short(n / 10_000)} 万`;
  return String(Math.max(0, Math.round(n)));
}
