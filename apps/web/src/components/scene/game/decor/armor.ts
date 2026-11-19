import * as THREE from 'three';
import { figureMaterial } from './avatarSculpt';
import { shade } from './textures';
import design from './avatar-data/armor.json';

function plate(width: number, height: number, color: string) {
  const r = design.panels.bevel, x = -width / 2, y = -height / 2;
  const shape = new THREE.Shape();
  shape.moveTo(x + r, y);
  shape.lineTo(x + width - r, y);
  shape.quadraticCurveTo(x + width, y, x + width, y + r);
  shape.lineTo(x + width, y + height - r);
  shape.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  shape.lineTo(x + r, y + height);
  shape.quadraticCurveTo(x, y + height, x, y + height - r);
  shape.lineTo(x, y + r);
  shape.quadraticCurveTo(x, y, x + r, y);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: design.panels.depth, bevelSize: r / 2, bevelThickness: r / 2, bevelSegments: 2, steps: 1, curveSegments: 4 });
  return new THREE.Mesh(geometry, figureMaterial(color));
}

export function createArmor(color: string, under: string, height: number) {
  const group = new THREE.Group();
  const chest = design.chest;
  const shell = new THREE.Mesh(new THREE.CylinderGeometry(chest.top, chest.bottom, chest.height * height, 28, 1, true, -chest.arc / 2, chest.arc), figureMaterial(color, { side: THREE.DoubleSide }));
  shell.position.set(0, chest.y * height, 0.014);
  shell.scale.z = 0.86;
  group.add(shell);
  const collar = design.collar;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(collar.radius, collar.radius, collar.height * height, 24, 1, true), figureMaterial(under, { side: THREE.DoubleSide }));
  neck.position.y = collar.y * height;
  group.add(neck);
  const p = design.panels;
  for (let i = 0; i < p.count; i++) {
    const angle = (i + 0.5) / p.count * Math.PI * 2;
    const section = new THREE.Group();
    section.rotation.y = angle;
    section.position.set(Math.sin(angle) * p.radius, 0, Math.cos(angle) * p.radius * 0.86);
    for (let row = 0; row < p.rows; row++) {
      const panel = plate(p.width, p.height * height, row % 2 ? shade(color, -0.035) : color);
      panel.position.set(0, (p.y - row * p.step) * height, row * p.depth / 2);
      for (const side of [-1, 1]) {
        const stitch = new THREE.Mesh(new THREE.SphereGeometry(design.stitches.radius, 8, 6), figureMaterial(design.stitches.color));
        stitch.position.set(side * p.width * 0.33, p.height * 0.2, p.depth * 1.5);
        stitch.scale.y = 1.8;
        panel.add(stitch);
      }
      section.add(panel);
    }
    group.add(section);
  }
  group.traverse((object) => { if (object instanceof THREE.Mesh) object.castShadow = true; });
  return group;
}

export function createShoulderArmor(color: string, side: number) {
  const d = design.shoulder;
  const group = new THREE.Group();
  const panel = plate(d.width, d.height, color);
  panel.rotation.x = -Math.PI / 2;
  panel.rotation.y = side * 0.18;
  panel.position.set(side * d.width * 0.05, d.y, 0);
  const edge = plate(d.width, d.height * 0.62, shade(color, -0.03));
  edge.position.set(0, d.y - d.height * 0.24, d.depth / 2);
  group.add(panel, edge);
  return group;
}
