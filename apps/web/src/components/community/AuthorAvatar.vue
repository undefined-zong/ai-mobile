<script setup lang="ts">
import { isNetizen, MOMENT_USER, nameColor, netizenName } from '@app/shared';
import { computed } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import { socialPersona } from '@/services/social';
import { useCharacterStore } from '@/stores/characters';

/**
 * 社群里一个人的头像：你（人设的头像）、角色（她的头像）、网友（按网名算出来的颜色上写网名的第一个字）。
 * 角色被删掉了显示一个空头像
 */
const props = withDefaults(defineProps<{ authorId: string; size?: number }>(), { size: 40 });
const chars = useCharacterStore();
const character = computed(() => chars.byId(props.authorId));
const me = computed(() => socialPersona());
const netizen = computed(() => (isNetizen(props.authorId) ? netizenName(props.authorId) : ''));
</script>

<template>
  <PersonaAvatar v-if="authorId === MOMENT_USER" :persona="me" :size="size" />
  <Avatar v-else-if="character" :character="character" :size="size" />
  <span v-else class="who" :style="{ width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px`, ...(netizen ? { background: nameColor(netizen) } : {}) }">
    <template v-if="netizen">{{ Array.from(netizen)[0] }}</template>
    <span v-else class="i-lucide-user-round-x" />
  </span>
</template>

<style scoped>
.who {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--panel);
  color: #fff;
  font-weight: 700;
  line-height: 1;
  text-transform: uppercase;
}
</style>
