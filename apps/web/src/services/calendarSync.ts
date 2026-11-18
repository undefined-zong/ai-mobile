import { errorText, type McpCallResult } from '@app/ai';
import {
  dayMinute,
  rhythmDate,
  RHYTHM_DAY_START_HOUR,
  shiftDate,
  toMinutes,
  zonedInstant,
  zonedParts,
  type CaptureBusy,
  type ISODate,
  type McpServerConfig,
  type ParallelCalendarLink,
  type ParallelItem,
  type Persona,
} from '@app/shared';
import { localOpener } from './mcp';
import { useEnvironmentStore } from '@/stores/environment';
import { useHubStore } from '@/stores/hub';
import { useParallelStore } from '@/stores/parallel';

/**
 * 平行时空里记的事同步进 Google 日历（设计文档 §9.16）：用人设日程系统里接的那台 Google 日历（同一份 OAuth，不用再登录一次）。
 * - 在云端授权的（Token 在 Worker 里）让 Worker 调（/v1/planner/mcp/:id/call）；在手机上授权的本机直连 Google 日历 API；
 * - 只碰我们自己建的那几条（记在 ParallelItem.calendar 上）：记的时候建，改时间、名字、补充时跟着改，删掉时一起删；
 * - AI 记一件事时先看一眼这几天日历里已有的，排时间时避开。
 */

const GOOGLE_CALENDAR = /^https:\/\/calendarmcp\.googleapis\.com\/mcp\/v1\/?$/;
const CALENDAR_ID = 'primary';
/** 没写多久的事在日历里占多久 */
const DEFAULT_MINUTES = 30;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export type CalendarState = { ok: true; server: McpServerConfig } | { ok: false; reason: string; fix: string };

/** 这个人设能不能同步进 Google 日历；不能时说明原因、去哪改 */
export function calendarState(persona: Persona): CalendarState {
  const fix = `/me/personas/${persona.id}/planner`;
  const server = persona.planner?.servers.find((s) => s.kind === 'calendar' && GOOGLE_CALENDAR.test(s.url));
  if (!server) return { ok: false, reason: '人设的日程系统里还没接 Google 日历', fix };
  if (!server.enabled) return { ok: false, reason: 'Google 日历在日程系统里关着', fix };
  if (server.auth === 'oauth' && !server.authorized) return { ok: false, reason: 'Google 日历还没授权', fix };
  if (server.authorized?.via === 'hub') {
    const hub = useHubStore();
    if (!hub.connected) return { ok: false, reason: 'Google 日历是在云端授权的：先连上云端', fix: '/me/sync' };
    if (hub.status && !hub.supportsMcpCall) return { ok: false, reason: '云端的 Worker 版本太旧，不能替你写 Google 日历：部署最新 main 的 Worker', fix: '/me/sync' };
  }
  return { ok: true, server };
}

/** 调日历的一个工具，读回 JSON */
async function call(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<unknown> {
  let result: McpCallResult;
  if (server.authorized?.via === 'hub') {
    const hub = useHubStore();
    if (!hub.connected) throw new Error('Google 日历是在云端授权的：先连上云端');
    await hub.ensureStatus();
    result = await hub.mcpCall(server, tool, args);
  } else {
    const session = await localOpener(AbortSignal.timeout(60_000))(server);
    try {
      result = await session.call(tool, args);
    } finally {
      await session.close();
    }
  }
  if (result.isError) throw new Error(result.text.slice(0, 300) || 'Google 日历出错了');
  try {
    return JSON.parse(result.text) as unknown;
  } catch {
    return result.text;
  }
}

/** 节律日 date 上的一件事 → 日历里的开始、结束：凌晨 4 点前的算第二天；不定时的写成那天的全天日程 */
function eventTimes(date: ISODate, item: Pick<ParallelItem, 'time' | 'minutes'>, timeZone: string): Record<string, string> {
  const m = item.time ? toMinutes(item.time) : null;
  if (m === null) return { start: date, end: shiftDate(date, 1) };
  const day = m < RHYTHM_DAY_START_HOUR * 60 ? shiftDate(date, 1) : date;
  const at = zonedInstant(day, m, timeZone);
  return { start: new Date(at).toISOString(), end: new Date(at + (item.minutes || DEFAULT_MINUTES) * 60_000).toISOString(), timeZone };
}

function eventBody(date: ISODate, item: ParallelItem): Record<string, unknown> {
  const description = [
    item.note,
    item.checklist.length ? `清单：${item.checklist.map((c) => c.text).join('、')}` : '',
    '（在平行时空里记的）',
  ].filter(Boolean).join('\n');
  return { calendarId: CALENDAR_ID, summary: item.title, description, ...eventTimes(date, item, useEnvironmentStore().settings.timezone) };
}

function serverOf(persona: Persona, link: ParallelCalendarLink): McpServerConfig {
  const server = persona.planner?.servers.find((s) => s.id === link.serverId);
  if (!server) throw new Error('记的时候用的那台 Google 日历已经从日程系统里删掉了');
  return server;
}

/** 已经不在日历里了（你在 Google 日历里删过）：当作删掉了 */
const gone = (e: unknown) => /Google API (404|410)/.test(errorText(e));

/** 把平行时空里记的一件事写进 Google 日历，记下是哪一条（已经写过的不再写） */
export async function linkToCalendar(persona: Persona, date: ISODate, itemId: string): Promise<void> {
  const parallel = useParallelStore();
  const item = parallel.itemOf(persona.id, date, itemId);
  if (!item || item.calendar) return;
  const state = calendarState(persona);
  if (!state.ok) throw new Error(state.reason);
  const res = await call(state.server, 'create_event', eventBody(date, item));
  const eventId = isObj(res) && typeof res.id === 'string' ? res.id : '';
  if (!eventId) throw new Error('Google 日历没有返回日程 ID');
  parallel.updateItem(persona.id, date, itemId, { calendar: { serverId: state.server.id, calendarId: CALENDAR_ID, eventId, at: Date.now() } });
}

/** 改过时间、名字、补充、清单的：日历里那一条跟着改（没同步过的不管；日历里被删了的就不再跟） */
export async function syncItemCalendar(persona: Persona, date: ISODate, itemId: string): Promise<void> {
  const parallel = useParallelStore();
  const item = parallel.itemOf(persona.id, date, itemId);
  const link = item?.calendar;
  if (!item || !link) return;
  try {
    await call(serverOf(persona, link), 'update_event', { ...eventBody(date, item), calendarId: link.calendarId, eventId: link.eventId });
  } catch (e) {
    if (!gone(e)) throw e;
    delete item.calendar;
  }
}

/** 删掉一件之前：日历里那一条也删掉 */
export async function unlinkCalendar(persona: Persona, item: ParallelItem): Promise<void> {
  const link = item.calendar;
  if (!link) return;
  try {
    await call(serverOf(persona, link), 'delete_event', { calendarId: link.calendarId, eventId: link.eventId });
  } catch (e) {
    if (!gone(e)) throw e;
  }
}

/** 我们自己建的那几条（看日历时不算两遍） */
function ownEventIds(personaId: string): Set<string> {
  const ids = new Set<string>();
  for (const d of Object.values(useParallelStore().days)) {
    if (d.personaId !== personaId) continue;
    for (const it of d.items) if (it.calendar) ids.add(it.calendar.eventId);
  }
  return ids;
}

interface EventTime { date?: string; dateTime?: string }

/**
 * 这几天（节律日）Google 日历里已有的：按节律日分好，时间换成节律日的分钟；全天的只写名字（不算占用时间）。
 * 标成"有空"的、取消了的、我们自己建的不算
 */
export async function calendarBusy(persona: Persona, dates: ISODate[]): Promise<Map<ISODate, CaptureBusy[]>> {
  const out = new Map<ISODate, CaptureBusy[]>();
  const state = calendarState(persona);
  if (!state.ok || !dates.length) return out;
  const timeZone = useEnvironmentStore().settings.timezone;
  const startMin = RHYTHM_DAY_START_HOUR * 60;
  const res = await call(state.server, 'list_events', {
    calendarId: CALENDAR_ID,
    startTime: new Date(zonedInstant(dates[0]!, startMin, timeZone)).toISOString(),
    endTime: new Date(zonedInstant(shiftDate(dates.at(-1)!, 1), startMin, timeZone)).toISOString(),
    timeZone,
    pageSize: 250,
  });
  const own = ownEventIds(persona.id);
  const push = (date: ISODate, b: CaptureBusy) => {
    if (dates.includes(date)) out.set(date, [...(out.get(date) ?? []), b]);
  };
  for (const ev of isObj(res) && Array.isArray(res.items) ? res.items : []) {
    if (!isObj(ev) || ev.status === 'cancelled' || ev.transparency === 'transparent' || own.has(String(ev.id))) continue;
    const title = (typeof ev.summary === 'string' && ev.summary.trim()) || '（没有标题）';
    const start = (isObj(ev.start) ? ev.start : {}) as EventTime;
    const end = (isObj(ev.end) ? ev.end : {}) as EventTime;
    if (start.date) {
      // 全天的：从开始那天到结束前一天，每天写一行
      for (let d = start.date; d < (end.date ?? shiftDate(start.date, 1)); d = shiftDate(d, 1)) push(d, { title, start: null, end: null });
      continue;
    }
    const s = Date.parse(start.dateTime ?? '');
    const e = Date.parse(end.dateTime ?? '');
    if (!Number.isFinite(s)) continue;
    const p = zonedParts(s, timeZone);
    const from = dayMinute(p.hour * 60 + p.minute);
    push(rhythmDate(new Date(s), timeZone), { title, start: from, end: Number.isFinite(e) && e > s ? from + Math.round((e - s) / 60_000) : null });
  }
  return out;
}
