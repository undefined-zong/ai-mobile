<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import BookReader from '@/components/scene/read/BookReader.vue';
import BookShelf from '@/components/scene/read/BookShelf.vue';

/**
 * 一起看书（设计文档 §9.10）：书架页（/scene/read）→ 点一本书 → 阅读页（/scene/read?book=书的 id）。
 * 两页在同一个场景里（ScenePage），从书架翻开一本书不算离开；阅读页左上角、系统返回键都回到书架。
 */
const route = useRoute();
const router = useRouter();
const bookId = computed(() => (typeof route.query.book === 'string' ? route.query.book : ''));

function openBook(id: string) {
  void router.push({ query: { ...route.query, book: id } });
}
/** 回书架：从书架点进来的就退一步（系统返回键也是这样），直接打开某本书的换成书架 */
function backToShelf() {
  const back: unknown = window.history.state?.back;
  const fromShelf = typeof back === 'string' && back.split('?')[0] === route.path && !/[?&]book=/.test(back);
  if (import.meta.env.MODE !== 'preview' && fromShelf) router.back();
  else {
    const { book: _book, ...rest } = route.query;
    void router.replace({ query: rest });
  }
}
</script>

<template>
  <BookReader v-if="bookId" :key="bookId" :book-id="bookId" @back="backToShelf" />
  <BookShelf v-else @open="openBook" />
</template>
