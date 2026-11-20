<script setup lang="ts">
import { avatarModeOf, fixedAvatarPortrait, type Character } from '@app/shared';
import { computed, inject } from 'vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import { FIGURE_LOOK } from '@/components/figure/look';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';
import { useRhythmStore } from '@/stores/rhythm';
import { mix } from '@/utils/color';

/**
 * 头像，按角色选的头像模式（avatarModeOf）：
 * - 固定：上传过的图；没上传时 avatarPortrait 那张立绘按头像框裁（没有立绘时是占位立绘），哪儿都一样；
 * - 跟随立绘：按头像框裁Ta此刻的立绘，服装按今天穿的那套、动作按Ta换过的；live 时表情也跟着换。
 *   在场景里时按场景里那张立绘的服装、动作、表情裁。
 */
const props = withDefaults(
  defineProps<{ character: Character; size?: number; ring?: boolean; live?: boolean; status?: 'online' | 'busy' | null }>(),
  { size: 44, ring: false, live: false, status: null },
);
const chars = useCharacterStore();
const looks = useAppearanceStore();
const rhythm = useRhythmStore();
const sceneLook = inject(FIGURE_LOOK, null);
const uploaded = computed(() => looks.avatarUrl('character', props.character));
const fixed = computed(() => avatarModeOf(props.character, !!uploaded.value) === 'fixed');
const src = computed(() => (fixed.value ? uploaded.value : null));
const fixedPortraitId = computed(() => (fixed.value ? (fixedAvatarPortrait(props.character.portraits, props.character.avatarPortrait)?.id ?? null) : null));
/** 跟随立绘时：在这个角色的场景里就照场景里那张的样子 */
const look = computed(() => {
  const l = sceneLook?.value;
  return !fixed.value && l?.characterId === props.character.id ? l : null;
});
const following = computed(() => !fixed.value && props.live);
const expression = computed(() => (following.value ? (look.value?.expression ?? chars.expression[props.character.id] ?? 'smile') : 'smile'));
const dayOutfit = computed(() => (fixed.value ? undefined : look.value ? look.value.dayOutfit : rhythm.outfitFor(props.character.id, null)));
const bg = computed(
  () => `linear-gradient(160deg, ${mix(props.character.accent, '#ffffff', 0.25)}, ${mix(props.character.accent, '#3b2a4a', 0.35)})`,
);
</script>

<template>
  <span
    class="avatar"
    :class="{ 'has-ring': ring }"
    :style="{ width: `${size}px`, height: `${size}px`, background: bg, '--ring': character.accent }"
    :title="character.name"
  >
    <img v-if="src" :src="src" class="avatar-img" alt="" />
    <PortraitFigure
      v-else
      class="avatar-fig"
      :character="character"
      :expression="expression"
      :outfit="look?.outfit"
      :pose="look?.pose"
      :day-outfit="dayOutfit"
      :portrait-id="fixedPortraitId"
      crop="head"
      :seed="following ? undefined : 0"
      :title="`${character.name}的头像`"
    />
    <span v-if="status" class="status" :class="status" />
  </span>
</template>

<style scoped>
.avatar {
  position: relative;
  flex-shrink: 0;
  display: inline-block;
  border-radius: 50%;
  overflow: visible;
}
.avatar-img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.avatar-fig {
  border-radius: 50%;
  overflow: hidden;
}
.avatar.has-ring {
  box-shadow:
    0 0 0 2px var(--bg),
    0 0 0 4px var(--ring);
}
.status {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 28%;
  height: 28%;
  min-width: 9px;
  min-height: 9px;
  border-radius: 50%;
  border: 2px solid var(--bg);
}
.status.online {
  background: var(--good);
}
.status.busy {
  background: var(--warn);
}
</style>
