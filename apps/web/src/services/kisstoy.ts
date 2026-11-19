import { KISSTOY_PATH, parseKisstoyShareUrl, type KisstoyAction, type KisstoyDeviceDetail, type KisstoyShare } from '@app/shared';
import type { IntifaceEvents, LinearSub, RotateSub, ScalarSub, ToyDevice, ToyFeature } from './intiface';

type HubEndpoint = (action: KisstoyAction) => { url: string; headers: Record<string, string> } | null;
type Events = IntifaceEvents & { onError?(message: string): void };
const PING_MS = 10_000;

/** 官方遥控协议的马达类型，不把型号、会话或迷路的能力写死在客户端。 */
const MOTORS: Record<number, Pick<ToyFeature, 'kind' | 'actuator' | 'descriptor'> | undefined> = {
  1: { kind: 'vibrate', actuator: 'Vibrate', descriptor: '震动' },
  2: { kind: 'vibrate', actuator: 'Vibrate', descriptor: '震动' },
  3: { kind: 'suction', actuator: 'Suction', descriptor: '吮吸' },
};

function deviceFrom(detail: KisstoyDeviceDetail, share: KisstoyShare): ToyDevice {
  let config = detail.config;
  const overrides = config.firmwareCapabilityOverrides ?? config.firmware_capability_overrides ?? [];
  if (share.hardwareVersion !== null) {
    const version = share.hardwareVersion;
    const match = overrides.filter((o) => {
      const min = Number(o.min_hardware_version ?? o.minHardwareVersion ?? 0);
      const max = Number(o.max_hardware_version ?? o.maxHardwareVersion ?? 0);
      return version >= min && (max <= 0 || version <= max);
    }).sort((a, b) => Number(b.min_hardware_version ?? b.minHardwareVersion ?? 0) - Number(a.min_hardware_version ?? a.minHardwareVersion ?? 0))[0];
    if (match) config = { ...config, ...match };
  }
  const features: ToyFeature[] = [];
  for (const motor of config.motors ?? []) {
    const index = Number(motor.type);
    const feature = MOTORS[index];
    if (feature && !features.some((f) => f.index === index)) features.push({ ...feature, index, via: 'scalar', steps: 20 });
  }
  if (!features.length) throw new Error('这个分享玩具没有可用的震动或吮吸通道');
  return { index: Number(share.deviceId), name: detail.name, features, batterySensor: null, gapMs: 0 };
}

/** iOS 的 PWA 保持原样，蓝牙由 KISSTOY App 维持；这里只连接官方的分享遥控会话。 */
export class KisstoyClient {
  readonly serverName = 'KISSTOY 分享遥控';
  private socket: WebSocket | null = null;
  private session: AbortController | null = null;
  private share: KisstoyShare | null = null;
  private device: ToyDevice | null = null;
  private ping: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly endpoint: HubEndpoint, private readonly events: Events = {}) {}

  get connected(): boolean { return this.socket?.readyState === WebSocket.OPEN && this.device !== null; }

  private async request<T>(action: KisstoyAction, shareUrl: string, signal: AbortSignal): Promise<T> {
    const endpoint = this.endpoint(action);
    if (!endpoint) throw new Error('请先在「我的 → 云端与同步」连接 Hub，再连接 KISSTOY');
    const response = await fetch(endpoint.url, {
      method: 'POST', headers: { ...endpoint.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ shareUrl }), signal, cache: 'no-store',
    });
    if (response.status === 404) throw new Error('Hub 还没有 KISSTOY 接口，请部署新版 Hub 后重试');
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error || `Hub HTTP ${response.status}`);
    return result;
  }

  async connect(shareUrl: string): Promise<void> {
    await this.disconnect();
    const share = parseKisstoyShareUrl(shareUrl);
    const session = new AbortController();
    this.session = session;
    const timeout = setTimeout(() => session.abort(new Error('KISSTOY 连接超时，请重试')), 30_000);
    try {
      const detail = await this.request<KisstoyDeviceDetail>('device', shareUrl, session.signal);
      const device = deviceFrom(detail, share);
      session.signal.throwIfAborted();
      const url = new URL(KISSTOY_PATH.socket, share.origin);
      url.protocol = 'wss:';
      url.searchParams.set('group', share.group);
      const socket = new WebSocket(url.toString());
      this.socket = socket;
      await new Promise<void>((resolve, reject) => {
        const aborted = () => reject(session.signal.reason);
        session.signal.addEventListener('abort', aborted, { once: true });
        const opened = () => {
          session.signal.removeEventListener('abort', aborted);
          resolve();
        };
        socket.onopen = opened;
        socket.onerror = () => {
          session.signal.removeEventListener('abort', aborted);
          reject(new Error('连不上 KISSTOY 遥控服务，请检查网络后重试'));
          socket.close();
        };
        socket.onclose = () => {
          session.signal.removeEventListener('abort', aborted);
          const wasConnected = this.connected || this.device !== null;
          const error = new Error('遥控连接已断开，请保持 KISSTOY App 与玩具连接后重连');
          session.abort(error);
          this.release();
          reject(error);
          if (wasConnected) this.events.onClose?.(error.message);
        };
        socket.onmessage = ({ data }) => {
          try {
            const message = JSON.parse(String(data)) as { result?: string; msg?: string; message?: string };
            if (message.result === 'error' || message.result === 'fail') this.events.onError?.(message.msg || message.message || 'KISSTOY 没有接受这条指令，请检查分享是否仍然有效');
          } catch { /* 官方遥控的其他消息不参与指令播放 */ }
        };
      });
      await this.request('bind', shareUrl, session.signal);
      session.signal.throwIfAborted();
      this.share = share;
      this.device = device;
      this.ping = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ event: 'ping' }));
      }, PING_MS);
    } catch (e) {
      if (this.session === session) this.release();
      throw session.signal.aborted ? session.signal.reason : e;
    } finally {
      clearTimeout(timeout);
    }
  }

  private release(): void {
    clearInterval(this.ping);
    if (this.socket) {
      this.socket.onopen = this.socket.onclose = this.socket.onerror = this.socket.onmessage = null;
      this.socket.close();
    }
    this.socket = null;
    this.device = null;
    this.share = null;
    this.session = null;
  }

  async disconnect(): Promise<void> {
    try { if (this.connected) await this.stopAll(); } finally {
      this.session?.abort(new Error('已断开 KISSTOY'));
      this.release();
    }
  }

  async deviceList(): Promise<ToyDevice[]> { return this.device ? [this.device] : []; }
  async startScanning(): Promise<void> { /* 分享链接指定一台玩具，不扫描本机蓝牙 */ }
  async stopScanning(): Promise<void> {}
  async battery(_device: ToyDevice): Promise<null> { return null; }

  async scalar(_device: number, subs: ScalarSub[]): Promise<void> {
    const motors = Object.fromEntries(subs.map((s) => [s.Index, Math.round(s.Scalar * 100)]));
    this.send(motors);
  }
  async linear(_device: number, _subs: LinearSub[]): Promise<void> { throw new Error('KISSTOY 分享遥控不提供位置控制'); }
  async rotate(_device: number, _subs: RotateSub[]): Promise<void> { throw new Error('KISSTOY 分享遥控不提供旋转控制'); }
  async stopDevice(_device: number): Promise<void> { return this.stopAll(); }
  async stopAll(): Promise<void> {
    if (this.device) this.send(Object.fromEntries(this.device.features.map((f) => [f.index, 0])));
  }

  private send(motors: Record<string, number>): void {
    if (!this.connected || !this.share) throw new Error('KISSTOY 遥控连接已断开');
    this.socket!.send(JSON.stringify({ event: 'control', data: { target: this.share.group, device_id: this.share.deviceId, motors } }));
  }
}
