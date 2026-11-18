import * as THREE from 'three';
import { box, cyl, disc, group, legs, ring, screen } from './primitives';
import { shade } from './textures';

const wood = { surface: 'wood' as const };
const cloth = { surface: 'fabric' as const };
const metal = { surface: 'metal' as const };
const ceramic = { surface: 'ceramic' as const };
const brass = '#ba955e';
const steel = '#aab8b7';
const ink = '#283c3d';
const paper = '#ece7d9';
const cyan = '#79dce0';

function drawers(w: number, h: number, c: string, rows: number, z: number) {
  const g = group();
  for (let i = 0; i < rows; i++) {
    const y = .1 + i * h / rows;
    g.add(box(w - .1, h / rows - .025, .045, c, [0, y, z], .01, wood));
    g.add(box(w * .22, .025, .04, brass, [0, y + h / rows * .55, z + .035], .006, metal));
  }
  return g;
}

function faucet(x: number, y: number, z: number, color = steel) {
  return group(cyl(.022, .022, .22, color, [x, y, z], 12, metal), box(.045, .04, .18, color, [x, y + .18, z + .07], .01, metal));
}

function bowl(x: number, y: number, c = paper, r = .25) {
  return group(cyl(r, r * .75, .11, c, [x, y, .05], 28, ceramic), cyl(r * .85, r * .85, .015, '#a7b7b1', [x, y + .11, .05], 28, ceramic), faucet(x, y, -.26));
}

function kitchen(c: string, style: 'modern' | 'onsen' | 'railway' | 'cyber') {
  const isMetal = style === 'railway' || style === 'cyber';
  const finish = isMetal ? metal : wood;
  const top = style === 'onsen' ? '#a1855c' : isMetal ? '#a6b5b7' : '#e8dfcf';
  const g = group(box(1.92, .67, .87, c, [0, .07, 0], .035, finish), box(1.98, .06, .97, top, [0, .74, 0], .025, isMetal ? metal : ceramic));
  if (style === 'onsen') {
    for (let i = 0; i < 14; i++) g.add(box(.025, .55, .045, shade(c, -.15), [-.88 + i * .136, .15, .45], .004, wood));
    g.add(box(.58, .03, .56, ink, [-.5, .8, 0], .03, ceramic), cyl(.2, .18, .13, '#565b52', [-.5, .83, 0], 24, ceramic), cyl(.22, .22, .035, '#7b7c64', [-.5, .96, 0]));
  } else {
    g.add(box(.85, .45, .025, ink, [-.48, .2, .45], .03, metal), box(.71, .28, .018, '#52676c', [-.48, .27, .468], .02), box(.6, .035, .05, steel, [-.48, .63, .49], .008, metal));
    for (const x of [-.7, -.27]) {
      g.add(ring(.13, .013, ink, [x, .807, -.14]), ring(.13, .013, ink, [x, .807, .18]));
      g.add(disc(.033, .02, steel, [x, .7, .46]));
    }
    const ds = drawers(.83, .57, c, 3, .45); ds.position.x = .5; g.add(ds);
  }
  if (style === 'railway') {
    g.add(box(1.9, .11, .045, steel, [0, .8, -.43], .015, metal));
    for (const x of [-.95, .95]) g.add(box(.035, .08, .85, brass, [x, .8, 0], .007, metal));
  }
  if (style === 'cyber') {
    g.add(box(1.9, .42, .1, c, [0, .8, -.4], .04, metal), screen(.72, .2, [.4, .92, -.343], cyan), screen(1.6, .018, [0, .12, .453], cyan));
    for (const x of [-.65, -.32]) g.add(cyl(.09, .09, .23, '#93b4aa', [x, .82, -.27], 16, ceramic));
  }
  return g;
}

function singleBed(c: string, railway: boolean) {
  const g = group(box(.91, .25, 1.91, railway ? '#71513e' : '#7d8f87', [0, .08, 0], .035, railway ? wood : metal), box(.87, .11, 1.83, paper, [0, .33, 0], .045, cloth), box(.88, .08, 1.25, c, [0, .44, .27], .045, cloth), box(.65, .1, .35, '#f1ebdf', [0, .44, -.6], .04, cloth));
  if (railway) {
    g.add(box(.94, .63, .11, c, [0, .35, -.91], .06, cloth), box(.92, .1, .1, brass, [0, .33, .92], .02));
    for (let i = 0; i < 5; i++) g.add(box(.008, .38, .006, shade(c, -.2), [-.34 + i * .17, .53, -.85], .002));
    g.add(box(.8, .04, .04, brass, [0, .95, -.85], .006));
  } else {
    for (const x of [-.44, .44]) for (const z of [-.94, .94]) g.add(cyl(.024, .024, z < 0 ? 1.08 : .7, ink, [x, 0, z], 10, metal));
    for (const z of [-.94, .94]) for (const y of [.6, .7]) g.add(box(.9, .025, .025, ink, [0, y, z], .004, metal));
    g.add(box(.76, .18, .025, c, [0, .11, .965], .015, metal), box(.14, .025, .04, steel, [0, .19, .985], .005));
  }
  return g;
}

function locker(c: string, style: 'academy' | 'railway' | 'cyber') {
  const g = group(box(.92, 1.8, .86, c, [0, .05, 0], .035, style === 'railway' ? wood : metal), box(.82, 1.65, .025, shade(c, .04), [0, .13, .44], .018, style === 'railway' ? wood : metal));
  g.add(box(.035, .22, .05, style === 'railway' ? brass : steel, [.25, .85, .47], .008));
  if (style === 'railway') {
    for (let i = 0; i < 8; i++) g.add(box(.6, .022, .025, shade(c, -.18), [0, 1.22 + i * .055, .464], .004, wood));
    g.add(box(.7, .026, .025, brass, [0, .4, .463], .004));
  } else if (style === 'academy') {
    for (const y of [.3, 1.5]) for (let i = 0; i < 4; i++) g.add(box(.42, .013, .012, ink, [0, y + i * .045, .46], .003));
    g.add(box(.2, .1, .012, paper, [0, 1.17, .462], .008), box(.1, .014, .007, ink, [0, 1.21, .472], .002));
  } else {
    g.add(screen(.022, 1.4, [-.31, .24, .46], cyan), screen(.19, .12, [.18, 1.15, .463], cyan));
    for (const y of [.3, 1.55]) g.add(box(.7, .065, .025, ink, [0, y, .464], .012, metal));
  }
  return g;
}

export const HOME_BUILDERS: Record<string, (c: string) => THREE.Group> = {
  platformBed: (c) => {
    const g = group(box(1.55, .19, 1.6, '#574d43', [0, .04, 0], .04, wood), box(1.97, .13, 1.97, '#b09a7c', [0, .23, 0], .045, wood), box(1.82, .12, 1.83, paper, [0, .36, 0], .06, cloth), box(1.94, .7, .16, c, [0, .28, -.88], .08, cloth), box(1.86, .08, 1.18, c, [0, .48, .31], .05, cloth));
    for (const x of [-.46, .46]) g.add(box(.64, .12, .33, '#f2eade', [x, .48, -.56], .05, cloth));
    g.add(box(1.87, .025, .27, '#9b755f', [0, .56, .65], .012, cloth));
    return g;
  },
  linenWardrobe: (c) => {
    const g = group(box(1.94, 1.78, .89, c, [0, .12, 0], .025, wood), ...legs(1.8, .8, .14, .025, ink));
    for (const x of [-.47, .47]) {
      g.add(box(.85, 1.58, .025, '#c8bc96', [x, .22, .46], .018, cloth));
      for (let i = 0; i < 14; i++) g.add(box(.8, .009, .008, '#9f9473', [x, .26 + i * .109, .48], .001));
      g.add(box(.025, .26, .045, brass, [x - Math.sign(x) * .33, .85, .49], .006));
    }
    return g;
  },
  islandKitchen: (c) => kitchen(c, 'modern'),
  floatingVanity: (c) => group(box(1.9, .38, .78, c, [0, .3, 0], .035, wood), drawers(1.84, .3, c, 1, .405), box(1.97, .1, .92, '#ddd4be', [0, .68, 0], .025, ceramic), bowl(-.47, .78), bowl(.47, .78)),
  tansu: (c) => {
    const g = group(box(1.93, 1.4, .87, c, [0, .08, 0], .025, wood), drawers(1.88, 1.3, c, 4, .45));
    for (const x of [-.94, .94]) for (const y of [.1, 1.34]) g.add(box(.1, .12, .04, '#45463c', [x, y, .48], .006, metal));
    return g;
  },
  zenDesk: (c) => group(box(1.93, .065, .9, c, [0, .295, 0], .025, wood), box(.12, .3, .75, shade(c, -.13), [-.75, 0, 0], .015, wood), box(.12, .3, .75, shade(c, -.13), [.75, 0, 0], .015, wood), box(1.5, .075, .04, c, [0, .1, -.33], .008, wood)),
  ryokanKitchen: (c) => kitchen(c, 'onsen'),
  stoneBasin: (c) => group(cyl(.27, .34, .58, shade(c, -.13), [0, 0, 0], 18, ceramic), cyl(.42, .3, .2, c, [0, .58, 0], 28, ceramic), cyl(.33, .33, .015, '#9cbcb1', [0, .78, 0], 28, ceramic), faucet(0, .61, -.34, '#927c50')),
  cedarBench: (c) => {
    const g = group(box(.12, .32, .65, c, [-.72, 0, 0], .015, wood), box(.12, .32, .65, c, [.72, 0, 0], .015, wood));
    for (let i = 0; i < 5; i++) g.add(box(1.94, .08, .13, c, [0, .32, -.3 + i * .15], .012, wood));
    return g;
  },
  dormBed: (c) => singleBed(c, false),
  academicLocker: (c) => locker(c, 'academy'),
  lectureDesk: (c) => {
    const g = group(box(1.94, .06, .67, '#b49469', [0, .7, -.35], .02, wood));
    for (const x of [-.5, .5]) {
      g.add(box(.78, .07, .42, c, [x, .36, .47], .025, wood), box(.78, .28, .045, c, [x, .44, .69], .02, wood));
      for (const dx of [-.29, .29]) g.add(box(.025, .7, .035, ink, [x + dx, 0, -.37], .004, metal), box(.025, .62, .035, ink, [x + dx, 0, .65], .004, metal), box(.04, .025, 1.2, ink, [x + dx, .04, .1], .004, metal));
      g.add(box(.72, .035, .43, '#66766c', [x, .52, -.34], .008, metal));
    }
    return g;
  },
  lectern: (c) => {
    const top = box(.86, .055, .62, '#b49469', [0, .99, 0], .018, wood); top.rotation.x = .12;
    const g = group(box(.78, .08, .65, ink, [0, 0, 0], .025, metal), box(.58, .9, .42, c, [0, .08, 0], .025, wood), top, box(.54, .018, .025, brass, [0, .99, .27], .004));
    for (let i = 0; i < 6; i++) g.add(box(.018, .64, .012, shade(c, -.18), [-.22 + i * .088, .23, .22], .003));
    return g;
  },
  chalkboard: (c) => {
    const g = group(box(2.98, 1.28, .09, c, [0, -.64, .045], .025, wood), box(2.78, 1.08, .035, '#244d43', [0, -.54, .103], .008), box(2.9, .035, .15, steel, [0, -.65, .12], .004, metal));
    g.add(box(.035, 1.1, .04, '#7b8d7f', [0, -.55, .132], .006));
    for (let row = 0; row < 5; row++) for (let col = 0; col < 3; col++) g.add(box(.15 + (row + col) % 3 * .06, .009, .007, '#d6deca', [-1.15 + col * .36, .32 - row * .16, .127], .001));
    const orbit = ring(.29, .008, '#d6deca', [.68, 0, .128], true); orbit.scale.y = .6; orbit.rotation.z = .4;
    g.add(orbit, ring(.19, .007, '#d6deca', [.68, 0, .13], true), box(.75, .008, .006, '#d6deca', [.68, -.38, .13], 0), box(.03, .025, .06, '#f2e3c5', [-.9, -.6, .16], .003));
    return g;
  },
  workstation: (c) => {
    const g = group(box(1.93, .06, .93, '#d0b68e', [0, .66, 0], .02, wood), ...legs(1.8, .82, .66, .025, ink), box(1.95, .58, .045, c, [0, .72, -.44], .02, cloth), box(.045, .53, .88, c, [-.94, .72, 0], .015, cloth));
    g.add(box(.72, .4, .055, ink, [.3, .85, -.23], .025, metal), screen(.65, .32, [.3, .89, -.197], '#a3c9c5'), box(.04, .14, .04, ink, [.3, .72, -.23], .006), box(.35, .025, .2, ink, [.3, .72, -.23], .015), box(.54, .018, .2, '#8a9995', [.3, .724, .19], .012));
    for (let i = 0; i < 3; i++) g.add(box(.16, .2, .004, ['#e8dba5', '#c9dcca', '#d8c1ac'][i]!, [-.65 + i * .2, .98, -.41], .002));
    return g;
  },
  canteenTable: (c) => {
    const g = group(box(1.9, .06, .77, '#e1ddce', [0, .69, 0], .035), ...legs(1.7, .65, .69, .025, steel));
    for (const z of [-.68, .68]) {
      g.add(box(1.88, .065, .38, c, [0, .355, z], .025));
      for (const x of [-.65, .65]) g.add(box(.04, .36, .045, steel, [x, 0, z], .006, metal), box(.05, .04, 1.6, steel, [x, .05, 0], .006, metal));
    }
    return g;
  },
  servingCounter: (c) => {
    const g = group(box(1.94, .69, .89, c, [0, .06, 0], .035, metal), box(1.99, .055, .97, steel, [0, .75, 0], .022, metal));
    for (let i = 0; i < 3; i++) {
      const x = -.63 + i * .63;
      g.add(box(.55, .04, .57, '#758c8b', [x, .805, 0], .035, metal), box(.45, .015, .45, ['#d6b174', '#8da776', '#a87957'][i]!, [x, .845, 0], .025));
      g.add(box(.23, .08, .012, paper, [x, .61, .458], .006));
    }
    for (const x of [-.92, .92]) g.add(cyl(.024, .024, .48, steel, [x, .8, -.32], 12, metal));
    g.add(box(1.98, .08, .64, c, [0, 1.27, -.12], .025, metal), box(1.75, .012, .025, '#f2d69f', [0, 1.26, .15], .004, { glow: '#f2d69f' }));
    return g;
  },
  mealTray: (c) => group(box(.44, .025, .37, c, [0, 0, 0], .035, metal), box(.18, .018, .27, '#e9e3ce', [-.09, .027, 0], .035), box(.13, .02, .12, '#8aab72', [.1, .026, -.075], .025), box(.13, .025, .12, '#bc9264', [.1, .026, .075], .025), box(.015, .01, .29, '#626e69', [.18, .026, 0], .004)),
  communalBasin: (c) => group(box(1.88, .55, .7, c, [0, .1, 0], .02), box(1.96, .15, .86, paper, [0, .65, 0], .04, ceramic), box(1.72, .015, .55, '#acbfb4', [0, .8, .06], .03, ceramic), faucet(-.5, .72, -.31), faucet(.5, .72, -.31)),
  sleeperBed: (c) => singleBed(c, true),
  cabinWardrobe: (c) => locker(c, 'railway'),
  galleyKitchen: (c) => kitchen(c, 'railway'),
  carriageVanity: (c) => group(box(.9, .68, .78, c, [0, .07, 0], .04, wood), box(.95, .06, .87, '#ddcfb6', [0, .75, 0], .035, ceramic), bowl(0, .81, paper, .28), box(.035, .2, .04, brass, [.3, .4, .42], .008)),
  foldingDesk: (c) => group(box(.92, .065, .84, c, [0, .585, 0], .025, wood), box(.055, .59, .055, brass, [0, 0, .2], .01, metal), box(.86, .36, .055, c, [0, .24, -.36], .018, wood), box(.045, .045, .7, brass, [0, .05, .05], .006, metal)),
  doublePod: (c) => {
    const g = group(box(1.95, .29, 1.95, c, [0, .07, 0], .08, metal), box(1.78, .1, 1.76, '#84989f', [0, .36, 0], .055, cloth), box(1.96, .94, .15, c, [0, .36, -.87], .07, metal));
    for (const x of [-.46, .46]) g.add(box(.66, .1, .35, '#c8d1d4', [x, .46, -.55], .05, cloth), screen(.67, .12, [x, .92, -.787], cyan));
    g.add(screen(1.65, .022, [0, .23, .978], cyan), box(1.82, .05, 1.12, '#465b6c', [0, .46, .28], .035, cloth));
    return g;
  },
  storagePod: (c) => locker(c, 'cyber'),
  nutritionStation: (c) => kitchen(c, 'cyber'),
  hygienePod: (c) => {
    const g = group(box(.95, .12, 1.94, c, [0, 0, 0], .05, metal), box(.95, 1.78, .13, c, [0, .12, -.88], .05, metal), box(.96, .1, .8, c, [0, 1.8, -.55], .04, metal), box(.8, .035, 1.7, '#869ea6', [0, .12, .02], .04, ceramic));
    for (const x of [-.44, .44]) g.add(box(.07, 1.75, .12, c, [x, .12, -.2], .02, metal), box(.016, 1.4, .024, cyan, [x, .3, -.126], .004, { glow: cyan }));
    g.add(cyl(.18, .18, .035, steel, [0, 1.76, -.33], 24, metal), screen(.3, .4, [0, .93, -.808], cyan));
    for (let i = 0; i < 5; i++) g.add(box(.62, .006, .018, '#526a75', [0, .16, .35 + i * .1], .002));
    return g;
  },
  holoTable: (c) => {
    const g = group(box(1.7, .16, .72, c, [0, .52, 0], .06, metal), box(.6, .52, .5, shade(c, -.15), [0, 0, 0], .05, metal), box(1.55, .018, .6, '#244658', [0, .68, 0], .03, metal));
    for (let i = 0; i < 3; i++) {
      const orbit = ring(.22 + i * .1, .007, cyan, [0, .77 + i * .13, 0]); orbit.scale.y = .65; g.add(orbit);
    }
    for (const x of [-.68, .68]) g.add(cyl(.04, .05, .09, cyan, [x, .68, 0], 12, { glow: cyan }));
    g.add(screen(1.5, .015, [0, .59, .367], cyan));
    return g;
  },
};
