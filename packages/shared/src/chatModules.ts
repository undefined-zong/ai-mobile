import type { ControlTagKind } from './tags.ts';

/**
 * 聊天里她能主动调用的模块：分享歌曲 [music:]、打电话 [call]、约学习 [study:]、约看片 [watch:]、约游戏 [game:]、玩具指令 <device>。
 *
 * 开不开由她绑定的世界书决定（自带的"聊天 · 主动卡片"世界书每个模块一条，开关那一条就开关那个模块）：
 * - 有一条开着的条目教了这个写法（内容里写了 [watch:…]）→ 开；
 * - 只有关着的条目教了它 → 关；
 * - 世界书里都没提 → 按默认（歌曲、打电话照旧能用，其余不开）。
 * 所以自己写的、导入的世界书只要内容里写了这些写法也一样能开关。游戏还能一个个开关（allowedInviteGames）。
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

/** 世界书能开关的模块（都是聊天里的标签） */
export const MODULE_TAGS = ['music', 'call', 'study', 'watch', 'game', 'device'] as const satisfies readonly ControlTagKind[];
export type ModuleTag = (typeof MODULE_TAGS)[number];

/** 条目内容里写了哪个写法，就算教了哪个模块 */
const TEACHES: Record<ModuleTag, RegExp> = {
  music: /[[【]music[:：]/i,
  call: /[[【]call[\]】]/i,
  study: /[[【]study[:：\]】]/i,
  watch: /[[【]watch[:：]/i,
  game: /[[【]game[:：]/i,
  device: /<device\s*>/i,
};

/** 她绑定的世界书条目 → 每个模块开（true）、关（false），没提到的不写 */
export function moduleSwitches(entries: readonly { content: string; enabled: boolean }[]): Partial<Record<ModuleTag, boolean>> {
  const out: Partial<Record<ModuleTag, boolean>> = {};
  for (const tag of MODULE_TAGS) {
    const taught = entries.filter((e) => TEACHES[tag].test(e.content));
    if (taught.length) out[tag] = taught.some((e) => e.enabled);
  }
  return out;
}

/**
 * 每个游戏单独开关：条目里写了 [game:海龟汤] 就是海龟汤的开关。
 * 有开着的游戏条目时只约开着的那几个；一个具体的游戏都没提（只写了 [game:游戏名]）时除了关掉的都能约
 */
export function allowedInviteGames(entries: readonly { content: string; enabled: boolean }[]): InviteGameId[] {
  const sw: Partial<Record<InviteGameId, boolean>> = {};
  for (const e of entries) {
    for (const m of e.content.matchAll(/[[【]game[:：]([^\]】\n]+)[\]】]/gi)) {
      const id = inviteGame(m[1] ?? '');
      if (id) sw[id] = sw[id] === true || e.enabled;
    }
  }
  const on = INVITE_GAMES.filter((g) => sw[g.id]).map((g) => g.id);
  return on.length ? on : INVITE_GAMES.filter((g) => sw[g.id] !== false).map((g) => g.id);
}

/** 按世界书的开关调整这个场景能用的标签 */
export function applyModuleSwitches(base: readonly ControlTagKind[], switches: Partial<Record<ModuleTag, boolean>>): ControlTagKind[] {
  const out = base.filter((t) => switches[t as ModuleTag] !== false);
  for (const tag of MODULE_TAGS) if (switches[tag] && !out.includes(tag)) out.push(tag);
  return out;
}
