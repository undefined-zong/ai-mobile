<script setup lang="ts">
import type { Community } from '@app/shared';
import { reactive } from 'vue';
import CommunityIcon from '@/components/community/CommunityIcon.vue';
import { useCommunityStore } from '@/stores/community';

/**
 * 改社群的介绍：名字、图标、主题色、简介、风气、标签、成员数。
 * "风气"每次发帖都会发给模型（聊什么、怎么说话、常见的帖子），想让这个社群换个味道就改它。
 */
const props = defineProps<{ community: Community }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const store = useCommunityStore();

const form = reactive({
  name: props.community.name,
  icon: props.community.icon,
  color: props.community.color,
  description: props.community.description,
  vibe: props.community.vibe,
  tags: props.community.tags.join('、'),
  memberCount: props.community.memberCount,
});
/** 取色器只认 #rrggbb；按名字算出来的颜色（hsl）没法放进去，先给它一个中性的起点 */
const pickerValue = () => (/^#[0-9a-f]{6}$/i.test(form.color) ? form.color : '#888888');

function save() {
  const name = form.name.trim();
  if (!name) return;
  store.patchCommunity(props.community.id, {
    name,
    icon: form.icon.trim(),
    color: form.color,
    description: form.description.trim(),
    vibe: form.vibe.trim(),
    tags: [...new Set(form.tags.split(/[,，、\s]+/).map((t) => t.trim()).filter(Boolean))],
    memberCount: Math.max(0, Math.round(Number(form.memberCount) || 0)),
  });
  emit('close');
}
</script>

<template>
  <div class="sheet" data-sheet="community-edit">
    <div class="flex items-center gap-2">
      <div class="sheet-title flex-1">社群的介绍</div>
      <van-button size="small" round @click="emit('close')">取消</van-button>
      <van-button size="small" round type="primary" :disabled="!form.name.trim()" @click="save">保存</van-button>
    </div>

    <div class="flex items-end gap-3 mt-3">
      <CommunityIcon :community="{ name: form.name, icon: form.icon, color: form.color }" :size="52" />
      <div class="flex-1 min-w-0">
        <label class="field-label !mt-0" for="ce-name">名字</label>
        <input id="ce-name" v-model="form.name" class="input" autocomplete="off" maxlength="30" />
      </div>
    </div>
    <div class="flex gap-3">
      <div class="flex-1 min-w-0">
        <label class="field-label" for="ce-icon">图标（一个 emoji）</label>
        <input id="ce-icon" v-model="form.icon" class="input" autocomplete="off" maxlength="8" />
      </div>
      <div>
        <label class="field-label" for="ce-color">主题色</label>
        <input id="ce-color" :value="pickerValue()" type="color" class="color" @input="form.color = ($event.target as HTMLInputElement).value" />
      </div>
      <div class="flex-1 min-w-0">
        <label class="field-label" for="ce-count">成员数</label>
        <input id="ce-count" v-model.number="form.memberCount" class="input num" type="number" min="0" inputmode="numeric" />
      </div>
    </div>
    <label class="field-label" for="ce-desc">简介</label>
    <textarea id="ce-desc" v-model="form.description" class="textarea" rows="2" />
    <label class="field-label" for="ce-vibe">风气（发帖时发给模型：聊什么、怎么说话、常见的帖子）</label>
    <textarea id="ce-vibe" v-model="form.vibe" class="textarea" rows="5" />
    <label class="field-label" for="ce-tags">标签（搜索用，用顿号或空格分开）</label>
    <input id="ce-tags" v-model="form.tags" class="input" autocomplete="off" />
  </div>
</template>

<style scoped>
.color {
  display: block;
  width: 52px;
  height: 40px;
  padding: 3px;
  border-radius: 12px;
  border: 1px solid var(--border);
  background: var(--panel);
}
</style>
