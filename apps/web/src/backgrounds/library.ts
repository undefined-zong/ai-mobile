import { BACKGROUND_KINDS, backdropKindFor, type BackdropKey, type BackgroundPeriod, type BackgroundPlace, type TimeOfDay } from '@app/shared';
import catalog from '@/assets/backgrounds/catalog.json';

export interface BackgroundAsset {
  id: string;
  group: string;
  scene: string;
  style: string;
  family: string;
  set: string;
  period: BackgroundPeriod;
  lighting: string;
  indoor: boolean;
  width: number;
  height: number;
  bytes: number;
}

/** 这里只导入 URL。正式构建把图片输出为独立带哈希文件，进入相应地点才下载。 */
const urls = import.meta.glob<string>('../assets/backgrounds/images/*.webp', { eager: true, query: '?url', import: 'default' });
export const BACKGROUND_ASSETS = catalog as BackgroundAsset[];
export const BACKGROUND_PERIOD_LABEL: Record<BackgroundPeriod, string> = { day: '日间', dusk: '黄昏', night: '夜间', indoor: '室内通用' };
export const BACKGROUND_GROUPS = [...new Set(BACKGROUND_ASSETS.map((a) => a.group))];

export function backgroundUrl(asset: BackgroundAsset): string {
  return urls[`../assets/backgrounds/images/${asset.id}.webp`]!;
}

export interface BackgroundFamily {
  id: string;
  set: string;
  scene: string;
  style: string;
  indoor: boolean;
  assets: BackgroundAsset[];
}

type Family = BackgroundFamily;
const familyMap = new Map<string, Family>();
for (const a of BACKGROUND_ASSETS) {
  let family = familyMap.get(a.family);
  if (!family) {
    family = { id: a.family, set: a.set, scene: a.scene, style: a.style, indoor: a.indoor, assets: [] };
    familyMap.set(a.family, family);
  }
  family.assets.push(a);
}
export const BACKGROUND_SETS = [...familyMap.values()];

/** 系列的封面：优先日间，其次室内通用 */
export function familyCover(family: BackgroundFamily): BackgroundAsset {
  return family.assets.find((a) => a.period === 'day') ?? family.assets.find((a) => a.period === 'indoor') ?? family.assets[0]!;
}

export interface BackgroundRequest extends BackgroundPlace {
  kind: string;
  /** 世界名字、简介、角色设定；只参与风格匹配，不抢走地点本身的用途。 */
  context?: string;
}

const DEFAULT_SETS: Partial<Record<BackdropKey, string>> = {
  bedroom: 'MC-bedroom', room: 'MC-single_room2', living: 'MC-living2', music: 'MC-living',
  study: 'MC-pc_room', dining: 'MC-island_kitchen', library: 'MC-library_room',
  park: 'MC-pond_park', seaside: 'MC-small_sandy_beach', restaurant: 'MC-restaurant',
  cinema: 'AP-cinema', aquarium: 'AP-aquarium', gallery: 'MC-art-museum',
};

/** 不把某一画风套到整座世界上：先限定用途，再比较素材真实拥有的风格。 */
const STYLE_HINTS: [RegExp, RegExp][] = [
  [/古代|仙侠|修仙|宗门|武侠|古风|中式|竹舍|膳堂|藏经|xianxia|wuxia/i, /日式|和室|榻榻米|传统|古典|木质|复古/],
  [/日式|和风|和室|榻榻米|日系|日本|japanese|tatami|ryokan/i, /日式|和室|榻榻米|和风|昭和/],
  [/西幻|魔法|城堡|王都|王国|欧式|贵族|古典|fantasy|magic|castle|classic/i, /古典|西式|复古/],
  [/赛博|未来|科幻|机甲|科技|cyber|futur|sci-fi/i, /现代|电脑|设备|都市|高楼/],
  [/现代|都市|城市|公寓|公司|modern|city|urban/i, /现代|公寓|都市|公司|简约/],
  [/复古|怀旧|昭和|旧书|retro|vintage/i, /复古|昭和|古典|旧书/],
  [/可爱|少女|粉色|甜美|cute|pink/i, /可爱/],
  [/简约|素雅|清爽|极简|minimal/i, /简约|素雅|清爽/],
  [/乡村|乡间|田园|村庄|rural|country/i, /乡间|田园/],
  [/冬|雪|winter|snow/i, /冬/],
  [/秋|枫|红叶|autumn|fall/i, /秋|红叶/],
  [/春|樱|spring|sakura/i, /春|樱/],
  [/夏|summer/i, /夏/],
  [/病房|住院|ward/i, /病房/],
  [/手术|surgery|operating/i, /手术/],
  [/护士|nurse/i, /护士/],
  [/隧道|tunnel/i, /隧道/],
  [/水母|水槽|tank/i, /水槽|水族展/],
  [/抓娃娃|娃娃机|claw/i, /抓娃娃/],
  [/街机|arcade/i, /街机|格斗/],
  [/寿司|sushi/i, /寿司/],
  [/居酒屋|izakaya/i, /居酒屋/],
  [/桑拿|sauna/i, /桑拿/],
  [/更衣|locker/i, /更衣/],
  [/器械|力量|拳馆|weight/i, /器械/],
  [/操房|瑜伽|舞蹈|yoga/i, /健身操/],
  [/甲板|deck/i, /甲板/],
  [/客舱|机舱|cabin/i, /客舱/],
  [/售票|ticket/i, /售票/],
  [/前台|接待|reception/i, /前台|接待|大厅/],
  [/放映|影院|电影|cinema/i, /放映厅/],
];

function hash(text: string): number {
  let n = 2166136261;
  for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619);
  return n >>> 0;
}

function styleScore(text: string, family: Family): number {
  return STYLE_HINTS.reduce((score, [wanted, actual]) => score + (wanted.test(text) && actual.test(family.style) ? 1 : 0), 0);
}

export function backgroundKind(request: BackgroundRequest): BackdropKey {
  return backdropKindFor({ ...request, backdrop: request.kind });
}

function candidates(kind: BackdropKey): Family[] {
  const definition = BACKGROUND_KINDS[kind];
  return BACKGROUND_SETS.filter((family) => definition.scenes.includes(family.scene)
    && (!definition.sets.length || definition.sets.includes(family.set)));
}

/** 同一个地点始终选同一系列；种子来自角色世界的地点 id，避免重开页面就变了一间屋子。 */
export function backgroundFamilies(request: BackgroundRequest): Family[] {
  const kind = backgroundKind(request);
  const named = `${BACKGROUND_KINDS[kind].label} ${request.name ?? ''} ${request.blurb ?? ''}`;
  const seed = request.id ?? kind;
  const explicit = BACKGROUND_SETS.filter((f) => f.id === request.backgroundSet || f.set === request.backgroundSet);
  const all = candidates(kind);
  // 古代和西幻地点有其它素材时，避开带电脑、电视等明显现代设备的系列。
  const historical = /古代|仙侠|修仙|宗门|武侠|古风|竹舍|藏经|西幻|魔法|王国|城堡|xianxia|wuxia|fantasy|magic|castle/i.test(`${named} ${request.context ?? ''}`);
  const compatible = historical ? all.filter((f) => !/电脑|电视|现代|公司|都市|高楼|设备/.test(f.style)) : all;
  const pool = [...new Set([...explicit, ...(compatible.length ? compatible : all)])];
  const score = (f: Family) =>
    (explicit.includes(f) ? 100 : 0)
    + styleScore(named, f) * 12
    + styleScore(request.context ?? '', f) * 8
    + (request.indoor === undefined || request.indoor === f.indoor ? 4 : 0)
    + (new Set(f.assets.map((a) => a.period)).size >= 3 || f.assets.some((a) => a.period === 'indoor') ? 2 : 0)
    + (!request.id && DEFAULT_SETS[kind] === f.set ? 3 : 0)
    // 有多种内景的场所，默认在主要活动区，而不是售票处、桑拿室或机场跑道。
    + (/放映厅|海底隧道|器械训练区|候机大厅|客舱|街机区|学校阅览室/.test(f.style) ? 3 : 0);
  return pool.sort((a, b) => score(b) - score(a) || hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`));
}

export function backgroundPeriod(tod: TimeOfDay): BackgroundPeriod {
  return tod === 'night' || tod === 'late' ? 'night' : tod === 'dusk' ? 'dusk' : 'day';
}

export function pickBackground(request: BackgroundRequest, tod: TimeOfDay) {
  const period = backgroundPeriod(tod);
  // 固定了某一张：就用它，时段和灯光都不再挑
  const fixed = request.backgroundAsset ? BACKGROUND_ASSETS.find((a) => a.id === request.backgroundAsset) : undefined;
  if (fixed) return { asset: fixed, url: backgroundUrl(fixed), kind: backgroundKind(request), requestedPeriod: period, periodFallback: false };
  const ranked = backgroundFamilies(request);
  const primary = ranked[0]!;
  // 自己选定的系列缺这个时段时，只在选定的系列里找最接近的时段，不换成别的屋子（黄昏不会突然变成电脑房）。
  const pinned = ranked.filter((f) => f.id === request.backgroundSet || f.set === request.backgroundSet);
  const fallbacks = pinned.length ? pinned : ranked;
  // 同一系列的对应时段 → 同系列室内通用 → 同用途其它系列对应时段 → 同用途室内通用。
  let available = primary.assets.filter((a) => a.period === period);
  if (!available.length) available = primary.assets.filter((a) => a.period === 'indoor');
  if (!available.length) available = fallbacks.find((f) => f.assets.some((a) => a.period === period))?.assets.filter((a) => a.period === period) ?? [];
  if (!available.length) available = fallbacks.find((f) => f.assets.some((a) => a.period === 'indoor'))?.assets.filter((a) => a.period === 'indoor') ?? [];
  // 素材本身没有该时段（如机场只有日间、游乐园没有黄昏）时保留该地点的真实素材。
  if (!available.length) available = primary.assets.filter((a) => a.period === (period === 'dusk' ? 'day' : 'dusk'));
  if (!available.length) available = primary.assets;
  if (period === 'night' || available.some((a) => a.period === 'indoor')) {
    const lighting = tod === 'late' ? /月光|台灯|关灯/ : /开灯/;
    const lit = available.filter((a) => lighting.test(a.lighting));
    if (lit.length) available = lit;
  }
  const asset = available[hash(`${request.id ?? request.kind}:${available[0]!.family}`) % available.length]!;
  return { asset, url: backgroundUrl(asset), kind: backgroundKind(request), requestedPeriod: period,
    periodFallback: asset.period !== period && asset.period !== 'indoor' };
}
