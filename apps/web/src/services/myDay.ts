import { getScene, MEAL_LABEL, rhythmDate, shiftDate, zonedInstant, type Message, type MessagePart } from '@app/shared';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { useEnvironmentStore } from '@/stores/environment';
import { useHealthStore } from '@/stores/health';
import { useHomeStore } from '@/stores/home';
import { usePersonaStore } from '@/stores/personas';

/**
 * 我的一天（"我的世界 → 今天的你"、日记里的"今天和你"）：全是真的记录，不编——
 * - 聊天里的记录卡片：健身的运动卡、一起吃饭的饭卡、陪伴学习的学习卡、约会回忆、观影票根、一起看书、一起玩的一局、通话、家务、分享的歌；
 * - 一起做事的场景开始（哄睡、一起听歌、心跳、出逃……这几件没有结束卡片）；
 * - 健身的运动记录（"健身"结束时记的，手表推来的也算）；家务系统里今天勾掉的。
 * 一天按节律日算（凌晨 4 点开始，按"环境与作息"的时区）。
 */

export interface DayEvent {
  key: string;
  at: number;
  /** 和谁（没有 = 你自己） */
  characterId: string | null;
  icon: string;
  title: string;
  detail: string;
  /** 点了去哪：聊天里那条消息 */
  chatId?: string;
  messageId?: string;
  kind: 'workout' | 'meal' | 'study' | 'date' | 'watch' | 'read' | 'game' | 'call' | 'chore' | 'music' | 'scene';
}

export interface DayStats {
  date: string;
  /** 运动：分钟、步数、公里（运动记录里有的才算） */
  workoutMin: number;
  steps: number;
  km: number;
  /** 记了哪几顿（早饭、午饭、晚饭） */
  meals: { breakfast: string | null; lunch: string | null; dinner: string | null };
  studyMin: number;
  pomodoros: number;
  /** 昨晚：哄睡开始的时刻、估计睡了几个小时（第二天第一次说话为止） */
  sleep: { bed: number; hours: number | null } | null;
  /** 家务：做完几件 / 一共几件（开了家务系统时） */
  chores: { done: number; total: number } | null;
  lastSong: string | null;
}

const DAY_START_MIN = 4 * 60;

/** 节律日的起止（毫秒）：凌晨 4 点到第二天凌晨 4 点 */
export function dayBounds(date: string, timeZone: string): [number, number] {
  return [zonedInstant(date, DAY_START_MIN, timeZone), zonedInstant(shiftDate(date, 1), DAY_START_MIN, timeZone)];
}

export function todayDate(): string {
  return rhythmDate(new Date(), useEnvironmentStore().settings.timezone);
}

const GAME_NAME: Record<string, string> = { soup: '海龟汤', truthdare: '真心话大冒险', flight: '飞行棋', decor: '装修小屋', workshop: '创意工坊', brawl: '大乱斗' };
/** 没有结束卡片、只看"开始"的那几件事 */
const ENTER_ONLY = new Set(['sleep', 'music', 'heart', 'escape', 'home', 'poke', 'rest']);

const minutes = (sec: number) => Math.max(1, Math.round(sec / 60));

/**
 * 一张卡片写成一件事；不是记录的卡片（邀请、拍一拍、玩具指令……）为空。
 * name 是角色的名字；withWho 是"和谁一起"里的那个人（默认是她；写进她的日记时空着，写成"一起"）
 */
export function partEvent(p: MessagePart, name: string, withWho = name): Pick<DayEvent, 'kind' | 'icon' | 'title' | 'detail'> | null {
  const together = withWho ? `和${withWho}一起` : '一起';
  switch (p.type) {
    case 'workout':
      return { kind: 'workout', icon: 'i-lucide-dumbbell', title: p.mode === 'plan' && p.plan ? `照计划练「${p.plan.title}」` : p.sport, detail: [`${minutes(p.durationSec)} 分钟`, p.distanceKm ? `${p.distanceKm.toFixed(1)} 公里` : '', p.steps ? `${p.steps} 步` : ''].filter(Boolean).join(' · ') };
    case 'meal':
      return { kind: 'meal', icon: 'i-lucide-utensils', title: `${MEAL_LABEL[p.meal] ?? '吃饭'} · ${p.food}`, detail: p.how === 'together' ? `${together}吃` : p.how === 'solo' ? `${name}陪着` : '' };
    case 'study':
      return { kind: 'study', icon: 'i-lucide-book-open', title: `学习 ${p.minutes} 分钟`, detail: [p.pomodoros ? `${p.pomodoros} 段` : '', p.tasks?.length ? `完成 ${p.tasks.filter((t) => t.done).length}/${p.tasks.length} 件` : '', p.together ? `${together}专注` : ''].filter(Boolean).join(' · ') };
    case 'date':
      return p.status === 'memory' ? { kind: 'date', icon: 'i-lucide-heart-handshake', title: `约会 · ${p.place}`, detail: p.minutes ? `${p.minutes} 分钟` : '' } : null;
    case 'watch':
      return { kind: 'watch', icon: 'i-lucide-clapperboard', title: `看了《${p.title}》`, detail: `${p.minutes} 分钟${p.herScore ? ` · ${name}打了 ${p.herScore} 分` : ''}` };
    case 'read':
      return { kind: 'read', icon: 'i-lucide-book-marked', title: `一起读《${p.title}》`, detail: [p.chapter, `${p.progress}%`].filter(Boolean).join(' · ') };
    case 'game':
      return { kind: 'game', icon: 'i-lucide-gamepad-2', title: `玩了${GAME_NAME[p.game] ?? '一局'}`, detail: p.game === 'soup' ? p.title : p.game === 'workshop' ? p.title : '' };
    case 'call-log':
      return !p.missed && p.durationSec > 0 ? { kind: 'call', icon: p.video ? 'i-lucide-video' : 'i-lucide-phone', title: p.video ? '视频通话' : '通话', detail: `${minutes(p.durationSec)} 分钟` } : null;
    case 'chore':
      return p.status === 'done' ? { kind: 'chore', icon: 'i-lucide-house', title: `家务 · ${p.name}`, detail: p.minutes ? `${p.minutes} 分钟` : '' } : null;
    case 'music':
      return { kind: 'music', icon: 'i-lucide-music-2', title: `《${p.title}》`, detail: p.artist };
    case 'scene': {
      if (p.event !== 'enter' || !ENTER_ONLY.has(p.sceneId)) return null;
      const s = getScene(p.sceneId);
      return { kind: 'scene', icon: s.icon, title: s.name, detail: p.title && p.title !== s.name ? p.title : '' };
    }
    default:
      return null;
  }
}

/** 这一条聊天在这段时间里的消息（内存里有的：每条聊天最近的几百条） */
function messagesIn(chatId: string, from: number, to: number): Message[] {
  return useChatStore().list(chatId).filter((m) => m.createdAt >= from && m.createdAt < to);
}

/** 这一天发生的事（所有角色），从早到晚 */
export function dayEvents(date = todayDate()): DayEvent[] {
  const tz = useEnvironmentStore().settings.timezone;
  const [from, to] = dayBounds(date, tz);
  const chars = useCharacterStore();
  const chat = useChatStore();
  const out: DayEvent[] = [];
  const workoutLogs = new Set<string>();
  for (const c of chat.chats) {
    const ch = chars.byId(c.characterId);
    if (!ch) continue;
    for (const m of messagesIn(c.id, from, to)) {
      m.parts.forEach((p, i) => {
        const e = partEvent(p, ch.name);
        if (!e) return;
        if (p.type === 'workout') workoutLogs.add(p.logId);
        out.push({ ...e, key: `${m.id}:${i}`, at: m.createdAt, characterId: ch.id, chatId: c.id, messageId: m.id });
      });
    }
  }
  // 运动记录里有、聊天里没发卡片的（只在手表上练的、没发给她的）
  const persona = usePersonaStore().defaultPersona;
  for (const l of useHealthStore().logsOf(persona.id, date)) {
    if (l.date !== date || workoutLogs.has(l.id)) continue;
    out.push({
      key: `log:${l.id}`, at: l.startedAt, characterId: l.characterId, kind: 'workout', icon: 'i-lucide-dumbbell',
      title: l.mode === 'plan' && l.plan ? `照计划练「${l.plan.title}」` : l.sport,
      detail: [`${minutes(l.durationSec)} 分钟`, l.distanceKm ? `${l.distanceKm.toFixed(1)} 公里` : '', l.steps ? `${l.steps} 步` : ''].filter(Boolean).join(' · '),
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 今天的你：几个数（全按真的记录算，没有的就是 0 / 空） */
export function dayStats(date = todayDate(), events = dayEvents(date)): DayStats {
  const tz = useEnvironmentStore().settings.timezone;
  const persona = usePersonaStore().defaultPersona;
  const chat = useChatStore();
  // 运动：运动记录为准（聊天里的运动卡也来自它）
  const logs = useHealthStore().logsOf(persona.id, date).filter((l) => l.date === date);
  const fromCards = events.filter((e) => e.kind === 'workout' && !e.key.startsWith('log:'));
  const workoutMin = logs.length
    ? logs.reduce((n, l) => n + minutes(l.durationSec), 0)
    : fromCards.reduce((n, e) => n + (Number(/(\d+) 分钟/.exec(e.detail)?.[1]) || 0), 0);
  let steps = logs.reduce((n, l) => n + (l.steps ?? 0), 0);
  let km = logs.reduce((n, l) => n + (l.distanceKm ?? 0), 0);
  // 三餐、学习、听歌（没有运动记录时，运动的步数和距离也从卡片上取）：聊天里的卡片
  const meals: DayStats['meals'] = { breakfast: null, lunch: null, dinner: null };
  let studyMin = 0;
  let pomodoros = 0;
  let lastSong: string | null = null;
  const [from, to] = dayBounds(date, tz);
  for (const c of chat.chats) {
    for (const m of messagesIn(c.id, from, to)) {
      for (const p of m.parts) {
        if (p.type === 'workout' && !logs.length) {
          steps += p.steps ?? 0;
          km += p.distanceKm ?? 0;
        } else if (p.type === 'meal' && p.meal in meals) meals[p.meal as keyof typeof meals] ??= p.food;
        else if (p.type === 'study') {
          studyMin += p.minutes;
          pomodoros += p.pomodoros;
        } else if (p.type === 'music') lastSong = p.title;
      }
    }
  }
  // 家务：开了家务系统时今天的清单
  let chores: DayStats['chores'] = null;
  if (persona.housework?.enabled && useHomeStore().today === date) {
    const items = useHomeStore().itemsFor(persona);
    if (items.length) chores = { done: items.filter((i) => i.mark.status === 'done').length, total: items.length };
  }
  return { date, workoutMin, steps, km: Math.round(km * 10) / 10, meals, studyMin, pomodoros, sleep: lastSleep(date), chores, lastSong };
}

/**
 * 昨晚的睡眠：这一天开始前后（前一天 18:00 到这天 10:00）最后一次进哄睡的时刻；
 * 睡了多久按之后第一次在聊天里说话算（3 到 14 小时之间才算，不然不写）
 */
function lastSleep(date: string): DayStats['sleep'] {
  const tz = useEnvironmentStore().settings.timezone;
  const chat = useChatStore();
  const from = zonedInstant(shiftDate(date, -1), 18 * 60, tz);
  const to = zonedInstant(date, 10 * 60, tz);
  let bed = 0;
  for (const c of chat.chats) {
    for (const m of messagesIn(c.id, from, to)) {
      const p = m.parts[0];
      if (p?.type === 'scene' && p.event === 'enter' && p.sceneId === 'sleep' && m.createdAt > bed) bed = m.createdAt;
    }
  }
  if (!bed) return null;
  let woke = Infinity;
  for (const c of chat.chats) {
    for (const m of messagesIn(c.id, bed + 3 * 3_600_000, bed + 14 * 3_600_000)) {
      if (m.role === 'user' && m.createdAt < woke) woke = m.createdAt;
    }
  }
  return { bed, hours: Number.isFinite(woke) ? Math.round(((woke - bed) / 3_600_000) * 10) / 10 : null };
}

/** 今天的一句话（"环境与作息"里的今日活动预览） */
export function dayLine(s: DayStats): string {
  const parts: string[] = [];
  if (s.workoutMin) parts.push(`你今天运动了 ${s.workoutMin} 分钟${s.steps ? `（${s.steps.toLocaleString('zh-CN')} 步）` : ''}`);
  const ate = (['breakfast', 'lunch', 'dinner'] as const).filter((k) => s.meals[k]).map((k) => `${MEAL_LABEL[k]}吃了${s.meals[k]}`);
  if (ate.length) parts.push(ate.join('，'));
  if (s.studyMin) parts.push(`学习了 ${s.studyMin} 分钟`);
  if (s.chores) parts.push(`家务做了 ${s.chores.done}/${s.chores.total}`);
  return parts.length ? parts.join('，') : '你今天还没有记录（运动、吃饭、学习这些在一起做事时会自动记下）';
}

/**
 * 这一天你和这个角色（日记里的"今天和你"）：一起做过的事，加上聊天里说过的话（每句截短，最多几十句）。
 * 没有就是空字符串
 */
export function withUserText(characterId: string, date: string, userName: string, maxLines = 40): string {
  const tz = useEnvironmentStore().settings.timezone;
  const [from, to] = dayBounds(date, tz);
  const chat = useChatStore();
  const c = chat.chatOfCharacter(characterId);
  const ch = useCharacterStore().byId(characterId);
  if (!c || !ch) return '';
  const lines: string[] = [];
  const time = (at: number) => new Intl.DateTimeFormat('zh-CN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(at);
  for (const m of messagesIn(c.id, from, to)) {
    for (const p of m.parts) {
      const e = partEvent(p, ch.name, '');
      if (e) lines.push(`${time(m.createdAt)} [${m.role === 'user' ? `${userName}：` : ''}${e.title}${e.detail ? ` · ${e.detail}` : ''}]`);
    }
    const text = m.text?.replace(/\s+/g, ' ').trim();
    if (text && (m.role === 'user' || m.role === 'assistant')) lines.push(`${time(m.createdAt)} ${m.role === 'user' ? userName : ch.name}：${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
  }
  // 太多时留下开头几句和后面的大部分（一天的样子都在）
  const kept = lines.length > maxLines ? [...lines.slice(0, 6), '……', ...lines.slice(-(maxLines - 7))] : lines;
  return kept.join('\n');
}
