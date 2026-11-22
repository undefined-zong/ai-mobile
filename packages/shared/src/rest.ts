import type { BackdropKey } from './backgrounds.ts';
import type { Expression, Outfit, Pose } from './expressions.ts';

/**
 * 休息（RestScene.vue）：午睡、散步、泡澡、静坐、听音乐。一个人歇会儿（?solo=1），或者叫上她一起。
 * 每种休息方式自己的时长、背景、立绘姿势、默认的白噪音写在这里；界面、提示词（场景任务）都从这里取。
 */
export type RestKind = 'nap' | 'walk' | 'bath' | 'sit' | 'music';

/** 白噪音（apps/web/src/services/ambience.ts 里本机合成的那四种） */
export type RestNoise = 'rain' | 'fire' | 'waves' | 'fan';

export interface RestActivity {
  id: RestKind;
  name: string;
  icon: string;
  /** 选的时候下面那行小字 */
  blurb: string;
  /** 可选的时长（分钟），0 是不计时 */
  minutes: number[];
  defaultMinutes: number;
  /** 默认开的白噪音（null：默认不开） */
  noise: RestNoise | null;
  /** 素材库的背景 */
  backdrop: BackdropKey;
  /** 固定用素材库里的这个系列（泡澡要有浴缸，不要洗手池那几张） */
  backgroundSet?: string;
  indoor: boolean;
  pose: Pose;
  outfit: Outfit;
  /** 开始时她的表情 */
  expression: Expression;
  /** 这段时间里她不主动说话，只在开始和结束时说一句（午睡、静坐） */
  quiet: boolean;
  /** 和她一起时，她在做什么（{{pronoun}} 换成她 / 他） */
  together: string;
  /** 结束时那张卡片上的话：午睡了 20 分钟 */
  doneVerb: string;
  /** 一点小提醒（泡澡：水别太烫） */
  tip?: string;
}

export const REST_ACTIVITIES: RestActivity[] = [
  {
    id: 'nap',
    name: '午睡',
    icon: 'i-lucide-bed-single',
    blurb: '闭上眼睛歇一会儿，到点轻轻叫醒你',
    minutes: [10, 20, 30, 45],
    defaultMinutes: 20,
    noise: 'fan',
    backdrop: 'bedroom',
    indoor: true,
    pose: 'lie',
    outfit: 'pajama',
    expression: 'sleepy',
    quiet: true,
    together: '{{pronoun}}也躺下了，到点叫你',
    doneVerb: '睡了',
    tip: '午睡别超过半小时，醒来不容易头昏',
  },
  {
    id: 'walk',
    name: '散步',
    icon: 'i-lucide-footprints',
    blurb: '出去走走，晒晒太阳、吹吹风',
    minutes: [10, 20, 30, 0],
    defaultMinutes: 20,
    noise: null,
    backdrop: 'park',
    indoor: false,
    pose: 'stand',
    outfit: 'daily',
    expression: 'smile',
    quiet: false,
    together: '{{pronoun}}也出门了，边走边跟你聊',
    doneVerb: '走了',
  },
  {
    id: 'bath',
    name: '泡澡',
    icon: 'i-lucide-bath',
    blurb: '放一缸热水，什么都不想',
    minutes: [15, 20, 30],
    defaultMinutes: 20,
    noise: 'rain',
    backdrop: 'bathroom',
    backgroundSet: 'MC-japanese_bathroom',
    indoor: true,
    pose: 'sit',
    outfit: 'pajama',
    expression: 'smile',
    quiet: false,
    together: '{{pronoun}}也在泡，隔着屏幕陪你',
    doneVerb: '泡了',
    tip: '水温别太烫，泡完记得喝杯水',
  },
  {
    id: 'sit',
    name: '静坐',
    icon: 'i-lucide-flower-2',
    blurb: '跟着圆圈呼吸，让脑子安静下来',
    minutes: [3, 5, 10, 15],
    defaultMinutes: 5,
    noise: 'rain',
    backdrop: 'courtyard',
    indoor: false,
    pose: 'sit',
    outfit: 'daily',
    expression: 'neutral',
    quiet: true,
    together: '{{pronoun}}坐在旁边，和你一起呼吸',
    doneVerb: '坐了',
  },
  {
    id: 'music',
    name: '听音乐',
    icon: 'i-lucide-headphones',
    blurb: '戴上耳机，听几首喜欢的歌',
    minutes: [0, 15, 30],
    defaultMinutes: 0,
    noise: null,
    backdrop: 'music',
    indoor: true,
    pose: 'sit',
    outfit: 'daily',
    expression: 'smile',
    quiet: false,
    together: '{{pronoun}}也戴上了耳机，和你听同一首',
    doneVerb: '听了',
  },
];

export function restActivity(id: string | null | undefined): RestActivity | undefined {
  return REST_ACTIVITIES.find((a) => a.id === id);
}

/** 静坐时跟着呼吸的节奏：吸、停、呼、停各多少秒 */
export type BreathPhase = 'in' | 'hold' | 'out' | 'rest';
export interface BreathPattern {
  id: string;
  name: string;
  desc: string;
  steps: { phase: BreathPhase; sec: number }[];
}

export const BREATH_PATTERNS: BreathPattern[] = [
  { id: 'calm', name: '放松', desc: '吸 4 · 呼 6', steps: [{ phase: 'in', sec: 4 }, { phase: 'out', sec: 6 }] },
  { id: 'box', name: '方块', desc: '吸 4 · 停 4 · 呼 4 · 停 4', steps: [{ phase: 'in', sec: 4 }, { phase: 'hold', sec: 4 }, { phase: 'out', sec: 4 }, { phase: 'rest', sec: 4 }] },
  { id: '478', name: '4-7-8', desc: '吸 4 · 停 7 · 呼 8', steps: [{ phase: 'in', sec: 4 }, { phase: 'hold', sec: 7 }, { phase: 'out', sec: 8 }] },
];

export const BREATH_PHASE_LABEL: Record<BreathPhase, string> = { in: '吸气', hold: '屏住', out: '呼气', rest: '停一下' };

/** 现在在呼吸的哪一步、这一步走了多少（0–1）：t 是开始静坐以来的秒数 */
export function breathAt(pattern: BreathPattern, t: number): { phase: BreathPhase; progress: number; left: number } {
  const cycle = pattern.steps.reduce((s, x) => s + x.sec, 0);
  let at = ((t % cycle) + cycle) % cycle;
  for (const step of pattern.steps) {
    if (at < step.sec) return { phase: step.phase, progress: at / step.sec, left: Math.ceil(step.sec - at) };
    at -= step.sec;
  }
  const last = pattern.steps.at(-1)!;
  return { phase: last.phase, progress: 1, left: 0 };
}

export function minutesLabel(m: number): string {
  return m ? `${m} 分钟` : '不计时';
}
