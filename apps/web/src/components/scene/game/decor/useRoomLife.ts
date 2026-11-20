import { textFn } from '@app/shared';
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch, type ShallowRef } from 'vue';
import { useAiStore } from '@/stores/ai';
import { useChatStore } from '@/stores/chat';
import { textsFor, useLibraryStore } from '@/stores/library';
import type { DecorEngine } from './engine';
import { parseLifeDecision, type LifeDecision } from './activities';

interface LifeOptions {
  engine: ShallowRef<DecorEngine | null>;
  roomId(): string;
  characterId(): string;
  chatId(): string;
  active(): boolean;
  blocked(): boolean;
  context(): string;
  reply(decision: LifeDecision): void;
  result(text: string): void;
}

function preference(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

export function useRoomLife(options: LifeOptions) {
  const ai = useAiStore();
  const chat = useChatStore();
  const lib = useLibraryStore();
  const enabled = ref(preference('ai-mobile:decor-life') !== 'off');
  const savedInterval = Number(preference('ai-mobile:decor-life-interval'));
  const interval = ref([20, 40, 90].includes(savedInterval) ? savedInterval : 40);
  const visible = ref(!document.hidden);
  const mounted = ref(true);
  const requesting = ref(false);
  const acting = ref(false);
  const error = ref('');
  const lastResult = ref('');
  const connected = computed(() => ai.status('decor').live);
  const preset = computed(() => lib.presetForUse('decor-life'));
  /** 小屋生活预设的程序文字：这一次的输入、上次的结果、动作说明（decorLife.*） */
  const lt = () => textFn(textsFor(preset.value));
  const available = computed(() => mounted.value && visible.value && options.active() && !options.blocked() && connected.value && !!preset.value && !!options.engine.value);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | null = null;
  let sequence = 0;

  function cancel() {
    clearTimeout(timer); timer = undefined;
    sequence++;
    controller?.abort(); controller = null;
    requesting.value = false; acting.value = false;
  }
  function schedule(delay = interval.value * 1000, userText?: string) {
    clearTimeout(timer);
    if (!available.value || (!enabled.value && !userText) || error.value) return;
    timer = setTimeout(() => void request(userText), delay);
  }
  async function request(userText?: string) {
    cancel();
    error.value = '';
    if (!available.value) {
      const status = ai.status('decor');
      if (!status.live) error.value = `小屋 API 待连接：${status.reason}`;
      else if (!preset.value) error.value = '先选择「小屋 · 角色生活」预设';
      return;
    }
    const e = options.engine.value!;
    const roomId = options.roomId();
    const version = e.observationVersion;
    const run = sequence;
    const abort = new AbortController();
    controller = abort;
    // 页面离开会取消；超时也终止同一次请求，避免一直占用角色。
    const timeout = setTimeout(() => { if (run === sequence) { error.value = '小屋 API 响应超时，点重试再来一次'; cancel(); } }, 60000);
    let retryText: string | undefined;
    let stale = false;
    requesting.value = true;
    try {
      const response = await chat.sceneJson(options.chatId(), {
        name: 'decor-act',
        input: lt()('decorLife.input', { context: options.context(), observe: JSON.stringify(e.observe()), last: lastResult.value || lt()('decorLife.last.entered'), said: userText, protocol: lt()('decorLife.protocol') }),
      }, parseLifeDecision, abort.signal, { agent: 'decor', use: 'decor-life' });
      clearTimeout(timeout);
      if (run !== sequence || abort.signal.aborted || roomId !== options.roomId()) return;
      if (!response.ok) { error.value = response.reason; return; }
      // 用户在模型思考时换了姿态，重新观察后再决定，旧答案不落地。
      if (e.observationVersion !== version) { stale = true; retryText = userText; return; }
      requesting.value = false;
      acting.value = true;
      options.reply(response.value);
      const result = await e.performAction('her', response.value.action, abort.signal);
      if (run !== sequence || result.cancelled) return;
      lastResult.value = result.ok ? lt()('decorLife.last.done', { action: response.value.action.type, target: response.value.action.target }) : lt()('decorLife.last.failed', { reason: result.reason });
      options.result(lastResult.value);
      if (!result.ok) error.value = result.reason ?? '没有走到家具旁';
    } finally {
      clearTimeout(timeout);
      if (run === sequence) {
        controller = null; requesting.value = false; acting.value = false;
        schedule(stale ? 1600 : interval.value * 1000, retryText);
      }
    }
  }

  watch([available, enabled], ([, on], [, wasOn]) => { cancel(); if (on && !wasOn) error.value = ''; schedule(4500); });
  watch([() => options.roomId(), () => options.characterId(), connected, preset], () => { cancel(); error.value = ''; lastResult.value = lt()('decorLife.last.changed'); schedule(4500); });
  watch(enabled, value => { try { localStorage.setItem('ai-mobile:decor-life', value ? 'on' : 'off'); } catch { /* 本次仍然生效 */ } });
  watch(interval, value => { try { localStorage.setItem('ai-mobile:decor-life-interval', String(value)); } catch { /* 本次仍然生效 */ } if (!requesting.value && !acting.value) schedule(); });
  const visibility = () => { visible.value = !document.hidden; };
  onMounted(() => { document.addEventListener('visibilitychange', visibility); schedule(4500); });
  onActivated(() => { mounted.value = true; visibility(); });
  onDeactivated(() => { mounted.value = false; cancel(); });
  onBeforeUnmount(() => { mounted.value = false; cancel(); document.removeEventListener('visibilitychange', visibility); });
  return { enabled, interval, connected, preset, requesting, acting, error, request, cancel };
}
