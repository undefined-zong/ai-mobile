<script setup lang="ts">
import type { Character, MessagePart } from '@app/shared';
import { showToast } from 'vant';
import { computed } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import GenImage from '@/components/figure/GenImage.vue';
import { saveFiles } from '@/services/download';
import { useAlbumStore } from '@/stores/album';
import { useChatStore } from '@/stores/chat';

/** 完整对话和聚焦首页共用：查看、重画、收藏和保存消息里的图片。 */
const props = defineProps<{ part: MessagePart | null; character: Character; chatId: string }>();
const show = defineModel<boolean>('show', { required: true });
const chatStore = useChatStore();

/** 照片查看器里"重新识图" */
function relook() {
  const p = props.part;
  const m = p?.type === 'image' ? chatStore.list(props.chatId).find((x) => x.parts.includes(p)) : undefined;
  if (m) void chatStore.lookAt(props.chatId, m.id, true);
}

function redrawImage() {
  if (props.part) chatStore.redraw(props.chatId, props.part);
}
// —— 存到相册（回忆 → 相册）：生成的配图 ——
const album = useAlbumStore();
const imageInAlbum = computed(() => {
  const p = props.part;
  return p?.type === 'image' && !!p.assetKey && !!album.find({ assetKey: p.assetKey });
});
function keepImage() {
  const p = props.part;
  if (p?.type !== 'image' || !p.assetKey || p.photo) return;
  const msg = chatStore.list(props.chatId).find((m) => m.parts.includes(p));
  const scene = p.use?.startsWith('image:') ? p.use.slice('image:'.length) : 'chat';
  const r = album.add({
    assetKey: p.assetKey, characterId: props.character.id, title: p.title ?? '', caption: p.caption, scene, at: msg?.createdAt ?? Date.now(),
    ...(p.prompt ? { prompt: p.prompt } : {}), ...(p.seed != null ? { seed: p.seed } : {}), ...(p.model ? { model: p.model } : {}),
  });
  if (!r.ok) showToast(r.reason);
  else showToast(r.existed ? '已经在相册里了' : '存到相册了（回忆 → 相册）');
}
/** 保存图片：手机上弹系统分享（能存进相册），电脑上下载成文件；本机清掉了缓存的先从云端取回来；服务商只给了链接的新开一页打开 */
async function saveImage() {
  const p = props.part;
  if (p?.type !== 'image' || !p.assetKey) return;
  const { missing } = await saveFiles([{ key: p.assetKey, name: p.title || p.caption || 'image' }]);
  if (missing) showToast('找不到这张图了');
}
</script>

<template>
  <van-popup v-model:show="show" round class="w-[88%] max-w-[400px]">
    <div v-if="part && part.type === 'image' && part.photo" class="p-3 max-h-[86vh] overflow-y-auto" data-testid="photo-viewer">
      <GenImage :part="part" :character="character" class="rounded-[16px] overflow-hidden" />
      <div class="mt-3 text-[13px] font-600">识图看到的</div>
      <p v-if="part.seen" class="text-[13.5px] leading-relaxed text-ink-2 mt-1 whitespace-pre-wrap">{{ part.seen }}</p>
      <p v-else-if="part.assetKey && chatStore.lookingKeys.has(part.assetKey)" class="text-[13px] text-ink-3 mt-1">正在看…</p>
      <p v-else class="text-[13px] text-warn mt-1">{{ part.seenError || '还没识图' }}</p>
      <div v-if="part.seenModel" class="text-[12px] text-ink-3 mt-1">{{ part.seenModel }} · 聊天里{{ character.name }}看到的是这段描述</div>
      <div class="flex gap-2 mt-3">
        <van-button v-if="!part.seen" size="small" round block :disabled="!!part.assetKey && chatStore.lookingKeys.has(part.assetKey)" @click="relook">重新识图</van-button>
        <van-button size="small" round block type="primary" :disabled="!part.assetKey" @click="saveImage">保存图片</van-button>
      </div>
    </div>
    <div v-else-if="part && part.type === 'image'" class="p-3 max-h-[86vh] overflow-y-auto" data-testid="image-viewer">
      <GenImage :part="part" :character="character" class="rounded-[16px] overflow-hidden" />
      <div class="mt-3 text-[15px] font-600">{{ part.title || part.caption }}</div>
      <div v-if="part.title" class="text-[12px] text-ink-3 mt-0.5">画的是：{{ part.caption }}</div>
      <ErrorDetails v-if="part.error" :detail="part.errorDetail ?? part.error" :title="part.error" max-height="30vh" />
      <div class="mt-1 text-[12px] text-ink-3 break-all max-h-[96px] overflow-y-auto">提示词：{{ part.prompt ?? (part.error ? '—' : '生成中…') }}</div>
      <div v-if="part.seed || part.model" class="text-[12px] text-ink-3 num">{{ [part.seed ? `种子：${part.seed}` : '', part.model ?? ''].filter(Boolean).join(' · ') }}</div>
      <div class="flex gap-2 mt-3">
        <van-button size="small" round block :disabled="!part.generated && !part.error" @click="redrawImage">重新生成</van-button>
        <van-button size="small" round block :disabled="!part.assetKey" :icon="imageInAlbum ? 'success' : undefined" data-testid="chat-image-album" @click="keepImage">{{ imageInAlbum ? '已在相册' : '存到相册' }}</van-button>
        <van-button size="small" round block type="primary" :disabled="!part.assetKey" @click="saveImage">保存图片</van-button>
      </div>
    </div>
  </van-popup>
</template>
