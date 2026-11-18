import * as THREE from 'three';

export type Surface = 'paint' | 'wood' | 'fabric' | 'ceramic' | 'metal';

const materials = new Map<string, THREE.MeshStandardMaterial>();
const textures = new Map<string, THREE.CanvasTexture>();
let glow = false;

/** Shared, small, deterministic tiles: furniture keeps its chosen colour. */
export function grain(kind: 'wood' | 'fabric'): THREE.CanvasTexture {
  const hit = textures.get(kind);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#f2f0eb';
  ctx.fillRect(0, 0, 256, 256);
  if (kind === 'wood') {
    for (let y = 0; y < 256; y += 2) {
      ctx.strokeStyle = `rgba(92,67,40,${0.025 + (Math.sin(y * 13.17) + 1) * 0.035})`;
      ctx.lineWidth = y % 7 === 0 ? 1.5 : 0.6;
      ctx.beginPath();
      for (let x = 0; x <= 256; x += 4) {
        const bend = Math.sin(x * Math.PI / 128) * Math.sin(y * 0.12) * 3;
        ctx.lineTo(x, y + bend);
      }
      ctx.stroke();
    }
  } else {
    for (let i = 0; i < 256; i += 4) {
      ctx.fillStyle = i % 8 === 0 ? 'rgba(90,76,64,.09)' : 'rgba(255,255,255,.4)';
      ctx.fillRect(i, 0, 1, 256);
      ctx.fillRect(0, i, 256, 1);
    }
  }
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  textures.set(kind, t);
  return t;
}

export function surface(color: string, kind: Surface = 'paint', opts: { emissive?: string; alwaysLit?: boolean; opacity?: number; side?: THREE.Side } = {}): THREE.MeshStandardMaterial {
  const key = `${kind}|${color}|${opts.emissive ?? ''}|${opts.alwaysLit ?? false}|${opts.opacity ?? 1}|${opts.side ?? 0}`;
  const hit = materials.get(key);
  if (hit) return hit;
  const m = new THREE.MeshStandardMaterial({
    color,
    roughness: { paint: 0.68, wood: 0.76, fabric: 1, ceramic: 0.27, metal: 0.32 }[kind],
    metalness: kind === 'metal' ? 0.55 : 0,
    side: opts.side ?? THREE.FrontSide,
  });
  if (kind === 'wood' || kind === 'fabric') m.map = grain(kind);
  if (opts.emissive) {
    m.emissive.set(opts.emissive);
    m.emissiveIntensity = glow ? 0.9 : opts.alwaysLit ? 0.65 : 0;
    m.userData.glow = true;
    m.userData.alwaysLit = opts.alwaysLit;
  }
  if (opts.opacity !== undefined) {
    m.transparent = true;
    m.opacity = opts.opacity;
    m.depthWrite = false;
  }
  m.userData.surface = kind;
  materials.set(key, m);
  return m;
}

export function setSurfaceGlow(on: boolean) {
  glow = on;
  for (const m of materials.values()) if (m.userData.glow) m.emissiveIntensity = on ? 0.9 : m.userData.alwaysLit ? 0.65 : 0;
}

export function disposeSurfaces() {
  for (const m of materials.values()) m.dispose();
  for (const t of textures.values()) t.dispose();
  materials.clear();
  textures.clear();
  glow = false;
}
