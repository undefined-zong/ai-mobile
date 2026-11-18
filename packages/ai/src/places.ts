import { distanceKm, type FoodPlace, type GeoPoint, type GroceryStore } from '@app/shared';

/**
 * Google 地图的附近搜索（Places API (New)）：手机用自己的 Key 从浏览器查；云端用你单独给它的 Key，
 * 每天到点排健康计划时自己查家附近能吃饭的地方和超市。这里只发请求、读结果，缓存在各自那边做。
 */

export class PlacesError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(message);
    this.name = 'PlacesError';
    this.detail = detail;
  }
}

export interface PlaceJson {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  shortFormattedAddress?: string;
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  primaryTypeDisplayName?: { text?: string };
  googleMapsUri?: string;
  businessStatus?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  regularOpeningHours?: { weekdayDescriptions?: string[] };
  takeout?: boolean;
  delivery?: boolean;
  dineIn?: boolean;
  servesVegetarianFood?: boolean;
  servesBreakfast?: boolean;
  servesLunch?: boolean;
  servesDinner?: boolean;
  editorialSummary?: { text?: string };
}

interface PlacesJson {
  places?: PlaceJson[];
  error?: { code?: number; message?: string; status?: string };
}

/**
 * 一次 Places API (New) 附近搜索。fields 决定计费档（名字、地址、坐标、种类是 Pro；价位、评分、营业时间是 Enterprise；
 * 只要用得到的字段）。某个种类 Google 不认（400）时只用第一个种类再搜一次
 */
export async function placesNearby(opts: {
  types: string[];
  center: GeoPoint;
  radius: number;
  max: number;
  rank: 'DISTANCE' | 'POPULARITY';
  fields: string[];
  key: string;
  signal?: AbortSignal;
}): Promise<PlaceJson[]> {
  const send = async (types: string[]) => {
    let res: Response;
    try {
      res = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': opts.key, 'X-Goog-FieldMask': opts.fields.map((f) => `places.${f}`).join(',') },
        body: JSON.stringify({
          includedTypes: types,
          maxResultCount: opts.max,
          rankPreference: opts.rank,
          languageCode: 'zh-CN',
          locationRestriction: { circle: { center: { latitude: opts.center.lat, longitude: opts.center.lng }, radius: opts.radius } },
        }),
        signal: opts.signal,
      });
    } catch (e) {
      throw new PlacesError(`连不上 Google 地点搜索：${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await res.json().catch(() => ({}))) as PlacesJson;
    return { res, json };
  };
  let { res, json } = await send(opts.types);
  if (res.status === 400 && /type/i.test(json.error?.message ?? '') && opts.types.length > 1) ({ res, json } = await send(opts.types.slice(0, 1)));
  if (!res.ok) {
    const msg = json.error?.message ?? '';
    const hint = res.status === 403 || /not been used|disabled|PERMISSION_DENIED/i.test(msg)
      ? '（这个 Key 没开通 Places API (New)，或者 Key 的限制不允许）'
      : res.status === 400 && /API key/i.test(msg)
        ? '（Key 不对）'
        : '';
    throw new PlacesError(`Google 附近搜索失败：HTTP ${res.status}${hint}`, msg);
  }
  return (json.places ?? []).filter((p) => p.id && p.displayName?.text && typeof p.location?.latitude === 'number' && typeof p.location.longitude === 'number');
}

export function placeAt(p: PlaceJson): GeoPoint {
  return { lat: p.location!.latitude!, lng: p.location!.longitude! };
}

// —— 附近能吃饭的地方、超市（排健康计划用） ——

/** 能吃饭的地方：餐厅、快餐、外卖店、三明治店、食堂；按受欢迎程度取 20 家（附近真有人去的店），太少就搜远一点 */
const FOOD_TYPES = ['restaurant', 'fast_food_restaurant', 'meal_takeaway', 'sandwich_shop', 'cafeteria'];
const FOOD_FIELDS = [
  'id', 'displayName', 'location', 'primaryTypeDisplayName', 'googleMapsUri', 'businessStatus', 'priceLevel', 'rating', 'userRatingCount',
  'regularOpeningHours', 'takeout', 'delivery', 'dineIn', 'servesVegetarianFood', 'servesBreakfast', 'servesLunch', 'servesDinner', 'editorialSummary',
];
const PRICE: Record<string, number> = { PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
/** 超市：不要加油站里的、便利店、卖酒的 */
const GROCERY_TYPES = ['supermarket', 'grocery_store'];
const NOT_GROCERY = new Set(['gas_station', 'convenience_store', 'liquor_store', 'pharmacy', 'drugstore']);
const open = (p: PlaceJson) => !p.businessStatus || p.businessStatus === 'OPERATIONAL';

/** 附近能吃饭的地方：按距离排 */
export async function searchFoodPlaces(center: GeoPoint, key: string, signal?: AbortSignal): Promise<FoodPlace[]> {
  const ask = (radius: number) => placesNearby({ types: FOOD_TYPES, center, radius, max: 20, rank: 'POPULARITY', fields: FOOD_FIELDS, key, signal });
  let places = (await ask(1600)).filter(open);
  // 郊区 1.6 公里里没几家：放到 5 公里
  if (places.length < 6) places = (await ask(5000)).filter(open);
  return places
    .map((p): FoodPlace => {
      const price = PRICE[p.priceLevel ?? ''];
      const hours = p.regularOpeningHours?.weekdayDescriptions?.filter((x) => typeof x === 'string');
      return {
        id: p.id!,
        name: p.displayName!.text!,
        type: p.primaryTypeDisplayName?.text || '餐厅',
        distanceKm: Math.round(distanceKm(center, placeAt(p)) * 100) / 100,
        ...(price ? { price } : {}),
        ...(typeof p.rating === 'number' ? { rating: p.rating } : {}),
        ...(typeof p.userRatingCount === 'number' ? { ratings: p.userRatingCount } : {}),
        ...(hours?.length === 7 ? { hours } : {}),
        ...(typeof p.takeout === 'boolean' ? { takeout: p.takeout } : {}),
        ...(typeof p.delivery === 'boolean' ? { delivery: p.delivery } : {}),
        ...(typeof p.dineIn === 'boolean' ? { dineIn: p.dineIn } : {}),
        ...(typeof p.servesVegetarianFood === 'boolean' ? { vegetarian: p.servesVegetarianFood } : {}),
        ...(typeof p.servesBreakfast === 'boolean' ? { breakfast: p.servesBreakfast } : {}),
        ...(typeof p.servesLunch === 'boolean' ? { lunch: p.servesLunch } : {}),
        ...(typeof p.servesDinner === 'boolean' ? { dinner: p.servesDinner } : {}),
        ...(p.editorialSummary?.text ? { summary: p.editorialSummary.text.slice(0, 80) } : {}),
        ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
      };
    })
    .sort((a, b) => a.distanceKm - b.distanceKm);
}

/** 附近的超市：5 公里里受欢迎的，同一家连锁只留最近的一间，按距离排 */
export async function searchGroceryStores(center: GeoPoint, key: string, signal?: AbortSignal): Promise<GroceryStore[]> {
  const places = await placesNearby({
    types: GROCERY_TYPES,
    center,
    radius: 5000,
    max: 15,
    rank: 'POPULARITY',
    fields: ['id', 'displayName', 'location', 'primaryType', 'primaryTypeDisplayName', 'googleMapsUri', 'businessStatus'],
    key,
    signal,
  });
  const seen = new Set<string>();
  return places
    .filter((p) => open(p) && !NOT_GROCERY.has(p.primaryType ?? ''))
    .map((p): GroceryStore => ({
      id: p.id!,
      name: p.displayName!.text!,
      type: p.primaryTypeDisplayName?.text || '超市',
      distanceKm: Math.round(distanceKm(center, placeAt(p)) * 100) / 100,
      ...(p.googleMapsUri ? { mapsUri: p.googleMapsUri } : {}),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .filter((s) => {
      const k = s.name.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 8);
}

