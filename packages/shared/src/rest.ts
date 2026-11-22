import type { BackdropKey } from './backgrounds.ts';
import { drawnView, pexelsView, type EscapeView } from './escape.ts';
import type { Expression, Outfit, Pose } from './expressions.ts';

/**
 * 休息（RestScene.vue）：午睡、散步、泡澡、静坐、听音乐。一个人歇会儿（?solo=1），或者叫上她一起。
 * 每种休息方式自己的背景、立绘姿势、默认的白噪音、计时器可选的时长写在这里；界面、提示词（场景任务）都从这里取。
 * 午睡、散步、泡澡、静坐的背景会动（同出逃，components/scene/escape/EscapeBackdrop.vue）：
 * - 实拍：Pexels 的竖屏视频（720 宽），从 Pexels 直接播放，不打包进 App。画面里不能有人：
 *   挑的时候每段在整段时长里均匀抽 8 帧看过（第一人称走路露出腿脚的也不要）；换素材时照这个来；
 * - 插画：场景素材库里的图慢慢平移，叠上花瓣、光点。
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
    views: [
      pexelsView('nap', 1, 35873903, '床边的海', '躺在床上，窗外是海，窗帘被风轻轻吹动', '15214045_720_1280_30fps.mp4'),
      pexelsView('nap', 2, 39686776, '白纱窗边的床', '午后的床，白纱窗帘透着光，外面是阳台', '16921634_720_1280_30fps.mp4'),
      pexelsView('nap', 3, 15863264, '阳光照在床上', '阳光斜斜地照在床上，枕边放着一本书和一杯咖啡', '15863264-hd_720_1280_30fps.mp4'),
      pexelsView('nap', 4, 26796112, '风吹白纱', '白纱窗帘被风吹起来，窗台上放着一个杯子，远处是山', '12008397_720_1280_30fps.mp4'),
      pexelsView('nap', 5, 40417711, '地上的阳光', '白纱窗帘轻轻晃，阳光一格一格落在地板上', '17271537_720_1280_30fps.mp4'),
      pexelsView('nap', 6, 38781080, '开着的窗', '窗开着，风从外面吹进来，纱帘飘起来又落下', '16478396_720_1280_25fps.mp4'),
      pexelsView('nap', 7, 11487518, '窗外的大雨', '窗外在下大雨，雨点打在玻璃上，外面的椅子都湿了', '11487518-hd_720_1280_60fps.mp4'),
      pexelsView('nap', 8, 34208854, '安静的卧室', '干净安静的卧室，床铺得整整齐齐', '14499028_720_1280_24fps.mp4'),
      pexelsView('nap', 9, 34237005, '开着台灯的卧室', '傍晚的卧室，床头的小灯亮着', '14509456_720_1280_24fps.mp4'),
    ],
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
      pexelsView('walk', 1, 13076309, '林间小路', '走在树林中间的小路上，两边是一排排的树，地上是落叶', '13076309-hd_720_1280_24fps.mp4'),
      pexelsView('walk', 2, 13261590, '松林', '在松树林里慢慢往前走，阳光从树干中间照过来', '13261590-hd_720_1280_24fps.mp4'),
      pexelsView('walk', 3, 38867809, '公园的小路', '公园里弯弯的小路，两边是草地和大树，没有别人', '16522805_720_1280_30fps.mp4', 'calm-copy-space-empty-path-environment-38867809.jpeg'),
      pexelsView('walk', 4, 38877994, '草地上的栈道', '一条木栈道穿过草地，天很蓝，云很大', '16528311_720_1280_30fps.mp4'),
      pexelsView('walk', 5, 32818103, '夏天的林荫路', '夏天，走在林荫路上，路弯弯地往前延伸', '13989039_720_1280_30fps.mp4', '4k-adventure-beautiful-calm-32818103.jpeg'),
      drawnView('walk', 1, 'AP-daytime_forrest-11', '林间小路（插画）', '树林里的小路，阳光一束一束照下来，空气里飘着光点', ['motes']),
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
      pexelsView('bath', 1, 6810590, '泡泡浴', '浴缸里放满了热水和泡泡，上面漂着玫瑰', '6810590-hd_720_1248_30fps.mp4'),
      pexelsView('bath', 2, 15391873, '壁炉边的浴缸', '圆圆的浴缸里撒着花瓣，旁边的壁炉烧着火', '15391873-hd_720_1280_30fps.mp4', 'beauty-spa-hotel-meditation-and-relaxation-relaxation-15391873.jpeg'),
      pexelsView('bath', 3, 5607537, '窗边的烛光', '浴缸靠着窗，缸边点着几支蜡烛，窗外是绿叶', '5607537-hd_720_1280_24fps.mp4', 'african-american-child-african-child-asian-child-asian-children-5607537.jpeg'),
      pexelsView('bath', 4, 34237015, '雨雾里的浴池', '浴池里冒着水泡，窗外的树林起了雾', '14509341_720_1280_24fps.mp4'),
      pexelsView('bath', 5, 40187590, '落地窗前的浴缸', '落地窗前放着一只白色的浴缸，外面是树和天', '17167747_720_1280_30fps.mp4'),
      pexelsView('bath', 6, 15404450, '夜里的热水池', '夜里，热水池亮着彩色的灯，旁边是壁炉', '15404450-hd_720_1280_30fps.mp4'),
      pexelsView('bath', 7, 8195632, '水面上的花瓣', '水面上漂满了红色的玫瑰花瓣', '8195632-hd_720_1366_30fps.mp4'),
      pexelsView('bath', 8, 34270347, '户外的石头浴缸', '院子里一只石头浴缸，水从龙头里流进来，背后是石墙', '14520056_720_1280_30fps.mp4'),
      pexelsView('bath', 9, 5698927, '山野里的浴缸', '一只浴缸放在山野里，四周是灌木和远山', '5698927-hd_720_1280_25fps.mp4', 'bath-bathe-bathing-bathtub-5698927.jpeg'),
      pexelsView('bath', 10, 38548099, '蓝色的温泉', '野外的温泉，水是蓝色的，冒着热气，远处是松林', '16373198_720_1280_30fps.mp4'),
      pexelsView('bath', 11, 40375841, '冒热气的温泉河', '温泉水顺着石头流进河里，到处冒着热气', '17252087_720_1280_30fps.mp4'),
      pexelsView('bath', 12, 6047892, '帕穆卡莱的温泉池', '白色石灰华上的温泉池，水是浅蓝色的', '6047892-hd_720_1280_30fps.mp4', 'pamukkale-6047892.jpeg'),
      pexelsView('bath', 13, 27949894, '倒映着山林的温泉', '野外的温泉池，水面倒映着山和松林', '12270984_720_1280_60fps.mp4'),
    ],
    noise: 'rain',
    backdrop: 'bathroom',
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
