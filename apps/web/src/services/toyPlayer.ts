import {
  MIN_TOY_INTERVAL,
  MIN_TOY_STROKE,
  SCALAR_KINDS,
  TOY_KIND_LABEL,
  TOY_KIND_SHORT,
  describeCommand,
  mergeCommands,
  type PlacedCommand,
  type ScalarKind,
  type ToyCommand,
  type ToyKind,
  type ToyLinear,
  type ToyWave,
} from '@app/shared';
import type { LinearSub, RotateSub, ScalarSub, ToyDevice, ToyFeature } from './intiface';

/**
 * 心跳：把控制指令放到玩具上（设计文档 §9.14）。
 * - ToyPlayer：每一种（震动、摆动、旋转、收缩、充气、伸缩）各放一段：新指令只换掉它写了的那几种，没写的接着放；
 *   变速按 pattern / interval 走，loop 放完停在 0，不写 loop 一直循环；伸缩在两个位置之间来回。
 *   指令里的强度都是 0–100，发给每个头时按这个头的上限按比例换算（上限 60 时指令写 100 发 60、写 50 发 30），
 *   伸缩按这个头的范围换算位置、不快于它的"一下最快"；和上一次发的一样就不再发（省蓝牙）。
 *   没连玩具时（"不连玩具也试试"）只在界面上算每个头的数值，心跳照样跟着走。
 * - ReplyTimeline：她一句话里的几条指令，读到 / 念到那个位置时执行。打字时按"读多快"往前走（不超过已经写出来的字），
 *   连麦时跟着她念到第几句（每句里按语速往前走）；指令来晚了（单独生成要等她说完）一下子到的几条合成一条再执行。
 */

/** 一个头（一个玩具的一项能力：双头玩具的每个马达、震动加伸缩的每一种）的上限 */
export interface HeadLimit {
  /** 强度上限 0–100：指令里的 0–100 按比例落到 0–max（震动、摆动、旋转、收缩、充气） */
  max: number;
  /** 伸缩的范围（0–100）：指令里的位置 0–100 按比例落在这中间 */
  posMin: number;
  posMax: number;
  /** 伸缩：从 0 到 100 走一下最快多少毫秒（幅度小时按比例） */
  strokeMs: number;
}

export const DEFAULT_HEAD_LIMIT: HeadLimit = { max: 100, posMin: 0, posMax: 100, strokeMs: 300 };

/** 一个头：连着的玩具的一项能力；没连玩具、只在界面上试时 device / feature 为空 */
export interface ToyHead {
  /** 设置里上限的键：玩具名（同名的第二个起加序号）| 消息:位置 */
  key: string;
  kind: ToyKind;
  /** 心跳那条上的简称：震、震1、震2、转 */
  short: string;
  /** 设置里的名字：震动 1（Clitoral Stimulator） */
  name: string;
  device: ToyDevice | null;
  feature: ToyFeature | null;
}

/** 按顺序排好的每个头（指令里写数组时按这个顺序对应）；简称里的序号在同一种里按顺序数 */
export function listHeads(devices: ToyDevice[]): ToyHead[] {
  const seen = new Map<string, number>();
  const raw = devices.flatMap((device) => {
    const n = (seen.get(device.name) ?? 0) + 1;
    seen.set(device.name, n);
    const dk = n > 1 ? `${device.name} #${n}` : device.name;
    const perKind = new Map<ToyKind, number>();
    for (const f of device.features) perKind.set(f.kind, (perKind.get(f.kind) ?? 0) + 1);
    const at = new Map<ToyKind, number>();
    return device.features.map((feature) => {
      const i = (at.get(feature.kind) ?? 0) + 1;
      at.set(feature.kind, i);
      const many = (perKind.get(feature.kind) ?? 0) > 1;
      const name = `${TOY_KIND_LABEL[feature.kind]}${many ? ` ${i}` : ''}${feature.descriptor && feature.descriptor !== 'N/A' ? `（${feature.descriptor}）` : ''}`;
      return { key: `${dk}|${feature.via}:${feature.index}`, kind: feature.kind, name, device, feature };
    });
  });
  return withShort(raw);
}

/** 没连玩具时界面上的头：每一种 count[kind] 个（默认 1） */
export function virtualHeads(kinds: ToyKind[], count: Partial<Record<ToyKind, number>>): ToyHead[] {
  return withShort(
    kinds.flatMap((kind) =>
      Array.from({ length: Math.max(1, count[kind] ?? 1) }, (_, i) => ({ key: `sim|${kind}:${i}`, kind, name: `${TOY_KIND_LABEL[kind]}${(count[kind] ?? 1) > 1 ? ` ${i + 1}` : ''}`, device: null, feature: null })),
    ),
  );
}

function withShort(list: Omit<ToyHead, 'short'>[]): ToyHead[] {
  const total = new Map<ToyKind, number>();
  for (const h of list) total.set(h.kind, (total.get(h.kind) ?? 0) + 1);
  const at = new Map<ToyKind, number>();
  return list.map((h) => {
    const i = (at.get(h.kind) ?? 0) + 1;
    at.set(h.kind, i);
    return { ...h, short: `${TOY_KIND_SHORT[h.kind]}${(total.get(h.kind) ?? 0) > 1 ? i : ''}` };
  });
}

/** 一个头现在的数值（界面上的强度条看这个） */
export interface HeadLevel {
  key: string;
  kind: ToyKind;
  short: string;
  name: string;
  /** 发给玩具的数值 0–100（已经按上限换算）；伸缩是现在去的位置 */
  value: number;
  /** 伸缩多快（0–100，越大越快），停着时是 0；别的种类不用 */
  pace: number;
}

/** 玩具现在的样子 */
export interface ToyLevels {
  /** 每个头，顺序同 listHeads */
  heads: HeadLevel[];
  /** 每一种现在在放什么（指令原样的一句话） */
  doing: Partial<Record<ToyKind, string>>;
}

export function emptyLevels(): ToyLevels {
  return { heads: [], doing: {} };
}

/** 一个头有多激烈（0–100）：伸缩看快慢，别的看强度 */
export function headHeat(h: Pick<HeadLevel, 'kind' | 'value' | 'pace'>): number {
  return h.kind === 'linear' ? h.pace : h.value;
}

/** 现在最激烈的那个头（0–100）：心跳的快慢按它 */
export function intensityOf(l: ToyLevels): number {
  return Math.max(0, ...l.heads.map(headHeat));
}

export interface ToyOutput {
  /** 连着的玩具；没连（只在界面上试）时为空 */
  devices(): ToyDevice[];
  scalar(device: number, subs: ScalarSub[]): void;
  linear(device: number, subs: LinearSub[]): void;
  rotate(device: number, subs: RotateSub[]): void;
  stopAll(): void;
}

const ACTUATOR: Record<ScalarKind, string> = { vibrate: 'Vibrate', oscillate: 'Oscillate', rotate: 'Rotate', constrict: 'Constrict', inflate: 'Inflate' };
/** 没连玩具时一种最多显示几个头（同 parseDeviceBlock 里数组最多几项） */
const MAX_VIRTUAL = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export class ToyPlayer {
  private timers: Partial<Record<ToyKind, ReturnType<typeof setTimeout>>> = {};
  /** 上一次发给每个头的值（一样就不再发） */
  private sent = new Map<string, number>();
  private towardTo = true;
  /** 没连玩具时每一种显示几个头（指令写了几个就几个） */
  private virtualCount: Partial<Record<ToyKind, number>> = {};
  readonly levels: ToyLevels;
  private readonly out: ToyOutput;
  private readonly limit: (head: ToyHead) => HeadLimit;
  private readonly simKinds: () => ToyKind[];

  /** limit：这个头的上限；simKinds：没连玩具、在界面上试时有哪几种 */
  constructor(levels: ToyLevels, out: ToyOutput, limit: (head: ToyHead) => HeadLimit, simKinds: () => ToyKind[]) {
    this.levels = levels;
    this.out = out;
    this.limit = limit;
    this.simKinds = simKinds;
  }

  /** 有没有哪一种在动 */
  get active(): boolean {
    return intensityOf(this.levels) > 0 || Object.keys(this.timers).length > 0;
  }

  /** 现在的每个头（连着玩具时是真的，没连时是界面上的） */
  heads(): ToyHead[] {
    const devices = this.out.devices();
    return devices.length ? listHeads(devices) : virtualHeads(this.simKinds(), this.virtualCount);
  }

  /** 头变了（玩具连上、断开、换了在界面上试）：重排强度条，留着还在的头的数值 */
  sync(): ToyHead[] {
    const heads = this.heads();
    const now = this.levels.heads;
    if (heads.length !== now.length || heads.some((h, i) => now[i]?.key !== h.key || now[i]?.short !== h.short)) {
      const old = new Map(now.map((h) => [h.key, h]));
      this.levels.heads = heads.map((h) => ({ key: h.key, kind: h.kind, short: h.short, name: h.name, value: old.get(h.key)?.value ?? 0, pace: old.get(h.key)?.pace ?? 0 }));
    }
    return heads;
  }

  apply(cmd: ToyCommand): void {
    if (cmd.stop) {
      this.stop();
      return;
    }
    for (const k of SCALAR_KINDS) {
      const w = cmd[k];
      if (w) this.runWave(k, w);
    }
    if (cmd.linear) this.runLinear(cmd.linear);
  }

  /** 全部停下（发 StopAllDevices，所有头归零） */
  stop(): void {
    for (const t of Object.values(this.timers)) clearTimeout(t);
    this.timers = {};
    this.sent.clear();
    this.out.stopAll();
    for (const h of this.levels.heads) {
      h.value = 0;
      h.pace = 0;
    }
    this.levels.doing = {};
  }

  private clear(kind: ToyKind) {
    clearTimeout(this.timers[kind]);
    delete this.timers[kind];
  }

  private level(key: string): HeadLevel | undefined {
    return this.levels.heads.find((h) => h.key === key);
  }

  /** 给这一种设一个强度（一个数是所有头，数组是每个头各自的），按每个头的上限换算 */
  private setLevel(kind: ScalarKind, step: number | number[], clockwise?: boolean) {
    if (!this.out.devices().length && Array.isArray(step) && step.length > (this.virtualCount[kind] ?? 1)) this.virtualCount[kind] = Math.min(MAX_VIRTUAL, step.length);
    const heads = this.sync().filter((h) => h.kind === kind);
    const pick = (i: number) => clamp(Math.round(Array.isArray(step) ? (step[i] ?? step.at(-1) ?? 0) : step), 0, 100);
    const byDevice = new Map<number, { scalars: ScalarSub[]; rotations: RotateSub[] }>();
    heads.forEach((head, i) => {
      const v = Math.round((pick(i) * clamp(this.limit(head).max, 0, 100)) / 100);
      const lv = this.level(head.key);
      if (lv) lv.value = v;
      const { device, feature } = head;
      if (!device || !feature) return;
      const scalar = Math.round((v / 100) * feature.steps) / feature.steps;
      const key = `${head.key}${feature.via === 'rotate' ? `:${clockwise !== false}` : ''}`;
      if (this.sent.get(key) === scalar) return;
      this.sent.set(key, scalar);
      const g = byDevice.get(device.index) ?? { scalars: [], rotations: [] };
      if (feature.via === 'rotate') g.rotations.push({ Index: feature.index, Speed: scalar, Clockwise: clockwise !== false });
      else g.scalars.push({ Index: feature.index, Scalar: scalar, ActuatorType: feature.actuator || ACTUATOR[kind] });
      byDevice.set(device.index, g);
    });
    for (const [device, g] of byDevice) {
      if (g.scalars.length) this.out.scalar(device, g.scalars);
      if (g.rotations.length) this.out.rotate(device, g.rotations);
    }
  }

  private runWave(kind: ScalarKind, w: ToyWave) {
    this.clear(kind);
    this.levels.doing[kind] = describeCommand({ [kind]: w });
    if (w.steps.length === 1 && !w.loop) {
      this.setLevel(kind, w.steps[0] as number | number[], w.clockwise);
      if (!this.levels.heads.some((h) => h.kind === kind && h.value > 0)) delete this.levels.doing[kind];
      return;
    }
    let i = 0;
    let loops = 0;
    const step = () => {
      if (i >= w.steps.length) {
        i = 0;
        loops += 1;
        if (w.loop && loops >= w.loop) {
          this.setLevel(kind, 0);
          delete this.timers[kind];
          delete this.levels.doing[kind];
          return;
        }
      }
      this.setLevel(kind, w.steps[i] as number | number[], w.clockwise);
      const ms = Math.max(MIN_TOY_INTERVAL, w.intervals[i % w.intervals.length] ?? 1000);
      i += 1;
      this.timers[kind] = setTimeout(step, ms);
    };
    step();
  }

  private runLinear(l: ToyLinear) {
    this.clear('linear');
    this.levels.doing.linear = describeCommand({ linear: l });
    /** 一个头的位置怎么换算：指令里的 0–100 落在它的范围里 */
    const mapper = (lim: HeadLimit) => {
      const lo = clamp(Math.min(lim.posMin, lim.posMax), 0, 100);
      const hi = clamp(Math.max(lim.posMin, lim.posMax), 0, 100);
      return (p: number) => lo + ((hi - lo) * clamp(p, 0, 100)) / 100;
    };
    let seg = 0;
    let loop = 0;
    let k = 0;
    let guard = 0;
    const move = () => {
      const s = l.segments[seg];
      if (!s) {
        if (l.repeat && guard < 1000) {
          seg = 0;
          loop = 0;
          k = 0;
          guard += 1;
          move();
          return;
        }
        delete this.timers.linear;
        delete this.levels.doing.linear;
        for (const h of this.levels.heads) if (h.kind === 'linear') h.pace = 0;
        return;
      }
      if (k >= s.durations.length) {
        k = 0;
        loop += 1;
      }
      if (loop >= s.loop) {
        seg += 1;
        loop = 0;
        k = 0;
        move();
        return;
      }
      guard = 0;
      const target = this.towardTo ? s.to : s.from;
      const heads = this.sync()
        .filter((h) => h.kind === 'linear')
        .map((head) => {
          const lim = this.limit(head);
          const map = mapper(lim);
          return { head, lim, pos: map(target), span: Math.abs(map(s.to) - map(s.from)) };
        });
      // 一起走：按最慢的那个头（它的"一下最快"和幅度）定这一下多久
      const ms = Math.round(Math.max(s.durations[k] ?? 1000, MIN_TOY_STROKE, ...heads.map((h) => (h.lim.strokeMs * h.span) / 100)));
      for (const h of heads) {
        this.sendLinear(h.head, h.pos, ms);
        const lv = this.level(h.head.key);
        if (!lv) continue;
        lv.value = clamp(Math.round(h.pos), 0, 100);
        // 多快：一下 200 毫秒算最快，2 秒以上算很慢
        lv.pace = h.span < 3 ? 0 : clamp(Math.round(100 - ((ms - 200) / 1800) * 90), 10, 100);
      }
      this.towardTo = !this.towardTo;
      k += 1;
      this.timers.linear = setTimeout(move, ms);
    };
    move();
  }

  private sendLinear(head: ToyHead, pos: number, ms: number) {
    const { device, feature } = head;
    if (!device || !feature) return;
    if (feature.via === 'linear') this.out.linear(device.index, [{ Index: feature.index, Duration: ms, Position: Math.round(pos) / 100 }]);
    else this.out.scalar(device.index, [{ Index: feature.index, Scalar: Math.round(pos) / 100, ActuatorType: feature.actuator || 'Position' }]);
  }
}

/** 一条要执行的指令和它在她原话里的位置（字符下标） */
export type TimedCommand = PlacedCommand;

/**
 * 她一句话里的指令什么时候执行：
 * - read（打字）：从第一个字出来开始按 msPerChar 往前读，不超过已经写出来的字；写完以后读到哪执行到哪；
 * - speech（连麦）：sentence() 告诉它开始念哪一句，句子里按语速往前走，到句末停住等下一句；drained() 说念完了，剩下的都执行。
 */
export class ReplyTimeline {
  private steps: (TimedCommand & { done: boolean })[] = [];
  /** 不用了：之后来的指令（单独生成来晚了）也不执行 */
  private dead = false;
  private startedAt = 0;
  private known = 0;
  private finished = false;
  private anchor = { pos: 0, at: 0, end: 0 };
  private searchFrom = 0;
  private text = '';
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly mode: 'read' | 'speech';
  private readonly msPerChar: number;
  private readonly fire: (cmd: ToyCommand) => void;

  constructor(mode: 'read' | 'speech', msPerChar: number, fire: (cmd: ToyCommand) => void) {
    this.mode = mode;
    this.msPerChar = Math.max(20, msPerChar);
    this.fire = fire;
    this.timer = setInterval(() => this.tick(), 120);
  }

  /** 正文写到哪了（打字时用；第一次有字时开始读） */
  setText(text: string, done = false) {
    this.text = text;
    this.known = text.length;
    // 连麦时从她开口念第一句算起
    if (this.mode === 'read' && !this.startedAt && text.length) this.startedAt = Date.now();
    if (done) this.finished = true;
    this.tick();
  }

  add(list: TimedCommand[]) {
    if (this.dead) return;
    for (const c of list) this.steps.push({ ...c, done: false });
    this.steps.sort((a, b) => a.pos - b.pos);
    this.tick();
  }

  /** 连麦：开始念这一句（找到它在原话里的位置） */
  sentence(text: string) {
    const probe = text.trim().slice(0, 8);
    let pos = probe ? this.text.indexOf(probe, this.searchFrom) : -1;
    if (pos < 0) pos = this.anchor.end;
    this.searchFrom = pos + Math.max(1, probe.length);
    this.anchor = { pos, at: Date.now(), end: pos + text.trim().length };
    if (!this.startedAt) this.startedAt = Date.now();
    this.tick();
  }

  /** 连麦：她这句话念完了 */
  drained() {
    this.finished = true;
    this.anchor = { pos: Number.MAX_SAFE_INTEGER, at: Date.now(), end: Number.MAX_SAFE_INTEGER };
    this.tick();
  }

  cursor(): number {
    if (!this.startedAt) return -1;
    if (this.mode === 'speech') {
      if (this.anchor.pos === Number.MAX_SAFE_INTEGER) return Number.MAX_SAFE_INTEGER;
      return Math.min(this.anchor.end, this.anchor.pos + (Date.now() - this.anchor.at) / this.msPerChar);
    }
    const read = (Date.now() - this.startedAt) / this.msPerChar;
    return this.finished ? read : Math.min(read, this.known);
  }

  private tick() {
    if (this.dead) return;
    const at = this.cursor();
    if (at < 0) return;
    const due = this.steps.filter((s) => !s.done && s.pos <= at);
    if (due.length) {
      for (const s of due) s.done = true;
      const merged = mergeCommands(due.map((s) => s.command));
      if (merged) this.fire(merged);
    }
    // 都执行完、也读完了：先不用每隔一会儿看一次（单独生成的指令来晚了时 add 会直接执行）
    if (this.finished && this.steps.every((s) => s.done) && at >= this.known) {
      clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) this.timer = setInterval(() => this.tick(), 120);
  }

  /** 不用了（她开始说下一句、你打断、离开）：没执行的不再执行 */
  dispose() {
    this.dead = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
