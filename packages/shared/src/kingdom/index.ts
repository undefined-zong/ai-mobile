import data from './catalog.json';
import type {
  KingdomAction, KingdomBuff, KingdomDynasty, KingdomEvent, KingdomFocus, KingdomMetric,
  KingdomNpc, KingdomOffice, KingdomPolicy, KingdomReport, KingdomResult, KingdomRole,
  KingdomRun, KingdomScenario, KingdomSetup, KingdomSkills, KingdomStats,
} from './types.ts';
export * from './types.ts';

export const KINGDOM_TURNS = (60 - 18) * 4;
export const KINGDOM_SEASONS = ['春', '夏', '秋', '冬'];
export const KINGDOM_DYNASTIES = data.dynasties as KingdomDynasty[];
export const KINGDOM_SCENARIOS = data.scenarios as KingdomScenario[];
export const KINGDOM_POLICIES = data.policies as KingdomPolicy[];
export const KINGDOM_ACTIONS = data.actions as { id: KingdomAction; name: string; cost: number; description: string }[];
export const KINGDOM_FOCUSES = data.focuses as { id: KingdomFocus; name: string; description: string }[];
export const KINGDOM_ROLES = data.npcRoles;
export const KINGDOM_METRICS: { id: KingdomMetric; name: string; unit: string }[] = [
  { id: 'treasury', name: '国库', unit: '万两' }, { id: 'grain', name: '粮食', unit: '万石' },
  { id: 'population', name: '人口', unit: '万人' }, { id: 'troops', name: '兵力', unit: '万人' },
  { id: 'technology', name: '科技', unit: '点' }, { id: 'welfare', name: '民生', unit: '/100' },
  { id: 'culture', name: '文化', unit: '点' }, { id: 'stability', name: '稳定', unit: '/100' },
];
export const KINGDOM_OFFICES: KingdomOffice[] = ['civil', 'war', 'science', 'culture'];
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const clamp = (n: number, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const round = (n: number) => Math.round(n * 10) / 10;
const mean = (ns: number[]) => ns.length ? ns.reduce((s, n) => s + n, 0) / ns.length : 0;
export const kingdomDynasty = (id: string) => KINGDOM_DYNASTIES.find(d => d.id === id) ?? KINGDOM_DYNASTIES.at(-1)!;
export const kingdomAge = (run: KingdomRun) => 18 + Math.floor(run.turn / 4);
export const kingdomDate = (run: Pick<KingdomRun, 'turn' | 'era'>) => `${run.era}${Math.floor(run.turn / 4) + 1}年 · ${KINGDOM_SEASONS[run.turn % 4]}季`;
export const kingdomNpcAge = (run: KingdomRun, npc: KingdomNpc) => npc.age + Math.floor((run.turn - npc.joinedTurn) / 4);
export const kingdomLands = (run: KingdomRun) => run.provinces.filter(p => p.owner === 'player');

/** 随机状态随存档保存；同一份季度安排在重新打开后仍得到同一结果。 */
function random(run: KingdomRun): number {
  run.seed = (Math.imul(run.seed, 1664525) + 1013904223) >>> 0;
  return run.seed / 4294967296;
}
const pick = <T>(run: KingdomRun, values: T[]) => values[Math.floor(random(run) * values.length)]!;
const roll = (run: KingdomRun, lo: number, hi: number) => Math.floor(random(run) * (hi - lo + 1)) + lo;
function change(run: KingdomRun, effects: Partial<KingdomStats>) {
  for (const [key, value] of Object.entries(effects)) run.stats[key as KingdomMetric] += value;
}
function settleBounds(run: KingdomRun) {
  for (const key of Object.keys(run.stats) as KingdomMetric[]) {
    run.stats[key] = round(key === 'welfare' || key === 'stability' ? clamp(run.stats[key]) : Math.max(0, run.stats[key]));
  }
  for (const key of Object.keys(run.rulerSkills) as (keyof KingdomRun['rulerSkills'])[]) run.rulerSkills[key] = clamp(run.rulerSkills[key]);
}

export function createKingdomNpc(run: KingdomRun, role: KingdomRole): KingdomNpc {
  const dynasty = kingdomDynasty(run.dynastyId);
  const index = run.npcs.length;
  let name = '';
  // 顺着名字表走即可避免同一局重名。
  for (let i = 0; i < data.givenNames.length; i++) {
    name = `${pick(run, dynasty.surnames)}${data.givenNames[(index + i) % data.givenNames.length]}`;
    if (!run.npcs.some(n => n.name === name)) break;
  }
  const gender = role === 'consort' || random(run) < .35 ? 'female' : 'male';
  const title = role === 'minister' ? '候任贤才' : role === 'consort' ? '宫中伴侣' : '来朝使臣';
  return {
    id: `${run.id}-npc-${index}`, name, role, title, age: roll(run, role === 'minister' ? 24 : 18, role === 'minister' ? 48 : 30), joinedTurn: run.turn,
    personality: pick(run, data.personalities), biography: `${dynasty.name}风格的虚构人物。${run.setting}`,
    appearanceTags: `${gender === 'female' ? '1girl, adult woman' : '1boy, adult man'}, black hair, brown eyes`,
    gender, skills: { politics: roll(run, 30, 88), military: roll(run, 25, 90), technology: roll(run, 30, 85), culture: roll(run, 35, 90) },
    loyalty: roll(run, 55, 85), affection: role === 'consort' ? 42 : 30,
    ...(role === 'foreign' ? { factionId: run.factions[index % run.factions.length]!.id } : {}),
  };
}

function nextEvent(run: KingdomRun): KingdomEvent {
  const events = data.events as KingdomEvent[];
  // 丰收只在秋季；同一奏报不连续出现。
  return copy(pick(run, events.filter(e => (e.id !== 'harvest' || run.turn % 4 === 2) && e.id !== run.event?.id)));
}

export function createKingdom(setup: KingdomSetup, id: string, seed: number, now: number): KingdomRun {
  const dynasty = kingdomDynasty(setup.dynastyId);
  const scenario = KINGDOM_SCENARIOS.find(s => s.id === setup.scenarioId) ?? KINGDOM_SCENARIOS[0]!;
  const names = dynasty.id === 'fantasy' ? data.fantasyProvinces : data.provinces;
  const run: KingdomRun = {
    id, createdAt: now, updatedAt: now, seed: seed >>> 0, turn: 0,
    name: setup.name.trim() || (dynasty.id === 'fantasy' ? '云岚' : dynasty.name), ruler: setup.ruler.trim() || '新君',
    rulerTitle: setup.rulerTitle, era: setup.era.trim() || '启元', dynastyId: dynasty.id,
    setting: setup.setting.trim() || dynasty.setting, scenarioId: scenario.id,
    stats: copy(scenario.stats), rulerSkills: { politics: 25, technology: 20, culture: 25 },
    npcs: [], heirs: [], provinces: names.map((name, i) => ({
      id: `province-${i}`, name, owner: [4, 5, 8, 9].includes(i) ? 'player' : i < 4 ? 'north' : i % 4 >= 2 ? 'east' : 'south',
      x: i % 4, y: Math.floor(i / 4), terrain: i % 3 === 0 ? 'mountain' : i % 3 === 1 ? 'plain' : 'river',
      development: 4, garrison: 10 + (i % 4) * 3,
    })),
    factions: ['north', 'east', 'south'].map((id, i) => ({ id, name: data.factionNames[i]!, relation: 15, power: 1, truceUntil: 0 })),
    cabinet: { civil: '', war: '', science: '', culture: '' }, policies: ['rest'], buffs: [],
    plan: { action: 'farm', focus: 'politics', targetProvince: 'province-5', targetNpc: '', targetFaction: 'north', troops: 15, tactic: 'balanced' },
    event: null as unknown as KingdomEvent, eventChoice: 0, reports: [], conversations: [], victories: 0, result: null,
  };
  // 每个邻国有自己的领地，便于外交和征服完整发生。
  run.provinces[11]!.owner = 'south';
  for (const role of ['minister', 'minister', 'minister', 'minister', 'consort', 'consort', 'foreign', 'foreign', 'foreign'] as KingdomRole[]) {
    const npc = createKingdomNpc(run, role);
    if (role === 'foreign') {
      npc.factionId = run.factions[run.npcs.filter(n => n.role === 'foreign').length]!.id;
      npc.title = `${run.factions.find(f => f.id === npc.factionId)!.name}使臣`;
    }
    run.npcs.push(npc);
  }
  for (const p of setup.participants) {
    const npc = createKingdomNpc(run, p.role);
    Object.assign(npc, { name: p.name, characterId: p.characterId, characterDescription: p.description, biography: p.description, gender: p.gender });
    if (p.appearanceTags) npc.appearanceTags = p.appearanceTags;
    run.npcs.push(npc);
  }
  for (const [i, office] of KINGDOM_OFFICES.entries()) run.cabinet[office] = run.npcs[i]!.id;
  run.event = nextEvent(run);
  return run;
}

export function kingdomBuffs(run: KingdomRun): KingdomBuff[] {
  const buffs = run.buffs.filter(b => b.remaining > 0).map(copy);
  const add = (id: string, name: string, description: string, effects: Partial<KingdomStats>, attack = 0) =>
    buffs.push({ id, name, description, effects, attack, remaining: -1, source: '国势达成，条件满足时持续生效' });
  if (run.stats.welfare >= 75 && run.stats.stability >= 70) add('peace', '国泰民安', '民生 ≥75、稳定 ≥70：每季国库 +25、人口 +1 万。', { treasury: 25, population: 1 });
  if (run.stats.technology >= 200) add('invention', '百工争鸣', '科技 ≥200：每季国库 +12、粮食 +40 万石。', { treasury: 12, grain: 40 });
  if (run.stats.culture >= 220) add('literature', '文运昌盛', '文化 ≥220：每季文化 +3、国库 +8。', { culture: 3, treasury: 8 });
  const palace = run.npcs.filter(n => n.role === 'consort');
  if (mean(palace.map(n => n.affection)) >= 70) add('family', '宫闱和睦', '后宫平均亲密 ≥70：每季稳定 +1。', { stability: 1 });
  if (kingdomLands(run).length >= 8) add('realm', '威加四海', '领土 ≥8 州：出征战力 +8%。', {}, .08);
  return buffs;
}

function official(run: KingdomRun, office: KingdomOffice, skill: keyof KingdomSkills): number {
  const npc = run.npcs.find(n => n.id === run.cabinet[office] && n.role === 'minister');
  return npc ? npc.skills[skill] * npc.loyalty / 100 : 0;
}
export function kingdomQuarterIncome(run: KingdomRun): { income: number; expense: number; grain: number } {
  const lands = kingdomLands(run);
  const development = lands.reduce((s, p) => s + p.development, 0);
  return {
    income: round(run.stats.population * .23 + development * 2.5 + run.rulerSkills.politics * .2 + official(run, 'civil', 'politics') * .22),
    expense: round(run.stats.troops * 1.4 + lands.length * 9 + run.npcs.length * 1.2),
    grain: round(lands.length * 32 + development * 5 + run.stats.population * .18 - run.stats.population * .6 - run.stats.troops * 2),
  };
}
export function kingdomAdjacent(run: KingdomRun, provinceId: string): boolean {
  const target = run.provinces.find(p => p.id === provinceId);
  return !!target && kingdomLands(run).some(p => Math.abs(p.x - target.x) + Math.abs(p.y - target.y) === 1);
}
export function kingdomBattleChance(run: KingdomRun): number {
  const target = run.provinces.find(p => p.id === run.plan.targetProvince);
  if (!target || target.owner === 'player') return 0;
  const faction = run.factions.find(f => f.id === target.owner)!;
  const upcoming = run.event.choices[run.eventChoice]?.buff;
  const attackBuff = kingdomBuffs(run).filter(b => b.id !== upcoming?.id).reduce((s, b) => s + (b.attack ?? 0), 0) + (upcoming?.attack ?? 0);
  const tactics = { balanced: 1, assault: 1.18, siege: target.terrain === 'plain' ? .95 : 1.2 };
  const force = Math.min(run.plan.troops, run.stats.troops) * (1 + official(run, 'war', 'military') / 110 + run.stats.technology / 650) * (1 + attackBuff) * tactics[run.plan.tactic];
  const defense = target.garrison * faction.power * (target.terrain === 'plain' ? 1 : 1.25);
  return clamp(force / (force + defense), .12, .92);
}
export function kingdomOrderCost(run: KingdomRun): { treasury: number; grain: number } {
  const cost = KINGDOM_ACTIONS.find(a => a.id === run.plan.action)!.cost;
  return { treasury: cost, grain: run.plan.action === 'war' ? Math.ceil(run.plan.troops * 5) : run.plan.action === 'recruit' ? 70 : run.plan.action === 'relief' ? 65 : 0 };
}
/** 行动的资源/对象限制就是游戏规则，界面在落子前显示同一原因。 */
export function kingdomOrderReason(run: KingdomRun): string {
  if (run.result) return '本朝已结算';
  const cost = kingdomOrderCost(run);
  if (run.stats.treasury < cost.treasury) return `这项政务需要 ${cost.treasury} 万两国库`;
  if (run.stats.grain < cost.grain) return `这项政务需要 ${cost.grain} 万石粮食`;
  const target = run.provinces.find(p => p.id === run.plan.targetProvince);
  if (['farm', 'trade'].includes(run.plan.action) && target?.owner !== 'player') return '请在疆域里选择一处本国州';
  if (run.plan.action === 'war') {
    if (!target || target.owner === 'player' || !kingdomAdjacent(run, target.id)) return '请在疆域里选择接壤的他国州';
    if (run.plan.troops < 1 || run.plan.troops > run.stats.troops) return '请按现有兵力安排出征人数';
    if ((run.factions.find(f => f.id === target.owner)?.truceUntil ?? 0) > run.turn) return '与该国尚在停战期，可先经营或进攻其他国家';
  }
  if (run.plan.action === 'diplomacy' && !run.provinces.some(p => p.owner === run.plan.targetFaction)) return '该国已无领地，请选择其他国家';
  return '';
}

export function appointKingdomMinister(run: KingdomRun, office: KingdomOffice, npcId: string) {
  for (const other of KINGDOM_OFFICES) if (run.cabinet[other] === npcId) run.cabinet[other] = '';
  run.cabinet[office] = npcId;
}
export function toggleKingdomPolicy(run: KingdomRun, id: string) {
  if (run.policies.includes(id)) run.policies = run.policies.filter(p => p !== id);
  else {
    const policy = KINGDOM_POLICIES.find(p => p.id === id)!;
    run.policies = run.policies.filter(p => KINGDOM_POLICIES.find(x => x.id === p)!.group !== policy.group);
    run.policies.push(id);
  }
}

function performOrder(run: KingdomRun, report: KingdomReport) {
  const { action, targetProvince, targetFaction, tactic } = run.plan;
  const target = run.provinces.find(p => p.id === targetProvince);
  const cost = kingdomOrderCost(run);
  change(run, { treasury: -cost.treasury, grain: -cost.grain });
  switch (action) {
    case 'rest': change(run, { welfare: .5, stability: 1, grain: 20 }); break;
    case 'farm': change(run, { grain: 140, welfare: 1.5 }); target!.development += 1; break;
    case 'trade': change(run, { treasury: 95, culture: 2 }); target!.development += 1; break;
    case 'research': change(run, { technology: 20 + run.rulerSkills.technology * .15 }); break;
    case 'academy': change(run, { culture: 22, technology: 4 }); break;
    case 'relief': change(run, { welfare: 5, stability: 4, population: 3 }); break;
    case 'recruit': change(run, { troops: 6, population: -1 }); break;
    case 'talent': case 'visit': {
      const npc = createKingdomNpc(run, action === 'talent' ? 'minister' : 'consort');
      run.npcs.push(npc);
      if (action === 'visit') run.stats.culture += 4;
      report.entries.push(`${npc.name}入${action === 'talent' ? '朝候任' : '宫相伴'}，${npc.personality}。`);
      break;
    }
    case 'diplomacy': {
      const faction = run.factions.find(f => f.id === targetFaction)!;
      faction.relation = clamp(faction.relation + 18, -100, 100);
      faction.truceUntil = run.turn + 4;
      const envoy = run.npcs.find(n => n.role === 'foreign' && n.factionId === faction.id);
      if (envoy) envoy.affection = clamp(envoy.affection + 8);
      report.entries.push(`使节访问${faction.name}，关系升至 ${faction.relation}，停战至第 ${faction.truceUntil + 1} 季。`);
      break;
    }
    case 'war': {
      const chance = kingdomBattleChance(run);
      const won = random(run) < chance;
      const losses = round(run.plan.troops * (won ? .08 + random(run) * .12 : .22 + random(run) * .16) * (tactic === 'assault' ? 1.3 : 1));
      const faction = run.factions.find(f => f.id === target!.owner)!;
      run.stats.troops -= losses;
      faction.relation = clamp(faction.relation - 28, -100, 100);
      if (won) {
        target!.owner = 'player';
        target!.garrison = 8;
        change(run, { treasury: 70, population: 25 + target!.development * 2, stability: -2 });
        run.victories += 1;
      } else {
        target!.garrison = Math.max(5, target!.garrison - run.plan.troops * .12);
        run.stats.stability -= 3;
      }
      report.battle = { target: target!.name, won, chance, losses };
      report.entries.push(`${target!.name}之战${won ? '告捷，纳入版图' : '失利，退回整军'}；损兵 ${losses} 万。`);
      break;
    }
  }
  report.entries.unshift(`本季施行「${KINGDOM_ACTIONS.find(a => a.id === action)!.name}」。`);
}

function personalLife(run: KingdomRun, report: KingdomReport) {
  const focus = run.plan.focus;
  if (focus === 'politics' || focus === 'technology' || focus === 'culture') {
    run.rulerSkills[focus] += 3;
    change(run, focus === 'politics' ? { stability: 1 } : { [focus]: 3 });
  }
  if (focus === 'audience') {
    const npc = run.npcs.find(n => n.id === run.plan.targetNpc && n.role === 'minister') ?? run.npcs.find(n => n.role === 'minister');
    if (npc) { npc.loyalty = clamp(npc.loyalty + 7); report.entries.push(`召见${npc.name}议政，忠诚升至 ${Math.round(npc.loyalty)}。`); }
    run.rulerSkills.politics += 1;
  }
  if (focus === 'palace') {
    const npc = run.npcs.find(n => n.id === run.plan.targetNpc && n.role === 'consort') ?? run.npcs.find(n => n.role === 'consort');
    if (npc) {
      npc.affection = clamp(npc.affection + 8);
      report.entries.push(`与${npc.name}相伴，亲密升至 ${Math.round(npc.affection)}。`);
      if (!npc.pregnancyDue && npc.affection >= 50 && kingdomNpcAge(run, npc) < 48 && random(run) < .2) {
        npc.pregnancyDue = run.turn + 3;
        report.entries.push(`${npc.name}传来家族喜讯，预计三季后迎来子嗣。`);
      }
    }
  }
  if (focus === 'education') {
    for (const heir of run.heirs) for (const skill of Object.keys(heir.education) as (keyof KingdomSkills)[]) heir.education[skill] = clamp(heir.education[skill] + 2);
    run.rulerSkills.culture += 1;
    report.entries.push(run.heirs.length ? '亲授诗书与政务，子嗣各项教育 +2。' : '先修订宗室家学，为日后子嗣备课。');
  }
  for (const npc of run.npcs) {
    if (npc.pregnancyDue && npc.pregnancyDue <= run.turn + 1) {
      const number = run.heirs.length + 1;
      const name = `${run.ruler.slice(0, 1)}${data.givenNames[(number + 5) % data.givenNames.length]}`;
      run.heirs.push({ id: `${run.id}-heir-${number}`, name, parentId: npc.id, bornTurn: run.turn + 1, gender: random(run) < .5 ? 'female' : 'male',
        education: { politics: 8, military: 8, technology: 8, culture: 8 }, designated: false });
      delete npc.pregnancyDue;
      report.entries.push(`皇嗣${name}降生，${npc.name}与君共喜。`);
      run.stats.stability += 2;
    }
    if (npc.role === 'minister') npc.loyalty = clamp(npc.loyalty - (run.stats.stability < 40 ? .8 : .15));
  }
  for (const heir of run.heirs) {
    if (run.turn - heir.bornTurn < 20) continue;
    heir.education.culture = clamp(heir.education.culture + official(run, 'culture', 'culture') / 120);
    heir.education.politics = clamp(heir.education.politics + official(run, 'civil', 'politics') / 150);
  }
}

export function scoreKingdom(run: KingdomRun): KingdomResult {
  const palace = run.npcs.filter(n => n.role === 'consort');
  const dims: [string, number, number, string][] = [
    ['领土', kingdomLands(run).length, 12, '州'], ['国库', run.stats.treasury, 5000, '万两'], ['人口', run.stats.population, 1000, '万人'],
    ['国家科技', run.stats.technology, 1200, '点'], ['民生', run.stats.welfare, 100, '点'], ['国家文化', run.stats.culture, 1200, '点'],
    ['后宫', palace.length * 7 + mean(palace.map(n => n.affection)) * .5, 100, '综合点'],
    ['子嗣', run.heirs.length * 10 + mean(run.heirs.map(h => mean(Object.values(h.education)))) * .5, 100, '综合点'],
    ['自身科技', run.rulerSkills.technology, 100, '点'], ['自身政治', run.rulerSkills.politics, 100, '点'], ['自身文化', run.rulerSkills.culture, 100, '点'],
  ];
  const dimensions = dims.map(([label, value, target, unit]) => ({ label, value: `${round(value)} ${unit}`, points: Math.round(clamp(value / target * 100)) }));
  const score = Math.round(mean(dimensions.map(d => d.points)) * 10);
  const achievements: KingdomResult['achievements'] = [];
  if (kingdomLands(run).length === 12) achievements.push({ name: '天下一统', description: '将全部十二州纳入版图。' });
  if (run.stats.treasury >= 5000) achievements.push({ name: '府库充盈', description: '国库积蓄达到五千万两。' });
  if (run.stats.population >= 1000 && run.stats.welfare >= 80) achievements.push({ name: '万家安居', description: '人口千万，民生八十以上。' });
  if (run.stats.technology >= 1000) achievements.push({ name: '格物开新', description: '国家科技突破一千点。' });
  if (run.stats.culture >= 1000) achievements.push({ name: '文耀千秋', description: '国家文化突破一千点。' });
  if (palace.length >= 5 && mean(palace.map(n => n.affection)) >= 60) achievements.push({ name: '宫苑知己', description: '五位以上后宫，平均亲密六十。' });
  if (run.heirs.length >= 3) achievements.push({ name: '枝繁叶茂', description: '迎来至少三位子嗣。' });
  if (run.heirs.some(h => h.designated && mean(Object.values(h.education)) >= 60)) achievements.push({ name: '后继有人', description: '储君四项平均教育达到六十。' });
  if (Object.values(run.rulerSkills).every(n => n >= 80)) achievements.push({ name: '博学明君', description: '自身科技、政治、文化皆达八十。' });
  if (run.turn >= KINGDOM_TURNS) achievements.push({ name: '四十二载', description: '从十八岁走到六十岁，完成一朝纪事。' });
  return { score, title: score >= 850 ? '千古一帝' : score >= 650 ? '盛世明君' : score >= 450 ? '守成之主' : score >= 250 ? '风雨之君' : '待续之志', dimensions, achievements };
}

/** 唯一推进时间的入口；每次恰好一季，四季长一岁，168 季后到六十岁。 */
export function advanceKingdom(current: KingdomRun, now: number): KingdomRun {
  if (kingdomOrderReason(current)) return current;
  const run = copy(current);
  const before = { ...run.stats };
  const report: KingdomReport = { turn: run.turn, title: kingdomDate(run), entries: [], delta: {} };
  const choice = run.event.choices[run.eventChoice]!;
  // 奏报授予的国势在本季即生效，持续季数包含这一季。
  change(run, choice.effects);
  report.entries.push(`${run.event.title}：${choice.label}。`);
  if (choice.buff) {
    run.buffs = run.buffs.filter(b => b.id !== choice.buff!.id);
    run.buffs.push({ ...copy(choice.buff), source: run.event.title });
  }
  performOrder(run, report);
  const income = kingdomQuarterIncome(run);
  change(run, { treasury: income.income - income.expense, grain: income.grain,
    population: run.stats.population * (.002 + run.stats.welfare / 16000),
    technology: official(run, 'science', 'technology') * .08,
    culture: official(run, 'culture', 'culture') * .08,
    troops: official(run, 'war', 'military') * .005,
    welfare: official(run, 'civil', 'politics') * .007 - .4,
  });
  for (const id of run.policies) {
    const policy = KINGDOM_POLICIES.find(p => p.id === id)!;
    change(run, { ...policy.effects, treasury: (policy.effects.treasury ?? 0) - policy.cost });
  }
  for (const buff of kingdomBuffs(run)) change(run, buff.effects);
  personalLife(run, report);
  // 他国缓慢发展；恶劣关系时可能袭扰，但不会在停战期行动。
  for (const faction of run.factions) {
    const lands = run.provinces.filter(p => p.owner === faction.id);
    if (!lands.length) continue;
    faction.power = round(1 + run.turn / 280);
    for (const p of lands) p.garrison = round(p.garrison + .12);
    if (faction.truceUntil > run.turn || faction.relation >= 0 || random(run) > .12) continue;
    const border = kingdomLands(run).filter(p => lands.some(f => Math.abs(f.x - p.x) + Math.abs(f.y - p.y) === 1));
    if (!border.length) continue;
    const target = pick(run, border);
    if (run.stats.troops < 12 * faction.power && kingdomLands(run).length > 1) {
      target.owner = faction.id;
      change(run, { population: -25, stability: -5 });
      report.entries.push(`${faction.name}攻占${target.name}，请整军收复。`);
    } else {
      change(run, { troops: -Math.min(run.stats.troops, 1.5), grain: -35 });
      report.entries.push(`守军击退${faction.name}的边境袭扰，损兵耗粮。`);
    }
  }
  if (run.stats.grain < 0) {
    change(run, { population: -run.stats.population * .025, welfare: -5, stability: -3 });
    report.entries.push('仓粮不足，人口流失、民生与稳定下降；需增产、赈济或减少军队负担。');
  }
  if (run.stats.treasury < 0) {
    change(run, { stability: -5, troops: -Math.min(2, run.stats.troops) });
    report.entries.push('国库入不敷出，欠饷导致军士离散、稳定下降；可调整政策和商贸。');
  }
  run.buffs = run.buffs.map(b => ({ ...b, remaining: b.remaining - 1 })).filter(b => b.remaining > 0);
  settleBounds(run);
  for (const m of KINGDOM_METRICS) report.delta[m.id] = round(run.stats[m.id] - before[m.id]);
  run.reports.push(report);
  run.turn += 1;
  run.updatedAt = now;
  if (run.turn === KINGDOM_TURNS) run.result = scoreKingdom(run);
  else { run.event = nextEvent(run); run.eventChoice = 0; }
  if (run.provinces.find(p => p.id === run.plan.targetProvince)?.owner === 'player' && run.plan.action === 'war') run.plan.action = 'farm';
  run.plan.troops = Math.max(1, Math.min(run.plan.troops, Math.floor(run.stats.troops)));
  return run;
}
