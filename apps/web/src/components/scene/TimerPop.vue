<script setup lang="ts">
import type { SceneTimer } from '@/composables/useSceneTimer';
import { clock } from '@/utils/time';

/**
 * 计时器的面板（在右上角那一列左边展开）：没开时选几分钟，点了就开始；开着时看还剩多久、暂停、加 5 分钟、不计时了。
 * hint：到点会发生什么（"到点轻轻响铃，她叫你起来"）。
 */
defineProps<{ timer: SceneTimer; options: number[]; preferred?: number; hint?: string }>();
</script>

<template>
  <div class="timer-pop" data-testid="timer-pop">
    <template v-if="!timer.running.value">
      <div class="text-[14px] font-600">计时</div>
      <div class="chips">
        <button v-for="m in options" :key="m" type="button" class="chip" :class="{ on: m === preferred }" :data-minutes="m" @click="timer.start(m)">{{ m }} 分钟</button>
      </div>
    </template>
    <template v-else>
      <div class="flex items-end gap-2">
        <span class="num big">{{ clock(timer.remainSec.value) }}</span>
        <span class="text-[12.5px] text-ink-3 pb-1.5">{{ timer.paused.value ? '暂停了' : `定了 ${timer.state.minutes} 分钟` }}</span>
      </div>
      <div class="bar" aria-hidden="true"><span :style="{ width: `${timer.progress.value * 100}%` }" /></div>
      <div class="row">
        <button type="button" class="act" data-testid="timer-pause" @click="timer.togglePause()">
          <span :class="timer.paused.value ? 'i-lucide-play' : 'i-lucide-pause'" />{{ timer.paused.value ? '继续' : '暂停' }}
        </button>
        <button type="button" class="act" @click="timer.addMinutes(5)"><span class="i-lucide-plus" />5 分钟</button>
        <button type="button" class="act" data-testid="timer-cancel" @click="timer.cancel()"><span class="i-lucide-timer-off" />不计时了</button>
      </div>
    </template>
    <p v-if="hint" class="hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 10px;
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 32px;
  padding: 0 13px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.big {
  font-size: 30px;
  font-weight: 700;
  line-height: 1.1;
}
.bar {
  height: 4px;
  margin-top: 8px;
  border-radius: 99px;
  background: var(--panel-2);
  overflow: hidden;
}
.bar > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--accent);
  transition: width 0.9s linear;
}
.row {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}
.act {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 34px;
  border-radius: 11px;
  background: var(--panel);
  color: var(--ink);
  font-size: 12.5px;
  white-space: nowrap;
}
.hint {
  margin: 10px 0 0;
  font-size: 11.5px;
  color: var(--ink-3);
}
</style>
