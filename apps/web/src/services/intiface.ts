import type { ScalarKind } from '@app/shared';

/**
 * Intiface Central 的客户端（心跳用，设计文档 §9.14）：Buttplug 协议，JSON 走 WebSocket。
 * 没用官方的 buttplug-js（几十 KB、带一串依赖），只做心跳要用的：
 * 握手（RequestServerInfo）、扫描、设备列表和增减、控制、停下（单个 / 全部）、读电量、按服务器要求定时 Ping。
 *
 * 先按 v4 握手（Intiface Central 3.0 起，2026-01）：OutputCmd 一条控制一个头，数值是整数档位（DeviceList 里每个头写着
 * Value 范围，例如震动 [0, 20]），和 Intiface 自己的 Devices 面板走同一条路，100 就是这个头的最高一档。
 * 服务器不认 v4（Intiface Central 2.x）时重连、按 v3 握手：ScalarCmd（震动 / 摆动 / 旋转 / 收缩 / 充气，0–1 的小数）、
 * LinearCmd（伸缩）、RotateCmd（带方向的旋转）。新版 Intiface 也还收 v3，但要它再换算一遍，有人用着发现 100 明显比面板上的 100 弱，所以能用 v4 就用 v4。
 * 协议说明：https://buttplug.io/docs/spec/
 *
 * 地址：Intiface Central 默认在 127.0.0.1:12345（设置里打开"所有网卡"才能从别的设备连）。
 * 页面是 https 时浏览器只让连 ws://127.0.0.1 / localhost 和 wss://（混合内容），连局域网别的电脑要 wss；
 * 连不上、被拦时把原因写清楚（见 blockedReason / connectError）。
 */

/** 设备的一项能力：在这条消息的属性列表里的位置（Index）、能分几档 */
export interface ToyFeature {
  /** v3：在 ScalarCmd / LinearCmd / RotateCmd 属性列表里的位置；v4：FeatureIndex */
  index: number;
  /** 震动、摆动……；linear 是伸缩（LinearCmd、v4 的 HwPositionWithDuration / Position，或者 ScalarCmd 里的 Position） */
  kind: ScalarKind | 'linear';
  /** 用哪条消息控制：v3 的 ScalarCmd / LinearCmd / RotateCmd，v4 的 OutputCmd */
  via: 'scalar' | 'linear' | 'rotate' | 'output';
  /** v3：ScalarCmd 的 ActuatorType 原文；v4：OutputType（Vibrate、Rotate、HwPositionWithDuration……） */
  actuator: string;
  /** 能分几档（v4 是 Value 范围里最大的那头） */
  steps: number;
  /** 设备自己写的说明（"Clitoral Stimulator"） */
  descriptor: string;
  /** v4：Value 的范围 [最小, 最大]（整数档位；旋转能反转时最小是负的） */
  range?: [number, number];
  /** v4 HwPositionWithDuration：Duration 的范围（毫秒） */
  duration?: [number, number];
  /** v4：同一个头在 v3 下的键（"scalar:0"），以前按 v3 存的上限照用 */
  legacy?: string;
}

export interface ToyDevice {
  index: number;
  name: string;
  features: ToyFeature[];
  /** 电量：v3 是 SensorReadCmd 里的位置，v4 是带 Battery 输入的 FeatureIndex；没有为 null */
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

/** v4 的 OutputType → 哪一种（Spray、Temperature、Led 心跳不用） */
const OUTPUT_KIND: Record<string, ToyFeature['kind'] | undefined> = {
  Vibrate: 'vibrate',
  Oscillate: 'oscillate',
  Rotate: 'rotate',
  Constrict: 'constrict',
  Inflate: 'inflate',
  HwPositionWithDuration: 'linear',
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

function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}

/** 你填的地址 → WebSocket 地址：127.0.0.1:12345 / 192.168.1.5 / ws://… / wss://…（没写端口时 ws 用 12345） */
export function normalizeIntifaceUrl(input: string): { url: string; host: string; loopback: boolean; secure: boolean } | { error: string } {
  let t = input.trim() || `127.0.0.1:${DEFAULT_PORT}`;
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

/** 浏览器会不会直接拦下这个地址（https 页面连没加密的局域网地址）：会的话返回原因 */
export function blockedReason(target: { host: string; loopback: boolean; secure: boolean }): string | null {
  if (typeof location === 'undefined' || location.protocol !== 'https:' || target.secure || target.loopback) return null;
  return `这个页面是 https，浏览器不让它连没加密的 ws://${target.host}。可以：在这台设备上开 Intiface Central（地址填 127.0.0.1:12345）；或者给 Intiface 套一层 https（例如 Caddy、cloudflared），地址填 wss://…`;
}

/** 连不上时说清楚可能是哪一步 */
export function connectError(target: { url: string; loopback: boolean }, detail: string): string {
  const where = target.loopback ? '这台设备上的 Intiface Central' : `${target.url} 那边的 Intiface Central`;
  return `连不上 ${target.url}（${detail}）。看看${where}开着没有、点了 Start Server 没有、端口是不是 12345${target.loopback ? '' : '，Intiface 设置里有没有打开"所有网卡"'}；浏览器问要不要允许访问本地网络设备时选允许。`;
}

/** 握手没成（服务器不认这个版本）：换一个版本再试 */
class HandshakeError extends Error {}

/** 列表或者以序号为键的对象（v4 的 Devices、DeviceFeatures）→ 一组对象 */
function objects(v: unknown): Obj[] {
  const arr = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.values(v as Obj) : [];
  return arr.filter((x): x is Obj => !!x && typeof x === 'object' && !Array.isArray(x));
}

/** v4 的范围：[0, 20]，也认 [[0, 20]]（电量输入的写法） */
function rangeOf(v: unknown): [number, number] | null {
  const a = Array.isArray(v) && Array.isArray(v[0]) ? (v[0] as unknown[]) : v;
  if (!Array.isArray(a) || a.length < 2) return null;
  const lo = Number(a[0]);
  const hi = Number(a[1]);
  return Number.isFinite(lo) && Number.isFinite(hi) ? [Math.min(lo, hi), Math.max(lo, hi)] : null;
}

/** v4 DeviceList 里的一个设备：每个 Feature 的每种 Output 一个头 */
function parseDeviceV4(raw: Obj): ToyDevice | null {
  const index = typeof raw.DeviceIndex === 'number' ? raw.DeviceIndex : null;
  if (index === null) return null;
  const features: ToyFeature[] = [];
  let battery: number | null = null;
  // 同一个头在 v3 下的位置（按顺序数），以前存的上限照用
  let scalarN = 0;
  let linearN = 0;
  const feats = objects(raw.DeviceFeatures).sort((a, b) => Number(a.FeatureIndex) - Number(b.FeatureIndex));
  for (const f of feats) {
    const fi = Number(f.FeatureIndex);
    if (!Number.isInteger(fi) || fi < 0) continue;
    const descriptor = String(f.FeatureDescription ?? '');
    const out = (f.Output && typeof f.Output === 'object' ? f.Output : {}) as Obj;
    const types = Object.keys(out);
    // 伸缩：有 HwPositionWithDuration（带时长，走得顺）用它，只有 Position 时用 Position
    const linearType = types.includes('HwPositionWithDuration') ? 'HwPositionWithDuration' : types.includes('Position') ? 'Position' : null;
    for (const t of types) {
      const kind = OUTPUT_KIND[t];
      if (!kind || (kind === 'linear' && t !== linearType)) continue;
      const info = (out[t] && typeof out[t] === 'object' ? out[t] : {}) as Obj;
      const range = rangeOf(info.Value);
      if (!range || range[0] === range[1]) continue;
      const duration = rangeOf(info.Duration);
      const legacy = kind === 'linear' ? `linear:${linearN++}` : `scalar:${scalarN++}`;
      features.push({ index: fi, kind, via: 'output', actuator: t, steps: Math.max(range[1], -range[0]), descriptor, range, ...(duration ? { duration } : {}), legacy });
    }
    const input = (f.Input && typeof f.Input === 'object' ? f.Input : {}) as Obj;
    if (battery === null && input.Battery) battery = fi;
  }
  const name = String(raw.DeviceDisplayName || raw.DeviceName || `玩具 ${index}`);
  return { index, name, features, batterySensor: battery, gapMs: Number(raw.DeviceMessageTimingGap) || 0 };
}

/** 回复里第一个数（v4 电量读数的写法没定死：Reading.Battery.Value、Data[0]……都认） */
function firstNumber(v: unknown, depth = 0): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (depth > 4 || !v || typeof v !== 'object') return null;
  for (const x of Array.isArray(v) ? v : Object.values(v as Obj)) {
    const n = firstNumber(x, depth + 1);
    if (n !== null) return n;
  }
  return null;
}

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
  /** 连接断了（不是你点的断开）：原因 */
  onClose?(reason: string): void;
}

export class IntifaceClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private closing = false;
  /** 正在握手：这时连接断了、报错，由 connect 换版本重试，不算"连接断了" */
  private handshaking = false;
  /** v4 不发 DeviceAdded / DeviceRemoved，每次发完整的 DeviceList：记着上一份，比出增减 */
  private known = new Map<number, string>();
  serverName = '';
  /** 这次连接用的协议版本 */
  protocol: 3 | 4 = 4;
  readonly events: IntifaceEvents;

  constructor(events: IntifaceEvents = {}) {
    this.events = events;
  }

  get connected(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN && !!this.serverName;
  }

  /** 连上并握手（先 v4，服务器不认时重连按 v3）；失败时抛出写好原因的错误 */
  async connect(target: { url: string; loopback: boolean }): Promise<void> {
    try {
      await this.open(target, 4);
    } catch (e) {
      if (!(e instanceof HandshakeError)) throw e;
      await this.open(target, 3);
    }
  }

  private async open(target: { url: string; loopback: boolean }, version: 3 | 4): Promise<void> {
    this.close();
    this.closing = false;
    this.known.clear();
    let ws: WebSocket;
    try {
      ws = new WebSocket(target.url);
    } catch (e) {
      throw new Error(connectError(target, e instanceof Error ? e.message : String(e)));
    }
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(connectError(target, '6 秒没有回应')));
        ws.close();
      }, 6000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error(connectError(target, '连接被拒绝或中断')));
      };
      ws.onclose = (e) => {
        clearTimeout(timer);
        reject(new Error(connectError(target, `连接关闭 ${e.code}`)));
      };
    });
    ws.onmessage = (e) => this.receive(e.data);
    ws.onerror = null;
    ws.onclose = (e) => this.dropped(e.code === 1000 ? '' : `连接断了（${e.code}${e.reason ? ` ${e.reason}` : ''}）`);
    this.handshaking = true;
    let info: Obj;
    try {
      const fields = version === 4 ? { ClientName: 'ai-mobile 心跳', ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 } : { ClientName: 'ai-mobile 心跳', MessageVersion: 3 };
      // 先记下版本：握手的回复和 v4 紧跟着推的 DeviceList 可能在同一帧里，读列表时要按这个版本读
      this.protocol = version;
      info = await this.request('RequestServerInfo', fields, version === 4 ? 6000 : 8000);
      // 老服务器不认 ProtocolVersionMajor，可能当成很老的客户端回 MessageVersion 0：重连按 v3
      const major = Number(info.ProtocolVersionMajor ?? info.MessageVersion ?? info.MessageMajorVersion);
      if (version === 4 && !(major >= 4)) throw new HandshakeError(`服务器是 v${Number.isFinite(major) ? major : '?'}`);
    } catch (e) {
      this.close();
      const msg = e instanceof Error ? e.message : String(e);
      throw version === 4 ? new HandshakeError(msg) : new Error(`Intiface 没有完成握手：${msg}`);
    } finally {
      this.handshaking = false;
    }
    this.serverName = String(info.ServerName ?? 'Intiface');
    const maxPing = Number(info.MaxPingTime) || 0;
    if (maxPing > 0) this.pingTimer = setInterval(() => void this.request('Ping', {}).catch(() => undefined), Math.max(200, Math.floor(maxPing / 2)));
  }

  /** 你点的断开：先让玩具都停下 */
  async disconnect(): Promise<void> {
    if (!this.ws) return;
    if (this.connected) await this.stopAll(1500).catch(() => undefined);
    this.close();
  }

  private close() {
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
    this.rejectAll('连接已关闭');
  }

  private dropped(reason: string) {
    const was = this.closing || this.handshaking;
    this.close();
    if (!was) this.events.onClose?.(reason || '连接关了');
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
    if (typeof data !== 'string') return;
    let list: unknown;
    try {
      list = JSON.parse(data);
    } catch {
      return;
    }
    for (const m of Array.isArray(list) ? (list as Msg[]) : []) {
      const type = Object.keys(m ?? {})[0];
      if (!type) continue;
      const body = (m[type] ?? {}) as Obj;
      const id = typeof body.Id === 'number' ? body.Id : 0;
      // 握手时老服务器读不懂 v4 的消息，回 Id 0 的 Error：算握手没成
      const p = id ? this.pending.get(id) : type === 'Error' && this.handshaking ? [...this.pending.values()][0] : undefined;
      if (p && !id) {
        for (const [k, v] of this.pending) if (v === p) this.pending.delete(k);
        clearTimeout(p.timer);
        p.reject(new Error(String(body.ErrorMessage ?? 'Intiface 报错')));
        continue;
      }
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        if (type === 'Error') p.reject(new Error(String(body.ErrorMessage ?? 'Intiface 报错')));
        else p.resolve(body, type);
        continue;
      }
      if (type === 'DeviceList') this.syncList(body);
      else if (type === 'DeviceAdded') {
        const d = parseDevice(body);
        if (d) this.events.onDeviceAdded?.(d);
      } else if (type === 'DeviceRemoved' && typeof body.DeviceIndex === 'number') this.events.onDeviceRemoved?.(body.DeviceIndex);
      else if (type === 'ScanningFinished') this.events.onScanningFinished?.();
    }
  }

  private parseList(body: Obj): ToyDevice[] {
    const parse = this.protocol === 4 ? parseDeviceV4 : parseDevice;
    return objects(body.Devices)
      .map(parse)
      .filter((d): d is ToyDevice => !!d);
  }

  /** v4 推过来的完整 DeviceList：比出哪些新连上、变了、断开了 */
  private syncList(body: Obj) {
    const list = this.parseList(body);
    const now = new Set(list.map((d) => d.index));
    for (const index of [...this.known.keys()]) {
      if (now.has(index)) continue;
      this.known.delete(index);
      this.events.onDeviceRemoved?.(index);
    }
    for (const d of list) {
      const sig = JSON.stringify(d);
      if (this.known.get(d.index) === sig) continue;
      this.known.set(d.index, sig);
      this.events.onDeviceAdded?.(d);
    }
  }

  async deviceList(): Promise<ToyDevice[]> {
    const r = await this.request('RequestDeviceList', {});
    const list = this.parseList(r);
    this.known = new Map(list.map((d) => [d.index, JSON.stringify(d)]));
    return list;
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

  /** v4：一个头设一个整数档位（HwPositionWithDuration 带时长，毫秒） */
  output(device: number, feature: number, type: string, value: number, durationMs?: number): Promise<Obj> {
    const cmd = type === 'HwPositionWithDuration' ? { Value: Math.round(value), Duration: Math.max(0, Math.round(durationMs ?? 500)) } : { Value: Math.round(value) };
    return this.request('OutputCmd', { DeviceIndex: device, FeatureIndex: feature, Command: { [type]: cmd } });
  }

  stopDevice(device: number): Promise<Obj> {
    return this.protocol === 4 ? this.request('StopCmd', { DeviceIndex: device }) : this.request('StopDeviceCmd', { DeviceIndex: device });
  }

  stopAll(timeoutMs?: number): Promise<Obj> {
    return this.protocol === 4 ? this.request('StopCmd', {}, timeoutMs) : this.request('StopAllDevices', {}, timeoutMs);
  }

  /** 电量 0–100；读不到为 null */
  async battery(d: ToyDevice): Promise<number | null> {
    if (d.batterySensor === null) return null;
    try {
      if (this.protocol === 4) {
        const r = await this.request('InputCmd', { DeviceIndex: d.index, FeatureIndex: d.batterySensor, Type: 'Battery', Command: 'Read' }, 4000);
        const v = firstNumber(r.Reading ?? r.Data ?? r.Value);
        return v !== null && v >= 0 && v <= 100 ? Math.round(v) : null;
      }
      const r = await this.request('SensorReadCmd', { DeviceIndex: d.index, SensorIndex: d.batterySensor, SensorType: 'Battery' }, 4000);
      const v = Array.isArray(r.Data) ? Number(r.Data[0]) : NaN;
      return Number.isFinite(v) ? Math.round(v) : null;
    } catch {
      return null;
    }
  }
}
