import * as THREE from 'three';

export const LIGHTING = {
  morning: { label: '晨光', icon: 'i-lucide-sunrise', sky: '#d7e8f3', ground: '#baa99a', ambient: 1.55, key: '#fff1da', power: 2.5, fill: '#d6e7ff', fillPower: 0.7, exposure: 1.08, window: '#ffe4b7', windowPower: 12, skyTop: '#a6ccdf', skyBottom: '#fff0db', background: '#ede8df', glow: false },
  day: { label: '晴昼', icon: 'i-lucide-sun', sky: '#edf5ff', ground: '#c3b19e', ambient: 1.8, key: '#fff6e5', power: 2.8, fill: '#dcecff', fillPower: 0.75, exposure: 1.06, window: '#fff0cf', windowPower: 10, skyTop: '#8ec9e5', skyBottom: '#eff7f3', background: '#f0ece4', glow: false },
  sunset: { label: '落日', icon: 'i-lucide-sunset', sky: '#efe1db', ground: '#b79e9b', ambient: 1.3, key: '#ffd4a1', power: 2.4, fill: '#c9d7f2', fillPower: 0.75, exposure: 1.08, window: '#ffba70', windowPower: 22, skyTop: '#cbb5c9', skyBottom: '#ffddac', background: '#ede0d5', glow: true },
  night: { label: '晚灯', icon: 'i-lucide-moon', sky: '#b5c4e9', ground: '#80798d', ambient: 1.15, key: '#c9d9ff', power: 0.85, fill: '#bec7e7', fillPower: 0.35, exposure: 1.13, window: '#adc9ff', windowPower: 2.5, skyTop: '#283a62', skyBottom: '#879bb5', background: '#292f43', glow: true },
} as const;
export type LightingMode = keyof typeof LIGHTING;

/** One sky map and one shadowed window projector per room, also on phones. */
export class RoomAmbience {
  readonly window = new THREE.SpotLight('#fff0cf', 10, 10, 0.53, 0.45, 1.3);
  readonly sky: THREE.MeshBasicMaterial;
  private skyCanvas = document.createElement('canvas');
  private skyMap: THREE.CanvasTexture;
  private aperture: THREE.CanvasTexture;

  constructor(scene: THREE.Scene) {
    this.skyCanvas.width = 256;
    this.skyCanvas.height = 192;
    this.skyMap = new THREE.CanvasTexture(this.skyCanvas);
    this.skyMap.colorSpace = THREE.SRGBColorSpace;
    this.sky = new THREE.MeshBasicMaterial({ map: this.skyMap, toneMapped: false });
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 128, 128);
    ctx.filter = 'blur(2px)';
    ctx.fillStyle = '#fff';
    for (const x of [22, 67]) for (const y of [22, 67]) ctx.fillRect(x, y, 39, 39);
    this.aperture = new THREE.CanvasTexture(canvas);
    this.window.map = this.aperture;
    this.window.castShadow = true;
    this.window.shadow.mapSize.set(512, 512);
    this.window.shadow.bias = -0.00015;
    this.window.shadow.normalBias = 0.012;
    this.window.shadow.radius = 3;
    this.window.shadow.camera.near = 0.1;
    this.window.visible = false;
    scene.add(this.window, this.window.target);
    this.setLighting('day');
  }

  setLighting(mode: LightingMode) {
    const p = LIGHTING[mode];
    this.window.color.set(p.window);
    this.window.intensity = p.windowPower;
    const ctx = this.skyCanvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 0, 192);
    gradient.addColorStop(0, p.skyTop);
    gradient.addColorStop(1, p.skyBottom);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 256, 192);
    ctx.fillStyle = mode === 'night' ? '#fff5d6' : '#fff3d8';
    ctx.beginPath();
    ctx.arc(192, mode === 'sunset' ? 123 : 47, mode === 'night' ? 12 : 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = mode === 'night' ? '#fff6e1' : 'rgba(255,255,255,.5)';
    for (let i = 0; i < 7; i++) {
      ctx.beginPath();
      ctx.ellipse((i * 73 + 31) % 256, (i * 29 + 28) % 115, mode === 'night' ? 1.2 : 28, mode === 'night' ? 1.2 : 5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Quiet silhouettes give the window depth without an external panorama.
    for (let layer = 0; layer < 2; layer++) {
      ctx.fillStyle = mode === 'night' ? ['#536b7a', '#3c5566'][layer]! : ['#abc1ad', '#7c9e91'][layer]!;
      ctx.beginPath();
      ctx.moveTo(0, 192);
      for (let x = 0; x <= 256; x += 4) ctx.lineTo(x, 161 + layer * 14 + Math.sin(x * 0.019 + layer * 2) * 13 + Math.sin(x * 0.047) * 5);
      ctx.lineTo(256, 192);
      ctx.fill();
    }
    this.skyMap.needsUpdate = true;
  }

  placeWindow(object: THREE.Object3D | undefined, sunset: boolean) {
    this.window.visible = !!object;
    if (!object) return;
    object.updateWorldMatrix(true, false);
    this.window.position.copy(object.localToWorld(new THREE.Vector3(-0.2, 0.25, 0.26)));
    this.window.target.position.copy(object.localToWorld(new THREE.Vector3(sunset ? 1.6 : 0.7, -1.45, sunset ? 3.6 : 2.2)));
    this.window.target.updateMatrixWorld();
    this.window.shadow.needsUpdate = true;
  }

  dispose() {
    this.window.removeFromParent();
    this.window.target.removeFromParent();
    this.window.dispose();
    this.sky.dispose();
    this.skyMap.dispose();
    this.aperture.dispose();
  }
}
