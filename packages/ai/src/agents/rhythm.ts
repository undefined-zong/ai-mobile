import { characterPronoun } from '@app/shared';
import { assembleTaskPrompt, backgroundLibraryPrompt, OUTFIT_KINDS, solarTermNote, substituteMacros, textFn, type RhythmContext, type RhythmDay, type RhythmPerson, type RhythmSlot, type RhythmTask, type TextFn, type World } from '@app/shared';
import type { ChatMessage } from '../llm/types.ts';
import type { TaskPreset } from './taskPreset.ts';

/**
 * 节律智能体（设计文档 §4.1、§9 开头）：
 * - 建世界：从角色卡和世界书里找出她住哪、在哪读书或工作、常去哪、身边有谁，写出作息模板、三餐习惯、衣柜；
 * - 排今天：按她的世界、模板、今天的日期天气、最近几天，排今天的作息、三餐、穿着、手头的事。
 * 提示词（任务、规则、输出格式）全在节律预设里，按触发条件只发这次的任务；这里只把这一次的输入填进程序填充块。
 * 输出用 @app/shared 的 parseBuiltWorld / parsePlanDay 读，再用 checkSchedule 检查。
 */

/** 节律预设的程序填充块（TASK_MARKERS.rhythm） */
export type RhythmFill =
  | 'rhythmCharacter'
  | 'rhythmSource'
  | 'rhythmWorld'
  | 'rhythmTemplate'
  | 'rhythmWardrobe'
  | 'rhythmToday'
  | 'rhythmRecent'
  | 'rhythmPromises'
  | 'rhythmAsk';

export interface RhythmPromptInput {
  task: Extract<RhythmTask, 'build-world' | 'plan-day' | 'draw-town'>;
  /** 排今天、穿着每天变化时：从衣柜里挑（outfit-pick）还是每天新编（outfit-new） */
  outfitMode?: 'pick' | 'new' | null;
  characterName: string;
  pronoun?: string;
  userName?: string;
  fills: Partial<Record<RhythmFill, string>>;
}

/** 这一次的类型：任务名，排今天时再加上穿着的做法 */
export function rhythmTypes(input: Pick<RhythmPromptInput, 'task' | 'outfitMode'>): string[] {
  return [input.task, ...(input.task === 'plan-day' && input.outfitMode ? [`outfit-${input.outfitMode}`] : [])];
}

export function buildRhythmMessages(input: RhythmPromptInput, preset: TaskPreset): ChatMessage[] {
  const fills: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.fills)) if (v) fills[k] = v;
  if (input.task === 'build-world') fills.rhythmAsk = [fills.rhythmAsk, backgroundLibraryPrompt(textFn(preset.texts))].filter(Boolean).join('\n\n');
  return assembleTaskPrompt({ preset, fills, macros: { pronoun: input.pronoun, char: input.characterName, user: input.userName ?? '' }, type: rhythmTypes(input) }).messages;
}

/** "她的世界"那一块（程序文字 rhythm.world*）：地点 id、名字、室内外、能一起做的事、一句话，和身边的人（排今天、画小镇都用） */
export function rhythmWorldFill(w: Pick<World, 'name' | 'blurb' | 'locations'>, people: RhythmPerson[], t: TextFn): string {
  return t('rhythm.world', {
    name: w.name,
    blurb: w.blurb,
    locations: w.locations.map((l) => t('rhythm.world.location', {
      id: l.id, name: l.name, place: t(l.indoor ? 'common.indoor' : 'common.outdoor'),
      activities: l.activities.map((a) => a.label).join('、') || t('common.none'), blurb: l.blurb,
    })),
    people: people.map((p) => t('rhythm.world.person', { name: p.name, relation: p.relation, note: p.note })),
  });
}

/** Rebuilt at execution time: cloud dates and recent days never depend on an open PWA. */
export function planDayInput(context: RhythmContext, date: string, recent: RhythmDay[]): RhythmPromptInput {
  const { character: c, userName, settings, template: tpl, world: w, people } = context;
  // 说明文字都在节律预设的程序文字里（上传的预设已经合好了自带预设文件里的）
  const t = textFn(context.preset?.texts);
  const vary = settings.mode === 'daily' ? settings.vary : { schedule: false, meals: false, outfits: false };
  const sub = (text: string) => substituteMacros(text, { char: c.name, user: userName, pronoun: c.pronoun }).trim();
  const schedule = (slots: RhythmSlot[]) => slots.map((s) => t('rhythm.slot', { from: s.from, to: s.to, place: w.locations.find((l) => l.id === s.locationId)?.name ?? s.locationId, id: s.locationId, status: s.status, fixed: !!s.fixed }));
  const d = new Date(`${date}T12:00:00`);
  const weekday = d.getDay();
  const none = t('common.none');
  const asks = [vary.schedule ? t('rhythm.ask.schedule') : '', vary.meals ? t('rhythm.ask.meals') : '', vary.outfits ? t('rhythm.ask.outfits') : '', t('rhythm.ask.task'), t('rhythm.ask.events')].filter(Boolean);
  return {
    task: 'plan-day', outfitMode: vary.outfits ? settings.outfitMode : null, characterName: c.name, pronoun: c.pronoun, userName,
    fills: {
      rhythmCharacter: t('social.character', {
        name: c.name, pronoun: characterPronoun(c),
        description: c.card.description ? sub(c.card.description) : '', personality: c.card.personality ? sub(c.card.personality) : '', scenario: c.card.scenario ? sub(c.card.scenario) : '',
      }),
      rhythmWorld: rhythmWorldFill(w, people, t),
      rhythmTemplate: t('rhythm.template', { schedule: schedule(tpl.schedule), breakfast: tpl.meals.breakfast || none, lunch: tpl.meals.lunch || none, dinner: tpl.meals.dinner || none, task: tpl.task }),
      rhythmWardrobe: vary.outfits || settings.mode === 'fixed'
        ? (tpl.wardrobe.length ? t('rhythm.wardrobe', { items: tpl.wardrobe.map((o) => t('rhythm.wardrobe.item', { kind: OUTFIT_KINDS[o.kind], name: o.name, tags: o.tags })) }) : t('rhythm.wardrobe.empty'))
        : '',
      rhythmToday: t('rhythm.today', { date, weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday], weekend: weekday === 0 || weekday === 6, term: solarTermNote(d, undefined, t) }),
      rhythmRecent: recent.length
        ? t('rhythm.recent', { days: recent.map((day) => t('rhythm.recent.day', {
          date: day.date,
          slots: day.schedule.filter((s) => !/睡/.test(s.status)).map((s) => `${s.from} ${s.status}`),
          outfits: Object.values(day.outfits).map((o) => o?.name ?? '').filter(Boolean),
          dinner: day.meals.dinner,
        })) })
        : '',
      rhythmPromises: context.promises,
      rhythmAsk: t('rhythm.ask', { asks, keepSchedule: !vary.schedule }),
    },
  };
}
