<script setup lang="ts">
import { getScene, type Character, type MapLocation, type SceneId } from '@app/shared';
import { computed } from 'vue';

/** 长按一件事：换个地方做（她此刻在的那个标出来） */
const props = defineProps<{ scene: SceneId | null; places: MapLocation[]; hereId?: string | null; owner: Character }>();
const emit = defineEmits<{ (e: 'go', loc: MapLocation): void; (e: 'close'): void }>();
const name = computed(() => (props.scene ? getScene(props.scene).name : ''));
</script>

<template>
  <van-popup :show="!!scene" position="bottom" round teleport="body" @update:show="(v: boolean) => !v && emit('close')">
    <div v-if="scene" class="sheet">
      <div class="sheet-title">{{ name }} · 去哪儿</div>
      <div class="list mt-3">
        <button v-for="l in places" :key="l.id" class="list-row press" @click="emit('go', l)">
          <span class="flex-1 text-left">{{ l.name }}</span>
          <span class="text-[13px]" :class="l.id === hereId ? 'text-accent-ink' : 'text-ink-3'">{{ l.id === hereId ? `${owner.name}在这里` : l.blurb }}</span>
        </button>
      </div>
    </div>
  </van-popup>
</template>

<style scoped>
.sheet {
  padding: 18px 16px calc(18px + var(--safe-bottom));
}
.sheet-title {
  font-size: 17px;
  font-weight: 650;
}
.list {
  display: grid;
  border-radius: 12px;
  overflow: hidden;
  background: var(--panel);
}
.list-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 0 14px;
  border: 0;
  border-top: 1px solid var(--border);
  background: none;
  color: var(--ink);
  font-size: 15px;
  text-decoration: none;
}
.list-row:first-child {
  border-top: 0;
}
</style>
