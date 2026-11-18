import {
  assembleTaskPrompt,
  expandPlannerMacros,
  fixedCallArgs,
  parsePlannerDay,
  parsePlannerGather,
  parsePlannerWeek,
  plannerVars,
  plannerWeekText,
  toolParamsText,
  weekStartOn,
  zonedParts,
  type ISODate,
  type McpServerConfig,
  type McpServerSecret,
  type McpToolInfo,
  type PlannerCall,
  type PlannerContext,
  type PlannerRunResult,
  type PlannerSource,
  type PlannerTask,
  type PlannerWeekPlan,
  TASK_MARKERS,
} from '@app/shared';
import { AiError } from '../core/errors.ts';
import type { ChatMessage } from '../llm/types.ts';
import { McpClient, McpCredentials, type McpCallResult } from '../mcp/client.ts';
import { openGoogleSession } from '../mcp/google.ts';
import type { AgentSystem } from './system.ts';
import { samplerRequest, type TaskPreset } from './taskPreset.ts';

/**
 * 日程计划智能体（日程系统，设计文档 §9.15）：
 * 1. 连上你接的 MCP 服务器（Gmail、日历……），列出工具；先调"每次都查"的；
 * 2. AI 自己查：把能用的工具（你勾了的）和查到的给模型看，模型决定这一轮调哪些（planner-gather），最多几轮；
 * 3. 按查到的邮件和日程、家务和健康、你写的情况，排这周（planner-week，需要时）和今天（planner-day）。
 * 提示词（任务、规则、输出格式）全在「计划」预设里；这里只把这一次的输入填进程序填充块。
 * 云端（每天到点）和本机（立即生成、没连云端时）跑的是同一段。
 */

export type PlannerFill = keyof (typeof TASK_MARKERS)['planner'];

export function buildPlannerMessages(input: { task: PlannerTask; userName: string; characterName?: string; fills: Partial<Record<PlannerFill, string>> }, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  return assembleTaskPrompt({ preset, fills, macros: { char: input.characterName ?? '', user: input.userName }, type: input.task }).messages;
}

/** 连好的一台服务器 */
export interface PlannerSession {
  server: McpServerConfig;
  tools: McpToolInfo[];
  call(tool: string, args: Record<string, unknown>): Promise<McpCallResult>;
  close(): Promise<void>;
}

/** 怎么连一台服务器（本机、云端各自给：密钥从哪拿、刷新后存到哪） */
export type PlannerOpen = (server: McpServerConfig) => Promise<PlannerSession>;

/** 用一份密钥连上服务器、列出工具（本机和云端共用） */
export async function openMcpSession(
  server: McpServerConfig,
  secret: McpServerSecret | null,
  opts: { fetch?: typeof fetch; onUpdate?: (s: McpServerSecret) => Promise<void> | void; signal?: AbortSignal } = {},
): Promise<PlannerSession> {
  const url = secret?.url || server.url;
  if (!url) throw new Error('没填地址');
  if (server.auth !== 'none' && !secret) throw new Error(server.auth === 'oauth' ? '还没授权' : '还没填 Token');
  const credentials = secret ? new McpCredentials({ ...secret, url }, { fetch: opts.fetch, onUpdate: opts.onUpdate }) : undefined;
  const google = openGoogleSession(server, url, credentials, opts);
  if (google) return google;
  const client = new McpClient({ url, credentials, fetch: opts.fetch, signal: opts.signal });
  await client.connect();
  const tools = await client.listTools();
  return { server, tools, call: (tool, args) => client.callTool(tool, args), close: () => client.close() };
}

export interface PlannerRunInput {
  context: PlannerContext;
  at: number;
  date: ISODate;
  /** 这周已经排好的（排今天时参考；每天重排这周时也给模型看上一版） */
  week: PlannerWeekPlan | null;
  lastRunAt?: number | null;
  want: { week: boolean; day: boolean };
  via: 'hub' | 'device';
}

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（后面还有 ${text.length - max} 字，截掉了）` : text;
}

export async function runPlanner(
  system: AgentSystem,
  input: PlannerRunInput,
  open: PlannerOpen,
  opts: { signal?: AbortSignal; onStep?: (step: string) => void } = {},
): Promise<PlannerRunResult> {
  const { context: ctx, at, date } = input;
  const s = ctx.settings;
  const preset = ctx.preset;
  if (!preset) throw new AiError('no_route', '没有"计划"预设');
  const userName = ctx.persona.name;
  const characterName = ctx.character?.name;
  const vars = plannerVars({ at, timeZone: ctx.timezone, date, weekStart: s.weekStart, lastRunAt: input.lastRunAt });
  const weekStart = weekStartOn(date, s.weekStart);
  const errors: string[] = [];
  const sources: PlannerSource[] = [];
  const gathered: string[] = [];
  const req = (task: PlannerTask, fills: Partial<Record<PlannerFill, string>>) => ({
    messages: buildPlannerMessages({ task, userName, characterName, fills }, preset),
    ...samplerRequest(preset.sampler),
  });

  // —— 这一次固定的输入 ——
  const wd = new Date(`${date}T12:00:00Z`).getUTCDay();
  const now = zonedParts(at, ctx.timezone);
  const profile = [
    `${userName}${ctx.persona.description.trim() ? `：${ctx.persona.description.trim()}` : ''}`,
    s.note.trim() ? `${userName}写的情况和偏好：\n${s.note.trim()}` : '',
    ctx.character ? `陪${userName}的人：${ctx.character.name}${ctx.character.description ? `（${ctx.character.description}）` : ''}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  const today = [
    `今天：${date} ${WEEKDAY[wd]}（${wd === 0 || wd === 6 ? '周末' : '工作日'}），时区 ${ctx.timezone}，现在 ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`,
    `这周：${vars.weekStart} 到 ${vars.weekEnd}`,
    `上次排计划：${vars.lastRunAt}`,
    `工具参数里能用的时间：${Object.entries(vars).map(([k, v]) => `${k} = ${v}`).join('；')}`,
  ].join('\n');

  // —— 1. 连服务器 ——
  const sessions: PlannerSession[] = [];
  for (const server of s.servers.filter((x) => x.enabled && x.url)) {
    opts.onStep?.(`连接「${server.name}」`);
    try {
      sessions.push(await open(server));
    } catch (e) {
      errors.push(`「${server.name}」连不上：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const called = new Set<string>();
  async function invoke(session: PlannerSession, tool: string, args: Record<string, unknown>, round: number, why = '') {
    const key = JSON.stringify([session.server.id, tool, args]);
    if (called.has(key)) return;
    called.add(key);
    const argsText = JSON.stringify(args);
    opts.onStep?.(`查「${session.server.name}」：${tool}`);
    try {
      const r = await session.call(tool, args);
      const text = clip(r.text.trim() || '（没有内容）', s.resultChars);
      sources.push({ server: session.server.name, tool, args: argsText, ok: !r.isError, chars: r.text.length, round, ...(r.isError ? { error: r.text.slice(0, 200) } : {}) });
      gathered.push(`### 「${session.server.name}」${tool} ${argsText}${why ? `（${why}）` : ''}${r.isError ? '（工具报错）' : ''}\n${text}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sources.push({ server: session.server.name, tool, args: argsText, ok: false, chars: 0, round, error: msg.slice(0, 200) });
      gathered.push(`### 「${session.server.name}」${tool} ${argsText}\n（调用失败：${msg.slice(0, 200)}）`);
    }
  }

  try {
    // —— 2. 每次都查的 ——
    for (const session of sessions) {
      for (const f of session.server.fixed) {
        if (!f.tool) continue;
        let args: Record<string, unknown>;
        try {
          args = fixedCallArgs(f, vars);
        } catch (e) {
          errors.push(`「${session.server.name}」${f.tool} 的参数不对：${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        await invoke(session, f.tool, args, 0);
      }
    }

    // —— 3. AI 自己查 ——
    // 邮箱只读：就算勾了，邮箱服务器上没标只读的工具也不给 AI
    const usable = sessions.map((x) => ({ session: x, tools: x.tools.filter((t) => x.server.allowed.includes(t.name) && (x.server.kind !== 'mail' || t.readOnly)) })).filter((x) => x.tools.length);
    if (s.maxRounds > 0 && usable.length) {
      const catalog = usable
        .map(({ session, tools }) =>
          [`## 服务器「${session.server.name}」（server 写 "${session.server.name}"）`, ...tools.map((t) => `- ${t.name}${t.title ? `（${t.title}）` : ''}：${t.description.replace(/\s+/g, ' ').slice(0, 400)}\n  参数：${toolParamsText(t.inputSchema)}`)].join('\n'),
        )
        .join('\n\n');
      for (let round = 1; round <= s.maxRounds; round++) {
        opts.onStep?.(`想想还要查什么（第 ${round} 轮）`);
        let plan: { calls: PlannerCall[]; done: boolean };
        try {
          ({ value: plan } = await system.json(
            'planner',
            req('planner-gather', {
              plannerProfile: profile,
              plannerToday: today,
              plannerLife: ctx.life,
              plannerTools: catalog,
              plannerGathered: gathered.join('\n\n') || '（还没查）',
              plannerRecent: ctx.recent,
              plannerAsk: `第 ${round} 轮（最多 ${s.maxRounds} 轮），这一轮最多调 ${s.maxCalls} 个工具。查够了就 done: true。`,
            }),
            parsePlannerGather,
            { signal: opts.signal },
          ));
        } catch (e) {
          errors.push(`决定查什么时出错：${e instanceof Error ? e.message : String(e)}`);
          break;
        }
        let ran = 0;
        for (const c of plan.calls.slice(0, s.maxCalls)) {
          const name = c.server.toLowerCase();
          const match =
            usable.find((u) => u.session.server.name.toLowerCase() === name || u.session.server.id === c.server) ??
            (usable.filter((u) => u.tools.some((t) => t.name === c.tool)).length === 1 ? usable.find((u) => u.tools.some((t) => t.name === c.tool)) : undefined);
          if (!match || !match.tools.some((t) => t.name === c.tool)) {
            sources.push({ server: c.server || '？', tool: c.tool, args: JSON.stringify(c.args), ok: false, chars: 0, round, error: '没勾的工具，没调' });
            continue;
          }
          // 模型写的参数里也可能用了 {{today}} 这类变量
          const args = JSON.parse(expandPlannerMacros(JSON.stringify(c.args), vars)) as Record<string, unknown>;
          await invoke(match.session, c.tool, args, round, c.why);
          ran++;
        }
        if (plan.done || !ran) break;
      }
    }
  } finally {
    await Promise.all(sessions.map((x) => x.close().catch(() => undefined)));
  }

  const gatheredText = gathered.length ? gathered.join('\n\n') : sessions.length ? '（这次没查到东西）' : '（没有接邮箱和日程，或者都没连上）';
  const result: PlannerRunResult = { personaId: ctx.persona.id, date, sources, errors, at };

  // —— 4. 排这周 ——
  let week = input.week;
  if (input.want.week) {
    opts.onStep?.('排这周');
    try {
      const { value, result: r } = await system.json(
        'planner',
        req('planner-week', {
          plannerProfile: profile,
          plannerToday: today,
          plannerLife: ctx.life,
          plannerGathered: gatheredText,
          plannerWeek: input.week ? `上一版（今天重排，可以改）：\n${plannerWeekText(input.week, date)}` : '',
          plannerRecent: ctx.recent,
          plannerAsk: `排 ${weekStart} 开始的这一周（${vars.weekStart} 到 ${vars.weekEnd}）。`,
        }),
        (v) => parsePlannerWeek(v, weekStart),
        { signal: opts.signal },
      );
      week = { ...value, personaId: ctx.persona.id, weekStart, model: r.model, at: Date.now(), via: input.via };
      result.week = week;
    } catch (e) {
      errors.push(`这周的计划没排出来：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // —— 5. 排今天 ——
  if (input.want.day) {
    opts.onStep?.('排今天');
    try {
      const { value, result: r } = await system.json(
        'planner',
        req('planner-day', {
          plannerProfile: profile,
          plannerToday: today,
          plannerLife: ctx.life,
          plannerGathered: gatheredText,
          plannerWeek: plannerWeekText(week, date),
          plannerRecent: ctx.recent,
          plannerAsk: `排今天（${date} ${WEEKDAY[wd]}）。`,
        }),
        parsePlannerDay,
        { signal: opts.signal },
      );
      result.day = { ...value, personaId: ctx.persona.id, date, model: r.model, at: Date.now(), via: input.via };
    } catch (e) {
      errors.push(`今天的计划没排出来：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 今天的是主要的：要排今天却没排出来（或者只排这周也没排出来）算失败，云端稍后重试；这周没排出来、今天排出来了照样留着
  if (input.want.day ? !result.day : !result.week) throw new AiError('bad_response', errors.join('；') || '计划没排出来');
  return result;
}
