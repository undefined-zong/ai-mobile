import { buildDeviceMessages, errorText, samplerRequest } from '@app/ai';
import { describeCommand, parseDeviceSteps, SCALAR_KINDS, TOY_KIND_KEYS, TOY_KIND_LABEL, type Character, type DeviceStep, type ToyCommand, type ToyKind } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { useAiStore } from './ai';
import { useLibraryStore } from './library';
import { blockedReason, IntifaceClient, normalizeIntifaceUrl, type ToyDevice, type ToyFeature } from '@/services/intiface';
import { MissingPresetError } from '@/services/prompt';
import { DEFAULT_CAPS, emptyLevels, intensityOf, OLD_DEFAULT_CAPS, ToyPlayer, type ToyCaps, type ToyLevels, type ToyOutput } from '@/services/toyPlayer';

/**
 * 心跳里的玩具（设计文档 §9.14）：连 Intiface Central、列出连着的玩具、把指令放上去、按设置守着上限和安全时间。
 * - 指令从哪来（source）：单独生成（"控制指令"预设按她的话写，默认）/ 她自己写（心跳的功能预设里"她自己写指令"那一块，她在回复里写 <device>）/ 不控制；
 * - 强度上限、伸缩最快多快和范围、多久没有新指令就停、切到后台就停、打字时读多快、没连玩具时也在界面上试：存在本机（ai-mobile:toys）；
 * - 按了"停"全部停下，她下一条指令照常执行；断开时停下。
 * 连接留着（再进心跳不用重连），设置里"断开"才断。
 */

export type CommandSource = 'separate' | 'inline' | 'off';

export interface ToySettings {
  /** Intiface Central 的地址：127.0.0.1:12345、ws://…、wss://… */
  url: string;
  /** 进心跳时自动连（连上过一次以后打开，点"断开"时关） */
  autoConnect: boolean;
  source: CommandSource;
  caps: ToyCaps;
  /** 按连接地址、设备和控制通道分别保存的发送上限 */
  featureCaps: Record<string, number>;
  /** 多久没有新指令就停下（分钟，0 = 一直放着） */
  safetyMin: number;
  /** 切到别的 App、锁屏时停下 */
  stopOnHide: boolean;
  /** 没连玩具时也写指令、在心跳上显示（试预设用） */
  simulate: boolean;
  /** 打字时她的话按多快读（字 / 秒），指令读到那里时执行 */
  readCps: number;
  /** 设置的版本：2 以前存的，还是旧默认值（强度上限 80 / 60、10 分钟自动停、切走就停）的换成现在的默认 */
  version: number;
}

const KEY = 'ai-mobile:toys';

export const DEFAULT_TOY_SETTINGS: ToySettings = {
  url: '127.0.0.1:12345',
  autoConnect: false,
  source: 'separate',
  caps: { ...DEFAULT_CAPS },
  featureCaps: {},
  safetyMin: 0,
  stopOnHide: false,
  simulate: false,
  readCps: 9,
  version: 2,
};

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

function load(): ToySettings {
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (v && typeof v === 'object') raw = v as Record<string, unknown>;
  } catch {
    // 读不出来就用默认的
  }
  const c = (raw.caps && typeof raw.caps === 'object' ? raw.caps : {}) as Partial<ToyCaps>;
  const featureCaps = (raw.featureCaps ?? {}) as Record<string, number>;
  const d = DEFAULT_CAPS;
  // 旧版存的、还是旧默认值的（没调过）：换成现在的默认
  const legacy = raw.version !== DEFAULT_TOY_SETTINGS.version;
  if (legacy) for (const [k, v] of Object.entries(OLD_DEFAULT_CAPS) as [keyof ToyCaps, number][]) if (c[k] === v) delete c[k];
  if (legacy && raw.safetyMin === 10) delete raw.safetyMin;
  if (legacy && raw.stopOnHide === true) delete raw.stopOnHide;
  return {
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : DEFAULT_TOY_SETTINGS.url,
    autoConnect: raw.autoConnect === true,
    source: raw.source === 'inline' || raw.source === 'off' ? raw.source : 'separate',
    caps: {
      vibrate: num(c.vibrate, 0, 100, d.vibrate),
      oscillate: num(c.oscillate, 0, 100, d.oscillate),
      rotate: num(c.rotate, 0, 100, d.rotate),
      constrict: num(c.constrict, 0, 100, d.constrict),
      inflate: num(c.inflate, 0, 100, d.inflate),
      strokeMs: num(c.strokeMs, 100, 3000, d.strokeMs),
      posMin: num(c.posMin, 0, 100, d.posMin),
      posMax: num(c.posMax, 0, 100, d.posMax),
    },
    featureCaps: Object.fromEntries(Object.entries(featureCaps).map(([key, value]) => [key, num(value, 0, 100, 100)])),
    safetyMin: num(raw.safetyMin, 0, 120, DEFAULT_TOY_SETTINGS.safetyMin),
    stopOnHide: raw.stopOnHide === true,
    simulate: raw.simulate === true,
    readCps: num(raw.readCps, 3, 30, DEFAULT_TOY_SETTINGS.readCps),
    version: DEFAULT_TOY_SETTINGS.version,
  };
}

export const useToyStore = defineStore('toys', () => {
  const settings = reactive<ToySettings>(load());
  watch(
    () => JSON.stringify(settings),
    (v) => {
      try {
        localStorage.setItem(KEY, v);
      } catch {
        // 存不下：这次打开仍然有效
      }
    },
  );

  const status = ref<'idle' | 'connecting' | 'connected'>('idle');
  /** 连不上、断了、被浏览器拦下的原因 */
  const error = ref('');
  /** 指令没发出去（玩具断开、Intiface 报错）：最近一次 */
  const sendError = ref('');
  const server = ref('');
  const scanning = ref(false);
  const devices = ref<ToyDevice[]>([]);
  const battery = reactive<Record<number, number | null>>({});
  const levels = reactive<ToyLevels>(emptyLevels());
  /** 安全时间到了、切到后台停下了：写一行 */
  const notice = ref('');
  /** 上一条执行的指令（一句话） */
  const lastCommand = ref<{ text: string; at: number } | null>(null);
  /** 上一次"控制指令"写的（她那句话、写了什么、出错没有），设置里看，调预设用 */
  const lastWritten = ref<{ line: string; steps: string[]; at: number; error?: string } | null>(null);
  let lastAt = 0;
  let watchdog: ReturnType<typeof setInterval> | undefined;
  let scanTimer: ReturnType<typeof setTimeout> | undefined;

  function fail(e: unknown) {
    sendError.value = `指令没发出去：${errorText(e)}`;
  }

  const client = new IntifaceClient({
    onDeviceAdded: (d) => {
      devices.value = [...devices.value.filter((x) => x.index !== d.index), d].sort((a, b) => a.index - b.index);
      void readBattery(d);
    },
    onDeviceRemoved: (index) => {
      devices.value = devices.value.filter((d) => d.index !== index);
      delete battery[index];
    },
    onScanningFinished: () => {
      scanning.value = false;
    },
    onClose: (reason) => {
      status.value = 'idle';
      server.value = '';
      devices.value = [];
      scanning.value = false;
      error.value = `Intiface ${reason}`;
      player.stop();
    },
  });

  const output: ToyOutput = {
    devices: () => (status.value === 'connected' ? devices.value : []),
    scalar: (d, s) => void client.scalar(d, s).catch(fail),
    linear: (d, s) => void client.linear(d, s).catch(fail),
    rotate: (d, s) => void client.rotate(d, s).catch(fail),
    stopAll: () => {
      if (client.connected) void client.stopAll().catch(() => undefined);
    },
  };
  const endpoint = computed(() => {
    const target = normalizeIntifaceUrl(settings.url);
    return 'url' in target ? target.url : settings.url;
  });

  function featureKey(device: ToyDevice, feature: ToyFeature): string {
    return JSON.stringify([endpoint.value, device.index, device.name, feature.via, feature.index, feature.kind]);
  }

  function featureCap(device: ToyDevice, feature: ToyFeature): number {
    return settings.featureCaps[featureKey(device, feature)] ?? (feature.kind === 'linear' ? settings.caps.posMax : settings.caps[feature.kind]);
  }

  function setFeatureCap(device: ToyDevice, feature: ToyFeature, value: number) {
    settings.featureCaps[featureKey(device, feature)] = value;
  }

  const player = new ToyPlayer(levels, output, () => settings.caps, featureCap);
  watch(() => JSON.stringify([settings.caps, settings.featureCaps]), () => player.refreshCaps());

  /** 连着、有玩具 */
  const ready = computed(() => status.value === 'connected' && devices.value.length > 0);
  /** 指令会被执行（连着玩具，或者在界面上试） */
  const live = computed(() => ready.value || settings.simulate);
  /** 要不要让她写指令：会执行、指令来源没关 */
  const wanted = computed(() => live.value && settings.source !== 'off');
  const intensity = computed(() => intensityOf(levels));

  async function readBattery(d: ToyDevice) {
    if (d.batterySensor === null) return;
    battery[d.index] = await client.battery(d);
  }

  async function scan() {
    if (!client.connected) return;
    scanning.value = true;
    clearTimeout(scanTimer);
    try {
      await client.startScanning();
    } catch (e) {
      // 已经在扫描时有的版本会报错，不影响
      if (!/already/i.test(errorText(e))) error.value = `扫描玩具：${errorText(e)}`;
    }
    scanTimer = setTimeout(() => {
      if (client.connected) void client.stopScanning().catch(() => undefined);
      scanning.value = false;
    }, 15_000);
  }

  /** 连上 Intiface Central（在点击里调用；自动连也走这里） */
  async function connect(): Promise<boolean> {
    if (status.value !== 'idle') return status.value === 'connected';
    const target = normalizeIntifaceUrl(settings.url);
    if ('error' in target) {
      error.value = target.error;
      return false;
    }
    const blocked = blockedReason(target);
    if (blocked) {
      error.value = blocked;
      return false;
    }
    status.value = 'connecting';
    error.value = '';
    sendError.value = '';
    try {
      await client.connect(target);
      server.value = client.serverName;
      status.value = 'connected';
      settings.autoConnect = true;
      devices.value = (await client.deviceList().catch(() => [] as ToyDevice[])).sort((a, b) => a.index - b.index);
      for (const d of devices.value) void readBattery(d);
      void scan();
      return true;
    } catch (e) {
      status.value = 'idle';
      error.value = errorText(e);
      return false;
    }
  }

  async function disconnect() {
    player.stop();
    clearTimeout(scanTimer);
    settings.autoConnect = false;
    await client.disconnect();
    status.value = 'idle';
    server.value = '';
    devices.value = [];
    scanning.value = false;
  }

  /** 试一下：这个玩具轻轻动一下（不经过她，也不管按没按停） */
  function test(d: ToyDevice) {
    if (!client.connected) return;
    const scalars = d.features.filter((f) => f.via === 'scalar' && f.kind !== 'linear');
    const rotations = d.features.filter((f) => f.via === 'rotate');
    const linears = d.features.filter((f) => f.kind === 'linear');
    if (scalars.length) void client.scalar(d.index, scalars.map((f) => ({ Index: f.index, Scalar: Math.min(0.3, featureCap(d, f) / 100), ActuatorType: f.actuator }))).catch(fail);
    if (rotations.length) void client.rotate(d.index, rotations.map((f) => ({ Index: f.index, Speed: Math.min(0.3, featureCap(d, f) / 100), Clockwise: true }))).catch(fail);
    for (const f of linears) {
      if (f.via === 'linear') void client.linear(d.index, [{ Index: f.index, Duration: 600, Position: Math.min(0.7, featureCap(d, f) / 100) }]).catch(fail);
    }
    setTimeout(() => {
      if (!client.connected) return;
      if (scalars.length) void client.scalar(d.index, scalars.map((f) => ({ Index: f.index, Scalar: 0, ActuatorType: f.actuator }))).catch(fail);
      if (rotations.length) void client.rotate(d.index, rotations.map((f) => ({ Index: f.index, Speed: 0, Clockwise: true }))).catch(fail);
      for (const f of linears) if (f.via === 'linear') void client.linear(d.index, [{ Index: f.index, Duration: 600, Position: Math.min(0.2, featureCap(d, f) / 100) }]).catch(fail);
    }, 800);
  }

  /** 连着的玩具能做的（在界面上试时都能） */
  const kinds = computed<ToyKind[]>(() => {
    if (!ready.value) return settings.simulate ? ['vibrate', 'oscillate', 'rotate', 'linear'] : [];
    const set = new Set(devices.value.flatMap((d) => d.features.map((f) => f.kind)));
    return ([...SCALAR_KINDS, 'linear'] as ToyKind[]).filter((k) => set.has(k));
  });

  /** 去掉玩具做不了的那几种；什么都不剩时为 null */
  function fitCommand(cmd: ToyCommand): ToyCommand | null {
    if (cmd.stop) return cmd;
    const out: ToyCommand = {};
    for (const k of kinds.value) {
      const v = cmd[k];
      if (v) Object.assign(out, { [k]: v });
    }
    return Object.keys(out).length ? out : null;
  }

  function arm() {
    if (watchdog) return;
    watchdog = setInterval(() => {
      if (!player.active) {
        clearInterval(watchdog);
        watchdog = undefined;
        return;
      }
      if (settings.safetyMin > 0 && Date.now() - lastAt > settings.safetyMin * 60_000) {
        player.stop();
        notice.value = `${settings.safetyMin} 分钟没有新的指令，先停下了`;
      }
    }, 5000);
  }

  /** 执行一条指令：她的或者你手动的；返回执行了没有 */
  function apply(cmd: ToyCommand, _from: 'her' | 'you' = 'her'): boolean {
    if (!live.value) return false;
    const fitted = fitCommand(cmd);
    if (!fitted) return false;
    player.apply(fitted);
    lastAt = Date.now();
    lastCommand.value = { text: describeCommand(fitted), at: lastAt };
    notice.value = '';
    if (!fitted.stop) arm();
    return true;
  }

  /** 全部停下（她下一条指令照常执行） */
  function stopAll(why = '') {
    player.stop();
    if (why) notice.value = why;
  }

  // 聊天里她的指令也会执行（不只在心跳里）：切到别的 App、锁屏时照"切走时停下"的设置停下
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && settings.stopOnHide && live.value && intensity.value > 0) stopAll('切到后台了，先停下了');
    });
  }

  // —— 写给"控制指令"预设、她自己写指令时看的几行 ——

  /** 连着的玩具和能写的键 */
  function toysLine(): string {
    if (!ready.value) return settings.simulate ? '没连真的玩具（只在界面上显示）：VIBRATE、OSCILLATE、ROTATE、LINEAR 都可以写。' : '';
    const lines = devices.value.map((d) => {
      const by = new Map<ToyKind, number>();
      for (const f of d.features) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
      const parts = [...by].map(([k, n]) => `${TOY_KIND_LABEL[k]}${n > 1 ? ` ${n} 个马达（可以写成数组分别控制）` : ''}（${TOY_KIND_KEYS[k].join(' / ')}）`);
      return `- ${d.name}：${parts.join('、') || '没有能控制的'}`;
    });
    const keys = kinds.value.flatMap((k) => TOY_KIND_KEYS[k]);
    return `${lines.join('\n')}\n能写的键：${keys.join('、')}、STOP；别的键这些玩具做不了，不要写。`;
  }

  /** AI 始终用完整的 0–100；连接上限仅在发送到各通道时截断 */
  function limitsLine(): string {
    const c = settings.caps;
    const parts = [
      '指令数值按完整的 0–100 表达，可以输出 100；每个设备通道的连接上限由程序发送时截断，不需要预先降低或按比例缩放指令',
      kinds.value.includes('linear') ? `伸缩：从底到顶一下最快 ${c.strokeMs} 毫秒（幅度小按比例更快）` : '',
      '变速的每一档不短于 120 毫秒',
    ];
    return parts.filter(Boolean).join('；');
  }

  /** 现在在做什么 */
  function nowLine(): string {
    const doing = Object.entries(levels.doing).map(([, v]) => v);
    const ago = lastCommand.value ? Math.round((Date.now() - lastCommand.value.at) / 1000) : null;
    return `${doing.length ? doing.join('；') : '都停着'}${ago !== null ? `（上一条指令在 ${ago} 秒前）` : ''}`;
  }

  /**
   * "控制指令"预设：按她这句话写指令（「控制指令」的 API，默认跟随「陪伴 · 快速」）。
   * 返回放到原话里之前的步骤；没接通、没有预设、写坏了时抛出
   */
  async function writeCommands(opts: { character: Character; userName: string; line: string; recent: string[]; signal?: AbortSignal }): Promise<DeviceStep[]> {
    const ai = useAiStore();
    const s = ai.status('device');
    if (!s.live) throw new Error(`「控制指令」还没接通：${s.reason}`);
    const preset = useLibraryStore().presetForUse('device', opts.character);
    if (!preset) throw new MissingPresetError('控制指令');
    const messages = buildDeviceMessages(
      {
        userName: opts.userName,
        characterName: opts.character.name,
        pronoun: opts.character.pronoun,
        fills: {
          deviceToys: `连着的玩具：\n${toysLine()}`,
          deviceLimits: `指令数值与执行速度：${limitsLine()}`,
          deviceNow: `玩具现在：${nowLine()}`,
          deviceRecent: opts.recent.length ? `最近的对话：\n${opts.recent.join('\n')}` : '',
          deviceLine: `${opts.character.name}这一句（要配指令的话）：\n${opts.line}`,
        },
      },
      preset,
    );
    try {
      const { value } = await ai.system.json('device', { messages, ...samplerRequest(preset.sampler) }, parseDeviceSteps, { signal: opts.signal });
      const steps = value.map((st) => ({ at: st.at, command: fitCommand(st.command) })).filter((st): st is DeviceStep => !!st.command);
      lastWritten.value = { line: opts.line, steps: steps.map((st) => `${st.at ? `「${st.at}」` : '开头'} → ${describeCommand(st.command)}`), at: Date.now() };
      return steps;
    } catch (e) {
      if (!opts.signal?.aborted) lastWritten.value = { line: opts.line, steps: [], at: Date.now(), error: errorText(e) };
      throw e;
    }
  }

  return {
    settings,
    status,
    error,
    sendError,
    server,
    scanning,
    devices,
    battery,
    levels,
    notice,
    lastCommand,
    lastWritten,
    ready,
    live,
    wanted,
    intensity,
    kinds,
    featureCap,
    setFeatureCap,
    connect,
    disconnect,
    scan,
    test,
    apply,
    stopAll,
    toysLine,
    limitsLine,
    nowLine,
    writeCommands,
  };
});
