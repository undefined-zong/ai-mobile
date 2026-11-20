<script setup lang="ts">
import { characterPronoun, type Character } from '@app/shared';
import { nextTick, ref, watch } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import { splitActions } from '@/utils/messagePreview';

/**
 * 视觉小说式对话框：名字、正文（流式时带光标）、选项、工具条、回复输入。
 * 正文最高 maxHeight，长了在框里滚动，工具条和回复框不被顶出屏幕；流式时跟着新写出来的字往下滚（往上翻了就不跟），换成另一条时回到开头。
 */
const props = withDefaults(
  defineProps<{
    name: string;
    character?: Character;
    text: string;
    streaming?: boolean;
    thinking?: boolean;
    choices?: string[];
    voiceOn?: boolean;
    autoOn?: boolean;
    showTools?: boolean;
    /** 回复失败时的完整报错 */
    error?: string;
    /** 正文最高多高（CSS 长度），超出在框里滚动 */
    maxHeight?: string;
  }>(),
  { streaming: false, thinking: false, choices: () => [], voiceOn: false, autoOn: false, showTools: true, error: '', maxHeight: '30dvh' },
);
const emit = defineEmits<{
  (e: 'reply', text: string): void;
  (e: 'choose', text: string): void;
  (e: 'log'): void;
  (e: 'toggle-voice'): void;
  (e: 'toggle-auto'): void;
}>();

const line = ref<HTMLElement | null>(null);
/** 正文在最底下（或者放得下不用滚）：流式写出来的字跟着往下滚 */
let follow = true;
function atBottom(el: HTMLElement) {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= parseFloat(getComputedStyle(el).lineHeight);
}
function onLineScroll() {
  if (line.value) follow = atBottom(line.value);
}
watch(
  () => props.text,
  (now, before) => {
    const el = line.value;
    if (!el) return;
    // 不是同一条接着写（新的回复、换成上一条）：回到开头，从头读
    if (!now.startsWith(before) && !before.startsWith(now)) {
      el.scrollTop = 0;
      follow = true;
    } else if (props.streaming && follow) {
      el.scrollTop = el.scrollHeight;
    }
  },
  { flush: 'post' },
);

const replying = ref(false);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);

async function openReply() {
  replying.value = true;
  await nextTick();
  input.value?.focus();
}

function submit() {
  const t = draft.value.trim();
  if (!t) return;
  emit('reply', t);
  draft.value = '';
  replying.value = false;
}
</script>

<template>
  <div class="dialog">
    <div v-if="props.choices.length && !streaming" class="choices">
      <button v-for="c in props.choices" :key="c" class="choice press" @click="emit('choose', c)">{{ c }}</button>
    </div>
    <div class="box">
      <div class="name">
        <span class="i-lucide-heart text-[12px]" />{{ name }}
        <span v-if="thinking" class="ml-1 inline-flex gap-1 text-accent-ink">
          <span class="typing-dot !w-1 !h-1" /><span class="typing-dot !w-1 !h-1" /><span class="typing-dot !w-1 !h-1" />
        </span>
      </div>
      <p ref="line" class="line" :class="{ 'stream-caret': streaming && !thinking }" :style="{ maxHeight }" @scroll.passive="onLineScroll">
        <template v-for="(s, i) in splitActions(text)" :key="i">
          <span :class="{ action: s.action }">{{ s.text }}</span>
        </template>
      </p>
      <ErrorDetails v-if="error" :detail="error" title="回复失败（切到聊天模式可以重新生成）" max-height="160px" />
      <div v-if="replying" class="reply">
        <input
          ref="input"
          v-model="draft"
          class="reply-input"
          :placeholder="`回${characterPronoun(character)}一句…`"
          enterkeyhint="send"
          aria-label="回复"
          @keydown.enter.prevent="submit"
        />
        <button class="reply-send" aria-label="发送" @click="submit"><span class="i-lucide-send-horizontal" /></button>
      </div>
      <div v-else-if="showTools" class="tools">
        <button class="tool" aria-label="记录" @click="emit('log')"><span class="i-lucide-scroll-text" /><span class="tool-label">记录</span></button>
        <button class="tool" :class="{ on: autoOn }" aria-label="自动" @click="emit('toggle-auto')"><span class="i-lucide-fast-forward" /><span class="tool-label">自动</span></button>
        <button class="tool" :class="{ on: voiceOn }" aria-label="语音" @click="emit('toggle-voice')"><span class="i-lucide-volume-2" /><span class="tool-label">语音</span></button>
        <button class="tool primary" @click="openReply">回复<span class="i-lucide-chevron-right" /></button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dialog {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 10;
  padding: 0 12px calc(var(--safe-bottom) + 12px);
}
.box {
  padding: 14px 16px 10px;
  border-radius: 24px;
  background: var(--glass-strong);
  border: 1px solid var(--glass-line);
  backdrop-filter: blur(22px);
  -webkit-backdrop-filter: blur(22px);
  box-shadow: var(--shadow);
}
.name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 6px;
  color: var(--accent-ink);
  font-weight: 600;
  font-size: 14px;
}
.line {
  margin: 0;
  min-height: 3.2em;
  font-size: 16px;
  line-height: 1.65;
  letter-spacing: 0.02em;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.action {
  opacity: 0.6;
  font-style: italic;
}
.tools {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--glass-line);
}
.tool {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 10px;
  border-radius: 99px;
  font-size: 13px;
  color: var(--ink-2);
  white-space: nowrap;
}
@media (max-width: 360px) {
  .tool-label {
    display: none;
  }
}
.tool.on {
  color: var(--accent-ink);
  background: var(--accent-soft);
}
.tool.primary {
  margin-left: auto;
  background: var(--accent);
  color: var(--on-accent);
  font-weight: 600;
}
.choices {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 10px;
}
.choice {
  padding: 11px 14px;
  border-radius: 16px;
  background: var(--glass-strong);
  border: 1px solid var(--accent-line);
  color: var(--ink);
  font-size: 15px;
  text-align: center;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.reply {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}
.reply-input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 14px;
  border-radius: 20px;
  border: 1px solid var(--accent-line);
  background: var(--panel);
  outline: none;
}
.reply-send {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
</style>
