import { KISSTOY_PATH, parseKisstoyShareUrl, type KisstoyAction } from '@app/shared';
import type { Env } from './env.ts';
import { HttpError, json, readJson } from './http.ts';

/** 分享页的 HTTP 接口没有跨域许可，由已有的 Hub 登录会话转发；不保存分享链接。 */
export async function kisstoyApi(request: Request, env: Env, action: KisstoyAction): Promise<Response> {
  const { shareUrl } = await readJson<{ shareUrl: string }>(request);
  let share;
  try { share = parseKisstoyShareUrl(shareUrl); } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (!env.KISSTOY_ORIGIN) throw new HttpError(503, '请在 Hub 配置 KISSTOY_ORIGIN 后重新部署');
  const origin = new URL(env.KISSTOY_ORIGIN).origin;
  if (share.origin !== origin) throw new HttpError(400, '分享链接的来源与 Hub 的 KISSTOY_ORIGIN 不一致');
  const url = new URL(KISSTOY_PATH[action], origin);
  if (action === 'device') url.searchParams.set('id', share.deviceId);
  try {
    const response = await fetch(url, {
      method: action === 'device' ? 'GET' : 'POST',
      headers: action === 'bind' ? { 'Content-Type': 'application/json' } : undefined,
      body: action === 'bind' ? JSON.stringify({ id: share.id }) : undefined,
      signal: AbortSignal.timeout(15_000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`KISSTOY HTTP ${response.status}`);
    const result = await response.json() as { code: number; msg?: string; data: unknown };
    if (result.code !== 1) throw new Error(result.msg || '分享已失效，请在 KISSTOY App 重新生成链接');
    return json(action === 'device' ? result.data : { ok: true });
  } catch (e) {
    throw new HttpError(502, e instanceof Error ? e.message : 'KISSTOY 遥控服务连接失败');
  }
}
