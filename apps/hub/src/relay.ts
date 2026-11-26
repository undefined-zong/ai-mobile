import { relayHosts } from '@app/ai';
import { RELAY_HEADERS, RELAY_MARK } from '@app/shared';
import type { Env } from './env.ts';
import { assert, HttpError } from './http.ts';

/** 能转发到哪些主机：不让浏览器直连的渠道的默认地址，加上 wrangler.jsonc 里 RELAY_HOSTS 填的（逗号隔开） */
function allowedHosts(env: Env): Set<string> {
  const extra = (env.RELAY_HOSTS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return new Set([...relayHosts(), ...extra]);
}

/**
 * POST /v1/relay：把 App 的请求原样转给不让浏览器直连的服务，回应原样带回去（流式也照样流）。
 * 只转发 allowedHosts 里的 https 主机，不是开放代理；Key 只随这次请求经过，Hub 不存。
 */
export async function relay(request: Request, env: Env): Promise<Response> {
  let target: URL;
  try {
    target = new URL(request.headers.get(RELAY_HEADERS.url) ?? '');
  } catch {
    throw new HttpError(400, '转发地址不对');
  }
  assert(target.protocol === 'https:' && !target.username && !target.password, '只转发 https 地址');
  const allowed = allowedHosts(env);
  if (!allowed.has(target.host.toLowerCase())) {
    throw new HttpError(403, `Hub 不转发 ${target.host}：现在只转发 ${[...allowed].join('、') || '（没有）'}，要加就写进 wrangler.jsonc 的 RELAY_HOSTS 再部署`);
  }
  const method = (request.headers.get(RELAY_HEADERS.method) || 'POST').toUpperCase();
  assert(/^(GET|POST|PUT|PATCH|DELETE)$/.test(method), '转发的请求方法不对');
  let forwarded: Record<string, string> = {};
  const packed = request.headers.get(RELAY_HEADERS.headers);
  if (packed) {
    try {
      forwarded = JSON.parse(decodeURIComponent(packed)) as Record<string, string>;
    } catch {
      throw new HttpError(400, '转发的请求头不对');
    }
    assert(forwarded && typeof forwarded === 'object' && !Array.isArray(forwarded) && Object.values(forwarded).every((v) => typeof v === 'string'), '转发的请求头不对');
  }
  const headers = new Headers(forwarded);
  // 请求体是 FormData 之类时，浏览器把带 boundary 的类型写在外层请求上
  const type = request.headers.get('Content-Type');
  if (type && !headers.has('Content-Type')) headers.set('Content-Type', type);
  let res: Response;
  try {
    res = await fetch(target, { method, headers, body: method === 'GET' ? undefined : await request.arrayBuffer() });
  } catch (e) {
    throw new HttpError(502, `Hub 连不上 ${target.host}：${e instanceof Error ? e.message : String(e)}`);
  }
  const back = new Headers({ 'Cache-Control': 'no-store', [RELAY_MARK]: '1' });
  const contentType = res.headers.get('Content-Type');
  if (contentType) back.set('Content-Type', contentType);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: back });
}
