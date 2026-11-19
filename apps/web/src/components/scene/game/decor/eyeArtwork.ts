import * as THREE from 'three';
import atlasUrl from '@/assets/avatars/eyes.webp';
import artwork from './avatar-data/eyes.json';

const atlas = new Image();
atlas.src = atlasUrl;
let ready = false;
/** The room can draw its procedural fallback while the original eye artwork loads. */
export const eyeArtworkReady = atlas.decode().then(() => { ready = true; }).catch(() => {});
const coloredEyes = new Map<string, HTMLCanvasElement>();

/** Recolour only the iris; the authored lashes, sclera and catchlights keep their ink. */
export function drawEyeArtwork(g: CanvasRenderingContext2D, style: string, x: number, y: number, color: string, side: number): boolean {
  const frames = artwork.styles[style as keyof typeof artwork.styles];
  if (!ready || !frames) return false;
  const key = `${style}:${color}:${side}`;
  let eye = coloredEyes.get(key);
  const frame = frames[side < 0 ? 0 : 1]!;
  const [sx, sy, width, height] = frame.crop as [number, number, number, number];
  const [cx, cy, rx, ry] = frame.iris as [number, number, number, number];
  if (!eye) {
    eye = document.createElement('canvas');
    eye.width = width;
    eye.height = height;
    const ctx = eye.getContext('2d')!;
    ctx.drawImage(atlas, sx, sy, width, height, 0, 0, width, height);
    const pixels = ctx.getImageData(0, 0, width, height);
    const tint = new THREE.Color(color).convertLinearToSRGB().toArray();
    for (let py = 0; py < height; py++) for (let px = 0; px < width; px++) {
      const radius = Math.hypot((px + sx - cx) / rx, (py + sy - cy) / ry);
      if (radius >= 1) continue;
      const i = (py * width + px) * 4;
      const light = (pixels.data[i]! + pixels.data[i + 1]! + pixels.data[i + 2]!) / (3 * 255);
      const amount = (1 - THREE.MathUtils.smoothstep(radius, 0.85, 1)) * THREE.MathUtils.smoothstep(light, 0.1, 0.3) * (1 - THREE.MathUtils.smoothstep(light, 0.84, 0.98));
      for (let channel = 0; channel < 3; channel++) {
        const base = tint[channel]!;
        const dyed = light < 0.55 ? base * light / 0.55 : base + (1 - base) * (light - 0.55) / 0.45;
        pixels.data[i + channel] = Math.round(THREE.MathUtils.lerp(pixels.data[i + channel]!, dyed * 255, amount));
      }
    }
    ctx.putImageData(pixels, 0, 0);
    coloredEyes.set(key, eye);
    if (coloredEyes.size > artwork.cacheLimit) coloredEyes.delete(coloredEyes.keys().next().value!);
  }
  const scale = artwork.displayWidth / width;
  // Register at the iris, so changing eye styles does not move the gaze.
  g.drawImage(eye, x - (cx - sx) * scale, y - (cy - sy) * scale, width * scale, height * scale);
  return true;
}
