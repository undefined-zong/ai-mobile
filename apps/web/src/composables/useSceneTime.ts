import { timeOfDay, zonedParts } from '@app/shared';
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useEnvironmentStore } from '@/stores/environment';

/** 所有背景共用一只时钟；切回 App 或更改时区时立即更新，整分钟更新一次。 */
const now = ref(Date.now());
let users = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
function tick() {
  clearTimeout(timer);
  now.value = Date.now();
  timer = setTimeout(tick, 60_000 - now.value % 60_000);
}

export function useSceneTime() {
  const environment = useEnvironmentStore();
  onMounted(() => {
    if (users++ === 0) {
      tick();
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('pageshow', tick);
      window.addEventListener('focus', tick);
    }
  });
  onUnmounted(() => {
    if (--users === 0) {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', tick);
      window.removeEventListener('pageshow', tick);
      window.removeEventListener('focus', tick);
    }
  });
  return computed(() => timeOfDay(zonedParts(now.value, environment.settings.timezone).hour));
}
