/** 大乱斗的战斗档案。数值是每局的上限；当前血蓝只存在本局里。 */
export const BRAWL_STYLES = { balanced: '均衡', rush: '近战突进', ranged: '远程牵制', guard: '防守反击' } as const;
export const BRAWL_KINDS = { strike: '近身攻击', projectile: '飞行弹道', dash: '突进攻击', burst: '范围爆发', shield: '护盾' } as const;
export const BRAWL_PASSIVES = { flow: '普攻额外回蓝', guard: '防御消耗减半', recovery: '回蓝速度提升', laststand: '低血量伤害提升' } as const;
export const BRAWL_DIFFICULTIES = { easy: '轻松', normal: '切磋', hard: '挑战' } as const;
export type BrawlStyle = keyof typeof BRAWL_STYLES;
export type BrawlSkillKind = keyof typeof BRAWL_KINDS;
export type BrawlDifficulty = keyof typeof BRAWL_DIFFICULTIES;
export type BrawlOwner = 'character' | 'persona';

export interface BrawlSkill {
  name: string;
  description: string;
  kind: BrawlSkillKind;
  damage: number;
  mana: number;
  cooldown: number;
  range: number;
  windup: number;
  recovery: number;
  knockback: number;
  launch: boolean;
}

export interface BrawlFighter {
  id: string;
  ownerKind: BrawlOwner;
  ownerId: string;
  name: string;
  title: string;
  style: BrawlStyle;
  hp: number;
  mp: number;
  attack: number;
  speed: number;
  color: string;
  look: { hair: 'short' | 'long' | 'spiky' | 'pony'; hairColor: string; outfit: string; skin: string };
  passive: { name: string; kind: keyof typeof BRAWL_PASSIVES; description: string };
  /** 固定三个位置：技能一、技能二、奥义。 */
  skills: [BrawlSkill, BrawlSkill, BrawlSkill];
  source: 'template' | 'ai' | 'manual';
  createdAt: number;
  updatedAt: number;
}

export const brawlId = (kind: BrawlOwner, id: string) => `${kind}-${id}`;
const numberIn = (v: unknown, fallback: number, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback;
const words = (v: unknown, fallback: string, length = 100) => typeof v === 'string' && v.trim() ? v.trim().slice(0, length) : fallback;
const color = (v: unknown, fallback: string) => typeof v === 'string' && /^#[\da-f]{6}$/i.test(v) ? v : fallback;
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function starterBrawlFighter(ownerKind: BrawlOwner, ownerId: string, name: string, accent = '#68d9c5', hairColor = '#352d48'): BrawlFighter {
  const now = Date.now();
  const skill = (name: string, kind: BrawlSkillKind, damage: number, mana: number, cooldown: number, range: number, description: string): BrawlSkill => ({ name, kind, damage, mana, cooldown, range, description, windup: .18, recovery: .28, knockback: 150, launch: false });
  return {
    id: brawlId(ownerKind, ownerId), ownerKind, ownerId, name, title: '初入擂台', style: 'balanced',
    hp: 1000, mp: 120, attack: 36, speed: 235, color: color(accent, '#68d9c5'),
    look: { hair: 'short', hairColor: color(hairColor, '#352d48'), outfit: color(accent, '#68d9c5'), skin: '#f3d1b9' },
    passive: { name: '顺势而为', kind: 'flow', description: '普攻命中额外恢复 3 点蓝量。' },
    skills: [
      skill('破风波', 'projectile', 110, 20, 5, 480, '发出一道能量波，向前飞行。'),
      { ...skill('踏影突袭', 'dash', 145, 28, 8, 260, '向前突进，命中后挑起对手。'), launch: true },
      { ...skill('星芒爆发', 'burst', 300, 70, 22, 230, '短暂蓄力后释放周身能量。'), windup: .55, recovery: .6, knockback: 300 },
    ], source: 'template', createdAt: now, updatedAt: now,
  };
}

/** 模型、手动编辑和助手共用同一份招式参数；不认识的字段沿用原档案。 */
export function readBrawlFighter(value: unknown, base: BrawlFighter): BrawlFighter {
  const o = object(value);
  const look = object(o.look);
  const passive = object(o.passive);
  return {
    ...base,
    title: words(o.title, base.title, 24),
    style: typeof o.style === 'string' && o.style in BRAWL_STYLES ? o.style as BrawlStyle : base.style,
    hp: Math.round(numberIn(o.hp, base.hp, 600, 1600)),
    mp: Math.round(numberIn(o.mp, base.mp, 80, 200)),
    attack: Math.round(numberIn(o.attack, base.attack, 20, 65)),
    speed: numberIn(o.speed, base.speed, 160, 320),
    color: color(o.color, base.color),
    look: {
      hair: ['short', 'long', 'spiky', 'pony'].includes(String(look.hair)) ? look.hair as BrawlFighter['look']['hair'] : base.look.hair,
      hairColor: color(look.hairColor, base.look.hairColor), outfit: color(look.outfit, base.look.outfit), skin: color(look.skin, base.look.skin),
    },
    passive: {
      name: words(passive.name, base.passive.name, 20),
      kind: typeof passive.kind === 'string' && passive.kind in BRAWL_PASSIVES ? passive.kind as BrawlFighter['passive']['kind'] : base.passive.kind,
      description: words(passive.description, base.passive.description),
    },
    skills: base.skills.map((s, i) => {
      const k = object(Array.isArray(o.skills) ? o.skills[i] : undefined);
      const kind = typeof k.kind === 'string' && k.kind in BRAWL_KINDS ? k.kind as BrawlSkillKind : s.kind;
      return {
        name: words(k.name, s.name, 20), description: words(k.description, s.description),
        kind,
        damage: Math.round(numberIn(k.damage, s.damage, 30, i === 2 ? 420 : 210)),
        mana: Math.round(numberIn(k.mana, s.mana, i === 2 ? 45 : 10, i === 2 ? 80 : 60)),
        cooldown: numberIn(k.cooldown, s.cooldown, i === 2 ? 14 : 3, 35),
        range: numberIn(k.range, s.range, 70, kind === 'burst' ? 300 : 650),
        windup: numberIn(k.windup, s.windup, .1, 1.2), recovery: numberIn(k.recovery, s.recovery, .15, 1),
        knockback: numberIn(k.knockback, s.knockback, 50, 380), launch: typeof k.launch === 'boolean' ? k.launch : s.launch,
      };
    }) as BrawlFighter['skills'],
  };
}

export interface BrawlResult {
  id: string;
  at: number;
  you: string;
  opponent: string;
  characterId: string;
  winner: 'you' | 'opponent' | 'draw';
  reason: 'ko' | 'time' | 'forfeit';
  seconds: number;
  difficulty: BrawlDifficulty;
  damage: number;
  combo: number;
  hpLeft: [number, number];
}
