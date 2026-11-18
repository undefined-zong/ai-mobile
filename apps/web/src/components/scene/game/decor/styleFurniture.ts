import * as THREE from 'three';
import { ball, box, cyl, disc, group, legs, mesh, ring, screen } from './primitives';
import { shade } from './textures';
import { HOME_BUILDERS } from './homeFurniture';

const wood = { surface: 'wood' as const };
const cloth = { surface: 'fabric' as const };
const metal = { surface: 'metal' as const };
const brass = '#ba955e';
const dark = '#26323b';
const paper = '#eee6d3';
const cyan = '#79dce0';

function frame(w: number, h: number, c: string, depth = .12) {
  return group(
    box(w, .06, depth, c, [0, -h / 2, depth / 2], .01, wood),
    box(w, .06, depth, c, [0, h / 2 - .06, depth / 2], .01, wood),
    box(.06, h, depth, c, [-w / 2 + .03, -h / 2, depth / 2], .01, wood),
    box(.06, h, depth, c, [w / 2 - .03, -h / 2, depth / 2], .01, wood),
  );
}

function circuit(w: number, h: number, color: string) {
  const g = group(box(w, h, .025, '#152c40', [0, 0, 0], .025, metal));
  for (let i = 0; i < 5; i++) {
    const y = h * (.18 + i * .14);
    g.add(screen(w * (.28 + (i % 3) * .13), .008, [-w * .12, y, .016], color));
    g.add(box(.028, .028, .012, i % 2 ? '#eab576' : color, [w * .35, y, .022], .005, { glow: color }));
  }
  const orbit = ring(h * .25, .009, color, [-w * .3, h * .55, .024], true);
  g.add(orbit);
  return g;
}

export const STYLE_BUILDERS: Record<string, (c: string) => THREE.Group> = {
  ...HOME_BUILDERS,
  modularSofa: (c) => {
    const g = group(box(2.86, .2, .86, shade(c, -.14), [0, .06, 0], .06, cloth));
    for (const x of [-.94, 0, .94]) {
      g.add(box(.92, .14, .7, c, [x, .23, .04], .08, cloth));
      g.add(box(.92, .48, .23, c, [x, .33, -.33], .09, cloth));
      g.add(box(.7, .012, .008, shade(c, -.12), [x, .37, .383], .002, cloth));
    }
    g.add(box(.25, .26, .82, c, [-1.3, .26, .02], .08, cloth), box(.25, .26, .82, c, [1.3, .26, .02], .08, cloth));
    const pillow = box(.36, .31, .15, '#b48669', [-.85, .37, -.15], .07, cloth);
    pillow.rotation.z = -.15;
    g.add(pillow, box(.4, .025, .65, '#8b9b8a', [.8, .38, .08], .015, cloth), box(.4, .2, .03, '#8b9b8a', [.8, .2, .4], .015, cloth));
    return g;
  },
  stoneTable: (c) => {
    const g = group(cyl(.22, .26, .29, shade(c, -.1), [-.55, 0, 0], 28, { surface: 'ceramic' }), cyl(.22, .26, .29, shade(c, -.1), [.55, 0, 0], 28, { surface: 'ceramic' }), box(1.94, .07, .94, c, [0, .29, 0], .035, { surface: 'ceramic' }));
    for (let i = 0; i < 10; i++) g.add(box(.08 + i % 3 * .025, .001, .009, shade(c, -.13), [-.8 + i * .17, .361, Math.sin(i * 5) * .32], 0));
    return g;
  },
  arcLamp: (c) => {
    const path = new THREE.CatmullRomCurve3([new THREE.Vector3(-.27, .05, 0), new THREE.Vector3(-.27, 1.45, 0), new THREE.Vector3(-.13, 1.83, 0), new THREE.Vector3(.27, 1.75, 0)]);
    const bulb = ball(.12, '#fff0ca', [.27, 1.65, 0], [1, .6, 1], { glow: '#ffe2a4' });
    bulb.userData.lamp = true;
    return group(cyl(.22, .25, .05, dark, [-.27, 0, 0]), mesh(new THREE.TubeGeometry(path, 24, .018, 8, false), brass, [0, 0, 0], metal), cyl(.13, .22, .15, c, [.27, 1.65, 0], 28, metal), bulb);
  },
  slatPanel: (c) => {
    const g = group(box(1.98, 1.8, .025, shade(c, -.25), [0, -.9, .012], 0, wood));
    for (let i = 0; i < 20; i++) g.add(box(.055, 1.8, .09, c, [-.95 + i * .1, -.9, .055], .005, wood));
    return g;
  },
  kotatsu: (c) => {
    const g = group(box(1.9, .07, 1.4, c, [0, .03, 0], .06, cloth), box(1.58, .26, 1.08, c, [0, .1, 0], .1, cloth), box(1.8, .06, 1.28, '#8b6549', [0, .36, 0], .025, wood));
    for (const x of [-.75, -.5, -.25, 0, .25, .5, .75]) g.add(box(.045, .006, 1.27, shade(c, .15), [x, .106, 0], .008, cloth));
    for (const z of [-.61, .61]) g.add(box(1.7, .025, .035, shade(c, -.15), [0, .1, z], .006, cloth));
    return g;
  },
  futon: (c) => group(
    box(1.9, .055, 1.94, '#b1ac7a', [0, .015, 0], .02, cloth),
    box(1.8, .12, 1.85, paper, [0, .07, 0], .06, cloth),
    box(1.83, .1, 1.22, c, [0, .17, .27], .06, cloth),
    box(1.8, .03, .19, shade(c, -.12), [0, .25, -.25], .01, cloth),
    box(.65, .09, .35, '#f8f2e5', [-.46, .19, -.62], .06, cloth),
    box(.65, .09, .35, '#f8f2e5', [.46, .19, -.62], .06, cloth),
  ),
  hinokiBath: (c) => {
    const g = group(box(1.88, .15, 1.88, shade(c, -.15), [0, 0, 0], .06, wood), box(1.62, .02, 1.62, '#91c6bc', [0, .39, 0], .06, { surface: 'ceramic' }));
    for (const x of [-.88, .88]) g.add(box(.16, .55, 1.9, c, [x, .1, 0], .035, wood));
    for (const z of [-.88, .88]) g.add(box(1.9, .55, .16, c, [0, .1, z], .035, wood));
    for (let i = 0; i < 13; i++) {
      g.add(box(.012, .46, .006, shade(c, -.2), [-.82 + i * .137, .12, .963], 0));
      g.add(box(.006, .46, .012, shade(c, -.2), [.963, .12, -.82 + i * .137], 0));
    }
    g.add(ring(.27, .008, '#c6e5d9', [0, .415, 0]), ring(.4, .006, '#beded3', [0, .415, 0]));
    g.add(box(.43, .045, .7, '#ddc6a1', [.48, .65, 0], .015, wood), box(.28, .055, .32, '#f7f1e4', [.48, .7, .1], .02, cloth));
    return g;
  },
  shoji: (c) => {
    const g = frame(2, 1.8, c);
    g.add(box(1.9, 1.68, .02, '#e9e2ce', [0, -.84, .035], .002));
    for (let i = -4; i <= 4; i++) g.add(box(.025, 1.7, .06, c, [i * .22, -.85, .08], .003, wood));
    for (let i = -3; i <= 3; i++) g.add(box(1.9, .022, .06, c, [0, i * .22, .08], .003, wood));
    g.add(box(.05, 1.72, .08, c, [0, -.86, .11], .004, wood), disc(.03, .01, dark, [.09, -.1, .15]));
    return g;
  },
  paperLantern: (c) => {
    const light = box(.38, .83, .38, c, [0, .22, 0], .04, { glow: '#ffe4ab' });
    light.userData.lamp = true;
    const g = group(cyl(.25, .29, .06, '#715640'), light, box(.48, .05, .48, '#715640', [0, 1.06, 0], .025, wood));
    for (let i = 0; i < 13; i++) g.add(box(.4, .009, .4, '#c2ae8a', [0, .25 + i * .063, 0], .02));
    for (const x of [-.2, .2]) for (const z of [-.2, .2]) g.add(box(.025, 1.06, .025, '#715640', [x, .06, z], .004, wood));
    return g;
  },
  labBench: (c) => {
    const g = group(box(1.94, .075, .94, '#343c3b', [0, .725, 0], .025, { surface: 'ceramic' }), box(.6, .65, .82, c, [-.6, .07, 0], .025, metal), ...legs(1.8, .8, .73, .032, '#6a7374'));
    for (let i = 0; i < 3; i++) g.add(box(.54, .18, .025, shade(c, .06), [-.6, .1 + i * .2, .425], .01, metal), box(.18, .018, .04, brass, [-.6, .22 + i * .2, .448], .005));
    g.add(box(1.8, .07, .045, '#535d59', [0, .8, -.42], .01));
    return g;
  },
  specimenCabinet: (c) => {
    const g = group(box(.89, 1.8, .12, c, [0, .05, -.38], .02, wood), box(.93, .09, .8, c, [0, 1.75, 0], .02, wood));
    for (const x of [-.42, .42]) g.add(box(.08, 1.75, .8, c, [x, .05, 0], .01, wood));
    for (let row = 0; row < 4; row++) {
      const y = .1 + row * .4;
      g.add(box(.86, .045, .78, c, [0, y, 0], .008, wood));
      for (let i = -1; i <= 1; i++) {
        const x = i * .24;
        g.add(cyl(.07, .075, .23, ['#8ba99c', '#d3b785', '#96afc6'][(i + row + 4) % 3]!, [x, y + .045, -.04], 16, { surface: 'ceramic' }));
        g.add(cyl(.075, .075, .025, brass, [x, y + .275, -.04], 16), box(.085, .06, .005, paper, [x, y + .13, .034], 0));
      }
    }
    g.add(box(.03, 1.66, .035, brass, [0, .13, .4], .005));
    return g;
  },
  microscope: (c) => {
    const arm = box(.045, .23, .06, c, [.035, .09, -.065], .02, metal);
    arm.rotation.z = -.28;
    const tube = cyl(.026, .032, .14, dark, [-.04, .27, .035], 12, metal);
    tube.rotation.z = -.35;
    return group(box(.27, .035, .3, c, [0, 0, 0], .025, metal), arm, tube, box(.18, .025, .14, dark, [0, .17, .04], .006), cyl(.024, .027, .07, brass, [-.03, .23, .05], 12), disc(.038, .018, dark, [.07, .22, -.06]));
  },
  researchBoard: (c) => {
    const g = frame(2, 1.15, c, .08);
    g.add(box(1.88, 1.03, .025, '#244d43', [0, -.515, .035], .002));
    for (let i = 0; i < 5; i++) g.add(box(.45 + i % 3 * .14, .008, .006, '#d5debf', [-.43, .32 - i * .14, .055], 0));
    g.add(ring(.23, .008, '#d5debf', [.49, .02, .06], true), ring(.1, .007, '#d5debf', [.49, .02, .06], true), box(.64, .008, .008, '#d5debf', [.49, .02, .06], 0));
    const orbit = ring(.32, .006, '#d5debf', [.49, .02, .063], true);
    orbit.scale.y = .5;
    orbit.rotation.z = .6;
    g.add(orbit, box(1.8, .035, .12, c, [0, -.58, .08], .005, wood));
    return g;
  },
  labStool: (c) => group(cyl(.28, .28, .07, c, [0, .43, 0], 28, cloth), cyl(.035, .04, .43, '#65706e', [0, 0, 0], 12, metal), ring(.22, .015, brass, [0, .2, 0]), ...legs(.55, .55, .18, .022, dark)),
  trainBench: (c) => {
    const g = group(box(1.94, .24, .9, '#6b4d3c', [0, .08, 0], .035, wood), box(1.82, .12, .78, c, [0, .3, .04], .07, cloth), box(1.92, .68, .21, c, [0, .36, -.34], .07, cloth));
    for (let i = 0; i < 9; i++) g.add(box(.012, .49, .012, shade(c, -.16), [-.8 + i * .2, .47, -.229], .004, cloth), ball(.015, brass, [-.8 + i * .2, .72, -.215]));
    for (const x of [-.94, .94]) g.add(box(.06, .56, .75, '#78543c', [x, .1, .02], .02, wood), box(.075, .035, .77, brass, [x, .64, .02], .012));
    return g;
  },
  carriageTable: (c) => group(box(.94, .055, .94, c, [0, .595, 0], .027, wood), box(.88, .005, .88, paper, [0, .65, 0], .02), cyl(.045, .065, .6, brass, [0, 0, 0], 16), cyl(.32, .35, .05, '#594a3c', [0, 0, 0])),
  trainWindow: (c) => {
    const g = frame(2.5, 1.2, c, .15);
    g.add(box(2.36, 1.06, .025, '#b9d8dc', [0, -.53, .025], .01));
    // Layered scenery stays inside the window aperture, with real depth between hills.
    for (let layer = 0; layer < 3; layer++) {
      const shape = new THREE.Shape();
      shape.moveTo(-1.17, -.52);
      shape.lineTo(-1.17, -.05 - layer * .1);
      for (let i = 0; i <= 8; i++) shape.lineTo(-1.17 + i * .2925, -.07 - layer * .12 + Math.sin(i * 1.8 + layer) * (.17 - layer * .04));
      shape.lineTo(1.17, -.52);
      shape.closePath();
      g.add(mesh(new THREE.ShapeGeometry(shape), ['#8aabb2', '#72968d', '#527e6b'][layer]!, [0, 0, .045 + layer * .012], { cast: false }));
    }
    g.add(disc(.085, .006, '#f3dfb0', [.72, .32, .05]), box(.04, 1.1, .12, brass, [0, -.55, .11], .004), box(2.5, .07, .2, '#76553e', [0, -.64, .1], .015, wood));
    for (const x of [-1.16, 1.16]) for (let i = 0; i < 3; i++) g.add(box(.09, 1.1, .09, '#cfb992', [x + (i - 1) * .035, -.55, .17], .03, cloth));
    return g;
  },
  luggageRack: (c) => {
    const g = group(box(1.46, .035, .43, brass, [0, -.22, .22], .008));
    for (let i = 0; i < 8; i++) g.add(box(.025, .025, .44, c, [-.68 + i * .195, -.18, .22], .006, wood));
    for (const x of [-.68, .68]) g.add(box(.025, .34, .025, brass, [x, -.22, .04], .005), box(.025, .12, .025, brass, [x, -.22, .42], .005));
    g.add(box(1.4, .025, .025, brass, [0, -.1, .42], .005), box(.7, .23, .34, '#855e43', [-.25, -.15, .22], .04, cloth), box(.3, .18, .31, '#4b655f', [.32, -.15, .22], .025, cloth));
    return g;
  },
  suitcase: (c) => {
    const g = group(box(.78, .53, .46, c, [0, .04, 0], .045, cloth), box(.82, .018, .48, shade(c, -.2), [0, .28, 0], .005));
    for (const x of [-.25, .25]) g.add(box(.055, .52, .012, '#b39364', [x, .04, .238], .007), box(.055, .018, .45, '#b39364', [x, .57, 0], .005), box(.08, .06, .015, brass, [x, .27, .247], .01));
    g.add(box(.21, .035, .05, '#4c3b31', [0, .59, 0], .015));
    return g;
  },
  cyberConsole: (c) => {
    const g = group(box(1.92, .11, .92, c, [0, .54, 0], .04, metal), box(.34, .54, .65, shade(c, -.12), [-.65, 0, 0], .04, metal), box(.34, .54, .65, shade(c, -.12), [.65, 0, 0], .04, metal));
    for (const x of [-.53, .53]) {
      const panel = circuit(.88, .51, x < 0 ? cyan : '#b29af5');
      panel.position.set(x, .71, -.29);
      panel.rotation.y = -x * .22;
      g.add(panel, box(.035, .16, .04, brass, [x, .62, -.3], .006));
    }
    for (let row = 0; row < 3; row++) for (let i = 0; i < 9; i++) g.add(box(.065, .012, .055, i === 8 ? cyan : '#82919d', [-.55 + i * .09, .655, .09 + row * .085], .008, { glow: i === 8 ? cyan : undefined }));
    g.add(screen(1.7, .018, [0, .57, .469], cyan));
    return g;
  },
  serverRack: (c) => {
    const g = group(box(.9, 1.9, .8, c, [0, .03, 0], .04, metal), box(.75, 1.72, .02, '#141f2c', [0, .12, .406], .01, metal));
    for (let row = 0; row < 7; row++) {
      const y = .19 + row * .23;
      g.add(box(.65, .18, .03, shade(c, .04), [0, y, .43], .01, metal));
      for (let i = 0; i < 5; i++) g.add(box(.055, .006, .006, '#9babb2', [-.23 + i * .075, y + .09, .45], 0));
      g.add(screen(.04, .018, [.26, y + .09, .45], row % 3 ? cyan : '#dd9bc7'));
    }
    const strip = screen(.016, 1.65, [-.39, .15, .45], cyan);
    strip.userData.lamp = true;
    g.add(strip);
    return g;
  },
  capsuleBed: (c) => {
    const g = group(box(.95, .22, 1.92, c, [0, .08, 0], .07, metal), box(.82, .1, 1.68, '#8e9ead', [0, .3, .04], .05, cloth), box(.64, .1, .35, '#c6ced6', [0, .4, -.57], .05, cloth), box(.92, 1.05, .14, c, [0, .27, -.84], .05, metal), box(.96, .12, .64, c, [0, 1.22, -.59], .055, metal));
    for (const x of [-.43, .43]) g.add(box(.08, .43, 1.75, c, [x, .26, .03], .03, metal), box(.012, .024, 1.65, cyan, [x + Math.sign(x) * .046, .53, .03], .005, { glow: cyan }));
    g.add(screen(.76, .025, [0, 1.22, -.26], cyan));
    return g;
  },
  pilotSeat: (c) => {
    const g = group(cyl(.31, .36, .06, dark), cyl(.055, .07, .32, brass, [0, .06, 0]), box(.65, .12, .65, c, [0, .34, .05], .06, cloth), box(.62, .7, .2, c, [0, .45, -.27], .07, cloth), box(.44, .2, .22, shade(c, .14), [0, .98, -.27], .065, cloth));
    for (const x of [-.37, .37]) g.add(box(.09, .06, .6, dark, [x, .63, .04], .025, metal), box(.025, .25, .04, brass, [x, .4, 0], .004), screen(.015, .44, [x * .7, .53, -.162], cyan));
    return g;
  },
  holoPanel: (c) => {
    const g = frame(1.5, 1, '#34465b', .09);
    const panel = circuit(1.35, .85, c);
    panel.position.set(0, -.425, .08);
    g.add(panel);
    const light = screen(1.3, .012, [0, -.46, .11], c);
    light.userData.lamp = true;
    g.add(light);
    return g;
  },
  neonStrip: (c) => {
    const light = box(1.92, .028, .025, c, [0, -.014, .075], .012, { glow: c });
    light.userData.lamp = true;
    return group(box(2, .1, .07, '#34465b', [0, -.05, .04], .015, metal), light);
  },
  radio: (c) => {
    const g = group(...legs(.7, .48, .19, .035, '#56483b'), box(.82, .74, .56, c, [0, .18, 0], .07, wood), box(.7, .42, .025, '#494a40', [0, .23, .287], .02, cloth));
    // Woven speaker grille, illuminated tuning scale and two physical dials.
    for (let i = 0; i < 16; i++) g.add(box(.009, .37, .005, '#a49776', [-.31 + i * .042, .25, .303], .002));
    for (let i = 0; i < 7; i++) g.add(box(.64, .006, .005, '#80765e', [0, .27 + i * .052, .308], .002));
    g.add(box(.68, .12, .016, '#263b3d', [0, .69, .294], .015));
    for (let i = 0; i < 15; i++) g.add(box(.009, i % 3 ? .025 : .042, .008, '#dbca99', [-.28 + i * .04, .728, .307], 0));
    g.add(box(.009, .07, .009, '#e2a475', [.08, .71, .314], 0));
    for (const x of [-.24, .24]) g.add(disc(.065, .045, brass, [x, .855, .31]), box(.008, .036, .004, '#554b3a', [x, .845, .335], .001));
    const indicator = ball(.014, '#6b806a', [0, .855, .31]);
    indicator.userData.radioIndicator = true;
    g.add(indicator, box(.24, .026, .018, '#dac9a5', [0, .95, 0], .009));
    return g;
  },
};
