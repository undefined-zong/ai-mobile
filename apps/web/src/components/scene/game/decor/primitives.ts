import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { surface, type Surface } from './surfaces';

export type V3 = [number, number, number];

export function mesh(geo: THREE.BufferGeometry, color: string, pos: V3 = [0, 0, 0], opts: { glow?: string; cast?: boolean; opacity?: number; surface?: Surface } = {}): THREE.Mesh {
  const finish = opts.surface ?? (['#c9ccd2', '#e8c26a'].includes(color) ? 'metal' : ['#d2a679', '#8a5a3b'].includes(color) ? 'wood' : 'paint');
  const m = new THREE.Mesh(geo, surface(color, finish, { emissive: opts.glow, opacity: opts.opacity }));
  m.userData.surface = opts.surface;
  m.position.set(...pos);
  m.castShadow = opts.cast ?? true;
  m.receiveShadow = true;
  return m;
}

/** 圆角方块：pos 是底面中心 */
export function box(w: number, h: number, d: number, color: string, pos: V3 = [0, 0, 0], r = 0.04, opts: { glow?: string; cast?: boolean; surface?: Surface } = {}) {
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001);
  const geo = rr > 0.005 ? new RoundedBoxGeometry(w, h, d, 3, rr) : new THREE.BoxGeometry(w, h, d);
  return mesh(geo, color, [pos[0], pos[1] + h / 2, pos[2]], opts);
}

/** 圆柱：pos 是底面中心 */
export function cyl(rt: number, rb: number, h: number, color: string, pos: V3 = [0, 0, 0], seg = 20, opts: { glow?: string; cast?: boolean; surface?: Surface } = {}) {
  return mesh(new THREE.CylinderGeometry(rt, rb, h, seg), color, [pos[0], pos[1] + h / 2, pos[2]], opts);
}

export function ball(r: number, color: string, pos: V3 = [0, 0, 0], scale: V3 = [1, 1, 1], opts: { glow?: string } = {}) {
  const m = mesh(new THREE.SphereGeometry(r, 20, 14), color, pos, opts);
  m.scale.set(...scale);
  return m;
}

export function group(...children: THREE.Object3D[]): THREE.Group {
  const g = new THREE.Group();
  g.add(...children);
  return g;
}

export function legs(w: number, d: number, h: number, r: number, color: string, inset = 0.08): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.push(cyl(r, r * 0.8, h, color, [sx * (w / 2 - inset), 0, sz * (d / 2 - inset)], 10));
  return out;
}

/** 横着的圆柱（轴朝前后）：pos 是中心 */
export function disc(r: number, depth: number, color: string, pos: V3, seg = 24, opts: { glow?: string; cast?: boolean } = {}) {
  const m = mesh(new THREE.CylinderGeometry(r, r, depth, seg), color, pos, opts);
  m.rotation.x = Math.PI / 2;
  return m;
}

/** 圆环：默认平躺着（轴朝上），stand 时立起来朝前 */
export function ring(r: number, tube: number, color: string, pos: V3, stand = false, arc = Math.PI * 2) {
  const m = mesh(new THREE.TorusGeometry(r, tube, 8, 24, arc), color, pos);
  if (!stand) m.rotation.x = Math.PI / 2;
  return m;
}

/** 亮着的屏幕（晚上会发光）：pos 是底边中心 */
export function screen(w: number, h: number, pos: V3, color = '#9fd0f0') {
  return box(w, h, 0.006, color, pos, 0, { glow: color, cast: false });
}

