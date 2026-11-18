import { onlineShops, samePlaceName, type MealSpot, type ShoppingItem } from '@app/shared';
import { splitEnglish } from './text';

/**
 * 健康计划里"要买的东西"在哪买（设计文档 §9.13）：
 * - 排计划时告诉「健康」附近有哪些超市（Google 地图搜的）、你那里能用哪些网店（@app/shared 的 onlineShopsText），
 *   它写的"在哪买"只用这些名字；
 * - 显示时：认得出的网店、连锁超市在它自己的网站上搜（美国：Amazon、Kroger 家的店、Walmart、Target、Costco；
 *   国内：京东、淘宝；别的国家用当地的 Amazon），附近的超市能点开 Google 地图，认不出的用 Google 搜"店名 + 商品"。
 * 认店名、网店这几样在 @app/shared（云端排健康计划时也要用）。
 */
export { countryAt, onlineShopsText, placeMentioned, samePlaceName } from '@app/shared';

/** "在哪买"写的是附近搜到的哪家超市（点开地图、看多远） */
export function nearbyStoreFor(where: string, stores: MealSpot[] | undefined): MealSpot | undefined {
  const w = where.trim();
  if (!w || !stores?.length) return undefined;
  return stores.find((s) => samePlaceName(s.name, w));
}

/**
 * 去哪搜这一样：认得出的网店、连锁超市在它网站上搜；认不出、但写了店名的用 Google 搜；
 * 没写在哪买、写了搜什么（或者名字里带英文原名）的在当地 Amazon 搜；都没写的（以前存的一行文字）不给链接
 */
export function searchLinkFor(item: ShoppingItem, country: string | undefined): { label: string; url: string } | null {
  const where = item.where.trim();
  // 没写搜什么时用名字里括号写的英文原名
  const en = splitEnglish(item.name).en;
  const q = (item.search || en || item.name).trim();
  if (!q || (!where && !item.search.trim() && !en)) return null;
  const shops = onlineShops(country);
  const shop = where ? shops.find((s) => s.match.test(where)) : shops.find((s) => s.id === 'amazon');
  if (shop) return { label: `在 ${shop.name} 搜`, url: shop.search(q) };
  if (where) return { label: '搜一下', url: `https://www.google.com/search?q=${encodeURIComponent(`${where} ${q}`)}` };
  return null;
}

