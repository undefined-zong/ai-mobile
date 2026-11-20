import { parseControlTags } from '@app/shared';
import { catalogItem, type DecorItem } from './model';

export type Resident = 'you' | 'her';
export const ACTION_LABELS = {
  idle: '休息片刻', stand: '站起来', approach: '走过去', sit: '坐下', lie: '躺下',
  bathe: '泡澡', toilet: '坐马桶', eat: '坐下吃饭', cook: '做饭', work: '学习工作',
  radio_on: '打开收音机', radio_off: '关闭收音机', tv_on: '打开电视', tv_off: '关闭电视', watch_tv: '看电视',
} as const;
export type ActivityType = keyof typeof ACTION_LABELS;
export interface RoomAction { type: ActivityType; target: string | null }
export interface ResidentActivity extends RoomAction { phase: 'idle' | 'walking' | 'active'; label: string }
export interface ActionResult { ok: boolean; reason?: string; cancelled?: boolean }
export interface LifeDecision { line: string; expr?: string; action: RoomAction }
export interface BubbleAnchor { x: number; y: number; visible: boolean }
export type BubbleAnchors = Record<Resident, BubbleAnchor>;
export const idleActivity = (): ResidentActivity => ({ type: 'idle', target: null, phase: 'idle', label: '站在房间里' });

const BATHS = new Set(['bathtub', 'hinokiBath']);
const KITCHENS = new Set(['stove', 'islandKitchen', 'ryokanKitchen', 'galleyKitchen', 'nutritionStation']);
const TABLES = new Set(['dining', 'diningLong', 'lowtable', 'coffee', 'stoneTable', 'kotatsu', 'carriageTable', 'canteenTable', 'holoTable']);
const DESKS = new Set(['desk', 'lectureDesk', 'workstation', 'labBench', 'cyberConsole', 'zenDesk', 'foldingDesk', 'lectern']);

/** 家具的生活用途与外观分开；五套风格共用相同的动作协议。 */
export function furnitureActions(item: DecorItem, powered = false): ActivityType[] {
  if (BATHS.has(item.kind)) return ['bathe', 'approach'];
  if (item.kind === 'toilet') return ['toilet', 'approach'];
  if (item.kind === 'radio') return [powered ? 'radio_off' : 'radio_on', 'approach'];
  if (item.kind === 'tv') return powered ? ['tv_off', 'watch_tv', 'approach'] : ['tv_on', 'watch_tv', 'approach'];
  if (KITCHENS.has(item.kind)) return ['cook', 'approach'];
  if (TABLES.has(item.kind)) return ['eat', 'approach'];
  if (DESKS.has(item.kind)) return ['work', 'approach'];
  const cat = catalogItem(item.kind);
  if (cat?.beds?.length) return ['lie', 'approach'];
  if (cat?.seats?.length) return ['sit', 'approach'];
  return ['approach'];
}

export function parseLifeDecision(value: unknown): LifeDecision | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const a = v.action as Record<string, unknown> | undefined;
  if (!a || typeof a.type !== 'string' || !Object.hasOwn(ACTION_LABELS, a.type)) return null;
  const type = a.type as ActivityType;
  if (type !== 'idle' && type !== 'stand' && typeof a.target !== 'string') return null;
  return {
    line: typeof v.line === 'string' ? parseControlTags(v.line, []).visible.trim().slice(0, 100) : '',
    ...(typeof v.expr === 'string' ? { expr: v.expr } : {}),
    action: { type, target: type === 'idle' || type === 'stand' ? null : a.target as string },
  };
}

