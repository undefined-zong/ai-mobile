import families from './background-families.json';

export type BackgroundPeriod = 'day' | 'dusk' | 'night' | 'indoor';

export interface BackgroundKindDef {
  label: string;
  scenes: string[];
  aliases: string[];
  icon: string;
  sets: string[];
}

const kind = (label: string, scene: string, words: string, icon: string, sets: string[] = []): BackgroundKindDef => ({
  label, scenes: scene.split('|'), aliases: words.split('|'), icon: `i-lucide-${icon}`, sets,
});

/** 地点用途与素材分类分开：旧世界的宽泛 key 仍然可用，新世界可以选择具体房间。 */
export const BACKGROUND_KINDS = {
  bedroom: kind('卧室', '卧室', '卧室|寝室|宿舍|闺房|寝殿|竹舍|睡房|bedroom|dormitory|dorm', 'bed-double'),
  room: kind('房间', '卧室', '房间|居室|小屋|room', 'house'),
  living: kind('客厅', '客厅', '客厅|起居室|和室|茶室|会客厅|living room|tatami room', 'sofa'),
  study: kind('书房', '书房', '书房|书斋|电脑房|study room', 'book-open'),
  dining: kind('餐桌', '厨房', '餐桌|用餐区|dining room', 'utensils'),
  kitchen: kind('厨房', '厨房', '厨房|灶房|炊事房|kitchen', 'cooking-pot'),
  bathroom: kind('浴室与洗手间', '洗手间', '浴室|卫生间|洗手间|盥洗室|厕所|bathroom|washroom|toilet', 'bath'),
  entrance: kind('玄关', '玄关', '玄关|门厅|入户|entrance hall', 'door-open'),
  corridor: kind('走廊', '走廊', '走廊|长廊|回廊|连廊|corridor|hallway', 'door-open'),
  balcony: kind('阳台', '阳台', '阳台|露台|balcony|veranda', 'sun'),
  courtyard: kind('庭院', '庭院', '庭院|庭园|庭園|花园|花園|庭前|小院|后院|中庭|courtyard|garden', 'flower-2'),
  attic: kind('阁楼', '阁楼', '阁楼|阁楼房|attic', 'house'),
  storage: kind('储藏室', '储藏室', '储藏室|储物间|杂物间|仓库|库房|storeroom|storage room|warehouse', 'boxes'),
  basement: kind('地下室', '地下室', '地下室|地下据点|地下基地|地下房间|秘密基地|basement|hideout', 'door-closed'),
  'house-exterior': kind('住宅外观', '住宅外观', '住宅外观|公寓外观|屋外|宅邸外|house exterior', 'house'),
  library: kind('图书馆', '图书馆|书房', '图书馆|图书室|阅览室|书库|藏书阁|藏经阁|library|reading room', 'library-big', ['MC-library', 'MC-library_room', 'AP-study_room']),
  bookstore: kind('书店', '书店', '书店|书屋|书铺|bookstore|bookshop', 'book-open'),
  school: kind('校园', '学校', '学校|校园|校门|大学|学园|学院|学堂|school|campus|academy', 'school', ['MC-campus', 'MC-school_in_spring', 'MC-school_entrance']),
  classroom: kind('教室', '学校', '教室|课堂|课室|讲堂|classroom|lecture hall', 'presentation', ['MC-front_of_classroom', 'MC-back_of_classroom', 'MC-blackboard']),
  'school-corridor': kind('教学楼走廊', '学校', '教学楼走廊|学校走廊|school hallway', 'school', ['MC-school_hallway', 'MC-connecting_corridor']),
  'school-yard': kind('校园庭院', '学校', '校园庭院|校园长椅|学校中庭|school courtyard', 'trees', ['AP-garden', 'MC-school_courtyard_bench', 'MC-behind_school_gym']),
  rooftop: kind('天台', '学校', '天台|屋顶|楼顶|观星台|rooftop|roof terrace', 'cloud-sun', ['MC-school_rooftop']),
  laboratory: kind('实验室', '学校', '实验室|实验楼|研究室|炼金室|炼丹房|laboratory|science lab', 'flask-conical', ['AP-science_laboratory']),
  infirmary: kind('校医室', '学校', '校医室|医务室|保健室|infirmary', 'cross', ['AP-school_infirmary']),
  'club-room': kind('社团室', '学校', '社团室|社办|活动室|部室|club room', 'users', ['MC-cultural_club_room']),
  'music-room': kind('音乐教室', '学校', '音乐教室|音乐室|练琴房|琴房|琴阁|music room', 'music', ['MC-school_music_room']),
  'staff-room': kind('教师办公室', '学校', '教师办公室|教员室|职员室|staff room', 'briefcase-business', ['MC-staff_room']),
  track: kind('操场', '操场', '操场|田径|跑道|球场|演武场|练武场|校场|训练场|竞技场|运动场|track|sports ground|arena', 'footprints'),
  'sports-hall': kind('体育馆', '体育馆', '体育馆|弓道|道场|武道馆|dojo|sports hall', 'target'),
  gym: kind('健身房', '健身房', '健身房|力量房|训练房|拳馆|器械区|gym|fitness', 'dumbbell'),
  pool: kind('游泳池', '游泳池', '游泳池|泳池|游泳馆|pool', 'waves'),
  hospital: kind('医院', '医院', '医院|医馆|诊所|医疗中心|hospital|clinic', 'hospital'),
  ward: kind('病房', '医院', '病房|住院部|hospital room|ward', 'bed', ['AP-hospital-rooms']),
  surgery: kind('手术室', '医院', '手术室|operating room|surgery', 'cross', ['AP-hospital-rooms']),
  'nurse-station': kind('护士站', '医院', '护士站|护理站|nurse station', 'cross', ['AP-hospital-rooms']),
  office: kind('办公室', '办公室', '办公室|办公区|公司|事务所|工位|office|workplace', 'briefcase-business'),
  archive: kind('档案室', '档案室', '档案室|档案馆|资料室|档案库|archive', 'archive'),
  'machine-room': kind('机房', '机房', '机房|服务器|数据中心|设备间|机械室|控制室|server room|machine room|data center', 'server'),
  facility: kind('公共设施', '公共设施', '公共设施|服务大厅|办事大厅|电梯厅|楼梯间|接待大厅|facility|elevator hall', 'building-2'),
  police: kind('警察局', '警察局', '警察局|警署|派出所|治安署|police', 'shield'),
  bank: kind('银行', '银行', '银行|取款|钱庄|bank|atm', 'landmark'),
  cafe: kind('咖啡厅', '咖啡厅', '咖啡厅|咖啡馆|咖啡店|咖啡屋|咖啡|茶馆|茶楼|cafe|café|coffee shop', 'coffee'),
  restaurant: kind('餐厅', '餐厅', '餐厅|饭店|餐馆|饭馆|小吃店|料理店|寿司|拉面店|膳堂|restaurant|diner|sushi', 'utensils'),
  canteen: kind('食堂', '餐厅', '食堂|员工餐厅|学生餐厅|canteen|cafeteria', 'utensils', ['MC-casual_restaurant']),
  bar: kind('酒吧', '酒吧|餐厅', '酒吧|酒馆|居酒屋|酒肆|tavern|bar|pub|izakaya', 'wine'),
  karaoke: kind('KTV', 'KTV', 'KTV|卡拉OK|歌厅|练歌房|karaoke', 'mic'),
  music: kind('听歌的房间', '客厅', '听歌房|听歌的房间|音乐角|listening room', 'music'),
  concert: kind('演唱会', '演唱会', '演唱会|演出舞台|舞台|音乐厅|剧院|戏台|剧场|concert|stage|theatre|theater', 'mic-vocal'),
  cinema: kind('电影院', '电影院', '电影院|影院|放映厅|影城|cinema|movie theater', 'clapperboard'),
  gallery: kind('美术馆', '美术馆', '美术馆|画廊|艺术馆|雕塑展|art gallery|art museum', 'frame'),
  museum: kind('博物馆', '博物馆', '博物馆|化石展|历史馆|museum', 'landmark'),
  aquarium: kind('水族馆', '水族馆', '水族馆|海洋馆|海底隧道|水母馆|aquarium', 'fish'),
  amusement: kind('游乐园', '游乐园', '游乐园|游乐场|摩天轮|主题乐园|amusement park|theme park', 'ferris-wheel'),
  arcade: kind('游戏厅', '游戏厅', '电玩城|游戏厅|街机厅|街机|抓娃娃|arcade|game center', 'gamepad-2'),
  bowling: kind('保龄球馆', '保龄球馆', '保龄球|bowling', 'circle-dot'),
  zoo: kind('动物园', '动物园', '动物园|灵兽园|兽园|动物展区|zoo', 'paw-print'),
  botanical: kind('植物园', '植物园', '植物园|温室|花房|botanical|greenhouse', 'sprout'),
  'hot-spring': kind('温泉', '温泉', '温泉|汤池|露天浴场|onsen|hot spring', 'waves'),
  shrine: kind('神社', '神社', '神社|神殿|寺庙|寺院|山门|祠堂|道观|庙宇|shrine|temple', 'landmark'),
  'night-market': kind('庙会与夜市', '庙会', '夜市|夜宵摊|庙会|祭典|集市|市集|小吃摊|拉面摊|night market|festival|bazaar', 'lamp'),
  hotel: kind('酒店', '酒店', '酒店|旅馆|旅店|客栈|民宿|驿站|hotel|inn|ryokan', 'bed-double'),
  'bus-stop': kind('公交站', '公交站', '公交站|巴士站|车站候车亭|bus stop|bus station', 'bus'),
  station: kind('火车站', '火车站', '火车站|地铁站|车站|站台|铁路站|train station|railway station|platform', 'train-front'),
  train: kind('火车车厢', '火车', '车厢|列车内|火车内|通勤列车|train interior|inside train', 'train-front'),
  railway: kind('铁路沿线', '铁路沿线', '铁路沿线|铁道边|铁路边|铁轨|railway|railside', 'train-track'),
  crossing: kind('铁路道口', '铁路道口', '铁路道口|平交道口|铁道口|railroad crossing', 'train-track'),
  car: kind('汽车内', '汽车', '汽车内|车里|轿车|车内|驾驶室|car interior|inside car', 'car'),
  airport: kind('机场', '机场', '机场|航站楼|候机厅|航天港|airport|terminal', 'plane'),
  airplane: kind('飞机', '飞机', '飞机|客舱|机舱|airplane|aircraft|cabin', 'plane'),
  ship: kind('轮船', '轮船', '轮船|游轮|邮轮|甲板|船舱|飞艇|星舰|cruise|ship|deck', 'ship'),
  pier: kind('码头', '码头', '码头|港口|港湾|防波堤|渡口|栈桥|pier|harbor|harbour|dock|port', 'anchor'),
  park: kind('公园', '公园', '公园|绿地|广场|樱花园|湖畔|湖边|park|plaza|lakeside', 'trees'),
  riverside: kind('河岸步道', '河岸步道', '江边步道|河堤|江堤|堤岸|河岸步道|滨河步道|河边散步|riverside trail|levee', 'footprints'),
  river: kind('河岸', '河岸', '河岸|河边|江边|溪边|溪流|河滩|桥下|riverbank|river', 'waves'),
  seaside: kind('海边', '海边', '海边|海岸|海滩|沙滩|海岛|海洋|大海|seaside|beach|ocean|sea', 'sailboat'),
  mountain: kind('山景', '山景', '山峰|山顶|山崖|山巅|雪山|山脉|山谷|悬崖|后山|mountain|cliff', 'mountain'),
  forest: kind('山间步道', '山间步道', '森林|林间|树林|竹林|山间步道|山路|石径|秘境|forest|woodland|mountain path', 'trees'),
  campsite: kind('露营地', '露营地', '露营|营地|帐篷|野营|野餐|camp|camping|campsite', 'tent'),
  'country-road': kind('乡间道路', '乡间道路', '乡间|乡村道路|田间|田园|乡道|村道|country road|rural road', 'route'),
  residential: kind('住宅街', '住宅街', '住宅街|住宅区|居民区|小区街道|residential street', 'houses'),
  street: kind('城市街道', '城市街道', '城市街道|街道|大街|路口|天桥|巷子|后巷|街头|商业区|street|alley|intersection', 'building-2'),
  'shopping-street': kind('商业街', '商业街', '商业街|步行街|商店街|沿街商铺|shopping street|shopping arcade', 'store'),
  convenience: kind('便利店', '便利店', '便利店|小卖部|杂货店|convenience store', 'store'),
  supermarket: kind('超市', '超市', '超市|supermarket|grocery', 'shopping-basket'),
  mall: kind('购物中心', '购物中心', '购物中心|商场|百货|shopping mall|mall', 'shopping-bag'),
  ruins: kind('废弃建筑', '废弃建筑', '废弃|废墟|遗迹|荒废|旧厂房|ruin|abandoned', 'brick-wall'),
} satisfies Record<string, BackgroundKindDef>;

export type BackdropKey = keyof typeof BACKGROUND_KINDS;
export const BACKDROPS = Object.keys(BACKGROUND_KINDS) as BackdropKey[];
export const BACKGROUND_FAMILIES = families;

export interface BackgroundPlace {
  id?: string;
  name?: string;
  blurb?: string;
  backdrop?: string;
  indoor?: boolean;
  /** 可固定素材系列（系列 id 来自素材库）；时段仍然自动选择。 */
  backgroundSet?: string;
  /** 可固定到某一张图（素材 id 来自素材库）：给了就用这一张，不再按时段和灯光挑（哄睡的场景里自己挑的那张）。 */
  backgroundAsset?: string;
}

function aliasScore(text: string, words: string[]): number {
  const normalized = text.normalize('NFKC').toLowerCase();
  return Math.max(0, ...words.map((word) => {
    const term = word.toLowerCase();
    const matches = term === '和室' ? /和室(?!友)/.test(normalized) : /[\u3400-\u9fff]/u.test(term)
      ? normalized.includes(term)
      : new RegExp(`\\b${term}\\b`, 'i').test(normalized);
    return matches ? term.length : 0;
  }));
}

/** 先看地点名字，再看描述；让旧世界的“library 公司”“amusement 街机厅”自动找到真实用途。 */
export function backdropKindFor(place: BackgroundPlace, fallback: BackdropKey = 'room'): BackdropKey {
  for (const text of [place.name, place.blurb]) {
    if (!text) continue;
    const ranked = BACKDROPS.map((key) => ({ key, score: aliasScore(text, BACKGROUND_KINDS[key].aliases) }))
      .sort((a, b) => b.score - a.score || Number(b.key === place.backdrop) - Number(a.key === place.backdrop));
    if (ranked[0]!.score > 0) return ranked[0]!.key;
  }
  return BACKDROPS.includes(place.backdrop as BackdropKey) ? place.backdrop as BackdropKey : fallback;
}

/** 传给建世界任务的是可用系列，不把 955 张图片或图片 URL 放进模型提示词。 */
export function backgroundLibraryPrompt(): string {
  return [
    '本次可用的背景素材库（地点名字照角色世界观写，图片从最接近的真实素材里挑）：',
    `backdrop 类型：${BACKDROPS.map((key) => `${key} ${BACKGROUND_KINDS[key].label}`).join(' / ')}`,
    '可选 backgroundSet 固定下面某一系列的完整 id；留空时程序按地点名称、描述、室内外和世界观自动匹配。backgroundSet 只选系列，白天/黄昏/夜间由程序切换。blurb 写清房间用途与风格（例如古典书房、日式和室、森林石径）。没有完全相同的世界观画面时选地点用途与风格最接近的，不把所有地点都写成公园或卧室。背景类型和系列以本次素材库为准。',
    ...families.map((f) => `- ${f.id}（${f.indoor ? '室内' : '室外'}；${f.periods.join('/')}）`),
  ].join('\n');
}
