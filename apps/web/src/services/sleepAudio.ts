import { computed, reactive, watch } from 'vue';
import { ambience, BREATH_KINDS, NOISE_KINDS, type BreathKind, type NoiseMix } from './ambience';

/**
 * 哄睡的白噪音和呼吸声怎么开（设计文档 §9.4）：左下角的小按钮（components/scene/sleep/SleepAudioDock.vue）看这里的状态。
 * 两层各开各的：白噪音（雨、炉火、海浪、风扇四个滑块混音）和呼吸声（男声 / 女声，一个音量），只开呼吸声时白噪音那层是静的。
 * 放在模块里而不是组件里：在连麦、故事、场景之间切换时按钮会重新挂上，声音不断，状态要对得上。
 * 混音和呼吸声的音量记在这台设备上；开没开不记（浏览器要点一下才让出声）。
 */
const SAVE_KEY = 'ai-mobile:sleep:audio';
interface Saved {
  mix?: Partial<NoiseMix>;
  breathVolume?: number;
}
function load(): Saved {
  try {
    const mine = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Saved | null;
    if (mine) return mine;
    // 改版以前混音和别的设置存在一起
    const old = JSON.parse(localStorage.getItem('ai-mobile:sleep') ?? '{}') as { mix?: Partial<NoiseMix> };
    return { mix: old.mix };
  } catch {
    return {};
  }
}
const saved = load();
const SILENT: NoiseMix = { rain: 0, fire: 0, waves: 0, fan: 0 };

export const SLEEP_NOISE_PRESETS: { label: string; mix: NoiseMix }[] = [
  { label: '雨夜', mix: { rain: 70, fire: 0, waves: 0, fan: 15 } },
  { label: '炉边', mix: { rain: 25, fire: 75, waves: 0, fan: 0 } },
  { label: '海边', mix: { rain: 0, fire: 0, waves: 75, fan: 10 } },
  { label: '风扇', mix: { rain: 0, fire: 0, waves: 0, fan: 70 } },
];

const state = reactive({
  mix: { rain: 60, fire: 20, waves: 0, fan: 10, ...(saved.mix ?? {}) } as NoiseMix,
  breathVolume: typeof saved.breathVolume === 'number' ? saved.breathVolume : 55,
  /** 白噪音那层想不想开 */
  noiseOn: false,
  /** 呼吸声想放哪种 */
  breath: null as BreathKind | null,
});

/** 真的在响（定时到点渐弱时不算） */
const sounding = computed(() => ambience.state.playing && !ambience.state.fading);
const noiseActive = computed(() => sounding.value && state.noiseOn);
const breathActive = computed<BreathKind | null>(() => (sounding.value ? state.breath : null));

/** 声音被别处停了（定时到点、离开哄睡）：两层都算关了 */
function settle() {
  if (sounding.value) return;
  state.noiseOn = false;
  state.breath = null;
}
function apply() {
  if (!state.noiseOn && !state.breath) {
    ambience.stop();
    return;
  }
  void ambience.start(state.noiseOn ? { ...state.mix } : SILENT, { kind: state.breath, volume: state.breathVolume });
}

watch(
  () => [{ ...state.mix }, state.breathVolume] as const,
  ([mix, breathVolume]) => {
    if (noiseActive.value) ambience.setMix(mix);
    if (breathActive.value) ambience.setBreath({ kind: state.breath, volume: breathVolume });
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({ mix, breathVolume }));
    } catch {
      // 无痕模式
    }
  },
);

/** 下面几个都要在点击里调用（浏览器只允许点了以后出声） */
export const sleepAudio = {
  state,
  noiseActive,
  breathActive,
  /** 在下雨（背景跟着下） */
  raining: computed(() => noiseActive.value && state.mix.rain > 0),
  toggleNoise() {
    settle();
    state.noiseOn = !state.noiseOn;
    // 四个滑块都拉到 0 了：给一个默认的混音，不然点了播放也没声
    if (state.noiseOn && NOISE_KINDS.every((k) => !state.mix[k])) Object.assign(state.mix, SLEEP_NOISE_PRESETS[0]!.mix);
    apply();
  },
  usePreset(mix: NoiseMix) {
    settle();
    Object.assign(state.mix, mix);
    state.noiseOn = true;
    apply();
  },
  /** 呼吸声：男声 / 女声 / 关（null） */
  pickBreath(kind: BreathKind | null) {
    settle();
    state.breath = kind && BREATH_KINDS.includes(kind) ? kind : null;
    apply();
  },
};
