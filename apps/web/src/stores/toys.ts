import { buildDeviceMessages, errorText, samplerRequest } from '@app/ai';
import { describeCommand, MIN_TOY_INTERVAL, placeDeviceTags, SCALAR_KINDS, TOY_KIND_KEYS, TOY_KIND_LABEL, type Character, type PlacedCommand, type ToyCommand, type ToyKind } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { useAiStore } from './ai';
import { useLibraryStore } from './library';
import { blockedReason, IntifaceClient, normalizeIntifaceUrl, type ToyDevice } from '@/services/intiface';
import { MissingPresetError } from '@/services/prompt';
import {
  DEFAULT_HEAD_LIMIT,
  emptyLevels,
  intensityOf,
  listHeads,
  outputDuration,
  outputLevel,
  outputPosition,
  ToyPlayer,
  type HeadLimit,
  type ToyHead,
  type ToyLevels,
  type ToyOutput,
} from '@/services/toyPlayer';

/**
 * 心跳里的玩具（设计文档 §9.14）：连 Intiface Central、列出连着的玩具、把指令放上去、按设置守着上限和安全时间。
 * - 指令从哪来（source）：单独生成（"控制指令"预设按她的话写，默认）/ 她自己写（心跳的功能预设里"她自己写指令"那一块，她在回复里写 <device>）/ 不控制；
 * - 每个头的上限（双头玩具的每个马达、震动加伸缩的每一种各设各的：强度上限，伸缩的范围和最快多快）、多久没有新指令就停、切到后台就停、
 *   打字时读多快、没连玩具时也在界面上试：存在本机（ai-mobile:toys）。她照 0–100 写，写多少发多少，超过这个头上限的发给玩具时压到上限；
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
  /** 每个头的上限（键是 listHeads 的 key）；没设过的头用 kindDefaults，再没有用 DEFAULT_HEAD_LIMIT */
  limits: Record<string, HeadLimit>;
  /** 以前按种类设的上限（震动一个数、伸缩一组）：没单独设过的头照它 */
  kindDefaults: Partial<Record<ToyKind, Partial<HeadLimit>>>;
  /** 多久没有新指令就停下（分钟，0 = 一直放着） */
  safetyMin: number;
  /** 切到别的 App、锁屏时停下 */
  stopOnHide: boolean;
  /** 没连玩具时也写指令、在心跳上显示（试预设用） */
  simulate: boolean;
  /** 打字时她的话按多快读（字 / 秒），指令读到那里时执行 */
  readCps: number;
  /**
   * 设置的版本：2 以前存的，还是旧默认值（强度上限 80 / 60、10 分钟自动停、切走就停）的换成现在的默认；
   * 3 以前的上限是按种类存的（caps），改过的那几种放进 kindDefaults
   */
  version: number;
}

const KEY = 'ai-mobile:toys';
/** 没连玩具、在界面上试时能写的几种 */
const SIM_KINDS: ToyKind[] = ['vibrate', 'oscillate', 'rotate', 'linear'];

export const DEFAULT_TOY_SETTINGS: ToySettings = {
  url: '127.0.0.1:12345',
  autoConnect: false,
  source: 'separate',
  limits: {},
  kindDefaults: {},
  safetyMin: 0,
  stopOnHide: false,
  simulate: false,
  readCps: 9,
  version: 3,
};

/** 版本 1 的默认强度上限：存着的还是这个值（没调过）时不算改过 */
const V1_DEFAULT_CAPS: Partial<Record<ToyKind, number>> = { vibrate: 80, oscillate: 80, rotate: 80, constrict: 60, inflate: 60 };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** 一个头的上限：缺的、超出范围的按 fallback 补 */
function readLimit(v: unknown, fallback: HeadLimit): HeadLimit {
  const o = (v && typeof v === 'object' ? v : {}) as Partial<HeadLimit>;
  return {
    max: num(o.max, 0, 100, fallback.max),
    posMin: num(o.posMin, 0, 100, fallback.posMin),
    posMax: num(o.posMax, 0, 100, fallback.posMax),
    strokeMs: num(o.strokeMs, 100, 3000, fallback.strokeMs),
  };
}

/** 3 以前按种类存的 caps → 没单独设过的头照它（只留改过的） */
function fromCaps(raw: Record<string, unknown>): ToySettings['kindDefaults'] {
  const c = (raw.caps && typeof raw.caps === 'object' ? raw.caps : {}) as Record<string, unknown>;
  const v1 = typeof raw.version !== 'number' || raw.version < 2;
  const out: ToySettings['kindDefaults'] = {};
  for (const k of SCALAR_KINDS) {
    const v = c[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || (v1 && v === V1_DEFAULT_CAPS[k])) continue;
    const max = num(v, 0, 100, DEFAULT_HEAD_LIMIT.max);
    if (max !== DEFAULT_HEAD_LIMIT.max) out[k] = { max };
  }
  const linear = readLimit({ posMin: c.posMin, posMax: c.posMax, strokeMs: c.strokeMs }, DEFAULT_HEAD_LIMIT);
  if (linear.posMin !== DEFAULT_HEAD_LIMIT.posMin || linear.posMax !== DEFAULT_HEAD_LIMIT.posMax || linear.strokeMs !== DEFAULT_HEAD_LIMIT.strokeMs) {
    out.linear = { posMin: linear.posMin, posMax: linear.posMax, strokeMs: linear.strokeMs };
  }
  return out;
}

function load(): ToySettings {
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    if (v && typeof v === 'object') raw = v as Record<string, unknown>;
  } catch {
    // 读不出来就用默认的
  }
  // 版本 1 存的、还是旧默认值的（没调过）：换成现在的默认
  const v1 = typeof raw.version !== 'number' || raw.version < 2;
  if (v1 && raw.safetyMin === 10) delete raw.safetyMin;
  if (v1 && raw.stopOnHide === true) delete raw.stopOnHide;
  const kindDefaults: ToySettings['kindDefaults'] = {};
  if (typeof raw.version === 'number' && raw.version >= 3) {
    const kd = (raw.kindDefaults && typeof raw.kindDefaults === 'object' ? raw.kindDefaults : {}) as Record<string, unknown>;
    for (const k of [...SCALAR_KINDS, 'linear'] as ToyKind[]) if (kd[k] && typeof kd[k] === 'object') kindDefaults[k] = kd[k] as Partial<HeadLimit>;
  } else Object.assign(kindDefaults, fromCaps(raw));
  const limits: Record<string, HeadLimit> = {};
  if (raw.limits && typeof raw.limits === 'object') for (const [key, v] of Object.entries(raw.limits as Record<string, unknown>)) limits[key] = readLimit(v, DEFAULT_HEAD_LIMIT);
  return {
    url: typeof raw.url === 'string' && raw.url.trim() ? raw.url.trim() : DEFAULT_TOY_SETTINGS.url,
    autoConnect: raw.autoConnect === true,
    source: raw.source === 'inline' || raw.source === 'off' ? raw.source : 'separate',
    limits,
    kindDefaults,
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
  /** 连上用的协议版本（Intiface Central 3.0 起是 4） */
  const protocol = ref<3 | 4 | null>(null);
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
    output: (d, f, type, value, ms) => void client.output(d, f, type, value, ms).catch(fail),
    stopAll: () => {
      if (client.connected) void client.stopAll().catch(() => undefined);
    },
  };
  /** 这个头的上限：单独设过的（新版 Intiface 上也认以前按 v3 存的键）→ 以前按种类设的 → 默认 */
  function headLimit(head: Pick<ToyHead, 'key' | 'kind' | 'alias'>): HeadLimit {
    return settings.limits[head.key] ?? (head.alias ? settings.limits[head.alias] : undefined) ?? readLimit(settings.kindDefaults[head.kind], DEFAULT_HEAD_LIMIT);
  }

  /** 改一个头的上限（设置里拖滑块） */
  function setHeadLimit(head: Pick<ToyHead, 'key' | 'kind' | 'alias'>, patch: Partial<HeadLimit>) {
    settings.limits[head.key] = readLimit({ ...headLimit(head), ...patch }, DEFAULT_HEAD_LIMIT);
  }

  const player = new ToyPlayer(levels, output, headLimit, () => (ready.value ? [] : SIM_KINDS));

  /** 连着、有玩具 */
  const ready = computed(() => status.value === 'connected' && devices.value.length > 0);
  /** 连着的玩具的每个头（指令里写数组时按这个顺序） */
  const heads = computed<ToyHead[]>(() => (ready.value ? listHeads(devices.value) : []));
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
      protocol.value = client.protocol;
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

  /** 试一下时"指令"写多少：强度 30，伸缩在 20–70 之间走一下（超过每个头上限、范围的压到上限、范围里） */
  const TEST = { level: 30, from: 20, to: 70, strokeMs: 600, holdMs: 800 };

  /** 试一下：这个玩具轻轻动一下（不经过她，也不管按没按停；也守着每个头的上限） */
  function test(d: ToyDevice) {
    if (!client.connected) return;
    const mine = heads.value.filter((h) => h.device?.index === d.index && h.feature);
    const send = (level: number, pos: number) => {
      const scalars = mine.filter((h) => h.feature!.via === 'scalar' && h.kind !== 'linear');
      const rotations = mine.filter((h) => h.feature!.via === 'rotate');
      const amount = (h: ToyHead) => Math.min(level, headLimit(h).max) / 100;
      const place = (h: ToyHead) => {
        const l = headLimit(h);
        return Math.min(Math.max(pos, Math.min(l.posMin, l.posMax)), Math.max(l.posMin, l.posMax)) / 100;
      };
      if (scalars.length) void client.scalar(d.index, scalars.map((h) => ({ Index: h.feature!.index, Scalar: amount(h), ActuatorType: h.feature!.actuator }))).catch(fail);
      if (rotations.length) void client.rotate(d.index, rotations.map((h) => ({ Index: h.feature!.index, Speed: amount(h), Clockwise: true }))).catch(fail);
      for (const h of mine) if (h.kind === 'linear' && h.feature!.via === 'linear') void client.linear(d.index, [{ Index: h.feature!.index, Duration: TEST.strokeMs, Position: place(h) }]).catch(fail);
      // v4：一个头一条
      for (const h of mine) {
        const f = h.feature!;
        if (f.via !== 'output') continue;
        if (h.kind !== 'linear') void client.output(d.index, f.index, f.actuator, outputLevel(f, amount(h) * 100)).catch(fail);
        else if (f.actuator === 'HwPositionWithDuration') void client.output(d.index, f.index, f.actuator, outputPosition(f, place(h) * 100), outputDuration(f, TEST.strokeMs)).catch(fail);
        else void client.output(d.index, f.index, f.actuator, outputPosition(f, place(h) * 100)).catch(fail);
      }
    };
    send(TEST.level, TEST.to);
    setTimeout(() => {
      if (client.connected) send(0, TEST.from);
    }, TEST.holdMs);
  }

  /** 连着的玩具能做的（在界面上试时都能） */
  const kinds = computed<ToyKind[]>(() => {
    if (!ready.value) return settings.simulate ? SIM_KINDS : [];
    const set = new Set(devices.value.flatMap((d) => d.features.map((f) => f.kind)));
    return ([...SCALAR_KINDS, 'linear'] as ToyKind[]).filter((k) => set.has(k));
  });

  // 头变了（连上、断开、玩具增减、打开 / 关掉在界面上试）：心跳那条跟着换
  watch(
    () => (ready.value ? heads.value.map((h) => h.key).join(',') : settings.simulate ? 'sim' : ''),
    () => {
      if (live.value) player.sync();
      else levels.heads = [];
    },
    { immediate: true },
  );

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

  /** 连着的玩具、能写的键，写数组时每个位置是哪个头 */
  function toysLine(): string {
    if (!ready.value) return settings.simulate ? `没连真的玩具（只在界面上显示）：${SIM_KINDS.flatMap((k) => TOY_KIND_KEYS[k]).join('、')} 都可以写。` : '';
    const lines = devices.value.map((d) => {
      const by = new Map<ToyKind, number>();
      for (const f of d.features) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
      const parts = [...by].map(([k, n]) => `${TOY_KIND_LABEL[k]}${n > 1 ? ` ${n} 个头` : ''}（${TOY_KIND_KEYS[k].join(' / ')}）`);
      return `- ${d.name}：${parts.join('、') || '没有能控制的'}`;
    });
    const many = SCALAR_KINDS.map((k) => {
      const hs = heads.value.filter((h) => h.kind === k);
      if (hs.length < 2) return '';
      const owner = (h: ToyHead) => (devices.value.length > 1 ? `${h.device?.name ?? ''}的` : '');
      return `${TOY_KIND_KEYS[k][0]} 有 ${hs.length} 个头：写一个数是一起，写数组 [${hs.map((_, i) => String.fromCharCode(97 + i)).join(', ')}] 依次是 ${hs.map((h) => `${owner(h)}${h.name}`).join('、')}`;
    }).filter(Boolean);
    const keys = kinds.value.flatMap((k) => TOY_KIND_KEYS[k]);
    return [
      ...lines,
      ...many,
      `能写的键：${keys.join('、')}、STOP；别的键这些玩具做不了，不要写。`,
      '强度都照 0–100 写，不用自己压低：每个头的上限在心跳设置里单独设，超过上限的，程序发给玩具时压到上限。',
    ].join('\n');
  }

  /** 最快的速度（太快玩具跟不上，程序会放慢） */
  function speedLine(): string {
    const linear = heads.value.filter((h) => h.kind === 'linear');
    const strokeMs = linear.length ? Math.max(...linear.map((h) => headLimit(h).strokeMs)) : readLimit(settings.kindDefaults.linear, DEFAULT_HEAD_LIMIT).strokeMs;
    return [
      `变速的每一档不短于 ${MIN_TOY_INTERVAL} 毫秒`,
      kinds.value.includes('linear') ? `伸缩：从底到顶一下最快 ${strokeMs} 毫秒（幅度小按比例更快）` : '',
    ]
      .filter(Boolean)
      .join('；');
  }

  /** 现在在做什么 */
  function nowLine(): string {
    const doing = Object.entries(levels.doing).map(([, v]) => v);
    const ago = lastCommand.value ? Math.round((Date.now() - lastCommand.value.at) / 1000) : null;
    return `${doing.length ? doing.join('；') : '都停着'}${ago !== null ? `（上一条指令在 ${ago} 秒前）` : ''}`;
  }

  /**
   * "控制指令"预设：按她这句话写指令（「控制指令」的 API，默认跟随「陪伴 · 快速」）。
   * 输出是她这句话照抄一遍、要变的地方插 <device>，返回放回原话位置的指令；没接通、没有预设、写坏了时抛出
   */
  async function writeCommands(opts: { character: Character; userName: string; line: string; recent: string[]; signal?: AbortSignal }): Promise<PlacedCommand[]> {
    const ai = useAiStore();
    const s = ai.status('device');
    if (!s.live) throw new Error(`「控制指令」还没接通：${s.reason}`);
    const lib = useLibraryStore();
    const preset = lib.withLorebooks(lib.presetForUse('device', opts.character), opts.character);
    if (!preset) throw new MissingPresetError('控制指令');
    const messages = buildDeviceMessages(
      {
        userName: opts.userName,
        characterName: opts.character.name,
        pronoun: opts.character.pronoun,
        fills: {
          deviceToys: `连着的玩具：\n${toysLine()}`,
          deviceLimits: `最快的速度：${speedLine()}`,
          deviceNow: `玩具现在：${nowLine()}`,
          deviceRecent: opts.recent.length ? `最近的对话：\n${opts.recent.join('\n')}` : '',
          deviceLine: `${opts.character.name}这一句（要配指令的话）：\n${opts.line}`,
        },
      },
      preset,
    );
    try {
      const { value } = await ai.system.text(
        'device',
        { messages, ...samplerRequest(preset.sampler) },
        (text) => placeDeviceTags(text, opts.line),
        `指令要写在 <device>…</device> 里：把${opts.character.name}这一句照抄一遍，在要变的地方插 <device>"键": 值</device>，不要别的写法、不要解释。`,
        { signal: opts.signal },
      );
      const placed = value.map((st) => ({ pos: st.pos, command: fitCommand(st.command) })).filter((st): st is PlacedCommand => !!st.command);
      const where = (pos: number) => (pos <= 0 ? '开头' : `「…${opts.line.slice(Math.max(0, pos - 8), pos).trim()}」之后`);
      lastWritten.value = { line: opts.line, steps: placed.map((st) => `${where(st.pos)} → ${describeCommand(st.command)}`), at: Date.now() };
      return placed;
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
    protocol,
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
    heads,
    headLimit,
    setHeadLimit,
    connect,
    disconnect,
    scan,
    test,
    apply,
    stopAll,
    toysLine,
    speedLine,
    nowLine,
    writeCommands,
  };
});
