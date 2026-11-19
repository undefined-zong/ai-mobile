import { readToyRelay, TOY_RELAY_API, TOY_RELAY_CLOSE, type ScalarKind, type ToyRelayMessage } from '@app/shared';
import { platform } from '@/pwa';

/**
 * Intiface Central 的客户端（心跳用，设计文档 §9.14）：Buttplug 协议 v3，JSON 走 WebSocket。
 * 没用官方的 buttplug-js（几十 KB、带一串依赖），只做心跳要用的：
 * 握手（RequestServerInfo）、扫描、设备列表和增减、ScalarCmd（震动 / 摆动 / 旋转 / 收缩 / 充气）、LinearCmd（伸缩）、
 * RotateCmd（带方向的旋转）、停下（单个 / 全部）、读电量、按服务器要求定时 Ping。
 * 协议说明：https://buttplug-spec.docs.buttplug.io/
 *
 * 地址：Intiface Central 默认在 127.0.0.1:12345（设置里打开"所有网卡"才能从别的设备连）。
 * 页面是 https 时浏览器只让连 ws://127.0.0.1 / localhost 和 wss://（混合内容），连局域网别的电脑要 wss；
 * iPhone / iPad 上的浏览器（都是 WebKit）和 Mac 上的 Safari 连本机的 ws:// 也拦，Intiface 又只有 ws://，这时经云端中转：
 * 电脑上开桥接页连本机的 Intiface，手机连自己 Worker 上的中转（wss），Buttplug 消息原样转（apps/hub/src/toyRelay.ts、services/toyBridge.ts）。
 * 连不上、被拦时把原因写清楚（见 blockedReason / connectError）。
 */

/** 设备的一项能力：在这条消息的属性列表里的位置（Index）、能分几档 */
export interface ToyFeature {
  /** 在 ScalarCmd / LinearCmd / RotateCmd 属性列表里的位置 */
  index: number;
  /** 震动、摆动……；linear 是伸缩（LinearCmd，或者 ScalarCmd 里的 Position） */
  kind: ScalarKind | 'linear';
  /** 用哪条消息控制 */
  via: 'scalar' | 'linear' | 'rotate';
  /** ScalarCmd 的 ActuatorType 原文 */
  actuator: string;
  steps: number;
  /** 设备自己写的说明（"Clitoral Stimulator"） */
  descriptor: string;
}

export interface ToyDevice {
  index: number;
  name: string;
  features: ToyFeature[];
  /** 电量传感器在 SensorReadCmd 里的位置；没有为 null */
  batterySensor: number | null;
  /** 两条消息之间至少隔多久（毫秒，设备给的） */
  gapMs: number;
}

export interface ScalarSub {
  Index: number;
  Scalar: number;
  ActuatorType: string;
}
export interface LinearSub {
  Index: number;
  Duration: number;
  Position: number;
}
export interface RotateSub {
  Index: number;
  Speed: number;
  Clockwise: boolean;
}

const ACTUATOR_KIND: Record<string, ToyFeature['kind'] | undefined> = {
  Vibrate: 'vibrate',
  Oscillate: 'oscillate',
  Rotate: 'rotate',
  Constrict: 'constrict',
  Inflate: 'inflate',
  Position: 'linear',
};

type Msg = Record<string, Record<string, unknown>>;
type Obj = Record<string, unknown>;

interface Pending {
  resolve(body: Obj, type: string): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_PORT = '12345';
/** 没填地址时连的：这台设备上的 Intiface Central */
export const DEFAULT_INTIFACE_ADDRESS = `127.0.0.1:${DEFAULT_PORT}`;
/** 经云端中转时，等电脑上的桥接页连好 Intiface 最多多久（它自己连 Intiface 最多等 6 秒） */
const RELAY_READY_MS = 12_000;

/** 连到哪：normalizeIntifaceUrl 给的直连地址，或者 relayTarget 给的中转地址 */
export interface IntifaceTarget {
  url: string;
  host: string;
  loopback: boolean;
  secure: boolean;
  /** 经云端中转：连上以后先等电脑上的桥接页连好 Intiface，再握手 */
  relay?: boolean;
}

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** 你填的地址 → WebSocket 地址：127.0.0.1:12345 / 192.168.1.5 / ws://… / wss://…（没写端口时 ws 用 12345） */
export function normalizeIntifaceUrl(input: string): IntifaceTarget | { error: string } {
  let t = input.trim() || DEFAULT_INTIFACE_ADDRESS;
  if (/^https?:\/\//i.test(t)) t = t.replace(/^http/i, 'ws');
  if (!/^wss?:\/\//i.test(t)) t = `ws://${t}`;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return { error: '地址看不懂：写成 127.0.0.1:12345，或者 ws://192.168.1.5:12345、wss://…' };
  }
  if (!u.port && u.protocol === 'ws:') u.port = DEFAULT_PORT;
  return { url: u.toString().replace(/\/$/, ''), host: u.host, loopback: isLoopback(u.hostname), secure: u.protocol === 'wss:' };
}

/** 经云端中转时连的地址：自己 Worker 上的中转（https → wss），带上刚换来的票 */
export function relayTarget(hub: string, ticket: string): IntifaceTarget {
  const u = new URL(TOY_RELAY_API.relay, hub);
  u.protocol = u.protocol === 'http:' ? 'ws:' : 'wss:';
  u.searchParams.set('ticket', ticket);
  return { url: u.toString(), host: u.host, loopback: false, secure: u.protocol === 'wss:', relay: true };
}

/** 这个页面是 https、地址是没加密的 ws://，而浏览器是 WebKit（iPhone / iPad 上的所有浏览器、Mac 上的 Safari）：连本机也会被拦 */
function webkitBlocks(target: { secure: boolean }): boolean {
  if (typeof location === 'undefined' || location.protocol !== 'https:' || target.secure) return false;
  const ua = navigator.userAgent;
  return platform() === 'ios' || (/Safari\//.test(ua) && !/Chrome\/|Chromium\/|Edg\/|OPR\/|Firefox\//.test(ua));
}

/** 浏览器会不会直接拦下这个地址（https 页面连没加密的局域网地址）：会的话返回原因 */
export function blockedReason(target: { host: string; loopback: boolean; secure: boolean }): string | null {
  if (typeof location === 'undefined' || location.protocol !== 'https:' || target.secure || target.loopback) return null;
  return `这个页面是 https，浏览器不让它连没加密的 ws://${target.host}。可以：连接方式改成"经云端中转"（电脑上开桥接页）；在这台设备上开 Intiface Central（地址填 ${DEFAULT_INTIFACE_ADDRESS}）；或者给 Intiface 套一层 https（例如 Caddy、cloudflared），地址填 wss://…`;
}

/**
 * 连不上时说清楚可能是哪一步。
 * webkitFix：浏览器是 WebKit、会拦 ws:// 时怎么办（默认是手机上改用经云端中转；电脑上的桥接页换一个浏览器）
 */
export function connectError(
  target: { url: string; loopback: boolean; secure: boolean },
  detail: string,
  webkitFix = '连接方式改成"经云端中转"，在装着 Intiface Central 的电脑上用 Chrome / Edge / Firefox 开桥接页。',
): string {
  const where = target.loopback ? '这台设备上的 Intiface Central' : `${target.url} 那边的 Intiface Central`;
  const steps = `看看${where}开着没有、点了 Start Server 没有、端口对不对（默认 ${DEFAULT_PORT}）${target.loopback ? '' : '，Intiface 设置里有没有打开"所有网卡"'}；浏览器问要不要允许访问本地网络设备时选允许。`;
  const webkit = webkitBlocks(target) ? `iPhone / iPad 上的浏览器和 Mac 上的 Safari 不让 https 页面连 ws://，连本机也不行（多半就是这个原因）：${webkitFix}` : '';
  return `连不上 ${target.url}（${detail}）。${webkit}${steps}`;
}

/** new WebSocket 抛出来的：浏览器直接拒绝（SecurityError）时说明是浏览器拦的 */
export function socketThrown(e: unknown): string {
  if (e instanceof DOMException && e.name === 'SecurityError') return '浏览器不让这个 https 页面连没加密的 ws://';
  return e instanceof Error ? e.message : String(e);
}

/** 经云端中转时，连不上中转本身 */
function relayError(detail: string): string {
  return `连不上自己 Worker 上的玩具中转（${detail}）：看看网络，以及 Worker 是不是最新的（推到 main 会自动部署）。`;
}

/** 连的时候电脑上的桥接页没开 */
const BRIDGE_DOWN = '电脑上的桥接页没开：在装着 Intiface Central 的电脑上用 Chrome / Edge / Firefox 打开桥接链接（心跳设置 → 玩具 → 经云端中转 → 复制），页面开着别关。';
/** 连着的时候电脑上的桥接页断了 */
const BRIDGE_LOST = '电脑上的桥接页断开了（页面关了、电脑睡着了或者断网了），再点一次连接';

function parseDevice(raw: Obj): ToyDevice | null {
  const index = typeof raw.DeviceIndex === 'number' ? raw.DeviceIndex : null;
  if (index === null) return null;
  const msgs = (raw.DeviceMessages ?? {}) as Record<string, unknown>;
  const list = (k: string): Obj[] => (Array.isArray(msgs[k]) ? (msgs[k] as unknown[]).filter((x): x is Obj => !!x && typeof x === 'object') : []);
  const features: ToyFeature[] = [];
  list('ScalarCmd').forEach((a, i) => {
    const actuator = String(a.ActuatorType ?? '');
    const kind = ACTUATOR_KIND[actuator];
    if (kind) features.push({ index: i, kind, via: 'scalar', actuator, steps: Number(a.StepCount) || 20, descriptor: String(a.FeatureDescriptor ?? '') });
  });
  list('RotateCmd').forEach((a, i) => features.push({ index: i, kind: 'rotate', via: 'rotate', actuator: 'Rotate', steps: Number(a.StepCount) || 20, descriptor: String(a.FeatureDescriptor ?? '') }));
  list('LinearCmd').forEach((a, i) => features.push({ index: i, kind: 'linear', via: 'linear', actuator: 'Position', steps: Number(a.StepCount) || 100, descriptor: String(a.FeatureDescriptor ?? '') }));
  const sensor = list('SensorReadCmd').findIndex((s) => s.SensorType === 'Battery');
  const name = String(raw.DeviceDisplayName || raw.DeviceName || `玩具 ${index}`);
  return { index, name, features, batterySensor: sensor >= 0 ? sensor : null, gapMs: Number(raw.DeviceMessageTimingGap) || 0 };
}

export interface IntifaceEvents {
  onDeviceAdded?(d: ToyDevice): void;
  onDeviceRemoved?(index: number): void;
  onScanningFinished?(): void;
  /** 连接断了（不是你点的断开）：原因（一整句，直接显示） */
  onClose?(reason: string): void;
}

export class IntifaceClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  /** 这次是经云端中转连的 */
  private relay = false;
  /** 经云端中转：在等电脑上的桥接页连好 Intiface */
  private relayWait: { resolve(): void; reject(e: Error): void } | null = null;
  serverName = '';
  readonly events: IntifaceEvents;

  constructor(events: IntifaceEvents = {}) {
    this.events = events;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.serverName;
  }

  /** 连上并握手（经云端中转时先等桥接页连好 Intiface）；失败时抛出写好原因的错误 */
  async connect(target: IntifaceTarget): Promise<void> {
    this.close();
    this.closing = false;
    this.relay = !!target.relay;
    const fail = (detail: string) => new Error(target.relay ? relayError(detail) : connectError(target, detail));
    let ws: WebSocket;
    try {
      ws = new WebSocket(target.url);
    } catch (e) {
      throw fail(socketThrown(e));
    }
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(fail('6 秒没有回应'));
        ws.close();
      }, 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(fail('连接被拒绝或中断'));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(fail(`连接关闭 ${e.code}`));
      };
    });
    ws.onmessage = (e) => this.receive(e.data);
    ws.onerror = null;
    ws.onclose = (e) => this.dropped(this.closeReason(e));
    if (target.relay) {
      await this.bridgeReady().catch((e: unknown) => {
        this.close();
        throw e;
      });
    }
    const info = await this.request('RequestServerInfo', { ClientName: 'ai-mobile 心跳', MessageVersion: 3 }, 8000).catch((e: unknown) => {
      this.close();
      throw new Error(`Intiface 没有完成握手：${e instanceof Error ? e.message : String(e)}`);
    });
    this.serverName = String(info.ServerName ?? 'Intiface');
    const maxPing = Number(info.MaxPingTime) || 0;
    if (maxPing > 0) this.pingTimer = setInterval(() => void this.request('Ping', {}).catch(() => undefined), Math.max(200, Math.floor(maxPing / 2)));
  }

  /** 经云端中转：等电脑上的桥接页说连好 Intiface 了（没开、连不上、不回应都抛出原因） */
  private bridgeReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.settleRelay(new Error(`电脑上的桥接页 ${RELAY_READY_MS / 1000} 秒没有回应：看看那个页面还开着没有、电脑是不是睡着了。`)), RELAY_READY_MS);
      this.relayWait = {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      };
    });
  }

  /** 结束"等桥接页"：带 error 时是失败；没在等时返回 false */
  private settleRelay(error?: Error): boolean {
    const w = this.relayWait;
    if (!w) return false;
    this.relayWait = null;
    if (error) w.reject(error);
    else w.resolve();
    return true;
  }

  /** 中转自己说的话：桥接页在不在、连好 Intiface 没有 */
  private relayControl(m: ToyRelayMessage) {
    let failed = '';
    if (m.relay === 'bridge' && !m.up) failed = this.relayWait ? BRIDGE_DOWN : BRIDGE_LOST;
    else if (m.relay === 'error') failed = `电脑上的桥接页连不上 Intiface Central：${m.message}`;
    // 已经握过手又来一次 ready：电脑上换了桥接页、重新连了 Intiface，这边的会话作废了
    else if (m.relay === 'ready' && !this.settleRelay()) failed = '电脑上的桥接页重新连了一次 Intiface Central，这边要重新连接';
    if (failed && !this.settleRelay(new Error(failed))) this.dropped(failed);
  }

  private closeReason(e: CloseEvent): string {
    if (e.code === 1000) return '';
    if (this.relay && e.code === TOY_RELAY_CLOSE.replaced) return '另一台设备连上了玩具中转，这台先断开了';
    return `${this.relay ? '玩具中转' : 'Intiface'} 的连接断了（${e.code}${e.reason ? ` ${e.reason}` : ''}）`;
  }

  /** 你点的断开：先让玩具都停下 */
  async disconnect(): Promise<void> {
    if (!this.ws) return;
    if (this.connected) await this.request('StopAllDevices', {}, 1500).catch(() => undefined);
    this.close();
  }

  private close(reason = '连接已关闭') {
    this.closing = true;
    clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    this.serverName = '';
    if (ws) {
      ws.onopen = ws.onerror = ws.onmessage = ws.onclose = null;
      try {
        ws.close(1000);
      } catch {
        // 已经关了
      }
    }
    this.settleRelay(new Error(reason));
    this.rejectAll(reason);
  }

  private dropped(reason: string) {
    const was = this.closing;
    this.close(reason || '连接已关闭');
    if (!was) this.events.onClose?.(reason || `${this.relay ? '玩具中转' : 'Intiface'} 的连接关了`);
  }

  private rejectAll(reason: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  /** 发一条消息，等对应 Id 的回复（Ok、ServerInfo、DeviceList……；Error 时抛出） */
  private request(type: string, fields: Obj, timeoutMs = 5000): Promise<Obj> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('还没连上 Intiface'));
    this.seq = this.seq >= 4_000_000_000 ? 1 : this.seq + 1;
    const id = this.seq;
    return new Promise<Obj>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${type} 没有回应`));
      }, timeoutMs);
      this.pending.set(id, { resolve: (body) => resolve(body), reject, timer });
      try {
        ws.send(JSON.stringify([{ [type]: { Id: id, ...fields } }]));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private receive(data: unknown) {
    const got = readToyRelay(data);
    if (!got) return;
    if ('control' in got) {
      if (this.relay) this.relayControl(got.control);
      return;
    }
    // 经云端中转：桥接页说连好之前来的 Buttplug 消息是上一次会话剩下的，不收
    if (this.relayWait) return;
    for (const m of got.buttplug as Msg[]) {
      const type = Object.keys(m ?? {})[0];
      if (!type) continue;
      const body = (m[type] ?? {}) as Obj;
      const id = typeof body.Id === 'number' ? body.Id : 0;
      const p = id ? this.pending.get(id) : undefined;
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (type === 'Error') p.reject(new Error(String(body.ErrorMessage ?? 'Intiface 报错')));
        else p.resolve(body, type);
        continue;
      }
      if (type === 'DeviceAdded') {
        const d = parseDevice(body);
        if (d) this.events.onDeviceAdded?.(d);
      } else if (type === 'DeviceRemoved' && typeof body.DeviceIndex === 'number') this.events.onDeviceRemoved?.(body.DeviceIndex);
      else if (type === 'ScanningFinished') this.events.onScanningFinished?.();
    }
  }

  async deviceList(): Promise<ToyDevice[]> {
    const r = await this.request('RequestDeviceList', {});
    const list = Array.isArray(r.Devices) ? (r.Devices as Obj[]) : [];
    return list.map(parseDevice).filter((d): d is ToyDevice => !!d);
  }

  startScanning(): Promise<Obj> {
    return this.request('StartScanning', {});
  }

  stopScanning(): Promise<Obj> {
    return this.request('StopScanning', {});
  }

  scalar(device: number, scalars: ScalarSub[]): Promise<Obj> {
    return this.request('ScalarCmd', { DeviceIndex: device, Scalars: scalars });
  }

  linear(device: number, vectors: LinearSub[]): Promise<Obj> {
    return this.request('LinearCmd', { DeviceIndex: device, Vectors: vectors });
  }

  rotate(device: number, rotations: RotateSub[]): Promise<Obj> {
    return this.request('RotateCmd', { DeviceIndex: device, Rotations: rotations });
  }

  stopDevice(device: number): Promise<Obj> {
    return this.request('StopDeviceCmd', { DeviceIndex: device });
  }

  stopAll(): Promise<Obj> {
    return this.request('StopAllDevices', {});
  }

  /** 电量 0–100；读不到为 null */
  async battery(d: ToyDevice): Promise<number | null> {
    if (d.batterySensor === null) return null;
    try {
      const r = await this.request('SensorReadCmd', { DeviceIndex: d.index, SensorIndex: d.batterySensor, SensorType: 'Battery' }, 4000);
      const v = Array.isArray(r.Data) ? Number(r.Data[0]) : NaN;
      return Number.isFinite(v) ? Math.round(v) : null;
    } catch {
      return null;
    }
  }
}
