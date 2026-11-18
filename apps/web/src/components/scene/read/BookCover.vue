<script setup lang="ts">
import { computed, ref } from 'vue';

/**
 * 书的封面：有封面图（微信读书的书）用图，没有或者图挂了按书名画一个——书名决定颜色，同一本书每次都一样，书多的时候一眼分得开。
 */
const props = defineProps<{ title: string; author?: string; cover?: string; badge?: string }>();

const broken = ref(false);
const showImage = computed(() => !!props.cover && !broken.value);
/** 书名 → 色相（0–359） */
const hue = computed(() => [...props.title].reduce((h, c) => (h * 31 + c.codePointAt(0)!) % 360, 7));
</script>

<template>
  <div class="cover" :style="{ '--hue': hue }">
    <img v-if="showImage" :src="cover" :alt="title" loading="lazy" referrerpolicy="no-referrer" @error="broken = true" />
    <div v-else class="drawn">
      <span class="spine" />
      <span class="t">{{ title }}</span>
      <span v-if="author" class="a">{{ author }}</span>
    </div>
    <span v-if="badge" class="badge">{{ badge }}</span>
  </div>
</template>

<style scoped>
.cover {
  position: relative;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  border-radius: 6px 10px 10px 6px;
  background: var(--panel);
  box-shadow:
    0 1px 2px rgb(0 0 0 / 0.12),
    0 6px 14px -6px rgb(0 0 0 / 0.28);
}
.cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.drawn {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14% 12% 10% 18%;
  background: linear-gradient(160deg, hsl(var(--hue) 42% 46%), hsl(calc(var(--hue) + 24) 46% 30%));
  color: hsl(var(--hue) 40% 96%);
}
.spine {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 8%;
  background: linear-gradient(90deg, rgb(0 0 0 / 0.22), rgb(255 255 255 / 0.08));
}
.t {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.35;
  word-break: break-all;
}
.a {
  margin-top: auto;
  font-size: 10.5px;
  opacity: 0.82;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  position: absolute;
  right: 4px;
  top: 4px;
  padding: 1px 6px;
  border-radius: 99px;
  background: rgb(0 0 0 / 0.5);
  color: #fff;
  font-size: 10px;
  line-height: 16px;
}
</style>
