import { getLocation, isRainy, isRealPlace, worldOf, type Character, type MapLocation } from '@app/shared';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useWeatherStore } from '@/stores/weather';

/**
 * 她此刻在哪、那里是什么天：剧场和聚焦首页的背景、顶上的"地点 · 时间 · 天气"、在地图上看她在哪都按这个。
 * 在家时背景是卧室；她来你这边了（真实世界的地点）就看你那边的天气，否则看她那边的。
 */
export function useHerPlace(character: MaybeRefOrGetter<Character | null | undefined>) {
  const weatherStore = useWeatherStore();
  const c = computed(() => toValue(character) ?? null);
  /** 她那边的天气（她在别的城市时是那里的，否则和你一样） */
  const herWeather = computed(() => weatherStore.forCharacter(c.value));
  const herWeatherText = computed(() => {
    const w = herWeather.value;
    if (!w) return '';
    return weatherStore.hasOwnCity(c.value) ? `${w.place} ${weatherStore.short(w)}` : weatherStore.short(w);
  });
  /** 她此刻在的地方；导入的角色还没有自己的小世界时退回她世界的第一个地点（只用来挑背景） */
  const loc = computed<MapLocation>(() => getLocation(c.value?.locationId) ?? (worldOf(c.value?.id).locations[0] as MapLocation));
  /** 知不知道她在哪：不知道时不显示地点（不借用别人的世界） */
  const placeKnown = computed(() => !!getLocation(c.value?.locationId));
  /** 背景所在地点的天气：你真实世界里的地方看你那边的，她小世界里的看她那边的 */
  const weather = computed(() => (isRealPlace(loc.value) ? weatherStore.mine : herWeather.value));
  const weatherText = computed(() => (weather.value ? weatherStore.short(weather.value) : ''));
  /** 那边的天气取得怎么样（还在取、没取到）：没有天气时告诉你为什么 */
  const weatherEntry = computed(() => (isRealPlace(loc.value) ? weatherStore.mineEntry : weatherStore.entryFor(c.value)));
  /** 在地图上看：她世界里的地点去她的世界，你真实世界里的地点去"我的世界" */
  const mapLink = computed(() => `/map?world=${isRealPlace(loc.value) ? 'me' : c.value?.id}&focus=${loc.value.id}`);
  const backdrop = computed(() => (loc.value.area === 'home' ? 'bedroom' : loc.value.backdrop));
  const rain = computed(() => isRainy(weather.value?.text) && (!loc.value.indoor || ['bedroom', 'library', 'cafe'].includes(backdrop.value)));
  return { herWeather, herWeatherText, loc, placeKnown, weather, weatherText, weatherEntry, mapLink, backdrop, rain };
}
