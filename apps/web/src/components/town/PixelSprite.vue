<script setup lang="ts">
import type { Character } from '@app/shared';
import { computed, onMounted, ref, watch } from 'vue';
import { useRhythmStore } from '@/stores/rhythm';
import { drawSprite } from './art';
import { spriteLookOf } from './sprite';

/** 角色的像素小人（和小镇里的是同一个），放在列表、卡片里当小头像 */
const props = withDefaults(defineProps<{ character: Character; scale?: number }>(), { scale: 3 });
const rhythm = useRhythmStore();
const look = computed(() => spriteLookOf(props.character, rhythm.outfitFor(props.character.id, null)?.tags ?? ''));
const cv = ref<HTMLCanvasElement>();
const W = 12;
const H = 18;
function paint() {
  const c = cv.value;
  if (!c) return;
  const ctx = c.getContext('2d')!;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.setTransform(props.scale, 0, 0, props.scale, 0, 0);
  drawSprite(ctx, 1, 0, look.value, 0);
}
onMounted(paint);
watch(look, paint);
</script>

<template>
  <canvas ref="cv" class="pixel-sprite" :width="W * scale" :height="H * scale" :style="{ width: `${W * scale}px`, height: `${H * scale}px` }" :aria-label="`${character.name}的像素小人`" role="img" />
</template>

<style scoped>
.pixel-sprite {
  image-rendering: pixelated;
  flex-shrink: 0;
}
</style>
