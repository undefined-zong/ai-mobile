import type { BrawlDifficulty, BrawlFighter, BrawlSkill } from '@app/shared';

export type Side = 0 | 1;
export interface Controls { move: number; guard: boolean; basic: boolean; jump: boolean; dash: boolean; skill: number | null }
export const neutralControls = (): Controls => ({ move: 0, guard: false, basic: false, jump: false, dash: false, skill: null });
export interface Attack { skill: BrawlSkill; slot: number; elapsed: number; fired: boolean; facing: number; chain: number }
export interface FighterState {
  profile: BrawlFighter; x: number; y: number; vx: number; vy: number; facing: number;
  hp: number; mp: number; shield: number; shieldTime: number; stun: number; invulnerable: number;
  dash: number; dashCooldown: number; dashDirection: number; guard: boolean; moving: boolean;
  cooldowns: number[]; attack: Attack | null; basicCooldown: number; chain: number; chainTime: number;
  combo: number; comboTime: number; bestCombo: number; damage: number; actionTime: number;
}
export interface Projectile { id: number; owner: Side; x: number; y: number; vx: number; distance: number; skill: BrawlSkill }
export interface Effect { id: number; kind: 'hit' | 'guard' | 'cast' | 'dash' | 'burst'; x: number; y: number; color: string; age: number; life: number; size: number; text?: string }
export interface Outcome { winner: 'you' | 'opponent' | 'draw'; reason: 'ko' | 'time' | 'forfeit' }

/** 60 Hz 固定步长的本地战斗。这里不发网络请求，也不修改持久化的档案。 */
export class BrawlEngine {
  readonly fighters: [FighterState, FighterState];
  readonly controls = neutralControls();
  readonly effects: Effect[] = [];
  readonly projectiles: Projectile[] = [];
  time = 90;
  countdown = 3;
  elapsed = 0;
  outcome: Outcome | null = null;
  hitStop = 0;
  shake = 0;
  announcement = '';
  announcementTime = 0;
  private ai = neutralControls();
  private aiWait = .6;
  private serial = 0;

  constructor(you: BrawlFighter, opponent: BrawlFighter, readonly difficulty: BrawlDifficulty) {
    const state = (p: BrawlFighter, side: Side): FighterState => ({
      profile: JSON.parse(JSON.stringify(p)), x: side === 0 ? 280 : 720, y: 0, vx: 0, vy: 0, facing: side === 0 ? 1 : -1,
      hp: p.hp, mp: p.mp, shield: 0, shieldTime: 0, stun: 0, invulnerable: 0, dash: 0, dashCooldown: 0, dashDirection: 0,
      guard: false, moving: false, cooldowns: [0, 0, 0], attack: null, basicCooldown: 0, chain: 0, chainTime: 0,
      combo: 0, comboTime: 0, bestCombo: 0, damage: 0, actionTime: 0,
    });
    this.fighters = [state(you, 0), state(opponent, 1)];
  }

  clearInput() { Object.assign(this.controls, neutralControls()); Object.assign(this.ai, neutralControls()); }
  forfeit() { if (!this.outcome) this.outcome = { winner: 'opponent', reason: 'forfeit' }; this.clearInput(); }

  private effect(kind: Effect['kind'], x: number, y: number, color: string, size = 50, text?: string) {
    this.effects.push({ id: ++this.serial, kind, x, y, color, size, age: 0, life: kind === 'burst' ? .65 : .42, text });
  }

  private think(dt: number) {
    this.aiWait -= dt;
    if (this.aiWait > 0) return;
    const reaction = { easy: .58, normal: .3, hard: .17 }[this.difficulty];
    this.aiWait = reaction * (.8 + Math.random() * .5);
    const me = this.fighters[1], target = this.fighters[0];
    const distance = Math.abs(target.x - me.x);
    const direction = Math.sign(target.x - me.x);
    const range = me.profile.style === 'ranged' ? 280 : me.profile.style === 'guard' ? 115 : 65;
    const chance = { easy: .3, normal: .6, hard: .83 }[this.difficulty];
    this.ai.move = distance > range + 30 ? direction : distance < range - 45 ? -direction : 0;
    this.ai.guard = !!target.attack && distance < 210 && Math.random() < chance * (me.profile.style === 'guard' ? 1.2 : .8);
    this.ai.basic = distance < 110 && Math.abs(target.y - me.y) < 95 && Math.random() < chance;
    this.ai.jump = !me.y && (target.y > 60 || this.projectiles.some(p => p.owner === 0 && Math.abs(p.x - me.x) < 220)) && Math.random() < chance * .65;
    this.ai.dash = distance > 300 && me.profile.style === 'rush' && Math.random() < chance;
    this.ai.skill = null;
    if (me.attack || me.stun > 0 || this.ai.guard || Math.random() > chance) return;
    const choices = me.profile.skills.map((s, i) => ({ s, i })).filter(({ s, i }) =>
      me.cooldowns[i]! <= 0 && me.mp >= s.mana && (s.kind === 'shield' ? me.hp < me.profile.hp * .7 && me.shield < 20 : distance < s.range + 30 && (s.kind !== 'burst' || distance < s.range)),
    );
    if (choices.length) this.ai.skill = choices[Math.floor(Math.random() * choices.length)]!.i;
  }

  step(dt: number) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      this.effects[i]!.age += dt;
      if (this.effects[i]!.age > this.effects[i]!.life) this.effects.splice(i, 1);
    }
    this.shake = Math.max(0, this.shake - dt * 40);
    this.announcementTime = Math.max(0, this.announcementTime - dt);
    if (this.outcome) return;
    if (this.countdown > 0) { this.countdown = Math.max(0, this.countdown - dt); this.clearInput(); return; }
    if (this.hitStop > 0) { this.hitStop -= dt; return; }
    this.time = Math.max(0, this.time - dt);
    this.elapsed += dt;
    this.think(dt);
    this.updateFighter(0, this.controls, dt);
    this.updateFighter(1, this.ai, dt);
    const [a, b] = this.fighters;
    // 地面身体不能重叠；跳过头顶、闪避穿身仍然可以换边。
    if (Math.abs(a.y - b.y) < 65 && !a.dash && !b.dash) {
      const gap = b.x - a.x;
      if (Math.abs(gap) < 54) {
        const sign = gap >= 0 ? 1 : -1;
        const push = (54 - Math.abs(gap)) / 2;
        a.x = Math.max(40, Math.min(960, a.x - sign * push));
        b.x = Math.max(40, Math.min(960, b.x + sign * push));
      }
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i]!;
      const oldX = p.x;
      p.x += p.vx * dt; p.distance -= Math.abs(p.vx) * dt;
      const target = this.fighters[p.owner === 0 ? 1 : 0];
      const crossed = target.x >= Math.min(oldX, p.x) - 30 && target.x <= Math.max(oldX, p.x) + 30;
      if (crossed && Math.abs(target.y + 52 - p.y) < 53) {
        this.hit(p.owner, p.skill, Math.sign(p.vx)); this.projectiles.splice(i, 1);
      } else if (p.distance <= 0 || p.x < 0 || p.x > 1000) this.projectiles.splice(i, 1);
    }
    if (a.hp <= 0 || b.hp <= 0) this.outcome = { winner: a.hp <= 0 && b.hp <= 0 ? 'draw' : a.hp <= 0 ? 'opponent' : 'you', reason: 'ko' };
    else if (this.time <= 0) {
      const difference = a.hp / a.profile.hp - b.hp / b.profile.hp;
      this.outcome = { winner: Math.abs(difference) < .00001 ? 'draw' : difference > 0 ? 'you' : 'opponent', reason: 'time' };
    }
    if (this.outcome) this.clearInput();
  }

  private updateFighter(side: Side, input: Controls, dt: number) {
    const f = this.fighters[side], target = this.fighters[side === 0 ? 1 : 0];
    f.actionTime += dt;
    for (let i = 0; i < 3; i++) f.cooldowns[i] = Math.max(0, f.cooldowns[i]! - dt);
    f.stun = Math.max(0, f.stun - dt); f.invulnerable = Math.max(0, f.invulnerable - dt);
    f.basicCooldown = Math.max(0, f.basicCooldown - dt); f.dashCooldown = Math.max(0, f.dashCooldown - dt);
    f.shieldTime -= dt; if (f.shieldTime <= 0) f.shield = 0;
    f.chainTime -= dt; if (f.chainTime <= 0) f.chain = 0;
    f.comboTime -= dt; if (f.comboTime <= 0) f.combo = 0;
    f.mp = Math.min(f.profile.mp, f.mp + (f.profile.passive.kind === 'recovery' ? 6 : 3.5) * dt);
    if (!f.attack && !f.dash && !f.stun) f.facing = target.x >= f.x ? 1 : -1;
    f.guard = input.guard && !f.attack && !f.stun && !f.dash && f.y === 0 && f.mp > 0;
    f.moving = false;

    if (!f.stun && !f.attack && !f.dash) {
      if (input.jump && f.y === 0) { f.vy = 620; f.guard = false; }
      if (input.dash && f.dashCooldown <= 0 && f.mp >= 8) {
        f.mp -= 8; f.dash = .18; f.dashCooldown = 1.15; f.invulnerable = .18;
        f.dashDirection = input.move ? Math.sign(input.move) : f.facing;
        f.guard = false; this.effect('dash', f.x, f.y + 50, f.profile.color, 80);
      } else if (!f.guard) {
        if (input.skill !== null) this.startAttack(side, input.skill);
        else if (input.basic && f.basicCooldown <= 0) this.startAttack(side, -1);
      }
    }
    input.jump = false; input.dash = false; input.skill = null;

    if (f.attack) {
      const a = f.attack;
      a.elapsed += dt;
      if (!a.fired && a.elapsed >= a.skill.windup) { a.fired = true; this.fire(side, a); }
      if (a.skill.kind === 'dash' && a.fired && a.elapsed < a.skill.windup + .2) {
        f.x += a.facing * a.skill.range / .2 * dt;
        if (Math.abs(target.x - f.x) < 90 && Math.abs(target.y - f.y) < 95 && a.chain !== -1) {
          this.hit(side, a.skill, a.facing); a.chain = -1;
        }
      }
      if (a.elapsed >= a.skill.windup + Math.max(a.skill.kind === 'dash' ? .24 : 0, a.skill.recovery)) f.attack = null;
    }
    if (f.dash > 0) { f.dash = Math.max(0, f.dash - dt); f.x += f.dashDirection * 800 * dt; }
    else if (!f.stun && !f.attack) {
      f.x += input.move * f.profile.speed * (f.guard ? .3 : 1) * dt;
      f.moving = Math.abs(input.move) > .1;
    }
    f.x += f.vx * dt; f.vx *= Math.exp(-dt * 10);
    if (f.y > 0 || f.vy > 0) { f.y += f.vy * dt; f.vy -= 1600 * dt; }
    if (f.y <= 0) { f.y = 0; f.vy = 0; }
    f.x = Math.max(40, Math.min(960, f.x));
  }

  private startAttack(side: Side, slot: number) {
    const f = this.fighters[side];
    let skill: BrawlSkill;
    if (slot === -1) {
      f.chain = f.chain % 3 + 1; f.chainTime = 1.1; f.basicCooldown = .35;
      skill = { name: `${f.chain}段连击`, description: '', kind: 'strike', damage: Math.round(f.profile.attack * (f.chain === 3 ? 1.5 : 1)), mana: 0, cooldown: .35, range: 110, windup: .09, recovery: .21, knockback: f.chain === 3 ? 210 : 65, launch: f.chain === 3 };
    } else {
      skill = f.profile.skills[slot]!;
      if (!skill || f.cooldowns[slot]! > 0 || f.mp < skill.mana) return;
      f.mp -= skill.mana; f.cooldowns[slot] = skill.cooldown;
      if (slot === 2) { this.announcement = `${f.profile.name} · ${skill.name}`; this.announcementTime = 1.1; }
    }
    f.attack = { skill, slot, elapsed: 0, fired: false, facing: f.facing, chain: slot === -1 ? f.chain : 0 };
    f.actionTime = 0;
  }

  private fire(side: Side, a: Attack) {
    const f = this.fighters[side], target = this.fighters[side === 0 ? 1 : 0], s = a.skill;
    if (s.kind === 'projectile') {
      this.projectiles.push({ id: ++this.serial, owner: side, x: f.x + a.facing * 45, y: f.y + 52, vx: a.facing * 520, distance: s.range, skill: s });
      this.effect('cast', f.x + a.facing * 40, f.y + 50, f.profile.color, 50);
    } else if (s.kind === 'shield') {
      f.shield = s.damage; f.shieldTime = 3.5;
      this.effect('guard', f.x, f.y + 45, f.profile.color, 95);
    } else if (s.kind === 'strike' || s.kind === 'burst') {
      const burst = s.kind === 'burst';
      this.effect(burst ? 'burst' : 'cast', f.x + (burst ? 0 : a.facing * 55), f.y + 45, f.profile.color, burst ? s.range * 2 : s.range);
      const dx = target.x - f.x;
      if (Math.abs(dx) < s.range + 28 && (burst || dx * a.facing >= -15) && Math.abs(target.y - f.y) < (burst ? s.range : 105)) this.hit(side, s, a.facing, a.slot === -1);
    }
  }

  private hit(side: Side, skill: BrawlSkill, direction: number, basic = false) {
    const f = this.fighters[side], target = this.fighters[side === 0 ? 1 : 0];
    if (target.invulnerable > 0) return;
    let damage = skill.damage;
    if (f.profile.passive.kind === 'laststand' && f.hp < f.profile.hp * .3) damage *= 1.18;
    // 连续命中递减，长连段仍会给对手脱身的机会。
    damage *= Math.max(.45, 1 - Math.max(0, f.combo - 2) * .08);
    const blocked = target.guard && target.facing === -direction;
    if (blocked) {
      const cost = 12 * (target.profile.passive.kind === 'guard' ? .5 : 1);
      target.mp = Math.max(0, target.mp - cost);
      damage *= .18;
      target.stun = target.mp === 0 ? .6 : .1;
      this.effect('guard', target.x, target.y + 50, '#b8e8ff', 85, target.mp === 0 ? '破防' : '防御');
    } else {
      target.stun = basic ? .19 : .3;
      target.attack = null; target.dash = 0;
      if (skill.launch) target.vy = 400;
      if (basic) f.mp = Math.min(f.profile.mp, f.mp + 5 + (f.profile.passive.kind === 'flow' ? 3 : 0));
      f.combo++; f.comboTime = 1.25; f.bestCombo = Math.max(f.bestCombo, f.combo);
      if (f.combo >= 8) { target.invulnerable = .65; target.vx = direction * 360; target.stun = .12; f.comboTime = 0; }
    }
    const absorbed = Math.min(target.shield, damage);
    target.shield -= absorbed; damage = Math.round(damage - absorbed);
    const dealt = Math.min(target.hp, damage);
    target.hp = Math.max(0, target.hp - damage); f.damage += dealt;
    target.vx += direction * skill.knockback * (blocked ? .25 : 1);
    this.hitStop = blocked ? .025 : basic ? .045 : .07;
    this.shake = blocked ? 1 : basic ? 3 : 6;
    this.effect('hit', target.x, target.y + 65, f.profile.color, basic ? 45 : 85, damage ? `−${damage}` : '护盾');
  }
}
