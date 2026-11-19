import html from './relay.html';
import type { Env } from './env.ts';

/**
 * Intiface 中转页（GET /relay，页面本身见 relay.html）：iPhone、iPad 上的浏览器不让 https 页面连 ws://127.0.0.1，
 * 这一页用 http 打开、放在最外层，全屏 iframe 套着 App（APP_URL），替它连 Intiface Central。
 * 要用 http 打开：给 Worker 绑一个自己的域名，那个域名不开 Always Use HTTPS / HSTS（workers.dev 整个 .dev 都强制 https）。
 */
export function relayPage(env: Env): Response {
  const app = env.APP_URL.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const page = html.replace(/(<meta name="relay-app" content=")[^"]*(")/, (_, open: string, close: string) => `${open}${app}${close}`);
  return new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
}
