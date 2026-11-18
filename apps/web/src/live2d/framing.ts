import type { CharacterLive2D } from '@app/shared';

export interface Bounds { left: number; right: number; bottom: number; top: number }

export function validBounds(b: Bounds): boolean {
  return Object.values(b).every(Number.isFinite) && b.right > b.left && b.top > b.bottom;
}

export interface Framing { zoom: number; x: number; y: number }
export const FRAMING_LIMITS = { zoom: [0.4, 2.5], x: [-60, 60], y: [-80, 80] } as const;
const within = (value: unknown, [min, max]: readonly [number, number], fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** Saved framing with every field present and inside the range the controls offer. */
export function normalizeFraming(framing?: { zoom?: number; x?: number; y?: number } | null): Framing {
  return {
    zoom: Math.round(within(framing?.zoom, FRAMING_LIMITS.zoom, 1) * 100) / 100,
    x: Math.round(within(framing?.x, FRAMING_LIMITS.x, 0) * 10) / 10,
    y: Math.round(within(framing?.y, FRAMING_LIMITS.y, 0) * 10) / 10,
  };
}

/** Save a framing change on the model config; the untouched default is stored as "no framing". */
export function setFraming(config: CharacterLive2D, patch: Partial<Framing>) {
  const next = normalizeFraming({ ...config.framing, ...patch });
  if (next.zoom === 1 && !next.x && !next.y) delete config.framing;
  else config.framing = next;
}

/**
 * Uniform screen-space scale, independent of the exported canvas size/origin.
 * zoom scales around the bottom centre; x / y then shift by a percentage of the stage (right / up positive).
 */
export function fitSilhouette(bounds: Bounds, width: number, height: number, framing?: { zoom?: number; x?: number; y?: number } | null) {
  const aspect = Math.max(1, width) / Math.max(1, height);
  const { zoom, x, y } = normalizeFraming(framing);
  const scale = Math.min(1.92 * aspect / (bounds.right - bounds.left), 1.94 / (bounds.top - bounds.bottom)) * zoom;
  return {
    x: scale / aspect,
    y: scale,
    tx: -(bounds.left + bounds.right) / 2 * scale / aspect + x / 50,
    // Unmoved, the visible lower edge meets the frame; busts cannot float above captions.
    ty: -1 - bounds.bottom * scale + y / 50,
  };
}

/** readPixels rows start at the bottom; discard transparent padding, not mesh vertices. */
export function alphaBounds(pixels: Uint8Array, width: number, height: number): Bounds | undefined {
  const bounds = { left: width, right: -1, bottom: height, top: -1 };
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (pixels[(y * width + x) * 4 + 3]! < 24) continue;
    bounds.left = Math.min(bounds.left, x);
    bounds.right = Math.max(bounds.right, x + 1);
    bounds.bottom = Math.min(bounds.bottom, y);
    bounds.top = Math.max(bounds.top, y + 1);
  }
  return validBounds(bounds) ? bounds : undefined;
}
