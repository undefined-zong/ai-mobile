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

export const LIFE_PROTOCOL = `你控制的是角色自己的小人（her），用户的小人（you）由用户操作。观察下面当前房间、双方姿态、家具占用和设备的实际状态，选择一个此刻可执行的动作。只使用当前房间列出的家具编号和可用动作，不能改动家具或替用户行动。用户在休息时轻声说话；不要连续反复开关设备、反复起坐。正在做的事可以继续，选择 idle 表示保持当前姿态。未接通音乐服务或没有歌单时不要声称音乐已经响起。
只返回一个 JSON 对象：{"line":"头顶气泡里的一两句自然口语，60字以内；在动作发生前说意图，不谎称已做完","expr":"表情","action":{"type":"动作名","target":"家具编号，idle/stand 时为 null"}}。
动作：idle 保持现状，stand 起身，approach 走近家具，sit 坐下，lie 躺床，bathe 进入浴缸泡澡，toilet 坐马桶，eat 坐到餐桌旁吃饭，cook 站在灶台前做饭，work 在课桌/工位学习工作，radio_on/radio_off 开关真实收音机，tv_on/tv_off 开关电视，watch_tv 坐着或站着看电视。只能从每件家具的 availableActions 中选择。动作结果会在下次观察里反馈。`;
