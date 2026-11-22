import { pronounText } from '@app/shared';
import type { BackdropKey, BuiltLocationSpec, BuiltWorldSpec, Character, OutfitItem, RhythmSlot, SceneId } from '@app/shared';

/**
 * 起步世界：没接通「节律」（或建世界失败）时，在本机按角色卡生成一个小世界，让每个角色一打开就有地图。
 * - 先从角色卡里认设定（校园 / 都市 / 仙侠 / 赛博 / 西幻），再从这个设定的地点池里挑 8 个左右，
 *   保证常用的几件事（学习、吃饭、运动、睡觉、听歌、约会、观影、游戏）都有地方做；
 * - 以角色 id 为种子，同一个角色每次生成都一样，同一设定的不同角色也不完全一样；
 * - 产出和「节律」建世界同一个格式（BuiltWorldSpec），之后在"我的 → 节律"里随时能用模型重建。
 */

export type StarterSetting = 'campus' | 'city' | 'xianxia' | 'cyber' | 'fantasy';

export const STARTER_SETTING_LABEL: Record<StarterSetting, string> = {
  campus: '校园',
  city: '都市',
  xianxia: '仙侠',
  cyber: '赛博',
  fantasy: '西幻',
};

type Act = [SceneId, string];
interface Spot {
  key: string;
  name: string;
  backdrop: BackdropKey;
  indoor: boolean;
  blurb: string;
  acts: Act[];
}
interface Pool {
  name: (who: string) => string;
  blurb: string;
  areas: { home: string; campus: string; city: string };
  home: Spot[];
  campus: Spot[];
  city: Spot[];
  /** 白天在哪做正事、那时的状态 */
  workStatus: string;
  meals: { breakfast: string; lunch: string; dinner: string };
  task: string;
  wardrobe: Omit<OutfitItem, 'id'>[];
}

const s = (key: string, name: string, backdrop: BackdropKey, indoor: boolean, blurb: string, acts: Act[]): Spot => ({ key, name, backdrop, indoor, blurb, acts });

const POOLS: Record<StarterSetting, Pool> = {
  campus: {
    name: (who) => `${who}的校园`,
    blurb: '宿舍、教学楼和学校附近常去的地方',
    areas: { home: '宿舍区', campus: '学校', city: '学校附近' },
    home: [s('dorm', '宿舍', 'bedroom', true, '和室友一起住的小房间', [['sleep', '哄睡'], ['music', '一起听歌'], ['poke', '戳戳乐'], ['rest', '休息']])],
    campus: [
      s('library', '图书馆', 'library', true, '靠窗的位置最抢手', [['study', '陪伴学习'], ['read', '一起看书']]),
      s('canteen', '食堂', 'dining', true, '二楼的窗口最好吃', [['meal', '一起吃饭']]),
      s('track', '操场', 'park', false, '傍晚有很多人跑步', [['exercise', '一起跑步']]),
      s('pool', '游泳馆', 'pool', true, '每周三晚上开放', [['exercise', '一起游泳']]),
    ],
    city: [
      s('cafe', '咖啡店', 'cafe', true, '学校后门的小店', [['study', '一起自习'], ['date', '约会']]),
      s('cinema', '电影院', 'cinema', true, '周末有学生票', [['watch', '一起观影'], ['date', '约会']]),
      s('river', '江边步道', 'park', false, '晚上的风很舒服', [['date', '散步'], ['music', '一起听歌'], ['rest', '散散步']]),
      s('market', '夜市', 'night-market', false, '烤冷面和糖葫芦', [['meal', '一起吃饭'], ['date', '逛夜市']]),
      s('arcade', '电玩城', 'amusement', true, '抓娃娃机总是差一点', [['game', '一起游戏'], ['date', '约会']]),
      s('aquarium', '水族馆', 'aquarium', true, '有一整面墙的水母', [['date', '约会']]),
    ],
    workStatus: '上课中',
    meals: { breakfast: '食堂的豆浆油条', lunch: '食堂', dinner: '和室友去吃麻辣烫' },
    task: '准备下周的期中考试',
    wardrobe: [
      { kind: 'daily', name: '卫衣配牛仔裤', tags: 'hoodie, jeans, sneakers' },
      { kind: 'sport', name: '运动套装', tags: 'track suit, sneakers' },
      { kind: 'sleep', name: '睡衣', tags: 'pajamas' },
    ],
  },
  city: {
    name: (who) => `${who}的城市`,
    blurb: '住的公寓、上班的地方和下班后常去的地方',
    areas: { home: '住处', campus: '上班的地方', city: '城里' },
    home: [s('apartment', '公寓', 'bedroom', true, '一个人住的小公寓', [['sleep', '哄睡'], ['music', '一起听歌'], ['meal', '一起做饭'], ['poke', '戳戳乐'], ['rest', '休息']])],
    campus: [
      s('office', '公司', 'library', true, '工位旁边有一盆绿萝', [['study', '陪你加班']]),
      s('cafeteria', '员工餐厅', 'dining', true, '周五有糖醋排骨', [['meal', '一起吃饭']]),
      s('gym', '健身房', 'gym', true, '下班后人最多', [['exercise', '健身']]),
    ],
    city: [
      s('cafe', '咖啡店', 'cafe', true, '常点的燕麦拿铁', [['study', '一起自习'], ['date', '约会']]),
      s('cinema', '电影院', 'cinema', true, '最后一排的位置', [['watch', '一起观影'], ['date', '约会']]),
      s('seaside', '海边', 'seaside', false, '周末开车就能到', [['date', '约会'], ['music', '一起听歌'], ['rest', '海边散步']]),
      s('gallery', '美术馆', 'gallery', true, '每个月换一次展', [['date', '约会']]),
      s('bar', '小酒馆', 'music', true, '周四有驻唱', [['music', '一起听歌'], ['date', '约会']]),
      s('market', '夜市', 'night-market', false, '下班路上会经过', [['meal', '一起吃饭'], ['date', '逛夜市']]),
      s('arcade', '电玩城', 'amusement', true, '解压的好地方', [['game', '一起游戏']]),
    ],
    workStatus: '上班中',
    meals: { breakfast: '路上买的三明治', lunch: '员工餐厅', dinner: '回家自己做一点' },
    task: '赶完这周的项目',
    wardrobe: [
      { kind: 'daily', name: '衬衫配长裤', tags: 'shirt, trousers, loafers' },
      { kind: 'sport', name: '运动服', tags: 'sportswear, sneakers' },
      { kind: 'sleep', name: '睡衣', tags: 'pajamas' },
    ],
  },
  xianxia: {
    name: () => '青崖宗',
    blurb: '山门里的竹舍、修习的地方，和山下常去的去处',
    areas: { home: '竹林', campus: '宗门', city: '后山与山下' },
    home: [s('bamboo', '竹舍', 'bedroom', true, '推窗就是竹林', [['sleep', '哄睡'], ['music', '听{{pronoun}}抚琴'], ['poke', '戳戳乐'], ['rest', '休息']])],
    campus: [
      s('scripture', '藏经阁', 'library', true, '最高一层的经卷不许外借', [['study', '一起修习'], ['read', '一起看书']]),
      s('hall', '膳堂', 'dining', true, '灵谷饭管饱', [['meal', '一起用膳']]),
      s('arena', '演武场', 'gym', false, '清晨有人练剑', [['exercise', '一起练剑']]),
    ],
    city: [
      s('spring', '后山温泉', 'pool', false, '雾气终年不散', [['date', '约会']]),
      s('market', '山门集市', 'night-market', false, '每逢初一十五最热闹', [['meal', '一起吃点心'], ['date', '逛集市']]),
      s('stars', '观星台', 'park', false, '夜里能看见整条银河', [['date', '看星星'], ['music', '一起听曲']]),
      s('beasts', '灵兽园', 'amusement', false, '有一只很亲人的白鹿', [['game', '一起游戏'], ['poke', '逗灵兽']]),
      s('qin', '琴阁', 'music', true, '挂着一张旧琴', [['music', '一起听曲'], ['watch', '一起听戏']]),
    ],
    workStatus: '修习中',
    meals: { breakfast: '膳堂的灵米粥', lunch: '膳堂', dinner: '山门集市的点心' },
    task: '把这卷心法抄完',
    wardrobe: [
      { kind: 'daily', name: '宗门道袍', tags: 'hanfu, wide sleeves, sash' },
      { kind: 'sport', name: '练功服', tags: 'martial arts uniform, wrist wraps' },
      { kind: 'sleep', name: '中衣', tags: 'white inner robe' },
    ],
  },
  cyber: {
    name: () => '新港第九区',
    blurb: '霓虹底下的胶囊公寓、上班的地方和下班后的街区',
    areas: { home: '公寓楼', campus: '工作区', city: '霓虹街区' },
    home: [s('capsule', '胶囊公寓', 'bedroom', true, '窗外是一整面广告屏', [['sleep', '哄睡'], ['music', '一起听歌'], ['poke', '戳戳乐'], ['rest', '休息']])],
    campus: [
      s('archive', '数据档案馆', 'library', true, '服务器的嗡嗡声很催眠', [['study', '陪你跑数据']]),
      s('canteen', '自动餐厅', 'dining', true, '营养块有七种口味', [['meal', '一起吃饭']]),
      s('ring', '地下拳馆', 'gym', true, '擂台的灯一直亮着', [['exercise', '一起练拳']]),
    ],
    city: [
      s('ramen', '拉面摊', 'night-market', false, '下雨天也开到凌晨', [['meal', '一起吃饭'], ['date', '约会']]),
      s('roof', '天台', 'park', false, '能看见整座城的霓虹', [['music', '一起听歌'], ['date', '约会']]),
      s('holo', '全息影院', 'cinema', true, '老电影修复版', [['watch', '一起观影'], ['date', '约会']]),
      s('arcade', '街机厅', 'amusement', true, '最高分还是{{pronoun}}的', [['game', '一起游戏']]),
      s('cafe', '赛博咖啡', 'cafe', true, '咖啡是合成的，但很香', [['study', '一起自习'], ['date', '约会']]),
    ],
    workStatus: '跑数据',
    meals: { breakfast: '一支营养剂', lunch: '自动餐厅', dinner: '街角的拉面' },
    task: '修好那段坏掉的记忆数据',
    wardrobe: [
      { kind: 'daily', name: '机能外套', tags: 'techwear jacket, cargo pants, boots' },
      { kind: 'sport', name: '训练服', tags: 'compression suit, sneakers' },
      { kind: 'sleep', name: '宽松 T 恤', tags: 'oversized t-shirt' },
    ],
  },
  fantasy: {
    name: () => '星辉王都',
    blurb: '学院宿舍、上课的地方和王都里常去的去处',
    areas: { home: '学院宿舍', campus: '魔法学院', city: '王都' },
    home: [s('dorm', '学院宿舍', 'bedroom', true, '窗台上养着会发光的花', [['sleep', '哄睡'], ['music', '一起听歌'], ['poke', '戳戳乐'], ['rest', '休息']])],
    campus: [
      s('books', '魔法书库', 'library', true, '禁书区要老师签字', [['study', '一起研读'], ['read', '一起看书']]),
      s('hall', '学院食堂', 'dining', true, '南瓜派是招牌', [['meal', '一起吃饭']]),
      s('training', '训练场', 'gym', false, '骑士团在这里操练', [['exercise', '一起训练']]),
    ],
    city: [
      s('tavern', '酒馆', 'music', true, '吟游诗人每晚都在', [['music', '一起听歌'], ['meal', '一起吃饭']]),
      s('market', '集市', 'night-market', false, '矮人的铁匠铺在尽头', [['date', '逛集市'], ['meal', '一起吃点心']]),
      s('plaza', '钟楼广场', 'park', false, '整点会响起钟声', [['date', '约会']]),
      s('arena', '竞技场', 'amusement', false, '周末有魔法比赛', [['game', '一起游戏'], ['watch', '一起观赛']]),
      s('lake', '湖畔', 'seaside', false, '传说湖里住着精灵', [['date', '约会'], ['music', '一起听歌'], ['rest', '湖边静坐']]),
    ],
    workStatus: '上课中',
    meals: { breakfast: '面包和热牛奶', lunch: '学院食堂', dinner: '酒馆的炖菜' },
    task: '练熟新学的那个咒语',
    wardrobe: [
      { kind: 'daily', name: '学院制服', tags: 'academy uniform, cape' },
      { kind: 'sport', name: '训练服', tags: 'leather armor, boots' },
      { kind: 'sleep', name: '睡袍', tags: 'nightgown' },
    ],
  },
};

const HINTS: [StarterSetting, RegExp][] = [
  ['xianxia', /修仙|仙侠|修真|宗门|门派|师尊|师兄|师姐|灵根|江湖|武侠|古代|皇宫|王爷|公主|宫廷|xianxia|wuxia|cultivat|hanfu/i],
  ['cyber', /赛博|义体|霓虹|未来都市|星际|机甲|仿生|黑客|太空|cyberpunk|android|cyborg|sci-?fi/i],
  ['fantasy', /魔法|骑士|精灵|魔王|王国|公会|冒险者|巨龙|魔族|异世界|fantasy|magic|elf|knight|isekai/i],
  ['campus', /学生|大学|高中|初中|学院|社团|宿舍|同学|学长|学姐|校园|student|school|college|campus/i],
  ['city', /公司|上班|职员|白领|医生|律师|老板|总裁|同事|打工|office|worker|doctor/i],
];

/** 从角色卡里认设定；什么都没写时按校园 */
export function detectSetting(c: Character): StarterSetting {
  const text = [c.name, c.card.description, c.card.personality, c.card.scenario, c.card.firstMes, c.card.tags?.join(' '), c.appearanceTags]
    .filter(Boolean)
    .join('\n');
  let best: StarterSetting = 'campus';
  let score = 0;
  for (const [setting, re] of HINTS) {
    const n = (text.match(new RegExp(re.source, 'gi')) ?? []).length;
    if (n > score) {
      best = setting;
      score = n;
    }
  }
  return best;
}

function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

const CORE: SceneId[] = ['study', 'meal', 'exercise', 'sleep', 'music', 'date', 'watch', 'game'];

/** 生成起步世界（BuiltWorldSpec，交给 worldFromSpec 变成世界和模板） */
export function starterWorldSpec(c: Character, setting = detectSetting(c)): BuiltWorldSpec {
  const pool = POOLS[setting];
  const rand = seeded(hash(c.id));
  const shuffle = <T>(arr: T[]) => arr.map((v) => [rand(), v] as const).sort((a, b) => a[0] - b[0]).map(([, v]) => v);

  const home = pool.home[0]!;
  const campus = shuffle(pool.campus).slice(0, 3);
  // 城里挑 4–5 个：先补齐还没地方做的常用事，再随机补满
  const covered = new Set([...home.acts, ...campus.flatMap((sp) => sp.acts)].map(([id]) => id));
  const city: Spot[] = [];
  const rest = shuffle(pool.city);
  for (const id of CORE) {
    if (covered.has(id)) continue;
    const sp = rest.find((x) => !city.includes(x) && x.acts.some(([a]) => a === id));
    if (sp) {
      city.push(sp);
      sp.acts.forEach(([a]) => covered.add(a));
    }
  }
  const want = 4 + Math.floor(rand() * 2);
  for (const sp of rest) if (city.length < want && !city.includes(sp)) city.push(sp);

  const toLoc = (sp: Spot, area: BuiltLocationSpec['area']): BuiltLocationSpec => ({
    key: sp.key,
    name: sp.name,
    area,
    indoor: sp.indoor,
    backdrop: sp.backdrop,
    blurb: pronounText(sp.blurb, c),
    activities: sp.acts.map(([sceneId, label]) => ({ sceneId, label: pronounText(label, c) })),
  });
  const locations = [toLoc(home, 'home'), ...campus.map((sp) => toLoc(sp, 'campus')), ...city.map((sp) => toLoc(sp, 'city'))];

  // 作息：睡在住处，白天在做正事的地方，饭点去吃饭的地方，傍晚运动，晚上去城里转转
  const where = (scene: SceneId, fallback: string) => locations.find((l) => l.activities.some((a) => a.sceneId === scene) && l.key !== home.key)?.key ?? fallback;
  const work = campus.find((sp) => sp.acts.some(([a]) => a === 'study'))?.key ?? campus[0]?.key ?? home.key;
  const eat = where('meal', home.key);
  const move = where('exercise', work);
  const fun = city.find((sp) => sp.acts.some(([a]) => a === 'date'))?.key ?? home.key;
  const schedule: RhythmSlot[] = [
    { from: '00:00', to: '07:30', locationId: home.key, status: '睡觉中' },
    { from: '07:30', to: '08:30', locationId: home.key, status: '吃早饭' },
    { from: '08:30', to: '11:30', locationId: work, status: pool.workStatus },
    { from: '11:30', to: '12:30', locationId: eat, status: '吃午饭' },
    { from: '12:30', to: '17:30', locationId: work, status: pool.workStatus },
    { from: '17:30', to: '18:30', locationId: eat, status: '吃晚饭' },
    { from: '18:30', to: '19:30', locationId: move, status: '锻炼' },
    { from: '19:30', to: '21:30', locationId: fun, status: '出门转转' },
    { from: '21:30', to: '24:00', locationId: home.key, status: '准备睡了' },
  ];

  return {
    name: pool.name(c.name),
    blurb: pool.blurb,
    areas: pool.areas,
    homeKey: home.key,
    locations,
    people: [],
    schedule,
    meals: pool.meals,
    wardrobe: pool.wardrobe,
    task: pool.task,
  };
}
