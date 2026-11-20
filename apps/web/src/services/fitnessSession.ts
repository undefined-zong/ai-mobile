/**
 * "健身"进行中（或者练完了、还没发给她）的那一次，存在本机（localStorage）：
 * iPhone 在后台把 PWA 关掉、离开健身页、刷新以后再进来，能接着练、按最后在动的时刻补结束，或者不要了。
 * 练的时候每隔几秒存一次（也在切到后台时存）；发给她、"再练一次"、"不要了"时删掉。
 * 健康计划对手表的运动时也看这里：和这一次重叠的手表运动先不单独记（等这次发给她以后再对上）。
 */

export interface FitnessSessionManual {
  hrAvg: string;
  hrMax: string;
  kcal: string;
  steps: string;
  km: string;
}

export interface FitnessSession {
  v: 1;
  characterId: string;
  phase: 'active' | 'done';
  mode: 'plan' | 'free';
  method: string;
  outdoor: boolean;
  /** 这次运动记录的 id（开练时就定下：快捷指令带着它回来，发给她以后对得上） */
  logId: string;
  /** 真正开始的时刻（不随暂停挪） */
  realStart: number;
  /** 计时用的开始时刻（暂停后继续时往后挪） */
  startedAt: number;
  pausedAt: number | null;
  /** 练完的时刻、练了多少秒（phase = done） */
  endedAt?: number;
  endedSec?: number;
  stepIndex: number;
  setNo: number;
  doneMoves: string[];
  km: number;
  steps: number;
  hrAvg: number;
  hrMax: number;
  /** 最后一次在动的时刻：GPS 走了一段、数到了步、点了屏幕、做完一组 */
  lastMoveAt: number;
  /** 最后一次存的时刻（App 开着时每几秒存一次；被关掉以后就停在那儿） */
  savedAt: number;
  /** 切到后台的时刻（回来时清掉） */
  hiddenAt: number | null;
  /** 练完页上填的数 */
  manual?: FitnessSessionManual;
}

const KEY = 'ai-mobile:fitness:session:v1';
/** 太久以前的不要了（两天） */
const MAX_AGE_MS = 48 * 3600_000;

export function loadFitnessSession(): FitnessSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as FitnessSession;
    if (!s || s.v !== 1 || typeof s.realStart !== 'number' || typeof s.logId !== 'string' || (s.phase !== 'active' && s.phase !== 'done')) return null;
    if (Date.now() - (s.savedAt || s.realStart) > MAX_AGE_MS) {
      clearFitnessSession();
      return null;
    }
    return s;
  } catch {
    return null;
  }
}

export function saveFitnessSession(s: FitnessSession) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // 存不下就算了（隐私模式）
  }
}

export function clearFitnessSession() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // 同上
  }
}

/** 这一次占了哪段时间（还在练的算到最后存的那一刻） */
export function sessionSpan(s: FitnessSession): [number, number] {
  return [s.realStart, s.endedAt ?? Math.max(s.savedAt, s.lastMoveAt)];
}
