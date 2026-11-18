import * as THREE from 'three';
import { box, ball, cyl, group, ring, screen } from './primitives';
import { catalogItem, type DecorItem } from './model';
import { furnitureActions } from './activities';

/** 所有效果挂在原家具下，跟随家具位置、朝向和释放生命周期。 */
export function addActivityEffects(obj: THREE.Group, item: DecorItem) {
  if (item.kind === 'tv') {
    const program = group(screen(1.3, .64, [0, .18, .049], '#97c8ca'), box(1.3, .17, .008, '#658c78', [0, .18, .058], 0));
    program.add(ball(.13, '#fff0ad', [.34, .65, .065], [1, 1, .025]));
    for (const x of [-.42, -.2, .08]) program.add(box(.18, .12, .008, '#eaf2e7', [x, .53, .062], .035));
    program.name = 'life-tv'; program.visible = false; obj.add(program);
  }
  if (furnitureActions(item).includes('cook')) {
    const top = catalogItem(item.kind)?.top ?? .8;
    const pot = group(cyl(.18, .15, .19, '#bdc9bb', [-.48, top + .02, .12]), cyl(.15, .15, .008, '#e7ad65', [-.48, top + .21, .12]), ring(.19, .018, '#79c7ec', [-.48, top + .012, .12]));
    for (const x of [-.71, -.25]) pot.add(box(.12, .035, .055, '#455c56', [x, top + .15, .12], .01));
    // 旅店厨房本身有砂锅，只给它加热气。
    if (item.kind === 'ryokanKitchen') { pot.children.forEach(child => { if (child instanceof THREE.Mesh) child.geometry.dispose(); }); pot.clear(); }
    for (let i = 0; i < 4; i++) {
      const steam = ball(.04, '#f5f5e8', [-.48, top + .3, .12], [1, 1.5, 1]);
      steam.userData.steam = i; pot.add(steam);
    }
    pot.name = 'life-cook'; pot.visible = false; obj.add(pot);
  }
  if (furnitureActions(item).includes('eat')) {
    const top = catalogItem(item.kind)?.top ?? .6;
    const meal = group(cyl(.16, .11, .09, '#f5edd8', [0, top, .15]), cyl(.145, .145, .01, '#e4bd76', [0, top + .09, .15]));
    for (const x of [-.06, .03, .08]) meal.add(ball(.025, '#7e9a5b', [x, top + .11, .13]));
    meal.name = 'life-eat'; meal.visible = false; obj.add(meal);
  }
}

export function updateActivityEffects(obj: THREE.Group, flags: { tv: boolean; cook: boolean; eat: boolean; radio: boolean }, time: number, reduced: boolean) {
  for (const type of ['tv', 'cook', 'eat'] as const) {
    const effect = obj.getObjectByName(`life-${type}`);
    if (!effect) continue;
    effect.visible = flags[type];
    if (type === 'cook' && flags.cook && !reduced) for (const puff of effect.children) {
      if (puff.userData.steam === undefined) continue;
      const k = (time * .55 + Number(puff.userData.steam) / 4) % 1;
      puff.position.y = (catalogItem(String(obj.userData.kind))?.top ?? .8) + .28 + k * .4;
      puff.position.x = -.48 + Math.sin(k * 4) * .06;
      puff.scale.setScalar((1 - k) * 1.4);
    }
  }
  if (obj.userData.kind === 'radio') obj.traverse(o => { if (o.userData.radioIndicator) o.scale.setScalar(flags.radio ? 1.4 + (reduced ? 0 : Math.sin(time * 4) * .15) : .65); });
}
