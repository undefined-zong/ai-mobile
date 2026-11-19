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
  for (const section of chest.sections) {
    const angle = section.angle * Math.PI;
    const shell = new THREE.Mesh(new THREE.CylinderGeometry(chest.top, chest.bottom, chest.height * height, 28, 1, true, angle - chest.arc / 2, chest.arc), figureMaterial(color, { side: THREE.DoubleSide }));
    shell.name = `armor-${section.id}`;
    shell.position.set(0, chest.y * height, Math.cos(angle) * chest.offset);
    shell.scale.z = chest.depthScale;
    group.add(shell);
  }
  const belt = design.belt;
  const waist = new THREE.Mesh(new THREE.CylinderGeometry(belt.radius, belt.radius, belt.height * height, 28, 1, true), figureMaterial(color, { side: THREE.DoubleSide }));
  waist.name = 'armor-belt';
  waist.position.y = belt.y * height;
  waist.scale.z = belt.depthScale;
  group.add(waist);
  const collar = design.collar;
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(collar.radius, collar.radius, collar.height * height, 24, 1, true), figureMaterial(under, { side: THREE.DoubleSide }));
  neck.position.y = collar.y * height;
  group.add(neck);
  const p = design.panels;
  for (const piece of p.pieces) {
    const angle = piece.angle * Math.PI;
    const panel = plate(piece.width, p.height * height, color);
    panel.name = `armor-${piece.id}`;
    panel.rotation.y = angle;
    panel.position.set(Math.sin(angle) * p.radius, p.y * height, Math.cos(angle) * p.radius * 0.86);
    for (const row of design.stitches.rows) {
      for (const side of [-1, 1]) {
        const stitch = new THREE.Mesh(new THREE.SphereGeometry(design.stitches.radius, 8, 6), figureMaterial(design.stitches.color));
        stitch.position.set(side * piece.width * 0.33, row * p.height * height, p.depth * 1.5);
        stitch.scale.y = 1.8;
        panel.add(stitch);
      }
    }
    group.add(panel);
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
