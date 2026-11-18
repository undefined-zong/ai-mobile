import { addItem, catalogItem, roomType, type DecorRoom, type Turn, type WallSide } from './model';

export const HOME_ROOM_TYPES = ['master', 'second', 'living', 'kitchen', 'bath', 'study'] as const;
export type HomeRoomType = typeof HOME_ROOM_TYPES[number];
interface Piece {
  kind: string; x: number; z: number; turn?: Turn; color?: string; wall?: WallSide; y?: number;
  /** Stable recipe key, so decorations can target one of several identical desks. */
  key?: string; on?: string;
}
interface RoomScheme {
  title: string;
  desc: string;
  pieces: Piece[];
  wall?: DecorRoom['wall'];
  floor?: DecorRoom['floor'];
}
export interface RoomStyle {
  id: string; name: string; desc: string; furniture: string; accent: string;
  wall: DecorRoom['wall']; floor: DecorRoom['floor'];
  rooms: Record<HomeRoomType, RoomScheme>;
}
const p = (kind: string, x: number, z: number, options: Partial<Piece> = {}): Piece => ({ kind, x, z, ...options });
const wall = (kind: string, x: number, z = 0, side: WallSide = 'back', y = 1.65): Piece => p(kind, x, z, { wall: side, y });
const top = (kind: string, x: number, z: number, on: string): Piece => p(kind, x, z, { on });
const radio = (color: string, x = 5.5, z = 4.5): Piece => p('radio', x, z, { color });
const tile = { finish: 'tile', color: '#c6c8bc' };
const modernWindow = () => wall('window', 0, 2.4, 'left', 1.5);
const shoji = () => [wall('shoji', 1.5, 0, 'back', 1.35), wall('shoji', 4.5, 0, 'back', 1.35)];
const railWindow = () => [wall('trainWindow', 2, 0, 'back', 1.6), wall('trainWindow', 0, 2.5, 'left', 1.65)];
const neon = () => [wall('neonStrip', 4.5, 0, 'back', 2.35), wall('neonStrip', 0, 2, 'left', 2.35)];

/** Five complete homes, each with six independently furnished rooms. Coordinates are in a 6 × 5 room. */
export const ROOM_STYLES: RoomStyle[] = [
  {
    id: 'apartment', name: '现代化公寓', desc: '洞石、织物与胡桃木，六间舒展的日常空间', furniture: '模块沙发 · 软包床 · 一体灶柜 · 洞石浴柜', accent: '#7b8b77',
    wall: { finish: 'plain', color: '#e6e0d4' }, floor: { finish: 'herring', color: '#b59476' },
    rooms: {
      master: { title: '胡桃木主卧', desc: '软包双人床、藤编衣橱和床边阅读角。', pieces: [
        p('platformBed', 2.5, 1.5), p('linenWardrobe', 5, .5), p('nightstand', 1, 1, { color: '#795740' }), p('nightstand', 4, 1, { key: 'right', color: '#795740' }),
        p('rugRect', 2.5, 3), p('armchair', .75, 3.75, { color: '#7c9385' }), p('arcLamp', .5, 2.5), p('dresser', 4.5, 4, { color: '#b79875' }), radio('#a87b55'),
        wall('slatPanel', 2.5, 0, 'back', 1.35), modernWindow(), top('deskLamp', 1, 1, 'nightstand'), top('books', 4, 1, 'right'), top('vase', 4.5, 4, 'dresser'), wall('painting', 0, 4, 'left'),
      ] },
      second: { title: '柔光客卧', desc: '客床、写字桌和一处安静的单人阅读位。', pieces: [
        p('platformBed', 1.5, 1.5, { color: '#b58163' }), p('linenWardrobe', 5, .5, { color: '#e5ddcc' }), p('desk', 4.75, 3.25, { color: '#b79875' }), p('chair', 4.75, 4.5, { turn: 2, color: '#7c9385' }),
        p('nightstand', 3, 1), p('rugRunner', 1.5, 3.5, { turn: 1 }), p('basket', .5, 4.5), radio('#e4d9bf', 3, 4.5), p('plantTall', 5.5, 2), modernWindow(), wall('slatPanel', 1.5),
        top('laptop', 4.5, 3.25, 'desk'), top('deskLamp', 5.25, 3.25, 'desk'), top('vase', 3, 1, 'nightstand'), wall('painting', 4.5),
      ] },
      living: { title: '开放式会客厅', desc: '模块沙发围合洞石茶几，弧形灯照亮阅读角。', pieces: [
        p('modularSofa', 2, .75), p('stoneTable', 2.5, 2.5), p('rugRect', 2.5, 2.5, { color: '#b3bcaa' }), p('armchair', 4.5, 2.5, { turn: 3, color: '#8b9b8a' }), p('arcLamp', 5.5, .75),
        p('tvstand', 2.5, 4.5, { turn: 2, color: '#795740' }), p('tree', .5, 3.5), radio('#a87b55'), wall('slatPanel', 4.75, 0, 'back', 1.4), modernWindow(), wall('painting', 2),
        top('teaSet', 2, 2.5, 'stoneTable'), top('books', 3, 2.5, 'stoneTable'), top('tv', 2.5, 4.5, 'tvstand'),
      ] },
      kitchen: { title: '公寓餐厨', desc: '一体灶柜、水槽与双人用餐区，料理和吃饭都齐备。', floor: { finish: 'tile', color: '#d8cfba' }, pieces: [
        p('islandKitchen', 1, .5), p('sink', 3, .5, { color: '#d9d6cb' }), p('fridge', 5.5, .5, { color: '#ded9ca' }), p('dining', 2.75, 3.1, { color: '#b79875' }),
        p('chair', 1.25, 3, { turn: 1, color: '#7c9385' }), p('chair', 4.25, 3, { turn: 3, color: '#7c9385' }), p('plantTall', .5, 4.5), radio('#e4d9bf'),
        wall('hood', 1, 0, 'back', 1.8), wall('wallCabinet', 3, 0, 'back', 2), modernWindow(), top('placeSetting', 2.25, 3, 'dining'), top('placeSetting', 3.25, 3, 'dining'), top('fruitBasket', 2.75, 3.5, 'dining'), top('spiceJars', 1.5, .5, 'islandKitchen'),
      ] },
      bath: { title: '洞石浴室', desc: '双盆浴柜、浴缸、洗衣区与柔软浴巾。', floor: tile, wall: { finish: 'check', color: '#ded9c8' }, pieces: [
        p('floatingVanity', 3, .5), p('bathtub', .75, 1.5, { color: '#e5ddcc' }), p('toilet', 5.5, .75), p('washer', 5.5, 2.5, { color: '#ded9ca' }), p('nightstand', 3.5, 3.5),
        p('rugRunner', 2.75, 2.5, { color: '#b3bcaa' }), p('basket', 1, 4.5), p('plantTall', .5, 3.5), radio('#e4d9bf'),
        wall('mirror', 2.5), wall('mirror', 3.5), wall('towel', 0, 3.25, 'left', 1.4), top('towels', 5.5, 2.5, 'washer'), top('bathTray', 3.5, 3.5, 'nightstand'),
      ] },
      study: { title: '居家工作室', desc: '长书桌、整墙书架和靠窗阅读椅。', pieces: [
        p('desk', 2.5, 1, { color: '#795740' }), p('officeChair', 2.5, 2.5, { turn: 2, color: '#7c9385' }), p('bookshelf', 5.5, 1.5, { turn: 3, color: '#b79875' }),
        p('armchair', .75, 3.5, { color: '#d9d6cb' }), p('coffee', 2, 4), p('arcLamp', .5, 2), p('rugRect', 2.5, 3.5), radio('#a87b55'), p('tree', 4.5, 4.5),
        wall('slatPanel', 4.5), modernWindow(), top('monitor', 2.25, 1, 'desk'), top('deskLamp', 3.25, 1, 'desk'), top('openbook', 2, 4, 'coffee'),
      ] },
    },
  },
  {
    id: 'onsen', name: '日式温泉旅店', desc: '从榻榻米客房到桧木汤屋的一整座旅店', furniture: '和式铺床 · 被炉 · 桧木浴池 · 木作料理柜', accent: '#aa7853',
    wall: { finish: 'timber', color: '#dfd4bb' }, floor: { finish: 'tatami', color: '#b9bb8f' },
    rooms: {
      master: { title: '庭院和室', desc: '双人铺床、桐木衣箪笥和临窗茶席。', pieces: [
        p('futon', 2, 1.5), p('tansu', 5, .5), p('kotatsu', 3.5, 3.5), p('cushion', 2, 3.5, { color: '#66816c' }), p('paperLantern', .5, .5), p('plantTall', .5, 3.5), radio('#a87b55'), p('basket', 5.5, 2),
        ...shoji(), wall('wallHanging', 0, 3, 'left', 1.6), top('teaSet', 3.5, 3.5, 'kotatsu'), p('rugRunner', 1.5, 4.5, { turn: 1, color: '#d8c9aa' }),
      ] },
      second: { title: '双铺客房', desc: '两张低铺床、行灯与旅人各自的行李位置。', pieces: [
        p('futon', 1.25, 1.5, { color: '#ded4bd' }), p('futon', 4.25, 1.5, { color: '#8d9a81' }), p('zenDesk', 3, 4), p('cushion', 3, 2.75, { turn: 2, color: '#66816c' }),
        p('paperLantern', 2.75, .5), p('basket', .5, 4.5), p('suitcase', 5.5, 3), radio('#e4d9bf'), ...shoji(), wall('wallHanging', 0, 3.5, 'left'), top('teaSet', 3, 4, 'zenDesk'),
      ] },
      living: { title: '旅店茶话间', desc: '围坐被炉喝茶，木凳与绿植围出接待休憩区。', pieces: [
        p('kotatsu', 2.75, 2.5), p('cushion', 1, 2.5, { color: '#66816c' }), p('cushion', 4.5, 2.5, { color: '#66816c' }), p('cushion', 2.75, 4, { color: '#b17859' }),
        p('cedarBench', 4.5, .5), p('paperLantern', .5, .5), p('tree', .5, 4.5, { color: '#a87b55' }), p('tansu', 5.5, 3.5, { turn: 3 }), radio('#a87b55', 2, .5),
        ...shoji(), wall('wallHanging', 0, 2.5, 'left'), top('teaSet', 2.5, 2.5, 'kotatsu'), top('books', 3.25, 2.5, 'kotatsu'),
      ] },
      kitchen: { title: '旅店会席餐厨', desc: '木作料理台、碗筷收纳与低桌会席。', floor: { finish: 'wood', color: '#a98a60' }, pieces: [
        p('ryokanKitchen', 1, .5), p('sink', 3, .5, { color: '#b79875' }), p('fridge', 5.5, .5, { color: '#e4dac6' }), p('kotatsu', 2.75, 3.25, { color: '#567365' }),
        p('cushion', 1, 3.25, { color: '#b17859' }), p('cushion', 4.5, 3.25, { color: '#b17859' }), p('paperLantern', .5, 4.5), radio('#a87b55'),
        wall('wallCabinet', 3, 0, 'back', 2), wall('shoji', 0, 2.5, 'left', 1.5), top('bowls', 2.25, 3.25, 'kotatsu'), top('placeSetting', 3.25, 3.25, 'kotatsu'), top('spiceJars', 1.5, .5, 'ryokanKitchen'),
      ] },
      bath: { title: '桧木温泉汤屋', desc: '桧木浴池、石钵洗手台、木凳和更衣篮。', floor: { finish: 'tile', color: '#9a9c83' }, pieces: [
        p('hinokiBath', 1.5, 1.5), p('stoneBasin', 4, .5), p('toilet', 5.5, .5, { color: '#ded4bd' }), p('cedarBench', 3.5, 3.5), p('paperLantern', .5, 3.5), p('basket', 5.5, 2.5),
        radio('#a87b55'), p('plantTall', 1, 4.5), p('rugRunner', 3.25, 2, { color: '#d7c9a7' }), wall('shoji', 1.5, 0, 'back', 1.65), wall('mirror', 4), wall('towel', 0, 3.5, 'left', 1.5),
        p('nightstand', 4.5, 4.5), top('towels', 4.5, 4.5, 'nightstand'),
      ] },
      study: { title: '静心文书房', desc: '低几读写、和纸灯与藏书，窗边留一席茶。', pieces: [
        p('zenDesk', 2.5, 1), p('cushion', 2.5, 2.25, { turn: 2, color: '#66816c' }), p('bookshelf', 5.5, 1.5, { turn: 3, color: '#a87b55' }), p('tansu', 1, 4.5),
        p('paperLantern', .5, .5), p('kotatsu', 4, 4), p('cushion', 4, 2.5, { color: '#b17859' }), radio('#a87b55', .5, 2.5), ...shoji(), wall('wallHanging', 0, 3.5, 'left'),
        top('openbook', 2.25, 1, 'zenDesk'), top('penholder', 3, 1, 'zenDesk'), top('teaSet', 4, 4, 'kotatsu'),
      ] },
    },
  },
  {
    id: 'academy', name: '学院研究所', desc: '大学教室、研究工位、实验室与食堂，串起完整校园日常', furniture: '连排课桌 · 隔板工位 · 实验台 · 食堂取餐台', accent: '#527c6c',
    wall: { finish: 'wainscot', color: '#b8c6b5' }, floor: { finish: 'check', color: '#b8afa0' },
    rooms: {
      master: { title: '研究员宿舍', desc: '铁架床、个人储物柜和独立学习工位。', floor: { finish: 'wood', color: '#aa936e' }, pieces: [
        p('dormBed', 1, 1.5), p('dormBed', 2.5, 1.5, { color: '#374c61' }), p('academicLocker', 4.5, .5), p('academicLocker', 5.5, .5),
        p('workstation', 4.75, 3), p('officeChair', 4.75, 4.25, { turn: 2, color: '#537b70' }), p('rugRunner', 1.75, 3.75, { turn: 1, color: '#a9b69b' }), p('basket', .5, 4.5), radio('#406b61', 3, 4.5),
        modernWindow(), wall('researchBoard', 4.5), wall('clock', 1.5, 0, 'back', 2), top('notepad', 4.1, 3.15, 'workstation'),
      ] },
      second: { title: '访学学者客房', desc: '单人宿舍床、图书柜与窗边写作桌。', pieces: [
        p('dormBed', 1, 1.5, { color: '#a37952' }), p('academicLocker', 2.5, .5, { color: '#ded9ca' }), p('desk', 4.5, 1, { color: '#a37952' }), p('chair', 4.5, 2.5, { turn: 2, color: '#537b70' }),
        p('bookshelf', .5, 3.5, { turn: 1, color: '#a37952' }), p('armchair', 3, 4, { color: '#537b70' }), p('floorLamp', 4.5, 4.5, { color: '#ded9ca' }), radio('#406b61'),
        modernWindow(), wall('researchBoard', 4.5), top('openbook', 4.25, 1, 'desk'), top('deskLamp', 5, 1, 'desk'), p('rugRect', 3, 3.75, { color: '#a9b69b' }),
      ] },
      living: { title: '大学教室', desc: '四组连排课桌、教师讲台和推拉黑板，课后也能围坐讨论。', pieces: [
        p('lectureDesk', 1.5, 2.1, { key: 'desk1' }), p('lectureDesk', 4.25, 2.1, { key: 'desk2' }), p('lectureDesk', 1.5, 4, { key: 'desk3' }), p('lectureDesk', 4.25, 4, { key: 'desk4' }),
        p('lectern', 3, .5), radio('#406b61', 5.5, .5), p('plantTall', .5, .5, { color: '#a37952' }), wall('chalkboard', 3, 0, 'back', 1.8), wall('clock', 5.2, 0, 'back', 2.2),
        wall('window', 0, 1.5, 'left', 1.65), wall('window', 0, 3.75, 'left', 1.65), top('openbook', 1, 1.75, 'desk1'), top('notepad', 4.75, 1.75, 'desk2'), top('books', 1, 3.65, 'desk3'), top('openbook', 4.75, 3.65, 'desk4'),
      ] },
      kitchen: { title: '学院食堂', desc: '保温取餐台、备餐灶柜与两组四人餐桌，餐盘也能单独摆放。', floor: tile, pieces: [
        p('servingCounter', 1.25, .5), p('islandKitchen', 3.5, .5, { color: '#537b70' }), p('fridge', 5.5, .5, { color: '#ded9ca' }),
        p('canteenTable', 1.5, 3.75, { key: 'canteen1' }), p('canteenTable', 4.25, 3.75, { key: 'canteen2' }), radio('#406b61', .5, 2), p('basket', 5.5, 2),
        wall('hood', 3.5, 0, 'back', 1.85), wall('researchBoard', 1.25, 0, 'back', 2), wall('window', 0, 3.5, 'left', 1.65), wall('clock', 5.2, 0, 'back', 2.1),
        top('mealTray', 1, 3.75, 'canteen1'), top('mealTray', 2, 3.75, 'canteen1'), top('mealTray', 3.75, 3.75, 'canteen2'), top('mealTray', 4.75, 3.75, 'canteen2'),
      ] },
      bath: { title: '宿舍盥洗室', desc: '双龙头盥洗台、洗衣机与个人更衣柜。', floor: tile, wall: { finish: 'check', color: '#c1d1c5' }, pieces: [
        p('communalBasin', 2.5, .5), p('toilet', 5.5, .5), p('washer', .5, .5, { color: '#ded9ca' }), p('academicLocker', 5.5, 2.5), p('bathtub', .75, 3, { color: '#ded9ca' }),
        p('cedarBench', 3.25, 3.5, { color: '#a37952' }), p('basket', 1.5, 4.5), radio('#406b61'), wall('mirror', 2), wall('mirror', 3), wall('towel', 0, 2.5, 'left', 1.5), top('towels', .5, .5, 'washer'), p('rugRunner', 3, 2.5, { color: '#819c87' }),
      ] },
      study: { title: '研究工位与实验室', desc: '两处隔板电脑工位，配实验台、显微镜和标本陈列柜。', pieces: [
        p('workstation', 1.25, .75, { key: 'work1' }), p('workstation', 4.25, .75, { key: 'work2' }), p('officeChair', 1.25, 2, { turn: 2, color: '#537b70' }), p('officeChair', 4.25, 2, { turn: 2, color: '#537b70' }),
        p('labBench', 2.25, 3.5), p('labStool', 2.25, 4.5), p('specimenCabinet', 5.5, 2.5), p('specimenCabinet', 5.5, 3.5), radio('#406b61'),
        wall('researchBoard', 2.75, 0, 'back', 1.9), wall('window', 0, 3.25, 'left', 1.6), top('microscope', 1.75, 3.5, 'labBench'), top('notepad', 2.75, 3.5, 'labBench'), top('books', .65, .9, 'work1'), top('penholder', 3.65, .9, 'work2'),
      ] },
    },
  },
  {
    id: 'railway', name: '观光列车包厢', desc: '卧铺、观景包厢与餐车，六间相连的旅行生活', furniture: '列车卧铺 · 绗缝卡座 · 观光窗 · 餐车灶柜', accent: '#456f63',
    wall: { finish: 'wainscot', color: '#d8c5a8' }, floor: { finish: 'carpet', color: '#778779' },
    rooms: {
      master: { title: '双人卧铺车厢', desc: '成对卧铺、行李架与窗边的睡前茶桌。', pieces: [
        p('sleeperBed', 1, 1.5), p('sleeperBed', 3, 1.5, { color: '#953f4b' }), p('cabinWardrobe', 5.5, .5), p('carriageTable', 3, 4), p('trainBench', 5.5, 2.5, { turn: 3 }),
        p('suitcase', .5, 4.5), radio('#a87b55'), p('rugRunner', 2, 3.5, { turn: 1, color: '#c6b290' }), ...railWindow(), wall('luggageRack', 4.75, 0, 'back', 2.18), top('teaSet', 3, 4, 'carriageTable'),
      ] },
      second: { title: '独旅卧铺包厢', desc: '单人卧铺、折叠写字桌与私人的观景座位。', pieces: [
        p('sleeperBed', 1, 1.5, { color: '#30475d' }), p('cabinWardrobe', 3, .5), p('foldingDesk', 5.25, 1), p('chair', 5.25, 2.25, { turn: 2, color: '#406b61' }),
        p('trainBench', 2.5, 4.5, { turn: 2 }), p('suitcase', .5, 4), radio('#a87b55'), ...railWindow(), wall('luggageRack', 4.75, 0, 'back', 2.2), top('openbook', 5.25, 1, 'foldingDesk'), p('rugRunner', 3, 2.5, { color: '#c6b290' }),
      ] },
      living: { title: '全景会客包厢', desc: '面对面卡座、山景窗与行李架，沿途喝茶闲谈。', pieces: [
        p('trainBench', .75, 2.25, { turn: 1 }), p('trainBench', 3.25, 2.25, { turn: 3 }), p('carriageTable', 2, 2.25), p('trainBench', 4.5, .75, { color: '#953f4b' }),
        p('suitcase', .75, 4), p('suitcase', 4.5, 4, { color: '#30475d' }), radio('#a87b55'), p('rugRunner', 4.5, 2.5, { color: '#c6b290' }), ...railWindow(), wall('luggageRack', 4.8, 0, 'back', 2.2), wall('clock', 0, 4.25, 'left', 1.9), top('teaSet', 2, 2.25, 'carriageTable'),
      ] },
      kitchen: { title: '观光餐车', desc: '带护栏的灶柜、备餐水槽和窗边卡座餐位。', floor: { finish: 'check', color: '#b9b7a5' }, pieces: [
        p('galleyKitchen', 1, .5), p('sink', 3, .5, { color: '#aab8b7' }), p('fridge', 5.5, .5, { color: '#ded9ca' }), p('trainBench', 1, 3.5, { turn: 1 }),
        p('carriageTable', 2.5, 3.5), p('trainBench', 4, 3.5, { turn: 3, color: '#953f4b' }), radio('#a87b55', 5.5, 4.5), wall('trainWindow', 0, 2.5, 'left', 1.65), wall('hood', 1, 0, 'back', 1.85), wall('wallCabinet', 3, 0, 'back', 2),
        top('placeSetting', 2.25, 3.5, 'carriageTable'), top('teaSet', 2.75, 3.5, 'carriageTable'), top('spiceJars', 1.5, .5, 'galleyKitchen'),
      ] },
      bath: { title: '列车洗漱包厢', desc: '折角洗漱柜、浴缸、更衣凳与黄铜毛巾架。', floor: tile, pieces: [
        p('carriageVanity', 2.5, .5), p('toilet', 4.5, .5), p('bathtub', .75, 1.5, { color: '#e2d5ba' }), p('cabinWardrobe', 5.5, 2), p('cedarBench', 3, 3.5, { color: '#a67d50' }),
        p('basket', 1, 4.5), radio('#a87b55'), p('rugRunner', 2.75, 2, { color: '#c6b290' }), wall('mirror', 2.5), wall('towel', 0, 3.5, 'left', 1.5), wall('luggageRack', 4.75, 0, 'back', 2.2), p('nightstand', 4.5, 4.5), top('towels', 4.5, 4.5, 'nightstand'),
      ] },
      study: { title: '旅行书房车厢', desc: '观景写作桌、藏书架与一组阅读卡座。', pieces: [
        p('foldingDesk', 1.5, 1), p('chair', 1.5, 2.25, { turn: 2, color: '#406b61' }), p('bookshelf', 5.5, 1.5, { turn: 3, color: '#a67d50' }), p('trainBench', 2.5, 4.5, { turn: 2, color: '#953f4b' }),
        p('carriageTable', 2.5, 3), p('suitcase', .5, 4.5), radio('#a87b55'), ...railWindow(), wall('luggageRack', 4.75, 0, 'back', 2.2), top('openbook', 1.5, 1, 'foldingDesk'), top('teaSet', 2.5, 3, 'carriageTable'), p('floorLamp', 4.5, 3.5, { color: '#c39867' }),
      ] },
    },
  },
  {
    id: 'cyber', name: '赛博电子机舱', desc: '从休眠舱到航行控制室，六个功能完整的未来舱室', furniture: '休眠舱床 · 营养料理站 · 净化舱 · 环幕控制台', accent: '#6bbec8',
    wall: { finish: 'bulkhead', color: '#39475b' }, floor: { finish: 'metal', color: '#526174' },
    rooms: {
      master: { title: '双人休眠舱', desc: '双人休眠平台、装备柜与独立生命监测面板。', pieces: [
        p('doublePod', 2, 1.5), p('storagePod', 4.5, .5), p('storagePod', 5.5, .5, { color: '#553f64' }), p('nightstand', .5, 1, { color: '#34445b' }), p('pilotSeat', 4.5, 3.5),
        p('rugRunner', 2, 3.5, { turn: 1, color: '#34466b' }), radio('#34445b'), ...neon(), wall('holoPanel', 2, 0, 'back', 1.8), wall('holoPanel', 0, 3.5, 'left', 1.5), top('tablet', .5, 1, 'nightstand'),
      ] },
      second: { title: '乘员休眠舱', desc: '两个独立胶囊床位，共用终端和装备收纳。', pieces: [
        p('capsuleBed', 1, 1.5), p('capsuleBed', 3, 1.5, { color: '#596477' }), p('storagePod', 5.5, .5), p('cyberConsole', 4.5, 3.5), p('pilotSeat', 4.5, 4.5, { turn: 2 }),
        radio('#34445b', .5, 4.5), p('rugRunner', 2, 3.5, { turn: 1, color: '#34466b' }), ...neon(), wall('holoPanel', 2.5, 0, 'back', 1.95), top('books', 3.8, 3.7, 'cyberConsole'),
      ] },
      living: { title: '航行会客舱', desc: '围绕全息沙盘交流，舷侧终端显示航行信息。', pieces: [
        p('modularSofa', 2, .75, { color: '#596477' }), p('holoTable', 2.5, 2.5), p('pilotSeat', .75, 2.5, { turn: 1 }), p('pilotSeat', 4.25, 2.5, { turn: 3 }), p('serverRack', 5.5, .5),
        p('storagePod', 5.5, 2), radio('#34445b'), p('rugRect', 2.5, 3, { color: '#34466b' }), ...neon(), wall('holoPanel', 2.5, 0, 'back', 1.8), wall('holoPanel', 0, 3.75, 'left', 1.6),
      ] },
      kitchen: { title: '营养补给舱', desc: '营养料理站、冷藏设备与四人补给餐桌。', pieces: [
        p('nutritionStation', 1.25, .5), p('sink', 3.5, .5, { color: '#596477' }), p('fridge', 5.5, .5, { color: '#34445b' }), p('canteenTable', 2.75, 3.5, { color: '#596477' }), p('storagePod', .5, 2.5),
        radio('#34445b'), ...neon(), wall('holoPanel', 3.5, 0, 'back', 1.8), wall('holoPanel', 0, 3.75, 'left', 1.7), top('mealTray', 2.25, 3.5, 'canteenTable'), top('mealTray', 3.25, 3.5, 'canteenTable'), p('basket', 5.5, 2.5, { color: '#34445b' }),
      ] },
      bath: { title: '净化洗漱舱', desc: '开放式淋浴净化舱、双盆洗漱台与装备更衣柜。', pieces: [
        p('hygienePod', .75, 1.5), p('communalBasin', 3, .5, { color: '#596477' }), p('toilet', 5.5, .5, { color: '#aab8b7' }), p('storagePod', 5.5, 2.5), p('washer', 3.5, 3.5, { color: '#596477' }),
        radio('#34445b'), p('rugRunner', 2, 3, { color: '#34466b' }), ...neon(), wall('mirror', 2.5), wall('mirror', 3.5), wall('holoPanel', 0, 3.5, 'left', 1.7), top('towels', 3.5, 3.5, 'washer'),
      ] },
      study: { title: '航行控制研究舱', desc: '环幕控制台、双设备机柜与全息任务沙盘。', pieces: [
        p('cyberConsole', 2.25, 1), p('pilotSeat', 2.25, 2.25, { turn: 2 }), p('serverRack', 4.5, .5), p('serverRack', 5.5, .5), p('holoTable', 3, 4), p('storagePod', .5, 3.5),
        radio('#34445b'), ...neon(), wall('holoPanel', 2.25, 0, 'back', 1.95), wall('holoPanel', 0, 2, 'left', 1.7), p('rugRunner', 4.5, 3, { color: '#34466b' }),
      ] },
    },
  },
];


const styleColors: Record<string, { wood: string; fabric: string; ceramic: string; metal: string; accent: string }> = {
  apartment: { wood: '#a38768', fabric: '#a7b19e', ceramic: '#e7e1d4', metal: '#787f80', accent: '#7c9385' },
  onsen: { wood: '#b28c63', fabric: '#c6bc97', ceramic: '#ded5ba', metal: '#71796b', accent: '#66816c' },
  academy: { wood: '#a37952', fabric: '#8fa58b', ceramic: '#ded9ca', metal: '#697e79', accent: '#537b70' },
  railway: { wood: '#a67d50', fabric: '#bca981', ceramic: '#eee3cd', metal: '#8f998f', accent: '#406b61' },
  cyber: { wood: '#526174', fabric: '#536783', ceramic: '#acbdc4', metal: '#34445b', accent: '#79bec8' },
};
const timberKinds = new Set(['chair', 'stool', 'wardrobe', 'bookshelf', 'dresser', 'basket', 'window', 'painting', 'shelf', 'wallCabinet']);
function presetColor(style: RoomStyle, piece: Piece): string | undefined {
  if (piece.color) return piece.color;
  const item = catalogItem(piece.kind);
  if (!item || item.style) return undefined;
  const colors = styleColors[style.id]!;
  if (timberKinds.has(piece.kind) || item.cat === 'table') return colors.wood;
  if (['seat', 'bed', 'rug'].includes(item.cat) || ['towel', 'towels', 'wallHanging'].includes(piece.kind)) return colors.fabric;
  if (item.cat === 'tech') return colors.metal;
  if (item.cat === 'study') return colors.accent;
  return colors.ceramic;
}

export function applyRoomStyle(room: DecorRoom, style: RoomStyle): { room: DecorRoom; omitted: string[] } {
  const scheme = style.rooms[room.type as HomeRoomType] ?? style.rooms.living;
  let next: DecorRoom = { ...room, style: style.id, wall: { ...(scheme.wall ?? style.wall) }, floor: { ...(scheme.floor ?? style.floor) }, items: [] };
  const omitted: string[] = [];
  const placed = new Map<string, { item: DecorRoom['items'][number]; recipe: Piece }>();
  for (const piece of scheme.pieces) {
    const support = piece.on ? placed.get(piece.on) : undefined;
    const near = support
      ? { x: support.item.x + piece.x - support.recipe.x, z: support.item.z + piece.z - support.recipe.z }
      : { x: piece.x * room.w / 6, z: piece.z * room.d / 5 };
    const result = piece.on && !support ? null : addItem(next, piece.kind, { near, turn: piece.turn, color: presetColor(style, piece), wall: piece.wall, y: piece.y, on: support?.item.id, by: 'you' });
    if (result && (!piece.on || result.item.on === support?.item.id)) {
      next = result.room;
      if (!placed.has(piece.kind)) placed.set(piece.kind, { item: result.item, recipe: piece });
      if (piece.key) placed.set(piece.key, { item: result.item, recipe: piece });
    } else omitted.push(piece.kind);
  }
  return { room: next, omitted };
}

/** Applying a preset replaces the complete home atomically; its six rooms keep matching room IDs. */
export function applyHomeStyle(existing: readonly DecorRoom[], style: RoomStyle): DecorRoom[] {
  return HOME_ROOM_TYPES.map((type) => {
    const previous = existing.find((r) => r.type === type);
    const room: DecorRoom = { id: previous?.id ?? crypto.randomUUID(), type, name: roomType(type).name, w: 6, d: 5, wall: style.wall, floor: style.floor, items: [] };
    return applyRoomStyle(room, style).room;
  });
}

export function stylePreview(id: string, room: HomeRoomType = 'living'): string {
  return new URL(`../../../../assets/decor-styles/${id}-${room}.jpg`, import.meta.url).href;
}
