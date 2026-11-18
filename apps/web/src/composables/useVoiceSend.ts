import { isAbortError } from '@app/ai';
import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from 'vue';
import { services } from '@/services';
import { putAsset } from '@/services/assets';
import type { VoiceRecording } from '@/services/recorder';
import { useChatStore } from '@/stores/chat';
import { showErrorDialog } from '@/utils/errors';

/**
 * 按住说话发出去：先识别成字，存好录音，作为语音消息发进聊天，再让她回。
 * 换了聊天、离开页面时还没识别完的作废（不会发到别的聊天里）。
 */
export function useVoiceSend(chatId: MaybeRefOrGetter<string | null | undefined>) {
  const chatStore = useChatStore();
  const calls = new Set<AbortController>();
  /** 还在识别的有几条 */
  const recognizing = ref(0);
  function cancel() {
    for (const ctrl of calls) ctrl.abort();
    calls.clear();
    recognizing.value = 0;
  }
  watch(() => toValue(chatId), cancel, { flush: 'sync' });
  onBeforeUnmount(cancel);

  async function onVoice(recording: VoiceRecording) {
    const target = toValue(chatId);
    if (!target) return;
    const ctrl = new AbortController();
    calls.add(ctrl);
    recognizing.value = calls.size;
    const stale = () => ctrl.signal.aborted || toValue(chatId) !== target;
    try {
      const transcript = await services.stt.transcribe(recording.audio, { signal: ctrl.signal });
      if (stale()) return;
      const assetKey = await putAsset(new Uint8Array(await recording.audio.arrayBuffer()), recording.audio.type);
      if (stale()) return;
      chatStore.push(target, 'user', [{ type: 'voice', assetKey, durationMs: recording.durationMs, transcript }]);
      void chatStore.generate(target);
    } catch (e) {
      if (!ctrl.signal.aborted && !isAbortError(e)) showErrorDialog('语音识别失败', e);
    } finally {
      calls.delete(ctrl);
      recognizing.value = calls.size;
    }
  }
  return { recognizing, onVoice };
}
