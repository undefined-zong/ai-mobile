import { uid } from '@/utils/id';

/**
 * 外层的 Intiface 中转页（apps/hub/src/relay.html，Worker 的 /relay 提供，也能放到别处）：
 * iPhone、iPad 上的浏览器不让 https 页面连 ws://127.0.0.1（混合内容）。中转页用 http 打开、放在最外层，
 * 全屏 iframe 套着这个 App，替它连 Intiface Central，消息用 postMessage 来回转。
 * - 握手：启动时向外层问一声（hello），中转页回 ready；之后只和这个来源的外层说话。
 *   中转页收到 hello、bye（这个页面刷新、跳走）时关掉之前开的连接：Intiface 只认一个客户端，断开时玩具也停。
 * - RelaySocket：IntifaceClient 的 WebSocket 换成它，经过中转页连。
 * - 配色、名字、图标跟到外层：iOS 状态栏和底部横条那两截是外层的底色，加到主屏幕时用外层的名字和图标。
 * 套在中转页里时这个页面不算安全上下文（最外层是 http）：数据和直接打开的那份分开存，麦克风、推送这些用不了。
 */

/** 和中转页约好的频道名、版本 */
const CHANNEL = 'ai-mobile-relay';
const VERSION = 1;
/** 等中转页回话最多多久：被别的页面嵌着（没人回）时之后按直接连 */
const WAIT_MS = 2000;

interface Packet {
  ch: typeof CHANNEL;
  type: string;
  id?: unknown;
  [key: string]: unknown;
}

export interface Relay {
  /** 中转页的来源（http://…） */
  origin: string;
  /** 中转页的协议版本（以后协议有变化时按这个判断） */
  version: number;
  /** 经过中转页开一条连接，用法和 WebSocket 一样 */
  open(url: string): RelaySocket;
}

let found: Relay | null = null;
let asking: Promise<void> | undefined;
const sockets = new Map<string, RelaySocket>();

function post(msg: Record<string, unknown>) {
  if (found) window.parent.postMessage({ ...msg, ch: CHANNEL }, found.origin);
}

/** 经过中转页的一条连接：只做 IntifaceClient 用到的那几样（readyState、send、close、四个回调） */
export class RelaySocket {
  readonly id = uid('ws');
  readyState: number = WebSocket.CONNECTING;
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;

  constructor(url: string) {
    sockets.set(this.id, this);
    post({ type: 'connect', id: this.id, url });
  }

  send(data: string) {
    if (this.readyState === WebSocket.CONNECTING) throw new DOMException('还没连上', 'InvalidStateError');
    if (this.readyState === WebSocket.OPEN) post({ type: 'send', id: this.id, data });
  }

  close() {
    if (this.readyState >= WebSocket.CLOSING) return;
    this.readyState = WebSocket.CLOSING;
    post({ type: 'close', id: this.id });
  }

  /** 中转页那边这条连接的事 */
  receive(m: Packet) {
    if (m.type === 'open') {
      this.readyState = WebSocket.OPEN;
      this.onopen?.(new Event('open'));
    } else if (m.type === 'message' && typeof m.data === 'string') {
      this.onmessage?.(new MessageEvent('message', { data: m.data }));
    } else if (m.type === 'error') {
      this.onerror?.(new Event('error'));
    } else if (m.type === 'close') {
      this.readyState = WebSocket.CLOSED;
      sockets.delete(this.id);
      this.onclose?.(new CloseEvent('close', { code: typeof m.code === 'number' ? m.code : 1006, reason: typeof m.reason === 'string' ? m.reason : '' }));
    }
  }
}

function receive(e: MessageEvent) {
  const m = e.data as Packet | null;
  if (e.source !== window.parent || !m || typeof m !== 'object' || m.ch !== CHANNEL) return;
  if (!found) {
    // 从本地文件打开的中转页来源是 "null"，没法指定只发给它：不用（中转页要从 http:// 地址打开）
    if (m.type !== 'ready' || e.origin === 'null') return;
    found = { origin: e.origin, version: typeof m.v === 'number' ? m.v : 1, open: (url) => new RelaySocket(url) };
    mirrorMeta();
    return;
  }
  if (e.origin === found.origin && typeof m.id === 'string') sockets.get(m.id)?.receive(m);
}

/** 这个页面的配色（theme-color，跟着配色变）、标题、图标交给外层；有变化再发 */
function mirrorMeta() {
  let last = '';
  const send = () => {
    const meta = {
      theme: document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.content ?? '',
      title: document.title,
      icon: document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href ?? '',
    };
    const json = JSON.stringify(meta);
    if (json === last) return;
    last = json;
    post({ type: 'meta', ...meta });
  };
  send();
  new MutationObserver(send).observe(document.head, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['content', 'href'] });
}

/**
 * 外层是不是中转页：第一次调用时问（启动时 main.ts 就问），最多等 WAIT_MS；之后直接给结果。
 * 没被嵌着、外层不回话时为 null（按直接连）。回话晚了也记下，下次连接就经过它
 */
export function findRelay(): Promise<Relay | null> {
  if (typeof window === 'undefined' || window.parent === window) return Promise.resolve(null);
  asking ??= new Promise<void>((resolve) => {
    window.addEventListener('message', (e) => {
      receive(e);
      if (found) resolve();
    });
    // 这个页面要走了（刷新、跳到授权页）：中转页关掉它替这个页面开的连接
    window.addEventListener('pagehide', () => post({ type: 'bye' }));
    // 还不知道外层是谁：只说一声"在吗"，不带别的
    window.parent.postMessage({ ch: CHANNEL, type: 'hello', v: VERSION }, '*');
    setTimeout(resolve, WAIT_MS);
  });
  return asking.then(() => found);
}
