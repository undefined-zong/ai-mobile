<script setup lang="ts">
import type { Community } from '@app/shared';

/** 社群的图标：主题色的底上一个 emoji（没有 emoji 时用名字的第一个字） */
withDefaults(defineProps<{ community: Pick<Community, 'name' | 'icon' | 'color'>; size?: number }>(), { size: 48 });
</script>

<template>
  <span class="community-icon" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.5)}px`, borderRadius: `${Math.round(size * 0.3)}px`, '--c': community.color }" aria-hidden="true">
    {{ community.icon || community.name.slice(0, 1) }}
  </span>
</template>

<style scoped>
.community-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 1;
  font-weight: 700;
  color: var(--c);
  background: var(--panel);
  box-shadow: inset 0 0 0 1px var(--border);
}
@supports (background: color-mix(in srgb, red 10%, transparent)) {
  .community-icon {
    background: color-mix(in srgb, var(--c) 22%, var(--panel));
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c) 38%, transparent);
  }
}
</style>
