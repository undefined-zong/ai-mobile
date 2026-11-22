import type { BackdropKey } from './backgrounds.ts';
import { drawnView, pexelsView, type EscapeView } from './escape.ts';
import type { Expression, Outfit, Pose } from './expressions.ts';

/**
 * 休息（RestScene.vue）：午睡、散步、泡澡、静坐、听音乐。一个人歇会儿（?solo=1），或者叫上她一起。
 * 每种休息方式自己的背景、立绘姿势、默认的白噪音、计时器可选的时长写在这里；界面、提示词（场景任务）都从这里取。
 * 散步、泡澡、静坐的背景会动（同出逃，components/scene/escape/EscapeBackdrop.vue）：
 * - 实拍：Pexels 的竖屏视频（720 宽），从 Pexels 直接播放，不打包进 App；
 * - 插画：场景素材库里的图慢慢平移，叠上热气、花瓣、光点。
 * 画面的说明（desc）写进给她的场景任务，她照着"眼前是什么"说话。
 * 听音乐不在这里放：进"一起听歌"（一个人时是它的一个人模式）。
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
  /** 右上角计时器里可选的时长（分钟）；计时器要的时候才开 */
  minutes: number[];
  defaultMinutes: number;
  /** 会动的背景（散步、泡澡、静坐）：几幅画面，"换一幅"在里面轮换；没有就用素材库的 backdrop */
  views?: EscapeView[];
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
    minutes: [10, 20, 30, 45],
    defaultMinutes: 20,
    views: [
      pexelsView('walk', 1, 38344808, '春天的林间', '春天的树林，阳光从叶子缝里照下来，脚下是长满青苔的小路', '16283332_720_1280_25fps.mp4', '4k-forest-4k-nature-4k-nature-background-4k-nature-video-38344808.jpeg'),
      pexelsView('walk', 2, 31888164, '雨后的樱花路', '刚下过雨，公园的小路湿湿的，路边的樱花开满了', '13582608_720_1280_30fps.mp4'),
      pexelsView('walk', 3, 36107226, '竹林小径', '两边是很高的竹子，中间一条砖铺的小路一直往前', '15312351_720_1280_24fps.mp4'),
      pexelsView('walk', 4, 40363880, '海边步道', '海边的步道，浪拍上堤岸，远处有人在慢慢走', '17244636_720_1280_30fps.mp4'),
      drawnView('walk', 1, 'AP-daytime_forrest-11', '林间小路', '树林里的小路，阳光一束一束照下来，空气里飘着光点', ['motes']),
      drawnView('walk', 2, 'MC-park_in_spring-01', '樱花公园', '春天的公园，樱花开着，花瓣慢慢飘下来', ['petals', 'clouds']),
      drawnView('walk', 3, 'MC-levee_trail-02', '黄昏的河堤', '黄昏，河堤上的散步道，天边是橙色的', ['warm-clouds', 'motes']),
      drawnView('walk', 4, 'AP-daytime_forrest-28', '夕阳下的森林', '太阳快落山了，树林里的小路被照得暖暖的', ['motes']),
    ],
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
    minutes: [10, 15, 20, 30],
    defaultMinutes: 20,
    views: [
      drawnView('bath', 1, 'MC-japanese_bathroom-01', '木浴缸', '木头的浴缸放满了热水，冒着热气，窗外是白天', ['steam']),
      drawnView('bath', 2, 'MC-hot_spring-03', '夜里的露天温泉', '夜里的露天温泉，热气往上飘，天上有星星', ['steam', 'stars']),
      drawnView('bath', 3, 'MC-hot_spring-02', '黄昏的温泉', '黄昏的温泉，水面泛着暖光，热气慢慢散开', ['steam', 'warm-clouds']),
      pexelsView('bath', 1, 6693847, '放热水', '浴缸在放热水，水从龙头里流下来', '6693847-hd_720_1366_30fps.mp4'),
      pexelsView('bath', 2, 8926011, '泡泡浴', '浴缸里满是泡泡，旁边点着小蜡烛', '8926011-hd_720_1366_25fps.mp4', 'bath-bathroom-bathtub-clean-8926011.jpeg'),
      pexelsView('bath', 3, 8926013, '浴球', '一颗浴球丢进热水里，慢慢化开', '8926013-hd_720_1366_25fps.mp4', 'adult-bath-bathroom-bathtub-8926013.jpeg'),
      pexelsView('bath', 4, 34807184, '烛火', '浴室里暗暗的，只点着一支蜡烛，火苗轻轻晃', '14757778_720_1064_30fps.mp4', 'burning-candle-burning-candles-candle-candle-flame-34807184.jpeg'),
      pexelsView('bath', 5, 12742709, '窗上的雨', '浴室的窗外在下雨，雨点顺着玻璃往下流', '12742709-hd_720_1280_30fps.mp4', 'blue-sky-cool-day-rain-12742709.jpeg'),
    ],
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
    views: [
      pexelsView('sit', 1, 36673541, '窗外的庭院', '坐在屋里，大窗户外面是日式庭院，树叶轻轻动', '15546967_720_1280_50fps.mp4'),
      pexelsView('sit', 2, 36131592, '睡莲', '池塘里开着一朵粉色的睡莲，周围是圆圆的叶子', '15322410_720_1280_30fps.mp4'),
      pexelsView('sit', 3, 36755682, '湖边芦苇', '安静的湖边，几根芦苇在风里轻轻晃', '15577480_720_1280_30fps.mp4'),
      pexelsView('sit', 4, 35272354, '雾中的湖', '起雾的湖，水面只有很小的波纹', '14941940_720_1280_30fps.mp4'),
      pexelsView('sit', 5, 40429172, '烛光', '暗暗的屋里点着几支蜡烛，火苗在晃', '17275379_720_1280_60fps.mp4'),
      drawnView('sit', 1, 'AP-garden-12', '日式庭园', '日式庭园，石灯笼、踏脚石和竹子，很安静', ['motes']),
      drawnView('sit', 2, 'MC-japanese_corridor-02', '黄昏的缘侧', '黄昏，坐在缘侧上，外面是田野和暖色的天', ['warm-clouds']),
      drawnView('sit', 3, 'MC-shrine-02', '傍晚的神社', '傍晚的神社，石灯笼，没有别人', ['motes']),
      drawnView('sit', 4, 'MC-japanese_corridor-03', '夜里的缘侧', '夜里的缘侧，外面是星空', ['stars']),
    ],
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
    blurb: '戴上耳机，听几首喜欢的歌（在"一起听歌"里放）',
    minutes: [15, 30, 45, 60],
    defaultMinutes: 30,
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
