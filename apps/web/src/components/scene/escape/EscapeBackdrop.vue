<script setup lang="ts">
import type { EscapeDrawnView, EscapeView } from '@app/shared';
import { computed, nextTick, ref, watch } from 'vue';
import { BACKGROUND_ASSETS, backgroundUrl } from '@/backgrounds/library';

/**
 * 出逃的画面：实拍是一段静音循环的竖屏视频，插画是素材库里的图慢慢平移、叠上会动的东西。
 * 换画面时新的淡入、旧的淡出。
 * iPhone 低电量模式会拦住自动播放（静音的也拦）：播不起来时先停在封面上，点一下再播。
 */
const props = defineProps<{ view: EscapeView }>();

const root = ref<HTMLElement | null>(null);
const blocked = ref(false);

function imageOf(v: EscapeDrawnView): string {
  const asset = BACKGROUND_ASSETS.find((a) => a.id === v.image);
  return asset ? backgroundUrl(asset) : '';
}
const drawnUrl = computed(() => (props.view.kind === 'drawn' ? imageOf(props.view) : ''));

/** 换画面时新旧两层同时在（淡入淡出），按画面 id 找这一层的视频 */
async function play() {
  const el = root.value?.querySelector<HTMLVideoElement>(`.layer[data-view="${CSS.escape(props.view.id)}"] video`);
  if (!el) return;
  try {
    await el.play();
    blocked.value = false;
  } catch {
    blocked.value = true;
  }
}
watch(
  () => props.view.id,
  async () => {
    blocked.value = false;
    await nextTick();
    if (props.view.kind === 'video') void play();
  },
  { immediate: true },
);

/** 漂浮的光点：位置、快慢错开 */
const MOTES = Array.from({ length: 14 }, (_, i) => ({ left: `${(i * 37) % 100}%`, top: `${55 + ((i * 23) % 40)}%`, delay: `-${(i * 0.7).toFixed(1)}s`, dur: `${7 + (i % 5)}s` }));
const STREAKS = Array.from({ length: 4 }, (_, i) => ({ top: `${34 + i * 5}%`, delay: `-${(i * 0.65).toFixed(2)}s`, dur: `${(2 + i * 0.4).toFixed(1)}s` }));
</script>

<template>
  <div ref="root" class="escape-backdrop" data-testid="escape-backdrop">
    <Transition name="view">
      <div :key="view.id" class="layer" :data-kind="view.kind" :data-view="view.id">
        <template v-if="view.kind === 'video'">
          <video class="media" :src="view.src" :poster="view.poster" muted loop playsinline autoplay preload="auto" disablepictureinpicture aria-hidden="true" />
          <button v-if="blocked" type="button" class="tap-play" data-testid="escape-tap-play" @click="play">
            <span class="i-lucide-play" />点一下让画面动起来
          </button>
        </template>
        <template v-else>
          <div class="media still" :class="view.motion" :style="{ backgroundImage: `url(${drawnUrl})` }" />
          <template v-if="view.fx.includes('stars')">
            <div class="stars" />
            <div class="stars b" />
          </template>
          <template v-if="view.fx.includes('clouds') || view.fx.includes('warm-clouds')">
            <div class="cloud" :class="{ warm: view.fx.includes('warm-clouds') }" style="top: 7%" />
            <div class="cloud c2" :class="{ warm: view.fx.includes('warm-clouds') }" />
          </template>
          <div v-if="view.fx.includes('glint')" class="glint" />
          <div v-if="view.fx.includes('motes')" class="motes">
            <i v-for="(m, i) in MOTES" :key="i" :style="{ left: m.left, top: m.top, animationDelay: m.delay, animationDuration: m.dur }" />
          </div>
          <template v-if="view.fx.includes('streaks')">
            <div v-for="(s, i) in STREAKS" :key="i" class="streak" :style="{ top: s.top, animationDelay: s.delay, animationDuration: s.dur }" />
          </template>
        </template>
      </div>
    </Transition>
    <div class="shade" />
  </div>
</template>

<style scoped>
.escape-backdrop {
  position: absolute;
  inset: 0;
  overflow: hidden;
  background: #05070b;
}
.layer {
  position: absolute;
  inset: 0;
}
.media {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.still {
  background-size: cover;
  background-repeat: no-repeat;
  background-position: 50% 50%;
}
/* 横图在竖屏里从左慢慢扫到右，再扫回来 */
.still.pan {
  animation: pan 46s ease-in-out infinite alternate;
}
.still.sway {
  animation:
    pan 46s ease-in-out infinite alternate,
    sway 3.4s ease-in-out infinite;
}
@keyframes pan {
  from {
    background-position: 0% 50%;
  }
  to {
    background-position: 100% 50%;
  }
}
@keyframes sway {
  0%,
  100% {
    transform: translateY(0) rotate(0);
  }
  50% {
    transform: translateY(1.5px) rotate(0.12deg);
  }
}
.shade {
  position: absolute;
  inset: auto 0 0 0;
  height: 45%;
  background: linear-gradient(transparent, rgba(0, 0, 0, 0.45));
  pointer-events: none;
}
.tap-play {
  position: absolute;
  left: 50%;
  top: 42%;
  transform: translate(-50%, -50%);
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 14px;
  border-radius: 99px;
  border: 1px solid rgba(255, 255, 255, 0.25);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 13px;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

/* 会动的东西 */
.stars {
  position: absolute;
  inset: 0 0 50% 0;
  pointer-events: none;
  background-image:
    radial-gradient(1.4px 1.4px at 12% 18%, #fff, transparent 60%), radial-gradient(1.1px 1.1px at 32% 8%, #fff, transparent 60%),
    radial-gradient(1.6px 1.6px at 58% 22%, #fff, transparent 60%), radial-gradient(1.1px 1.1px at 76% 12%, #fff, transparent 60%),
    radial-gradient(1.4px 1.4px at 88% 30%, #fff, transparent 60%), radial-gradient(1.1px 1.1px at 44% 36%, #fff, transparent 60%),
    radial-gradient(1.1px 1.1px at 20% 40%, #fff, transparent 60%), radial-gradient(1.5px 1.5px at 66% 4%, #fff, transparent 60%);
  animation: twinkle 3.2s ease-in-out infinite alternate;
}
.stars.b {
  animation-delay: -1.6s;
  transform: translate(7%, 5%);
}
@keyframes twinkle {
  from {
    opacity: 0.15;
  }
  to {
    opacity: 0.95;
  }
}
.cloud {
  position: absolute;
  width: 90%;
  height: 26%;
  border-radius: 50%;
  pointer-events: none;
  background: radial-gradient(closest-side, rgba(255, 255, 255, 0.55), rgba(255, 255, 255, 0));
  filter: blur(6px);
  animation: drift 38s linear infinite;
}
.cloud.warm {
  background: radial-gradient(closest-side, rgba(255, 214, 190, 0.55), rgba(255, 214, 190, 0));
}
.cloud.c2 {
  top: 14%;
  height: 18%;
  opacity: 0.7;
  animation-duration: 52s;
  animation-delay: -20s;
}
@keyframes drift {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(130%);
  }
}
.glint {
  position: absolute;
  left: 0;
  right: 0;
  top: 52%;
  height: 30%;
  pointer-events: none;
  background: repeating-linear-gradient(90deg, transparent 0 14px, rgba(255, 255, 255, 0.18) 15px, transparent 17px 31px);
  mix-blend-mode: screen;
  -webkit-mask-image: linear-gradient(transparent, #000 30%, transparent);
  mask-image: linear-gradient(transparent, #000 30%, transparent);
  animation: glint 4s ease-in-out infinite alternate;
}
@keyframes glint {
  from {
    opacity: 0.1;
    transform: translateX(-6px);
  }
  to {
    opacity: 0.55;
    transform: translateX(6px);
  }
}
.motes {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.motes i {
  position: absolute;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 226, 180, 0.9);
  box-shadow: 0 0 6px rgba(255, 210, 150, 0.9);
  animation: mote 9s linear infinite;
}
@keyframes mote {
  0% {
    transform: translateY(0);
    opacity: 0;
  }
  15% {
    opacity: 1;
  }
  100% {
    transform: translateY(-160px) translateX(30px);
    opacity: 0;
  }
}
.streak {
  position: absolute;
  left: -40%;
  width: 40%;
  height: 2px;
  border-radius: 2px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 240, 200, 0.85), transparent);
  animation: streak 2.6s linear infinite;
}
@keyframes streak {
  to {
    transform: translateX(380%);
  }
}

.view-enter-active,
.view-leave-active {
  transition: opacity 0.9s ease;
}
.view-enter-from,
.view-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .still.pan,
  .still.sway,
  .stars,
  .cloud,
  .glint,
  .motes i,
  .streak {
    animation: none;
  }
}
</style>
