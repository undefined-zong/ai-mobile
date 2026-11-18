import type { TimeOfDay, TownProp, TownTree } from '@app/shared';
import { TILE, hashString, rng, type Deco, type Ground, type Plot, type TownLayout } from './layout';
import { isDark, isLit, mix, MOOD_TINT, TOD_TINT, type ResolvedBuild, type ResolvedLook, type Tri } from './look';
import type { SpriteLook } from './sprite';

/**
 * 像素小镇的画法：所有地面、建筑、树、灯和小人都由代码画出来，没有图片素材，也没有写死的皮肤。
 * 画什么全看蓝图解析出来的 ResolvedLook / ResolvedBuild（look.ts）：
 * 地面 8 种、路 6 种、屋顶 9 种、墙 8 种、窗 7 种、树 11 种、灯 5 种、建筑形状 21 种、摆设 12 种、招牌图标 25 个，
 * 颜色由蓝图给底色、这里算亮面暗面。一个像素 = 画布上的一个点；显示时整数倍放大。
 */

type Ctx = CanvasRenderingContext2D;

/** 夜里会亮的东西：先按白天的颜色画，叠完夜色以后再按亮的颜色补一遍 */
interface Emit {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  glow?: number;
}

class Painter {
  emits: Emit[] = [];
  constructor(
    public ctx: Ctx,
    public L: ResolvedLook,
  ) {}
  px(x: number, y: number, w: number, h: number, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
  }
  dot(x: number, y: number, color: string) {
    this.px(x, y, 1, 1, color);
  }
  /** 会发光的一块：白天画 day，夜里补成 night */
  light(x: number, y: number, w: number, h: number, day: string, night: string, glow = 0) {
    this.px(x, y, w, h, day);
    this.emits.push({ x, y, w, h, color: night, glow });
  }
  icon(rows: string[], x: number, y: number, color: string, emit = false) {
    rows.forEach((row, j) => {
      for (let i = 0; i < row.length; i++) {
        if (row[i] !== '#') continue;
        if (emit) this.light(x + i, y + j, 1, 1, color, color);
        else this.dot(x + i, y + j, color);
      }
    });
  }
  /** 实心三角形（屋顶尖、帐篷、山）：顶点 (cx, top)，底边 y = bottom、半宽 half */
  tri(cx: number, top: number, bottom: number, half: number, left: string, right: string) {
    const h = Math.max(1, bottom - top);
    for (let y = top; y <= bottom; y++) {
      const w = Math.round(((y - top) / h) * half);
      this.px(cx - w, y, w, 1, left);
      this.px(cx, y, w + 1, 1, right);
    }
  }
}

// —— 招牌上的 7×7 小图标（TOWN_SIGNS） ——
const ICONS: Record<string, string[]> = {
  book: ['.......', '##...##', '#.#.#.#', '#..#..#', '#..#..#', '##.#.##', '...#...'],
  bowl: ['..#.#..', '...#...', '#######', '#.....#', '.#...#.', '..###..', '.......'],
  cup: ['.#.#...', '.......', '#####..', '#...###', '#...#.#', '#...###', '.###...'],
  note: ['...####', '...#..#', '...#..#', '...#..#', '.###.##', '####.##', '.##....'],
  film: ['#######', '#.#.#.#', '#######', '#.....#', '#######', '#.#.#.#', '#######'],
  fish: ['.......', '..###.#', '.#.###.', '#######', '.#####.', '..###.#', '.......'],
  dumbbell: ['.......', '#.....#', '##...##', '#######', '##...##', '#.....#', '.......'],
  wave: ['.......', '.##..##', '#..##..', '.......', '.##..##', '#..##..', '.......'],
  palette: ['.####..', '#.#..#.', '#....##', '#.#...#', '#...#.#', '.#...#.', '..###..'],
  heart: ['.......', '.##.##.', '#######', '#######', '.#####.', '..###..', '...#...'],
  star: ['...#...', '...#...', '#######', '.#####.', '..###..', '.##.##.', '.#...#.'],
  sword: ['......#', '.....#.', '....#..', '.#.#...', '..#....', '.#.#...', '#......'],
  scroll: ['##...##', '#.###.#', '.#...#.', '.#.#.#.', '.#...#.', '#.###.#', '##...##'],
  leaf: ['....##.', '..####.', '.#####.', '.####..', '.###...', '.#.....', '#......'],
  moon: ['..###..', '.##....', '##.....', '##.....', '##.....', '.##....', '..###..'],
  flame: ['...#...', '..##...', '..###..', '.####..', '.#####.', '.##.##.', '..###..'],
  gear: ['..#.#..', '.#####.', '##...##', '.#...#.', '##...##', '.#####.', '..#.#..'],
  potion: ['..###..', '...#...', '..###..', '.#####.', '#######', '#######', '.#####.'],
  cross: ['..###..', '..###..', '#######', '#######', '#######', '..###..', '..###..'],
  coin: ['..###..', '.#...#.', '#..#..#', '#.###.#', '#..#..#', '.#...#.', '..###..'],
  crown: ['#..#..#', '##.#.##', '#######', '#######', '.#####.', '.......', '.......'],
  anchor: ['...#...', '..###..', '...#...', '...#...', '#..#..#', '.#.#.#.', '..###..'],
  paw: ['.#.#.#.', '.#.#.#.', '.......', '..###..', '.#####.', '.#####.', '..###..'],
  flower: ['..#.#..', '.#####.', '##.#.##', '.##.##.', '##.#.##', '.#####.', '..#.#..'],
  shield: ['#######', '#.....#', '#..#..#', '#.###.#', '.#.#.#.', '..#.#..', '...#...'],
};

const noise = (x: number, y: number, k = 0) => (hashString(`${x},${y},${k}`) % 1000) / 1000;
const pickOf = <T>(arr: readonly T[], k: number): T => arr[((k % arr.length) + arr.length) % arr.length]!;

// —— 地面 ——
function groundAt(l: TownLayout, x: number, y: number): Ground | null {
  if (x < 0 || y < 0 || x >= l.w || y >= l.h) return null;
  return l.ground[y * l.w + x]!;
}
const PATHLIKE: Ground[] = ['path', 'bridge', 'plaza'];

/** 小镇的底色地面（草地、土地、沙地、雪地、石板、柏油、苔地、灰烬） */
function baseTile(p: Painter, X: number, Y: number, r: () => number, tint?: Tri) {
  const L = p.L;
  const [g0, g1, g2] = tint ?? L.groundTri;
  p.px(X, Y, TILE, TILE, g0);
  const speck = (n: number, colors: string[]) => {
    for (let k = 0; k < n; k++) p.dot(X + Math.floor(r() * 16), Y + Math.floor(r() * 16), colors[Math.floor(r() * colors.length)]!);
  };
  switch (L.ground) {
    case 'grass':
    case 'moss': {
      speck(5, [g1, g2]);
      if (r() < 0.45) {
        const gx = X + 2 + Math.floor(r() * 11);
        const gy = Y + 3 + Math.floor(r() * 10);
        p.dot(gx, gy, g2);
        p.dot(gx + 2, gy, g2);
        p.dot(gx + 1, gy + 1, g2);
      }
      if (L.ground === 'moss' && r() < 0.35) p.px(X + Math.floor(r() * 11), Y + Math.floor(r() * 12), 4, 3, g2);
      break;
    }
    case 'dirt':
      speck(6, [g1, g2]);
      if (r() < 0.5) p.px(X + Math.floor(r() * 13), Y + Math.floor(r() * 14), 2, 1, g2);
      break;
    case 'sand':
      speck(5, [g2, g1]);
      break;
    case 'snow':
      speck(4, [mix(g0, '#9fc0e0', 0.45), '#ffffff']);
      break;
    case 'stone':
      p.px(X, Y + 7, TILE, 1, g2);
      p.px(X + (Y % 32 ? 4 : 11), Y, 1, 7, g2);
      p.px(X + (Y % 32 ? 11 : 4), Y + 8, 1, 8, g2);
      speck(2, [g1]);
      break;
    case 'asphalt':
      speck(7, [g1, g2]);
      break;
    case 'ash':
      speck(6, [g2, g1]);
      if (r() < 0.015) p.light(X + Math.floor(r() * 14), Y + Math.floor(r() * 14), 1, 1, '#d9663a', '#ff8a4a', 3);
      break;
  }
}

/** 路：土路、石板、砖、木板、柏油、沙路 */
function pathTile(p: Painter, X: number, Y: number, r: () => number) {
  const L = p.L;
  const [c0, c1, c2] = L.pathTri;
  p.px(X, Y, TILE, TILE, c0);
  switch (L.path) {
    case 'dirt':
    case 'sand':
      for (let k = 0; k < 4; k++) p.dot(X + Math.floor(r() * 16), Y + Math.floor(r() * 16), r() < 0.5 ? c1 : c2);
      break;
    case 'stone':
      p.px(X, Y + 7, TILE, 1, c2);
      p.px(X + 5, Y, 1, 7, c2);
      p.px(X + 11, Y + 8, 1, 8, c2);
      p.dot(X + 2, Y + 2, c1);
      p.dot(X + 9, Y + 11, c1);
      break;
    case 'brick':
      for (let yy = 0; yy < 16; yy += 4) {
        p.px(X, Y + yy, TILE, 1, c2);
        for (let xx = (yy / 4) % 2 ? 0 : 4; xx < 16; xx += 8) p.px(X + xx, Y + yy, 1, 4, c2);
      }
      break;
    case 'plank':
      for (let yy = 2; yy < 16; yy += 4) p.px(X, Y + yy, TILE, 1, c2);
      p.dot(X + Math.floor(r() * 14), Y + 1 + Math.floor(r() * 3) * 4, c1);
      break;
    case 'asphalt':
      for (let k = 0; k < 5; k++) p.dot(X + Math.floor(r() * 16), Y + Math.floor(r() * 16), r() < 0.5 ? c1 : c2);
      if (r() < 0.5) p.px(X + 7, Y + 4, 2, 4, '#c9a83a');
      break;
  }
}

function drawGround(p: Painter, l: TownLayout) {
  const L = p.L;
  const [w0, w1, w2, w3] = L.water4;
  for (let ty = 0; ty < l.h; ty++) {
    for (let tx = 0; tx < l.w; tx++) {
      const g = groundAt(l, tx, ty)!;
      const X = tx * TILE;
      const Y = ty * TILE;
      const r = rng(hashString(`${tx}:${ty}`));
      switch (g) {
        case 'grass':
        case 'mountain':
        case 'wall':
        case 'cliff':
          baseTile(p, X, Y, r);
          break;
        case 'garden':
          baseTile(p, X, Y, r, [mix(L.groundTri[0], L.groundTri[1], 0.35), L.groundTri[1], L.groundTri[2]]);
          break;
        case 'lawn':
          baseTile(p, X, Y, r);
          if (ty % 2 === 0) p.px(X, Y, TILE, TILE, mix(L.groundTri[0], L.groundTri[2], 0.1) + '90');
          break;
        case 'plaza': {
          const [c0, c1, c2] = L.pathTri;
          p.px(X, Y, TILE, TILE, mix(c0, c1, 0.4));
          p.px(X, Y + 7, TILE, 1, c2);
          p.px(X + (ty % 2 ? 4 : 11), Y, 1, 7, c2);
          p.px(X + (ty % 2 ? 11 : 4), Y + 8, 1, 8, c2);
          break;
        }
        case 'path':
          pathTile(p, X, Y, r);
          break;
        case 'sand': {
          const [s0, , s2] = L.sandTri;
          p.px(X, Y, TILE, TILE, s0);
          for (let k = 0; k < 4; k++) p.dot(X + Math.floor(r() * 16), Y + Math.floor(r() * 16), s2);
          break;
        }
        case 'water':
        case 'bridge': {
          p.px(X, Y, TILE, TILE, w0);
          for (let k = 0; k < 2; k++) p.px(X + Math.floor(r() * 11), Y + 2 + Math.floor(r() * 12), 4, 1, w1);
          if (r() < 0.4) p.px(X + Math.floor(r() * 12), Y + Math.floor(r() * 14), 3, 1, w2);
          break;
        }
      }
    }
  }
  // 边：路沿、水岸的浪花、桥
  for (let ty = 0; ty < l.h; ty++) {
    for (let tx = 0; tx < l.w; tx++) {
      const g = groundAt(l, tx, ty)!;
      const X = tx * TILE;
      const Y = ty * TILE;
      const n = groundAt(l, tx, ty - 1);
      const s = groundAt(l, tx, ty + 1);
      const w = groundAt(l, tx - 1, ty);
      const e = groundAt(l, tx + 1, ty);
      if (g === 'path') {
        const edge = L.pathTri[2];
        if (n && !PATHLIKE.includes(n)) p.px(X, Y, TILE, 1, edge);
        if (s && !PATHLIKE.includes(s)) p.px(X, Y + 15, TILE, 1, edge);
        if (w && !PATHLIKE.includes(w)) p.px(X, Y, 1, TILE, edge);
        if (e && !PATHLIKE.includes(e)) p.px(X + 15, Y, 1, TILE, edge);
      }
      if (g === 'water') {
        const land = (q: Ground | null) => q && q !== 'water' && q !== 'bridge';
        if (land(n)) {
          p.px(X, Y, TILE, 2, w2);
          p.px(X, Y + 2, TILE, 1, w3);
        }
        if (land(s)) p.px(X, Y + 14, TILE, 2, w3);
        if (land(w)) p.px(X, Y, 1, TILE, w3);
        if (land(e)) p.px(X + 15, Y, 1, TILE, w3);
      }
      if (g === 'bridge') {
        const [b0, b1] = L.plank;
        const vertical = PATHLIKE.includes(n ?? 'grass') || PATHLIKE.includes(s ?? 'grass');
        if (vertical) {
          p.px(X + 2, Y, 12, TILE, b0);
          for (let k = 0; k < 16; k += 3) p.px(X + 2, Y + k, 12, 1, b1);
          p.px(X + 1, Y, 1, TILE, b1);
          p.px(X + 14, Y, 1, TILE, b1);
        } else {
          p.px(X, Y + 2, TILE, 12, b0);
          for (let k = 0; k < 16; k += 3) p.px(X + k, Y + 2, 1, 12, b1);
          p.px(X, Y + 1, TILE, 1, b1);
          p.px(X, Y + 14, TILE, 1, b1);
        }
      }
    }
  }
}

// —— 四周：远山、城墙、山崖 ——
function drawMountains(p: Painter, l: TownLayout) {
  if (!l.ground.some((g, i) => g === 'mountain' && i < l.w)) return;
  const W = l.w * TILE;
  const bandH = 3 * TILE;
  const L = p.L;
  const far = mix(L.groundTri[2], '#8494b8', 0.55);
  const near = mix(L.groundTri[2], '#4a5a70', 0.35);
  const snow = L.ground === 'sand' ? mix('#f6e7c4', far, 0.2) : '#f4f6fa';
  p.px(0, 0, W, bandH, mix(far, '#ffffff', 0.25));
  const r = rng(l.seed + 7);
  // 远处一排高的，近处一排矮的
  for (const [color, minH, maxH, cap] of [
    [far, 30, 46, true],
    [near, 18, 30, false],
  ] as const) {
    for (let x = -10; x < W + 20; x += 18 + Math.floor(r() * 16)) {
      const h = minH + Math.floor(r() * (maxH - minH));
      const top = bandH - h;
      p.tri(x, top, bandH, Math.round(h * 0.95), mix(color, '#ffffff', 0.12), color);
      if (cap && h > 36) p.tri(x, top, top + 7, 6, snow, mix(snow, '#c8d0e0', 0.4));
    }
  }
  // 山脚和草地接起来
  p.px(0, bandH - 2, W, 2, L.groundTri[2]);
}

function drawWalls(p: Painter, l: TownLayout) {
  const L = p.L;
  const stone = mix(L.wall === 'stone' || L.wall === 'brick' ? L.walls[0]! : '#b8b2a6', '#8a8478', 0.15);
  const [s0, s1, s2] = [stone, mix(stone, '#ffffff', 0.22), mix(stone, '#2a2235', 0.32)];
  for (let ty = 0; ty < l.h; ty++)
    for (let tx = 0; tx < l.w; tx++) {
      if (groundAt(l, tx, ty) !== 'wall') continue;
      const X = tx * TILE;
      const Y = ty * TILE;
      p.px(X, Y + 2, TILE, 14, s0);
      p.px(X, Y + 2, TILE, 2, s1);
      for (let yy = 6; yy < 16; yy += 4) {
        p.px(X, Y + yy, TILE, 1, s2);
        for (let xx = (yy / 4) % 2 ? 2 : 6; xx < 16; xx += 8) p.px(X + xx, Y + yy, 1, 4, s2);
      }
      // 垛口
      for (let xx = 0; xx < 16; xx += 5) p.px(X + xx, Y - 2, 3, 4, s1);
      p.px(X, Y + 15, TILE, 1, s2);
    }
  // 城门两边的门楼
  if (l.gate) {
    const gx = l.gate.x * TILE;
    const gy = l.gate.y * TILE;
    for (const tx of [gx - 10, gx + 2 * TILE - 2]) {
      p.px(tx, gy - 14, 12, 30, s0);
      p.px(tx, gy - 14, 12, 2, s1);
      p.px(tx + 4, gy - 6, 3, 5, s2);
      p.light(tx + 4, gy - 6, 3, 4, s2, p.L.lamp, 6);
      for (let xx = 0; xx < 12; xx += 4) p.px(tx + xx, gy - 17, 2, 3, s1);
    }
    p.px(gx - 2, gy - 6, 2 * TILE + 4, 4, s2);
  }
}

function drawCliffs(p: Painter, l: TownLayout) {
  const [r0, r1] = p.L.rock;
  for (let ty = 0; ty < l.h; ty++)
    for (let tx = 0; tx < l.w; tx++) {
      if (groundAt(l, tx, ty) !== 'cliff') continue;
      const X = tx * TILE;
      const Y = ty * TILE;
      p.px(X, Y, TILE, TILE, r0);
      for (let yy = 3; yy < 16; yy += 5) p.px(X, Y + yy + (tx % 2), TILE, 1, r1);
      p.px(X + (tx === 0 ? 14 : 0), Y, 2, TILE, mix(r1, '#000000', 0.2));
    }
}

// —— 树、灌木、花、石头、灯、长椅 ——
function drawTree(p: Painter, X: number, Y: number, kind: TownTree, v: number) {
  const L = p.L;
  const [f0, f1, f2] = L.foliage(kind);
  const trunk = kind === 'neon' || kind === 'crystal' ? '#3a3f4e' : '#7a5232';
  p.px(X + 3, Y + 13, 10, 3, 'rgba(0,0,0,0.16)');
  switch (kind) {
    case 'pine': {
      p.px(X + 7, Y + 10, 2, 5, trunk);
      for (const [ox, oy, w] of [
        [2, 6, 12],
        [3, 2, 10],
        [5, -2, 6],
        [6, -5, 4],
      ] as const) {
        p.px(X + ox, Y + oy + 2, w, 4, f2);
        p.px(X + ox, Y + oy, w, 4, f0);
        p.px(X + ox + 1, Y + oy, w - 3, 1, f1);
      }
      if (L.ground === 'snow') {
        p.px(X + 6, Y - 5, 4, 1, '#ffffff');
        p.px(X + 4, Y + 2, 6, 1, '#ffffff');
      }
      return;
    }
    case 'bamboo':
      for (const bx of [4, 7, 10]) {
        p.px(X + bx, Y - 2, 2, 16, f0);
        p.dot(X + bx, Y + 3, f2);
        p.dot(X + bx, Y + 9, f2);
        p.px(X + bx + 1, Y - 1, 3, 1, f1);
      }
      return;
    case 'palm': {
      for (let k = 0; k < 12; k++) p.px(X + 7 + Math.round(Math.sin(k / 4) * 2), Y + 14 - k, 2, 1, k % 3 ? '#8f6a42' : '#6f5232');
      const cx = X + 8;
      const cy = Y + 1;
      for (const [dx, dy] of [
        [-7, 2],
        [7, 2],
        [-5, -3],
        [5, -3],
        [0, -5],
        [-8, 5],
        [8, 5],
      ] as const) {
        const steps = 6;
        for (let s = 0; s <= steps; s++) p.px(cx + Math.round((dx * s) / steps), cy + Math.round((dy * s) / steps + (s * s) / 18), 2, 1, s > 3 ? f2 : f0);
      }
      p.px(cx - 1, cy - 1, 3, 3, f1);
      return;
    }
    case 'willow': {
      p.px(X + 7, Y + 6, 2, 9, trunk);
      p.px(X + 2, Y - 1, 12, 6, f0);
      p.px(X + 4, Y - 2, 7, 2, f1);
      for (let xx = 2; xx < 14; xx += 2) p.px(X + xx, Y + 4, 1, 6 + ((xx * 7) % 4), xx % 4 ? f0 : f2);
      return;
    }
    case 'dead': {
      p.px(X + 7, Y + 2, 2, 13, f0);
      p.px(X + 4, Y + 4, 3, 1, f0);
      p.px(X + 3, Y + 2, 1, 2, f0);
      p.px(X + 9, Y + 6, 4, 1, f0);
      p.px(X + 12, Y + 4, 1, 2, f0);
      p.px(X + 6, Y, 1, 2, f0);
      return;
    }
    case 'cactus': {
      p.px(X + 6, Y + 1, 4, 14, f0);
      p.px(X + 7, Y + 1, 1, 14, f1);
      p.px(X + 3, Y + 5, 3, 2, f0);
      p.px(X + 3, Y + 2, 2, 4, f0);
      p.px(X + 10, Y + 7, 3, 2, f0);
      p.px(X + 11, Y + 4, 2, 4, f0);
      return;
    }
    case 'crystal': {
      for (const [ox, h] of [
        [4, 9],
        [8, 13],
        [11, 7],
      ] as const) {
        p.tri(X + ox, Y + 14 - h, Y + 14, 2, f1, f2);
        p.light(X + ox, Y + 14 - h + 2, 1, 2, f1, f1, 4);
      }
      return;
    }
    case 'neon':
      p.px(X + 3, Y + 11, 10, 4, '#3a3f4e');
      p.px(X + 3, Y + 11, 10, 1, '#59627a');
      p.px(X + 7, Y + 6, 2, 5, trunk);
      p.px(X + 3, Y - 2, 10, 9, f2);
      p.px(X + 4, Y - 3, 8, 8, f0);
      p.light(X + 5, Y - 2, 3, 2, f1, f1, 4);
      return;
    default: {
      // round / blossom / maple：圆圆的树冠，三层
      p.px(X + 7, Y + 9, 2, 6, trunk);
      p.px(X + 2, Y + 1, 12, 9, f2);
      p.px(X + 1, Y + 3, 14, 5, f2);
      p.px(X + 3, Y - 1, 10, 9, f0);
      p.px(X + 2, Y + 1, 12, 6, f0);
      p.px(X + 4, Y - 1, 5, 2, f1);
      p.px(X + 3, Y + 1, 3, 3, f1);
      if (kind === 'round' && v === 1) {
        p.dot(X + 9, Y + 3, '#e5534b');
        p.dot(X + 5, Y + 6, '#e5534b');
      }
      if (L.ground === 'snow') p.px(X + 4, Y - 1, 6, 1, '#ffffff');
    }
  }
}

function treeKind(L: ResolvedLook, x: number, y: number): TownTree {
  return pickOf(L.trees, hashString(`t${x},${y}`));
}

function drawLamp(p: Painter, X: number, Y: number) {
  const L = p.L;
  if (L.lights === 'none') return;
  p.px(X + 6, Y + 13, 5, 2, 'rgba(0,0,0,0.18)');
  switch (L.lights) {
    case 'stone-lantern':
      p.px(X + 6, Y + 8, 4, 6, L.rock[0]);
      p.px(X + 4, Y + 3, 8, 2, L.rock[1]);
      p.light(X + 6, Y + 5, 4, 3, '#efe3c4', L.lamp, 9);
      p.px(X + 5, Y + 2, 6, 1, L.rock[1]);
      return;
    case 'lantern':
      p.px(X + 7, Y + 1, 1, 13, '#5a3a2a');
      p.px(X + 7, Y + 1, 5, 1, '#5a3a2a');
      p.light(X + 10, Y + 3, 3, 4, mix(L.accent[0]!, '#d94a38', 0.5), L.lamp, 9);
      return;
    case 'torch':
      p.px(X + 7, Y + 4, 2, 10, '#6f4a2a');
      p.light(X + 6, Y + 1, 4, 3, '#ffb347', L.lamp, 10);
      p.light(X + 7, Y, 2, 1, '#ffe08a', '#ffe08a');
      return;
    case 'neon':
      p.px(X + 7, Y + 2, 1, 12, '#3a3f4e');
      p.light(X + 4, Y + 2, 7, 3, L.accent[1] ?? L.lamp, L.accent[1] ?? L.lamp, 8);
      return;
    default:
      p.px(X + 7, Y + 2, 2, 12, '#5b5f6b');
      p.px(X + 5, Y + 1, 6, 2, '#5b5f6b');
      p.light(X + 6, Y + 3, 4, 2, '#e8e2cf', L.lamp, 10);
  }
}

function drawDeco(p: Painter, d: Deco) {
  const L = p.L;
  const X = d.x * TILE;
  const Y = d.y * TILE;
  switch (d.kind) {
    case 'tree':
      drawTree(p, X, Y, treeKind(L, d.x, d.y), d.v);
      break;
    case 'bush': {
      const kind = L.trees.includes('bamboo') ? 'bamboo' : L.trees.find((t) => t === 'round' || t === 'pine' || t === 'willow' || t === 'palm') ?? L.trees[0]!;
      if (kind === 'bamboo') {
        drawTree(p, X, Y + 2, 'bamboo', 0);
        break;
      }
      if (kind === 'dead' || kind === 'cactus' || kind === 'crystal') {
        p.px(X + 5, Y + 9, 6, 4, L.rock[1]);
        p.px(X + 5, Y + 8, 5, 3, L.rock[0]);
        break;
      }
      const [f0, f1, f2] = L.foliage(kind);
      p.px(X + 2, Y + 8, 12, 7, f2);
      p.px(X + 3, Y + 6, 10, 7, f0);
      p.px(X + 4, Y + 7, 4, 2, f1);
      break;
    }
    case 'flower': {
      const colors = ['#ffffff', ...L.accent];
      const r = rng(hashString(`f${d.x}${d.y}`));
      for (let k = 0; k < 3; k++) {
        const fx = X + 2 + Math.floor(r() * 11);
        const fy = Y + 3 + Math.floor(r() * 10);
        p.dot(fx, fy + 1, L.groundTri[2]);
        p.dot(fx, fy, pickOf(colors, d.v + k));
      }
      break;
    }
    case 'rock':
      p.px(X + 5, Y + 9, 6, 4, L.rock[1]);
      p.px(X + 5, Y + 8, 5, 3, L.rock[0]);
      break;
    case 'lamp':
      drawLamp(p, X, Y);
      break;
    case 'bench':
      drawBench(p, X, Y + 2);
      break;
  }
}

function drawBench(p: Painter, X: number, Y: number) {
  const [b0, b1] = p.L.plank;
  p.px(X + 2, Y + 6, 12, 2, b0);
  p.px(X + 2, Y + 3, 12, 2, b0);
  p.px(X + 3, Y + 8, 1, 3, b1);
  p.px(X + 12, Y + 8, 1, 3, b1);
}

// —— 建筑 ——
interface BStyle {
  b: ResolvedBuild;
  /** 屋檐下挂灯笼 */
  eaveLanterns: boolean;
  awning?: [string, string];
  chimney?: boolean;
  noSign?: boolean;
}

const WOODY = new Set(['wood', 'log', 'paper', 'bamboo']);

function drawWindow(p: Painter, x: number, y: number, h: number, kind: ResolvedBuild['window'], on: boolean, frame: string) {
  const L = p.L;
  switch (kind) {
    case 'none':
      return;
    case 'neon':
      p.light(x - 1, y + Math.floor(h / 2) - 1, 7, 2, mix(L.accent[0]!, '#000000', 0.25), L.accent[(x >> 3) % L.accent.length] ?? L.lamp, 3);
      return;
    case 'paper':
      p.px(x - 1, y - 1, 7, h + 2, frame);
      p.light(x, y, 5, h, '#f3ead2', on ? L.litWindow : '#f3ead2', on ? 5 : 0);
      p.px(x + 2, y, 1, h, frame);
      p.px(x, y + Math.floor(h / 2), 5, 1, frame);
      return;
    case 'lattice':
      p.px(x - 1, y - 1, 7, h + 2, frame);
      p.light(x, y, 5, h, '#efe3c4', on ? L.litWindow : '#efe3c4', on ? 5 : 0);
      for (let k = 1; k < h; k += 2) p.px(x, y + k, 5, 1, frame);
      p.px(x + 2, y, 1, h, frame);
      return;
    case 'round':
      p.px(x, y - 1, 5, h + 2, frame);
      p.px(x - 1, y, 7, h, frame);
      p.light(x, y, 5, h, '#a5d6ee', on ? L.litWindow : '#24304f', on ? 5 : 0);
      p.dot(x, y, frame);
      p.dot(x + 4, y, frame);
      p.dot(x, y + h - 1, frame);
      p.dot(x + 4, y + h - 1, frame);
      return;
    case 'arched':
      p.px(x - 1, y - 1, 7, h + 2, frame);
      p.light(x, y + 1, 5, h - 1, '#a5d6ee', on ? L.litWindow : '#24304f', on ? 5 : 0);
      p.px(x + 1, y, 3, 1, on ? L.litWindow : '#a5d6ee');
      return;
    default:
      p.px(x - 1, y - 1, 7, h + 2, frame);
      p.light(x, y, 5, h, '#a5d6ee', on ? L.litWindow : '#24304f', on ? 5 : 0);
      p.px(x, y, 2, 1, '#ffffff66');
      if (h > 7) p.px(x, y + Math.floor(h / 2), 5, 1, frame);
  }
}

function drawWall(p: Painter, X: number, top: number, PW: number, H: number, b: ResolvedBuild, pillars: boolean) {
  const [w0, w1, w2] = b.wallTri;
  const bottom = top + H;
  p.px(X, top, PW, H, w0);
  p.px(X, top, PW, 2, w2);
  p.px(X, bottom - 2, PW, 2, w2);
  p.px(X, top, 1, H, w2);
  p.px(X + PW - 1, top, 1, H, w2);
  switch (b.wall) {
    case 'brick':
      for (let yy = top + 3; yy < bottom - 2; yy += 3) for (let xx = X + (((yy - top) / 3) % 2 ? 1 : 4); xx < X + PW - 2; xx += 6) p.px(xx, yy, 3, 1, w2);
      break;
    case 'wood':
      for (let xx = X + 3; xx < X + PW - 1; xx += 3) p.px(xx, top + 2, 1, H - 4, mix(w0, w2, 0.55));
      break;
    case 'log':
      for (let yy = top + 3; yy < bottom - 2; yy += 3) {
        p.px(X, yy, PW, 1, w2);
        p.dot(X, yy - 1, w1);
        p.dot(X + PW - 1, yy - 1, w1);
      }
      break;
    case 'stone':
      for (let yy = top + 3; yy < bottom - 2; yy += 4) {
        p.px(X + 1, yy, PW - 2, 1, w2);
        for (let xx = X + (((yy - top) >> 2) % 2 ? 3 : 7); xx < X + PW - 2; xx += 7) p.px(xx, yy - 3, 1, 3, w2);
      }
      break;
    case 'metal':
      for (let xx = X + 6; xx < X + PW - 2; xx += 9) {
        p.px(xx, top + 2, 1, H - 4, w2);
        p.dot(xx - 2, top + 3, w1);
        p.dot(xx - 2, bottom - 4, w1);
      }
      break;
    case 'paper':
      for (let xx = X + 4; xx < X + PW - 2; xx += 6) p.px(xx, top + 2, 1, H - 4, '#6e4a32');
      p.px(X, top + Math.floor(H / 2), PW, 1, '#6e4a32');
      break;
    case 'bamboo':
      for (let xx = X + 2; xx < X + PW - 1; xx += 3) {
        p.px(xx, top + 2, 1, H - 4, w2);
        for (let yy = top + 5; yy < bottom - 2; yy += 6) p.dot(xx + 1, yy, w2);
      }
      break;
    default:
      if (H > 12) p.px(X + 1, top + 2, PW - 2, 1, w1);
  }
  if (pillars) {
    for (let xx = X + 1; xx < X + PW; xx += 12) p.px(xx, top, 2, H - 2, '#6e3b28');
    p.px(X, bottom - 3, PW, 3, p.L.rock[0]);
  }
}

/** 一栋楼：屋顶（俯视）+ 前墙（3/4 视角，按层数加高）+ 门窗 + 招牌 */
function drawBuilding(p: Painter, X: number, Y: number, PW: number, PH: number, st: BStyle, seed: number, opts: { door?: boolean; extraTop?: number } = {}) {
  const L = p.L;
  const b = st.b;
  const extraTop = opts.extraTop ?? 0;
  const pillars = b.roof === 'curved' && b.wall !== 'metal';
  const baseWall = Math.min(24, Math.max(18, Math.round(PH * 0.42)));
  const wallH = Math.min(baseWall + (b.floors - 1) * 10, PH + extraTop - 12);
  const roofTop = Y - extraTop - 6;
  const roofBottom = Y + PH - wallH;
  const wallTop = roofBottom;
  const r = rng(seed);
  const [r0, r1, r2] = b.roofTri;

  // 投影
  p.px(X + 3, Y + PH - 1, PW, 3, 'rgba(0,0,0,0.2)');
  p.px(X + PW, roofTop + 10, 3, Y + PH - roofTop - 10, 'rgba(0,0,0,0.12)');

  drawWall(p, X, wallTop, PW, wallH, b, pillars);
  // 楼层之间的檐线
  for (let f = 1; f < b.floors; f++) p.px(X, wallTop + f * 10 - 1, PW, 1, b.wallTri[2]);

  // 门
  const doorW = 8;
  const dx = X + Math.floor(PW / 2) - doorW / 2;
  const doorH = Math.min(12, baseWall - 5);
  if (opts.door !== false) {
    const frame = WOODY.has(b.wall) || pillars ? '#5a3424' : b.wallTri[2];
    p.px(dx - 1, Y + PH - doorH - 1, doorW + 2, doorH + 1, frame);
    if (b.wall === 'metal' || L.neon) p.light(dx, Y + PH - doorH, doorW, doorH, '#2f4f7a', L.litWindow, 6);
    else if (b.wall === 'paper') {
      p.px(dx, Y + PH - doorH, doorW, doorH, '#f3ead2');
      p.px(dx + 3, Y + PH - doorH, 1, doorH, frame);
      p.px(dx, Y + PH - doorH + 5, doorW, 1, frame);
    } else {
      p.px(dx, Y + PH - doorH, doorW, doorH, mix(b.wallTri[2], '#5a3424', 0.6));
      if (b.window === 'glass') p.px(dx + 1, Y + PH - doorH + 1, doorW - 2, 3, '#a5d6ee');
      if (b.window === 'arched') p.px(dx + 2, Y + PH - doorH - 1, doorW - 4, 1, frame);
    }
    p.dot(dx + doorW - 2, Y + PH - Math.floor(doorH / 2), '#e8c26a');
  }

  // 窗：每层一排，最下面一层避开门
  const frame = WOODY.has(b.wall) || b.window === 'lattice' || b.window === 'paper' ? '#5a3a2a' : b.wall === 'metal' ? '#1c2130' : '#ffffff';
  const wh = b.floors === 1 && wallH >= 22 && (b.window === 'glass' || b.window === 'arched') ? 9 : 6;
  for (let f = 0; f < b.floors; f++) {
    const wy = wallTop + 4 + f * 10;
    const ground = f === b.floors - 1;
    for (let xx = X + 4; xx + 6 <= X + PW - 3; xx += 10) {
      if (ground && opts.door !== false && xx + 6 > dx - 2 && xx < dx + doorW + 2) continue;
      drawWindow(p, xx, wy, f === b.floors - 1 ? wh : 6, b.window, r() < 0.65, frame);
    }
  }

  // 雨棚
  if (st.awning) {
    for (let xx = X - 1; xx < X + PW + 1; xx += 1) p.px(xx, wallTop + 1, 1, 5, Math.floor((xx - X) / 3) % 2 ? st.awning[1] : st.awning[0]);
    for (let xx = X; xx < X + PW; xx += 3) p.px(xx, wallTop + 6, 2, 1, st.awning[0]);
  }

  // 屋顶
  const RW = PW + 2;
  const RX = X - 1;
  const RH = roofBottom - roofTop;
  switch (b.roof) {
    case 'flat': {
      p.px(RX, roofTop, RW, RH, r2);
      p.px(RX, roofTop, RW, RH - 2, r0);
      p.px(RX, roofTop, RW, 1, r1);
      p.px(RX + 2, roofTop + 2, RW - 4, RH - 6, r1);
      p.px(RX + 3, roofTop + 3, RW - 6, RH - 8, r0);
      for (let k = 0; k < (RW * RH) / 52; k++) p.dot(RX + 4 + Math.floor(r() * (RW - 8)), roofTop + 4 + Math.floor(r() * (RH - 10)), r() < 0.5 ? r2 : r1);
      if (RW > 40) {
        p.px(RX + 6, roofTop + 5, 7, 5, '#c9cdd3');
        p.px(RX + 6, roofTop + 9, 7, 1, '#9aa0a8');
        if (b.window === 'glass') {
          p.px(RX + RW - 18, roofTop + 6, 10, 6, '#ffffff');
          p.px(RX + RW - 17, roofTop + 7, 8, 4, '#a5d6ee');
        }
      }
      break;
    }
    case 'gable':
    case 'thatch':
    case 'tent': {
      const mid = roofTop + Math.floor(RH / 2);
      const stripe = b.roof === 'tent';
      p.px(RX, roofTop, RW, RH, r2);
      p.px(RX, roofTop, RW, mid - roofTop, r1);
      p.px(RX, mid, RW, RH - (mid - roofTop) - 2, r0);
      if (stripe) {
        for (let xx = RX; xx < RX + RW; xx += 6) p.px(xx, roofTop, 3, RH - 2, '#f4efe6');
      } else if (b.roof === 'thatch') {
        for (let yy = roofTop + 2; yy < roofBottom - 2; yy += 2) for (let xx = RX + (yy % 4 ? 1 : 3); xx < RX + RW - 1; xx += 4) p.px(xx, yy, 2, 1, yy < mid ? r0 : r2);
        for (let xx = RX; xx < RX + RW; xx += 2) p.px(xx, roofBottom - 2, 1, 2 + ((xx * 7) % 3), r2);
      } else {
        for (let yy = roofTop + 2, row = 0; yy < roofBottom - 2; yy += 3, row++) {
          p.px(RX + 1, yy, RW - 2, 1, yy < mid ? r0 : r2);
          for (let xx = RX + 2 + (row % 2) * 3; xx < RX + RW - 2; xx += 6) p.dot(xx, yy + 1, yy < mid ? r0 : r2);
        }
      }
      p.px(RX, mid - 1, RW, 2, r2);
      p.px(RX, mid - 2, RW, 1, r1);
      if (st.chimney && b.roof === 'gable') {
        p.px(RX + RW - 9, roofTop - 3, 4, 7, mix(b.wallTri[2], '#9e5b48', 0.5));
        p.px(RX + RW - 9, roofTop - 3, 4, 1, b.wallTri[1]);
      }
      break;
    }
    case 'hip': {
      const mid = roofTop + Math.floor(RH / 2);
      const inset = Math.min(10, Math.floor(RW / 4));
      p.px(RX, roofTop, RW, RH, r2);
      p.px(RX, roofTop, RW, mid - roofTop, r1);
      p.px(RX, mid, RW, RH - (mid - roofTop) - 2, r0);
      for (let yy = roofTop + 3; yy < roofBottom - 2; yy += 3) p.px(RX + 1, yy, RW - 2, 1, yy < mid ? r0 : r2);
      p.px(RX + inset, mid - 1, RW - inset * 2, 2, r2);
      // 两端的斜脊
      const span = Math.max(1, mid - roofTop);
      for (let k = 0; k <= span; k++) {
        const t = Math.round((k / span) * inset);
        p.dot(RX + t, roofTop + k, r2);
        p.dot(RX + RW - 1 - t, roofTop + k, r2);
        p.dot(RX + t, roofBottom - 2 - k, r2);
        p.dot(RX + RW - 1 - t, roofBottom - 2 - k, r2);
      }
      break;
    }
    case 'curved': {
      p.px(RX - 2, roofTop + 2, RW + 4, RH - 2, r2);
      p.px(RX - 1, roofTop + 1, RW + 2, RH - 4, r0);
      for (let yy = roofTop + 3; yy < roofBottom - 3; yy += 3) p.px(RX, yy, RW, 1, r2);
      for (let xx = RX + 2; xx < RX + RW - 2; xx += 4) p.px(xx, roofBottom - 4, 1, 3, r1);
      p.px(RX + 2, roofTop, RW - 4, 2, r1);
      p.px(RX + 2, roofTop - 1, RW - 4, 1, r2);
      p.px(RX - 4, roofBottom - 4, 3, 2, r2);
      p.dot(RX - 5, roofBottom - 6, r2);
      p.dot(RX - 4, roofBottom - 5, r2);
      p.px(RX + RW + 1, roofBottom - 4, 3, 2, r2);
      p.dot(RX + RW + 4, roofBottom - 6, r2);
      p.dot(RX + RW + 3, roofBottom - 5, r2);
      p.px(RX + 1, roofTop - 3, 2, 3, r2);
      p.px(RX + RW - 3, roofTop - 3, 2, 3, r2);
      if (st.eaveLanterns)
        for (const lx of [X + 3, X + PW - 6]) {
          p.px(lx + 1, roofBottom - 1, 1, 2, '#3a2a22');
          p.light(lx, roofBottom + 1, 3, 4, '#d94a38', '#ff7a55', 8);
        }
      break;
    }
    case 'dome': {
      p.px(RX, roofBottom - 6, RW, 6, r2);
      p.px(RX, roofBottom - 6, RW, 4, r0);
      const cx = X + PW / 2;
      const R = Math.min(PW / 2 - 3, RH + 2);
      for (let yy = -R; yy <= 0; yy++)
        for (let xx = -R; xx <= R; xx++) {
          const d = (xx * xx + yy * yy) / (R * R);
          if (d > 1) continue;
          p.dot(cx + xx, roofBottom - 6 + yy, d > 0.86 ? r2 : xx < -R / 3 && yy < -R / 3 ? r1 : r0);
        }
      p.px(cx - R / 2, roofBottom - 6 - R + 3, 3, 2, '#ffffffaa');
      p.px(cx - 0.5, roofBottom - 6 - R - 3, 1, 4, r2);
      break;
    }
    case 'spire': {
      p.px(RX, roofBottom - 5, RW, 5, r2);
      p.px(RX, roofBottom - 5, RW, 3, r0);
      const cx = X + Math.floor(PW / 2);
      const top = roofTop - Math.min(14, Math.floor(PW / 3));
      p.tri(cx, top, roofBottom - 4, Math.floor(PW / 2) - 2, r1, r2);
      if (PW > 40) for (const ox of [X + 5, X + PW - 5]) p.tri(ox, roofBottom - 16, roofBottom - 4, 4, r1, r2);
      p.px(cx, top - 3, 1, 3, '#e8c26a');
      break;
    }
    case 'tech': {
      p.px(RX, roofTop, RW, RH, r2);
      p.px(RX, roofTop, RW, RH - 2, r0);
      for (let xx = RX + 6; xx < RX + RW; xx += 8) p.px(xx, roofTop + 1, 1, RH - 4, r1);
      p.px(RX + RW - 10, roofTop - 6, 1, 8, '#59627a');
      p.light(RX + RW - 10, roofTop - 7, 1, 1, L.accent[1] ?? '#ff4fa3', L.accent[1] ?? '#ff4fa3', 4);
      if (RW > 40) {
        p.px(RX + 5, roofTop + 3, 8, 6, mix(r0, '#ffffff', 0.12));
        p.px(RX + 5, roofTop + 3, 8, 1, r1);
      }
      const neon = pickOf(L.accent, seed);
      p.light(RX, roofBottom - 2, RW, 1, neon, neon, 6);
      break;
    }
  }

  // 招牌：门上方
  if (b.sign && ICONS[b.sign] && !st.noSign) {
    const sx = X + Math.floor(PW / 2) - 5;
    const sy = wallTop - 5;
    const woody = pillars || WOODY.has(b.wall);
    const board = L.neon ? '#121624' : woody ? '#3a2a22' : '#ffffff';
    const ink = L.neon ? pickOf(L.accent, seed) : woody ? '#e8c26a' : b.roofTri[2];
    p.px(sx - 1, sy - 1, 11, 11, L.neon || woody ? '#000000aa' : b.wallTri[2]);
    p.px(sx, sy, 9, 9, board);
    p.icon(ICONS[b.sign]!, sx + 1, sy + 1, ink, L.neon);
  }
}

// —— 摆设：放在门口两边、楼的两侧 ——
function drawProps(p: Painter, plot: Plot, b: ResolvedBuild, layout: TownLayout) {
  const L = p.L;
  const X = plot.x * TILE;
  const Y = plot.y * TILE;
  const PW = plot.w * TILE;
  const PH = plot.h * TILE;
  const front = Y + PH + 1;
  const slots: [number, number][] = [
    [X + 2, front],
    [X + PW - 14, front],
    [X - 12, Y + PH - 14],
    [X + PW + 1, Y + PH - 14],
  ];
  const doorX = plot.doorX * TILE;
  let i = 0;
  for (const prop of b.props) {
    if (prop === 'carving') continue;
    // 广场中间已经放了篝火 / 水井
    if (plot.shape === 'plaza' && (prop === 'campfire' || (prop === 'well' && !b.props.includes('campfire')))) continue;
    if (prop === 'fence') {
      const [f0, f1] = L.plank;
      for (let xx = X - 2; xx < X + PW + 2; xx += 4) {
        if (xx > doorX - 4 && xx < doorX + TILE + 2) continue;
        p.px(xx, front + 2, 1, 6, f1);
      }
      for (const yy of [front + 3, front + 6]) {
        p.px(X - 2, yy, Math.max(0, doorX - 3 - X), 1, f0);
        p.px(doorX + TILE + 2, yy, Math.max(0, X + PW + 2 - doorX - TILE - 2), 1, f0);
      }
      continue;
    }
    const slot = slots[i++ % slots.length]!;
    drawProp(p, prop, slot[0], slot[1], plot, layout);
  }
}

function drawProp(p: Painter, prop: TownProp, x: number, y: number, plot: Plot, layout: TownLayout) {
  const L = p.L;
  const [b0, b1] = L.plank;
  switch (prop) {
    case 'lantern':
      p.px(x + 5, y, 1, 12, '#5a3a2a');
      p.light(x + 3, y + 1, 5, 6, mix(L.accent[0]!, '#d94a38', 0.4), '#ff7a55', 9);
      p.px(x + 3, y + 1, 5, 1, '#3a2a22');
      return;
    case 'flag':
      p.px(x + 3, y - 6, 1, 18, '#6b6f78');
      p.px(x + 4, y - 6, 7, 5, L.accent[0]!);
      p.px(x + 4, y - 4, 7, 1, mix(L.accent[0]!, '#000000', 0.2));
      return;
    case 'barrels':
      for (const ox of [0, 6]) {
        p.px(x + ox, y + 3, 6, 8, '#8f633e');
        p.px(x + ox, y + 5, 6, 1, '#4a3a2a');
        p.px(x + ox, y + 9, 6, 1, '#4a3a2a');
        p.px(x + ox + 1, y + 3, 4, 1, '#b98a5e');
      }
      return;
    case 'crates':
      p.px(x, y + 5, 7, 6, b0);
      p.px(x + 5, y + 1, 7, 6, b0);
      for (const [cx, cy] of [
        [x, y + 5],
        [x + 5, y + 1],
      ] as const) {
        p.px(cx, cy, 7, 1, b1);
        p.px(cx, cy + 5, 7, 1, b1);
        p.px(cx + 3, cy, 1, 6, b1);
      }
      return;
    case 'well':
      p.px(x + 1, y + 5, 10, 6, L.rock[0]);
      p.px(x + 2, y + 6, 8, 3, L.water4[2]);
      p.px(x + 1, y - 2, 1, 8, b1);
      p.px(x + 10, y - 2, 1, 8, b1);
      p.px(x, y - 3, 12, 2, b0);
      return;
    case 'campfire':
      p.px(x + 2, y + 9, 8, 2, '#6f4a2a');
      p.light(x + 4, y + 4, 4, 5, '#ff9a3a', '#ffb347', 12);
      p.light(x + 5, y + 2, 2, 2, '#ffe08a', '#ffe08a');
      return;
    case 'bench':
      drawBench(p, x - 2, y);
      return;
    case 'flowers':
      p.px(x, y + 7, 12, 4, '#8f5a3e');
      for (let k = 0; k < 5; k++) p.dot(x + 1 + k * 2, y + 6, pickOf(L.accent, k));
      return;
    case 'boat': {
      // 附近有水才放
      const tx = Math.floor(x / TILE);
      for (let dy = 0; dy <= 3; dy++)
        for (const dx of [0, -1, 1, 2]) {
          if (layout.ground[(plot.y + plot.h + dy) * layout.w + tx + dx] === 'water') {
            const bx = (tx + dx) * TILE + 2;
            const by = (plot.y + plot.h + dy) * TILE + 5;
            p.px(bx, by, 12, 4, b0);
            p.px(bx + 1, by + 3, 10, 2, b1);
            p.px(bx + 2, by - 1, 8, 1, b1);
            return;
          }
        }
      return;
    }
    case 'cart':
      p.px(x, y + 3, 12, 5, b0);
      p.px(x, y + 3, 12, 1, b1);
      p.px(x + 2, y + 8, 3, 3, '#4a3a2a');
      p.px(x + 8, y + 8, 3, 3, '#4a3a2a');
      p.px(x + 11, y + 4, 4, 1, b1);
      return;
  }
}

function drawPlot(p: Painter, plot: Plot, b: ResolvedBuild, layout: TownLayout) {
  const L = p.L;
  const X = plot.x * TILE;
  const Y = plot.y * TILE;
  const PW = plot.w * TILE;
  const PH = plot.h * TILE;
  const seed = hashString(plot.loc.id);
  const eaveLanterns = b.roof === 'curved' && (L.lights === 'lantern' || L.lights === 'stone-lantern' || b.props.includes('lantern'));
  const st: BStyle = { b, eaveLanterns };
  const accent = pickOf(L.accent, seed);

  switch (b.shape) {
    case 'house':
      drawBuilding(p, X, Y, PW, PH, { ...st, chimney: b.roof === 'gable' && !L.neon }, seed);
      break;
    case 'hall':
    case 'shrine': {
      if (b.shape === 'shrine') {
        // 抬高的石台，上面一座小殿
        p.px(X, Y + PH - 8, PW, 8, L.rock[1]);
        p.px(X, Y + PH - 8, PW, 2, L.rock[0]);
        p.px(X + PW / 2 - 6, Y + PH - 8, 12, 8, L.rock[0]);
        for (let k = 0; k < 3; k++) p.px(X + PW / 2 - 6, Y + PH - 6 + k * 2, 12, 1, L.rock[1]);
        drawBuilding(p, X + 4, Y - 2, PW - 8, PH - 6, st, seed);
      } else drawBuilding(p, X, Y, PW, PH, st, seed);
      if (b.sign === 'film') {
        const my = Y + PH - 24;
        p.px(X + 3, my, PW - 6, 4, '#2a1c25');
        for (let xx = X + 4; xx < X + PW - 4; xx += 3) p.light(xx, my + 1, 1, 2, '#ffe6a0', '#ffe6a0', 3);
      }
      break;
    }
    case 'shop':
      drawBuilding(p, X, Y, PW, PH, { ...st, awning: [accent, L.neon ? '#1c2130' : '#ffffff'] }, seed);
      break;
    case 'tower': {
      const extra = 8 + b.floors * 8;
      drawBuilding(p, X + 4, Y, PW - 8, PH, st, seed, { extraTop: extra });
      break;
    }
    case 'pagoda': {
      const tiers = Math.max(2, Math.min(3, b.floors));
      for (let t = 0; t < tiers; t++) {
        const tw = PW - 10 - t * 12;
        const tx = X + (PW - tw) / 2;
        const ty = Y + PH - 28 - t * 20;
        drawBuilding(p, tx, ty, tw, 26, { ...st, b: { ...b, floors: 1 }, noSign: t > 0 }, seed + t, { door: t === 0 });
      }
      break;
    }
    case 'dome': {
      drawBuilding(p, X, Y + 6, PW, PH - 6, { ...st, b: { ...b, roof: b.roof === 'dome' ? 'flat' : b.roof } }, seed);
      const cx = X + PW / 2;
      const cy = Y + PH - 26;
      const R = Math.min(PW / 2 - 6, 22);
      const glass = b.window === 'glass' || b.window === 'neon';
      const [d0, d1, d2] = glass ? [L.water4[0], L.water4[1], '#ffffff'] : b.roofTri;
      for (let yy = -R; yy <= 0; yy++)
        for (let xx = -R; xx <= R; xx++) {
          const d = (xx * xx + yy * yy) / (R * R);
          if (d > 1) continue;
          p.dot(cx + xx, cy + yy, d > 0.86 ? (glass && L.neon ? accent : d2) : (xx + yy) % 7 === 0 ? d1 : d0);
        }
      p.px(cx - R + 5, cy - R + 8, 4, 2, '#ffffffaa');
      if (b.sign === 'fish') {
        p.px(cx - 6, cy - 9, 4, 2, '#f2994a');
        p.px(cx + 4, cy - 14, 3, 2, '#ffd23f');
      }
      break;
    }
    case 'stalls': {
      const n = Math.max(2, Math.floor(PW / 30));
      const sw = Math.floor(PW / n);
      for (let i = 0; i < n; i++) {
        const sx = X + i * sw + 2;
        const sy = Y + 8;
        const c1 = pickOf(L.accent, i);
        const c2 = L.neon ? '#1c2130' : b.roof === 'curved' ? mix(c1, '#ffffff', 0.5) : '#ffffff';
        const [k0, k1] = L.plank;
        p.px(sx + 2, sy + PH - 26, sw - 6, 3, 'rgba(0,0,0,0.18)');
        p.px(sx + 1, sy + 4, 1, PH - 14, k1);
        p.px(sx + sw - 5, sy + 4, 1, PH - 14, k1);
        p.px(sx + 1, sy + PH - 22, sw - 5, 9, k0);
        p.px(sx + 1, sy + PH - 22, sw - 5, 1, k1);
        for (let k = 0; k < 4; k++) p.px(sx + 3 + k * 5, sy + PH - 25, 3, 3, pickOf(['#e05a5a', '#ffd23f', '#7ec26b', '#f2994a'], i + k));
        for (let xx = 0; xx < sw - 2; xx++) {
          const c = Math.floor(xx / 3) % 2 ? c2 : c1;
          if (L.neon && c === c1) p.light(sx - 1 + xx, sy - 2, 1, 6, c, c);
          else p.px(sx - 1 + xx, sy - 2, 1, 6, c);
        }
      }
      for (let xx = X + 2; xx < X + PW - 2; xx += 5) {
        const sag = Math.round(Math.sin(((xx - X) / PW) * Math.PI) * 3);
        const lantern = L.lights === 'lantern' || b.roof === 'curved';
        p.light(xx, Y + 2 + sag, 2, 2, lantern ? '#d94a38' : '#ffe6a0', lantern ? '#ff7a55' : '#ffe6a0', 4);
      }
      break;
    }
    case 'arena': {
      // 场地的圈：蓝图写了颜色就用它；霓虹调是深色；柏油、砖路的镇子是红色塑胶跑道；其余跟着路走（石圈、夯土圈）
      const stone = L.path === 'stone';
      const ring = b.hasColor ? b.wallTri[0] : L.neon ? '#2a3142' : L.path === 'asphalt' || L.path === 'brick' ? '#c8604a' : stone ? L.pathTri[0] : mix(L.pathTri[0], L.pathTri[2], 0.35);
      const field = L.neon ? ['#1d2733', '#222e3b'] : stone ? [L.pathTri[1], mix(L.pathTri[1], L.pathTri[2], 0.3)] : [L.groundTri[0], mix(L.groundTri[0], L.groundTri[2], 0.15)];
      const cx = X + PW / 2;
      const cy = Y + PH / 2;
      const rx = PW / 2 - 1;
      const ry = PH / 2 - 1;
      p.px(X + 2, Y + PH - 1, PW, 3, 'rgba(0,0,0,0.12)');
      for (let yy = Y; yy < Y + PH; yy++)
        for (let xx = X; xx < X + PW; xx++) {
          const d = ((xx + 0.5 - cx) / rx) ** 2 + ((yy + 0.5 - cy) / ry) ** 2;
          if (d > 1) continue;
          if (d > 0.52) {
            const lane = Math.abs(d - 0.76) < 0.025;
            if (lane && L.neon) p.light(xx, yy, 1, 1, accent, accent);
            else p.dot(xx, yy, lane ? '#f4ece0' : ring);
          } else p.dot(xx, yy, Math.floor((xx - X) / 6) % 2 ? field[0]! : field[1]!);
        }
      p.px(cx - 1, cy - 6, 2, 12, L.neon ? accent : '#f4ece0');
      break;
    }
    case 'plaza': {
      // 广场中间放什么：摆设里有篝火 / 水井就放它；土地、沙地、灰烬上不放喷泉，其余放喷泉
      const cx = X + PW / 2;
      const cy = Y + PH / 2 + 2;
      const center = b.props.includes('campfire') ? 'campfire' : b.props.includes('well') ? 'well' : L.ground === 'ash' || L.ground === 'sand' || L.ground === 'dirt' ? null : 'fountain';
      p.px(X, Y, PW, PH, mix(L.pathTri[0], L.pathTri[1], 0.4));
      for (let yy = Y + 7; yy < Y + PH; yy += 8) p.px(X, yy, PW, 1, L.pathTri[2]);
      if (center === 'fountain') {
        for (let yy = -9; yy <= 9; yy++)
          for (let xx = -11; xx <= 11; xx++) {
            const d = (xx / 11) ** 2 + (yy / 8) ** 2;
            if (d <= 1) p.dot(cx + xx, cy + yy, d > 0.62 ? L.rock[0] : L.water4[0]);
          }
        p.px(cx - 1, cy - 8, 3, 8, L.rock[0]);
        p.light(cx - 1, cy - 10, 3, 2, L.water4[3], L.water4[3]);
      } else if (center) {
        for (let k = 0; k < 10; k++) p.dot(cx - 9 + ((k * 7) % 18), cy + 5 + (k % 3), L.rock[k % 2]!);
        drawProp(p, center, cx - 6, cy - 8, plot, layout);
      }
      drawTree(p, X, Y, treeKind(L, plot.x, plot.y), 0);
      drawTree(p, X + PW - TILE, Y, treeKind(L, plot.x + 1, plot.y), 3);
      break;
    }
    case 'garden': {
      const [f0, , f2] = L.foliage(L.trees.find((t) => t === 'round' || t === 'pine' || t === 'willow') ?? 'round');
      p.px(X, Y, PW, PH, mix(L.groundTri[0], L.groundTri[1], 0.3));
      // 绿篱一圈
      p.px(X, Y, PW, 4, f2);
      p.px(X, Y, 4, PH, f2);
      p.px(X + PW - 4, Y, 4, PH, f2);
      p.px(X + 1, Y, PW - 2, 2, f0);
      // 小池塘和汀步
      const px0 = X + Math.floor(PW * 0.55);
      const py0 = Y + Math.floor(PH * 0.45);
      for (let yy = -5; yy <= 5; yy++)
        for (let xx = -9; xx <= 9; xx++) if ((xx / 9) ** 2 + (yy / 5) ** 2 <= 1) p.dot(px0 + xx, py0 + yy, (xx + yy) % 5 ? L.water4[0] : L.water4[1]);
      for (let k = 0; k < 4; k++) p.px(X + 8 + k * 6, Y + PH - 10 - k * 3, 4, 3, L.pathTri[1]);
      for (let k = 0; k < 8; k++) p.dot(X + 6 + ((k * 13) % (PW - 12)), Y + 7 + ((k * 7) % (PH - 14)), pickOf(['#ffffff', ...L.accent], k));
      if (b.roof === 'curved') {
        const tx = X + 6;
        const ty = Y + 6;
        p.px(tx + 2, ty + 8, 2, 12, '#6e3b28');
        p.px(tx + 14, ty + 8, 2, 12, '#6e3b28');
        p.px(tx - 2, ty, 22, 9, b.roofTri[2]);
        p.px(tx - 1, ty - 1, 20, 8, b.roofTri[0]);
        p.dot(tx - 3, ty - 2, b.roofTri[2]);
        p.dot(tx + 20, ty - 2, b.roofTri[2]);
      }
      break;
    }
    case 'field': {
      const soil = mix(L.groundTri[2], '#7a5232', 0.6);
      p.px(X, Y, PW, PH, soil);
      const crop = L.foliage(L.trees.find((t) => t === 'round' || t === 'palm' || t === 'willow') ?? 'round');
      for (let yy = Y + 2; yy < Y + PH - 2; yy += 5) {
        p.px(X + 2, yy, PW - 4, 2, crop[0]);
        for (let xx = X + 3; xx < X + PW - 3; xx += 4) p.dot(xx, yy - 1, (xx + yy) % 3 ? crop[1] : '#e8c56e');
      }
      const [k0, k1] = L.plank;
      p.px(X, Y + PH - 1, PW, 1, k0);
      for (let xx = X; xx < X + PW; xx += 5) p.px(xx, Y + PH - 4, 1, 4, k1);
      break;
    }
    case 'pool': {
      const bh = PH - 26;
      drawBuilding(p, X, Y, PW, bh, st, seed);
      const py = Y + bh + 6;
      p.px(X + 2, py, PW - 4, 18, L.neon ? '#3a4152' : '#f4f4f0');
      p.px(X + 5, py + 3, PW - 10, 12, L.water4[0]);
      for (let xx = X + 7; xx < X + PW - 8; xx += 6) p.px(xx, py + 5, 3, 1, L.water4[1]);
      for (const ly of [py + 7, py + 11]) for (let xx = X + 5; xx < X + PW - 5; xx += 2) p.dot(xx, ly, (xx / 2) % 2 ? '#e05a5a' : '#ffffff');
      break;
    }
    case 'dock': {
      const [k0, k1] = L.plank;
      p.px(X, Y + 6, PW, PH - 6, k0);
      for (let xx = X; xx < X + PW; xx += 4) p.px(xx, Y + 6, 1, PH - 6, k1);
      p.px(X, Y + PH - 2, PW, 1, k1);
      for (let xx = X + 2; xx < X + PW; xx += 8) p.px(xx, Y + PH - 6, 1, 5, k1);
      p.px(X, Y + PH - 6, PW, 1, k1);
      if (b.roof === 'curved') {
        const tx = X + PW / 2 - 9;
        p.px(tx + 2, Y + 4, 2, 14, '#6e3b28');
        p.px(tx + 14, Y + 4, 2, 14, '#6e3b28');
        p.px(tx - 2, Y - 4, 22, 9, b.roofTri[2]);
        p.px(tx - 1, Y - 5, 20, 8, b.roofTri[0]);
        p.px(tx + 6, Y - 8, 6, 3, b.roofTri[0]);
      } else {
        drawLamp(p, X, Y);
        drawBench(p, X + TILE, Y + 2);
        drawLamp(p, X + PW - TILE, Y);
      }
      break;
    }
    case 'beach': {
      const ux = X + 14;
      const uy = Y + 6;
      p.px(ux + 5, uy + 4, 1, 14, '#8f633e');
      for (let k = 0; k < 7; k++) p.px(ux + k * 2 - 1, uy + Math.abs(3 - k) - 2, 2, 4 - Math.abs(3 - k) / 2 + 2, k % 2 ? '#ffffff' : accent);
      p.px(ux + 14, uy + 12, 10, 4, pickOf(L.accent, seed + 1));
      p.px(ux + 14, uy + 12, 10, 1, '#ffffff88');
      break;
    }
    case 'wheel': {
      const cx = X + PW / 2;
      const cy = Y + 30;
      const R = 26;
      p.px(cx - 18, Y + PH - 2, 40, 3, 'rgba(0,0,0,0.18)');
      for (let k = 0; k <= 34; k++) {
        p.dot(cx - Math.round(k * 0.5), cy + k, '#8a94a6');
        p.dot(cx + Math.round(k * 0.5), cy + k, '#8a94a6');
      }
      for (let a = 0; a < 360; a += 3) {
        const rad = (a * Math.PI) / 180;
        p.dot(cx + Math.round(Math.cos(rad) * R), cy + Math.round(Math.sin(rad) * R), '#6f7a8e');
        p.dot(cx + Math.round(Math.cos(rad) * (R - 1)), cy + Math.round(Math.sin(rad) * (R - 1)), '#e8ecf2');
      }
      for (let a = 0; a < 360; a += 45) {
        const rad = (a * Math.PI) / 180;
        for (let k = 0; k < R; k += 1) p.dot(cx + Math.round(Math.cos(rad) * k), cy + Math.round(Math.sin(rad) * k), '#8a94a6');
      }
      for (let i = 0; i < 8; i++) {
        const rad = ((i * 45 + 22) * Math.PI) / 180;
        p.light(cx + Math.round(Math.cos(rad) * R) - 2, cy + Math.round(Math.sin(rad) * R) - 1, 5, 4, pickOf([...L.accent, '#7ec26b', '#9b80c6'], i), '#ffe6a0', 3);
      }
      p.px(cx - 2, cy - 2, 5, 5, '#ffffff');
      drawBuilding(p, X + 2, Y + PH - 26, 22, 24, { ...st, b: { ...b, roof: 'flat', floors: 1, window: 'glass' }, noSign: true }, seed, {});
      break;
    }
    case 'gate': {
      const red = b.roof === 'curved' && (WOODY.has(b.wall) || b.wall === 'plaster');
      if (b.wall === 'stone' || b.wall === 'brick') {
        // 城门楼：厚墙中间一个拱门，上面垛口和旗
        const [w0, w1, w2] = b.wallTri;
        p.px(X, Y + 2, PW, PH - 2, w0);
        p.px(X, Y + 2, PW, 2, w1);
        for (let xx = X; xx < X + PW; xx += 5) p.px(xx, Y - 1, 3, 3, w1);
        p.px(X + PW / 2 - 6, Y + PH - 14, 12, 14, w2);
        p.px(X + PW / 2 - 4, Y + PH - 16, 8, 2, w2);
        p.px(X + PW / 2 - 5, Y + PH - 13, 10, 13, mix(w2, '#000000', 0.4));
        drawProp(p, 'flag', X + 2, Y - 2, plot, layout);
        drawProp(p, 'flag', X + PW - 12, Y - 2, plot, layout);
      } else {
        // 牌坊 / 鸟居 / 拱门：两根柱子 + 横梁（+ 屋檐）
        const post = red ? '#c8423a' : b.wallTri[2];
        const beam = b.roof === 'curved' ? b.roofTri[2] : post;
        p.px(X + 4, Y + 2, 3, PH - 2, post);
        p.px(X + PW - 7, Y + 2, 3, PH - 2, post);
        p.px(X, Y + 2, PW, 3, beam);
        p.dot(X - 1, Y + 1, beam);
        p.dot(X + PW, Y + 1, beam);
        p.px(X + 2, Y + 8, PW - 4, 2, post);
        if (b.sign && ICONS[b.sign]) {
          p.px(X + PW / 2 - 5, Y + 5, 10, 8, '#3a2a22');
          p.icon(ICONS[b.sign]!, X + PW / 2 - 4, Y + 6, '#e8c26a', false);
        }
      }
      break;
    }
    case 'tent': {
      const n = PW >= 64 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const tw = Math.floor(PW / n) - 4;
        const tx = X + 2 + i * (tw + 4);
        const cx = tx + Math.floor(tw / 2);
        const c = pickOf([b.wallTri[0], ...L.accent], i);
        p.px(tx + 2, Y + PH - 2, tw, 2, 'rgba(0,0,0,0.18)');
        p.tri(cx, Y + 6, Y + PH - 2, Math.floor(tw / 2), mix(c, '#ffffff', 0.15), mix(c, '#241a3a', 0.25));
        p.tri(cx, Y + PH - 12, Y + PH - 2, 4, '#2a2230', '#2a2230');
        p.px(cx, Y + 3, 1, 4, '#6b6f78');
      }
      drawProp(p, 'campfire', X + PW - 12, Y + PH, plot, layout);
      break;
    }
    case 'ruin': {
      const [w0, w1, w2] = b.wallTri;
      for (const [ox, w, h] of [
        [0, 10, 22],
        [12, 8, 12],
        [PW - 16, 16, 28],
      ] as const) {
        const wx = X + ox;
        const wy = Y + PH - h;
        p.px(wx, wy, w, h, w0);
        p.px(wx, wy, w, 2, w1);
        for (let xx = wx; xx < wx + w; xx += 3) p.px(xx, wy - (xx % 2), 2, 2, w1);
        for (let yy = wy + 4; yy < wy + h; yy += 4) p.px(wx, yy, w, 1, w2);
      }
      for (let k = 0; k < 10; k++) p.px(X + ((k * 11) % PW), Y + PH - 3 - (k % 3), 3, 2, k % 2 ? L.rock[0] : L.rock[1]);
      const [f0] = L.foliage('round');
      for (let k = 0; k < 6; k++) p.px(X + 2 + ((k * 7) % (PW - 4)), Y + PH - 18 + ((k * 5) % 12), 2, 3, f0);
      break;
    }
    case 'cliff': {
      const [c0, c1] = L.rock;
      const face = mix(c0, b.wallTri[0], 0.25);
      p.px(X, Y, PW, PH, face);
      p.px(X, Y, PW, 5, L.groundTri[0]);
      p.px(X, Y + 5, PW, 1, L.groundTri[2]);
      for (let yy = Y + 10; yy < Y + PH - 2; yy += 6) p.px(X, yy + ((yy >> 3) % 2), PW, 1, c1);
      for (let xx = X + 7; xx < X + PW; xx += 13) p.px(xx, Y + 6, 1, PH - 8, c1);
      p.px(X, Y + PH - 3, PW, 3, mix(c1, '#000000', 0.25));
      if (b.props.includes('carving')) {
        // 山崖上刻着几张脸
        const n = Math.max(2, Math.min(5, Math.floor(PW / 22)));
        const gap = PW / n;
        for (let i = 0; i < n; i++) {
          const fx = X + Math.floor(gap * i + gap / 2) - 7;
          const fy = Y + 9;
          p.px(fx + 1, fy, 12, 16, mix(face, '#ffffff', 0.12));
          p.px(fx, fy + 2, 14, 12, mix(face, '#ffffff', 0.12));
          p.px(fx + 1, fy, 12, 3, c1);
          p.px(fx + 3, fy + 6, 3, 1, c1);
          p.px(fx + 8, fy + 6, 3, 1, c1);
          p.px(fx + 6, fy + 8, 2, 3, c1);
          p.px(fx + 4, fy + 12, 6, 1, c1);
          p.px(fx, fy + 4, 1, 8, c1);
          p.px(fx + 13, fy + 4, 1, 8, c1);
        }
      }
      break;
    }
    case 'statue': {
      const cx = X + PW / 2;
      const base = Y + PH - 2;
      const stone = b.wallTri;
      p.px(cx - 8, base - 6, 16, 6, L.rock[1]);
      p.px(cx - 8, base - 6, 16, 2, L.rock[0]);
      p.px(cx - 3, base - 20, 6, 14, stone[0]);
      p.px(cx - 6, base - 18, 12, 3, stone[0]);
      p.px(cx - 2, base - 26, 5, 6, stone[0]);
      p.px(cx - 2, base - 26, 2, 6, stone[1]);
      p.px(cx + 1, base - 20, 2, 14, stone[2]);
      break;
    }
  }
  drawProps(p, plot, b, layout);
}

export interface StaticLayer {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/** 画静态层：地面、四周、建筑、树、灯；叠时段和气氛；夜里点灯 */
export function renderStatic(layout: TownLayout, look: ResolvedLook, builds: Map<string, ResolvedBuild>, tod: TimeOfDay): StaticLayer {
  const width = layout.w * TILE;
  const height = layout.h * TILE;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const p = new Painter(ctx, look);

  drawGround(p, layout);
  drawMountains(p, layout);
  drawCliffs(p, layout);

  // 前后遮挡：按"底边"从上往下画
  type Ent = { base: number; draw: () => void };
  const ents: Ent[] = [
    ...layout.plots.map((pl) => ({ base: pl.y + pl.h, draw: () => drawPlot(p, pl, builds.get(pl.loc.id)!, layout) })),
    ...layout.decos.map((d) => ({ base: d.y + 0.9, draw: () => drawDeco(p, d) })),
  ];
  ents.sort((a, b) => a.base - b.base);
  for (const e of ents) e.draw();
  drawWalls(p, layout);

  // 时段、气氛
  for (const tint of [look.neon && !isDark(tod) ? '#a9b0d0' : TOD_TINT[tod], MOOD_TINT[look.mood]]) {
    if (!tint) continue;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.globalCompositeOperation = 'source-over';
  if (look.mood === 'misty') {
    ctx.fillStyle = 'rgba(240,244,248,0.16)';
    ctx.fillRect(0, 0, width, height);
    const r = rng(layout.seed + 3);
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (let k = 0; k < 9; k++) ctx.fillRect(Math.floor(r() * width) - 60, Math.floor(r() * height), 120 + Math.floor(r() * 80), 3);
  }
  // 点灯
  if (isLit(tod, look)) {
    const strong = isDark(tod) || look.neon;
    ctx.globalCompositeOperation = 'lighter';
    for (const e of p.emits) {
      if (!e.glow || !strong) continue;
      const cx = e.x + e.w / 2;
      const cy = e.y + e.h / 2;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, e.glow * 1.6);
      g.addColorStop(0, `${e.color}55`);
      g.addColorStop(1, `${e.color}00`);
      ctx.fillStyle = g;
      ctx.fillRect(cx - e.glow * 1.6, cy - e.glow * 1.6, e.glow * 3.2, e.glow * 3.2);
    }
    ctx.globalCompositeOperation = 'source-over';
    for (const e of p.emits) {
      if (!strong && e.color.startsWith('#24')) continue;
      ctx.fillStyle = e.color;
      ctx.fillRect(Math.round(e.x), Math.round(e.y), Math.round(e.w), Math.round(e.h));
    }
  }
  return { canvas, width, height };
}

// —— 小人：纸娃娃（身体 + 发型 + 眼睛 + 衣服），外观从角色数据里取（sprite.ts） ——

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return `#${[f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** 10 × 16 的小人；frame 0/1 是呼吸的上下一像素 */
export function drawSprite(ctx: Ctx, x: number, y: number, look: SpriteLook, frame: number) {
  const P = (dx: number, dy: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x + dx, y + dy, w, h);
  };
  const b = frame ? 1 : 0;
  const skin = look.skin;
  const hair = look.hair;
  const hairD = shade(hair, 0.7);
  const cloth = look.outfit;
  const clothD = shade(cloth, 0.72);
  P(1, 15, 8, 2, 'rgba(0,0,0,0.25)');
  P(3, 12, 2, 3, '#3b3446');
  P(5, 12, 2, 3, '#3b3446');
  P(2, 8 + b, 6, 5 - b, cloth);
  P(2, 12, 6, 1, clothD);
  P(1, 9 + b, 1, 3, skin);
  P(8, 9 + b, 1, 3, skin);
  if (look.style === 'long') P(1, 4 + b, 8, 6, hairD);
  if (look.style === 'twintails') {
    P(0, 3 + b, 1, 7, hairD);
    P(9, 3 + b, 1, 7, hairD);
    P(-1, 5 + b, 1, 4, hairD);
    P(10, 5 + b, 1, 4, hairD);
  }
  if (look.style === 'ponytail') P(8, 2 + b, 2, 6, hairD);
  P(2, 2 + b, 6, 6, skin);
  P(1, 1 + b, 8, 3, hair);
  P(1, 3 + b, 1, look.style === 'short' ? 2 : 3, hair);
  P(8, 3 + b, 1, look.style === 'short' ? 2 : 3, hair);
  P(2, 1 + b, 4, 1, shade(hair, 1.25));
  P(3, 5 + b, 1, 1, look.eyes);
  P(6, 5 + b, 1, 1, look.eyes);
  P(2, 6 + b, 1, 1, '#f3a7a0');
  P(7, 6 + b, 1, 1, '#f3a7a0');
}

/** 动态层：水面闪光、雨 */
export function drawWaterShimmer(ctx: Ctx, layout: TownLayout, look: ResolvedLook, t: number) {
  ctx.fillStyle = look.water4[3];
  ctx.globalAlpha = 0.7;
  for (let ty = 0; ty < layout.h; ty++)
    for (let tx = 0; tx < layout.w; tx++) {
      if (layout.ground[ty * layout.w + tx] !== 'water') continue;
      const ph = noise(tx, ty);
      const k = (t * 0.6 + ph * 10) % 10;
      if (k > 2.2) continue;
      ctx.fillRect(tx * TILE + Math.floor(ph * 10), ty * TILE + 4 + Math.floor((ph * 97) % 9), 3, 1);
    }
  ctx.globalAlpha = 1;
}

export function drawRain(ctx: Ctx, w: number, h: number, t: number) {
  ctx.fillStyle = 'rgba(210,225,255,0.45)';
  const r = rng(Math.floor(t * 8));
  for (let i = 0; i < 140; i++) ctx.fillRect(Math.floor(r() * w), Math.floor(r() * h), 1, 4);
}

export function spriteTint(tod: TimeOfDay): string | null {
  return TOD_TINT[tod];
}
