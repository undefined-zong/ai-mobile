import * as THREE from 'three';
import type { Avatar } from './avatar';
import hairData from './avatar-data/hair.json';
import studioData from './avatar-data/studio.json';
import sculptedHair from './avatar-data/sculpted-hair.json';
import { cloth, shade } from './textures';

/** Shared matte materials keep the figure's skin, fabric and hair under the same light. */
const materials = new Map<string, THREE.MeshToonMaterial>();
const ramp = new THREE.DataTexture(new Uint8Array([162, 210, 240, 255]), 4, 1, THREE.RedFormat);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
ramp.generateMipmaps = false;
ramp.needsUpdate = true;
export function figureMaterial(color: string, opts: { side?: THREE.Side } = {}) {
  const key = `${color}:${opts.side ?? THREE.FrontSide}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshToonMaterial({ color, gradientMap: ramp, ...opts });
    materials.set(key, material);
  }
  return material;
}

export function figureCloth(color: string, pattern: string, around: number, height: number, opts: { side?: THREE.Side } = {}) {
  if (pattern === 'plain') return figureMaterial(color, opts);
  const source = cloth(color, pattern, around, height, opts);
  const key = `cloth:${source.uuid}`;
  let material = materials.get(key);
  if (!material) {
    material = new THREE.MeshToonMaterial({ color: source.color, map: source.map, gradientMap: ramp, ...opts });
    materials.set(key, material);
  }
  return material;
}

/** The head and its face overlay are deformed together so features follow the cheeks. */
export function sculptHead(radius: number, avatar: Avatar, face = false) {
  const shape = studioData.faceShapes.find((s) => s.id === avatar.faceShape) ?? studioData.faceShapes[0]!;
  const geometry = face
    ? new THREE.SphereGeometry(radius, 48, 28, Math.PI * 0.2, Math.PI * 0.6, Math.PI * 0.34, Math.PI * 0.44)
    : new THREE.SphereGeometry(radius, 48, 36);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const y = position.getY(i) / radius;
    const jaw = Math.pow(Math.max(0, -y), 1.5) * shape.jaw;
    const cheek = Math.exp(-Math.pow((y + 0.28) / 0.3, 2)) * shape.cheek;
    position.setXYZ(i, position.getX(i) * shape.width * (1 - jaw + cheek), position.getY(i) * shape.height, position.getZ(i) * shape.depth);
  }
  geometry.computeVertexNormals();
  return geometry;
}

type Point = number[];
const hairMaterial = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: sculptedHair.roughness, metalness: 0 });

/** A curved, tapered lock with an elliptical cross-section, instead of a cone. */
function lock(points: Point[], width: number, radius: number, depth = 0.4, normalHint: Point = [0, 0, 1], widthProfile = sculptedHair.widthProfile) {
  const v = points.map((p) => new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(radius));
  const curve = new THREE.CubicBezierCurve3(v[0]!, v[1]!, v[2]!, v[3]!);
  const positions: number[] = [], indices: number[] = [];
  const segments = 28, sides = 12;
  const hint = new THREE.Vector3(...normalHint);
  const [rootWidth, shoulderWidth, tipWidth, endWidth] = widthProfile;
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const center = curve.getPoint(t), tangent = curve.getTangent(t);
    const across = hint.clone().cross(tangent).normalize();
    const normal = tangent.clone().cross(across).normalize();
    const u = 1 - t;
    const profile = u ** 3 * rootWidth! + 3 * u * u * t * shoulderWidth! + 3 * u * t * t * tipWidth! + t ** 3 * endWidth!;
    const size = width * radius * profile;
    for (let j = 0; j <= sides; j++) {
      const angle = j / sides * Math.PI * 2;
      const p = center.clone().addScaledVector(across, Math.cos(angle) * size).addScaledVector(normal, Math.sin(angle) * size * depth);
      positions.push(p.x, p.y, p.z);
      if (i < segments && j < sides) {
        const a = i * (sides + 1) + j, b = a + sides + 1;
        indices.push(a, b, a + 1, b, b + 1, a + 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, hairMaterial);
  mesh.castShadow = true;
  return mesh;
}

function cap(radius: number, avatar: Avatar) {
  const settings = sculptedHair.scalp;
  const volume = avatar.hairTop === 'fluffy' ? settings.fluffyHeight : settings.height;
  const geometry = new THREE.SphereGeometry(radius, 48, 28, 0, Math.PI * 2, 0, Math.PI * 0.99);
  const position = geometry.getAttribute('position'), uv = geometry.getAttribute('uv');
  for (let i = 0; i < position.count; i++) {
    const phi = uv.getX(i) * Math.PI * 2;
    const front = Math.max(0, Math.sin(phi));
    const coverage = settings.madaraCoverage;
    const madaraEdge = coverage.edge + coverage.extension * Math.exp(-Math.pow((-Math.cos(phi) - coverage.centerX) / coverage.width, 2));
    const frontEdge = avatar.bangs === 'none' ? settings.openFrontEdge
      : avatar.hair === 'madara' && avatar.bangs === 'oneEye' ? madaraEdge : settings.frontEdge;
    const edge = THREE.MathUtils.lerp(settings.backEdge, frontEdge, front * front);
    const theta = (1 - uv.getY(i)) * edge * Math.PI;
    position.setXYZ(i, -Math.cos(phi) * Math.sin(theta) * radius * settings.width,
      Math.cos(theta) * radius * volume, Math.sin(phi) * Math.sin(theta) * radius);
  }
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, hairMaterial);
  mesh.castShadow = true;
  return mesh;
}

export function sculptHair(avatar: Avatar, radius: number) {
  if (avatar.hair === 'madara' || avatar.hair === 'halfUp') return sculptSignatureHair(avatar, radius);
  const group = new THREE.Group();
  const style = hairData.styles[avatar.hair as keyof typeof hairData.styles] ?? hairData.styles.short;
  group.add(cap(radius, avatar));
  for (const part of sculptedHair.bangs[avatar.bangs as keyof typeof sculptedHair.bangs] ?? []) {
    group.add(lock(part.points, part.width, radius, 0.48));
  }
  // Overlapping sections form the back silhouette and preserve a continuous crown.
  const count = 13;
  const longHair = style.length >= 1;
  if (longHair) group.add(hairCurtain(radius, style.length, style.width));
  for (let i = 0; !longHair && i < count; i++) {
    const angle = Math.PI * (0.94 + i / (count - 1) * 1.12);
    const x = -Math.cos(angle), z = Math.sin(angle);
    const stagger = Math.sin(i * 2.4) * style.wave;
    const length = style.length + stagger;
    group.add(lock([
      [x * 0.76, 0.64, z * 0.76],
      [x * style.width, 0.18, z * 1.04],
      [x * (style.width + style.flare), -length * 0.72, z * 0.94],
      [x * (style.width + style.flare * 0.6 - 0.08), -length, z * 0.72],
    ], 0.25, radius, 0.48, [x, 0, z]));
  }
  for (const side of [-1, 1]) {
    group.add(lock([
      [side * 0.77, 0.62, 0.36], [side * 1.02, 0.1, 0.53],
      [side * 1.01, -style.side * 0.7, 0.5], [side * 0.82, -style.side, 0.4],
    ], 0.22, radius, 0.5));
  }

  const tieMaterial = figureMaterial(avatar.accColor);
  const tie = (x: number, y: number, z: number, size: number) => {
    const m = new THREE.Mesh(new THREE.SphereGeometry(radius * size, 16, 10), tieMaterial);
    m.position.set(x * radius, y * radius, z * radius);
    m.scale.set(1, 0.65, 1);
    group.add(m);
  };
  if (avatar.hair === 'twin' || avatar.hair === 'pony') {
    const twin = avatar.hair === 'twin';
    for (const side of twin ? [-1, 1] : [0]) {
      const x = twin ? side * 0.96 : 0, y = twin ? 0.35 : 0.7, z = twin ? -0.23 : -0.85;
      for (let i = -2; i <= 2; i++) {
        const spread = i * 0.12;
        group.add(lock([
          [x + spread * 0.2, y, z],
          [x * 1.55 + spread, y + 0.08, z - 0.35],
          [x * 1.5 + spread, -1.08, z - 0.46],
          [x * 1.2 + spread, -1.8 + Math.abs(i) * 0.08, z - 0.1],
        ], 0.23, radius, 0.7));
      }
      tie(x, y, z + 0.04, 0.16);
    }
  } else if (avatar.hair === 'bun') {
    for (let i = 0; i < 6; i++) {
      const angle = i / 6 * Math.PI * 2;
      const x = Math.cos(angle) * 0.35, z = Math.sin(angle) * 0.28 - 0.3;
      group.add(lock([[x * 0.5, 0.92, z], [x * 1.2, 1.5, z], [-x * 0.6, 1.59, z - 0.14], [-x, 1.1, z - 0.15]], 0.24, radius, 0.8));
    }
    tie(0, 1.03, -0.28, 0.32);
  }
  if (avatar.hairTop === 'ahoge') {
    group.add(lock([[0, 1.0, 0], [-0.16, 1.55, 0], [0.36, 1.63, 0.03], [0.31, 1.28, 0.1]], 0.085, radius, 0.65));
  } else if (avatar.hairTop === 'spiky') {
    for (const part of hairData.crowns.spiky) group.add(lock(part.points, part.width, radius, 0.24));
  } else if (['fluffy', 'messy'].includes(avatar.hairTop) || avatar.hair === 'spiky') {
    for (let i = 0; i < 9; i++) {
      const angle = i / 9 * Math.PI * 2;
      const x = Math.cos(angle), z = Math.sin(angle);
      group.add(lock([
        [x * 0.24, 0.97, z * 0.24], [x * 0.5, 1.1, z * 0.5],
        [x * 0.91, 1.04, z * 0.9], [x * (0.92), 0.54, z * 1.04],
      ], 0.21, radius, 0.42));
    }
  }

  return tintHair(group, avatar, radius, style.length);
}

/** One closed rear volume keeps long hair continuous between the sculpted strands. */
function hairCurtain(radius: number, length: number, width: number, depth = 1) {
  const settings = sculptedHair.curtain;
  const path = new THREE.CatmullRomCurve3(settings.profile.map(([r, y]) => new THREE.Vector3(r!, y! > 0 ? y! : y! * length, 0)));
  const { segments, rings } = settings;
  const positions: number[] = [], indices: number[] = [];
  const stride = segments + 1, surfaceSize = stride * (rings + 1);
  for (let surface = 0; surface < 2; surface++) {
    for (let i = 0; i <= rings; i++) {
      const t = i / rings, profile = path.getPoint(t);
      for (let j = 0; j <= segments; j++) {
        const angle = j / segments * Math.PI;
        const groove = Math.cos(angle * settings.grooves * 2 + t * 0.8) * settings.grooveDepth * Math.sin(t * Math.PI / 2);
        const r = profile.x + groove - surface * settings.thickness;
        const hem = settings.hemWave * Math.cos(angle * settings.grooves * 2) * t ** 8;
        positions.push(Math.cos(angle) * r * width * radius, (profile.y + hem) * radius, -Math.sin(angle) * r * radius * depth);
        if (i < rings && j < segments) {
          const a = surface * surfaceSize + i * stride + j, b = a + stride;
          if (surface === 0) indices.push(a, b, a + 1, b, b + 1, a + 1);
          else indices.push(a, a + 1, b, b, a + 1, b + 1);
        }
      }
    }
  }
  // Close the side edges and hem; the crown overlaps the upper seam.
  for (let i = 0; i < rings; i++) {
    for (const j of [0, segments]) {
      const a = i * stride + j, b = a + stride, c = a + surfaceSize, d = b + surfaceSize;
      if (j === 0) indices.push(a, c, b, b, c, d);
      else indices.push(a, b, c, b, d, c);
    }
  }
  for (let j = 0; j < segments; j++) {
    const a = rings * stride + j, b = a + surfaceSize;
    indices.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const mesh = new THREE.Mesh(geometry, hairMaterial);
  mesh.castShadow = true;
  return mesh;
}

/** Signature styles use a continuous scalp and solid locks at every viewing angle. */
function sculptSignatureHair(avatar: Avatar, radius: number) {
  const group = new THREE.Group();
  const kind = avatar.hair as keyof typeof sculptedHair.styles;
  const style = sculptedHair.styles[kind];
  group.add(cap(radius, avatar));
  const fringe = kind === 'madara' && avatar.bangs === 'oneEye' ? 'madara' : avatar.bangs;
  for (const part of sculptedHair.bangs[fringe as keyof typeof sculptedHair.bangs] ?? []) {
    group.add(lock(part.points, part.width, radius, 0.48));
  }
  if (kind === 'madara') {
    for (const layer of sculptedHair.rearLayers) {
      for (const [i, drop] of layer.tipOffsets.entries()) {
        const angle = THREE.MathUtils.lerp(layer.angleStart, layer.angleEnd, i / (layer.tipOffsets.length - 1)) * Math.PI;
        const x = Math.cos(angle), z = -Math.sin(angle);
        const points = layer.points.map(([rx, y, rz], index) => [
          x * rx!, y! + drop * (index / (layer.points.length - 1)) ** 2, z * rz!,
        ]);
        group.add(lock(points, layer.width, radius, layer.depth, [x, 0, z], sculptedHair.rearWidthProfile));
      }
    }
  } else {
    group.add(hairCurtain(radius, style.length, style.width, style.depth));
    const half = sculptedHair.halfUp;
    for (const side of [-1, 1]) {
      for (let i = 0; i < half.sweeps; i++) {
        group.add(lock([
          [side * (0.45 + i * 0.16), 0.8 - i * 0.1, 0.25],
          [side * 1.08, 0.8, -0.25],
          [side * 0.65, 0.8, -1.03],
          [0, 0.55, -1.08],
        ], 0.16, radius, 0.5, [side, 1, 0]));
      }
    }
    const middle = (half.tailLocks - 1) / 2;
    for (let j = 0; j < half.tailLocks; j++) {
      const i = j - middle;
      group.add(lock([
        [i * 0.06, 0.55, -1.03],
        [i * 0.14, 0.78, -1.4],
        [i * 0.17, -0.6, -1.3],
        [i * 0.13, -1.45 + Math.abs(i) * 0.06, -0.95],
      ], 0.17, radius, 0.55, [0, 0, -1]));
    }
    const band = new THREE.Mesh(new THREE.TorusGeometry(half.tieRadius * radius, half.tieWidth * radius, 10, 24), figureMaterial(avatar.accColor));
    band.position.fromArray(half.tiePosition).multiplyScalar(radius);
    band.rotation.x = Math.PI / 2;
    group.add(band);
  }
  if (avatar.hairTop === 'spiky') {
    for (const part of sculptedHair.crown) group.add(lock(part.points, part.width, radius, 0.65, part.normal, sculptedHair.crownWidthProfile));
  } else if (avatar.hairTop === 'ahoge') {
    group.add(lock([[0, 1.0, 0], [-0.16, 1.55, 0], [0.36, 1.63, 0.03], [0.31, 1.28, 0.1]], 0.085, radius, 0.65));
  }
  return tintHair(group, avatar, radius, style.length);
}

function tintHair(group: THREE.Group, avatar: Avatar, radius: number, length: number) {
  const root = new THREE.Color(avatar.hairColor), end = new THREE.Color(avatar.hairColor2 || avatar.hairColor);
  const highlight = new THREE.Color(shade(avatar.hairColor, 0.12));
  const color = new THREE.Color();
  group.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh || mesh.material !== hairMaterial) return;
    const pos = mesh.geometry.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i) / radius;
      const fade = THREE.MathUtils.smoothstep(-y, 0.05, Math.max(length, 0.7));
      color.lerpColors(root, end, fade);
      // A broad, subdued sheen follows the crown; colour still belongs to the user's palette.
      color.lerp(highlight, Math.exp(-Math.pow((y - 0.42) / 0.24, 2)) * 0.18 * (1 - fade));
      colors.set([color.r, color.g, color.b], i * 3);
    }
    mesh.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  });
  if (avatar.hairFlip) group.scale.x = -1;
  return group;
}

const inks = new Map<string, THREE.MeshBasicMaterial>();
/** A narrow inverted hull gives the editable 3D surfaces a drawn silhouette. */
export function addFigureContours(group: THREE.Group) {
  const meshes: THREE.Mesh[] = [];
  group.traverse((object) => {
    if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshToonMaterial) meshes.push(object);
  });
  for (const mesh of meshes) {
    const base = (mesh.material as THREE.MeshToonMaterial).color;
    const key = base.getHexString();
    let ink = inks.get(key);
    if (!ink) {
      ink = new THREE.MeshBasicMaterial({ color: base.clone().multiplyScalar(0.38), side: THREE.BackSide });
      inks.set(key, ink);
    }
    const geometry = mesh.geometry.clone();
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    const width = studioData.figure.outlineWidth;
    for (let i = 0; i < position.count; i++) position.setXYZ(i, position.getX(i) + normal.getX(i) * width, position.getY(i) + normal.getY(i) * width, position.getZ(i) + normal.getZ(i) * width);
    mesh.add(new THREE.Mesh(geometry, ink));
  }
}
