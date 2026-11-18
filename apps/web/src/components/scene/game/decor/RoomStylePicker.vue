<script setup lang="ts">
import { computed, ref } from 'vue';
import { roomType } from './model';
import { HOME_ROOM_TYPES, ROOM_STYLES, stylePreview, type HomeRoomType, type RoomStyle } from './styles';
const props = defineProps<{ current?: string }>();
const emit = defineEmits<{ apply: [style: RoomStyle] }>();
const choice = ref(props.current ?? ROOM_STYLES[0]!.id);
const previewRoom = ref<HomeRoomType>('living');
const selected = computed(() => ROOM_STYLES.find((s) => s.id === choice.value) ?? ROOM_STYLES[0]!);
const scheme = computed(() => selected.value.rooms[previewRoom.value]);
</script>

<template>
  <section class="style-picker" aria-label="整套小屋软装预设">
    <div class="style-heading"><h2>给整套小屋换个风格</h2><span>每套 6 个房间</span></div>
    <div class="style-choices" aria-label="选择整套软装风格">
      <button v-for="style in ROOM_STYLES" :key="style.id" type="button" :aria-pressed="selected.id === style.id" @click="choice = style.id"><img :src="stylePreview(style.id)" alt="" width="80" height="60" /><span>{{ style.name }}</span></button>
    </div>
    <div class="style-preview">
      <img :src="stylePreview(selected.id, previewRoom)" :alt="`${selected.name} · ${roomType(previewRoom).name} · ${scheme.title}的 3D 布局`" width="800" height="600" />
      <div class="style-caption"><h3>{{ scheme.title }}<span>{{ roomType(previewRoom).name }}</span></h3><p>{{ scheme.desc }}</p></div>
    </div>
    <div class="style-rooms" aria-label="预览六个房间">
      <button v-for="type in HOME_ROOM_TYPES" :key="type" type="button" :aria-pressed="previewRoom === type" @click="previewRoom = type"><img :src="stylePreview(selected.id, type)" alt="" width="120" height="90" /><span>{{ roomType(type).name }}</span><small>{{ selected.rooms[type].title }}</small></button>
    </div>
    <p class="style-includes">{{ selected.desc }}<span>六间均有收音机，所有家具也可在家具库单独添加。</span></p>
    <button type="button" class="apply-style" @click="emit('apply', selected)"><span class="i-lucide-house" aria-hidden="true" />套用整套六房间<span class="i-lucide-arrow-right" aria-hidden="true" /></button>
    <p class="style-note">{{ current === selected.id ? '当前小屋已采用此风格。' : '' }}替换整套小屋的房间布局、家具、墙面和地板，可整体撤销。每件家具仍能挪动、换色。</p>
  </section>
</template>

<style scoped>
.style-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 4px 0 12px; }
.style-heading h2 { font-size: 18px; font-weight: 650; letter-spacing: -.02em; }
.style-heading > span { font-size: 11px; color: var(--ink-2); white-space: nowrap; }
.style-preview { background: var(--panel); border-radius: 14px; overflow: hidden; }
.style-preview > img { width: 100%; height: auto; max-height: 210px; object-fit: contain; display: block; background: #eee9e0; }
.style-caption { padding: 10px 12px 12px; }
.style-caption h3 { display: flex; gap: 8px; align-items: baseline; font-size: 15px; font-weight: 600; margin: 0 0 4px; }
.style-caption h3 > span { color: var(--ink-2); font-size: 11px; font-weight: 400; }
.style-caption p { font-size: 12px; color: var(--ink-2); margin: 0; line-height: 1.6; }
.style-choices { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 5px; margin: 0 0 12px; }
.style-choices button { min-width: 0; text-align: center; border-radius: 8px; padding: 3px 3px 6px; border: 1px solid transparent; color: var(--ink-2); font-size: 11px; line-height: 1.5; }
.style-choices button[aria-pressed='true'] { border-color: var(--accent-ink); color: var(--accent-ink); background: var(--panel); font-weight: 600; }
.style-choices img { display: block; width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 5px; margin-bottom: 5px; }
.style-rooms { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.style-rooms button { min-width: 0; text-align: left; padding: 3px 3px 6px; border: 1px solid transparent; border-radius: 8px; color: var(--ink-2); }
.style-rooms button[aria-pressed='true'] { border-color: var(--accent-ink); background: var(--panel); color: var(--accent-ink); }
.style-rooms img { width: 100%; height: auto; aspect-ratio: 4 / 3; object-fit: cover; border-radius: 5px; display: block; margin-bottom: 4px; }
.style-rooms span { display: block; font-size: 12px; padding: 0 3px; }
.style-rooms small { display: block; font-size: 10px; line-height: 1.5; padding: 0 3px; margin-top: 2px; }
.style-includes { font-size: 12px; color: var(--ink-2); line-height: 1.7; margin: 12px 0; }
.style-includes > span { display: block; font-size: 11px; margin-top: 4px; }
.apply-style { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 46px; padding: 10px; border-radius: 11px; font-size: 14px; font-weight: 600; background: var(--accent); color: var(--on-accent); }
.style-note { font-size: 11px; color: var(--ink-2); line-height: 1.7; margin: 10px 0 24px; }
button:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 3px; }
@media (max-width: 360px) { .style-heading h2 { font-size: 16px; } .style-preview > img { max-height: 180px; } }
</style>
