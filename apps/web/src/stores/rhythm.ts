import { buildRhythmMessages, errorReport, errorText, samplerRequest, planDayInput, type RhythmFill } from '@app/ai';
import {
  dayFromTemplate,
  DEFAULT_RHYTHM_SETTINGS,
  getLocation,
  hasOwnWorld,
  outfitOfDay,
  parseBuiltWorld,
  parsePlanDay,
  registerWorld,
  rhythmDate,
  rhythmDayFromPlan,
  builtLocationId,
  locationResolver,
  parseTownDesign,
  type TownBuild,
  type TownDesign,
  shiftDate,
  wallDate,
  type RhythmContext,
  slotIn,
  templateFromWorld,
  unregisterWorld,
  worldFromSpec,
  worldOf,
  DEMO_WORLDS,
  type CharacterRhythm,
  type DayOutfit,
  type OutfitKind,
  type RhythmDay,
  type RhythmMeals,
  type RhythmPerson,
  type RhythmSettings,
  type RhythmSlot,
  type RhythmTemplate,
  type World,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { useMemoryStore } from './memory';
import { useLibraryStore } from './library';
import { useEnvironmentStore } from './environment';
import { useHubStore } from './hub';
import { autoSave, getEntries, write, type RemoteChange } from '@/db/idb';
import { usePersonaStore } from './personas';
import { characterLines, sourceLines } from '@/services/characterSource';
import { starterWorldSpec } from '@/services/starterWorld';
import { uid } from '@/utils/id';

/**
 * 节律（设计文档 §9 开头）：她每天的作息、三餐和穿着，都挂在角色 id 下，存在本机。
 * - 每个角色在"我的 → 节律"里选：固定（一直用模板）/ 每天变化（作息、三餐、穿着可以分别勾；穿着从衣柜挑或每天新编）；
 * - 模板：演示角色来自她的世界；导入的角色先"建世界"（「节律」从角色卡和世界书里生成她的地点、身边的人、作息模板、三餐、衣柜）；
 * - 每天：固定的直接按模板；每天变化的由云端凌晨 4 点排，未连接云端时在打开 App 后排（也可以手动"重新排今天"），
 *   排出来的先检查（盖满一整天、不重叠、地点在她的世界里、固定的事没挪），不合格的部分用模板补；
 * - 用在：她此刻在哪、在做什么（每分钟按今天的作息更新）；陪伴学习里她的小目标；一起吃饭她吃什么；
 *   生图这个场景该穿哪套（同一天的图衣服一致）；【当前环境】里她今天穿什么。
 * 节律日按环境设置里的时区，从凌晨 4 点算起。云端结果同步后也保存在本机。
 */

export type RhythmResult<T> = { ok: true; value: T } | { ok: false; reason: string; detail?: string; notConnected?: boolean };

/** "建世界"的结果：先给你看，确认后才存 */
export interface WorldPreview {
  world: World;
  template: RhythmTemplate;
  people: RhythmPerson[];
  model: string;
  /** AI 按世界观写的像素小镇蓝图（建世界时顺带写的；没写就没有） */
  town?: TownDesign;
}

const DAY = 86_400_000;
const KEEP_DAYS = 30;

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function dayKey(characterId: string, date: string) {
  return `${characterId}:${date}`;
}

/** 最近 n 个节律日（不含今天），从近到远 */
function previousDates(today: string, n: number): string[] {
  return Array.from({ length: n }, (_, i) => shiftDate(today, -(i + 1)));
}

export const useRhythmStore = defineStore('rhythm', () => {
  const configs = reactive<Record<string, CharacterRhythm>>({});
  const days = reactive<Record<string, RhythmDay>>({});
  /** 导入的角色"建世界"后生成的世界（同时登记进 @app/shared，地图、场景、提示词都认得） */
  const worlds = reactive<Record<string, World>>({});
  /** 像素小镇的蓝图（AI 按世界观写的，town.ts）：建世界时顺带写，或者单独"画小镇"；演示角色的世界也能画 */
  const towns = reactive<Record<string, TownDesign>>({});
  /** 已经拷过初始世界的演示角色：只拷一次，之后删了、重建了都按你的来 */
  const seededWorlds = reactive<string[]>([]);
  /** 正在排 / 正在建 / 正在画小镇的角色 */
  const busy = reactive<Record<string, 'plan' | 'build' | 'town' | undefined>>({});
  /** 最近一次排今天失败的原因（只在内存里）；节律页显示 */
  const errors = reactive<Record<string, { at: number; reason: string; detail?: string } | undefined>>({});
  /** 今天是哪个节律日（每分钟更新） */
  const today = ref(rhythmDate(new Date(), useEnvironmentStore().settings.timezone));

  const saver = autoSave(
    'rhythm',
    () => [
      ...Object.values(configs).map((c) => ({ key: `char:${c.characterId}`, value: c })),
      ...Object.values(days).map((d) => ({ key: `day:${dayKey(d.characterId, d.date)}`, value: d })),
      ...Object.values(worlds).map((w) => ({ key: `world:${w.characterId}`, value: w })),
      ...Object.entries(towns).map(([id, t]) => ({ key: `town:${id}`, value: { ...t, characterId: id } })),
      { key: 'seeded-worlds', value: seededWorlds },
    ],
    () => [configs, days, worlds, towns, seededWorlds],
    { apply: applyRemoteEntries },
  );

  /** 读出一条节律记录（读库时、别的设备改了时）；返回 false：太旧了，从本机删掉 */
  function loadEntry(key: string, value: unknown, oldest: string): boolean {
    if (!value || typeof value !== 'object') return true;
    if (key.startsWith('char:')) {
      const c = value as CharacterRhythm;
      configs[c.characterId] = { ...c, settings: { ...DEFAULT_RHYTHM_SETTINGS, ...c.settings, vary: { ...DEFAULT_RHYTHM_SETTINGS.vary, ...c.settings?.vary } }, people: c.people ?? [] };
    } else if (key.startsWith('day:')) {
      const d = value as RhythmDay;
      if (d.date < oldest) return false;
      days[dayKey(d.characterId, d.date)] = d;
    } else if (key.startsWith('world:')) {
      const w = value as World;
      worlds[w.characterId] = w;
      registerWorld(w);
    } else if (key.startsWith('town:')) {
      const { characterId, ...t } = value as TownDesign & { characterId: string };
      if (characterId && t.look) towns[characterId] = t;
    } else if (key === 'seeded-worlds' && Array.isArray(value)) {
      for (const id of value as string[]) if (!seededWorlds.includes(id)) seededWorlds.push(id);
    }
    return true;
  }

  /** 别的设备改了节律、世界、小镇（同步已经写进库）：放进内存；删掉的世界从地图上拿掉 */
  function applyRemoteEntries(changes: RemoteChange[]) {
    const oldest = rhythmDate(new Date(Date.now() - KEEP_DAYS * DAY), useEnvironmentStore().settings.timezone);
    for (const { key, value, deleted } of changes) {
      if (!deleted) {
        loadEntry(key, value, oldest);
        continue;
      }
      const id = key.slice(key.indexOf(':') + 1);
      if (key.startsWith('char:')) delete configs[id];
      else if (key.startsWith('day:')) delete days[id];
      else if (key.startsWith('world:')) {
        if (worlds[id]) unregisterWorld(id);
        delete worlds[id];
      } else if (key.startsWith('town:')) delete towns[id];
    }
  }

  async function hydrate() {
    const entries = await getEntries<unknown>('rhythm');
    const oldest = rhythmDate(new Date(Date.now() - KEEP_DAYS * DAY), useEnvironmentStore().settings.timezone);
    const stale: string[] = [];
    for (const { key, value } of entries) if (!loadEntry(key, value, oldest)) stale.push(key);
    // 演示角色的初始世界第一次打开时拷进本机库，之后和建出来的世界一样存、改背景、重建、删
    for (const demo of DEMO_WORLDS) {
      if (seededWorlds.includes(demo.characterId)) continue;
      seededWorlds.push(demo.characterId);
      if (worlds[demo.characterId]) continue;
      const world = clone(demo);
      worlds[demo.characterId] = world;
      registerWorld(world);
    }
    if (stale.length) await write('rhythm', [], stale);
    saver.start();
  }

  // —— 读 ——

  /** 这个角色的节律设置（还没设置过时是默认：固定） */
  function configOf(characterId: string): CharacterRhythm {
    return configs[characterId] ?? { characterId, settings: clone(DEFAULT_RHYTHM_SETTINGS), template: null, people: [], updatedAt: 0 };
  }

  /** 要改设置时先放进表里 */
  function ensureConfig(characterId: string): CharacterRhythm {
    if (!configs[characterId]) configs[characterId] = configOf(characterId);
    return configs[characterId] as CharacterRhythm;
  }

  /** 她有没有自己的世界（演示角色有；导入的角色"建世界"以后才有） */
  function hasWorld(characterId: string): boolean {
    return !!worlds[characterId] || hasOwnWorld(characterId);
  }

  /** 她的模板：自己改过 / 建世界生成的；演示角色还没改过时来自她的世界；导入的角色没建世界时为空 */
  function templateOf(characterId: string): RhythmTemplate | null {
    const own = configs[characterId]?.template;
    if (own) return own;
    return hasWorld(characterId) ? templateFromWorld(worldOf(characterId)) : null;
  }

  /** 某一天：存下来的（排过的、改过的），否则按模板 */
  function dayOf(characterId: string, date = today.value): RhythmDay | null {
    const saved = days[dayKey(characterId, date)];
    if (saved) return saved;
    const t = templateOf(characterId);
    return t ? dayFromTemplate(characterId, date, t) : null;
  }

  function todayOf(characterId: string): RhythmDay | null {
    return dayOf(characterId, today.value);
  }

  /** 最近 n 天排过的（不含今天），从近到远 */
  function recentDays(characterId: string, n = 7): RhythmDay[] {
    return previousDates(today.value, n)
      .map((d) => days[dayKey(characterId, d)])
      .filter((d): d is RhythmDay => !!d);
  }

  /** 这个场景她今天该穿的那套（生图用）；没有节律时为空 */
  function outfitFor(characterId: string, sceneId: string | null | undefined): DayOutfit | undefined {
    return outfitOfDay(todayOf(characterId), sceneId);
  }

  /** 她今天手头的事（陪伴学习里她的小目标） */
  function taskOf(characterId: string): string {
    return todayOf(characterId)?.task || (hasWorld(characterId) ? worldOf(characterId).life.studyTask : '');
  }

  function mealsOf(characterId: string): RhythmMeals | null {
    return todayOf(characterId)?.meals ?? null;
  }

  /** 她此刻按今天的作息在哪、在做什么 */
  function slotNow(characterId: string, now = new Date()): RhythmSlot | undefined {
    const d = todayOf(characterId);
    return d?.schedule.length ? slotIn(d.schedule, wallDate(now.getTime(), useEnvironmentStore().settings.timezone)) : undefined;
  }

  // —— 改 ——

  function setSettings(characterId: string, patch: Partial<RhythmSettings>) {
    const c = ensureConfig(characterId);
    c.settings = { ...c.settings, ...patch, vary: { ...c.settings.vary, ...patch.vary } };
    c.updatedAt = Date.now();
  }

  /** 改模板（第一次改时从她的世界复制一份出来） */
  function editTemplate(characterId: string): RhythmTemplate | null {
    const c = ensureConfig(characterId);
    if (!c.template) {
      const t = templateOf(characterId);
      if (!t) return null;
      c.template = clone(t);
    }
    c.updatedAt = Date.now();
    return c.template;
  }

  /** 改今天（第一次改时把按模板的今天存下来） */
  function editToday(characterId: string): RhythmDay | null {
    const k = dayKey(characterId, today.value);
    if (!days[k]) {
      const d = todayOf(characterId);
      if (!d) return null;
      days[k] = clone(d);
    }
    const d = days[k] as RhythmDay;
    d.edited = true;
    return d;
  }

  /** 把今天存成模板（作息、三餐、手头的事；今天穿的几套没在衣柜里的放进衣柜） */
  function saveTodayAsTemplate(characterId: string): boolean {
    const d = todayOf(characterId);
    const t = editTemplate(characterId);
    if (!d || !t) return false;
    t.schedule = clone(d.schedule);
    t.meals = { ...d.meals };
    if (d.task) t.task = d.task;
    for (const [kind, o] of Object.entries(d.outfits) as [OutfitKind, DayOutfit][]) {
      if (o && !t.wardrobe.some((w) => w.name === o.name && w.tags === o.tags)) t.wardrobe.push({ id: uid('outfit'), kind, name: o.name, tags: o.tags });
    }
    return true;
  }

  /** 恢复成按模板（去掉今天排过、改过的） */
  function resetToday(characterId: string, keepTemplate = true) {
    const template = templateOf(characterId);
    if (template && keepTemplate) days[dayKey(characterId, today.value)] = { ...dayFromTemplate(characterId, today.value, template), edited: true };
    else delete days[dayKey(characterId, today.value)];
  }

  // —— 交给「节律」——

  function promiseLines(characterId: string): string {
    const chat = useChatStore();
    const c = chat.chatOfCharacter(characterId);
    if (!c) return '';
    const summary = useMemoryStore()
      .timelineOf(c.id)
      .slice(-2)
      .map((s) => s.text)
      .join('\n');
    const recent = chat.recentLines(c.id, 8);
    return [summary ? `最近的聊天摘要：\n${summary}` : '', recent.length ? `最近的聊天：\n${recent.join('\n')}` : ''].filter(Boolean).join('\n');
  }

  function userName(characterId: string): string {
    const chat = useChatStore().chatOfCharacter(characterId);
    return usePersonaStore().forChat(chat).name;
  }

  /** Upload only rhythm inputs; volatile location/presence changes do not invalidate a running plan. */
  function cloudContext(characterId: string): RhythmContext | null {
    const c = useCharacterStore().byId(characterId);
    const template = templateOf(characterId);
    if (!c || !template) return null;
    const cfg = configOf(characterId);
    return { character: { id: c.id, name: c.name, pronoun: c.pronoun, card: c.card }, userName: userName(characterId),
      timezone: useEnvironmentStore().settings.timezone, settings: cfg.settings, template,
      world: worldOf(characterId), people: cfg.people, preset: useLibraryStore().presetForUse('rhythm', c) ?? null,
      promises: promiseLines(characterId) };
  }

  async function ingestCloud(incoming: RhythmDay[]) {
    const accepted = incoming.filter((day) => {
      if (!useCharacterStore().byId(day.characterId) || configOf(day.characterId).settings.mode !== 'daily' || busy[day.characterId]) return false;
      const local = days[dayKey(day.characterId, day.date)];
      return !local?.edited && (!local || local.at < day.at);
    });
    const previous = new Map(accepted.map((day) => [dayKey(day.characterId, day.date), days[dayKey(day.characterId, day.date)]]));
    for (const day of accepted) { days[dayKey(day.characterId, day.date)] = day; delete errors[day.characterId]; }
    if (!await write('rhythm', accepted.map((day) => ({ key: `day:${dayKey(day.characterId, day.date)}`, value: clone(day) })))) {
      // Retry on the next pull; retain any edits made while the IDB transaction was running.
      for (const day of accepted) {
        const key = dayKey(day.characterId, day.date);
        if (days[key]?.edited || days[key]?.at !== day.at) continue;
        const old = previous.get(key);
        if (old) days[key] = old;
        else delete days[key];
      }
      throw new Error('节律未能写入本机存储，下次同步会重试');
    }
    tick();
  }

  /** 调「节律」：按节律预设拼提示词，读回 JSON */
  async function callRhythm<T>(
    characterId: string,
    task: 'build-world' | 'plan-day' | 'draw-town',
    fills: Partial<Record<RhythmFill, string>>,
    parse: (v: unknown) => T | null,
    outfitMode?: 'pick' | 'new' | null,
  ): Promise<RhythmResult<{ value: T; model: string }>> {
    const ai = useAiStore();
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    const status = ai.status('rhythm');
    if (!status.live) return { ok: false, reason: `「节律」还没接通：${status.reason}`, notConnected: true };
    const preset = useLibraryStore().presetForUse('rhythm', c);
    if (!preset) return { ok: false, reason: '没有节律预设：去"我的 → 预设 → 节律"导入或恢复一个' };
    try {
      const messages = buildRhythmMessages({ task, outfitMode, characterName: c.name, userName: userName(characterId), fills }, preset);
      const { value, result } = await ai.system.json('rhythm', { messages, ...samplerRequest(preset.sampler) }, parse);
      return { ok: true, value: { value, model: result.model } };
    } catch (e) {
      return { ok: false, reason: errorText(e), detail: errorReport(e) };
    }
  }

  /**
   * 排今天：每天变化的几项交给「节律」，其余按模板；排出来的作息检查过、补过。
   * force：今天已经排过、改过也重新排
   */
  async function planToday(characterId: string, opts: { force?: boolean } = {}): Promise<RhythmResult<RhythmDay>> {
    const date = today.value;
    const k = dayKey(characterId, date);
    if (busy[characterId]) return { ok: false, reason: '正在排' };
    if (days[k] && !opts.force) return { ok: true, value: days[k] as RhythmDay };
    const template = templateOf(characterId);
    if (!template) return { ok: false, reason: '还没有小世界：先"建世界"' };
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    const context = clone(cloudContext(characterId)!);
    busy[characterId] = 'plan';
    try {
      const input = planDayInput(context, date, recentDays(characterId, 3));
      const r = await callRhythm(characterId, 'plan-day', input.fills, parsePlanDay, input.outfitMode);
      if (!r.ok) {
        errors[characterId] = { at: Date.now(), reason: r.reason, detail: r.detail };
        return r;
      }
      const day = rhythmDayFromPlan({ characterId, date, template: context.template, settings: context.settings,
        locations: context.world.locations, output: r.value.value, model: r.value.model, at: Date.now() });
      days[dayKey(characterId, date)] = day;
      delete errors[characterId];
      return { ok: true, value: day };
    } finally {
      delete busy[characterId];
    }
  }

  /** 建世界：从角色卡和世界书生成她的世界、作息模板、衣柜、身边的人；先返回给你看 */
  async function buildWorld(characterId: string): Promise<RhythmResult<WorldPreview>> {
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    if (busy[characterId]) return { ok: false, reason: '正在忙' };
    busy[characterId] = 'build';
    try {
      const user = userName(characterId);
      const r = await callRhythm(characterId, 'build-world', { rhythmCharacter: characterLines(c, user), rhythmSource: sourceLines(c, user) }, parseBuiltWorld);
      if (!r.ok) return r;
      const spec = r.value.value;
      const built = worldFromSpec(characterId, c.name, spec);
      // 小镇蓝图：look 是整个镇的样子，每个地点的 build 按地点 id 存
      const builds: Record<string, TownBuild> = {};
      for (const l of spec.locations) if (l.build) builds[builtLocationId(characterId, l.key)] = l.build;
      const town = spec.look || Object.keys(builds).length ? { look: spec.look ?? {}, builds, model: r.value.model, at: Date.now() } : undefined;
      return { ok: true, value: { ...built, model: r.value.model, ...(town ? { town } : {}) } };
    } finally {
      delete busy[characterId];
    }
  }

  /** "她的世界"那一块：地点 id、名字、室内外、能一起做的事、一句话，和身边的人（排今天、画小镇都用这个格式） */
  function worldLines(w: World, people: RhythmPerson[]): string {
    return [
      `${w.name}：${w.blurb}`,
      '地点（id：名字 · 室内或室外 · 能一起做的事 · 一句话）：',
      ...w.locations.map((l) => `- ${l.id}：${l.name} · ${l.indoor ? '室内' : '室外'} · ${l.activities.map((a) => a.label).join('、') || '—'}${l.blurb ? ` · ${l.blurb}` : ''}`),
      people.length ? `身边的人：\n${people.map((p) => `- ${p.name}（${p.relation}）${p.note ? `：${p.note}` : ''}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** 她的像素小镇蓝图；AI 还没画过时是 null（小镇按地名猜一份示例的样子） */
  function townOf(characterId: string): TownDesign | null {
    return towns[characterId] ?? null;
  }

  /**
   * 画小镇：只按角色卡和世界书里的世界观重画像素小镇（地面、水、四周、树、灯、每栋楼的形状材料颜色），
   * 地点、作息都不动。演示角色的世界、以前建的世界、本机生成的起步世界都能画。
   */
  async function drawTown(characterId: string): Promise<RhythmResult<TownDesign>> {
    const c = useCharacterStore().byId(characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    if (!hasWorld(characterId)) return { ok: false, reason: '还没有小世界：先"建世界"' };
    if (busy[characterId]) return { ok: false, reason: '正在忙' };
    const w = worldOf(characterId);
    const user = userName(characterId);
    busy[characterId] = 'town';
    try {
      const resolve = locationResolver(w.locations, characterId);
      const r = await callRhythm(
        characterId,
        'draw-town',
        { rhythmCharacter: characterLines(c, user), rhythmSource: sourceLines(c, user), rhythmWorld: worldLines(w, configOf(characterId).people) },
        (v) => parseTownDesign(v, resolve),
      );
      if (!r.ok) return r;
      const town: TownDesign = { ...r.value.value, model: r.value.model, at: Date.now() };
      towns[characterId] = town;
      return { ok: true, value: town };
    } finally {
      delete busy[characterId];
    }
  }

  /** 确认"建世界"的结果：存下世界、模板、身边的人；今天按新模板重来 */
  function applyWorld(characterId: string, preview: WorldPreview) {
    const world = clone(preview.world);
    worlds[characterId] = world;
    registerWorld(world);
    // 地点换了，旧的小镇蓝图对不上了：有新的就用新的，没有就回到按地名猜
    if (preview.town) towns[characterId] = clone(preview.town);
    else delete towns[characterId];
    const c = ensureConfig(characterId);
    c.template = clone(preview.template);
    c.people = clone(preview.people);
    c.updatedAt = Date.now();
    resetToday(characterId, false);
    tick();
  }

  /** 这次打开 App 已经替谁自动建过（失败了也不再反复试，节律页能手动重建） */
  const autoTried = new Set<string>();

  /**
   * 没有小世界的角色打开地图 / 世界页时自动建一个：
   * 接通了「节律」就按角色卡和世界书建（和"建世界"一样，只是不先给你看）；没接通或失败了，在本机按设定生成一个起步世界。
   * 两条路产出同一种世界：经典主题画成 2D 小地图，像素小镇主题画成像素小镇。之后在"我的 → 节律"里随时能重建。
   */
  async function ensureWorld(characterId: string): Promise<'model' | 'starter' | null> {
    if (hasWorld(characterId) || busy[characterId] || autoTried.has(characterId)) return null;
    const c = useCharacterStore().byId(characterId);
    if (!c) return null;
    autoTried.add(characterId);
    if (useAiStore().status('rhythm').live) {
      const r = await buildWorld(characterId);
      if (r.ok) {
        applyWorld(characterId, r.value);
        return 'model';
      }
    }
    const built = worldFromSpec(characterId, c.name, starterWorldSpec(c));
    applyWorld(characterId, { ...built, model: '本机生成' });
    return 'starter';
  }

  // —— 每个地点用哪套背景 ——

  /** 她的世界（响应式，改了随世界一起存） */
  function editableWorld(characterId: string): World | undefined {
    return worlds[characterId];
  }

  /** 地点固定的背景系列；undefined = 按地点名、世界观自动匹配 */
  function backgroundSetOf(characterId: string, locationId: string): string | undefined {
    return worlds[characterId]?.locations.find((l) => l.id === locationId)?.backgroundSet;
  }

  /** 给她世界里的一个地点换背景系列（null = 回到自动匹配）；时段仍然自动切换 */
  function setBackground(characterId: string, locationId: string, setId: string | null) {
    const loc = worlds[characterId]?.locations.find((l) => l.id === locationId);
    if (!loc) return;
    if (setId) loc.backgroundSet = setId;
    else delete loc.backgroundSet;
  }

  /** 删掉她的世界（演示角色的也一样，删了不会再自动拷回来） */
  function removeWorld(characterId: string) {
    if (!worlds[characterId]) return;
    delete worlds[characterId];
    delete towns[characterId];
    unregisterWorld(characterId);
    const c = ensureConfig(characterId);
    c.template = null;
    c.people = [];
    resetToday(characterId, false);
  }

  // —— 每分钟：更新位置；未连接云端的设备才自动在本机排 ——

  /** 自动排失败后，这个角色一小时内不再自动试（完整报错在节律页） */
  const backoff = new Map<string, number>();
  let timer: ReturnType<typeof setInterval> | undefined;

  function tick() {
    today.value = rhythmDate(new Date(), useEnvironmentStore().settings.timezone);
    const chars = useCharacterStore();
    const chat = useChatStore();
    const ai = useAiStore();
    for (const c of chars.list) {
      // 正在一起做事：她在你们那儿，不按作息挪
      if (chat.chatOfCharacter(c.id)?.togetherAt) continue;
      const slot = slotNow(c.id);
      if (slot && getLocation(slot.locationId)) Object.assign(c, { locationId: slot.locationId, status: slot.status });
      const cfg = configs[c.id];
      if (useHubStore().connected) continue;
      if (cfg?.settings.mode !== 'daily' || days[dayKey(c.id, today.value)] || busy[c.id]) continue;
      if ((backoff.get(c.id) ?? 0) > Date.now() || !ai.isLive('rhythm') || !templateOf(c.id)) continue;
      void planToday(c.id).then((r) => {
        if (!r.ok) backoff.set(c.id, Date.now() + 3_600_000);
        else tick();
      });
    }
  }

  function start() {
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && tick());
  }

  return {
    configs,
    cloudContext,
    ingestCloud,
    days,
    worlds,
    busy,
    errors,
    today,
    hydrate,
    start,
    tick,
    configOf,
    hasWorld,
    templateOf,
    dayOf,
    todayOf,
    recentDays,
    outfitFor,
    taskOf,
    mealsOf,
    slotNow,
    setSettings,
    editTemplate,
    editToday,
    saveTodayAsTemplate,
    resetToday,
    planToday,
    buildWorld,
    applyWorld,
    ensureWorld,
    removeWorld,
    editableWorld,
    backgroundSetOf,
    setBackground,
    towns,
    townOf,
    drawTown,
  };
});
