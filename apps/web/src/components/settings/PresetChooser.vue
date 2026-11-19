<script setup lang="ts">
import { PRESET_CATEGORIES, PRESET_CATEGORY_ORDER, type Preset, type PresetCategory } from '@app/shared';
import { computed, ref } from 'vue';
import HScroll from '@/components/common/HScroll.vue';
import { useLibraryStore } from '@/stores/library';

/**
 * 从所有预设里挑一个（不分用途）：上面搜名字、按分类筛，点一行就选它。
 * 预设编辑页"复制到其他预设"、助手的"预设融合"选底子和功能来源共用。
 */
const props = defineProps<{
  /** 选着的（打勾） */
  modelValue?: string | null;
  /** 不列出来的（例如正在编辑的这个） */
  exclude?: string[];
  /** 打开时先筛的分类 */
  initialCategory?: PresetCategory;
  /** 每一行右边的小字（例如复制时说明"程序块会跳过"） */
  note?: (p: Preset) => string;
}>();
const emit = defineEmits<{ 'update:modelValue': [id: string] }>();
const lib = useLibraryStore();

const query = ref('');
const cat = ref<PresetCategory | 'all'>(props.initialCategory ?? 'all');
const pool = computed(() => lib.presets.filter((p) => !props.exclude?.includes(p.id)));
const cats = computed(() => PRESET_CATEGORY_ORDER.filter((c) => pool.value.some((p) => p.category === c)));
const list = computed(() => {
  const q = query.value.trim().toLowerCase();
  return pool.value
    .filter((p) => cat.value === 'all' || p.category === cat.value)
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q))
    .sort((a, b) => PRESET_CATEGORY_ORDER.indexOf(a.category) - PRESET_CATEGORY_ORDER.indexOf(b.category));
});
</script>

<template>
  <div class="grid gap-2 min-w-0" data-testid="preset-chooser">
    <input v-model="query" class="input" type="search" placeholder="搜预设的名字、说明" aria-label="搜预设" autocomplete="off" />
    <HScroll :active="cat" class="gap-1.5" role="tablist" aria-label="按分类筛">
      <button type="button" role="tab" class="chip" :class="{ on: cat === 'all' }" :aria-selected="cat === 'all'" @click="cat = 'all'">全部</button>
      <button v-for="c in cats" :key="c" type="button" role="tab" class="chip" :class="{ on: cat === c }" :aria-selected="cat === c" @click="cat = c">
        {{ PRESET_CATEGORIES[c].label }}
      </button>
    </HScroll>
    <div role="radiogroup" aria-label="预设" class="grid gap-1.5">
      <button
        v-for="p in list"
        :key="p.id"
        type="button"
        role="radio"
        class="row press"
        :class="{ on: p.id === modelValue }"
        :aria-checked="p.id === modelValue"
        :data-preset="p.id"
        @click="emit('update:modelValue', p.id)"
      >
        <span class="dot"><span v-if="p.id === modelValue" class="i-lucide-check" /></span>
        <span class="flex-1 min-w-0 text-left">
          <span class="block text-[14px] font-600 truncate">{{ p.name }}</span>
          <span class="block text-[11.5px] text-ink-3 truncate">
            {{ PRESET_CATEGORIES[p.category].label }} · {{ p.blocks.length }} 块{{ p.regex.length ? ` · 正则 ${p.regex.length}` : '' }}{{ p.seedFile ? ' · 自带' : '' }}
          </span>
          <span v-if="note?.(p)" class="block text-[11.5px] text-warn mt-0.5">{{ note(p) }}</span>
        </span>
      </button>
      <p v-if="!list.length" class="text-[13px] text-ink-3 text-center py-3 m-0">没有对得上的预设</p>
    </div>
  </div>
</template>

<style scoped>
.chip {
  height: 30px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
  white-space: nowrap;
  flex-shrink: 0;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 9px 12px;
  border-radius: 14px;
  background: var(--panel);
  border: 1px solid transparent;
}
.row.on {
  background: var(--accent-soft);
  border-color: var(--accent-line);
}
.dot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 99px;
  border: 1.5px solid var(--border);
  color: var(--on-accent);
  font-size: 13px;
}
.row.on .dot {
  background: var(--accent);
  border-color: var(--accent);
}
</style>
