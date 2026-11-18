import type {
  MapLocation,
  TimeOfDay,
  TownBuild,
  TownDesign,
  TownGround,
  TownLight,
  TownLook,
  TownMood,
  TownPath,
  TownProp,
  TownRoof,
  TownShape,
  TownSize,
  TownTree,
  TownWall,
  TownWater,
  TownWindow,
  TownEdge,
  World,
} from '@app/shared';
import { hashString, purposeOf, type Purpose } from './layout';

/**
 * 小镇蓝图 → 能直接画的东西。
 * - 蓝图（TownLook / TownBuild，见 @app/shared 的 town.ts）由 AI 按世界观写；这里只负责把它补全：
 *   没写的零件用默认值，颜色只要一个底色，亮面和暗面由程序算出来。
 * - 没有蓝图的世界（演示角色、AI 还没画过的）用 EXAMPLE_LOOKS 里按地名猜的一份；这几份只是示例数据，不是皮肤。
 */

export type Tri = [string, string, string];

// —— 颜色 ——

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = rgb(a);
  const [r2, g2, b2] = rgb(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${f(r1, r2)}${f(g1, g2)}${f(b1, b2)}`;
}
/** 一个底色 → [底色, 亮面（偏暖）, 暗面（偏紫）]：像素画里阴影往冷色偏、高光往暖色偏 */
export function tri(base: string): Tri {
  return [base, mix(base, '#fff6dc', 0.24), mix(base, '#241a3a', 0.3)];
}
export function luminance(hex: string): number {
  const [r, g, b] = rgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// —— 每种零件的默认颜色（蓝图没写颜色时用） ——

const GROUND: Record<TownGround, string> = {
  grass: '#7ec26b',
  dirt: '#b48e5e',
  sand: '#ecd9a0',
  snow: '#eef2f7',
  stone: '#c4beb2',
  asphalt: '#3a4050',
  moss: '#6f9a5a',
  ash: '#7d7a78',
};
const PATH: Record<TownPath, string> = {
  dirt: '#c9a678',
  stone: '#cfc6b3',
  brick: '#b8674e',
  plank: '#c08d5e',
  asphalt: '#4a5263',
  sand: '#e8d4a0',
};
const ROOFS: Record<TownRoof, string[]> = {
  gable: ['#e07a5f', '#6b7a90', '#e5a13c'],
  hip: ['#8a5a44', '#5d7090', '#b35d4a'],
  curved: ['#4b5569', '#5a4a45', '#3f5a58'],
  flat: ['#7d8a9a', '#a7b3c0', '#5d90c0'],
  dome: ['#5db5e1', '#e8c56e', '#e9edf2'],
  spire: ['#4f5d8a', '#7a4a6a', '#3f6a5a'],
  thatch: ['#c9a35a', '#b8924a', '#d9b56a'],
  tent: ['#e05a5a', '#f2c14e', '#5db5e1'],
  tech: ['#2a2f3d', '#2a2236', '#1f2330'],
};
const WALLS: Record<TownWall, string[]> = {
  plaster: ['#f4e7d0', '#e6edf3', '#f3e3cf'],
  brick: ['#c6644e', '#a85a48', '#b8734e'],
  wood: ['#a8774f', '#8f633e', '#b98a5e'],
  log: ['#9a6a42', '#86593a', '#a87a4e'],
  stone: ['#b8b2a6', '#a39d92', '#c9c2b4'],
  metal: ['#2b3040', '#33293f', '#26333f'],
  paper: ['#f3ecd8', '#efe5d0', '#f8f1e2'],
  bamboo: ['#b8c47a', '#a8b46a', '#c8d48a'],
};
const TREE: Record<TownTree, string> = {
  round: '#4fa65a',
  pine: '#4d7a56',
  bamboo: '#6f9a5a',
  palm: '#5aa64f',
  blossom: '#f2b3c6',
  willow: '#7db85a',
  maple: '#d9683a',
  dead: '#7a6450',
  cactus: '#5a9a5a',
  crystal: '#9fd8f0',
  neon: '#49c2b4',
};
/** 叶子是绿色的那几种：蓝图写了树叶色就换成那个颜色 */
const GREEN_TREES = new Set<TownTree>(['round', 'pine', 'bamboo', 'palm', 'willow', 'cactus']);
const LAMP: Record<Exclude<TownLight, 'none'>, string> = {
  streetlamp: '#ffe6a0',
  lantern: '#ff7a55',
  torch: '#ffb347',
  'stone-lantern': '#ffd18a',
  neon: '#7fe8ff',
};

export interface ResolvedLook {
  ground: TownGround;
  path: TownPath;
  water: TownWater[];
  edges: TownEdge[];
  trees: TownTree[];
  lights: TownLight;
  mood: TownMood;
  roof: TownRoof;
  wall: TownWall;
  window: TownWindow;
  groundTri: Tri;
  pathTri: Tri;
  sandTri: Tri;
  /** 水：底色、亮、暗、浪花 */
  water4: [string, string, string, string];
  roofs: string[];
  walls: string[];
  accent: string[];
  foliage: (kind: TownTree) => Tri;
  plank: [string, string];
  rock: [string, string];
  /** 窗户夜里亮的颜色、路灯的颜色 */
  litWindow: string;
  lamp: string;
  /** 这一镇是不是霓虹调（窗、灯会发光，白天也压暗一点） */
  neon: boolean;
}

export function resolveLook(look: TownLook): ResolvedLook {
  const c = look.colors ?? {};
  const ground = look.ground ?? 'grass';
  const path = look.path ?? (ground === 'asphalt' ? 'asphalt' : ground === 'sand' ? 'sand' : 'dirt');
  const roof = look.roof ?? 'gable';
  const wall = look.wall ?? 'plaster';
  const window = look.window ?? 'glass';
  const lights = look.lights ?? 'streetlamp';
  const mood = look.mood ?? 'bright';
  const accent = c.accent?.length ? c.accent : ['#e05a5a', '#ffd23f', '#5db5e1'];
  const neon = window === 'neon' || lights === 'neon' || mood === 'neon';
  const groundBase = c.ground ?? GROUND[ground];
  const waterBase = c.water ?? (neon ? '#173a57' : ground === 'snow' ? '#7fc3e6' : ground === 'ash' ? '#5a7280' : '#5db5e1');
  return {
    ground,
    path,
    water: look.water ?? [],
    edges: look.edges ?? ['forest'],
    trees: look.trees?.length ? look.trees : ['round'],
    lights,
    mood,
    roof,
    wall,
    window,
    groundTri: tri(groundBase),
    pathTri: tri(c.path ?? PATH[path]),
    sandTri: tri(ground === 'sand' ? groundBase : '#f2e0a8'),
    water4: [waterBase, mix(waterBase, '#ffffff', 0.3), mix(waterBase, '#0a1a30', 0.3), mix(waterBase, '#ffffff', 0.78)],
    roofs: c.roofs?.length ? c.roofs : ROOFS[roof],
    walls: c.walls?.length ? c.walls : WALLS[wall],
    accent,
    foliage: (kind) => tri(c.foliage && GREEN_TREES.has(kind) ? c.foliage : TREE[kind]),
    plank: ['#c08d5e', '#8f633e'],
    rock: [mix(groundBase, '#9aa0a8', 0.6), mix(groundBase, '#6a7078', 0.6)],
    litWindow: window === 'neon' ? accent[0]! : window === 'paper' || window === 'lattice' ? '#ffcf7a' : '#ffd77a',
    lamp: lights === 'none' ? '#ffe6a0' : lights === 'neon' ? accent[0]! : LAMP[lights],
    neon,
  };
}

/** 时段：整体乘一层颜色；夜里窗户、路灯另外再亮起来 */
export const TOD_TINT: Record<TimeOfDay, string | null> = {
  dawn: '#ffd8c4',
  morning: null,
  noon: null,
  afternoon: '#fff1dd',
  dusk: '#f3b693',
  night: '#7a84b6',
  late: '#636da3',
};
/** 气氛：在时段之外再压一层（雾另外画） */
export const MOOD_TINT: Record<TownMood, string | null> = {
  bright: null,
  warm: '#fff0dc',
  cool: '#e6edf8',
  misty: '#eef0f4',
  dark: '#bdb8cc',
  neon: '#c8cde6',
};
export function isDark(tod: TimeOfDay): boolean {
  return tod === 'night' || tod === 'late';
}
export function isLit(tod: TimeOfDay, look: ResolvedLook): boolean {
  return isDark(tod) || tod === 'dusk' || look.neon;
}

// —— 建筑 ——

/** 每种形状在三个大小下占几格（宽 × 高） */
const SHAPE_SIZE: Record<TownShape, Record<TownSize, [number, number]>> = {
  house: { s: [3, 3], m: [4, 4], l: [5, 4] },
  hall: { s: [5, 4], m: [6, 4], l: [7, 5] },
  tower: { s: [3, 3], m: [3, 3], l: [4, 4] },
  pagoda: { s: [4, 4], m: [5, 5], l: [6, 6] },
  shop: { s: [3, 3], m: [4, 3], l: [5, 4] },
  stalls: { s: [4, 2], m: [6, 3], l: [7, 3] },
  dome: { s: [4, 4], m: [5, 4], l: [6, 5] },
  arena: { s: [6, 4], m: [8, 5], l: [9, 6] },
  plaza: { s: [4, 4], m: [5, 5], l: [6, 6] },
  garden: { s: [4, 4], m: [5, 4], l: [6, 5] },
  field: { s: [4, 3], m: [6, 4], l: [7, 5] },
  pool: { s: [5, 4], m: [6, 5], l: [7, 5] },
  dock: { s: [3, 2], m: [4, 2], l: [6, 2] },
  beach: { s: [4, 3], m: [5, 3], l: [6, 3] },
  wheel: { s: [5, 5], m: [6, 6], l: [6, 6] },
  gate: { s: [3, 2], m: [4, 2], l: [5, 3] },
  shrine: { s: [3, 3], m: [4, 4], l: [5, 4] },
  tent: { s: [3, 3], m: [4, 3], l: [5, 4] },
  ruin: { s: [3, 3], m: [4, 4], l: [5, 4] },
  cliff: { s: [5, 3], m: [7, 3], l: [9, 4] },
  statue: { s: [2, 2], m: [3, 3], l: [3, 3] },
};

/** 没有蓝图的地点：按用途给一个形状、大小、招牌（和以前的样子一致） */
const PURPOSE_BUILD: Record<Purpose, TownBuild> = {
  home: { shape: 'house', size: 'm' },
  study: { shape: 'hall', size: 'm', sign: 'book', window: 'glass' },
  dining: { shape: 'hall', size: 's', sign: 'bowl' },
  cafe: { shape: 'shop', size: 'm', sign: 'cup' },
  park: { shape: 'plaza', size: 's' },
  track: { shape: 'arena', size: 'm' },
  riverside: { shape: 'dock', size: 'm' },
  seaside: { shape: 'beach', size: 'm' },
  pool: { shape: 'pool', size: 'm', sign: 'wave' },
  gym: { shape: 'hall', size: 's', sign: 'dumbbell' },
  cinema: { shape: 'hall', size: 's', sign: 'film' },
  market: { shape: 'stalls', size: 'm' },
  gallery: { shape: 'hall', size: 's', sign: 'palette' },
  aquarium: { shape: 'dome', size: 'm', sign: 'fish' },
  amusement: { shape: 'wheel', size: 'm', sign: 'star' },
  music: { shape: 'house', size: 'm', sign: 'note' },
};

export interface ResolvedBuild {
  shape: TownShape;
  w: number;
  h: number;
  floors: number;
  roof: TownRoof;
  wall: TownWall;
  window: TownWindow;
  wallTri: Tri;
  roofTri: Tri;
  /** 蓝图里单独写了主色（跑道、雕像这些平地形状也用它） */
  hasColor: boolean;
  sign?: string;
  props: TownProp[];
}

/** 一个地点：AI 写的 build 优先，没写的部分按用途和整个小镇的样子补 */
export function resolveBuild(loc: MapLocation, homeId: string, build: TownBuild | undefined, look: ResolvedLook, example?: Partial<Record<Purpose, TownBuild>>): ResolvedBuild {
  const purpose = purposeOf(loc, homeId);
  const base = { ...PURPOSE_BUILD[purpose], ...(example?.[purpose] ?? {}) };
  const b: TownBuild = build ? { ...(build.shape ? {} : base), ...build } : base;
  const shape = b.shape ?? 'house';
  const [w, h] = SHAPE_SIZE[shape][b.size ?? 'm'];
  const seed = hashString(loc.id);
  const pickColor = (list: string[], k: number) => list[k % list.length]!;
  const roof: TownRoof = b.roof ?? (shape === 'pagoda' ? 'curved' : shape === 'tent' ? 'tent' : shape === 'dome' ? 'dome' : shape === 'tower' && (look.roof === 'gable' || look.roof === 'hip' || look.roof === 'flat') ? 'spire' : look.roof);
  return {
    shape,
    w,
    h,
    floors: b.floors ?? (shape === 'tower' || shape === 'pagoda' ? 3 : 1),
    roof,
    wall: b.wall ?? look.wall,
    window: b.window ?? look.window,
    wallTri: tri(b.color ?? pickColor(look.walls, seed)),
    roofTri: tri(b.roofColor ?? pickColor(look.roofs, seed >>> 3)),
    hasColor: !!b.color,
    sign: b.sign,
    props: b.props ?? [],
  };
}

// —— 没有蓝图时的示例（只在 AI 还没画过时用，也给预览切换用） ——

export interface ExampleLook {
  label: string;
  look: TownLook;
  /** 按用途给的建筑细节（演示角色的世界靠这个保持以前的样子） */
  builds?: Partial<Record<Purpose, TownBuild>>;
}

export const EXAMPLE_LOOKS: Record<string, ExampleLook> = {
  modern: {
    label: '现代',
    look: {
      ground: 'grass',
      path: 'dirt',
      edges: ['forest'],
      trees: ['round', 'round', 'blossom'],
      lights: 'streetlamp',
      mood: 'bright',
      roof: 'flat',
      wall: 'plaster',
      window: 'glass',
      colors: { path: '#eadcb9', roofs: ['#6b7a90', '#5d90c0', '#7d8a9a'], walls: ['#f4e7d0', '#e6edf3', '#f3e3cf'] },
    },
    builds: {
      home: { roof: 'gable', roofColor: '#e07a5f', color: '#f4e7d0' },
      study: { roof: 'gable', wall: 'brick', color: '#c6644e', roofColor: '#6b7a90' },
      dining: { roof: 'gable', color: '#f3e3cf', roofColor: '#e5a13c' },
      cafe: { roof: 'gable', color: '#f3e3cf', roofColor: '#6b7a90' },
      music: { roof: 'gable', color: '#efe2f0', roofColor: '#9b80c6' },
      pool: { color: '#e6edf3', roofColor: '#5d90c0' },
      gym: { color: '#e6edf3', roofColor: '#5d90c0' },
      cinema: { color: '#8a5a6c', roofColor: '#4d3a4a' },
      gallery: { color: '#f6f4ef', roofColor: '#6b7a90' },
      aquarium: { color: '#e6edf3', roofColor: '#5d90c0' },
      track: { color: '#c8604a' },
    },
  },
  xianxia: {
    label: '仙侠',
    look: {
      ground: 'grass',
      path: 'stone',
      edges: ['forest'],
      trees: ['pine', 'round', 'bamboo', 'blossom'],
      lights: 'stone-lantern',
      mood: 'bright',
      roof: 'curved',
      wall: 'wood',
      window: 'lattice',
      colors: { ground: '#93b77c', foliage: '#4d7a56', roofs: ['#4b5569', '#5a4a45', '#3f5a58'], walls: ['#efe5d0', '#a35c3d', '#e9dfca'], accent: ['#d94a38', '#e8b84a', '#3f8f86'] },
    },
    builds: { amusement: { shape: 'pagoda' }, study: { floors: 2 }, track: { shape: 'arena' } },
  },
  cyber: {
    label: '赛博',
    look: {
      ground: 'asphalt',
      path: 'asphalt',
      edges: [],
      trees: ['neon', 'crystal'],
      lights: 'neon',
      mood: 'neon',
      roof: 'tech',
      wall: 'metal',
      window: 'neon',
      colors: { ground: '#2c3341', water: '#173a57', roofs: ['#1f2330', '#2a2236'], walls: ['#2b3040', '#33293f', '#26333f'], accent: ['#3fe0d0', '#ff4fa3', '#ffd23f'] },
    },
    builds: { amusement: { shape: 'hall', floors: 2 }, home: { shape: 'tower', size: 'l' } },
  },
};

/** 没有蓝图的世界：按地名猜一份示例（演示角色、AI 还没画过的） */
export function guessExample(world: World): string {
  const names = world.locations.map((l) => l.name).join('') + world.name + world.blurb;
  if (/宗|阁|殿|峰|仙|观星|灵|山门|竹舍|膳堂/.test(names)) return 'xianxia';
  if (/赛博|霓虹|全息|胶囊|义体|第.区|数据/.test(names)) return 'cyber';
  return 'modern';
}

/** 这个世界最终怎么画：预览示例 > AI 的蓝图 > 按地名猜的示例 */
export function lookFor(world: World, design: TownDesign | null | undefined, preview: string | null) {
  const ex = EXAMPLE_LOOKS[preview ?? ''] ?? (design ? null : EXAMPLE_LOOKS[guessExample(world)]);
  const look = resolveLook(ex ? ex.look : design!.look);
  const builds = new Map<string, ResolvedBuild>();
  for (const loc of world.locations) builds.set(loc.id, resolveBuild(loc, world.homeId, ex ? undefined : design?.builds[loc.id], look, ex?.builds));
  return { look, builds };
}
