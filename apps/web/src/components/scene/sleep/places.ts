/**
 * 哄睡 · 场景里现成的四个睡前的地方（设计文档 §9.4）：family 是背景素材库里的系列 id。
 * 单独放一个文件：挑地方的画面（SleepImmersion.vue）要用，立绘设置里"各场景的位置和大小"也要按它列出每个地方（components/scene/location.ts）。
 */
export interface SleepPresetPlace {
  id: string;
  name: string;
  icon: string;
  family: string;
  blurb: string;
}

export const SLEEP_PRESET_PLACES: SleepPresetPlace[] = [
  { id: 'train', name: '夜行列车', icon: 'i-lucide-train-front', family: 'MC-inside_train/火车/通勤列车车厢', blurb: '深夜的列车，车厢空空的，轻轻摇晃，窗外的灯一盏一盏往后退' },
  { id: 'onsen', name: '温泉旅馆', icon: 'i-lucide-waves', family: 'MC-hot_spring/温泉/旅馆温泉', blurb: '夜里的温泉旅馆，露天的池子冒着热气，远处有流水声' },
  { id: 'plane', name: '夜航飞机', icon: 'i-lucide-plane', family: 'AP-airplane/飞机/客舱', blurb: '夜航的客舱，灯调暗了，引擎低低地响，舷窗外是云和星星' },
  { id: 'cabin', name: '林间小屋', icon: 'i-lucide-trees', family: 'MC-attic_room/阁楼/木质阁楼', blurb: '森林深处的小木屋，柴火偶尔噼啪一声，窗外是风吹过树林的声音' },
];

/**
 * 立绘在某个睡前的地方怎么摆，记在哪个 key 下（PortraitSet.sceneLayouts）：每个地方各记各的。
 * placeId：现成的四个是上面的 id，自己从素材库选的是系列 id
 */
export const sleepSceneLayoutKey = (placeId: string) => `sleep:scene:${placeId}`;
