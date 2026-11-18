import type { CatalogItem } from './model';

const wood = ['#b79875', '#795740', '#e5ddcc', '#596b60'];
const linen = ['#d9d6cb', '#7c9385', '#b58163', '#34466b'];
const campus = ['#537b70', '#ded9ca', '#374c61', '#a37952'];
const rail = ['#406b61', '#953f4b', '#30475d', '#c39867'];
const metal = ['#313b52', '#596477', '#e1e4e6', '#553f64'];

/** Coordinated furniture for bedrooms, kitchens, bathrooms and work spaces. */
export const HOME_CATALOG: CatalogItem[] = [
  { id: 'platformBed', name: '软包悬浮床', style: 'apartment', cat: 'bed', w: 2, d: 2, h: 1, place: 'floor', beds: [[-.45, .1], [.45, .1]], bedH: .4, colors: linen },
  { id: 'linenWardrobe', name: '藤编衣橱', style: 'apartment', cat: 'bed', w: 2, d: 1, h: 1.9, place: 'floor', colors: wood },
  { id: 'islandKitchen', name: '公寓一体灶柜', style: 'apartment', cat: 'kitchen', w: 2, d: 1, h: .8, top: .8, place: 'floor', colors: linen },
  { id: 'floatingVanity', name: '洞石双盆浴柜', style: 'apartment', cat: 'bath', w: 2, d: 1, h: 1, place: 'floor', colors: wood },
  { id: 'tansu', name: '旅店桐木衣箪笥', style: 'onsen', cat: 'bed', w: 2, d: 1, h: 1.5, place: 'floor', colors: wood },
  { id: 'zenDesk', name: '和室文书矮几', style: 'onsen', cat: 'table', w: 2, d: 1, h: .36, top: .36, place: 'floor', colors: wood },
  { id: 'ryokanKitchen', name: '旅店木作料理柜', style: 'onsen', cat: 'kitchen', w: 2, d: 1, h: .78, top: .78, place: 'floor', colors: wood },
  { id: 'stoneBasin', name: '温泉石钵洗手台', style: 'onsen', cat: 'bath', w: 1, d: 1, h: .85, place: 'floor', colors: ['#899087', '#b7b3a3', '#65786e'] },
  { id: 'cedarBench', name: '桧木更衣长凳', style: 'onsen', cat: 'seat', w: 2, d: 1, h: .4, seats: [[-.45, 0], [.45, 0]], seatH: .4, place: 'floor', colors: wood },
  { id: 'dormBed', name: '学院铁架储物床', style: 'academy', cat: 'bed', w: 1, d: 2, h: 1.1, beds: [[0, .1]], bedH: .44, place: 'floor', colors: campus },
  { id: 'academicLocker', name: '学院个人储物柜', style: 'academy', cat: 'bed', w: 1, d: 1, h: 1.85, place: 'floor', colors: campus },
  { id: 'lectureDesk', name: '大学连排课桌椅', style: 'academy', cat: 'table', w: 2, d: 1.5, h: .78, top: .76, seats: [[-.5, .47], [.5, .47]], seatTurns: [2, 2], seatH: .43, place: 'floor', colors: campus },
  { id: 'lectern', name: '大学讲台', style: 'academy', cat: 'study', w: 1, d: 1, h: 1.06, place: 'floor', colors: campus },
  { id: 'chalkboard', name: '大学教学推拉黑板', style: 'academy', cat: 'wall', w: 3, d: .15, h: 1.3, wallY: 1.65, place: 'wall', colors: wood },
  { id: 'workstation', name: '研究员隔板工位', style: 'academy', cat: 'table', w: 2, d: 1, h: 1.3, top: .72, place: 'floor', colors: campus },
  { id: 'canteenTable', name: '食堂四人连体餐桌', style: 'academy', cat: 'table', w: 2, d: 2, h: .75, top: .75, seats: [[-.5, -.68], [.5, -.68], [-.5, .68], [.5, .68]], seatTurns: [0, 0, 2, 2], seatH: .42, place: 'floor', colors: campus },
  { id: 'servingCounter', name: '食堂保温取餐台', style: 'academy', cat: 'kitchen', w: 2, d: 1, h: 1.35, place: 'floor', colors: campus },
  { id: 'mealTray', name: '食堂分格餐盘', style: 'academy', cat: 'kitchen', w: .5, d: .5, h: .09, place: 'top', prefer: ['canteenTable'], colors: ['#bbc6c5', '#ddd9c8', '#91a89b'] },
  { id: 'communalBasin', name: '学院双龙头盥洗台', style: 'academy', cat: 'bath', w: 2, d: 1, h: .95, place: 'floor', colors: campus },
  { id: 'sleeperBed', name: '列车卧铺', style: 'railway', cat: 'bed', w: 1, d: 2, h: 1, beds: [[0, .1]], bedH: .43, place: 'floor', colors: rail },
  { id: 'cabinWardrobe', name: '包厢旅行衣柜', style: 'railway', cat: 'bed', w: 1, d: 1, h: 1.85, place: 'floor', colors: wood },
  { id: 'galleyKitchen', name: '餐车不锈钢灶柜', style: 'railway', cat: 'kitchen', w: 2, d: 1, h: .8, top: .8, place: 'floor', colors: rail },
  { id: 'carriageVanity', name: '列车折角洗漱柜', style: 'railway', cat: 'bath', w: 1, d: 1, h: .95, place: 'floor', colors: rail },
  { id: 'foldingDesk', name: '包厢折叠写字桌', style: 'railway', cat: 'table', w: 1, d: 1, h: .65, top: .65, place: 'floor', colors: wood },
  { id: 'doublePod', name: '双人休眠平台', style: 'cyber', cat: 'bed', w: 2, d: 2, h: 1.3, beds: [[-.45, .1], [.45, .1]], bedH: .38, place: 'floor', colors: metal },
  { id: 'storagePod', name: '机舱装备储存柜', style: 'cyber', cat: 'bed', w: 1, d: 1, h: 1.85, light: true, place: 'floor', colors: metal },
  { id: 'nutritionStation', name: '机舱营养料理站', style: 'cyber', cat: 'kitchen', w: 2, d: 1, h: 1.25, top: .76, place: 'floor', colors: metal },
  { id: 'hygienePod', name: '机舱淋浴净化舱', style: 'cyber', cat: 'bath', w: 1, d: 2, h: 1.9, light: true, place: 'floor', colors: metal },
  { id: 'holoTable', name: '航行全息沙盘', style: 'cyber', cat: 'table', w: 2, d: 1, h: 1.15, place: 'floor', colors: metal },
];
