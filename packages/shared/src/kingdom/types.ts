export type KingdomRole = 'minister' | 'consort' | 'foreign';
export type KingdomOffice = 'civil' | 'war' | 'science' | 'culture';
export type KingdomFocus = 'politics' | 'technology' | 'culture' | 'audience' | 'palace' | 'education';
export type KingdomAction = 'rest' | 'farm' | 'trade' | 'research' | 'academy' | 'relief' | 'recruit' | 'talent' | 'visit' | 'diplomacy' | 'war';
export type KingdomMetric = 'treasury' | 'grain' | 'population' | 'troops' | 'technology' | 'welfare' | 'culture' | 'stability';
export type KingdomStats = Record<KingdomMetric, number>;
export type KingdomSkills = Record<'politics' | 'military' | 'technology' | 'culture', number>;
export interface KingdomDynasty {
  id: string; name: string; setting: string; clothing: string;
  offices: Record<KingdomOffice, string>; surnames: string[];
}
export interface KingdomScenario {
  id: string; name: string; description: string; stats: KingdomStats;
}
export interface KingdomPolicy {
  id: string; name: string; description: string; cost: number;
  effects: Partial<KingdomStats>; group: string;
}
export interface KingdomPortrait { assetKey: string | null; url?: string; prompt: string; negative: string; seed: number | null; model: string }
export interface KingdomNpc {
  id: string; name: string; role: KingdomRole; title: string; age: number; joinedTurn: number;
  personality: string; biography: string; appearanceTags: string;
  skills: KingdomSkills; loyalty: number; affection: number;
  factionId?: string; characterId?: string; characterDescription?: string;
  portrait?: KingdomPortrait; pregnancyDue?: number;
  gender: 'female' | 'male';
}
export interface KingdomHeir {
  id: string; name: string; parentId: string; bornTurn: number;
  gender: 'female' | 'male'; education: KingdomSkills; designated: boolean;
}
export interface KingdomProvince {
  id: string; name: string; owner: string; x: number; y: number;
  terrain: 'plain' | 'mountain' | 'river'; development: number; garrison: number;
}
export interface KingdomFaction { id: string; name: string; relation: number; power: number; truceUntil: number }
export interface KingdomBuff {
  id: string; name: string; description: string; source: string;
  remaining: number; effects: Partial<KingdomStats>; attack?: number;
}
export interface KingdomPlan {
  action: KingdomAction; focus: KingdomFocus;
  targetProvince: string; targetNpc: string; targetFaction: string;
  troops: number; tactic: 'balanced' | 'assault' | 'siege';
}
export interface KingdomEvent {
  id: string; title: string; text: string;
  choices: { label: string; effects: Partial<KingdomStats>; buff?: Omit<KingdomBuff, 'source'> }[];
}
export interface KingdomReport {
  turn: number; title: string; entries: string[]; delta: Partial<KingdomStats>;
  narrative?: string; battle?: { target: string; won: boolean; chance: number; losses: number };
}
export interface KingdomScore { label: string; value: string; points: number }
export interface KingdomResult { score: number; title: string; dimensions: KingdomScore[]; achievements: { name: string; description: string }[] }
export interface KingdomRun {
  id: string; createdAt: number; updatedAt: number; seed: number; turn: number;
  name: string; ruler: string; rulerTitle: string; era: string; dynastyId: string; setting: string; scenarioId: string;
  stats: KingdomStats; rulerSkills: Pick<KingdomSkills, 'politics' | 'technology' | 'culture'>;
  npcs: KingdomNpc[]; heirs: KingdomHeir[]; provinces: KingdomProvince[]; factions: KingdomFaction[];
  cabinet: Record<KingdomOffice, string>; policies: string[]; buffs: KingdomBuff[];
  plan: KingdomPlan; event: KingdomEvent; eventChoice: number;
  reports: KingdomReport[]; victories: number; result: KingdomResult | null;
  conversations: { npcId: string; turn: number; user: string; reply: string }[];
}
export interface KingdomSetup {
  name: string; ruler: string; rulerTitle: string; era: string; dynastyId: string; setting: string; scenarioId: string;
  participants: { characterId: string; name: string; description: string; appearanceTags: string; gender: 'female' | 'male'; role: KingdomRole }[];
}
