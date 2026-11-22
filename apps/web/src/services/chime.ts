import { acquireAudioContext, type AudioContextLease } from './audio';

/**
 * 到点的提示音（休息：午睡叫醒、静坐结束）：几声轻轻的铃，本机合成，不联网。
 * 浏览器只允许点了以后出声：开始计时那一下（点击里）先 prepareChime() 借好 AudioContext（先不出声），
 * 到点时 ring() 再让它出声；不用了 dispose() 还回去。
 */
export interface Chime {
  ring(times?: number): void;
  dispose(): void;
}

export function prepareChime(): Chime {
  let lease: AudioContextLease | null = null;
  try {
    lease = acquireAudioContext('playback', false);
  } catch {
    // 不支持网页音频：到点只震动
  }
  let cleanup: ReturnType<typeof setTimeout> | undefined;
  return {
    ring(times = 3) {
      navigator.vibrate?.([180, 120, 180]);
      const l = lease;
      if (!l) return;
      l.setActive(true);
      const ctx = l.ctx;
      void ctx.resume().catch(() => undefined);
      const master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
      const t0 = ctx.currentTime + 0.05;
      for (let i = 0; i < times; i += 1) {
        const at = t0 + i * 1.25;
        // 一声铃：基音加两个泛音，起得快、慢慢散
        for (const [hz, amp, decay] of [
          [784, 1, 2.4],
          [1568, 0.35, 1.4],
          [2352, 0.12, 0.8],
        ] as const) {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.value = hz;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(amp, at + 0.012);
          g.gain.exponentialRampToValueAtTime(0.0001, at + decay);
          osc.connect(g).connect(master);
          osc.start(at);
          osc.stop(at + decay + 0.05);
        }
      }
      clearTimeout(cleanup);
      cleanup = setTimeout(() => {
        master.disconnect();
        l.setActive(false);
      }, (times * 1.25 + 2.6) * 1000);
    },
    dispose() {
      clearTimeout(cleanup);
      lease?.release();
      lease = null;
    },
  };
}
