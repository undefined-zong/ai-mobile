/**
 * 心跳的玩具中转：Worker（apps/hub/src/toyRelay.ts）、手机上的 App（services/intiface.ts）、电脑上的桥接页（services/toyBridge.ts）共用的约定。
 * 手机经自己 Worker 上的中转（wss），连电脑上桥接页开着的 Intiface Central；Buttplug 消息（JSON 数组）原样转，中转自己说的话是下面这些对象。
 */

export const TOY_RELAY_API = {
  /** 中转的 WebSocket（凭票，票放在 ?ticket=） */
  relay: '/v1/toys/relay',
  /** App 换票（登录了 Worker 的设备） */
  ticket: '/v1/toys/ticket',
  /** 看（GET）/ 换（POST）桥接链接里的密钥（登录了 Worker 的设备） */
  bridgeKey: '/v1/toys/bridge',
  /** 桥接页换票（凭桥接链接里的密钥，不用登录） */
  bridgeTicket: '/v1/toys/bridge/ticket',
} as const;

/** 中转的 WebSocket 是哪一边连的：手机上的 App / 电脑上的桥接页 */
export type ToyRelayRole = 'app' | 'bridge';

/** 中转关掉一条连接时用的代码 */
export const TOY_RELAY_CLOSE = {
  /** 同一边又连上来一个（另一台手机、另一个桥接页），旧的被顶掉 */
  replaced: 4000,
  /** 桥接链接换过了，旧链接打开的桥接页断开 */
  keyRotated: 4003,
} as const;

/** 中转自己说的话 */
export type ToyRelayMessage =
  /** 中转 → App：电脑上的桥接页在不在 */
  | { relay: 'bridge'; up: boolean }
  /** 中转 → 桥接页：App 连上来了（重新连一次 Intiface，每台 App 自己握手）/ App 都走了（断开 Intiface，玩具会停） */
  | { relay: 'open' }
  | { relay: 'close' }
  /** 桥接页 → App：连好 Intiface 了，可以握手 / 连不上 Intiface（原因） */
  | { relay: 'ready' }
  | { relay: 'error'; message: string };

/** 收到的一条：Buttplug 消息（数组）、中转的话，或者都不是（null） */
export function readToyRelay(data: unknown): { buttplug: unknown[] } | { control: ToyRelayMessage } | null {
  if (typeof data !== 'string') return null;
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (Array.isArray(v)) return { buttplug: v };
  const m = v as Partial<Record<string, unknown>> | null;
  switch (m?.relay) {
    case 'bridge':
      return typeof m.up === 'boolean' ? { control: { relay: 'bridge', up: m.up } } : null;
    case 'open':
    case 'close':
    case 'ready':
      return { control: { relay: m.relay } };
    case 'error':
      return { control: { relay: 'error', message: typeof m.message === 'string' ? m.message : '' } };
    default:
      return null;
  }
}
