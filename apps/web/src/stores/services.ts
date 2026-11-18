import { defineStore } from 'pinia';
import { computed, reactive } from 'vue';
import { autoSave, getEntries, getOne } from '@/db/idb';

/**
 * 真实世界的服务（"我的 → 地图、天气、音乐"）：网易云音乐、Google 地图、和风天气；还有"我的 → 观影设置"的 B 站 Cookie。
 * 地址这类设置存在 settings 表（services 一项）；Key 和 Cookie 单独存在 secrets 表（svc: 开头），不进同步数据，
 * 请求从浏览器直接发给服务商（或者你自己部署的 Worker）。给云端的 Google 地图 Key 另外加密传到你的 Worker（stores/hub.ts）。
 * Open-Meteo（你那边的天气）、美国气象局的预警、网页定位不用 Key。
 */

/** 网易云音质（和 Netease_url Worker 的 level 一致；无损以上要黑胶 Cookie） */
export const NETEASE_QUALITIES = [
  { value: 'standard', label: '标准 128k' },
  { value: 'exhigh', label: '极高 320k' },
  { value: 'lossless', label: '无损 FLAC' },
  { value: 'hires', label: 'Hi-Res' },
  { value: 'jyeffect', label: '高清环绕声' },
  { value: 'sky', label: '沉浸环绕声' },
  { value: 'jymaster', label: '超清母带' },
] as const;
export type NeteaseQuality = (typeof NETEASE_QUALITIES)[number]['value'];

export interface NeteaseSettings {
  /** 你部署的 Netease_url Worker（和 SleepTogether 用的是同一个，填同一个地址就行） */
  workerUrl: string;
  quality: NeteaseQuality;
  /** 0–1 */
  volume: number;
}

export interface WeatherServiceSettings {
  /** 和风天气的 API Host（控制台 → 设置），例如 abcxyz.re.qweatherapi.com */
  qweatherHost: string;
}

/**
 * 一起看书接微信读书（"我的 → 看书设置"）：经过云端 Hub 内置的微信读书 MCP，或者你自己部署的微信读书 MCP。
 * Cookie、CookieCloud 密码、自己的 MCP 的请求头存在 secrets 表（svc: 开头），只在这台设备
 */
export type WereadSource = 'hub' | 'url';
export interface WereadSettings {
  source: WereadSource;
  /** 自己部署的 MCP 地址（Streamable HTTP） */
  url: string;
  /** 自己的 MCP 要登录时用的请求头名字（值在 secrets） */
  headerName: string;
  /** CookieCloud 的服务器地址、用户 ID（密码在 secrets）：填了 Hub 每次去取最新的 Cookie */
  cookieCloudUrl: string;
  cookieCloudId: string;
  /** 从微信读书取一本书时带上几条热门书评（0 = 不带） */
  reviews: number;
}
export const DEFAULT_WEREAD: WereadSettings = { source: 'hub', url: '', headerName: 'Authorization', cookieCloudUrl: '', cookieCloudId: '', reviews: 10 };
export const WEREAD_REVIEWS_MAX = 30;

export const SECRET_IDS = {
  neteaseCookie: 'svc:netease-cookie',
  googleMaps: 'svc:google-maps',
  /** 给云端的 Google 地图 Key：同步时加密传到你的 Worker，每天到点排健康计划时云端用它查家附近的店 */
  googleMapsCloud: 'svc:google-maps-cloud',
  qweather: 'svc:qweather',
  /** B 站登录 Cookie（SESSDATA=…）：逛 B 站搜索时随请求发给你自己的云端 Hub */
  biliCookie: 'svc:bili-cookie',
  /** 微信读书 Cookie：随请求发给你自己的云端 Hub（内置的微信读书 MCP） */
  wereadCookie: 'svc:weread-cookie',
  cookieCloudPassword: 'svc:cookiecloud-password',
  /** 自己部署的微信读书 MCP 的请求头的值 */
  wereadHeader: 'svc:weread-header',
} as const;

/** 去掉多余的空白和末尾的斜杠；没写 https:// 的补上 */
export function normalizeBase(url: string): string {
  const t = url.trim().replace(/\/+$/, '');
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export const useServicesStore = defineStore('services', () => {
  const netease = reactive<NeteaseSettings>({ workerUrl: '', quality: 'exhigh', volume: 1 });
  const weather = reactive<WeatherServiceSettings>({ qweatherHost: '' });
  const weread = reactive<WereadSettings>({ ...DEFAULT_WEREAD });
  /** svc: 开头的 Key / Cookie */
  const secrets = reactive<Record<string, string>>({});

  type Saved = { netease?: Partial<NeteaseSettings>; weather?: Partial<WeatherServiceSettings>; weread?: Partial<WereadSettings> };
  // 别的设备改了音乐、天气、微信读书的设置（同步；Key 和 Cookie 不同步）：放进来
  const saver = autoSave('settings', () => [{ key: 'services', value: { netease, weather, weread } }], () => [netease, weather, weread],
    { apply: ([c]) => { if (c && !c.deleted) load(c.value as Saved); } });

  function load(saved: Saved | null | undefined) {
    const n = saved?.netease;
    if (n) {
      if (typeof n.workerUrl === 'string') netease.workerUrl = n.workerUrl;
      if (NETEASE_QUALITIES.some((q) => q.value === n.quality)) netease.quality = n.quality as NeteaseQuality;
      if (typeof n.volume === 'number' && n.volume >= 0 && n.volume <= 1) netease.volume = n.volume;
    }
    if (typeof saved?.weather?.qweatherHost === 'string') weather.qweatherHost = saved.weather.qweatherHost;
    const w = saved?.weread;
    if (w) {
      if (w.source === 'hub' || w.source === 'url') weread.source = w.source;
      for (const k of ['url', 'headerName', 'cookieCloudUrl', 'cookieCloudId'] as const) if (typeof w[k] === 'string') weread[k] = w[k];
      if (typeof w.reviews === 'number' && w.reviews >= 0 && w.reviews <= WEREAD_REVIEWS_MAX) weread.reviews = Math.round(w.reviews);
    }
  }
  const secretSaver = autoSave(
    'secrets',
    () => Object.entries(secrets).filter(([k, v]) => k.startsWith('svc:') && !!v).map(([key, value]) => ({ key, value })),
    () => ({ ...secrets }),
    200,
  );

  async function hydrate() {
    const [saved, stored] = await Promise.all([
      getOne<Saved>('settings', 'services'),
      getEntries<string>('secrets'),
    ]);
    load(saved);
    for (const { key, value } of stored) if (key.startsWith('svc:') && typeof value === 'string' && value) secrets[key] = value;
    saver.start();
    secretSaver.start();
  }

  function setSecret(id: string, value: string | null | undefined) {
    const v = value?.trim();
    if (v) secrets[id] = v;
    else delete secrets[id];
  }

  const neteaseBase = computed(() => normalizeBase(netease.workerUrl));
  const neteaseCookie = computed(() => secrets[SECRET_IDS.neteaseCookie] ?? '');
  const musicReady = computed(() => !!neteaseBase.value);

  const mapsKey = computed(() => secrets[SECRET_IDS.googleMaps] ?? '');
  const mapsReady = computed(() => !!mapsKey.value);
  const cloudMapsKey = computed(() => secrets[SECRET_IDS.googleMapsCloud] ?? '');

  const qweatherBase = computed(() => normalizeBase(weather.qweatherHost));
  const qweatherKey = computed(() => secrets[SECRET_IDS.qweather] ?? '');
  const qweatherReady = computed(() => !!qweatherBase.value && !!qweatherKey.value);

  const biliCookie = computed(() => secrets[SECRET_IDS.biliCookie] ?? '');

  return {
    netease,
    weather,
    secrets,
    hydrate,
    setSecret,
    neteaseBase,
    neteaseCookie,
    musicReady,
    mapsKey,
    mapsReady,
    cloudMapsKey,
    qweatherBase,
    qweatherKey,
    qweatherReady,
    biliCookie,
    weread,
  };
});
