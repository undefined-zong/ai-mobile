import { formatChoreBlock, MEAL_LABEL, plannerDayText, substituteMacros, type AppBlockFill, type LifeFlag, type Persona, type Preset } from '@app/shared';
import { useEnvironmentStore } from '@/stores/environment';
import { useHealthStore, workoutLine } from '@/stores/health';
import { useHomeStore } from '@/stores/home';
import { seedBlockContent } from '@/stores/library';
import { usePlannerStore } from '@/stores/planner';
import { parallelLines } from './parallel';

/**
 * "家务和健康"那一块（程序填充块 home，设计文档 §9.12、§9.13、§9.15）：你开了家务、健康、日程系统时，今天的情况写在这里，
 * 聊天、通话、一起做事、主动消息（本机和云端）都带上。她怎么反应写在预设里（"家务：你怎么反应""健康：你怎么反应"两块，
 * 触发条件写着 housework / health / planner，没开的系统那一块不发）。都没开时这一块是空的，不发送。
 * 日程：开了日程系统、"写进聊天"开着、今天已经排了计划时，写今天的计划（勾掉的标"做完了"）。
 * 平行时空：你在那里自己记的今天的事、从今天拿掉的事（平行时空的"写进聊天"开着时）；不靠开关，有就写。
 */

/** 你人设里开着的系统：预设里触发条件写了它们的块只在开着时发送（家务：有重复的家务，或者今天有健康计划发来的要提前做的饭） */
export function lifeFlags(persona: Persona | undefined): LifeFlag[] {
  const out: LifeFlag[] = [];
  if (persona?.housework?.enabled && (persona.housework.chores.length || useHomeStore().extrasOf(persona.id).length)) out.push('housework');
  if (persona?.health?.enabled) out.push('health');
  if (persona?.planner?.enabled && persona.planner.inChat && todayPlan(persona)) out.push('planner');
  return out;
}

/** 今天排好的日程计划（还没排时为空） */
function todayPlan(persona: Persona) {
  const planner = usePlannerStore();
  return planner.ready ? planner.dayOf(persona.id, planner.today(persona)) : undefined;
}

/** 日程这几行：今天的计划、勾掉了哪些 */
export function plannerLines(persona: Persona): string {
  const plan = todayPlan(persona);
  if (!plan) return '';
  return `【今天的计划】${persona.name}今天的安排（日程系统按邮件和日程排的）：\n${plannerDayText(plan, usePlannerStore().doneOf(persona.id, plan.date))}`;
}

/** 每个系统"她怎么反应"那一块在自带预设里的名字 */
const RULE_BLOCKS: Record<LifeFlag, string> = { housework: 'homeRules', health: 'healthRules', planner: 'plannerRules' };
const FLAG_NAMES: Record<LifeFlag, string> = { housework: '家务', health: '健康', planner: '日程' };

/** 现在几点；stepMin 给了就往前取整（上传云端的那份用半小时，免得每分钟都算"变了"） */
function clockNow(timeZone: string, stepMin = 0): string {
  const step = stepMin * 60_000;
  const at = step ? Math.floor(Date.now() / step) * step : Date.now();
  try {
    return new Intl.DateTimeFormat('zh-CN', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
  } catch {
    return '';
  }
}

/** 健康这几行：目标、今天练什么吃什么、今天练了没有 */
export function healthLines(persona: Persona): string {
  const h = persona.health;
  if (!h?.enabled) return '';
  const health = useHealthStore();
  const today = health.today();
  const day = health.dayOf(persona.id, today);
  const week = health.weekOf(persona.id);
  const done = health.logsOf(persona.id, today).filter((l) => l.date === today);
  const target = h.targetWeightKg && h.weightKg ? `（${h.weightKg} → ${h.targetWeightKg} kg）` : '';
  const lines = [`【健康】${persona.name}的目标：${h.goal.trim() || '保持健康'}${target}`];
  if (day?.workout && !day.rest) lines.push(`今天的健身计划：${day.workout.title} · ${day.workout.minutes} 分钟（${done.some((l) => l.mode === 'plan') ? '练过了' : done.length ? '照计划的还没练' : '还没练'}）`);
  else if (day?.rest) lines.push('今天的健身计划：休息');
  else {
    const wd = new Date(`${today}T12:00:00Z`).getUTCDay();
    const planned = week?.days.find((d) => d.weekday === wd);
    lines.push(planned ? `这周的计划里今天：${planned.rest ? '休息' : `${planned.workout} ${planned.minutes} 分钟`}` : '今天的健身计划还没排');
  }
  if (day) {
    const meals = (['breakfast', 'lunch', 'dinner', 'snack'] as const)
      .map((k) => {
        const m = day.meals[k];
        const how = m?.cook && m.minutes ? `（自己做，约 ${m.minutes} 分钟${m.prep ? '，顺手备一份' : ''}）` : m?.bento ? '（带提前做好的便当）' : m?.place ? `（去${m.place}吃）` : '';
        return m ? `${MEAL_LABEL[k]} ${m.name}${how}` : '';
      })
      .filter(Boolean);
    if (meals.length) lines.push(`今天吃什么（计划）：${meals.join('；')}`);
  }
  if (done.length) lines.push(`今天练了：${done.map((l) => workoutLine(l, false)).join('；')}`);
  return lines.join('\n');
}

/**
 * 预设里没有"她怎么反应"那一块的（导入的 SillyTavern 预设、以前复制的）：用自带预设文件里的，接在今天的情况后面。
 * 预设里有（触发条件写着 housework / health 的块，开着关着都算你的选择）就不补
 */
export function missingRules(persona: Persona, preset: Pick<Preset, 'blocks'> | undefined, names: { char: string; pronoun?: string }): string[] {
  return lifeFlags(persona)
    .filter((f) => !preset?.blocks.some((b) => b.triggers?.includes(f)))
    .map((f) => seedBlockContent(RULE_BLOCKS[f]))
    .filter((t): t is string => !!t)
    .map((t) => substituteMacros(t, { char: names.char, pronoun: names.pronoun, user: persona.name }));
}

/**
 * 这一块的内容；两套都没开时为 null（不发送）。
 * opts.stepMin：时间往前取整（上传云端时用 30）；opts.preset：这一轮的预设，里面没有"她怎么反应"的块时把自带的接在后面
 */
export function homeBlock(persona: Persona | undefined, opts: { stepMin?: number; preset?: Pick<Preset, 'blocks'>; characterName?: string; pronoun?: string } = {}): AppBlockFill | null {
  const flags = lifeFlags(persona);
  const parallel = persona ? parallelLines(persona) : '';
  if (!persona || (!flags.length && !parallel)) return null;
  const tz = useEnvironmentStore().settings.timezone;
  const parts: string[] = [];
  if (flags.includes('housework')) {
    const home = useHomeStore();
    parts.push(formatChoreBlock({ userName: persona.name, items: home.itemsFor(persona), recent: home.recentFor(persona), nowText: clockNow(tz, opts.stepMin), timeZone: tz }));
  }
  if (flags.includes('health')) parts.push(healthLines(persona));
  if (flags.includes('planner')) parts.push(plannerLines(persona));
  if (parallel) parts.push(parallel);
  if (opts.preset) parts.push(...missingRules(persona, opts.preset, { char: opts.characterName ?? '', pronoun: opts.pronoun }));
  const content = parts.filter(Boolean).join('\n');
  if (!content) return null;
  const names = [...flags.map((f) => FLAG_NAMES[f]), ...(parallel ? ['平行时空'] : [])];
  return { content, source: `${persona.name}的${names.join('、')}（"共同的家"里勾的、健康计划、运动记录、日程计划、平行时空里记的）` };
}
