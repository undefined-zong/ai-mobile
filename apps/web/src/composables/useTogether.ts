import {
  defaultLocationFor,
  getLocation,
  isRealPlace,
  OWN_ENTRY_SCENES,
  SCENES,
  timeOfDay,
  WORLD_ACTIVITY_SCENES,
  worldOf,
  type Character,
  type LocationActivity,
  type MapLocation,
  type SceneId,
  type TimeOfDay,
  type World,
} from '@app/shared';
import { computed, toValue, type MaybeRefOrGetter } from 'vue';
import { useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { useParallelStore } from '@/stores/parallel';
import { useRhythmStore } from '@/stores/rhythm';

/** 一起做的一件事（格子里的一格） */
export interface TogetherTile {
  key: string;
  name: string;
  icon: string;
  tint: string;
  /** 小字：在哪做 / 和谁 / 几条新留言 */
  where: string;
  /** 她世界里的活动：长按能换地方 */
  scene?: SceneId;
  /** 她此刻在的地方就能做 */
  near?: boolean;
  run: () => void;
}

/** 格子里常用的排前面 */
const COMMON: SceneId[] = ['study', 'meal', 'exercise', 'sleep', 'rest', 'music', 'date', 'watch', 'game', 'read', 'poke'];
/** "一起做点什么"里的活动：除了另有入口的那几个，一个都不能少（和她的世界里有没有地方无关） */
export const TOGETHER_SCENES = WORLD_ACTIVITY_SCENES;

/**
 * 在她的世界里，这件事在哪做。"建世界"是 AI 挑的地点和活动，可能哪儿都没写某件事（比如没有影院就没有一起观影）：
 * 这时就在她家做——功能不能因为地图上没有地方就不见。
 */
export function scenePlaces(w: World, sceneId: SceneId): MapLocation[] {
  const places = w.locations.filter((l) => l.activities.some((a) => a.sceneId === sceneId));
  if (places.length || OWN_ENTRY_SCENES.has(sceneId)) return places;
  const home = w.locations.find((l) => l.id === w.homeId) ?? w.locations[0];
  return home ? [home] : [];
}
/** 在这个地点做这件事（地点上没写这件事时就是这件事本身，不拿地点的第一个活动顶替） */
export function sceneActivity(l: MapLocation, sceneId: SceneId): LocationActivity {
  return l.activities.find((a) => a.sceneId === sceneId) ?? { sceneId, label: SCENES.find((s) => s.id === sceneId)?.name ?? sceneId };
}

/** 她在家时"此刻"按时段推荐 */
const TIME_SCENE: Record<TimeOfDay, SceneId> = {
  dawn: 'exercise',
  morning: 'meal',
  noon: 'meal',
  afternoon: 'study',
  dusk: 'meal',
  night: 'music',
  late: 'sleep',
};

/**
 * 和她一起做点什么（像素小镇的世界页、聚焦主题的"一起"面板共用）：
 * 她的世界里有哪些活动、各在哪做、默认去哪；加上一直在的打电话、共同的家、心跳、平行时空。
 * go 是"去这个地方做这件事"（页面决定怎么去：像素小镇先把镜头推过去）。
 */
export function useTogether(
  owner: MaybeRefOrGetter<Character | null | undefined>,
  go: (loc: MapLocation, activity: LocationActivity) => void | Promise<void>,
  now: MaybeRefOrGetter<Date> = () => new Date(),
) {
  const router = useRouter();
  const app = useAppStore();
  const parallel = useParallelStore();
  const rhythm = useRhythmStore();
  const who = computed(() => toValue(owner) ?? null);
  /** 直接跟随这个角色的小世界，新建、重建和同步后地点与活动一起更新。 */
  const world = computed(() => rhythm.worlds[who.value?.id ?? ''] ?? worldOf(who.value?.id));

  /** 她此刻在她小世界里的哪儿（来你这边了、不知道在哪时是 null） */
  const here = computed<MapLocation | null>(() => {
    const l = world.value.locations.find((loc) => loc.id === who.value?.locationId) ?? getLocation(who.value?.locationId);
    return l && !isRealPlace(l) ? l : null;
  });

  const placesFor = (sceneId: SceneId) => scenePlaces(world.value, sceneId);
  const activityAt = sceneActivity;
  /** 默认去哪：她现在在的地方能做就去那儿，否则去最常去的那个 */
  function defaultPlace(sceneId: SceneId): MapLocation | null {
    const c = who.value;
    if (!c) return null;
    if (here.value?.activities.some((a) => a.sceneId === sceneId)) return here.value;
    return placesFor(sceneId).length ? defaultLocationFor(sceneId, c.id) : null;
  }
  function goScene(sceneId: SceneId) {
    const loc = defaultPlace(sceneId);
    if (loc) void go(loc, activityAt(loc, sceneId));
    // 她的世界一个地点都没有：直接进场景，场景页自己定在哪
    else withHer(`/scene/${sceneId}`);
  }

  /** "此刻"那一件事：她在外面能一起做的就做那个，否则按时段 */
  const nowAction = computed(() => {
    const c = who.value;
    if (!c) return null;
    const l = here.value;
    if (l && l.id !== world.value.homeId && l.activities[0]) return { loc: l, activity: l.activities[0] };
    const scene = TIME_SCENE[timeOfDay(toValue(now).getHours())];
    const loc = l?.activities.some((a) => a.sceneId === scene) ? l : defaultLocationFor(scene, c.id);
    return { loc, activity: activityAt(loc, scene) };
  });

  function withHer(path: string, query?: Record<string, string>) {
    const c = who.value;
    if (!c) return;
    app.activeCharacterId = c.id;
    void router.push({ path, query });
  }
  const goHome = () => withHer('/scene/home', { at: 'real:home' });
  const goHeart = () => withHer('/scene/heart');
  const goEscape = () => withHer('/scene/escape');
  const goParallel = () => who.value && withHer(`/parallel/${encodeURIComponent(who.value.id)}`);
  const goCall = () => who.value && withHer(`/call/${who.value.id}`);

  const sceneDef = (id: SceneId) => SCENES.find((s) => s.id === id)!;
  const rank = (id: SceneId) => (COMMON.includes(id) ? COMMON.indexOf(id) : COMMON.length);
  /** 她世界里能做的活动（常用的排前面）+ 打电话、共同的家、心跳、平行时空、出逃（后五个一直在） */
  const tiles = computed((): TogetherTile[] => {
    const c = who.value;
    if (!c) return [];
    const scenes = [...TOGETHER_SCENES].sort((a, b) => rank(a.id) - rank(b.id));
    const home = sceneDef('home');
    const heart = sceneDef('heart');
    const escape = sceneDef('escape');
    const unread = parallel.unreadOf(c.id);
    return [
      ...scenes.map((s) => ({
        key: s.id,
        name: s.name,
        icon: s.icon,
        tint: s.tint,
        where: defaultPlace(s.id)?.name ?? '',
        scene: s.id,
        near: !!here.value?.activities.some((a) => a.sceneId === s.id),
        run: () => goScene(s.id),
      })),
      { key: 'call', name: '打电话', icon: 'i-lucide-phone', tint: '#e8c26a', where: `给${c.name}`, run: goCall },
      { key: 'home', name: home.name, icon: home.icon, tint: home.tint, where: '你的家', run: goHome },
      { key: 'heart', name: heart.name, icon: heart.icon, tint: heart.tint, where: `和${c.name}`, run: goHeart },
      { key: 'parallel', name: '平行时空', icon: 'i-lucide-orbit', tint: '#9fb4e8', where: unread ? `${unread} 条新留言` : `和${c.name}`, run: goParallel },
      { key: 'escape', name: escape.name, icon: escape.icon, tint: escape.tint, where: `带${c.name}去远方`, run: goEscape },
    ];
  });

  return { world, here, placesFor, activityAt, defaultPlace, nowAction, tiles, goHome, goHeart, goParallel, goCall, goEscape };
}
