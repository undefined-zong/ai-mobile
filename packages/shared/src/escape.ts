import type { BackdropKey } from './backgrounds.ts';
import { registerPlaces, type MapLocation } from './locations.ts';

/**
 * 出逃：从日常里逃出去，去一个很远的地方待一会儿。一个人去，或者带她一起。
 * 每个去处有几幅画面，两种来源：
 * - 实拍（video）：Pexels 的竖屏视频，直接从 Pexels 播放，不打包进 App；
 * - 插画（drawn）：场景素材库里现成的图（和立绘同一个画风），横图在竖屏里慢慢平移，再叠星星、云、光点这些会动的东西。
 * 画面的说明（desc）会写进给她的场景任务，她照着"眼前是什么"说话；不描述没写的东西。
 */
export type EscapeFx = 'stars' | 'clouds' | 'warm-clouds' | 'glint' | 'motes' | 'streaks';

export interface EscapeVideoView {
  kind: 'video';
  /** 全局唯一（去处 id + 编号），记在"上次看的是哪一幅"里 */
  id: string;
  label: string;
  /** 给她看的画面说明：在哪、窗外 / 眼前有什么、什么时候 */
  desc: string;
  /** Pexels 视频页的编号（打开原页面用） */
  pexelsId: number;
  /** 720×1280 的 mp4 */
  src: string;
  poster: string;
}

export interface EscapeDrawnView {
  kind: 'drawn';
  id: string;
  label: string;
  desc: string;
  /** 场景素材库里的图片 id（apps/web/src/assets/backgrounds/images/<id>.webp） */
  image: string;
  /** 平移（慢慢扫过整张横图），或者在平移的同时轻轻晃（车厢里） */
  motion: 'pan' | 'sway';
  fx: EscapeFx[];
}

export type EscapeView = EscapeVideoView | EscapeDrawnView;

export interface EscapeDestination {
  id: string;
  /** 地点名：顶栏、聊天里"和她来到…"、给她的场景任务都用它 */
  name: string;
  icon: string;
  /** 一句话的感觉，选去处时显示 */
  tagline: string;
  /** 聊天剧场、视频通话这些按地点挑背景的地方用（她此刻在这里时） */
  backdrop: BackdropKey;
  indoor: boolean;
  views: EscapeView[];
}

const PX = 'https://videos.pexels.com/video-files/';
const pexels = (dest: string, n: number, pexelsId: number, label: string, desc: string, file: string, thumb?: string): EscapeVideoView => ({
  kind: 'video',
  id: `${dest}:${n}`,
  label,
  desc,
  pexelsId,
  src: `${PX}${pexelsId}/${file}`,
  poster: `https://images.pexels.com/videos/${pexelsId}/${thumb ?? `pexels-photo-${pexelsId}.jpeg`}?auto=compress&cs=tinysrgb&w=750`,
});
const drawn = (dest: string, n: number, image: string, label: string, desc: string, fx: EscapeFx[], motion: EscapeDrawnView['motion'] = 'pan'): EscapeDrawnView => ({
  kind: 'drawn',
  id: `${dest}:d${n}`,
  label,
  desc,
  image,
  motion,
  fx,
});

export const ESCAPE_DESTINATIONS: EscapeDestination[] = [
  {
    id: 'train',
    name: '火车上',
    icon: 'i-lucide-train-front',
    tagline: '最直接的"在路上"',
    backdrop: 'train',
    indoor: true,
    views: [
      drawn('train', 1, 'MC-inside_train-03', '空车厢', '空荡荡的车厢里只有你们，车身轻轻晃，窗外的灯一道道划过去', ['streaks'], 'sway'),
      drawn('train', 2, 'MC-station_platform-02', '黄昏的站台', '黄昏的站台，光斜斜地照进来，车快到了', ['motes']),
      pexels('train', 1, 27874072, '城市车窗', '火车车窗外，晴天，城市的楼一栋栋往后退', '12251533_720_1280_30fps.mp4'),
      pexels('train', 2, 37954692, '乡间铁轨', '火车开过乡间，铁轨两边是田野', '16104812_720_1280_60fps.mp4'),
      pexels('train', 3, 35119650, '雪原列车', '火车穿过一大片雪原，窗外全是白的', '14878064_720_1280_30fps.mp4'),
      pexels('train', 4, 19534471, '雪景车窗', '车窗外在下雪，雪景一直往后退', '19534471-hd_720_1280_60fps.mp4'),
      pexels('train', 5, 35110516, '乡野车窗', '火车开过乡野，窗外是树和田', '14874410_720_1280_30fps.mp4', 'train-crossing-train-interior-trainlife-35110516.jpeg'),
      pexels('train', 6, 34859848, '乡间列车', '白天的乡间列车，窗外是很远的村子和田', '14773277_720_1280_60fps.mp4'),
    ],
  },
  {
    id: 'nighttrain',
    name: '夜车上',
    icon: 'i-lucide-tram-front',
    tagline: '深夜，窗外是别处的灯',
    backdrop: 'train',
    indoor: true,
    views: [
      pexels('nighttrain', 1, 37594553, '东京夜车', '夜里的电车穿过东京，窗外是亮着的城市', '15933270_720_1280_60fps.mp4', '4k-60fps-aesthetic-asia-37594553.jpeg'),
      pexels('nighttrain', 2, 36979682, '驶过亮着的街', '夜车驶过一条还亮着的街，店都开着灯', '15666513_720_1280_25fps.mp4'),
      pexels('nighttrain', 3, 36182455, '雪夜电车', '下雪的夜里，电车从城里开过', '15344798_720_1280_30fps.mp4'),
    ],
  },
  {
    id: 'plane',
    name: '万米高空',
    icon: 'i-lucide-plane',
    tagline: '离得最远的一种',
    backdrop: 'airplane',
    indoor: true,
    views: [
      pexels('plane', 1, 34467289, '舷窗云海', '飞机舷窗外是云海', '14605175_720_1280_30fps.mp4'),
      pexels('plane', 2, 38965935, '机翼与地平线', '舷窗外是机翼，远处是地平线', '16575282_720_1280_24fps.mp4'),
      pexels('plane', 3, 24390475, '云层上的机翼', '飞机在云层上面飞，窗外是机翼和云', '11896021_720_1280_30fps.mp4'),
      pexels('plane', 4, 34759076, '舷窗外的云', '靠窗的位置，窗外一团团的云', '14735746_720_1280_30fps.mp4'),
      pexels('plane', 5, 18139465, '靠窗座位', '靠窗的座位，往外看是天空和云', '18139465-hd_720_1280_60fps.mp4', 'air-airplane-window-beautiful-view-cloud-4k-18139465.jpeg'),
    ],
  },
  {
    id: 'sea',
    name: '海边',
    icon: 'i-lucide-waves',
    tagline: '只有一条线的远方',
    backdrop: 'seaside',
    indoor: false,
    views: [
      drawn('sea', 1, 'MC-sea_island-03', '夜海', '夜里的海，天上有星星，海面一直铺到天边', ['stars']),
      drawn('sea', 2, 'MC-sea_island-01', '白天的海', '白天的海，云很大，海面上闪着光', ['clouds', 'glint']),
      drawn('sea', 3, 'MC-seaside_bus_stop-02', '海边车站', '黄昏，海边的小车站，能看见海和远处的山', ['warm-clouds', 'motes']),
      pexels('sea', 1, 13663887, '海上日落', '太阳落进海里，海面是橙色的', '13663887-hd_720_1280_60fps.mp4'),
      pexels('sea', 2, 31937272, '远处的货轮', '平静的海，海平线上有一艘货轮', '13604160_720_1280_30fps.mp4'),
      pexels('sea', 3, 35822284, '暮色海面', '天快黑了，海面很安静', '15189159_720_1280_60fps.mp4'),
      pexels('sea', 4, 39270101, '远处的船', '平静的海上，远处有几条船在走', '16709301_720_1280_60fps.mp4'),
      pexels('sea', 5, 39979795, '落日与云', '海上的落日，云很厚', '17062220_720_1280_60fps.mp4'),
      pexels('sea', 6, 4609822, '海边下雪', '海边在下雪', '4609822-hd_720_1280_30fps.mp4'),
    ],
  },
  {
    id: 'ferry',
    name: '渡轮甲板',
    icon: 'i-lucide-ship',
    tagline: '在甲板上吹风',
    backdrop: 'ship',
    indoor: false,
    views: [
      pexels('ferry', 1, 39050805, '地中海渡轮', '在地中海的渡轮上，海很蓝', '16616674_720_1280_30fps.mp4'),
      pexels('ferry', 2, 37739169, '博斯普鲁斯渡轮', '阴天，渡轮开过博斯普鲁斯海峡', '16007209_720_1280_60fps.mp4'),
      pexels('ferry', 3, 35811920, '灰色的海', '灰色的海面上，一艘渡轮开过', '15183692_720_1280_30fps.mp4'),
    ],
  },
  {
    id: 'road',
    name: '公路上',
    icon: 'i-lucide-car-front',
    tagline: '副驾视角，一直开下去',
    backdrop: 'car',
    indoor: true,
    views: [
      pexels('road', 1, 32853897, '车窗外的公路', '坐在车里，窗外是公路和风景', '14002787_720_1280_30fps.mp4'),
      pexels('road', 2, 33018123, '山路', '车开在山路上，窗外是山', '14071138_720_1280_25fps.mp4'),
      pexels('road', 3, 18684571, '高速与天空', '车开在高速上，天很大', '18684571-hd_720_1280_30fps.mp4'),
      pexels('road', 4, 35202025, '沙漠公路', '车开过沙漠，两边全是沙', '14913653_720_1280_30fps.mp4', '4k-asia-islam-kaaba-35202025.jpeg'),
      pexels('road', 5, 35743109, '冬天的荒原', '冬天，车开过荒原', '15150876_720_1280_60fps.mp4', 'beautiful-nature-camping-cold-desert-desert-35743109.jpeg'),
      pexels('road', 6, 9011090, '沙漠公路延时', '沙漠里一条笔直的公路，云在走', '9011090-hd_720_1280_30fps.mp4', '4k-arid-asphalt-blue-sky-9011090.jpeg'),
    ],
  },
  {
    id: 'aurora',
    name: '北边',
    icon: 'i-lucide-sparkles',
    tagline: '很北的地方，天上有极光',
    backdrop: 'mountain',
    indoor: false,
    views: [
      pexels('aurora', 1, 25988225, '极光', '夜里，天上是极光', '11925561_720_1280_25fps.mp4'),
      pexels('aurora', 2, 40449011, '北极光', '很亮的北极光铺满了夜空', '17284647_720_1280_30fps.mp4'),
      pexels('aurora', 3, 39885802, '小屋上的极光', '北欧的小房子上面是极光', '17010211_720_1280_24fps.mp4'),
    ],
  },
  {
    id: 'stars',
    name: '星空下',
    icon: 'i-lucide-moon-star',
    tagline: '野外，星星在转',
    backdrop: 'campsite',
    indoor: false,
    views: [
      drawn('stars', 1, 'MC-school_rooftop-03', '天台', '夜里的天台，天上有星星，远处是城市', ['stars']),
      pexels('stars', 1, 32349013, '星空延时', '野外，满天的星星在慢慢转', '13800910_720_1280_30fps.mp4'),
      pexels('stars', 2, 40197917, '流星', '星空里划过流星', '17173655_720_1280_30fps.mp4'),
      pexels('stars', 3, 30054113, '星轨', '星星绕着转出一圈圈星轨', '12891204_720_1280_30fps.mp4'),
      pexels('stars', 4, 35150207, '树梢星空', '树梢上面是星空', '14890781_720_1280_30fps.mp4'),
    ],
  },
  {
    id: 'mountain',
    name: '山顶',
    icon: 'i-lucide-mountain-snow',
    tagline: '清晨，雾和日出',
    backdrop: 'mountain',
    indoor: false,
    views: [
      pexels('mountain', 1, 39481766, '群山日出', '太阳从一层层的山后面升起来', '16817659_720_1280_30fps.mp4'),
      pexels('mountain', 2, 34142319, '雾中日出', '清晨，山谷里的雾，太阳刚出来', '14476177_720_1280_60fps.mp4', '4k-sunrise-timelapse-atmospheric-sunrise-video-breathtaking-sunrise-timelapse-cinematic-foggy-34142319.jpeg'),
      pexels('mountain', 3, 38099722, '黎明山谷', '天刚亮，山很安静', '16176486_720_1280_25fps.mp4'),
      pexels('mountain', 4, 35571635, '山脊日出', '山脊上看日出', '15073542_720_1280_60fps.mp4'),
      pexels('mountain', 5, 39657533, '雾林晨光', '山里的树林有雾，晨光照进来', '16905653_720_1280_30fps.mp4'),
    ],
  },
];

export const ESCAPE_PLACE_PREFIX = 'escape:';
export const escapePlaceId = (destId: string) => `${ESCAPE_PLACE_PREFIX}${destId}`;

export function escapeDestination(id: string | null | undefined): EscapeDestination | undefined {
  if (!id) return undefined;
  const key = id.startsWith(ESCAPE_PLACE_PREFIX) ? id.slice(ESCAPE_PLACE_PREFIX.length) : id;
  return ESCAPE_DESTINATIONS.find((d) => d.id === key);
}

/** 某一幅画面在哪个去处（id 是"去处:编号"） */
export function escapeView(viewId: string | null | undefined): { dest: EscapeDestination; view: EscapeView } | undefined {
  if (!viewId) return undefined;
  const dest = escapeDestination(viewId.split(':')[0]);
  const view = dest?.views.find((v) => v.id === viewId);
  return dest && view ? { dest, view } : undefined;
}

/**
 * 去处也是地点：带她一起时，她这一段"在"那儿（聊天里记"和她来到海边 · 出逃"，聊天剧场按 backdrop 挑背景），
 * 离开出逃就回到原来的地方。不属于任何一个小世界，也不是你真实世界的地点（area 不是 real），不进足迹。
 */
export const ESCAPE_PLACES: MapLocation[] = ESCAPE_DESTINATIONS.map((d) => ({
  id: escapePlaceId(d.id),
  name: d.name,
  area: 'city',
  icon: d.icon,
  x: 0,
  y: 0,
  backdrop: d.backdrop,
  indoor: d.indoor,
  blurb: d.tagline,
  activities: [{ sceneId: 'escape', label: '出逃' }],
}));
registerPlaces(ESCAPE_PLACES);
