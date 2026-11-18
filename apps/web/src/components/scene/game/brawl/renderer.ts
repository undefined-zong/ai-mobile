import * as THREE from 'three';
import type { BrawlFighter } from '@app/shared';
import { Chibi } from '../decor/chibi';
import { seededAvatar } from '../decor/avatar';
import type { BrawlEngine, Effect, FighterState } from './engine';

/** 与小屋共用角色造型，独立的侧视擂台与战斗动作。资源只在进入大乱斗后加载。 */
export class BrawlRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-5.8, 5.8, 3.5, -3.5, .1, 100);
  private models: Chibi[] = [];
  private profileKeys: string[] = [];
  private fx = new Map<number, THREE.Group>();
  private shots = new Map<number, THREE.Group>();
  private clock = 0;
  private aspect = 1.85;
  private center = 0;
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor('#171e38');
    this.scene.fog = new THREE.Fog('#171e38', 15, 36);
    this.scene.add(new THREE.HemisphereLight('#e1e9ff', '#695c84', 2.6));
    const key = new THREE.DirectionalLight('#fff0db', 3.1); key.position.set(-3, 7, 5); this.scene.add(key);
    const rim = new THREE.DirectionalLight('#9bb9ff', 2); rim.position.set(5, 3, -4); this.scene.add(rim);
    this.camera.position.set(0, 3.8, 11); this.camera.lookAt(0, .7, 0);
    this.buildStage();
  }

  private box(x: number, y: number, z: number, w: number, h: number, d: number, color: string, emissive = false) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), emissive ? new THREE.MeshBasicMaterial({ color }) : new THREE.MeshStandardMaterial({ color, roughness: .85 }));
    mesh.position.set(x, y, z); this.scene.add(mesh); return mesh;
  }

  private buildStage() {
    this.box(0, -.24, 0, 11.6, .45, 3.7, '#394255');
    this.box(0, -.005, 0, 10.5, .02, 2.5, '#677583');
    for (const x of [-5.4, 5.4]) {
      this.box(x, .04, 0, .06, .06, 3.4, '#e9be7b', true);
      this.box(x, .4, -1.7, .14, 1, .14, '#a0a3b4');
    }
    this.box(0, .15, -1.7, 11, .08, .1, '#b6b3bd');
    this.box(0, .85, -1.7, 11, .06, .08, '#b6b3bd');
    for (let i = -4; i <= 4; i++) this.box(i * 1.1, .46, -1.7, .045, .75, .045, '#828ba1');
    this.box(0, -.2, 1.88, 11.4, .055, .02, '#f1ba72', true);
    // 远处屋顶的轮廓与窗灯，用固定布局避免每次重开场地跳变。
    for (let i = 0; i < 22; i++) {
      const x = (i - 10.5) * 1.1, h = 1.2 + ((i * 7) % 11) / 3;
      this.box(x, h / 2 - .7, -7 - (i % 3) * 2, .8 + (i % 3) * .2, h, 1, i % 2 ? '#252e4a' : '#303650');
      for (let j = 0; j < 3; j++) this.box(x + .16, .15 + j * .62, -6.46 - (i % 3) * 2, .12, .2, .02, (i + j) % 3 ? '#647590' : '#bba58c', true);
    }
    const moon = new THREE.Mesh(new THREE.SphereGeometry(.55, 32, 24), new THREE.MeshBasicMaterial({ color: '#f1ddbd' }));
    moon.position.set(4, 4.6, -12); this.scene.add(moon);
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.1, 1.13, 64), new THREE.MeshBasicMaterial({ color: '#b6c4cc', transparent: true, opacity: .45, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = .015; this.scene.add(ring);
    const points = new Float32Array(160 * 3);
    for (let i = 0; i < 160; i++) { points[i * 3] = Math.sin(i * 31.1) * 20; points[i * 3 + 1] = 2 + (i % 23) * .4; points[i * 3 + 2] = -15 - i % 10; }
    const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
    this.scene.add(new THREE.Points(geometry, new THREE.PointsMaterial({ color: '#b7c8eb', size: .025, transparent: true, opacity: .7 })));
  }

  setFighters(profiles: BrawlFighter[]) {
    profiles.forEach((p, i) => {
      const key = JSON.stringify([p.look, p.id]);
      if (key === this.profileKeys[i]) return;
      this.profileKeys[i] = key;
      if (this.models[i]) { this.scene.remove(this.models[i]!.root); this.models[i]!.dispose(); }
      const avatar = { ...seededAvatar(p.id), hair: p.look.hair, hairColor: p.look.hairColor, hairColor2: '', skin: p.look.skin, topColor: p.look.outfit, suit: 'none', top: 'hoodie', bottom: 'pants', bottomColor: '#293249', shoesColor: '#e7e1d5', acc: [], head: .9, height: 1.12, eyes: 'round', blush: false, topPattern: 'plain', bottomPattern: 'plain' };
      const model = new Chibi(avatar, i === 0 ? 'you' : 'her');
      this.models[i] = model; this.scene.add(model.root);
    });
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.aspect = width / height;
  }

  screenPoint(x: number, y: number) {
    const point = new THREE.Vector3(x / 100 - 5, y / 100, .3).project(this.camera);
    return { x: (point.x + 1) * 50, y: (1 - point.y) * 50 };
  }

  private pose(model: Chibi, f: FighterState, dt: number, index: number) {
    model.update(dt);
    model.root.position.set(f.x / 100 - 5, f.y / 100, 0);
    model.root.rotation.y = f.facing * 1.05;
    const a = f.attack;
    const action = f.hp <= 0 ? 'down' : f.stun > 0 ? 'hurt' : a ? a.skill.kind === 'strike' || a.skill.kind === 'dash' ? 'strike' : 'cast' : f.guard ? 'guard' : f.y > 0 ? 'jump' : f.moving || f.dash > 0 ? 'run' : 'idle';
    model.battlePose(action, this.clock + index, a ? a.elapsed / (a.skill.windup + a.skill.recovery) : 0);
    model.root.visible = f.invulnerable <= 0 || Math.floor(this.clock * 28) % 2 === 0 || this.reducedMotion;
  }

  private energy(color: string, size: number) {
    const group = new THREE.Group();
    const core = new THREE.Mesh(new THREE.SphereGeometry(.12, 12, 8), new THREE.MeshBasicMaterial({ color: '#fff4dc', transparent: true }));
    const halo = new THREE.Mesh(new THREE.TorusGeometry(.22, .035, 8, 32), new THREE.MeshBasicMaterial({ color, transparent: true }));
    group.add(core, halo); group.scale.setScalar(size); return group;
  }

  private effectMesh(effect: Effect) {
    const group = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ color: effect.color, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const radius = effect.size / 200;
    group.add(new THREE.Mesh(new THREE.RingGeometry(radius * .75, radius, 40, 1, effect.kind === 'cast' ? -.8 : 0, effect.kind === 'cast' ? Math.PI * 1.2 : Math.PI * 2), mat));
    if (effect.kind === 'hit' || effect.kind === 'burst') {
      for (let i = 0; i < 8; i++) {
        const shard = new THREE.Mesh(new THREE.BoxGeometry(.045, radius * .6, .025), mat);
        const angle = i * Math.PI / 4;
        shard.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, .05); shard.rotation.z = angle - Math.PI / 2;
        group.add(shard);
      }
    }
    group.position.set(effect.x / 100 - 5, effect.y / 100, .3); return group;
  }

  private remove(map: Map<number, THREE.Group>, id: number) {
    const group = map.get(id)!; this.scene.remove(group);
    group.traverse(o => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); for (const mat of Array.isArray(o.material) ? o.material : [o.material]) mat.dispose(); } });
    map.delete(id);
  }

  draw(engine: BrawlEngine, dt: number) {
    this.clock += dt;
    this.setFighters(engine.fighters.map(f => f.profile));
    engine.fighters.forEach((f, i) => this.pose(this.models[i]!, f, dt, i));
    for (const p of engine.projectiles) {
      if (!this.shots.has(p.id)) { const group = this.energy(engine.fighters[p.owner].profile.color, .8 + p.skill.damage / 200); this.shots.set(p.id, group); this.scene.add(group); }
      const group = this.shots.get(p.id)!; group.position.set(p.x / 100 - 5, p.y / 100, .15); group.rotation.z = this.clock * 9;
    }
    for (const id of this.shots.keys()) if (!engine.projectiles.some(p => p.id === id)) this.remove(this.shots, id);
    for (const e of engine.effects) {
      if (!this.fx.has(e.id)) { const group = this.effectMesh(e); this.fx.set(e.id, group); this.scene.add(group); }
      const group = this.fx.get(e.id)!, progress = e.age / e.life;
      group.scale.setScalar(.6 + progress * 1.2);
      group.traverse(o => { if (o instanceof THREE.Mesh) (o.material as THREE.MeshBasicMaterial).opacity = 1 - progress; });
    }
    for (const id of this.fx.keys()) if (!engine.effects.some(e => e.id === id)) this.remove(this.fx, id);
    // 窄屏跟随双方位置，近身时推近；横屏保留完整场地。
    const [a, b] = engine.fighters;
    const halfWidth = this.aspect < 1.4 ? Math.max(3.25, Math.min(5.8, Math.abs(a.x - b.x) / 200 + 1.6)) : 5.8;
    const center = Math.max(halfWidth - 5.8, Math.min(5.8 - halfWidth, (a.x + b.x) / 200 - 5));
    this.center += (center - this.center) * Math.min(1, dt * 9);
    this.camera.left = -halfWidth; this.camera.right = halfWidth;
    this.camera.top = halfWidth / this.aspect; this.camera.bottom = -halfWidth / this.aspect;
    this.camera.updateProjectionMatrix();
    const shake = this.reducedMotion ? 0 : engine.shake / 170;
    this.camera.position.x = this.center + Math.sin(this.clock * 130) * shake;
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.models.forEach(m => { this.scene.remove(m.root); m.dispose(); });
    this.scene.traverse(o => { if (o instanceof THREE.Mesh || o instanceof THREE.Points) { o.geometry.dispose(); for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose(); } });
    this.renderer.dispose();
  }
}
