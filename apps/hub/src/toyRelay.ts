import { TOY_RELAY_API, TOY_RELAY_CLOSE, type ToyRelayMessage, type ToyRelayRole } from '@app/shared';
import { DurableObject } from 'cloudflare:workers';
import { equalSecret, randomKey, signTicket, verifyTicket } from './crypto.ts';
import type { Env } from './env.ts';
import { assert, HttpError, json, readJson } from './http.ts';

/**
 * 心跳的玩具中转（iPhone 连 Intiface Central 用）。
 * iPhone 上的浏览器都是 WebKit：https 页面连没加密的 ws:// 会被拦下（连本机 127.0.0.1 也一样），Intiface Central 又只有 ws://。
 * 所以在装着 Intiface Central 的电脑上开一个"桥接页"（电脑上的 Chrome / Edge / Firefox 允许连本机的 ws://127.0.0.1），
 * 桥接页和手机上的 App 都用 wss 连到这里，这个 Durable Object 把两边的 Buttplug 消息原样转过去。
 * - 同一时间一个桥接页、一台 App，新连上来的顶掉旧的；
 * - App 连上（或者换了一台）时让桥接页重新连一次 Intiface，每台 App 自己握手；App 走了让桥接页断开 Intiface（Intiface 会让玩具停下）；
 * - 中转自己说的话是带 relay 的对象，Buttplug 消息是数组：App 发来的只转数组，桥接页发来的原样转给 App。
 * 进来要凭票（60 秒内有效，放在地址上）：App 用登录 Worker 的 token 换，桥接页用桥接链接里的密钥换（桥接页不登录 Worker）。
 */

const TICKET_PURPOSE = 'toy-relay';
const TICKET_TTL_MS = 60_000;
/** 存桥接链接密钥的键 */
const BRIDGE_KEY = 'bridgeKey';

function send(ws: WebSocket, data: string | ToyRelayMessage) {
  try {
    ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  } catch {
    // 这条连接已经关了：它的关闭事件会处理
  }
}

function close(ws: WebSocket, code: number, reason: string) {
  try {
    ws.close(code, reason);
  } catch {
    // 已经关了
  }
}

export class ToyRelay extends DurableObject<Env> {
  /** 这一边现在开着的连接 */
  private sockets(role: ToyRelayRole): WebSocket[] {
    return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  private roleOf(ws: WebSocket): ToyRelayRole | null {
    const tag = this.ctx.getTags(ws)[0];
    return tag === 'app' || tag === 'bridge' ? tag : null;
  }

  private broadcast(role: ToyRelayRole, data: string | ToyRelayMessage) {
    for (const ws of this.sockets(role)) send(ws, data);
  }

  async fetch(request: Request): Promise<Response> {
    const role = new URL(request.url).searchParams.get('role');
    if ((role !== 'app' && role !== 'bridge') || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response(null, { status: 400 });
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);
    for (const old of this.sockets(role)) if (old !== server) close(old, TOY_RELAY_CLOSE.replaced, 'replaced');
    if (role === 'bridge') {
      this.broadcast('app', { relay: 'bridge', up: true });
      if (this.sockets('app').length) send(server, { relay: 'open' });
    } else {
      const bridges = this.sockets('bridge');
      send(server, { relay: 'bridge', up: bridges.length > 0 });
      for (const b of bridges) send(b, { relay: 'open' });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    // 被顶掉、正在关的连接再发来的不转（多半是旧会话的）
    if (typeof message !== 'string' || ws.readyState !== WebSocket.OPEN) return;
    const role = this.roleOf(ws);
    if (role === 'app' && message.trimStart().startsWith('[')) this.broadcast('bridge', message);
    else if (role === 'bridge') this.broadcast('app', message);
  }

  webSocketClose(ws: WebSocket): void {
    this.left(ws);
  }

  webSocketError(ws: WebSocket): void {
    this.left(ws);
  }

  /** 一边走了：桥接页都走了告诉 App，App 都走了让桥接页断开 Intiface（被新连接顶掉的不算走了） */
  private left(ws: WebSocket) {
    const role = this.roleOf(ws);
    close(ws, 1000, '');
    if (!role || this.sockets(role).some((s) => s !== ws)) return;
    if (role === 'bridge') this.broadcast('app', { relay: 'bridge', up: false });
    else this.broadcast('bridge', { relay: 'close' });
  }

  /** 桥接链接里的密钥：第一次要时生成 */
  bridgeKey(): string {
    const saved = this.ctx.storage.kv.get<string>(BRIDGE_KEY);
    if (saved) return saved;
    const key = randomKey();
    this.ctx.storage.kv.put(BRIDGE_KEY, key);
    return key;
  }

  /** 换一个桥接链接：旧链接打开的桥接页马上断开 */
  rotateBridgeKey(): string {
    const key = randomKey();
    this.ctx.storage.kv.put(BRIDGE_KEY, key);
    const bridges = this.sockets('bridge');
    for (const b of bridges) close(b, TOY_RELAY_CLOSE.keyRotated, 'key rotated');
    if (bridges.length) this.broadcast('app', { relay: 'bridge', up: false });
    return key;
  }

  async checkBridgeKey(key: string): Promise<boolean> {
    const saved = this.ctx.storage.kv.get<string>(BRIDGE_KEY);
    return !!saved && (await equalSecret(key, saved));
  }
}

const relay = (env: Env) => env.TOY_RELAY.get(env.TOY_RELAY.idFromName('toys'));

async function ticket(env: Env, role: ToyRelayRole): Promise<Response> {
  if (!env.KEK) throw new HttpError(503, 'Worker 尚未设置 HUB_PASSWORD / KEK');
  return json({ ticket: await signTicket(env.KEK, TICKET_PURPOSE, role, TICKET_TTL_MS) });
}

/** 不用登录的两个：中转的 WebSocket（凭票）、电脑上的桥接页换票（凭桥接链接里的密钥） */
export async function toyRelayPublic(request: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === TOY_RELAY_API.relay && request.method === 'GET') {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') throw new HttpError(426, '这个地址要用 WebSocket 连');
    const role = env.KEK ? await verifyTicket(env.KEK, TICKET_PURPOSE, url.searchParams.get('ticket') ?? '') : null;
    if (role !== 'app' && role !== 'bridge') throw new HttpError(401, '中转的票不对或者过期了，重新连一次');
    const target = new URL(request.url);
    target.search = `?role=${role}`;
    return relay(env).fetch(new Request(target.toString(), { headers: request.headers }));
  }
  if (url.pathname === TOY_RELAY_API.bridgeTicket && request.method === 'POST') {
    const { key } = await readJson<{ key?: unknown }>(request, 4096);
    assert(typeof key === 'string' && /^[\w-]{16,128}$/.test(key), '桥接链接不完整：在 App 的心跳设置 → 玩具里重新复制一次');
    if (!(await relay(env).checkBridgeKey(key))) throw new HttpError(401, '桥接链接失效了（可能换过）：在 App 的心跳设置 → 玩具里重新复制一次');
    return ticket(env, 'bridge');
  }
  throw new HttpError(404, '接口不存在');
}

/** 登录了的设备：App 换票、看 / 换电脑上桥接页的链接密钥 */
export async function toyRelayApi(request: Request, env: Env, path: string): Promise<Response> {
  if (path === TOY_RELAY_API.ticket && request.method === 'POST') return ticket(env, 'app');
  if (path === TOY_RELAY_API.bridgeKey && request.method === 'GET') return json({ key: await relay(env).bridgeKey() });
  if (path === TOY_RELAY_API.bridgeKey && request.method === 'POST') return json({ key: await relay(env).rotateBridgeKey() });
  throw new HttpError(404, '接口不存在');
}
