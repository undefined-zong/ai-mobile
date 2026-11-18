<script setup lang="ts">
import { onMounted, ref } from 'vue';
defineProps<{ title: string; caption?: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog ref="dialog" class="royal-dialog" :aria-label="title" @cancel.prevent="emit('close')" @click="($event.target === $event.currentTarget) && emit('close')">
    <section class="scroll-frame">
      <header><div><small v-if="caption">{{ caption }}</small><h2>{{ title }}</h2></div><button type="button" aria-label="返回宫城" autofocus @click="emit('close')"><span class="i-lucide-x" /></button></header>
      <div class="scroll-body"><slot /></div>
      <footer v-if="$slots.footer"><slot name="footer" /></footer>
    </section>
  </dialog>
</template>

<style scoped>
.royal-dialog { width: min(calc(100% - 24px), 456px); max-width: none; max-height: none; padding: 0; border: 0; background: transparent; overflow: visible; color: var(--ink); }
.royal-dialog::backdrop { background: #131b18a3; backdrop-filter: blur(2px); }
.scroll-frame { display: flex; flex-direction: column; max-height: calc(100dvh - 74px - var(--safe-top, 0px) - var(--safe-bottom, 0px)); background: var(--paper); background-image: linear-gradient(90deg, #9479411c, transparent 6%, transparent 94%, #9479411c); border: 1px solid #b59456; box-shadow: 0 0 0 4px #352e21, 0 0 0 5px #a58b52, 0 20px 70px #111a17a6; }
header { flex: none; display: flex; justify-content: space-between; align-items: center; padding: 13px 18px; background: #e4d6b6; border-bottom: 1px solid #c1ac82; }
header small { display: block; font-size: 9px; color: #806747; letter-spacing: 3px; margin-bottom: 3px; }
header h2 { font-family: var(--royal-serif); font-size: 22px; font-weight: 600; letter-spacing: 4px; margin: 0; color: #493725; }
header button { display: grid; place-items: center; flex-shrink: 0; width: 36px; height: 36px; border: 1px solid #b49a6d; background: #eadfc7; color: #775a37; font-size: 19px; }
.scroll-body { min-height: 0; overflow: auto; overscroll-behavior: contain; padding: 18px; scrollbar-width: thin; }
footer { flex: none; padding: 12px 18px; border-top: 1px solid #ccb990; }
@media (max-width: 350px) { .scroll-body { padding: 14px; } }
</style>
