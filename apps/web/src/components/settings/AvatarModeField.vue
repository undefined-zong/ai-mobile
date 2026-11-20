<script setup lang="ts">
import { avatarModeOf, fixedAvatarPortrait, hasPortraits, shownPortraits, type AvatarMode, type Character } from '@app/shared';
import { computed } from 'vue';
import HScroll from '@/components/common/HScroll.vue';
import Segmented from '@/components/common/Segmented.vue';
import PortraitFigure from '@/components/figure/PortraitFigure.vue';
import { useAppearanceStore } from '@/stores/appearance';
import { useCharacterStore } from '@/stores/characters';

/** 角色头像：固定头像（上传的图，或者挑一张立绘）/ 跟随立绘变化。外观页和角色编辑页共用 */
const props = defineProps<{ character: Character }>();
const chars = useCharacterStore();
const looks = useAppearanceStore();

const uploaded = computed(() => !!looks.avatarUrl('character', props.character));
const mode = computed<AvatarMode>({
  get: () => avatarModeOf(props.character, uploaded.value),
  set: (v) => chars.setAvatar(props.character.id, { mode: v }),
});
const set = computed(() => (hasPortraits(props.character.portraits) ? props.character.portraits : null));
/** 固定、没上传图时从立绘里挑一张 */
const choices = computed(() => (mode.value === 'fixed' && !uploaded.value && set.value ? shownPortraits(set.value) : []));
const pinned = computed(() => fixedAvatarPortrait(set.value, props.character.avatarPortrait)?.id ?? null);

const note = computed(() => {
  const p = props.character.pronoun;
  if (mode.value === 'fixed') {
    if (uploaded.value) return '用你上传的图，一直不变。';
    if (set.value) return `用下面选中的这张立绘按头像框裁，不随${p}的表情、动作、服装换；上传图片后改用上传的图。`;
    return '用占位立绘的头像，一直不变；上传图片后改用上传的图。';
  }
  const kept = uploaded.value ? '上传的图留着，换回固定头像时用。' : '';
  if (set.value) return `按头像框裁${p}此刻的立绘：跟着表情、动作和今天穿的那套换。${kept}`;
  return `用占位立绘的头像，跟着${p}的表情换。${kept}`;
});
</script>

<template>
  <div class="grid gap-2" :data-avatar-mode="character.id">
    <Segmented
      v-model="mode"
      :options="[
        { value: 'fixed', label: '固定头像' },
        { value: 'portrait', label: '跟随立绘变化' },
      ]"
    />
    <p class="m-0 text-[12px] leading-relaxed text-ink-3">{{ note }}</p>
    <HScroll v-if="choices.length > 1" :active="pinned" class="gap-2 p-1" aria-label="固定头像用哪张立绘">
      <button
        v-for="p in choices"
        :key="p.id"
        type="button"
        class="pick"
        :class="{ on: p.id === pinned }"
        :aria-pressed="p.id === pinned"
        :aria-label="`头像用这张：${p.name}`"
        :title="p.name"
        @click="chars.setAvatar(character.id, { portrait: p.id })"
      >
        <PortraitFigure :character="character" :portrait-id="p.id" crop="head" />
      </button>
    </HScroll>
  </div>
</template>

<style scoped>
.pick {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
  background: linear-gradient(160deg, var(--accent-soft), var(--panel));
  box-shadow: 0 0 0 1px var(--border);
}
.pick.on {
  box-shadow:
    0 0 0 2px var(--bg),
    0 0 0 4px var(--accent);
}
</style>
