import type { Turn, WallSide } from './model';

interface Furnishing {
  kind: string;
  color: string;
  /** 以房间宽、深的比例定位，已有家具交给原来的摆放规则避让。 */
  near?: [number, number];
  turn?: Turn;
  wall?: WallSide;
  y?: number;
  /** 台面小物只放在这些家具上。 */
  supports?: string[];
  count?: number;
}

interface FurnishingSet {
  name: string;
  desc: string;
  items: Furnishing[];
}

/** 新建普通房间的基础软装搭配。数量是目标总数，重复使用不会越添越多。 */
export const ROOM_FURNISHINGS: Record<string, FurnishingSet> = {
  master: {
    name: '晚安玫瑰',
    desc: '床边相框、织物挂毯与一盏阅读灯',
    items: [
      { kind: 'armchair', near: [0.78, 0.66], turn: 3, color: '#c69c9f' },
      { kind: 'floorLamp', near: [0.93, 0.55], color: '#f3eae0' },
      { kind: 'basket', near: [0.75, 0.9], color: '#b99a7d' },
      { kind: 'plantTall', near: [0.08, 0.08], color: '#e4d5c6' },
      { kind: 'frame', supports: ['nightstand', 'dresser'], color: '#a98366' },
      { kind: 'books', supports: ['nightstand', 'dresser'], color: '#c69c9f' },
      { kind: 'candle', supports: ['dresser', 'nightstand'], color: '#f3eae0' },
      { kind: 'wallHanging', wall: 'left', near: [0, 0.82], y: 1.65, color: '#d9b8ae' },
    ],
  },
  second: {
    name: '森林来信',
    desc: '柔软的阅读角、串灯和书桌绿植',
    items: [
      { kind: 'rugRound', near: [0.67, 0.68], color: '#d1d4b9' },
      { kind: 'beanbag', near: [0.75, 0.72], turn: 3, color: '#91a08a' },
      { kind: 'floorLamp', near: [0.91, 0.5], color: '#eee5d6' },
      { kind: 'basket', near: [0.91, 0.9], color: '#baa185' },
      { kind: 'cactus', supports: ['desk', 'nightstand'], color: '#e5d7c4' },
      { kind: 'books', supports: ['desk', 'nightstand'], color: '#91a08a' },
      { kind: 'bear', supports: ['nightstand', 'desk'], color: '#ccb597' },
      { kind: 'fairy', wall: 'back', near: [0.23, 0], y: 2.18, color: '#edcf97' },
    ],
  },
  living: {
    name: '午后小憩',
    desc: '编织收纳、茶盘与沙发边的阅读灯',
    items: [
      { kind: 'basket', near: [0.91, 0.9], color: '#b99670' },
      { kind: 'teaSet', supports: ['lowtable', 'coffee'], color: '#e9e1d1' },
      { kind: 'floorLamp', near: [0.91, 0.1], color: '#e9e1d1' },
    ],
  },
  kitchen: {
    name: '香草厨房',
    desc: '条纹长毯、香料罐与早餐茶具',
    items: [
      { kind: 'rugRunner', near: [0.52, 0.35], turn: 1, color: '#a2ac8d' },
      { kind: 'basket', near: [0.91, 0.28], color: '#c0a180' },
      { kind: 'spiceJars', supports: ['counter'], color: '#b99a76' },
      { kind: 'pot', supports: ['counter'], color: '#ece2ce' },
      { kind: 'teaSet', supports: ['dining', 'diningLong'], color: '#e9ddc6' },
      { kind: 'placeSetting', supports: ['dining', 'diningLong'], count: 2, color: '#a2ac8d' },
    ],
  },
  bath: {
    name: '海盐沐浴',
    desc: '叠放浴巾、洗护托盘与藤编收纳',
    items: [
      { kind: 'nightstand', near: [0.9, 0.62], color: '#b2a18b' },
      { kind: 'basket', near: [0.7, 0.87], color: '#c3b296' },
      { kind: 'plantTall', near: [0.1, 0.87], color: '#edf0e7' },
      { kind: 'towels', supports: ['washer', 'nightstand'], color: '#9eb9bd' },
      { kind: 'bathTray', supports: ['nightstand', 'washer'], color: '#9eb9bd' },
      { kind: 'candle', supports: ['nightstand', 'washer'], color: '#edf0e7' },
      { kind: 'painting', wall: 'back', near: [0.2, 0], y: 1.75, color: '#b2a18b' },
    ],
  },
  study: {
    name: '慢读时光',
    desc: '茶几、书本和落地灯围成阅读角',
    items: [
      { kind: 'lowtable', near: [0.5, 0.7], color: '#ae9479' },
      { kind: 'floorLamp', near: [0.91, 0.58], color: '#ede4d5' },
      { kind: 'basket', near: [0.91, 0.9], color: '#b49c7e' },
      { kind: 'openbook', supports: ['lowtable', 'coffee'], color: '#8c9b89' },
      { kind: 'teaSet', supports: ['lowtable'], color: '#ede4d5' },
      { kind: 'pot', supports: ['desk', 'dresser'], color: '#b5bca8' },
      { kind: 'frame', supports: ['dresser', 'desk'], color: '#ae9479' },
      { kind: 'shelf', wall: 'back', near: [0.25, 0], y: 1.9, color: '#ae9479' },
    ],
  },
  dining: {
    name: '两人晚餐',
    desc: '亚麻餐垫、花器和边柜上的茶具',
    items: [
      { kind: 'tvstand', near: [0.5, 0.1], color: '#b38f73' },
      { kind: 'plantTall', near: [0.09, 0.1], color: '#eee3d4' },
      { kind: 'floorLamp', near: [0.91, 0.16], color: '#eee3d4' },
      { kind: 'placeSetting', supports: ['diningLong', 'dining'], count: 4, color: '#bc9989' },
      { kind: 'teaSet', supports: ['tvstand'], color: '#eee3d4' },
      { kind: 'frame', supports: ['tvstand'], color: '#b38f73' },
      { kind: 'candle', supports: ['diningLong', 'dining'], color: '#eee3d4' },
      { kind: 'wallHanging', wall: 'left', near: [0, 0.83], y: 1.65, color: '#bc9989' },
    ],
  },
};
