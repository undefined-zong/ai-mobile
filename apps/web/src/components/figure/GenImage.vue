<script setup lang="ts">
import type { Character, MessagePart } from '@app/shared';
import CgArt from './CgArt.vue';
import { useAssetSrc } from '@/composables/useAssetSrc';

/**
 * 配图：生成好的图从本机素材库按 key 取出来显示；还在画、画失败或者是演示数据时显示占位画。
 * key 也可能直接是链接（服务商只给了链接、浏览器取不回字节时）。
 * 别的设备画的、图还没传上云端时先显示占位画，传上来以后自己换成图（useAssetSrc）。
 */
const props = withDefaults(defineProps<{ part: Extract<MessagePart, { type: 'image' }>; character: Character; scene?: string; expression?: string }>(), {
  scene: 'library',
  expression: 'shy',
});

const { src: url } = useAssetSrc(() => ({ key: props.part.assetKey }));
</script>

<template>
  <img v-if="url" :src="url" :alt="part.caption" class="gen-img" />
  <div v-else class="relative">
    <CgArt :character="character" :scene="scene" :expression="expression" :pending="!part.generated && !part.error" class="rounded-[inherit]" />
    <div v-if="part.error" class="gen-error">
      <span class="i-lucide-image-off text-[20px]" />
      <span>没画出来</span>
    </div>
  </div>
</template>

<style scoped>
.gen-img {
  display: block;
  width: 100%;
  height: auto;
  border-radius: inherit;
  background: var(--panel);
}
.gen-error {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border-radius: inherit;
  background: rgba(0, 0, 0, 0.38);
  color: #fff;
  font-size: 13px;
}
</style>
