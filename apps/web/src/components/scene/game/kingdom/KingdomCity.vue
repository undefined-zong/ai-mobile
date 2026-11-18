<script setup lang="ts">
import palace from '@/assets/kingdom/palace.webp';
defineProps<{ season: number; event: string; buffs: string[] }>();
defineEmits<{ enter: [place: string] }>();
const places = [
  { id: 'study', name: '御书房', desc: '修身 · 养成', x: 23, y: 25 },
  { id: 'palace', name: '后宫', desc: '相伴 · 子嗣', x: 79, y: 21 },
  { id: 'court', name: '太极殿', desc: '临朝 · 批奏', x: 51, y: 39 },
  { id: 'people', name: '内阁', desc: '群臣 · 任官', x: 22, y: 57 },
  { id: 'policy', name: '户部', desc: '国策 · 国势', x: 81, y: 58 },
  { id: 'map', name: '城门', desc: '疆域 · 征战', x: 51, y: 83 },
];
const seasons = ['春和景明', '夏木成荫', '秋高气清', '岁暮天寒'];
</script>

<template>
  <main class="palace-city" aria-label="宫城，点击宫殿处理事务">
    <img :src="palace" class="city-art" alt="金瓦朱墙的宫城，殿宇、庭园与御道相连" fetchpriority="high" />
    <div class="city-vignette" />
    <div class="city-caption"><span>宫 城</span><small>{{ seasons[season] }}</small></div>
    <button v-for="p in places" :key="p.id" type="button" class="place" :class="{ audience: p.id === 'court' }" :style="{ left: `${p.x}%`, top: `${p.y}%` }" :aria-label="`${p.name}：${p.desc}`" @click="$emit('enter', p.id)">
      <span class="place-name">{{ p.name }}<i v-if="p.id === 'court'" aria-label="本季有奏折">奏</i></span>
      <small>{{ p.desc }}</small>
    </button>
    <button type="button" class="court-message" @click="$emit('enter', 'court')"><span>奏</span><div><small>本季待议</small><strong>{{ event }}</strong></div><span class="i-lucide-chevron-right" /></button>
    <div v-if="buffs.length" class="city-buffs"><button v-for="b in buffs.slice(0, 2)" :key="b" type="button" @click="$emit('enter', 'policy')"><span class="i-lucide-sparkles" />{{ b }}</button></div>
  </main>
</template>

<style scoped>
.palace-city { position: relative; flex: 1; min-height: 300px; isolation: isolate; overflow: hidden; background: #827c5d; }
.city-art, .city-vignette { position: absolute; inset: 0; width: 100%; height: 100%; }
.city-art { object-fit: fill; }
.city-vignette { pointer-events: none; box-shadow: inset 0 8px 18px #2b281b45, inset 0 -20px 25px #201e1680; }
.city-caption { position: absolute; top: 15px; left: 15px; display: flex; flex-direction: column; color: #fff3d5; text-shadow: 0 1px 5px #1e302a; font-family: var(--royal-serif); }
.city-caption > span { font-size: 21px; letter-spacing: 6px; }
.city-caption small { font-size: 10px; letter-spacing: 2px; margin-top: 2px; }
.place { position: absolute; transform: translate(-50%, -50%); min-width: 82px; min-height: 61px; padding: 4px; text-align: center; color: #fff0c8; transition: transform .18s ease; }
.place:hover { transform: translate(-50%, -53%); }
.place:active { transform: translate(-50%, -48%); }
.place-name { position: relative; display: block; min-width: 78px; padding: 4px 10px 5px; background: linear-gradient(#493c29, #252e29); border: 1px solid #d6b36a; outline: 2px solid #302c20d9; box-shadow: 0 4px 8px #19291d66, inset 0 0 0 2px #544c32; font-family: var(--royal-serif); font-size: 17px; font-weight: 700; letter-spacing: 3px; text-indent: 3px; white-space: nowrap; }
.place-name::before, .place-name::after { content: ''; position: absolute; top: 10px; width: 3px; height: 10px; background: #d6b36a; }
.place-name::before { left: -4px; }.place-name::after { right: -4px; }
.place small { display: inline-block; padding: 2px 7px; background: #2f3025d9; color: #f9e4b6; font-size: 10px; letter-spacing: 1px; }
.place.audience .place-name { background: linear-gradient(#99463a, #6c2822); outline-color: #602d21; }
.place i { position: absolute; top: -11px; right: -9px; display: grid; place-items: center; width: 22px; height: 22px; border: 1px solid #f1d297; border-radius: 50%; font-family: var(--royal-serif); font-style: normal; background: #a64230; color: #fff1ce; font-size: 11px; letter-spacing: 0; text-indent: 0; }
.court-message { position: absolute; bottom: 14px; left: 12px; display: flex; align-items: center; gap: 9px; min-height: 48px; padding: 6px 10px 6px 7px; background: #f8edcfef; color: #4a3828; border: 1px solid #bfa572; box-shadow: 0 3px 10px #1b291a40; text-align: left; }
.court-message > span:first-child { border: 1px solid #a74634; padding: 3px; color: #9b392d; font-family: var(--royal-serif); font-size: 19px; }
.court-message div { display: flex; flex-direction: column; gap: 1px; }
.court-message small { font-size: 9px; letter-spacing: 2px; color: #78654c; }.court-message strong { font-family: var(--royal-serif); font-size: 13px; }
.city-buffs { position: absolute; bottom: 15px; right: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; max-width: 43%; }
.city-buffs button { display: flex; align-items: center; gap: 4px; background: #293e30e6; color: #f4dfad; padding: 3px 6px; font-size: 10px; border: 1px solid #bca46d; }
@media (prefers-reduced-motion: reduce) { .place { transition: none; } }
</style>
