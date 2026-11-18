<script setup lang="ts">
import type { Community } from '@app/shared';
import { showToast } from 'vant';
import { computed, onBeforeUnmount, ref } from 'vue';
import { communityStatus, membersOf, publishUserPost } from '@/services/community';
import { useAiStore } from '@/stores/ai';
import { compressPhoto } from '@/utils/image';

/**
 * 在社群里发帖：标题（可以不写）、正文、几张照片。
 * 发出去以后网友点赞、顶帖、回复，你邀请进这个社群的角色也各自回应（用"社媒"的 API）；照片先交给识图看一遍。
 */
const props = defineProps<{ community: Community }>();
const emit = defineEmits<{ (e: 'close'): void; (e: 'sent'): void }>();

const ai = useAiStore();

const MAX_PHOTOS = 9;
const title = ref('');
const text = ref('');
const photos = ref<{ bytes: Uint8Array<ArrayBuffer>; mime: string; url: string }[]>([]);
const sending = ref(false);

const canSend = computed(() => !sending.value && (!!title.value.trim() || !!text.value.trim() || photos.value.length > 0));
const status = computed(() => communityStatus());
const visionLive = computed(() => ai.isLive('vision'));
const members = computed(() => membersOf(props.community));

async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])].slice(0, MAX_PHOTOS - photos.value.length);
  input.value = '';
  for (const file of files) {
    try {
      const p = await compressPhoto(file);
      photos.value.push({ bytes: p.bytes, mime: p.mime, url: URL.createObjectURL(new Blob([p.bytes], { type: p.mime })) });
    } catch {
      showToast('有一张照片读不出来');
    }
  }
}
function drop(i: number) {
  const [gone] = photos.value.splice(i, 1);
  if (gone) URL.revokeObjectURL(gone.url);
}
onBeforeUnmount(() => photos.value.forEach((p) => URL.revokeObjectURL(p.url)));

async function send() {
  if (!canSend.value) return;
  sending.value = true;
  try {
    await publishUserPost({ communityId: props.community.id, title: title.value, text: text.value, photos: photos.value.map(({ bytes, mime }) => ({ bytes, mime })) });
    emit('sent');
  } catch {
    showToast('没发出去：照片没能存进本机');
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <div class="sheet" data-sheet="community-compose">
    <div class="flex items-center gap-2">
      <div class="sheet-title flex-1 truncate">发到「{{ community.name }}」</div>
      <van-button size="small" round @click="emit('close')">取消</van-button>
      <van-button size="small" round type="primary" :disabled="!canSend" :loading="sending" data-testid="community-send" @click="send">发帖</van-button>
    </div>

    <input v-model="title" class="input mt-3" autocomplete="off" maxlength="60" placeholder="标题（可以不写）" aria-label="标题" />
    <textarea v-model="text" class="textarea mt-2" rows="5" placeholder="想说点什么…" aria-label="正文" />

    <div class="photos">
      <div v-for="(p, i) in photos" :key="p.url" class="photo">
        <img :src="p.url" alt="" />
        <button type="button" class="remove" aria-label="去掉这张" @click="drop(i)"><span class="i-lucide-x" /></button>
      </div>
      <label v-if="photos.length < MAX_PHOTOS" class="photo add press" aria-label="添加照片">
        <span class="i-lucide-image-plus text-[22px]" />
        <input type="file" accept="image/*" multiple class="sr-only" @change="pick" />
      </label>
    </div>
    <p v-if="photos.length && !visionLive" class="note">「识图」还没接通：大家只知道你发了照片，看不到照片里有什么。</p>

    <p class="note">
      发出去以后网友会点赞、顶帖、回复<template v-if="members.length">，{{ members.map((m) => m.name).join('、') }}也会看到、记住这一帖</template>。
      <template v-if="!status.ok">{{ status.reason }}，发出去以后暂时没有人回应。</template>
    </p>
  </div>
</template>

<style scoped>
.photos {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}
.photo {
  position: relative;
  aspect-ratio: 1;
  border-radius: 10px;
  overflow: hidden;
  background: var(--panel);
}
.photo img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.photo.add {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed var(--border);
  color: var(--ink-3);
  cursor: pointer;
}
.remove {
  position: absolute;
  top: 3px;
  right: 3px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 13px;
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
</style>
