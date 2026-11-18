import { BACKGROUND_KINDS, backdropKindFor, getScene, type BackgroundPlace, type BackdropKey, type Character, type MapLocation, type SceneFigureAdjust, type TimeOfDay } from '@app/shared';
import type { InjectionKey, Ref } from 'vue';
import { SLEEP_PRESET_PLACES, sleepSceneLayoutKey } from './sleep/places';

/** 当前场景发生在地图上的哪个地点：ScenePage 决定，SceneShell 和各场景读取 */
export const SCENE_LOCATION: InjectionKey<Ref<MapLocation | null>> = Symbol('scene-location');

const HOME_ROOMS: Partial<Record<string, BackdropKey>> = { study: 'study', read: 'living', watch: 'living', meal: 'dining', home: 'living' };
const atHome = (loc: MapLocation) => (loc.area === 'home' || loc.id === 'real:home')
  && ['bedroom', 'room', 'living'].includes(backdropKindFor(loc));

/** 家里的活动对应具体房间；其它地方按名称细分旧世界的宽泛背景 key。 */
export function backdropAt(loc: MapLocation | null | undefined, sceneId: string): string {
  const scene = getScene(sceneId);
  if (!loc) return scene.backdrop;
  if (atHome(loc)) return HOME_ROOMS[sceneId] ?? scene.backdrop;
  return backdropKindFor(loc);
}

export function backgroundPlaceAt(loc: MapLocation | null | undefined, sceneId: string): BackgroundPlace | null {
  if (!loc) return null;
  if (!atHome(loc)) return loc;
  const backdrop = backdropAt(loc, sceneId) as BackdropKey;
  return {
    id: `${loc.id}:${backdrop}`, name: BACKGROUND_KINDS[backdrop].label, backdrop, indoor: true,
    // 一个卧室系列不能被套用到厨房或书房；风格由 StageView 的世界观上下文继续保留。
    ...(backdrop === loc.backdrop && loc.backgroundSet ? { backgroundSet: loc.backgroundSet } : {}),
  };
}

/** 场景标题：图书馆 · 陪伴学习；家里只写房间：卧室 · 哄睡 */
export function titleAt(loc: MapLocation | null | undefined, sceneId: string): string {
  const scene = getScene(sceneId);
  const label = loc?.activities.find((a) => a.sceneId === sceneId)?.label;
  if (!loc) return scene.name;
  if (loc.area === 'home') return label ?? scene.name;
  return `${loc.name} · ${label ?? scene.name}`;
}

export type FigureLayout = { left: number; bottom: number; height: number };
/** 按头像框摆的画面：脸的中心在画面里的位置（占宽、占高的比例）和脸（头像框）占画面高度的多少 */
export type FaceFrame = { x: number; y: number; size: number };

/** 场景给的立绘位置叠上角色在这个场景的微调（立绘设置 → 各场景的位置和大小） */
export function adjustFigureLayout(layout: FigureLayout, adj: SceneFigureAdjust | null | undefined): FigureLayout {
  if (!adj) return layout;
  return { left: layout.left + adj.x, bottom: layout.bottom + adj.y, height: layout.height * adj.scale };
}

/** 按头像框摆的画面叠上微调：x / y 同样是占画面的百分比（正数往右、往上），scale 放大脸 */
export function adjustFaceFrame(frame: FaceFrame, adj: SceneFigureAdjust | null | undefined): FaceFrame {
  if (!adj) return frame;
  return { x: frame.x + adj.x / 100, y: frame.y - adj.y / 100, size: frame.size * adj.scale };
}

/** 存一个画面的立绘微调（PortraitSet.sceneLayouts[key]）：收在范围里；挪回原样就把这一条删掉。没有立绘的角色不存 */
export function setSceneFigureAdjust(character: Character, key: string, next: SceneFigureAdjust): void {
  const s = character.portraits;
  if (!s) return;
  const adj: SceneFigureAdjust = {
    x: Math.round(Math.max(-60, Math.min(60, next.x)) * 10) / 10,
    y: Math.round(Math.max(-80, Math.min(80, next.y)) * 10) / 10,
    scale: Math.round(Math.max(0.4, Math.min(2.5, next.scale)) * 100) / 100,
  };
  const all = { ...s.sceneLayouts };
  if (!adj.x && !adj.y && adj.scale === 1) delete all[key];
  else all[key] = adj;
  s.sceneLayouts = all;
  character.updatedAt = Date.now();
}

/** place / tod：立绘设置里预览这个画面时铺哪张背景、按什么时段（不给按场景的默认背景） */
type FigureEntry = { id: string; scene: string; name?: string; label?: string; place?: BackgroundPlace; tod?: TimeOfDay } & (
  | { layout: FigureLayout; face?: undefined }
  | { face: FaceFrame; layout?: undefined }
);

/** 哄睡全屏的画面（连麦、故事、场景）立绘平时摆在哪 */
export const SLEEP_FULL_LAYOUT: FigureLayout = { left: 50, bottom: 24, height: 68 };

/**
 * 各场景平时立绘摆在哪（和场景页里给 SceneShell 的 layout 一致），立绘设置里调位置时按它预览。
 * id 是 sceneLayouts 里的 key；一个场景有几种画面、立绘位置差得远时各占一条（scene 指回场景，label 写是哪种画面），
 * 场景页把对应的 id 作为 layoutKey 交给 SceneShell，这样调好一种画面不会把另一种带偏。
 * 不是场景的画面（聚焦主题）写 name，scene 只用来挑预览的背景、衣服和姿势；
 * 只露出一截、按头像框摆的画面（聚焦主题完整对话上面的她）写 face 而不是 layout。
 */
export const SCENE_FIGURE_LAYOUTS: FigureEntry[] = [
  { id: 'date', scene: 'date', layout: { left: 50, bottom: 22, height: 66 } },
  { id: 'exercise', scene: 'exercise', layout: { left: 70, bottom: 16, height: 62 } },
  { id: 'meal', scene: 'meal', layout: { left: 50, bottom: 24, height: 62 } },
  // 陪伴学习：key 'study' 沿用旧数据，是一起专注时坐在计时器下面那种
  { id: 'study', scene: 'study', label: '一起专注', layout: { left: 50, bottom: -30, height: 76 } },
  { id: 'study:split', scene: 'study', label: '开始前 / 学完', layout: { left: 50, bottom: 50, height: 46 } },
  { id: 'study:solo', scene: 'study', label: '各自专注', layout: { left: 72, bottom: 50, height: 40 } },
  { id: 'heart', scene: 'heart', layout: { left: 50, bottom: 16, height: 70 } },
  { id: 'poke', scene: 'poke', layout: { left: 50, bottom: 30, height: 62 } },
  // 哄睡：卧室里选怎么睡是一种；全屏的连麦、故事各一种；场景里每个睡前的地方各一种
  // （自己从素材库选的地方不在这张表里，进了那个画面点"调立绘"调，同样各记各的）
  { id: 'sleep', scene: 'sleep', label: '选怎么睡', layout: { left: 50, bottom: 40, height: 50 } },
  { id: 'sleep:mic', scene: 'sleep', label: '连麦（还没画好图时）', layout: SLEEP_FULL_LAYOUT },
  { id: 'sleep:story', scene: 'sleep', label: '故事', layout: SLEEP_FULL_LAYOUT },
  ...SLEEP_PRESET_PLACES.map(
    (p): FigureEntry => ({
      id: sleepSceneLayoutKey(p.id),
      scene: 'sleep',
      label: `场景 · ${p.name}`,
      layout: SLEEP_FULL_LAYOUT,
      place: { id: `sleep:${p.family}`, name: p.name, backgroundSet: p.family },
      tod: 'night',
    }),
  ),
  { id: 'home', scene: 'home', layout: { left: 72, bottom: 47, height: 36 } },
  { id: 'watch', scene: 'watch', layout: { left: 78, bottom: 56, height: 30 } },
  { id: 'read', scene: 'read', layout: { left: 78, bottom: 56, height: 30 } },
  { id: 'game', scene: 'game', layout: { left: 78, bottom: 56, height: 30 } },
  // 出逃：站在画面右边，左边留给窗外 / 海平线
  { id: 'escape', scene: 'escape', layout: { left: 66, bottom: 22, height: 60 } },
  // 聚焦主题的首页：下面压着她的台词、回复栏，人往上站一点
  { id: 'focus', scene: 'free', name: '聚焦主题', label: '首页', layout: { left: 50, bottom: 12, height: 78 } },
  // 聚焦主题的完整对话：上面只露出一截，脸放在那一截的正中
  { id: 'focus:chat', scene: 'free', name: '聚焦主题', label: '完整对话上面', face: { x: 0.5, y: 0.56, size: 0.46 } },
];

/** 某个画面平时立绘摆在哪（SCENE_FIGURE_LAYOUTS 里按 layout 摆的），叠上角色在这个画面的微调 */
export function figureLayoutFor(id: string, adj: SceneFigureAdjust | null | undefined): FigureLayout {
  return adjustFigureLayout(SCENE_FIGURE_LAYOUTS.find((s) => s.id === id)!.layout!, adj);
}

/** 某个按头像框摆的画面（SCENE_FIGURE_LAYOUTS 里写 face 的），叠上角色在这个画面的微调 */
export function faceFrameFor(id: string, adj: SceneFigureAdjust | null | undefined): FaceFrame {
  return adjustFaceFrame(SCENE_FIGURE_LAYOUTS.find((s) => s.id === id)!.face!, adj);
}
