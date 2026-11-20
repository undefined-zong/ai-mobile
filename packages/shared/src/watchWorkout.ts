/**
 * 手表的运动数据（设计文档 §9.1）：Apple Watch 记的运动经 iPhone 的快捷指令或 Health Auto Export 推到你自己的 Worker
 * （POST /v1/ingest/workout、/v1/ingest/hae），手机拉回来（GET /v1/ingest/workouts）和"健身"里记的那一次对上：
 * 对上了就换成手表的心率、消耗、距离、步数；没开 App、只在手表上练的，记成一条单独的运动记录。
 * 这里是 Worker 和 App 共用的：把两种格式读成同一个样子（WatchWorkout），以及怎么对、怎么合。
 */

/** 谁推来的：快捷指令（格式是这里定的）/ Health Auto Export（它的 JSON，第 1、2 版） */
export type WatchSource = 'shortcut' | 'hae';

/** 按分钟的明细（Health Auto Export 开了 Include Workout Metrics 时有）：手表忘了停时截取 App 那一段用 */
export interface WatchMinute {
  /** 这一分钟开始的时刻（毫秒） */
  t: number;
  hr?: number;
  hrMax?: number;
  kcal?: number;
  km?: number;
  steps?: number;
}

/** 一次手表上的运动（读好、换好单位的） */
export interface WatchWorkout {
  /** 去重用：hae:<它的 id> / sc:<App 记录的 id 或开始的那一分钟> */
  id: string;
  source: WatchSource;
  startedAt: number;
  endedAt: number;
  /** 运动时长（秒；Health Auto Export 给的不含暂停） */
  durationSec: number;
  /** 手表上的运动类型（Running、跑步……） */
  name?: string;
  indoor?: boolean;
  /** 记录它的设备或 App（Apple Watch……） */
  device?: string;
  /** 活动消耗（千卡，不含基础代谢） */
  kcal?: number;
  km?: number;
  steps?: number;
  hrAvg?: number;
  hrMax?: number;
  minutes?: WatchMinute[];
  /** 从 App 里按"用手表的数据更新"跑的快捷指令：App 里那次运动记录的 id */
  logId?: string;
}

/** GET /v1/ingest/workouts?since= 的回应 */
export interface HubWatchWorkouts {
  workouts: { seq: number; receivedAt: number; workout: WatchWorkout }[];
  next: number;
  more: boolean;
  /** 上报令牌是哪天建的（App 只把这之后的、没对上的记成单独的运动） */
  tokenCreatedAt: number | null;
}

/** 一次运动最长按 24 小时算（再长就是数据不对） */
const MAX_SPAN_MS = 24 * 3600_000;
const MAX_MINUTES = 24 * 60;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const round = (n: number, digits = 0) => Math.round(n * 10 ** digits) / 10 ** digits;

// —— 时间 ——

/**
 * 读一个时刻（毫秒）：Health Auto Export 的 "2024-02-06 07:00:00 -0800"、ISO 8601（快捷指令"格式化日期 → ISO 8601"）、
 * Unix 秒或毫秒。没写时区的不认（不知道是哪里的几点）
 */
export function parseWatchTime(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    const ms = Math.abs(v) < 1e11 ? v * 1000 : v;
    // 2000 年到 2100 年之间才算
    return ms > 946_684_800_000 && ms < 4_102_444_800_000 ? Math.round(ms) : null;
  }
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (/^\d{9,13}(\.\d+)?$/.test(s)) return parseWatchTime(Number(s));
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i);
  if (m) {
    const [, y, mo, d, h, mi, sec = '00', frac = '', tz] = m;
    if (!tz) return null;
    const zone = tz.toUpperCase() === 'Z' ? 'Z' : `${tz.slice(0, 3)}:${tz.slice(-2)}`;
    const t = Date.parse(`${y}-${mo}-${d}T${h!.padStart(2, '0')}:${mi}:${sec.padStart(2, '0')}${frac ? `.${frac.slice(0, 3).padEnd(3, '0')}` : ''}${zone}`);
    return Number.isFinite(t) ? t : null;
  }
  if (!/\d{4}/.test(s) || !/(Z|[+-]\d{2}:?\d{2}|GMT|UTC)\s*$/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

// —— 数和单位 ——

type Kind = 'km' | 'kcal' | 'bpm' | 'count';

/** 换成公里 / 千卡的系数（键是小写的单位） */
const UNIT: Record<Exclude<Kind, 'bpm' | 'count'>, Record<string, number>> = {
  km: { km: 1, kilometer: 1, kilometers: 1, 公里: 1, 千米: 1, mi: 1.609344, mile: 1.609344, miles: 1.609344, 英里: 1.609344, m: 0.001, meter: 0.001, meters: 0.001, 米: 0.001, yd: 0.0009144, yard: 0.0009144, yards: 0.0009144, ft: 0.0003048, feet: 0.0003048 },
  // Apple 的 "Cal" 就是千卡（大卡）
  kcal: { kcal: 1, cal: 1, 千卡: 1, 大卡: 1, 卡: 1, 卡路里: 1, kj: 1 / 4.184, 千焦: 1 / 4.184 },
};

function factor(kind: Kind, unit: string | undefined): number | null {
  if (kind === 'bpm' || kind === 'count') return 1;
  if (!unit) return 1;
  const u = unit.trim().toLowerCase();
  return UNIT[kind][u] ?? null;
}

/** "4,200" 这样的千分位去掉；"3,1" 当成 3.1 */
function toNumber(s: string): number {
  const t = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  return Number(t);
}

/** 一个数：数字、"3.1 km"、"142 count/min"、{ qty, units }；单位不认得时不要 */
function one(v: unknown, kind: Kind, unitHint?: string): number | null {
  if (typeof v === 'number') {
    const f = factor(kind, unitHint);
    return Number.isFinite(v) && f !== null ? v * f : null;
  }
  if (isObj(v)) {
    const qty = v.qty ?? v.value ?? v.Avg ?? v.avg;
    const units = typeof v.units === 'string' ? v.units : typeof v.unit === 'string' ? v.unit : unitHint;
    return one(typeof qty === 'string' ? toNumber(qty) : qty, kind, units);
  }
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^(-?\d[\d,]*(?:\.\d+)?)\s*([^\d\s][^\s]*)?/);
  if (!m) return null;
  const n = toNumber(m[1]!);
  // 心率、步数后面的 "count/min"、"bpm"、"步" 都不用管
  const unit = kind === 'km' || kind === 'kcal' ? (m[2] ?? unitHint) : undefined;
  const f = factor(kind, unit);
  return Number.isFinite(n) && f !== null ? n * f : null;
}

/** 一串数：数组，或者一行一个（快捷指令把列表放进文字里就是一行一个），或者 "142, 145" */
function many(v: unknown, kind: Kind, unitHint?: string): number[] {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/\r?\n|;|,\s+/) : v === undefined || v === null ? [] : [v];
  return items.map((x) => one(x, kind, unitHint)).filter((n): n is number => n !== null && Number.isFinite(n));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** 合理的范围里才要（超出范围多半是单位不对） */
function within(n: number | null | undefined, lo: number, hi: number, digits = 0): number | undefined {
  return n !== null && n !== undefined && Number.isFinite(n) && n > lo && n <= hi ? round(n, digits) : undefined;
}
const okHr = (n: number | null | undefined) => within(n, 25, 250);
const okKcal = (n: number | null | undefined) => within(n, 0, 10_000);
const okKm = (n: number | null | undefined) => within(n, 0, 500, 2);
const okSteps = (n: number | null | undefined) => within(n, 0, 300_000);

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}
const text = (v: unknown, max = 80) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

function span(start: number | null, end: number | null): string | null {
  if (start === null) return '开始时间读不出来（要带时区：快捷指令里用"格式化日期 → ISO 8601"）';
  if (end === null) return '结束时间读不出来（要带时区：快捷指令里用"格式化日期 → ISO 8601"）';
  if (end <= start) return '结束时间不在开始时间之后';
  if (end - start > MAX_SPAN_MS) return '一次运动超过 24 小时，时间多半不对';
  return null;
}

export interface WatchParse {
  workouts: WatchWorkout[];
  /** 没读成的（第几条、为什么） */
  errors: string[];
}

// —— 快捷指令 ——

/**
 * 快捷指令推来的（格式是这里定的，一次一条或者一个数组）：
 * { start, end, logId?, sport?, hr?, hrAvg?, hrMax?, kcal?, km?, steps?, energyUnit?, distanceUnit?, device? }
 * - start / end：ISO 8601（"格式化日期 → ISO 8601"），或 Unix 秒 / 毫秒；
 * - hr：心率，可以是一串（"获取健康样本的详细信息 → 值"放进文字里就是一行一个）：取平均和最高；也能直接给 hrAvg、hrMax；
 * - kcal、km、steps：一个数或者一串（加起来）；带单位的（"3.1 km"、"2 mi"、"1088 kJ"）会换算；
 *   不带单位时按 energyUnit / distanceUnit（默认千卡、公里）。
 */
export function parseShortcutWorkouts(body: unknown): WatchParse {
  const list = Array.isArray(body) ? body : [body];
  const out: WatchParse = { workouts: [], errors: [] };
  list.slice(0, 50).forEach((raw, i) => {
    const label = list.length > 1 ? `第 ${i + 1} 条：` : '';
    if (!isObj(raw)) {
      out.errors.push(`${label}要是 JSON 对象`);
      return;
    }
    const start = parseWatchTime(pick(raw, ['start', 'startDate', 'startedAt', '开始']));
    const end = parseWatchTime(pick(raw, ['end', 'endDate', 'endedAt', '结束']));
    const bad = span(start, end);
    if (bad) {
      out.errors.push(label + bad);
      return;
    }
    const energyUnit = text(pick(raw, ['energyUnit', 'kcalUnit']), 12);
    const distanceUnit = text(pick(raw, ['distanceUnit', 'kmUnit']), 12);
    const hrs = many(pick(raw, ['hr', 'heartRate', 'heartRates', '心率']), 'bpm').filter((n) => n > 25 && n <= 250);
    const hrAvg = okHr(one(pick(raw, ['hrAvg', 'avgHeartRate', '平均心率']), 'bpm') ?? (hrs.length ? sum(hrs) / hrs.length : null));
    const hrMax = okHr(one(pick(raw, ['hrMax', 'maxHeartRate', '最高心率']), 'bpm') ?? (hrs.length ? Math.max(...hrs) : null));
    const kcalList = many(pick(raw, ['kcal', 'activeEnergy', 'energy', 'calories', '消耗', '活动能量']), 'kcal', energyUnit);
    const kmList = many(pick(raw, ['km', 'distance', '距离']), 'km', distanceUnit);
    const stepList = many(pick(raw, ['steps', 'stepCount', '步数']), 'count');
    const logId = text(raw.logId, 80);
    const w: WatchWorkout = {
      id: `sc:${logId ?? Math.round(start! / 60_000)}`,
      source: 'shortcut',
      startedAt: start!,
      endedAt: end!,
      durationSec: Math.round((end! - start!) / 1000),
    };
    const name = text(pick(raw, ['sport', 'name', 'type', '运动']), 40);
    const device = text(raw.device, 40);
    const kcal = okKcal(kcalList.length ? sum(kcalList) : null);
    const km = okKm(kmList.length ? sum(kmList) : null);
    const steps = okSteps(stepList.length ? sum(stepList) : null);
    if (name) w.name = name;
    if (device) w.device = device;
    if (logId) w.logId = logId;
    if (kcal !== undefined) w.kcal = kcal;
    if (km !== undefined) w.km = km;
    if (steps !== undefined) w.steps = steps;
    if (hrAvg !== undefined) w.hrAvg = hrAvg;
    if (hrMax !== undefined) w.hrMax = Math.max(hrMax, hrAvg ?? 0);
    out.workouts.push(w);
  });
  if (list.length > 50) out.errors.push(`一次最多 50 条，后面的 ${list.length - 50} 条没要`);
  return out;
}

// —— Health Auto Export ——

/** Health Auto Export 一条时间序列（{ date, qty, units } 或心率的 { date, Min, Avg, Max }）放进按分钟的桶 */
function bucket(minutes: Map<number, WatchMinute & { hrN?: number }>, series: unknown, field: 'hr' | 'kcal' | 'km' | 'steps', start: number, end: number) {
  if (!Array.isArray(series)) return;
  for (const p of series) {
    if (!isObj(p)) continue;
    const t = parseWatchTime(p.date ?? p.timestamp);
    if (t === null || t < start - 60_000 || t > end + 60_000) continue;
    const key = Math.floor(t / 60_000) * 60_000;
    const m = minutes.get(key) ?? { t: key };
    if (field === 'hr') {
      const avg = okHr(one(p.Avg ?? p.avg ?? p.qty, 'bpm'));
      const max = okHr(one(p.Max ?? p.max ?? p.qty, 'bpm'));
      if (avg === undefined) continue;
      const n = (m.hrN ?? 0) + 1;
      m.hr = ((m.hr ?? 0) * (n - 1) + avg) / n;
      m.hrN = n;
      m.hrMax = Math.max(m.hrMax ?? 0, max ?? avg);
    } else {
      const v = one(p, field === 'km' ? 'km' : field === 'kcal' ? 'kcal' : 'count');
      if (v === null || v < 0) continue;
      m[field] = (m[field] ?? 0) + v;
    }
    minutes.set(key, m);
  }
}

/** 一串 { qty, units } 加起来（没有就 null） */
function total(series: unknown, kind: Kind): number | null {
  if (!Array.isArray(series)) return null;
  const xs = series.map((p) => one(p, kind)).filter((n): n is number => n !== null && n >= 0);
  return xs.length ? sum(xs) : null;
}

/**
 * Health Auto Export 推来的（REST API 自动化，数据类型选 Workouts，JSON，第 2 版；第 1 版也认）：
 * { data: { workouts: [...] } }。只要体能训练，别的（健康指标等）不管
 */
export function parseHaeWorkouts(body: unknown): WatchParse {
  const out: WatchParse = { workouts: [], errors: [] };
  const data = isObj(body) && isObj(body.data) ? body.data : isObj(body) ? body : null;
  const list = Array.isArray(body) ? body : data && Array.isArray(data.workouts) ? data.workouts : null;
  if (!list) {
    out.errors.push(data && Array.isArray(data.metrics) ? '推来的是健康指标：自动化的数据类型要选 Workouts（体能训练）' : '没有 data.workouts：自动化的数据类型要选 Workouts、格式选 JSON');
    return out;
  }
  list.slice(0, 200).forEach((raw, i) => {
    if (!isObj(raw)) return;
    const name = text(raw.name, 40);
    const label = `第 ${i + 1} 条${name ? `（${name}）` : ''}：`;
    const start = parseWatchTime(raw.start);
    const end = parseWatchTime(raw.end);
    const bad = span(start, end);
    if (bad) {
      out.errors.push(label + bad.replace(/（要带时区[^）]*）/, ''));
      return;
    }
    const s = start!;
    const e = end!;
    const v1 = !Array.isArray(raw.activeEnergy) && isObj(raw.activeEnergy);
    const hrSummary = isObj(raw.heartRate) ? raw.heartRate : {};
    const hrSeries = Array.isArray(raw.heartRateData) ? raw.heartRateData : [];
    const hrAvgs = hrSeries.map((p) => (isObj(p) ? okHr(one(p.Avg ?? p.qty, 'bpm')) : undefined)).filter((n): n is number => n !== undefined);
    const hrMaxes = hrSeries.map((p) => (isObj(p) ? okHr(one(p.Max ?? p.qty, 'bpm')) : undefined)).filter((n): n is number => n !== undefined);
    const distanceSeries = raw.walkingAndRunningDistance ?? raw.cyclingDistance ?? raw.swimDistance;
    const w: WatchWorkout = {
      id: `hae:${text(raw.id, 80) ?? Math.round(s / 1000)}`,
      source: 'hae',
      startedAt: s,
      endedAt: e,
      durationSec: Math.round(typeof raw.duration === 'number' && raw.duration > 0 && raw.duration * 1000 <= MAX_SPAN_MS ? raw.duration : (e - s) / 1000),
    };
    if (name) w.name = name;
    const device = text(isObj(raw.source) ? raw.source.name : raw.source, 40);
    if (device) w.device = device;
    if (typeof raw.isIndoor === 'boolean') w.indoor = raw.isIndoor;
    else if (typeof raw.location === 'string') w.indoor = /indoor|pool/i.test(raw.location);
    const kcal = okKcal(one(raw.activeEnergyBurned, 'kcal') ?? (v1 ? one(raw.activeEnergy, 'kcal') : total(raw.activeEnergy, 'kcal')));
    const km = okKm(one(raw.distance, 'km') ?? total(distanceSeries, 'km'));
    const steps = okSteps(Array.isArray(raw.stepCount) ? total(raw.stepCount, 'count') : one(raw.stepCount, 'count'));
    const hrAvg = okHr(one(hrSummary.avg, 'bpm') ?? one(raw.avgHeartRate, 'bpm') ?? (hrAvgs.length ? sum(hrAvgs) / hrAvgs.length : null));
    const hrMax = okHr(one(hrSummary.max, 'bpm') ?? one(raw.maxHeartRate, 'bpm') ?? (hrMaxes.length ? Math.max(...hrMaxes) : null));
    if (kcal !== undefined) w.kcal = kcal;
    if (km !== undefined) w.km = km;
    if (steps !== undefined) w.steps = steps;
    if (hrAvg !== undefined) w.hrAvg = hrAvg;
    if (hrMax !== undefined) w.hrMax = Math.max(hrMax, hrAvg ?? 0);
    // 按分钟的明细（秒级的也并成分钟）
    const minutes = new Map<number, WatchMinute & { hrN?: number }>();
    bucket(minutes, hrSeries, 'hr', s, e);
    if (!v1) bucket(minutes, raw.activeEnergy, 'kcal', s, e);
    bucket(minutes, distanceSeries, 'km', s, e);
    bucket(minutes, raw.stepCount, 'steps', s, e);
    if (minutes.size) {
      w.minutes = [...minutes.values()]
        .sort((a, b) => a.t - b.t)
        .slice(0, MAX_MINUTES)
        .map(({ hrN: _n, ...m }) => ({
          t: m.t,
          ...(m.hr !== undefined ? { hr: round(m.hr) } : {}),
          ...(m.hrMax !== undefined ? { hrMax: round(m.hrMax) } : {}),
          ...(m.kcal !== undefined ? { kcal: round(m.kcal, 2) } : {}),
          ...(m.km !== undefined ? { km: round(m.km, 4) } : {}),
          ...(m.steps !== undefined ? { steps: round(m.steps) } : {}),
        }));
    }
    out.workouts.push(w);
  });
  if (list.length > 200) out.errors.push(`一次最多 200 条，后面的 ${list.length - 200} 条没要（开 Batch Requests 分几次发）`);
  return out;
}

// —— 对上、合起来 ——

/** App 里一次运动记录里对得上用的几项 */
export interface WatchLogLike {
  id: string;
  startedAt: number;
  /** 结束的时刻（旧记录没有：按开始 + 时长算） */
  endedAt?: number;
  durationSec: number;
}

const endOf = (l: WatchLogLike) => l.endedAt ?? l.startedAt + l.durationSec * 1000;

/** 两段时间重叠的部分，占短的那段的多少（0–1） */
export function overlapShare(a0: number, a1: number, b0: number, b1: number): number {
  const both = Math.min(a1, b1) - Math.max(a0, b0);
  const shorter = Math.min(a1 - a0, b1 - b0);
  return both > 0 && shorter > 0 ? both / shorter : 0;
}

/** 这次手表的运动是 App 里的哪一次：带了 logId 的按 id；否则按时间，重叠超过短的那段的一半，几条都行时取重叠最多的 */
export function matchWatchLog<T extends WatchLogLike>(w: WatchWorkout, logs: T[]): T | null {
  if (w.logId) return logs.find((l) => l.id === w.logId) ?? null;
  let best: T | null = null;
  let bestShare = 0.5;
  for (const l of logs) {
    const share = overlapShare(l.startedAt, endOf(l), w.startedAt, w.endedAt);
    if (share >= bestShare) {
      best = l;
      bestShare = share;
    }
  }
  return best;
}

/** 手表的数用到 App 记的这一次上：要改的几项（没有的就不改）和一句说明 */
export interface WatchMerge {
  durationSec?: number;
  endedAt?: number;
  kcal?: number;
  distanceKm?: number;
  steps?: number;
  hrAvg?: number;
  hrMax?: number;
  /** 用了手表的数没有（手表那次长得多、又没有逐分钟的数时什么都不用） */
  used: boolean;
  note?: string;
}

/** 两边的时长差多少算"有一边忘了停"：长的那边超过短的 1.5 倍，而且多出 10 分钟以上 */
function muchLonger(a: number, b: number): boolean {
  return a > b * 1.5 && a - b > 10 * 60_000;
}

/** 手表那次在 [from, to] 这一段里的数（按分钟的明细算） */
function windowed(w: WatchWorkout, from: number, to: number): Omit<WatchMerge, 'used' | 'note'> {
  const ms = (w.minutes ?? []).filter((m) => m.t + 60_000 > from && m.t < to);
  const hrs = ms.map((m) => m.hr).filter((n): n is number => n !== undefined);
  const hrMaxes = ms.map((m) => m.hrMax ?? m.hr).filter((n): n is number => n !== undefined);
  const add = (k: 'kcal' | 'km' | 'steps') => {
    const xs = ms.map((m) => m[k]).filter((n): n is number => n !== undefined);
    return xs.length ? sum(xs) : undefined;
  };
  const r: Omit<WatchMerge, 'used' | 'note'> = {};
  const kcal = okKcal(add('kcal'));
  const km = okKm(add('km'));
  const steps = okSteps(add('steps'));
  if (kcal !== undefined) r.kcal = kcal;
  if (km !== undefined) r.distanceKm = km;
  if (steps !== undefined) r.steps = steps;
  if (hrs.length) r.hrAvg = round(sum(hrs) / hrs.length);
  if (hrMaxes.length) r.hrMax = Math.max(...hrMaxes);
  return r;
}

function whole(w: WatchWorkout): Omit<WatchMerge, 'used' | 'note'> {
  return {
    ...(w.kcal !== undefined ? { kcal: Math.round(w.kcal) } : {}),
    ...(w.km !== undefined ? { distanceKm: w.km } : {}),
    ...(w.steps !== undefined ? { steps: w.steps } : {}),
    ...(w.hrAvg !== undefined ? { hrAvg: w.hrAvg } : {}),
    ...(w.hrMax !== undefined ? { hrMax: w.hrMax } : {}),
  };
}

/**
 * 手表的数怎么用到 App 记的这一次上：
 * - 两边差不多长：心率、消耗、距离、步数都换成手表的；
 * - 手表那次长得多（手表忘了停）：有逐分钟的数时只取 App 那段时间里的，没有就不用（平均心率被休息时拉低、消耗也多算了）；
 * - App 那次长得多、手表早就结束了（App 里忘了按结束）：用手表的数，时长按手表结束的时刻算
 */
export function mergeWatch(log: WatchLogLike, w: WatchWorkout): WatchMerge {
  const appStart = log.startedAt;
  const appEnd = endOf(log);
  const appSpan = appEnd - appStart;
  const watchSpan = w.endedAt - w.startedAt;
  if (muchLonger(watchSpan, appSpan)) {
    const part = w.minutes?.length ? windowed(w, appStart, appEnd) : {};
    const used = Object.keys(part).length > 0;
    return {
      ...part,
      used,
      note: used ? '手表那次比 App 里长得多（可能忘了停），只用了 App 那段时间里的数' : '手表那次比 App 里长得多（可能忘了停），又没有逐分钟的数，没用手表的数',
    };
  }
  if (muchLonger(appSpan, watchSpan) && w.endedAt < appEnd - 10 * 60_000) {
    const sec = Math.round((w.endedAt - appStart) / 1000);
    const durationSec = Math.max(60, Math.min(log.durationSec, sec));
    return { ...whole(w), durationSec, endedAt: Math.min(appEnd, w.endedAt), used: true, note: 'App 里那次比手表长得多（可能忘了按结束），时长按手表结束的时刻算' };
  }
  return { ...whole(w), used: true };
}

/** "跑步 32 分钟 · 3.10 公里 · 平均心率 142 · 260 千卡"（横幅、记录里看的） */
export function watchWorkoutLine(w: Pick<WatchWorkout, 'name' | 'durationSec' | 'km' | 'hrAvg' | 'kcal' | 'steps'>): string {
  return [
    `${watchSportName(w.name)} ${Math.max(1, Math.round(w.durationSec / 60))} 分钟`,
    w.km ? `${w.km.toFixed(2)} 公里` : '',
    w.steps ? `${w.steps} 步` : '',
    w.hrAvg ? `平均心率 ${w.hrAvg}` : '',
    w.kcal ? `${Math.round(w.kcal)} 千卡` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

const SPORT_ZH: [RegExp, string][] = [
  [/run|跑/i, '跑步'],
  [/hik|徒步|登山/i, '徒步'],
  [/walk|走/i, '步行'],
  [/cycl|bik|骑/i, '骑行'],
  [/swim|游/i, '游泳'],
  [/yoga|瑜伽/i, '瑜伽'],
  [/strength|weight|力量/i, '力量训练'],
  [/hiit|interval|间歇/i, '高强度间歇'],
  [/row|划/i, '划船'],
  [/elliptical|椭圆/i, '椭圆机'],
  [/stair|楼梯/i, '爬楼梯'],
  [/dance|舞/i, '跳舞'],
  [/jump|rope|跳绳/i, '跳绳'],
];

/** 手表上的运动类型（英文的 Running、中文的跑步）换成 App 里的叫法；认不出就原样，没有就"运动" */
export function watchSportName(name: string | undefined): string {
  if (!name) return '运动';
  return SPORT_ZH.find(([re]) => re.test(name))?.[1] ?? name;
}
