<script setup lang="ts">
import type { BackgroundPlace, TimeOfDay } from '@app/shared';
import { computed, shallowRef, watch } from 'vue';
import { pickBackground } from '@/backgrounds/library';
import { useSceneTime } from '@/composables/useSceneTime';

/** 真正的场景素材：地点决定系列，时区时钟决定时段，界面主题不改变素材光照。 */
const props = withDefaults(defineProps<{
  kind: string;
  location?: BackgroundPlace | null;
  context?: string;
  tod?: TimeOfDay;
  rain?: boolean;
  dim?: number;
}>(), { rain: false, dim: 0 });
const clock = useSceneTime();
const t = computed(() => props.tod ?? clock.value);
const selected = computed(() => pickBackground({ ...props.location, kind: props.kind, context: props.context }, t.value));
const shown = shallowRef<ReturnType<typeof pickBackground>>();
// 新图加载好再切换；离开地点或切时段后，旧请求不会把背景换回去。
watch(selected, (next, _previous, cleanup) => {
  const bitmap = new Image();
  bitmap.onload = () => { shown.value = next; };
  bitmap.onerror = () => { shown.value = undefined; };
  cleanup(() => { bitmap.onload = null; bitmap.onerror = null; });
  bitmap.src = next.url;
}, { immediate: true });
</script>

<template>
  <div class="backdrop" aria-hidden="true" :data-background="shown?.asset.id" :data-period="shown?.asset.period" :data-time="t">
    <Transition name="background">
      <img v-if="shown" :key="shown.url" class="background-image" :src="shown.url" :width="shown.asset.width" :height="shown.asset.height" alt="" decoding="async" draggable="false" />
    </Transition>
    <div v-if="rain" class="rain" />
    <div class="vignette" :style="{ '--dim': dim }" />
  </div>
</template>

<style scoped>
.backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #191921;
  pointer-events: none;
}
.background-image {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}
.background-enter-active,
.background-leave-active {
  transition: opacity 0.45s ease;
}
.background-enter-from,
.background-leave-to {
  opacity: 0;
}
.rain {
  position: absolute;
  inset: -20%;
  background-image: repeating-linear-gradient(
    105deg,
    rgba(255, 255, 255, 0) 0 14px,
    rgba(255, 255, 255, 0.18) 14px 15px,
    rgba(255, 255, 255, 0) 15px 34px
  );
  background-size: 60px 120px;
  animation: rain 0.9s linear infinite;
  opacity: 0.55;
  pointer-events: none;
}
.vignette {
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(5, 3, 10, 0.35) 0%, rgba(5, 3, 10, 0) 22%, rgba(5, 3, 10, 0) 55%, rgba(5, 3, 10, 0.55) 100%),
    rgba(5, 3, 10, calc(var(--dim) * 1));
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .background-enter-active,
  .background-leave-active { transition: none; }
  .rain { animation: none; }
}
</style>
