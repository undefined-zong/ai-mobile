<script setup lang="ts">
import { computed, ref } from 'vue';
import PlaylistMusic from '@/components/scene/PlaylistMusic.vue';
import { ambience, BREATH_KINDS, BREATH_LABEL, NOISE_KINDS, NOISE_LABEL } from '@/services/ambience';
import { sleepMusic } from '@/services/musicPlayer';
import { sleepSearches } from '@/services/playlistSearches';
import { SLEEP_NOISE_PRESETS, sleepAudio } from '@/services/sleepAudio';

/**
 * 哄睡全屏画面左下角的两个小按钮：白噪音（带呼吸声）、音乐。和陪伴学习最下面那一排一样的玻璃小圆角，点开是浮在上面的小面板。
 * 放在一条占满宽度、定了位的底栏里用（面板按那条底栏定位）；连麦、故事、场景三种画面共用，声音在三种画面之间不断。
 * - 白噪音：本机合成（services/ambience.ts），四个滑块混音，几个现成的搭配；
 * - 呼吸声：男声 / 女声，像有人睡在旁边，可以只开它，也可以和白噪音叠着；
 * - 音乐：网易云的助眠歌单（components/scene/PlaylistMusic.vue，播放器是 sleepMusic；自带的几个在 services/playlistSearches.ts，能自己增删）。
 * compact：这一排还要放别的按钮（连麦的闭麦、挂断）时，白噪音只留图标。
 */
defineProps<{ compact?: boolean }>();


const audio = sleepAudio.state;
const open = ref<'noise' | 'music' | null>(null);
const sounding = computed(() => sleepAudio.noiseActive.value || !!sleepAudio.breathActive.value);
/** 白噪音里最响的那种（按钮上的图标和字） */
const loudest = computed(() => [...NOISE_KINDS].sort((a, b) => audio.mix[b] - audio.mix[a])[0]!);
const noiseIcon = computed(() => {
  if (ambience.state.loading) return 'i-lucide-loader-circle';
  if (sleepAudio.noiseActive.value) return NOISE_LABEL[loudest.value].icon;
  return sleepAudio.breathActive.value ? 'i-lucide-wind' : 'i-lucide-audio-lines';
});
const noiseText = computed(() => {
  if (ambience.state.loading) return '准备中';
  const breath = sleepAudio.breathActive.value;
  if (sleepAudio.noiseActive.value) return `${NOISE_LABEL[loudest.value].label}${breath ? ' + 呼吸' : ''}`;
  return breath ? '呼吸声' : '白噪音';
});
const musicPlaying = computed(() => sleepMusic.state.playing && !sleepMusic.state.fading);
</script>

<template>
  <div class="dock" data-testid="sleep-audio">
    <button
      type="button"
      class="pill"
      :class="{ on: sounding, icon: compact }"
      :aria-expanded="open === 'noise'"
      :aria-label="`白噪音和呼吸声：${sounding ? noiseText : '没开'}`"
      data-testid="sleep-noise-btn"
      @click="open = open === 'noise' ? null : 'noise'"
    >
      <span :class="[noiseIcon, { spin: ambience.state.loading }]" class="shrink-0" /><span v-if="!compact" class="pill-text">{{ noiseText }}</span>
    </button>
    <button
      type="button"
      class="pill icon"
      :class="{ on: musicPlaying }"
      :aria-expanded="open === 'music'"
      :aria-label="musicPlaying ? `音乐：${sleepMusic.current()?.title ?? '正在播放'}` : '音乐'"
      data-testid="sleep-music-btn"
      @click="open = open === 'music' ? null : 'music'"
    >
      <span :class="sleepMusic.state.loading ? 'i-lucide-loader-circle spin' : musicPlaying ? 'i-lucide-disc-3 spin-slow' : 'i-lucide-music'" />
    </button>

    <div v-if="open" class="pop-catcher" @click="open = null" />
    <div v-if="open === 'noise'" class="pop noise-pop" role="dialog" aria-label="白噪音和呼吸声">
      <div class="flex items-center gap-2.5">
        <button
          type="button"
          class="play shrink-0"
          :aria-label="sleepAudio.noiseActive.value ? '关掉白噪音' : '播放白噪音'"
          :aria-pressed="sleepAudio.noiseActive.value"
          data-testid="noise-play"
          @click="sleepAudio.toggleNoise()"
        >
          <span :class="ambience.state.loading ? 'i-lucide-loader-circle spin' : sleepAudio.noiseActive.value ? 'i-lucide-pause' : 'i-lucide-play'" />
        </button>
        <div class="flex-1 min-w-0">
          <div class="text-[14px] font-600">{{ ambience.state.loading ? '准备中……' : sleepAudio.noiseActive.value ? '白噪音开着' : '白噪音' }}</div>
          <div class="text-[11.5px] text-ink-3 truncate">在这台设备上合成，不联网、不用流量</div>
        </div>
      </div>
      <div class="flex gap-2 mt-2.5 overflow-x-auto no-scrollbar">
        <button v-for="p in SLEEP_NOISE_PRESETS" :key="p.label" type="button" class="chip" @click="sleepAudio.usePreset(p.mix)">{{ p.label }}</button>
      </div>
      <div class="grid gap-2 mt-2.5">
        <div v-for="k in NOISE_KINDS" :key="k" class="flex items-center gap-3">
          <span :class="NOISE_LABEL[k].icon" class="text-ink-3 shrink-0" />
          <span class="w-9 text-[13px] text-ink-2 shrink-0">{{ NOISE_LABEL[k].label }}</span>
          <van-slider v-model="audio.mix[k]" class="flex-1" bar-height="4px" button-size="16px" :aria-label="NOISE_LABEL[k].label" />
        </div>
      </div>

      <div class="divider" />
      <div class="flex items-center gap-2">
        <span class="i-lucide-wind text-ink-3 shrink-0" />
        <span class="text-[13px] text-ink-2 shrink-0">呼吸声</span>
        <span class="flex-1" />
        <button type="button" class="chip" :class="{ on: !sleepAudio.breathActive.value }" :aria-pressed="!sleepAudio.breathActive.value" @click="sleepAudio.pickBreath(null)">关</button>
        <button
          v-for="b in BREATH_KINDS"
          :key="b"
          type="button"
          class="chip"
          :class="{ on: sleepAudio.breathActive.value === b }"
          :aria-pressed="sleepAudio.breathActive.value === b"
          :data-testid="`breath-${b}`"
          @click="sleepAudio.pickBreath(b)"
        >
          {{ BREATH_LABEL[b] }}
        </button>
      </div>
      <div class="flex items-center gap-3 mt-2.5 px-1">
        <span class="i-lucide-volume-2 text-ink-3 shrink-0" />
        <van-slider v-model="audio.breathVolume" class="flex-1" bar-height="4px" button-size="16px" aria-label="呼吸声音量" />
      </div>
      <p class="text-[11.5px] text-ink-3 mt-2 mb-0">像有人睡在旁边，均匀地呼吸；可以只开呼吸声，也可以和白噪音叠着听。</p>
      <p v-if="ambience.state.error" class="text-[12px] text-bad mt-2 mb-0">{{ ambience.state.error }}</p>
    </div>
    <div v-if="open === 'music'" class="pop music-pop" role="dialog" aria-label="音乐">
      <PlaylistMusic :player="sleepMusic" :searches="sleepSearches" test-id="sleep-music" />
    </div>
  </div>
</template>

<style scoped>
.dock {
  display: flex;
  align-items: center;
  gap: 6px;
  /* 窄屏一排放不下时，白噪音上的字先省略（名字在 aria-label 里） */
  flex: 0 1 auto;
  min-width: 0;
}
.pill:not(.icon) {
  flex-shrink: 1;
  min-width: 38px;
}
.pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  min-width: 38px;
  height: 38px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--glass);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  color: var(--ink);
  font-size: 13.5px;
  white-space: nowrap;
  flex-shrink: 0;
}
.pill.on {
  color: var(--accent-ink);
  border-color: var(--accent-line);
}
.pill.icon {
  padding: 0;
}
.pill-text {
  min-width: 0;
  max-width: 7em;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pop-catcher {
  position: fixed;
  inset: 0;
  z-index: 1;
}
.pop {
  position: absolute;
  z-index: 2;
  left: 0;
  bottom: calc(100% + 8px);
  max-height: min(62vh, 520px);
  overflow-y: auto;
  border-radius: 18px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
  animation: rise 0.2s var(--ease) both;
}
.noise-pop {
  width: min(330px, 100%);
  padding: 12px;
}
.music-pop {
  right: 0;
  padding: 4px 14px 14px;
}
.play {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  font-size: 18px;
}
.chip {
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip.on {
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.divider {
  height: 1px;
  margin: 12px 0 10px;
  background: var(--glass-line);
}
.spin {
  animation: spin 1s linear infinite;
}
.spin-slow {
  animation: spin 4s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
