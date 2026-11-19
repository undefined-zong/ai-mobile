import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Avatar } from './avatar';
import { Chibi } from './chibi';
import { figureMaterial } from './avatarSculpt';
import settings from './avatar-data/studio.json';

export type StudioView = 'body' | 'face' | 'clothes';

/** The editor and its option thumbnails share one renderer and the real in-room figure. */
export class ChibiStudio {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 30);
  private controls: OrbitControls;
  private chibi: Chibi;
  private stage: THREE.Mesh;
  private raf = 0;
  private last = 0;
  private resizeObs: ResizeObserver;
  private view: StudioView = 'body';
  private reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  private thumbnailTarget: THREE.WebGLRenderTarget;
  private thumbnailCanvas = document.createElement('canvas');

  constructor(private canvas: HTMLCanvasElement, avatar: Avatar) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    const light = settings.lighting;
    const hemi = new THREE.HemisphereLight(light.sky, light.ground, light.ambient);
    const key = new THREE.DirectionalLight(light.key, light.keyIntensity);
    key.position.fromArray(light.keyPosition);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    Object.assign(key.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 0.1, far: 15 });
    key.shadow.bias = -0.001;
    key.shadow.normalBias = 0.02;
    const fill = new THREE.DirectionalLight(light.fill, light.fillIntensity);
    fill.position.fromArray(light.fillPosition);
    const rim = new THREE.DirectionalLight(light.rim, light.rimIntensity);
    rim.position.fromArray(light.rimPosition);
    this.scene.add(hemi, key, fill, rim);
    this.stage = new THREE.Mesh(new THREE.CylinderGeometry(0.56, 0.58, 0.045, 64), figureMaterial(light.platform));
    this.stage.position.y = -0.025;
    this.stage.receiveShadow = true;
    this.scene.add(this.stage);
    this.chibi = new Chibi(avatar, 'you');
    this.scene.add(this.chibi.root);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.enableDamping = true;
    this.controls.minPolarAngle = 1.15;
    this.controls.maxPolarAngle = 1.65;
    this.setView('body');
    const size = settings.thumbnailSize;
    this.thumbnailTarget = new THREE.WebGLRenderTarget(size, size, { samples: 4 });
    this.thumbnailTarget.texture.colorSpace = THREE.SRGBColorSpace;
    this.thumbnailCanvas.width = this.thumbnailCanvas.height = size;
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(canvas.parentElement ?? canvas);
    this.resize();
    this.last = performance.now();
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      if (!document.hidden) {
        if (!this.reducedMotion.matches) this.chibi.update(dt);
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
      }
    };
    this.raf = requestAnimationFrame(loop);
  }

  setAvatar(avatar: Avatar) {
    this.chibi.setAvatar(avatar);
    this.resize();
  }

  setView(view: StudioView) {
    this.view = view;
    this.front();
    this.resize();
  }

  front() {
    const target = settings.framing[this.view].target;
    this.controls.target.set(0, target, 0);
    this.camera.position.set(0, target + 0.16, 5);
    this.controls.update();
  }

  turn() {
    const offset = this.camera.position.clone().sub(this.controls.target);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 4);
    this.camera.position.copy(this.controls.target).add(offset);
    this.controls.update();
  }

  wave() {
    if (this.reducedMotion.matches) return;
    this.chibi.wave(1.8);
  }

  thumbnail(avatar: Avatar, view: StudioView = 'body'): string {
    const figure = new Chibi(avatar, 'you');
    const size = settings.thumbnailSize;
    const height = settings.framing.thumbnail[view];
    const camera = new THREE.OrthographicCamera(-height / 2, height / 2, height / 2, -height / 2, 0.1, 30);
    const target = view === 'face' ? settings.figure.neckHeight * avatar.height + settings.figure.headRadius * avatar.head : settings.framing[view].target;
    camera.position.set(view === 'body' ? 0.16 : 0, target + 0.12, 5);
    camera.lookAt(0, target, 0);
    const stageVisible = this.stage.visible;
    this.chibi.root.visible = false;
    this.stage.visible = false;
    this.scene.add(figure.root);
    const pixels = new Uint8Array(size * size * 4);
    this.renderer.setRenderTarget(this.thumbnailTarget);
    this.renderer.render(this.scene, camera);
    this.renderer.readRenderTargetPixels(this.thumbnailTarget, 0, 0, size, size, pixels);
    this.renderer.setRenderTarget(null);
    this.scene.remove(figure.root);
    figure.dispose();
    this.chibi.root.visible = true;
    this.stage.visible = stageVisible;
    const context = this.thumbnailCanvas.getContext('2d')!;
    const image = context.createImageData(size, size);
    for (let y = 0; y < size; y++) image.data.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), (size - y - 1) * size * 4);
    context.putImageData(image, 0, 0);
    return this.thumbnailCanvas.toDataURL();
  }

  private resize() {
    const el = this.canvas.parentElement ?? this.canvas;
    const width = Math.max(1, el.clientWidth), height = Math.max(1, el.clientHeight);
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    const scale = Math.max(this.chibi.avatar.head, this.chibi.avatar.height);
    const frame = settings.framing[this.view].height * scale;
    const figureWidth = new THREE.Box3().setFromObject(this.chibi.root).getSize(new THREE.Vector3()).x;
    const halfHeight = Math.max(frame, (figureWidth + settings.framing.horizontalPadding) / aspect) / 2;
    Object.assign(this.camera, { left: -halfHeight * aspect, right: halfHeight * aspect, top: halfHeight, bottom: -halfHeight });
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObs.disconnect();
    this.controls.dispose();
    this.chibi.dispose();
    this.stage.geometry.dispose();
    this.thumbnailTarget.dispose();
    this.scene.traverse((object) => { if (object instanceof THREE.DirectionalLight) object.shadow.dispose(); });
    this.renderer.dispose();
  }
}
