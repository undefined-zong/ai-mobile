import type { TextFn } from './programText.ts';
import { roughlyInChina, roughlyInUS } from './weather.ts';

/**
 * 附近的店（Google 地图搜到的）和"在哪买"的几样规则，手机和云端共用；发请求的那部分在 @app/ai 的 places.ts。
 * 手机用自己的 Key 从浏览器查（结果缓存一天）；云端用你单独给它的 Key，每天到点排健康计划时自己查家附近。
 */

export interface GeoPoint {
  lat: number;
  lng: number;
}

/** 附近一家能吃饭的地方（排健康计划时，外食只从这些店里挑） */
export interface FoodPlace {
  id: string;
  name: string;
  /** 什么店：Google 地图上的种类（"沙拉店""快餐店""日本料理店"） */
  type: string;
  distanceKm: number;
  /** 价位 1–4（$ 到 $$$$），不知道是 undefined */
  price?: number;
  rating?: number;
  ratings?: number;
  /** 营业时间：周一到周日七行（Google 给的原文，"星期一: 10:30–21:00"） */
  hours?: string[];
  takeout?: boolean;
  delivery?: boolean;
  dineIn?: boolean;
  vegetarian?: boolean;
  breakfast?: boolean;
  lunch?: boolean;
  dinner?: boolean;
  /** Google 写的一句介绍 */
  summary?: string;
  mapsUri?: string;
}

/** 附近的一家超市 */
export interface GroceryStore {
  id: string;
  name: string;
  type: string;
  distanceKm: number;
  mapsUri?: string;
}

/** 两点之间的距离（公里） */
export function distanceKm(a: GeoPoint, b: GeoPoint): number {
  const R = 6371;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 显示用的距离：不到 1 公里写米 */
export function distanceText(km: number): string {
  if (km < 1) return `${Math.max(10, Math.round((km * 1000) / 10) * 10)} m`;
  return `${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

// —— 在哪买：网店、连锁超市 ——

export interface OnlineShop {
  id: string;
  name: string;
  /** 认这个名字（连同它家的其他招牌） */
  match: RegExp;
  /** 在它的网站上搜 */
  search: (q: string) => string;
}

/** 各国的 Amazon */
const AMAZON_DOMAIN: Record<string, string> = {
  US: 'amazon.com', CA: 'amazon.ca', MX: 'amazon.com.mx', BR: 'amazon.com.br', GB: 'amazon.co.uk', DE: 'amazon.de', FR: 'amazon.fr', IT: 'amazon.it',
  ES: 'amazon.es', NL: 'amazon.nl', BE: 'amazon.com.be', SE: 'amazon.se', PL: 'amazon.pl', TR: 'amazon.com.tr', JP: 'amazon.co.jp', IN: 'amazon.in',
  SG: 'amazon.sg', AU: 'amazon.com.au', AE: 'amazon.ae', SA: 'amazon.sa', EG: 'amazon.eg',
};

/** Kroger 和它家的招牌（kroger.com 能配送、到店自提的那些） */
const KROGER =
  /kroger|ralphs|fred\s*meyer|king\s*soopers|harris\s*teeter|smith'?s\s+food|fry'?s\s+(?:food|marketplace)|\bqfc\b|mariano'?s|dillons|food\s*4\s*less|foods\s*co\b|pick\s*'?n\s*save|metro\s*market|city\s*market/i;
const TARGET = /\btarget\b/i;
const COSTCO = /costco|好市多|开市客/i;

/** 你那里能在网站上搜的网店、连锁超市 */
export function onlineShops(country: string | undefined): OnlineShop[] {
  const q = encodeURIComponent;
  const out: OnlineShop[] = [];
  const amazon = country ? AMAZON_DOMAIN[country] : undefined;
  if (amazon) out.push({ id: 'amazon', name: 'Amazon', match: /amazon|亚马逊/i, search: (s) => `https://www.${amazon}/s?k=${q(s)}` });
  if (country === 'US') {
    out.push(
      { id: 'kroger', name: 'Kroger', match: KROGER, search: (s) => `https://www.kroger.com/search?query=${q(s)}` },
      { id: 'walmart', name: 'Walmart', match: /walmart|沃尔玛/i, search: (s) => `https://www.walmart.com/search?q=${q(s)}` },
      { id: 'target', name: 'Target', match: TARGET, search: (s) => `https://www.target.com/s?searchTerm=${q(s)}` },
      { id: 'costco', name: 'Costco', match: COSTCO, search: (s) => `https://www.costco.com/CatalogSearch?keyword=${q(s)}` },
    );
  }
  if (country === 'CN') {
    out.push(
      { id: 'jd', name: '京东', match: /京东|jd\.com/i, search: (s) => `https://search.jd.com/Search?keyword=${q(s)}` },
      { id: 'taobao', name: '淘宝', match: /淘宝|天猫|taobao|tmall/i, search: (s) => `https://s.taobao.com/search?q=${q(s)}` },
    );
  }
  return out;
}

/** 你在哪个国家（ISO 代码）：地理编码给的优先，没有就按经纬度粗算美国、中国 */
export function countryAt(code: string | undefined | null, at: GeoPoint | null | undefined): string | undefined {
  if (code) return code.toUpperCase();
  if (!at) return undefined;
  if (roughlyInUS(at.lat, at.lng)) return 'US';
  if (roughlyInChina(at.lat, at.lng)) return 'CN';
  return undefined;
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** 两个店名说的是不是同一家（"Sweetgreen" 和 "sweetgreen Midtown"、"Trader Joe's" 和 "Trader Joes"） */
export function samePlaceName(a: string, b: string): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 3 && long.includes(short);
}

/** 排计划时给「健康」的一行：你那里能用哪些网店（美国按附近有没有 Kroger、Target、Costco 的店来写） */
export function onlineShopsText(country: string | undefined, nearbyStores: { name: string }[], t: TextFn): string {
  if (country === 'US') {
    const near = (re: RegExp) => nearbyStores.find((s) => re.test(s.name));
    const kroger = near(KROGER);
    return t('health.shops', {
      items: [
        t('health.shop.amazonUS'),
        t('health.shop.walmart'),
        kroger ? t('health.shop.krogerNear', { store: kroger.name }) : t('health.shop.krogerFar'),
        near(TARGET) ? t('health.shop.target') : '',
        near(COSTCO) ? t('health.shop.costco') : '',
        t('health.shop.instacart'),
      ].filter(Boolean),
    });
  }
  if (country === 'CN') return t('health.shops.CN');
  const amazon = country ? AMAZON_DOMAIN[country] : undefined;
  return amazon ? t('health.shop.amazon', { domain: amazon }) : '';
}

/** 一段话里提到了附近的哪家店（备案里"去 CAVA 点……"）：名字最长的那家优先 */
export function placeMentioned<T extends { name: string }>(text: string | undefined, places: T[]): T | undefined {
  const t = norm(text ?? '');
  if (!t) return undefined;
  return [...places].sort((a, b) => b.name.length - a.name.length).find((p) => {
    const n = norm(p.name);
    return n.length >= 3 && t.includes(n);
  });
}
