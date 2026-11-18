import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { WALL_H, type DecorRoom } from './model';
import { surface } from './surfaces';
import { shade } from './textures';

/** Actual moulding catches the light, including on old saved rooms. */
export function roomTrim(room: DecorRoom): THREE.Group {
  const root = new THREE.Group();
  const { w, d } = room;
  const trim = surface(shade(room.wall.color, 0.055));
  const panel = surface(shade(room.wall.color, -0.035));
  const rail = (width: number, height: number, depth: number, x: number, y: number, z: number, material = trim) => {
    const mesh = new THREE.Mesh(new RoundedBoxGeometry(width, height, depth, 1, Math.min(0.014, height / 3, depth / 3)), material);
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    mesh.raycast = () => {};
    root.add(mesh);
  };
  rail(w, 0.14, 0.055, 0, 0.07, -d / 2 + 0.026);
  rail(0.055, 0.14, d, -w / 2 + 0.026, 0.07, 0);
  rail(w + 0.18, 0.065, 0.2, -0.04, WALL_H - 0.02, -d / 2 - 0.045);
  rail(0.2, 0.065, d, -w / 2 - 0.045, WALL_H - 0.02, 0);
  // A small lower plinth gives the miniature a finished, layered edge.
  rail(w + 0.16, 0.055, 0.055, -0.075, -0.18, d / 2 + 0.012, surface(shade(room.floor.color, -0.1), 'wood'));
  rail(0.055, 0.055, d + 0.16, w / 2 + 0.012, -0.18, -0.075, surface(shade(room.floor.color, -0.1), 'wood'));
  if (room.wall.finish === 'wainscot') {
    rail(w, 0.045, 0.07, 0, 1, -d / 2 + 0.035);
    rail(0.07, 0.045, d, -w / 2 + 0.035, 1, 0);
    for (const side of ['back', 'left'] as const) {
      const length = side === 'back' ? w : d;
      const count = Math.round(length / 0.8);
      const span = length / count;
      for (let i = 0; i < count; i++) {
        const center = -length / 2 + span * (i + 0.5);
        const along = (a: number, y: number, width: number, height: number) => side === 'back'
          ? rail(width, height, 0.028, a, y, -d / 2 + 0.025, panel)
          : rail(0.028, height, width, -w / 2 + 0.025, y, a, panel);
        for (const y of [0.24, 0.83]) along(center, y, span - 0.16, 0.026);
        for (const offset of [-1, 1]) along(center + offset * (span / 2 - 0.08), 0.535, 0.026, 0.59);
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const back = ctx.createLinearGradient(0, 0, 0, 25);
  back.addColorStop(0, 'rgba(79,56,43,.18)');
  back.addColorStop(1, 'rgba(79,56,43,0)');
  ctx.fillStyle = back;
  ctx.fillRect(0, 0, 256, 25);
  const left = ctx.createLinearGradient(0, 0, 25, 0);
  left.addColorStop(0, 'rgba(79,56,43,.16)');
  left.addColorStop(1, 'rgba(79,56,43,0)');
  ctx.fillStyle = left;
  ctx.fillRect(0, 0, 25, 256);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false });
  material.userData.own = true;
  const contact = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = 0.001;
  contact.raycast = () => {};
  root.add(contact);
  return root;
}
