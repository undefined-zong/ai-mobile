<script setup lang="ts">
import { kingdomNpcAge, KINGDOM_ROLES, type KingdomNpc, type KingdomRun } from '@app/shared';
import AssetImg from '@/components/common/AssetImg.vue';
defineProps<{ npc: KingdomNpc; run: KingdomRun; selected?: boolean; office?: string; gallery?: boolean }>();
defineEmits<{ select: [] }>();
</script>

<template>
  <button type="button" class="person" :class="{ selected, gallery }" :aria-pressed="!!selected" @click="$emit('select')">
    <span class="portrait">
      <AssetImg v-if="npc.portrait" :asset-key="npc.portrait.assetKey" :url="npc.portrait.url" :alt="`${npc.name}立绘`" />
      <span v-else class="unpainted" aria-hidden="true"><span>{{ npc.name.slice(0, 1) }}</span><small>丹青待绘</small></span>
      <span v-if="gallery" class="portrait-title">{{ npc.title }}</span>
    </span>
    <span class="profile">
      <strong>{{ npc.name }}<small v-if="npc.characterId">故人</small></strong>
      <span>{{ office || npc.title || KINGDOM_ROLES[npc.role] }} · {{ kingdomNpcAge(run, npc) }} 岁</span>
      <span v-if="!gallery">{{ npc.personality }}</span>
      <span v-if="npc.role === 'minister'" class="numbers">政 {{ npc.skills.politics }} · 军 {{ npc.skills.military }} · 科 {{ npc.skills.technology }} · 文 {{ npc.skills.culture }}</span>
      <span v-else-if="npc.role === 'consort'" class="numbers">亲密 {{ Math.round(npc.affection) }}<template v-if="npc.pregnancyDue"> · {{ npc.pregnancyDue - run.turn }} 季后添子嗣</template></span>
      <span v-else class="numbers">{{ run.factions.find(f => f.id === npc.factionId)?.name }}</span>
    </span>
    <span v-if="!gallery" class="i-lucide-chevron-right" aria-hidden="true" />
  </button>
</template>

<style scoped>
.person { display: flex; align-items: center; gap: 12px; width: 100%; text-align: left; padding: 14px 0; color: var(--ink); border-bottom: 1px solid var(--border); }
.person.selected .profile strong { color: var(--accent-ink); }
.portrait { position: relative; width: 68px; height: 96px; flex-shrink: 0; overflow: hidden; background: #c9c5a9; border: 1px solid #b7a77f; }
.portrait :deep(img) { object-fit: cover; object-position: top; }
.unpainted { display: flex; flex-direction: column; height: 100%; align-items: center; justify-content: center; gap: 5px; background: radial-gradient(ellipse at top, #eee6cf, #c6bea0); }
.unpainted > span { font-family: var(--royal-serif); font-size: 32px; color: #7e8069; }.unpainted > small { color: #8b7e62; font-size: 8px; letter-spacing: 1px; }
.profile { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--ink-2); }
.profile strong { font-family: var(--royal-serif); font-weight: 600; letter-spacing: 1px; font-size: 19px; color: #59442e; overflow-wrap: anywhere; }
.profile strong small { font-family: var(--font-sans); font-size: 9px; color: #9b6343; font-weight: 400; margin-left: 8px; padding: 1px 3px; border: 1px solid #b99874; }
.numbers { font-variant-numeric: tabular-nums; color: #826a48; }
.gallery { flex-direction: column; padding: 0 0 14px; gap: 9px; align-items: stretch; text-align: center; }
.gallery .portrait { width: 100%; height: 180px; }.gallery .profile { gap: 3px; }.gallery .unpainted > span { font-size: 50px; }.gallery .unpainted > small { font-family: var(--royal-serif); font-size: 10px; letter-spacing: 3px; }.portrait-title { position: absolute; top: 10px; right: 7px; writing-mode: vertical-rl; max-height: 85%; color: #795b3b; background: #f1e5c9de; padding: 5px 2px; font-family: var(--royal-serif); font-size: 10px; letter-spacing: 2px; }
.person:focus-visible { outline: 2px solid #a16c3a; outline-offset: 2px; }
</style>
