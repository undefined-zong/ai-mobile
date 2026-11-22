import { computed, onBeforeUnmount, reactive } from 'vue';
import { prepareChime, type Chime } from '@/services/chime';

/**
 * 场景右上角的计时器（休息、一起听歌）：默认不开，要的时候点一下选几分钟。
 * 到点轻轻响几声铃、震一下（services/chime.ts），再交给场景做到点的事（她叫你、音乐慢慢停）。
 * 开始那一下在点击里借好提示音（浏览器只允许点了以后出声），到点不用再点。
 * 按时间戳算剩多少：切到后台、计时器晚醒也不会算错。
 */
export interface SceneTimerOptions {
  /** 到点了：定的是几分钟 */
  onEnd?(minutes: number): void;
  /** 到点响几声（午睡多响两声） */
  chimes?(): number;
}

export function useSceneTimer(opts: SceneTimerOptions = {}) {
  const state = reactive({
    /** 定的分钟数；0 是没开 */
    minutes: 0,
    startedAt: 0,
    pausedAt: 0,
    pausedMs: 0,
    now: Date.now(),
    /** 上一次到点是几分钟的（场景显示"到点了"用；重新开始时清掉） */
    lastEnded: 0,
  });
  let ticker = 0;
  let chime: Chime | null = null;

  const running = computed(() => state.minutes > 0);
  const paused = computed(() => running.value && state.pausedAt > 0);
  const totalSec = computed(() => state.minutes * 60);
  const elapsedSec = computed(() => (running.value ? Math.max(0, ((state.pausedAt || state.now) - state.startedAt - state.pausedMs) / 1000) : 0));
  const remainSec = computed(() => Math.max(0, totalSec.value - elapsedSec.value));
  const progress = computed(() => (running.value ? Math.min(1, elapsedSec.value / totalSec.value) : 0));

  function tick() {
    state.now = Date.now();
    if (running.value && !paused.value && remainSec.value <= 0) end();
  }
  function end() {
    const m = state.minutes;
    clearInterval(ticker);
    state.minutes = 0;
    state.lastEnded = m;
    chime?.ring(opts.chimes?.() ?? 3);
    opts.onEnd?.(m);
  }

  /** 在点击里调用 */
  function start(minutes: number) {
    chime?.dispose();
    chime = prepareChime();
    state.minutes = minutes;
    state.startedAt = Date.now();
    state.now = state.startedAt;
    state.pausedAt = 0;
    state.pausedMs = 0;
    state.lastEnded = 0;
    clearInterval(ticker);
    ticker = window.setInterval(tick, 1000);
  }
  function togglePause() {
    if (!running.value) return;
    if (state.pausedAt) {
      state.pausedMs += Date.now() - state.pausedAt;
      state.pausedAt = 0;
    } else {
      state.pausedAt = Date.now();
    }
    state.now = Date.now();
  }
  function addMinutes(n: number) {
    if (running.value) state.minutes += n;
  }
  function cancel() {
    clearInterval(ticker);
    state.minutes = 0;
    state.pausedAt = 0;
    chime?.dispose();
    chime = null;
  }

  onBeforeUnmount(() => {
    clearInterval(ticker);
    chime?.dispose();
  });

  return { state, running, paused, totalSec, elapsedSec, remainSec, progress, start, togglePause, addMinutes, cancel };
}

export type SceneTimer = ReturnType<typeof useSceneTimer>;
