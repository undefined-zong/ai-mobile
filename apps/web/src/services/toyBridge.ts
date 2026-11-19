import { readToyRelay, TOY_RELAY_API, TOY_RELAY_CLOSE, type ToyRelayMessage } from '@app/shared';
import { blockedReason, connectError, DEFAULT_INTIFACE_ADDRESS, normalizeIntifaceUrl, relayTarget, socketThrown } from './intiface';

/**
 * 电脑上的玩具桥接页（iPhone 连 Intiface Central 用；中转在 apps/hub/src/toyRelay.ts）。
 * 这一页开在装着 Intiface Central 的电脑上：一头连本机的 Intiface（ws://127.0.0.1:12345，电脑上的 Chrome / Edge / Firefox 允许），
 * 一头用 wss 连自己 Worker 上的中转；手机上的 App 也连那个中转，两边的 Buttplug 消息原样转过去。
 * - 中转说手机连上了（open）：重新连一次 Intiface，连好告诉手机（ready），连不上把原因告诉手机（error）；
 * - 中转说手机走了（close）：断开 Intiface（Intiface 会让玩具停下）；
 * - 和中转断了自己重连（每次重新换票）；桥接链接失效、被别的桥接页顶掉时停下，写明原因；
 * - 打开页面时先试连一下 Intiface：浏览器要问"允许访问本地网络设备"时，人还在电脑前。
 * 桥接页不登录 Worker：桥接链接里带着 Worker 地址和只能当桥用的密钥（在手机的心跳设置 → 玩具里复制）。
 */

/** 桥接页在 App 里的路由（桥接链接指向这里） */
export const TOY_BRIDGE_ROUTE = '/toy-bridge';
/** 桥接页上填的 Intiface 地址存在本机的这个键 */
const ADDRESS_KEY = 'ai-mobile:toy-bridge';
/** 和中转断了以后，第几次重连等多久 */
const RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
/** 连本机 Intiface 最多等多久 */
const INTIFACE_TIMEOUT_MS = 6000;
/** 电脑上的浏览器连不了本机 ws:// 时怎么办 */
const WEBKIT_FIX = '这一页换 Chrome / Edge / Firefox 打开。';

export interface BridgeStatus {
  /** 在桥接（点了"停下"、链接失效、被别的桥接页顶掉时为 false） */
  running: boolean;
  /** 和自己 Worker 上的中转 */
  relay: 'off' | 'connecting' | 'up';
  /** 手机连着中转 */
  phone: boolean;
  /** 本机的 Intiface：没连着 / 在连 / 手机正在用 */
  intiface: 'idle' | 'connecting' | 'busy';
  /** 上一次连 Intiface 成功了没有（还没试过为 null） */
  intifaceOk: boolean | null;
  /** 停下的原因、最近一次出的错 */
  error: string;
  /** 转过多少条 Buttplug 消息（两个方向） */
  forwarded: number;
}

export function emptyBridgeStatus(): BridgeStatus {
  return { running: false, relay: 'off', phone: false, intiface: 'idle', intifaceOk: null, error: '', forwarded: 0 };
}

/** 桥接链接：App 的地址 + 桥接页的路由，带上 Worker 地址和桥接密钥（都在 # 后面，不发给网页服务器） */
export function toyBridgeLink(appUrl: string, hub: string, key: string): string {
  const base = new URL(appUrl);
  base.hash = '';
  base.search = '';
  return `${base.toString()}#${TOY_BRIDGE_ROUTE}?${new URLSearchParams({ hub, key }).toString()}`;
}

/** 从桥接页地址上读 Worker 地址和密钥；不全、不对时为 null */
export function readBridgeParams(query: Record<string, unknown>): { hub: string; key: string } | null {
  const hub = typeof query.hub === 'string' ? query.hub : '';
  const key = typeof query.key === 'string' ? query.key : '';
  if (!/^[\w-]{16,128}$/.test(key)) return null;
  try {
    const u = new URL(hub);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u.hostname)) return null;
    return { hub: u.origin, key };
  } catch {
    return null;
  }
}

export function loadBridgeAddress(): string {
  try {
    return localStorage.getItem(ADDRESS_KEY) || DEFAULT_INTIFACE_ADDRESS;
  } catch {
    return DEFAULT_INTIFACE_ADDRESS;
  }
}

export function saveBridgeAddress(address: string): void {
  try {
    localStorage.setItem(ADDRESS_KEY, address.trim());
  } catch {
    // 存不下：这次打开仍然有效
  }
}

const text = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class ToyBridge {
  private relay: WebSocket | null = null;
  private intiface: WebSocket | null = null;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly hub: string;
  private readonly key: string;
  private readonly address: () => string;
  /** 页面上显示的状态（传进来的是 reactive 对象，改了界面跟着变） */
  readonly status: BridgeStatus;

  constructor(opts: { hub: string; key: string; address: () => string; status: BridgeStatus }) {
    this.hub = opts.hub;
    this.key = opts.key;
    this.address = opts.address;
    this.status = opts.status;
  }

  start(): void {
    if (this.status.running) return;
    this.status.running = true;
    this.retries = 0;
    this.status.error = '';
    void this.connectRelay();
    this.checkIntiface();
  }

  /** 停下：断开中转和 Intiface；reason 写在页面上 */
  stop(reason = ''): void {
    this.status.running = false;
    clearTimeout(this.retryTimer);
    const relay = this.relay;
    this.relay = null;
    if (relay) {
      relay.onopen = relay.onmessage = relay.onerror = relay.onclose = null;
      try {
        relay.close(1000);
      } catch {
        // 已经关了
      }
    }
    this.closeIntiface();
    this.status.relay = 'off';
    this.status.phone = false;
    if (reason) this.status.error = reason;
  }

  /** 再连一次本机的 Intiface：手机连着时是给手机连（连好告诉它），没连时只试一下能不能连上 */
  checkIntiface(): void {
    if (this.status.intiface === 'busy') return;
    this.openIntiface(this.status.phone);
  }

  private async connectRelay() {
    if (!this.status.running) return;
    this.status.relay = 'connecting';
    let ticket: string;
    try {
      const res = await fetch(new URL(TOY_RELAY_API.bridgeTicket, this.hub), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: this.key }),
        signal: AbortSignal.timeout(15_000),
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as { ticket?: string; error?: string };
      // 链接不对、失效了（换过），或者 Worker 还没有中转：重连也没用
      if (res.status === 400 || res.status === 401 || res.status === 404) {
        this.stop(res.status === 404 ? '这个 Worker 还没有玩具中转：重新部署一次 Worker（推到 main 会自动部署）。' : data.error || `Worker 不认这条桥接链接（HTTP ${res.status}）`);
        return;
      }
      if (!res.ok || !data.ticket) throw new Error(data.error || `HTTP ${res.status}`);
      ticket = data.ticket;
    } catch (e) {
      this.retryLater(`连不上自己的 Worker（${text(e)}）`);
      return;
    }
    if (!this.status.running) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(relayTarget(this.hub, ticket).url);
    } catch (e) {
      this.retryLater(`连不上玩具中转（${socketThrown(e)}）`);
      return;
    }
    this.relay = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.status.relay = 'up';
      this.status.error = '';
    };
    ws.onmessage = (e) => this.fromRelay(e.data);
    ws.onclose = (e) => {
      if (this.relay !== ws) return;
      this.relay = null;
      this.status.relay = 'off';
      this.status.phone = false;
      this.closeIntiface();
      if (e.code === TOY_RELAY_CLOSE.replaced) this.stop('这条桥接链接在别的页面（或别的电脑）上打开了，这一页先停下。要用这一页就点"开始桥接"。');
      else if (e.code === TOY_RELAY_CLOSE.keyRotated) this.stop('桥接链接换过了，这一页的链接已经失效：在手机的心跳设置 → 玩具里重新复制。');
      else this.retryLater(`和玩具中转的连接断了（${e.code}）`);
    };
  }

  private retryLater(why: string) {
    if (!this.status.running) return;
    const delay = RETRY_MS[Math.min(this.retries, RETRY_MS.length - 1)]!;
    this.retries++;
    this.status.relay = 'off';
    this.status.error = `${why}，${Math.round(delay / 1000)} 秒后重连`;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connectRelay(), delay);
  }

  private sendRelay(data: string | ToyRelayMessage) {
    const ws = this.relay;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(typeof data === 'string' ? data : JSON.stringify(data));
    } catch {
      // 断了：关闭事件会重连
    }
  }

  private fromRelay(data: unknown) {
    const got = readToyRelay(data);
    if (!got) return;
    if ('buttplug' in got) {
      const ws = this.intiface;
      if (this.status.intiface === 'busy' && ws?.readyState === WebSocket.OPEN && typeof data === 'string') {
        ws.send(data);
        this.status.forwarded++;
      }
      return;
    }
    if (got.control.relay === 'open') {
      this.status.phone = true;
      this.openIntiface(true);
    } else if (got.control.relay === 'close') {
      this.status.phone = false;
      this.closeIntiface();
    }
  }

  /** 连本机的 Intiface：forPhone 时连好告诉手机、开始转消息；否则只是试一下，连上就断开 */
  private openIntiface(forPhone: boolean) {
    this.closeIntiface();
    const failed = (message: string) => {
      this.status.intiface = 'idle';
      this.status.intifaceOk = false;
      this.status.error = message;
      if (forPhone) this.sendRelay({ relay: 'error', message });
    };
    const target = normalizeIntifaceUrl(this.address());
    if ('error' in target) return failed(target.error);
    const blocked = blockedReason(target);
    if (blocked) return failed(blocked);
    let ws: WebSocket;
    try {
      ws = new WebSocket(target.url);
    } catch (e) {
      return failed(connectError(target, socketThrown(e), WEBKIT_FIX));
    }
    this.intiface = ws;
    this.status.intiface = 'connecting';
    let opened = false;
    const timer = setTimeout(() => {
      if (this.intiface !== ws) return;
      this.closeIntiface();
      failed(connectError(target, `${INTIFACE_TIMEOUT_MS / 1000} 秒没有回应`, WEBKIT_FIX));
    }, INTIFACE_TIMEOUT_MS);
    ws.onopen = () => {
      clearTimeout(timer);
      opened = true;
      this.status.intifaceOk = true;
      if (!forPhone) {
        this.closeIntiface();
        return;
      }
      this.status.intiface = 'busy';
      this.status.error = '';
      this.sendRelay({ relay: 'ready' });
    };
    ws.onmessage = (e) => {
      if (!forPhone || typeof e.data !== 'string') return;
      this.sendRelay(e.data);
      this.status.forwarded++;
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      if (this.intiface !== ws) return;
      this.intiface = null;
      failed(opened ? `本机的 Intiface Central 断开了（${e.code}）` : connectError(target, '连接被拒绝或中断', WEBKIT_FIX));
    };
  }

  /** 断开本机的 Intiface（自己断的，不算出错） */
  private closeIntiface() {
    const ws = this.intiface;
    this.intiface = null;
    this.status.intiface = 'idle';
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
    try {
      ws.close(1000);
    } catch {
      // 已经关了
    }
  }
}
