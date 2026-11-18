/**
 * 像素小镇的蓝图：AI 按角色卡的世界观写，程序（apps/web 的小镇引擎）照着画。
 * - 没有现成的皮肤和地点模板：蓝图只能用这里列出的零件，但颜色、组合、每栋楼长什么样都由 AI 定；
 * - 两处会写：「节律」建世界时顺带写（look + 每个地点的 build），已有的世界可以单独"画小镇"（draw-town）；
 * - 读的时候尽量宽容：认不出的值丢掉，交给程序的默认值；颜色只认 #rgb / #rrggbb。
 * 零件的中文说明写在节律预设的"小镇零件"一块里，改这里的列表时那一块也要跟着改。
 */

export const TOWN_GROUNDS = ['grass', 'dirt', 'sand', 'snow', 'stone', 'asphalt', 'moss', 'ash'] as const;
export const TOWN_PATHS = ['dirt', 'stone', 'brick', 'plank', 'asphalt', 'sand'] as const;
export const TOWN_WATERS = ['river', 'sea', 'lake', 'moat'] as const;
export const TOWN_EDGES = ['forest', 'mountains', 'walls', 'cliffs'] as const;
export const TOWN_TREES = ['round', 'pine', 'bamboo', 'palm', 'blossom', 'willow', 'maple', 'dead', 'cactus', 'crystal', 'neon'] as const;
export const TOWN_LIGHTS = ['streetlamp', 'lantern', 'torch', 'stone-lantern', 'neon', 'none'] as const;
export const TOWN_MOODS = ['bright', 'warm', 'cool', 'misty', 'dark', 'neon'] as const;
export const TOWN_ROOFS = ['gable', 'hip', 'curved', 'flat', 'dome', 'spire', 'thatch', 'tent', 'tech'] as const;
export const TOWN_WALLS = ['plaster', 'brick', 'wood', 'log', 'stone', 'metal', 'paper', 'bamboo'] as const;
export const TOWN_WINDOWS = ['glass', 'lattice', 'paper', 'arched', 'round', 'neon', 'none'] as const;
export const TOWN_SHAPES = [
  'house',
  'hall',
  'tower',
  'pagoda',
  'shop',
  'stalls',
  'dome',
  'arena',
  'plaza',
  'garden',
  'field',
  'pool',
  'dock',
  'beach',
  'wheel',
  'gate',
  'shrine',
  'tent',
  'ruin',
  'cliff',
  'statue',
] as const;
export const TOWN_SIGNS = [
  'book',
  'bowl',
  'cup',
  'note',
  'film',
  'fish',
  'dumbbell',
  'wave',
  'palette',
  'heart',
  'star',
  'sword',
  'scroll',
  'leaf',
  'moon',
  'flame',
  'gear',
  'potion',
  'cross',
  'coin',
  'crown',
  'anchor',
  'paw',
  'flower',
  'shield',
] as const;
export const TOWN_PROPS = ['lantern', 'flag', 'fence', 'barrels', 'crates', 'well', 'campfire', 'bench', 'flowers', 'boat', 'cart', 'carving'] as const;
export const TOWN_SIZES = ['s', 'm', 'l'] as const;

export type TownGround = (typeof TOWN_GROUNDS)[number];
export type TownPath = (typeof TOWN_PATHS)[number];
export type TownWater = (typeof TOWN_WATERS)[number];
export type TownEdge = (typeof TOWN_EDGES)[number];
export type TownTree = (typeof TOWN_TREES)[number];
export type TownLight = (typeof TOWN_LIGHTS)[number];
export type TownMood = (typeof TOWN_MOODS)[number];
export type TownRoof = (typeof TOWN_ROOFS)[number];
export type TownWall = (typeof TOWN_WALLS)[number];
export type TownWindow = (typeof TOWN_WINDOWS)[number];
export type TownShape = (typeof TOWN_SHAPES)[number];
export type TownSign = (typeof TOWN_SIGNS)[number];
export type TownProp = (typeof TOWN_PROPS)[number];
export type TownSize = (typeof TOWN_SIZES)[number];

/** 整个小镇的样子：地面、路、水、四周、树、灯、气氛、默认的屋顶 / 墙 / 窗，和一组颜色 */
export interface TownLook {
  ground?: TownGround;
  path?: TownPath;
  water?: TownWater[];
  edges?: TownEdge[];
  trees?: TownTree[];
  lights?: TownLight;
  mood?: TownMood;
  roof?: TownRoof;
  wall?: TownWall;
  window?: TownWindow;
  colors?: {
    ground?: string;
    path?: string;
    water?: string;
    foliage?: string;
    roofs?: string[];
    walls?: string[];
    accent?: string[];
  };
}

/** 一个地点的建筑：形状、大小、层数，可以单独换屋顶 / 墙 / 窗和颜色，招牌图标，门口的摆设 */
export interface TownBuild {
  shape?: TownShape;
  size?: TownSize;
  floors?: number;
  roof?: TownRoof;
  wall?: TownWall;
  window?: TownWindow;
  color?: string;
  roofColor?: string;
  sign?: TownSign;
  props?: TownProp[];
}

/** 一个角色的小镇蓝图：builds 按地点 id */
export interface TownDesign {
  look: TownLook;
  builds: Record<string, TownBuild>;
  /** 谁写的（模型名）、什么时候 */
  model?: string;
  at?: number;
}

// —— 读：宽容地把模型写的值认成零件 ——

const ALIASES: Record<string, string> = {
  // 形状
  temple: 'shrine',
  torii: 'gate',
  archway: 'gate',
  castle: 'hall',
  palace: 'hall',
  mansion: 'hall',
  manor: 'hall',
  school: 'hall',
  market: 'stalls',
  stall: 'stalls',
  fountain: 'plaza',
  square: 'plaza',
  park: 'garden',
  farm: 'field',
  pier: 'dock',
  harbor: 'dock',
  harbour: 'dock',
  port: 'dock',
  lighthouse: 'tower',
  windmill: 'tower',
  ferris: 'wheel',
  monument: 'statue',
  mountain: 'cliff',
  rock: 'cliff',
  // 屋顶（形状里 pagoda 直接认得，这条只对屋顶起作用）
  pagoda: 'curved',
  eave: 'curved',
  eaves: 'curved',
  pitched: 'gable',
  cone: 'spire',
  conical: 'spire',
  straw: 'thatch',
  // 墙、窗、地面、路
  wooden: 'wood',
  timber: 'wood',
  concrete: 'plaster',
  shoji: 'paper',
  stained: 'arched',
  soil: 'dirt',
  desert: 'sand',
  cobblestone: 'stone',
  pavement: 'stone',
  gravel: 'dirt',
  road: 'asphalt',
  boardwalk: 'plank',
  streetlight: 'streetlamp',
  lamp: 'streetlamp',
};

function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase().replace(/[_\s]+/g, '-') : '';
}

function pick<T extends string>(list: readonly T[], v: unknown): T | undefined {
  const s = norm(v);
  if (!s) return undefined;
  if ((list as readonly string[]).includes(s)) return s as T;
  const alias = ALIASES[s];
  if (alias && (list as readonly string[]).includes(alias)) return alias as T;
  // "curved-roof"、"stone walls" 这种：里面含着一个零件名就算
  return list.find((k) => s.split('-').includes(k)) ?? list.find((k) => s.includes(k));
}

function pickMany<T extends string>(list: readonly T[], v: unknown, max: number): T[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，、|/]+/) : [];
  const out: T[] = [];
  for (const item of raw) {
    const k = pick(list, item);
    if (k && !out.includes(k)) out.push(k);
    if (out.length >= max) break;
  }
  return out.length ? out : undefined;
}

export function townColor(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return undefined;
}

function colorList(v: unknown, max: number): string[] | undefined {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,，\s]+/) : [];
  const out = raw.map(townColor).filter((c): c is string => !!c).slice(0, max);
  return out.length ? out : undefined;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function compact<T extends object>(o: T): T | undefined {
  const entries = Object.entries(o).filter(([, v]) => v !== undefined);
  return entries.length ? (Object.fromEntries(entries) as T) : undefined;
}

export function parseTownLook(v: unknown): TownLook | undefined {
  if (!isObj(v)) return undefined;
  const c = isObj(v.colors) ? v.colors : {};
  return compact<TownLook>({
    ground: pick(TOWN_GROUNDS, v.ground),
    path: pick(TOWN_PATHS, v.path),
    water: pickMany(TOWN_WATERS, v.water, 2),
    edges: pickMany(TOWN_EDGES, v.edges, 3),
    trees: pickMany(TOWN_TREES, v.trees, 4),
    lights: pick(TOWN_LIGHTS, v.lights),
    mood: pick(TOWN_MOODS, v.mood),
    roof: pick(TOWN_ROOFS, v.roof),
    wall: pick(TOWN_WALLS, v.wall),
    window: pick(TOWN_WINDOWS, v.window),
    colors: compact({
      ground: townColor(c.ground),
      path: townColor(c.path),
      water: townColor(c.water),
      foliage: townColor(c.foliage),
      roofs: colorList(c.roofs ?? c.roof, 3),
      walls: colorList(c.walls ?? c.wall, 3),
      accent: colorList(c.accent ?? c.accents, 3),
    }),
  });
}

export function parseTownBuild(v: unknown): TownBuild | undefined {
  if (!isObj(v)) return undefined;
  const floors = Number(v.floors);
  return compact<TownBuild>({
    shape: pick(TOWN_SHAPES, v.shape),
    size: pick(TOWN_SIZES, v.size),
    floors: Number.isFinite(floors) && floors > 0 ? Math.min(3, Math.max(1, Math.round(floors))) : undefined,
    roof: pick(TOWN_ROOFS, v.roof),
    wall: pick(TOWN_WALLS, v.wall),
    window: pick(TOWN_WINDOWS, v.window),
    color: townColor(v.color),
    roofColor: townColor(v.roofColor ?? v.roof_color),
    sign: pick(TOWN_SIGNS, v.sign),
    props: pickMany(TOWN_PROPS, v.props, 4),
  });
}

/**
 * "画小镇"的输出：{"look": {...}, "buildings": [{"at": "地点 id", "shape": ...}]}。
 * at 交给 resolve 认（地点 id、key、名字都行）；认不出的那一栋丢掉。
 */
export function parseTownDesign(v: unknown, resolve: (ref: string) => string | null): TownDesign | null {
  if (!isObj(v)) return null;
  const look = parseTownLook(v.look) ?? {};
  const builds: Record<string, TownBuild> = {};
  const list = Array.isArray(v.buildings) ? v.buildings : Array.isArray(v.builds) ? v.builds : [];
  for (const b of list) {
    if (!isObj(b)) continue;
    const id = resolve(String(b.at ?? b.id ?? b.key ?? b.name ?? ''));
    const build = parseTownBuild(b);
    if (id && build) builds[id] = build;
  }
  if (!Object.keys(look).length && !Object.keys(builds).length) return null;
  return { look, builds };
}
