<script setup lang="ts">
import { kingdomAdjacent, type KingdomRun } from '@app/shared';
const props = defineProps<{ run: KingdomRun; disabled?: boolean }>();
const emit = defineEmits<{ select: [id: string] }>();
const owner = (id: string) => id === 'player' ? props.run.name : props.run.factions.find(f => f.id === id)?.name;
const terrain = { plain: '平原', mountain: '山地', river: '水网' };
// Shared corners make every border match the four-neighbour simulation topology.
const corners = [
  [[16, 13], [100, 5], [201, 15], [297, 8], [389, 25]],
  [[7, 111], [105, 115], [190, 103], [304, 118], [395, 107]],
  [[12, 223], [95, 214], [207, 226], [295, 217], [388, 232]],
  [[24, 325], [108, 334], [196, 322], [309, 336], [380, 316]],
];
const shape = (x: number, y: number) => [corners[y]![x]!, corners[y]![x + 1]!, corners[y + 1]![x + 1]!, corners[y + 1]![x]!].map(p => p.join(',')).join(' ');
</script>

<template>
  <div class="realm-map" aria-label="十二州疆域，按地理相邻连接">
    <svg viewBox="0 0 404 345" aria-hidden="true" class="map-regions"><g v-for="p in run.provinces" :key="p.id" :class="[p.owner, { selected: run.plan.targetProvince === p.id }]"><polygon :points="shape(p.x, p.y)" /><path v-if="p.terrain === 'river'" :d="`M${p.x * 100 + 15},${p.y * 110 + 45} q20,25 40,0 t40,0`" class="river-line" /><path v-else-if="p.terrain === 'mountain'" :d="`M${p.x * 100 + 20},${p.y * 110 + 40} l15,-20 20,25 15,-15 15,15`" class="mountain-line" /></g></svg>
    <div class="province-labels"><button v-for="p in run.provinces" :key="p.id" type="button" class="province" :class="[p.owner, { selected: run.plan.targetProvince === p.id }]" :disabled="disabled" :aria-pressed="run.plan.targetProvince === p.id" :aria-label="`${p.name}，${owner(p.owner)}，${terrain[p.terrain]}`" @click="emit('select', p.id)"><strong>{{ p.name }}</strong><span>{{ p.owner === 'player' ? `发展 ${p.development}` : `驻军 ${Math.round(p.garrison)}万` }}</span><small>{{ p.owner === 'player' ? '本国' : kingdomAdjacent(run, p.id) ? '接壤' : '远境' }}</small></button></div>
    <span class="map-compass" aria-hidden="true">北 ↑</span>
  </div>
  <div class="legend"><span class="player">{{ run.name }}</span><span v-for="f in run.factions" :key="f.id" :class="f.id">{{ f.name }}</span></div>
  <p class="map-note">点击州郡筹划经营或出征。上下左右接壤，山地与水网易守难攻。</p>
</template>

<style scoped>
.realm-map { position: relative; aspect-ratio: 404 / 345; margin: 12px -6px 0; background: #ded4ad; border: 3px double #ae9869; box-shadow: 0 3px 9px #7a633524; }
.map-regions { position: absolute; inset: 0; width: 100%; height: 100%; }.map-regions polygon { stroke: #aa996e; stroke-width: 1.8; fill: #d5c59d; }.map-regions .player polygon { fill: #c6d0ac; }.map-regions .north polygon { fill: #bcc8bd; }.map-regions .east polygon { fill: #e0ca9e; }.map-regions .south polygon { fill: #d8b5a1; }.map-regions .selected polygon { stroke: #943e2b; stroke-width: 3; fill: #f0ddb0; }
.river-line { fill: none; stroke: #7b9f9c; stroke-width: 3; opacity: .55; }.mountain-line { fill: none; stroke: #7d8667; stroke-width: 2; opacity: .5; }
.province-labels { position: absolute; inset: 0; display: grid; grid-template-columns: repeat(4, 1fr); grid-template-rows: repeat(3, 1fr); }
.province { min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; padding: 10px 1px 0; color: #716247; font-size: 10px; }.province strong { font-family: var(--royal-serif); font-size: 16px; font-weight: 600; color: #54472e; text-shadow: 0 1px #f4e8c6; }.province small { font-size: 9px; }.province.selected strong { color: #943e2b; }.province.selected small { background: #933c2c; padding: 0 4px; color: #fce4b6; }.province:focus-visible { outline: 2px solid #943e2b; outline-offset: -4px; }
.map-compass { position: absolute; top: 3px; right: 5px; color: #837248; font-family: var(--royal-serif); font-size: 9px; pointer-events: none; }
.legend { display: flex; flex-wrap: wrap; gap: 7px 14px; margin-top: 15px; font-size: 11px; }.legend > span { display: flex; align-items: center; gap: 5px; }.legend > span::before { content: ''; width: 9px; height: 9px; background: #b4c195; border: 1px solid #a0a07b; }.legend .north::before { background: #a9bbb0; }.legend .east::before { background: #d9bf8b; }.legend .south::before { background: #c89a82; }.map-note { color: var(--ink-2); font-size: 11px; line-height: 1.7; margin: 10px 0; }
</style>
