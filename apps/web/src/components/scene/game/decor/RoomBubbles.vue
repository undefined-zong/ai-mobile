<script setup lang="ts">
import type { BubbleAnchors, Resident } from './activities';
const props = defineProps<{ anchors: BubbleAnchors; messages: Record<Resident, string>; names: Record<Resident, string> }>();
function position(who: Resident) {
  const a = props.anchors[who];
  const both = props.messages.you && props.messages.her && Math.abs(props.anchors.you.x - props.anchors.her.x) < 184 && Math.abs(props.anchors.you.y - props.anchors.her.y) < 90;
  const center = (props.anchors.you.x + props.anchors.her.x) / 2;
  const x = both ? center + (who === 'you' ? -96 : 96) : a.x;
  return { left: `clamp(min(92px, 23vw), ${x}px, calc(100% - min(92px, 23vw)))`, top: `${Math.max(112, a.y)}px` };
}
</script>

<template>
  <div class="bubbles" aria-live="polite" aria-atomic="false">
    <template v-for="who in (['you', 'her'] as const)" :key="who">
      <div v-if="messages[who] && anchors[who].visible" class="bubble" :class="who" :style="position(who)" :aria-label="`${names[who]}说：${messages[who]}`">
        <span class="name">{{ names[who] }}</span><span>{{ messages[who] }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.bubbles { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.bubble { position: absolute; transform: translate(-50%, -100%); width: max-content; max-width: min(180px, 44vw); padding: 9px 12px; border-radius: 14px 14px 14px 4px; background: #fffdf5f5; border: 1px solid #d8d8c8; box-shadow: 0 3px 12px #36443816; color: #374738; font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
.bubble::after { content: ''; position: absolute; left: 50%; bottom: -6px; width: 10px; height: 10px; transform: rotate(45deg); background: #fffdf5; border-right: 1px solid #d8d8c8; border-bottom: 1px solid #d8d8c8; }
.name { display: block; color: #6b7d66; font-size: 10px; font-weight: 600; margin-bottom: 2px; }
.you { background: #eff7f8f5; border-color: #cadbdf; border-radius: 14px 14px 4px 14px; }
.you::after { background: #eff7f8; border-color: #cadbdf; }
</style>
