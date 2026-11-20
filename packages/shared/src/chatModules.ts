import type { ControlTagKind } from './tags.ts';

/**
 * 聊天里她能主动调用的模块：分享歌曲 [music:]、打电话 [call]、约学习 [study:]、约看片 [watch:]、约游戏 [game:]、哄睡 [sleep]、一起运动 [exercise]、平行时空 [parallel]、玩具指令 <device>。
 *
 * 日常聊天默认支持全部模块和游戏，世界书只提供提示词内容。
 */

/** 一起游戏里能约的游戏（和 apps/web 的 GameScene 里的 GAMES 一一对应） */
export const INVITE_GAMES = [
  { id: 'kingdom', label: '王国模拟', alias: ['王国', '王朝', '皇帝', 'kingdom'] },
  { id: 'brawl', label: '大乱斗', alias: ['乱斗', '格斗', 'brawl'] },
  { id: 'soup', label: '海龟汤', alias: ['龟汤', 'soup'] },
  { id: 'truthdare', label: '真心话大冒险', alias: ['真心话', '大冒险', 'truthdare'] },
  { id: 'flight', label: '飞行棋', alias: ['flight'] },
  { id: 'decor', label: '装修小屋', alias: ['装修', '小屋', 'decor'] },
  { id: 'workshop', label: '创意工坊', alias: ['工坊', 'workshop'] },
] as const;

export type InviteGameId = (typeof INVITE_GAMES)[number]['id'];

/** [game:] 里写的名字 → 游戏 id（认 id、中文名和几个常见叫法）；认不出来为 null */
export function inviteGame(value: string): InviteGameId | null {
  const t = value.trim().toLowerCase();
  if (!t) return null;
  const hit = INVITE_GAMES.find((g) => g.id === t || g.label === t) ?? INVITE_GAMES.find((g) => g.label.includes(t) || t.includes(g.label) || g.alias.some((a) => t.includes(a)));
  return hit?.id ?? null;
}

export function inviteGameLabel(id: string): string {
  return INVITE_GAMES.find((g) => g.id === id)?.label ?? id;
}

const split = (value: string) =>
  value
    .split(/[|｜]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** [study:任务|分钟]：两项都可以不写，顺序也不限；分钟限在 5–180 */
export function parseStudyInvite(value: string): { kind: 'study'; task: string; minutes: number | null } {
  let minutes: number | null = null;
  const rest: string[] = [];
  for (const bit of split(value)) {
    const m = /^(\d{1,3})\s*(?:分钟|分|min(?:ute)?s?|m)?$/i.exec(bit);
    if (m && minutes === null) minutes = Math.min(180, Math.max(5, Number(m[1])));
    else rest.push(bit);
  }
  return { kind: 'study', task: rest.join(' ').slice(0, 60), minutes };
}

/** [watch:片名|链接]：链接是带 http 的地址或 B 站 BV 号；片名和链接至少要有一个 */
export function parseWatchInvite(value: string): { kind: 'watch'; title: string; link: string } | null {
  const bits = split(value);
  const link = bits.find((b) => /^https?:\/\/\S+$/i.test(b) || /^BV[0-9A-Za-z]{10}$/.test(b)) ?? '';
  const title = bits
    .filter((b) => b !== link)
    .join(' ')
    .replace(/^《(.+)》$/, '$1')
    .slice(0, 80);
  return title || link ? { kind: 'watch', title, link } : null;
}

/** 日常聊天支持的主动卡片模块 */
export const MODULE_TAGS = ['music', 'call', 'study', 'watch', 'game', 'sleep', 'exercise', 'parallel', 'device'] as const satisfies readonly ControlTagKind[];
export type ModuleTag = (typeof MODULE_TAGS)[number];

/** 模块的中文名（和"聊天 · 主动卡片"世界书的条目标题一致） */
export const MODULE_LABELS: Record<ModuleTag, string> = {
  music: '一起听歌',
  call: '打电话',
  study: '约一起学习',
  watch: '约一起看片',
  game: '约游戏',
  sleep: '哄睡',
  exercise: '一起运动',
  parallel: '平行时空',
  device: '玩具指令（成人）',
};

/**
 * 副对话预设里主动卡片那几块的触发条件："card:music"……，游戏按类型分块："card:game:soup"。
 * 按这一轮处理的标签发送对应提示块；游戏模块包含全部游戏。
 */
export const CARD_FLAG_PREFIX = 'card:';
export type CardKey = ModuleTag | `game:${InviteGameId}`;

export function cardFlag(key: CardKey): string {
  return `${CARD_FLAG_PREFIX}${key}`;
}

/** 这一轮发送的卡片提示块，游戏模块包含所有注册游戏 */
export function cardFlags(tags: readonly ControlTagKind[]): string[] {
  const on = MODULE_TAGS.filter((t) => tags.includes(t));
  return [...on.map((t) => cardFlag(t)), ...(on.includes('game') ? INVITE_GAMES.map((g) => cardFlag(`game:${g.id}`)) : [])];
}

/** 卡片块触发条件的中文名（预设编辑页里选） */
export const CARD_FLAGS: Record<string, string> = Object.fromEntries([
  ...MODULE_TAGS.map((t) => [cardFlag(t), `主动卡片：${MODULE_LABELS[t]}`]),
  ...INVITE_GAMES.map((g) => [cardFlag(`game:${g.id}`), `主动卡片：游戏 · ${g.label}`]),
]);
