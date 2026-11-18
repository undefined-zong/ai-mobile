import { backdropKindFor, type MapLocation, type TownEdge, type TownShape, type TownWater, type World } from '@app/shared';

/**
 * 像素小镇的排布：把一个世界（地点表 + 每个地点在旧地图上的 0-100 坐标）排进一张图块网格。
 * - 和画法无关：这里只决定哪格是地面、路、水、山、城墙，每个地点占哪块地、门在哪；
 * - 地点的形状和大小、有没有河海湖、四周是树林还是远山城墙，都来自蓝图（look.ts 解析好以后传进来）；
 * - 确定性：以世界 id 为种子，同一个世界每次打开都一样。
 */

export const TILE = 16;

export type Ground = 'grass' | 'lawn' | 'plaza' | 'garden' | 'path' | 'water' | 'sand' | 'bridge' | 'mountain' | 'wall' | 'cliff';

/** 地点的用途：没有蓝图时按它给默认的形状（look.ts） */
export type Purpose =
  | 'home'
  | 'study'
  | 'dining'
  | 'cafe'
  | 'park'
  | 'track'
  | 'riverside'
  | 'seaside'
  | 'pool'
  | 'gym'
  | 'cinema'
  | 'market'
  | 'gallery'
  | 'aquarium'
  | 'amusement'
  | 'music';

export interface Plot {
  loc: MapLocation;
  shape: TownShape;
  /** 占地（图块） */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 门口那一格（路从这里接出去） */
  doorX: number;
  doorY: number;
}

export interface Deco {
  kind: 'tree' | 'bush' | 'flower' | 'lamp' | 'bench' | 'rock';
  x: number;
  y: number;
  v: number;
}

export interface TownLayout {
  w: number;
  h: number;
  ground: Ground[];
  plots: Plot[];
  decos: Deco[];
  seed: number;
  /** 城墙的城门（四周是城墙时） */
  gate?: { x: number; y: number };
}

/** 排布要知道的：每个地点的形状和占地、水、四周、树多不多 */
export interface LayoutPlan {
  sizes: Map<string, { shape: TownShape; w: number; h: number }>;
  water: TownWater[];
  edges: TownEdge[];
  /** 树的多少，1 是正常 */
  trees: number;
}

/** 没有蓝图时从 backdrop + 名字推断用途 */
export function purposeOf(loc: MapLocation, homeId: string): Purpose {
  const n = loc.name;
  if (loc.id === homeId || loc.area === 'home') return 'home';
  if (/操场|田径|跑道|球场|演武|练武|校场|训练场/.test(n)) return 'track';
  if (/江|河|堤|步道|湖/.test(n) && loc.backdrop === 'park') return 'riverside';
  switch (backdropKindFor(loc)) {
    case 'bedroom':
    case 'room':
    case 'living':
    case 'bathroom':
    case 'entrance':
    case 'attic':
    case 'hotel':
    case 'house-exterior':
      return 'home';
    case 'library':
    case 'study':
    case 'bookstore':
    case 'school':
    case 'classroom':
    case 'school-corridor':
    case 'laboratory':
    case 'infirmary':
    case 'club-room':
    case 'staff-room':
    case 'office':
    case 'archive':
    case 'machine-room':
    case 'facility':
    case 'hospital':
    case 'ward':
    case 'surgery':
    case 'nurse-station':
    case 'police':
    case 'bank':
      return 'study';
    case 'dining':
    case 'kitchen':
    case 'restaurant':
    case 'canteen':
      return 'dining';
    case 'cafe':
    case 'bar':
      return 'cafe';
    case 'track':
      return 'track';
    case 'river':
    case 'riverside':
      return 'riverside';
    case 'seaside':
    case 'pier':
    case 'ship':
      return 'seaside';
    case 'pool':
    case 'hot-spring':
      return 'pool';
    case 'gym':
    case 'sports-hall':
    case 'bowling':
      return 'gym';
    case 'cinema':
      return 'cinema';
    case 'night-market':
    case 'shopping-street':
    case 'convenience':
    case 'supermarket':
    case 'mall':
      return 'market';
    case 'gallery':
    case 'museum':
      return 'gallery';
    case 'aquarium':
      return 'aquarium';
    case 'amusement':
    case 'arcade':
      return 'amusement';
    case 'music':
    case 'music-room':
    case 'karaoke':
    case 'concert':
      return 'music';
    default:
      return 'park';
  }
}

/** 小而稳定的随机数（mulberry32） */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** 平地形状：没有屋顶，地名写在场地中间 */
export const FLAT_SHAPES = new Set<TownShape>(['arena', 'plaza', 'garden', 'field', 'stalls', 'dock', 'beach', 'wheel', 'cliff', 'statue', 'ruin']);

export function buildLayout(world: World, plan: LayoutPlan): TownLayout {
  const seed = hashString(world.id);
  const rand = rng(seed);
  // 竖屏手机：比宽略高，地图能铺满上半屏；地点少的世界用小一号的地图，不显得空
  const small = world.locations.length <= 9;
  const W = small ? 24 : 30;
  const H = small ? 34 : 40;
  const ground: Ground[] = new Array(W * H).fill('grass');
  const solid = new Uint8Array(W * H); // 1 = 地块；2 = 水；3 = 山、城墙、山崖
  const at = (x: number, y: number) => y * W + x;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
  const setCell = (x: number, y: number, g: Ground, s: number) => {
    if (!inside(x, y) || solid[at(x, y)] === 3) return;
    ground[at(x, y)] = g;
    solid[at(x, y)] = s;
  };

  const items = world.locations.map((loc) => {
    const s = plan.sizes.get(loc.id) ?? { shape: 'house' as TownShape, w: 4, h: 4 };
    return { loc, ...s };
  });
  const byShape = (shape: TownShape) => items.find((i) => i.shape === shape);
  // 蓝图没写水：有沙滩就有海，有码头 / 栈道就有河
  const water: TownWater[] = plan.water.length ? plan.water : [...(byShape('beach') ? ['sea' as const] : []), ...(byShape('dock') ? ['river' as const] : [])];

  // —— 四周：远山在最上面几行；山崖在左右两边；城墙围一圈，下边正中留城门 ——
  const mountains = plan.edges.includes('mountains');
  const cliffs = plan.edges.includes('cliffs');
  const walls = plan.edges.includes('walls');
  if (mountains) for (let y = 0; y < 3; y++) for (let x = 0; x < W; x++) setCell(x, y, 'mountain', 3);
  if (cliffs) for (let y = 0; y < H; y++) for (const x of [0, W - 1]) setCell(x, y, 'cliff', 3);
  let gate: TownLayout['gate'];
  if (walls) {
    const top = mountains ? 3 : 0;
    const left = cliffs ? 1 : 0;
    const right = cliffs ? W - 2 : W - 1;
    const gx = Math.floor(W / 2) - 1;
    for (let x = left; x <= right; x++) {
      setCell(x, top, 'wall', 3);
      if (x !== gx && x !== gx + 1) setCell(x, H - 1, 'wall', 3);
    }
    for (let y = top; y < H; y++) {
      setCell(left, y, 'wall', 3);
      setCell(right, y, 'wall', 3);
    }
    gate = { x: gx, y: H - 1 };
    setCell(gx, H - 1, 'path', 0);
    setCell(gx + 1, H - 1, 'path', 0);
  }
  const top = mountains ? 4 : walls ? 2 : 1;

  // —— 水：海在沙滩那个地点的角落；河在码头那个地点的高度横穿；湖在园林附近 ——
  if (water.includes('sea')) {
    const anchor = byShape('beach')?.loc ?? byShape('dock')?.loc ?? { x: 90, y: 90 };
    const right = anchor.x >= 50;
    const bottom = anchor.y >= 50;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const dx = right ? W - 1 - x : x;
        const dy = bottom ? H - 1 - y : y;
        const wobble = Math.sin((dx + dy) * 0.7 + seed) * 0.8;
        if (dx + dy * 1.15 < 7.5 + wobble) setCell(x, y, 'water', 2);
        else if (dx + dy * 1.15 < 9.6 + wobble && solid[at(x, y)] === 0) ground[at(x, y)] = 'sand';
      }
    }
  }
  if (water.includes('river')) {
    const anchor = items.find((i) => i.shape === 'dock' && i !== byShape('beach'))?.loc;
    const base = anchor ? Math.round((anchor.y / 100) * (H - 1)) : Math.round(H * 0.72);
    const rowY = Math.min(H - 3, Math.max(top + 2, base + 1));
    const phase = rand() * Math.PI * 2;
    for (let x = 0; x < W; x++) {
      const yy = Math.round(rowY + Math.sin(x * 0.32 + phase) * 1.2);
      for (let k = 0; k < 2; k++) setCell(x, yy + k, 'water', 2);
    }
  }
  if (water.includes('lake')) {
    // 有码头 / 栈道的话湖就在它旁边（那个地点多半就是湖边），否则挨着园林
    const anchor = (water.includes('river') || water.includes('sea') ? null : byShape('dock')?.loc) ?? byShape('garden')?.loc ?? { x: 50, y: 58 };
    const cx = Math.round(1 + (anchor.x / 100) * (W - 2));
    const cy = Math.round(top + 3 + (anchor.y / 100) * (H - top - 8)) + 3;
    for (let y = cy - 3; y <= cy + 3; y++)
      for (let x = cx - 4; x <= cx + 4; x++) {
        const d = ((x - cx) / 4.2) ** 2 + ((y - cy) / 2.6) ** 2;
        if (d <= 1 && solid[at(Math.max(0, Math.min(W - 1, x)), Math.max(0, Math.min(H - 1, y)))] === 0) setCell(x, y, 'water', 2);
      }
  }

  // —— 地块：按旧地图上的位置摆，大的先摆，撞了就就近找空地 ——
  /** 能不能摆在这里：不压别的地块、山和城墙，地块本身和门前那一行不能是水（码头的门前就是水，frontWater 放行） */
  const fits = (x: number, y: number, w: number, h: number, frontWater = false) => {
    if (x < 1 || y < top || x + w > W - 1 || y + h + 1 > H - 1) return false;
    for (let yy = y - 1; yy <= y + h; yy++)
      for (let xx = x - 1; xx <= x + w; xx++) if (inside(xx, yy) && (solid[at(xx, yy)] === 1 || solid[at(xx, yy)] === 3)) return false;
    for (let yy = y; yy <= y + h - (frontWater ? 1 : 0); yy++) for (let xx = x; xx < x + w; xx++) if (solid[at(xx, yy)] === 2) return false;
    return true;
  };
  const plots: Plot[] = [];
  type Item = (typeof items)[number];
  const place = (it: Item, wantX: number, wantY: number, test = fits, doorAbove = false) => {
    const cx = Math.round(wantX - it.w / 2);
    const cy = Math.round(wantY - it.h / 2);
    for (let r = 0; r < 22; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = cx + dx;
          const y = cy + dy;
          if (!test(x, y, it.w, it.h)) continue;
          for (let yy = y; yy < y + it.h; yy++) for (let xx = x; xx < x + it.w; xx++) solid[at(xx, yy)] = 1;
          const plot: Plot = { loc: it.loc, shape: it.shape, x, y, w: it.w, h: it.h, doorX: x + Math.floor(it.w / 2), doorY: doorAbove ? y - 1 : y + it.h };
          plots.push(plot);
          return plot;
        }
      }
    }
    return null;
  };
  const wantX = (it: Item) => 1 + (it.loc.x / 100) * (W - 2);
  const wantY = (it: Item) => top + 4 + (it.loc.y / 100) * (H - top - 8);
  const special = new Set<TownShape>(['dock', 'beach', 'cliff']);
  const order = items.filter((i) => !special.has(i.shape)).sort((a, b) => b.w * b.h - a.w * a.h);

  // 山崖靠在最后面（地图上方）
  for (const it of items.filter((i) => i.shape === 'cliff')) place(it, wantX(it), top + it.h / 2);
  for (const it of order) place(it, wantX(it), wantY(it));
  // 码头 / 栈道：紧挨着水；沙滩：在沙子上。找不到合适的地方就当普通地块摆
  for (const it of items.filter((i) => i.shape === 'dock')) {
    const ok = place(
      it,
      wantX(it),
      wantY(it),
      (x, y, w, h) => {
        if (!fits(x, y, w, h, true)) return false;
        for (let xx = x; xx < x + w; xx++) if (!inside(xx, y + h) || ground[at(xx, y + h)] !== 'water') return false;
        return true;
      },
      true,
    );
    if (!ok) place(it, wantX(it), wantY(it));
  }
  for (const it of items.filter((i) => i.shape === 'beach')) {
    let best: { x: number; y: number } | null = null;
    for (let y = top; y < H - it.h; y++)
      for (let x = 1; x < W - it.w; x++) {
        let sand = 0;
        let ok = true;
        for (let yy = y; yy < y + it.h; yy++)
          for (let xx = x; xx < x + it.w; xx++) {
            if (solid[at(xx, yy)]) ok = false;
            if (ground[at(xx, yy)] === 'sand') sand++;
          }
        if (!ok || sand < it.w * it.h * 0.45) continue;
        const want = { x: (it.loc.x / 100) * W, y: (it.loc.y / 100) * H };
        if (!best || Math.hypot(x - want.x, y - want.y) < Math.hypot(best.x - want.x, best.y - want.y)) best = { x, y };
      }
    if (best) {
      for (let yy = best.y; yy < best.y + it.h; yy++) for (let xx = best.x; xx < best.x + it.w; xx++) solid[at(xx, yy)] = 1;
      plots.push({ loc: it.loc, shape: it.shape, x: best.x, y: best.y, w: it.w, h: it.h, doorX: best.x + Math.floor(it.w / 2), doorY: best.y - 1 });
    } else place(it, wantX(it), wantY(it));
  }

  // 护城河：绕着最大的那栋楼一圈，路过的地方自然成了桥
  if (water.includes('moat')) {
    const main = [...plots].filter((p) => !FLAT_SHAPES.has(p.shape)).sort((a, b) => b.w * b.h - a.w * a.h)[0];
    if (main) {
      for (let y = main.y - 2; y <= main.y + main.h + 2; y++)
        for (let x = main.x - 2; x <= main.x + main.w + 1; x++) {
          const ring = x === main.x - 2 || x === main.x + main.w + 1 || y === main.y - 2 || y === main.y + main.h + 2;
          if (ring && inside(x, y) && solid[at(x, y)] === 0) setCell(x, y, 'water', 2);
        }
    }
  }

  // —— 片区地面：城里铺石板，学校是修剪过的草坪，住处有个小花园 ——
  for (const area of ['campus', 'city', 'home'] as const) {
    const ps = plots.filter((p) => p.loc.area === area && p.shape !== 'dock' && p.shape !== 'beach' && p.shape !== 'cliff');
    if (!ps.length) continue;
    if (area === 'city') {
      for (const p of ps)
        for (let yy = p.y + p.h; yy <= p.y + p.h + 1; yy++)
          for (let xx = p.x - 1; xx <= p.x + p.w; xx++) if (inside(xx, yy) && ground[at(xx, yy)] === 'grass' && !solid[at(xx, yy)]) ground[at(xx, yy)] = 'plaza';
      continue;
    }
    const kind: Ground = area === 'campus' ? 'lawn' : 'garden';
    const x0 = Math.max(0, Math.min(...ps.map((p) => p.x)) - 1);
    const y0 = Math.max(0, Math.min(...ps.map((p) => p.y)) - 1);
    const x1 = Math.min(W - 1, Math.max(...ps.map((p) => p.x + p.w)));
    const y1 = Math.min(H - 1, Math.max(...ps.map((p) => p.y + p.h)) + 1);
    if (area === 'home' || (x1 - x0) * (y1 - y0) < W * H * 0.45) {
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (ground[at(x, y)] === 'grass') ground[at(x, y)] = kind;
    }
  }

  // —— 路：门口之间连一棵最小生成树，每条边走最短路，复用已有的路，过水就是桥；有城门就连到城门 ——
  const doors = plots.map((p) => ({ x: Math.min(W - 1, Math.max(0, p.doorX)), y: Math.min(H - 1, Math.max(0, p.doorY)) }));
  if (gate) doors.push({ x: gate.x, y: gate.y });
  const connected = new Set<number>([0]);
  const edges: [number, number][] = [];
  while (connected.size < doors.length) {
    let best: [number, number, number] | null = null;
    for (const i of connected)
      for (let j = 0; j < doors.length; j++) {
        if (connected.has(j)) continue;
        const d = Math.abs(doors[i]!.x - doors[j]!.x) + Math.abs(doors[i]!.y - doors[j]!.y);
        if (!best || d < best[2]) best = [i, j, d];
      }
    if (!best) break;
    connected.add(best[1]);
    edges.push([best[0], best[1]]);
  }
  const roadCost = (x: number, y: number) => {
    const s = solid[at(x, y)];
    if (s === 1 || s === 3) return Infinity;
    const g = ground[at(x, y)];
    if (g === 'path' || g === 'bridge') return 0.35;
    if (g === 'water') return 6;
    return 1;
  };
  const isPath = new Uint8Array(W * H);
  for (const [a, b] of edges) {
    const from = doors[a]!;
    const to = doors[b]!;
    const dist = new Float64Array(W * H).fill(Infinity);
    const prev = new Int32Array(W * H).fill(-1);
    const open: number[] = [at(from.x, from.y)];
    dist[at(from.x, from.y)] = 0;
    while (open.length) {
      let bi = 0;
      for (let i = 1; i < open.length; i++) if (dist[open[i]!]! < dist[open[bi]!]!) bi = i;
      const cur = open.splice(bi, 1)[0]!;
      if (cur === at(to.x, to.y)) break;
      const cx = cur % W;
      const cy = (cur - cx) / W;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (!inside(nx, ny)) continue;
        const n = at(nx, ny);
        const goal = n === at(to.x, to.y);
        const c = goal ? 0.1 : roadCost(nx, ny);
        if (c === Infinity) continue;
        // 拐弯稍微贵一点，路更直
        const turn = prev[cur]! >= 0 && prev[cur]! % W !== nx && Math.floor(prev[cur]! / W) !== ny ? 0.4 : 0;
        const nd = dist[cur]! + c + turn;
        if (nd < dist[n]!) {
          dist[n] = nd;
          prev[n] = cur;
          open.push(n);
        }
      }
    }
    let c = at(to.x, to.y);
    let guard = 0;
    while (c >= 0 && guard++ < W * H) {
      if (solid[c] !== 3) {
        isPath[c] = 1;
        if (ground[c] === 'water') ground[c] = 'bridge';
        else if (ground[c] !== 'bridge') ground[c] = 'path';
      }
      c = prev[c]!;
    }
  }

  // —— 装饰：树长在空地上（多少按蓝图），四周是树林时边上更密；路边隔一段一盏灯 ——
  const decos: Deco[] = [];
  const near = (x: number, y: number, kinds: Ground[], r = 1) => {
    for (let yy = y - r; yy <= y + r; yy++) for (let xx = x - r; xx <= x + r; xx++) if (inside(xx, yy) && kinds.includes(ground[at(xx, yy)]!)) return true;
    return false;
  };
  const nearPlot = (x: number, y: number) => plots.some((p) => x >= p.x - 1 && x <= p.x + p.w && y >= p.y - 1 && y <= p.y + p.h + 1);
  const forest = plan.edges.includes('forest');
  const taken = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = at(x, y);
      const g = ground[i];
      if (solid[i] || isPath[i] || taken[i]) continue;
      const r = rand();
      if ((g === 'grass' || g === 'lawn') && !nearPlot(x, y)) {
        const edge = x < 2 || y < top + 1 || x > W - 3 || y > H - 3;
        const byWater = near(x, y, ['water']);
        const p = Math.min(0.85, (edge ? (forest ? 0.55 : 0.2) : byWater ? 0.12 : g === 'lawn' ? 0.06 : 0.16) * plan.trees);
        if (r < p && !near(x, y, ['path', 'bridge'], 0)) {
          decos.push({ kind: rand() < 0.82 ? 'tree' : 'bush', x, y, v: Math.floor(rand() * 4) });
          taken[i] = 1;
          continue;
        }
        if (r < p + 0.06) decos.push({ kind: 'flower', x, y, v: Math.floor(rand() * 3) });
        else if (r < p + 0.075) decos.push({ kind: 'rock', x, y, v: 0 });
      } else if (g === 'garden' && !nearPlot(x, y) && r < 0.35) {
        decos.push({ kind: 'flower', x, y, v: Math.floor(rand() * 3) });
      } else if (g === 'sand' && r < 0.05) {
        decos.push({ kind: 'rock', x, y, v: 1 });
      }
    }
  }
  let step = 0;
  for (let y = 1; y < H - 1; y++)
    for (let x = 1; x < W - 1; x++) {
      const i = at(x, y);
      if (solid[i] || isPath[i] || taken[i] || ground[i] === 'water') continue;
      if (!near(x, y, ['path'], 1) || nearPlot(x, y)) continue;
      if (step++ % 7 === 0) {
        decos.push({ kind: rand() < 0.75 ? 'lamp' : 'bench', x, y, v: 0 });
        taken[i] = 1;
      }
    }

  return { w: W, h: H, ground, plots, decos, seed, gate };
}
