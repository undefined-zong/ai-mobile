import type { CatalogItem } from './model';
import { HOME_CATALOG } from './homeCatalog';

const linen = ['#d9d6cb', '#7c9385', '#b58163', '#34466b', '#ead5c6'];
const timber = ['#c8a47b', '#785440', '#e4dac6', '#494f52'];
const laboratory = ['#537b70', '#ded9ca', '#374c61', '#a37952'];
const carriage = ['#406b61', '#953f4b', '#30475d', '#c39867'];
const alloy = ['#313b52', '#596477', '#e1e4e6', '#553f64'];

/** Each style's furniture is also available individually in the furniture drawer. */
export const STYLE_CATALOG: CatalogItem[] = [
  ...HOME_CATALOG,
  { id: 'modularSofa', style: 'apartment', name: '模块沙发', cat: 'seat', w: 3, d: 1, h: .85, place: 'floor', seats: [[-.9, .08], [0, .08], [.9, .08]], seatH: .34, colors: linen },
  { id: 'stoneTable', style: 'apartment', name: '洞石茶几', cat: 'table', w: 2, d: 1, h: .36, top: .36, place: 'floor', colors: linen },
  { id: 'arcLamp', style: 'apartment', name: '弧形落地灯', cat: 'light', w: 1, d: 1, h: 1.95, light: true, place: 'floor', colors: timber },
  { id: 'slatPanel', style: 'apartment', name: '木格栅墙饰', cat: 'wall', w: 2, d: .12, h: 1.8, wallY: 1.25, place: 'wall', colors: timber },
  { id: 'kotatsu', style: 'onsen', name: '被炉暖桌', cat: 'table', w: 2, d: 1.5, h: .42, top: .42, place: 'floor', colors: ['#b17859', '#567365', '#566c8a', '#ddc9aa'] },
  { id: 'futon', style: 'onsen', name: '和式铺床', cat: 'bed', w: 2, d: 2, h: .28, beds: [[-.45, .1], [.45, .1]], bedH: .2, place: 'floor', colors: linen },
  { id: 'hinokiBath', style: 'onsen', name: '桧木温泉浴池', cat: 'bath', w: 2, d: 2, h: .65, beds: [[0, .1]], bedH: .3, place: 'floor', colors: timber },
  { id: 'shoji', style: 'onsen', name: '障子格窗', cat: 'wall', w: 2, d: .16, h: 1.8, wallY: 1.3, place: 'wall', colors: timber },
  { id: 'paperLantern', style: 'onsen', name: '和纸行灯', cat: 'light', w: 1, d: 1, h: 1.25, light: true, place: 'floor', colors: ['#eddfbe', '#e3c5ad', '#dce0c6'] },
  { id: 'labBench', style: 'academy', name: '学院实验台', cat: 'table', w: 2, d: 1, h: .8, top: .8, place: 'floor', colors: laboratory },
  { id: 'specimenCabinet', style: 'academy', name: '标本陈列柜', cat: 'study', w: 1, d: 1, h: 1.85, place: 'floor', colors: laboratory },
  { id: 'microscope', style: 'academy', name: '光学显微镜', cat: 'study', w: .5, d: .5, h: .44, place: 'top', prefer: ['labBench', 'desk'], colors: ['#e4e1d7', '#34466b', '#537b70'] },
  { id: 'researchBoard', style: 'academy', name: '研究手稿黑板', cat: 'wall', w: 2, d: .12, h: 1.15, wallY: 1.65, place: 'wall', colors: timber },
  { id: 'labStool', style: 'academy', name: '旋转实验凳', cat: 'seat', w: 1, d: 1, h: .5, seats: [[0, 0]], seatH: .5, place: 'floor', colors: laboratory },
  { id: 'trainBench', style: 'railway', name: '列车绗缝卡座', cat: 'seat', w: 2, d: 1, h: 1.05, seats: [[-.45, .12], [.45, .12]], seatH: .37, place: 'floor', colors: carriage },
  { id: 'carriageTable', style: 'railway', name: '包厢小餐桌', cat: 'table', w: 1, d: 1, h: .65, top: .65, place: 'floor', colors: timber },
  { id: 'trainWindow', style: 'railway', name: '山景观光窗', cat: 'wall', w: 2.5, d: .2, h: 1.2, wallY: 1.6, place: 'wall', colors: timber },
  { id: 'luggageRack', style: 'railway', name: '黄铜行李架', cat: 'wall', w: 1.5, d: .45, h: .5, wallY: 2.18, place: 'wall', colors: timber },
  { id: 'suitcase', style: 'railway', name: '皮革旅行箱', cat: 'small', w: 1, d: 1, h: .6, place: 'floor', colors: carriage },
  { id: 'cyberConsole', style: 'cyber', name: '环幕控制台', cat: 'tech', w: 2, d: 1, h: 1.25, top: .65, place: 'floor', colors: alloy },
  { id: 'serverRack', style: 'cyber', name: '电子设备机柜', cat: 'tech', w: 1, d: 1, h: 1.95, light: true, place: 'floor', colors: alloy },
  { id: 'capsuleBed', style: 'cyber', name: '休眠舱床', cat: 'bed', w: 1, d: 2, h: 1.35, beds: [[0, .12]], bedH: .36, place: 'floor', colors: alloy },
  { id: 'pilotSeat', style: 'cyber', name: '机舱驾驶座', cat: 'seat', w: 1, d: 1, h: 1.2, seats: [[0, .1]], seatH: .42, place: 'floor', colors: alloy },
  { id: 'holoPanel', style: 'cyber', name: '全息航行面板', cat: 'wall', w: 1.5, d: .18, h: 1, wallY: 1.65, place: 'wall', light: true, colors: ['#6ed8dc', '#ae9cfa', '#e4a7d1'] },
  { id: 'neonStrip', style: 'cyber', name: '机舱导光灯', cat: 'light', w: 2, d: .1, h: .12, wallY: 2.3, place: 'wall', light: true, colors: ['#6ed8dc', '#ae9cfa', '#e4a7d1'] },
  { id: 'radio', name: '立式收音机', cat: 'tech', w: 1, d: 1, h: 1.03, place: 'floor', colors: ['#a87b55', '#e4d9bf', '#406b61', '#34445b', '#9c3d4f'] },
];
