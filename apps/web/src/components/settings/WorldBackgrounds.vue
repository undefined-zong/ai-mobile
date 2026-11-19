<script setup lang="ts">
import { previewImages } from '@/services/imageViewer';
import type { Character, MapLocation } from '@app/shared';

import { computed, ref, watch } from 'vue';
import {
  BACKGROUND_GROUPS, BACKGROUND_PERIOD_LABEL, BACKGROUND_SETS, backgroundFamilies, backgroundUrl, familyCover, type BackgroundFamily,
} from '@/backgrounds/library';
import { useRhythmStore } from '@/stores/rhythm';

/** 角色卡编辑 → 背景：给她小世界里的每个地点挑一套背景系列（白天/黄昏/夜间仍自动切换） */
const props = defineProps<{ character: Character }>();
const rhythm = useRhythmStore();

const world = computed(() => rhythm.editableWorld(props.character.id));
/** 和 StageView 一样：世界名、简介、角色设定参与风格匹配 */
const context = computed(() => [world.value?.name, world.value?.blurb, props.character.card.scenario, props.character.card.description].filter(Boolean).join('\n'));

function ranked(loc: MapLocation, backgroundSet: string | undefined): BackgroundFamily[] {
  return backgroundFamilies({ ...loc, backgroundSet, kind: loc.backdrop, context: context.value });
}
const periods = (f: BackgroundFamily) => [...new Set(f.assets.map((a) => a.period))].map((p) => BACKGROUND_PERIOD_LABEL[p]).join(' / ');

const rows = computed(() => (world.value?.locations ?? []).map((loc) => {
  const fixed = rhythm.backgroundSetOf(props.character.id, loc.id);
  const used = ranked(loc, fixed)[0]!;
  return { loc, fixed, used };
}));

// —— 选择面板 ——
const editing = ref<MapLocation | null>(null);
const open = computed({ get: () => !!editing.value, set: (v) => { if (!v) editing.value = null; } });
const current = computed(() => editing.value && rhythm.backgroundSetOf(props.character.id, editing.value.id));
const auto = computed(() => editing.value ? ranked(editing.value, undefined) : []);
/** 和这个地点用途相同的系列（自动匹配的候选，按匹配度排） */
const suggested = computed(() => auto.value.slice(0, 12));
const query = ref('');
const group = ref('');
const visibleCount = ref(24);
const others = computed(() => {
  const near = new Set(suggested.value);
  const words = query.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return BACKGROUND_SETS.filter((f) => !near.has(f)
    && (!group.value || f.assets.some((a) => a.group === group.value))
    && words.every((w) => `${f.scene} ${f.style} ${f.set} ${f.id}`.toLowerCase().includes(w)));
});
watch([query, group, editing], () => { visibleCount.value = 24; });

function edit(loc: MapLocation) {
  query.value = '';
  group.value = '';
  editing.value = loc;
}
function choose(setId: string | null) {
  if (!editing.value) return;
  rhythm.setBackground(props.character.id, editing.value.id, setId);
  editing.value = null;
}
function preview(f: BackgroundFamily) {
  previewImages(f.assets.map(backgroundUrl));
}
const isOn = (f: BackgroundFamily) => !!current.value && (f.id === current.value || f.set === current.value);
</script>

<template>
  <div class="px-4 pb-6" data-testid="world-backgrounds">
    <template v-if="world">
      <p class="intro">{{ world.name }}：给每个地点挑一套背景。不选就按地点名、描述和世界观自动匹配；日间、黄昏、夜间始终按时间切换。</p>
      <button
        v-for="r in rows" :key="r.loc.id" type="button" class="loc-row press" :data-testid="`bg-loc-${r.loc.id}`"
        @click="edit(r.loc)"
      >
        <img class="thumb" :src="backgroundUrl(familyCover(r.used))" alt="" loading="lazy" decoding="async" />
        <span class="flex-1 min-w-0">
          <span class="block text-[14px] truncate"><span :class="r.loc.icon" class="text-accent-ink mr-1" />{{ r.loc.name }}</span>
          <span class="block text-[12px] text-ink-3 truncate">{{ r.fixed ? '固定' : '自动' }} · {{ r.used.scene }} · {{ r.used.style }}</span>
          <span v-if="r.loc.area === 'home'" class="block text-[11.5px] text-ink-3 truncate">只换主房间；书房、厨房等仍按房间自动选</span>
        </span>
        <span class="i-lucide-chevron-right text-ink-3" />
      </button>
    </template>
    <div v-else class="empty">
      <p>{{ character.name }}还没有小世界，建好之后就能给每个地点换背景。</p>
      <RouterLink :to="`/me/rhythm?char=${character.id}`" class="link press">去节律建世界 <span class="i-lucide-chevron-right" /></RouterLink>
    </div>

    <van-popup v-model:show="open" round position="bottom" closeable :style="{ height: '82%' }" teleport="body">
      <div v-if="editing" class="sheet">
        <h3 class="sheet-title">{{ editing.name }} 的背景</h3>
        <div class="sheet-scroll">
          <button type="button" class="auto-row press" :class="{ on: !current }" data-testid="bg-auto" @click="choose(null)">
            <img v-if="auto[0]" class="thumb" :src="backgroundUrl(familyCover(auto[0]))" alt="" loading="lazy" decoding="async" />
            <span class="flex-1 min-w-0 text-left">
              <span class="block text-[14px]">自动匹配</span>
              <span v-if="auto[0]" class="block text-[12px] text-ink-3 truncate">现在会用：{{ auto[0].scene }} · {{ auto[0].style }}</span>
            </span>
            <span v-if="!current" class="i-lucide-check text-accent-ink" />
          </button>

          <h4>适合这里</h4>
          <div class="grid">
            <div v-for="f in suggested" :key="f.id" class="opt" :class="{ on: isOn(f) }">
              <button type="button" class="opt-pick press" :aria-label="`用 ${f.scene} ${f.style}`" @click="choose(f.id)">
                <img :src="backgroundUrl(familyCover(f))" alt="" loading="lazy" decoding="async" />
                <span class="opt-name">{{ f.scene }} · {{ f.style }}</span>
                <span class="opt-meta">{{ periods(f) }}</span>
              </button>
              <button type="button" class="opt-zoom" :aria-label="`看 ${f.style} 的全部图`" @click="preview(f)"><span class="i-lucide-expand" /></button>
            </div>
          </div>

          <h4>全部系列</h4>
          <div class="filters">
            <input v-model="query" type="search" class="search" placeholder="搜索场景、风格" aria-label="搜索场景、风格" />
            <select v-model="group" aria-label="场景分类"><option value="">全部分类</option><option v-for="g in BACKGROUND_GROUPS" :key="g" :value="g">{{ g }}</option></select>
          </div>
          <div class="grid">
            <div v-for="f in others.slice(0, visibleCount)" :key="f.id" class="opt" :class="{ on: isOn(f) }">
              <button type="button" class="opt-pick press" :aria-label="`用 ${f.scene} ${f.style}`" @click="choose(f.id)">
                <img :src="backgroundUrl(familyCover(f))" alt="" loading="lazy" decoding="async" />
                <span class="opt-name">{{ f.scene }} · {{ f.style }}</span>
                <span class="opt-meta">{{ periods(f) }}</span>
              </button>
              <button type="button" class="opt-zoom" :aria-label="`看 ${f.style} 的全部图`" @click="preview(f)"><span class="i-lucide-expand" /></button>
            </div>
          </div>
          <p v-if="!others.length" class="empty">没有找到，换个词试试。</p>
          <button v-if="visibleCount < others.length" type="button" class="more press" @click="visibleCount += 24">再看 24 个</button>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.intro { color: var(--ink-2); font-size: 12.5px; line-height: 1.6; margin: 12px 0; }
.loc-row, .auto-row { display: flex; align-items: center; gap: 12px; width: 100%; padding: 10px; margin-bottom: 8px; border-radius: 12px; background: var(--panel); text-align: left; }
.auto-row { border: 1.5px solid transparent; }
.auto-row.on { border-color: var(--accent); }
.thumb { width: 72px; height: 48px; flex: none; object-fit: cover; border-radius: 8px; background: var(--surface); }
.empty { padding: 24px 8px; text-align: center; color: var(--ink-2); font-size: 13.5px; line-height: 1.6; }
.link { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; color: var(--accent-ink); }
.sheet { display: flex; flex-direction: column; height: 100%; }
.sheet-title { font-size: 16px; font-weight: 600; padding: 16px 48px 10px 16px; }
.sheet-scroll { flex: 1; overflow-y: auto; padding: 0 16px calc(20px + var(--safe-bottom, 0px)); }
h4 { font-size: 13px; color: var(--ink-2); margin: 16px 0 8px; }
.grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.opt { position: relative; min-width: 0; border-radius: 10px; border: 1.5px solid transparent; }
.opt.on { border-color: var(--accent); }
.opt-pick { display: flex; flex-direction: column; width: 100%; text-align: left; }
.opt-pick img { width: 100%; aspect-ratio: 3 / 2; object-fit: cover; border-radius: 8px; background: var(--surface); }
.opt-name { font-size: 12.5px; color: var(--ink); margin: 5px 4px 0; line-height: 1.4; }
.opt-meta { font-size: 11.5px; color: var(--ink-3); margin: 2px 4px 4px; }
.opt-zoom { position: absolute; top: 6px; right: 6px; width: 28px; height: 28px; display: grid; place-items: center; border-radius: 50%; color: #fff; background: rgb(0 0 0 / 0.45); }
.filters { display: flex; gap: 8px; margin-bottom: 10px; }
.search { flex: 1; min-width: 0; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--ink); font-size: 16px; }
.filters select { padding: 6px 8px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); color: var(--ink); font-size: 16px; }
.more { width: 100%; min-height: 40px; margin-top: 16px; border: 1px solid var(--border); border-radius: 12px; color: var(--accent-ink); background: var(--surface); }
</style>
