/** 各个接口共用的回应、报错和读请求体 */
export const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });

export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new HttpError(400, message);
}

/** 读 JSON 请求体，超过 maxBytes 字节不读 */
export async function readJson<T>(request: Request, maxBytes = 1_800_000): Promise<T> {
  const value = await request.text();
  assert(new TextEncoder().encode(value).length <= maxBytes, '请求内容太大');
  try { return JSON.parse(value) as T; } catch { throw new HttpError(400, '无效的 JSON'); }
}
