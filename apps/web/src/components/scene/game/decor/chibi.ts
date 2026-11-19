import * as THREE from 'three';
import type { Avatar } from './avatar';
import settings from './avatar-data/studio.json';
import { faceForExpression, faceTexture, shade, type FaceState } from './textures';
import { figureCloth as cloth, figureMaterial as toon, sculptHair, sculptHead, addFigureContours } from './avatarSculpt';
import { createArmor, createShoulderArmor } from './armor';

/**
 * Q 版小人：大头、短身子，柔和脸型、曲面发束和布料轮廓；脸是一张贴图（眼睛、嘴、腮红），贴在头前面的一片球面上。
 * 原点在两脚中间的地面上，正面朝 +z。会站着晃、走路、坐下（腿往前伸，像玩偶）、躺下、挥手、蹦一下、眨眼。
 * 头发分三块拼：发型（后面和两边）、发顶、刘海，整个能左右翻转，发梢能渐变；衣服能带花纹（textures.ts 的 cloth）。
 */

export type ChibiPose = 'stand' | 'sit' | 'lie';

const HIP = 0.33;
const HEAD_R = settings.figure.headRadius;

type Mat = THREE.Material | string;
const matOf = (m: Mat): THREE.Material => (typeof m === 'string' ? toon(m) : m);

function capsule(r: number, len: number, mat: Mat, y: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, len, 6, 14), matOf(mat));
  m.position.y = y;
  m.castShadow = true;
  return m;
}

function sphere(r: number, mat: Mat, pos: [number, number, number], scale: [number, number, number] = [1, 1, 1], seg = 20): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, seg, Math.round(seg * 0.7)), matOf(mat));
  m.position.set(...pos);
  m.scale.set(...scale);
  m.castShadow = true;
  return m;
}

/** 一截圆筒（裙摆、腰带）：上口半径 rt、下口半径 rb，前后压扁一点 */
function tube(rt: number, rb: number, h: number, mat: Mat, y: number, open = true, flat = 0.84): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, h, 28, 1, open), matOf(mat));
  m.position.y = y;
  m.scale.set(1, 1, flat);
  m.castShadow = true;
  return m;
}

/** 球面的一片：phi 绕竖轴（π/2 是正前方），theta 从头顶往下 */
function shell(r: number, color: string, phi0: number, phiLen: number, theta0: number, thetaLen: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.SphereGeometry(r, 36, 18, phi0 * Math.PI, phiLen * Math.PI, theta0 * Math.PI, thetaLen * Math.PI), toon(color, { side: THREE.DoubleSide }));
  m.castShadow = true;
  return m;
}

/** 球面上一点（头的坐标） */
function onSphere(r: number, phi: number, theta: number): THREE.Vector3 {
  const p = phi * Math.PI;
  const t = theta * Math.PI;
  return new THREE.Vector3(-r * Math.cos(p) * Math.sin(t), r * Math.cos(t), r * Math.sin(p) * Math.sin(t));
}

export class Chibi {
  readonly root = new THREE.Group();
  avatar: Avatar;
  pose: ChibiPose = 'stand';
  activity: 'idle' | 'cook' | 'eat' | 'work' | 'bathe' = 'idle';
  private spoon: THREE.Group | null = null;
  /** 坐、躺时屁股 / 身子离地多高 */
  seatH = 0;
  private body = new THREE.Group();
  private head = new THREE.Group();
  private arms: THREE.Group[] = [];
  private legs: THREE.Group[] = [];
  private face!: THREE.Mesh;
  private faceMat!: THREE.MeshBasicMaterial;
  private t = Math.random() * 10;
  private blinkAt = 2 + Math.random() * 3;
  private blinkUntil = 0;
  private override: FaceState | null = null;
  private overrideUntil = 0;
  private waveUntil = 0;
  private hopUntil = 0;
  private path: THREE.Vector3[] = [];
  private onArrive: (() => void) | null = null;
  private lastFace = '';
  /** 步子多大（穿浴衣迈不开腿） */
  private stride = 1;
  /** 浴衣的长裙摆：坐下时收短，腿伸出来 */
  private longSkirt: THREE.Mesh | null = null;
  speed = 1.5;

  constructor(avatar: Avatar, readonly who: 'you' | 'her') {
    this.avatar = avatar;
    this.root.add(this.body);
    this.build();
  }

  get walking() {
    return this.path.length > 0;
  }

  speechAnchor() {
    this.root.updateWorldMatrix(true, true);
    return this.head.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, .46 * this.avatar.head, 0));
  }

  setAvatar(a: Avatar) {
    this.avatar = a;
    this.build();
  }

  /** 表情（几秒后回到平常的脸）；null 立刻回去 */
  setExpression(expr: string | null, ms = 5000) {
    this.override = faceForExpression(expr);
    this.overrideUntil = this.t + ms / 1000;
  }

  wave(seconds = 2.2) {
    this.waveUntil = this.t + seconds;
  }

  hop() {
    this.hopUntil = this.t + 0.7;
    this.setExpression('laugh', 1800);
  }

  /** 沿着路走（屋里的世界坐标，y 不管），走到了回调 */
  walk(points: THREE.Vector3[], onArrive?: () => void) {
    this.stand();
    this.path = points.map((p) => new THREE.Vector3(p.x, 0, p.z));
    this.onArrive = onArrive ?? null;
    if (!this.path.length) {
      this.onArrive = null;
      onArrive?.();
    }
  }

  stop() {
    this.path = [];
    this.onArrive = null;
  }

  stand() {
    this.pose = 'stand';
    this.seatH = 0;
    this.activity = 'idle';
  }

  /** 坐在 (x, z)，面朝 facing（弧度），坐垫高 h */
  sit(x: number, z: number, facing: number, h: number) {
    this.stop();
    this.pose = 'sit';
    this.seatH = h;
    this.root.position.set(x, 0, z);
    this.root.rotation.y = facing;
  }

  /** 躺在 (x, z)（身子中间），头朝 headDir（弧度），床面高 h */
  lie(x: number, z: number, headDir: number, h: number) {
    this.stop();
    this.pose = 'lie';
    this.seatH = h;
    // 原点在脚下：从身子中间往脚那头退半个身长
    const half = 0.7 * this.avatar.height;
    this.root.position.set(x - Math.sin(headDir) * half, 0, z - Math.cos(headDir) * half);
    this.root.rotation.y = headDir + Math.PI;
  }

  faceTo(x: number, z: number) {
    const dx = x - this.root.position.x;
    const dz = z - this.root.position.z;
    if (Math.hypot(dx, dz) > 0.01) this.root.rotation.y = Math.atan2(dx, dz);
  }

  dispose() {
    this.clear();
  }

  private clear() {
    for (const g of [this.body]) {
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          m.geometry.dispose();
        }
      });
      g.clear();
    }
    this.faceMat?.dispose();
    this.arms = [];
    this.legs = [];
    this.head = new THREE.Group();
  }

  private build() {
    this.clear();
    const a = this.avatar;
    const H = a.height;
    const K = a.head;
    const R = HEAD_R * K;
    const skin = a.skin;
    const suit = a.suit === 'none' ? null : a.suit;
    const dress = suit === 'dress';
    const yukata = suit === 'yukata';
    const robe = suit === 'bathrobe';
    const armor = suit === 'armor';
    // 身上那件的颜色、花纹：穿套装时是套装的
    const top = armor ? a.suitColor2 : suit ? a.suitColor : a.topColor;
    const topPattern = suit ? a.suitPattern : a.topPattern;
    const trim = a.suitColor2;
    const longSleeve = suit ? !dress : ['hoodie', 'shirt', 'sweater'].includes(a.top);
    const topMat = (around: number, height: number, side?: THREE.Side) => cloth(top, topPattern, around, height, side === undefined ? {} : { side });
    const bottomMat = (around: number, height: number, side?: THREE.Side) => cloth(a.bottomColor, a.bottomPattern, around, height, side === undefined ? {} : { side });
    const gloves = a.acc.includes('gloves');
    this.body.userData.chibi = this.who;
    this.stride = yukata ? 0.4 : robe ? 0.75 : 1;
    this.longSkirt = null;

    // 腿（髋关节处转）
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.08, HIP * H, 0);
      const legMat: Mat = yukata || armor ? topMat(0.42, 0.33) : !suit && a.bottom === 'pants' ? bottomMat(0.42, 0.33) : skin;
      leg.add(capsule(0.066, 0.2 * H, legMat, -0.165 * H));
      if (!suit && a.bottom === 'shorts') leg.add(capsule(0.072, 0.05, bottomMat(0.45, 0.19), -0.06));
      leg.add(sphere(0.078, a.shoesColor, [0, -HIP * H + 0.045, 0.03], [1, 0.62, 1.35]));
      this.legs.push(leg);
      this.body.add(leg);
    }

    // 身子
    const outline = settings.figure.torsoProfile;
    const torso = new THREE.Mesh(new THREE.LatheGeometry(outline.map(([r, y]) => new THREE.Vector2(r! * (robe ? 1.05 : 1), y! * H)), 32), topMat(1, 0.52));
    torso.position.y = 0.5 * H;
    torso.castShadow = true;
    torso.scale.set(1, 1, 0.8);
    this.body.add(torso);
    if (armor) {
      this.body.add(createArmor(a.suitColor, a.suitColor2, H));
    } else if (dress) {
      this.body.add(tube(0.15, 0.3, 0.3 * H, topMat(1.4, 0.3 * H, THREE.DoubleSide), 0.33 * H, true, 1));
      this.body.add(sphere(0.045, trim, [0, 0.5 * H, 0.13], [1.6, 0.8, 0.5]));
    } else if (yukata) {
      // 长裙摆：从腰到脚踝（几何体的原点在上口，坐下时往上收）
      const h = 0.3 * H;
      const geo = new THREE.CylinderGeometry(0.158, 0.188, h, 28, 1, true);
      geo.translate(0, -h / 2, 0);
      const skirt = new THREE.Mesh(geo, topMat(1.08, h, THREE.DoubleSide));
      skirt.position.y = 0.37 * H;
      skirt.scale.set(1, 1, 0.86);
      skirt.castShadow = true;
      this.longSkirt = skirt;
      this.body.add(skirt);
      // 腰带，后面打个结
      this.body.add(tube(0.173, 0.173, 0.11 * H, trim, 0.43 * H, false, 0.82));
      for (const s of [-1, 1]) this.body.add(sphere(0.07, trim, [s * 0.065, 0.45 * H, -0.15], [1, 0.8, 0.45]));
      this.body.add(sphere(0.036, shade(trim, -0.1), [0, 0.45 * H, -0.165]));
      // 交领：白色的里襟，左边压着右边
      for (const s of [-1, 1]) {
        const band = capsule(0.02, (s > 0 ? 0.2 : 0.15) * H, '#ffffff', 0);
        band.position.set(s * 0.04 - 0.012, 0.6 * H, 0.122 + (s > 0 ? 0.008 : 0));
        band.rotation.z = -s * 0.45;
        this.body.add(band);
      }
    } else if (robe) {
      // 到膝盖的下摆，腰带在前面系一下，领子和袖口是另一个颜色
      this.body.add(tube(0.166, 0.228, 0.24 * H, topMat(1.25, 0.24 * H, THREE.DoubleSide), 0.29 * H, true, 0.88));
      this.body.add(tube(0.178, 0.178, 0.05 * H, trim, 0.42 * H, false, 0.82));
      this.body.add(sphere(0.032, trim, [0.02, 0.42 * H, 0.146]));
      for (const s of [-1, 1]) {
        const end = capsule(0.014, 0.07, trim, 0);
        end.position.set(0.02 + s * 0.022, 0.37 * H, 0.152);
        end.rotation.z = s * 0.25;
        this.body.add(end);
        const lapel = capsule(0.032, 0.17 * H, trim, 0);
        lapel.position.set(s * 0.05, 0.59 * H, 0.118);
        lapel.rotation.z = -s * 0.42;
        this.body.add(lapel);
      }
    } else {
      const hip = tube(0.137, 0.144, 0.09, bottomMat(0.98, 0.09), 0.3 * H, false, 0.8);
      this.body.add(hip);
      if (a.bottom === 'skirt') this.body.add(tube(0.15, 0.27, 0.2 * H, bottomMat(1.3, 0.2 * H, THREE.DoubleSide), 0.28 * H, true, 1));
    }
    // 上衣的小细节
    if (suit) {
      // 套装没有这些
    } else if (a.top === 'hoodie') {
      this.body.add(sphere(0.17, shade(top, -0.06), [0, 0.68 * H, -0.11], [1.05, 0.55, 0.55]));
      this.body.add(sphere(0.1, shade(top, -0.06), [0, 0.42 * H, 0.12], [1, 0.45, 0.25]));
      for (const s of [-1, 1]) this.body.add(capsule(0.008, 0.08, '#f7f6f2', 0.6 * H).translateX(s * 0.04).translateZ(0.13));
    } else if (a.top === 'shirt') {
      for (const s of [-1, 1]) {
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(settings.figure.collar.flatMap(([x, y, z]) => [x! * s, y! * H, z!]), 3));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        geometry.computeVertexNormals();
        const collar = new THREE.Mesh(geometry, toon('#ffffff', { side: THREE.DoubleSide }));
        this.body.add(collar);
      }
      for (let i = 0; i < 3; i += 1) this.body.add(sphere(0.012, shade(top, -0.3), [0, (0.6 - i * 0.09) * H, 0.13], [1, 1, 0.5], 8));
    } else if (a.top === 'sweater') {
      const hem = new THREE.Mesh(new THREE.TorusGeometry(0.155, 0.02, 8, 24), toon(shade(top, -0.08)));
      hem.rotation.x = Math.PI / 2;
      hem.position.y = 0.36 * H;
      hem.scale.set(1, 0.84, 1);
      const neck = hem.clone();
      neck.scale.set(0.45, 0.4, 1);
      neck.position.y = 0.72 * H;
      this.body.add(hem, neck);
    }

    // 胳膊（肩膀处转）
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * settings.figure.shoulderX, 0.64 * H, 0);
      arm.rotation.z = side * 0.14;
      arm.add(capsule(0.05, 0.18 * H, longSleeve ? topMat(0.31, 0.28) : skin, -0.13 * H));
      if (!longSleeve) arm.add(capsule(0.06, 0.04, topMat(0.38, 0.16), -0.04).translateX(side * 0.004));
      if (dress) arm.add(sphere(0.075, top, [0, -0.03, 0], [1, 0.85, 1]));
      // 浴衣的大袖子：挂在小臂上的一片
      if (yukata) arm.add(sphere(0.088, topMat(0.5, 0.26), [side * 0.004, -0.17 * H, 0], [0.7, 1.45, 1.35]));
      if (robe) arm.add(capsule(0.058, 0.02, trim, -0.225 * H));
      if (armor) arm.add(createShoulderArmor(a.suitColor, side));
      arm.add(sphere(0.044, gloves ? a.accColor : skin, [0, -0.27 * H, 0], [0.92, 1.18, 0.72]));
      arm.add(sphere(0.017, gloves ? a.accColor : skin, [-side * 0.032, -0.254 * H, 0.017], [0.8, 1.3, 1]));
      if (gloves) arm.add(capsule(0.056, 0.012, shade(a.accColor, -0.1), -0.232 * H));
      this.arms.push(arm);
      this.body.add(arm);
    }

    this.spoon = new THREE.Group();
    this.spoon.add(capsule(0.012, 0.16, '#b7c8ca', -0.31 * H), sphere(0.035, '#d8e3dd', [0, -0.42 * H, 0], [1, 1.45, 0.35]));
    this.spoon.visible = false;
    this.arms[1]!.add(this.spoon);

    // 挂在脖子上的耳机
    if (a.acc.includes('neckphones')) {
      const c = a.accColor;
      const geo = new THREE.TorusGeometry(0.14, 0.02, 8, 28, Math.PI * 1.2);
      geo.rotateZ(-Math.PI * 0.1);
      const band = new THREE.Mesh(geo, toon(shade(c, -0.1)));
      band.rotation.x = -Math.PI / 2;
      band.position.set(0, 0.705 * H, -0.01);
      band.scale.set(1, 0.82, 1);
      this.body.add(band);
      for (const s of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.058, 0.045, 18), toon(c));
        cup.rotation.set(Math.PI / 2, 0, s * 0.5);
        cup.position.set(s * 0.128, 0.675 * H, 0.06);
        cup.castShadow = true;
        this.body.add(cup);
      }
    }

    // 头
    this.head = new THREE.Group();
    this.head.position.y = settings.figure.neckHeight * H + R * 0.92;
    this.body.add(this.head);
    const headMesh = new THREE.Mesh(sculptHead(R, a), toon(skin));
    headMesh.castShadow = true;
    this.head.add(headMesh);
    for (const side of [-1, 1]) {
      this.head.add(sphere(R * 0.13, skin, [side * R * 0.93, -R * 0.12, 0], [0.7, 1, 0.75]));
    }
    this.head.add(capsule(0.047 * K, 0.09 * H, skin, -R - 0.04 * H));
    // 脸：头前面的一片
    this.faceMat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
    this.face = new THREE.Mesh(sculptHead(R * 1.006, a, true), this.faceMat);
    this.head.add(this.face);
    this.lastFace = '';
    this.applyFace();

    this.head.add(sculptHair(a, R));
    this.buildAccessory(R, K);
    addFigureContours(this.body);
  }

  private buildAccessory(R: number, K: number) {
    const a = this.avatar;
    const h = this.head;
    const c = a.accColor;
    const has = (id: string) => a.acc.includes(id);
    if (has('catEars')) {
      for (const s of [-1, 1]) {
        const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1 * K, 0.18 * K, 12), toon(a.hairColor));
        ear.position.set(s * R * 0.55, R * 0.92, -R * 0.05);
        ear.rotation.z = -s * 0.35;
        ear.castShadow = true;
        const inner = new THREE.Mesh(new THREE.ConeGeometry(0.06 * K, 0.11 * K, 12), toon('#f4b6c2'));
        inner.position.set(0, -0.02, 0.04);
        ear.add(inner);
        h.add(ear);
      }
    }
    if (has('glasses')) {
      const mat = toon(c === '#f7f6f2' ? '#3a2a2e' : shade(c, -0.15));
      const y = -R * 0.32;
      const z = R * 0.79;
      for (const s of [-1, 1]) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(0.082 * K * a.eyeScale, 0.007, 8, 32), mat);
        ring.position.set(s * R * 0.35 * a.eyeSpacing, y, z);
        h.add(ring);
        const temple = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.012, R * 0.8), mat);
        temple.position.set(s * R * 0.52, y + 0.01, R * 0.55);
        h.add(temple);
      }
      const bridge = new THREE.Mesh(new THREE.BoxGeometry(R * 0.2, 0.012, 0.012), mat);
      bridge.position.set(0, y + 0.02, z + 0.01);
      h.add(bridge);
    }
    if (has('bow')) {
      const bow = new THREE.Group();
      for (const s of [-1, 1]) {
        const wing = new THREE.Mesh(new THREE.ConeGeometry(0.07 * K, 0.13 * K, 12), toon(c));
        wing.rotation.z = s * (Math.PI / 2);
        wing.position.x = s * 0.06 * K;
        wing.castShadow = true;
        bow.add(wing);
      }
      bow.add(sphere(0.035 * K, shade(c, -0.1), [0, 0, 0]));
      bow.position.copy(onSphere(R * 1.08, 0.3, 0.2));
      bow.rotation.set(-0.2, -0.3, 0.4);
      h.add(bow);
    }
    if (has('beanie')) {
      h.add(shell(R * 1.13, c, 0, 2, 0, 0.36));
      const brim = new THREE.Mesh(new THREE.TorusGeometry(R * 1.13 * Math.sin(0.36 * Math.PI), 0.045, 8, 32), toon(shade(c, -0.08)));
      brim.rotation.x = Math.PI / 2;
      brim.position.y = R * 1.13 * Math.cos(0.36 * Math.PI);
      h.add(brim, sphere(0.08 * K, '#f7f6f2', [0, R * 1.18, 0]));
    }
    if (has('headphones')) {
      const band = new THREE.Mesh(new THREE.TorusGeometry(R * (has('beanie') ? 1.2 : 1.14), 0.026, 8, 32, Math.PI), toon(shade(c, -0.1)));
      h.add(band);
      for (const s of [-1, 1]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.1 * K, 0.1 * K, 0.08, 20), toon(c));
        cup.rotation.z = Math.PI / 2;
        cup.position.set(s * R * 1.1, -R * 0.08, 0);
        cup.castShadow = true;
        h.add(cup);
      }
    }
    if (has('flower')) {
      const f = new THREE.Group();
      for (let i = 0; i < 5; i += 1) {
        const ang = (i / 5) * Math.PI * 2;
        f.add(sphere(0.04 * K, c, [Math.cos(ang) * 0.045 * K, Math.sin(ang) * 0.045 * K, 0], [1, 1, 0.5], 10));
      }
      f.add(sphere(0.03 * K, '#f6e09a', [0, 0, 0.015], [1, 1, 0.6], 10));
      f.position.copy(onSphere(R * 1.09, 0.22, 0.32));
      f.lookAt(f.position.clone().multiplyScalar(2));
      h.add(f);
    }
  }

  private applyFace() {
    const blinking = this.t < this.blinkUntil;
    const st: FaceState = { ...(this.t < this.overrideUntil ? (this.override ?? {}) : {}) };
    if (this.pose === 'lie') st.closed = true;
    if (blinking && !st.closed && st.eyes !== 'smile' && (st.eyes ?? this.avatar.eyes) !== 'smile') st.closed = true;
    const key = JSON.stringify(st);
    if (key === this.lastFace) return;
    this.lastFace = key;
    this.faceMat.map = faceTexture(this.avatar, st);
    this.faceMat.needsUpdate = true;
  }

  /** 大乱斗专用姿势；小屋的动作仍由 update 驱动。 */
  battlePose(action: 'idle' | 'run' | 'jump' | 'guard' | 'strike' | 'cast' | 'hurt' | 'down', time: number, progress = 0) {
    const [a, b] = this.arms;
    const [la, lb] = this.legs;
    const swing = Math.sin(time * 15);
    this.body.position.y = 0;
    this.body.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    a!.rotation.set(-.5, 0, -.2); b!.rotation.set(-.6, 0, .2);
    la!.rotation.set(.15, 0, -.06); lb!.rotation.set(-.15, 0, .06);
    if (action === 'run') {
      la!.rotation.x = swing * .9; lb!.rotation.x = -swing * .9;
      a!.rotation.x = -swing * .8; b!.rotation.x = swing * .8;
      this.body.rotation.x = .18; this.body.position.y = Math.abs(swing) * .035;
    } else if (action === 'jump') {
      la!.rotation.x = -.65; lb!.rotation.x = .55; a!.rotation.z = -.65; b!.rotation.z = .65;
    } else if (action === 'guard') {
      a!.rotation.set(-1.2, -.4, -.1); b!.rotation.set(-1.2, .4, .1); this.head.rotation.x = .12;
    } else if (action === 'strike') {
      const punch = Math.sin(Math.min(1, progress) * Math.PI);
      a!.rotation.x = -.8; b!.rotation.x = -1.3 - punch;
      this.body.rotation.y = -.3 + punch * .7; lb!.rotation.x = -.4;
    } else if (action === 'cast') {
      a!.rotation.set(-1.3, 0, -.45); b!.rotation.set(-1.3, 0, .45);
      this.head.rotation.x = -.12;
    } else if (action === 'hurt') {
      this.body.rotation.x = -.35; a!.rotation.z = -.8; b!.rotation.z = .8;
      this.head.rotation.x = -.2;
    } else if (action === 'down') {
      this.body.rotation.x = -Math.PI / 2; this.body.position.y = .18;
    } else {
      this.body.position.y = Math.sin(time * 3) * .012;
    }
  }

  /** 每帧调用：dt 秒 */
  update(dt: number) {
    this.t += dt;
    const t = this.t;
    const H = this.avatar.height;
    // 眨眼
    if (t > this.blinkAt) {
      this.blinkUntil = t + 0.13;
      this.blinkAt = t + 2.2 + Math.random() * 3.5;
    }
    this.applyFace();

    // 走路
    let moving = false;
    if (this.path.length) {
      const target = this.path[0]!;
      const pos = this.root.position;
      const dx = target.x - pos.x;
      const dz = target.z - pos.z;
      const dist = Math.hypot(dx, dz);
      const step = this.speed * dt;
      if (dist <= step) {
        pos.set(target.x, 0, target.z);
        this.path.shift();
        if (!this.path.length) {
          const cb = this.onArrive;
          this.onArrive = null;
          cb?.();
        }
      } else {
        pos.x += (dx / dist) * step;
        pos.z += (dz / dist) * step;
        const want = Math.atan2(dx, dz);
        let diff = want - this.root.rotation.y;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        this.root.rotation.y += diff * Math.min(1, dt * 12);
        moving = true;
      }
    }

    const [legA, legB] = this.legs;
    const [armA, armB] = this.arms;
    const hop = t < this.hopUntil ? Math.abs(Math.sin(((this.hopUntil - t) / 0.7) * Math.PI * 2)) * 0.16 : 0;
    this.body.rotation.set(0, 0, 0);
    this.head.rotation.set(0, 0, 0);
    if (this.pose === 'sit') {
      this.body.position.y = this.seatH - HIP * H + Math.sin(t * 2) * 0.006;
      legA!.rotation.set(-Math.PI / 2 + 0.12 + Math.sin(t * 3) * 0.06, 0, 0);
      legB!.rotation.set(-Math.PI / 2 + 0.12 - Math.sin(t * 3) * 0.06, 0, 0);
      armA!.rotation.set(-0.5, 0, -0.2);
      armB!.rotation.set(-0.5, 0, 0.2);
      this.head.rotation.z = Math.sin(t * 0.9) * 0.05;
    } else if (this.pose === 'lie') {
      this.body.position.y = this.seatH + 0.2;
      this.body.position.z = 0;
      this.body.rotation.x = -Math.PI / 2;
      legA!.rotation.set(0, 0, 0.05);
      legB!.rotation.set(0, 0, -0.05);
      armA!.rotation.set(0, 0, -0.3);
      armB!.rotation.set(0, 0, 0.3);
    } else if (moving) {
      const s = Math.sin(t * 11);
      this.body.position.y = Math.abs(Math.cos(t * 11)) * 0.04;
      legA!.rotation.set(s * 0.6 * this.stride, 0, 0);
      legB!.rotation.set(-s * 0.6 * this.stride, 0, 0);
      armA!.rotation.set(-s * 0.7, 0, -0.14);
      armB!.rotation.set(s * 0.7, 0, 0.14);
    } else {
      this.body.position.y = Math.sin(t * 2.2) * 0.012 + hop;
      legA!.rotation.set(0, 0, 0);
      legB!.rotation.set(0, 0, 0);
      armA!.rotation.set(Math.sin(t * 2.2) * 0.05, 0, -0.14 - Math.sin(t * 2.2) * 0.03);
      armB!.rotation.set(-Math.sin(t * 2.2) * 0.05, 0, 0.14 + Math.sin(t * 2.2) * 0.03);
      this.head.rotation.z = Math.sin(t * 1.1) * 0.04;
    }
    if (this.longSkirt) this.longSkirt.scale.y = this.pose === 'sit' ? 0.35 : 1;
    if (this.spoon) this.spoon.visible = !moving && (this.activity === 'eat' || this.activity === 'cook');
    if (!moving && this.activity === 'cook') {
      armA!.rotation.set(-0.95, 0, -0.2);
      armB!.rotation.set(-1.15 + Math.sin(t * 3) * 0.18, Math.cos(t * 3) * 0.2, 0.16);
      this.head.rotation.x = 0.12;
    } else if (!moving && this.activity === 'eat') {
      armA!.rotation.set(-1.05, 0, -0.2);
      armB!.rotation.set(-1.5 - Math.sin(t * 2.4) * 0.65, -0.25, 0.3);
      this.head.rotation.x = 0.08 + Math.sin(t * 2.4) * 0.04;
    } else if (!moving && this.activity === 'work') {
      armA!.rotation.set(-1.1 + Math.sin(t * 5) * 0.08, 0, -0.18);
      armB!.rotation.set(-1.1 - Math.sin(t * 5) * 0.08, 0, 0.18);
      this.head.rotation.x = 0.12;
    } else if (!moving && this.activity === 'bathe') {
      armA!.rotation.set(-0.35, 0, -0.7);
      armB!.rotation.set(-0.35, 0, 0.7);
    } else if (t < this.waveUntil && this.pose !== 'lie' && this.activity === 'idle') {
      armB!.rotation.set(0, 0, 2.5 + Math.sin(t * 12) * 0.35);
      this.head.rotation.z = -0.08;
    }
  }
}
