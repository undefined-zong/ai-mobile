<script setup lang="ts">
import { computed } from 'vue';
import type { SceneTimer } from '@/composables/useSceneTimer';

/**
 * 右上角那一列里的计时器按钮（白噪音下面）：没开时是个计时器图标；开着时一圈进度，中间是还剩几分钟。
 * 按钮的底色、大小跟着场景那一列的按钮走（场景给它自己那一列按钮的 class）。
 */
const props = defineProps<{ timer: SceneTimer }>();
const mins = computed(() => Math.max(1, Math.ceil(props.timer.remainSec.value / 60)));
const label = computed(() =>
  props.timer.running.value ? `计时器：还剩 ${mins.value} 分钟${props.timer.paused.value ? '，暂停了' : ''}` : '计时器：没开',
);
const C = 2 * Math.PI * 16;
</script>

<template>
  <button type="button" class="timer-btn" :class="{ on: timer.running.value }" :aria-label="label" data-testid="timer-btn">
    <template v-if="timer.running.value">
      <svg viewBox="0 0 38 38" class="progress-ring" aria-hidden="true">
        <circle cx="19" cy="19" r="16" fill="none" class="track" stroke-width="2.5" />
        <circle
          cx="19"
          cy="19"
          r="16"
          fill="none"
          class="lit"
          stroke-width="2.5"
          stroke-linecap="round"
          :stroke-dasharray="C"
          :stroke-dashoffset="C * timer.progress.value"
          transform="rotate(-90 19 19)"
        />
      </svg>
      <span v-if="timer.paused.value" class="i-lucide-pause mins" />
      <span v-else class="num mins">{{ mins }}</span>
    </template>
    <span v-else class="i-lucide-timer" />
  </button>
</template>

<style scoped>
.timer-btn {
  position: relative;
}
/* 开着时压在会动的背景上也要看得清：底色不透明一点（比场景那一列按钮的 .on 优先） */
.timer-btn.timer-btn.on {
  background: var(--glass-strong);
  color: var(--accent-ink);
}
.progress-ring {
  position: absolute;
  inset: -1px;
  width: calc(100% + 2px);
  height: calc(100% + 2px);
  pointer-events: none;
}
.track {
  stroke: color-mix(in srgb, currentColor 18%, transparent);
}
.lit {
  stroke: currentColor;
  transition: stroke-dashoffset 0.9s linear;
}
.mins {
  font-size: 13px;
  font-weight: 700;
}
</style>
