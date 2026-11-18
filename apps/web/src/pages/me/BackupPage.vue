<script setup lang="ts">
import { computed, ref } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import PageHeader from '@/layouts/PageHeader.vue';
import type { StoreName } from '@/db/idb';
import { downloadBlob, exportBackup, inspectBackup, restoreBackup, type BackupHeader } from '@/services/backup';

const LABELS: Partial<Record<StoreName, string>> = {
  characters: '角色卡', presets: '预设', lorebooks: '世界书', chats: '聊天', chatMessages: '消息记录', settings: '设置项',
  secrets: 'API Key / 密码', memories: '记忆', profiles: '画像卡', moments: '朋友圈', books: '书', assets: '图片与语音', live2d: 'Live2D 模型',
};

const withSecrets = ref(true);
const withMedia = ref(true);
const busy = ref('');
const failure = ref('');
const last = ref<{ blob: Blob; name: string } | null>(null);
const canShare = computed(() => {
  if (!last.value || typeof navigator.canShare !== 'function') return false;
  try { return navigator.canShare({ files: [new File([], last.value.name)] }); } catch { return false; }
});

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
};
const size = (bytes: number) => bytes > 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const summary = (h: BackupHeader) => Object.entries(LABELS)
  .filter(([s]) => h.counts[s as StoreName])
  .map(([s, label]) => `${label} ${h.counts[s as StoreName]}`)
  .join('、');

async function doExport() {
  busy.value = '正在打包…'; failure.value = '';
  try {
    const { blob, header } = await exportBackup({ secrets: withSecrets.value, media: withMedia.value }, (t) => { busy.value = t; });
    const name = `ai-mobile-备份-${stamp()}.jsonl`;
    last.value = { blob, name };
    downloadBlob(blob, name);
    showToast({ message: `已导出 ${size(blob.size)}\n${summary(header)}`, duration: 3000 });
  } catch (e) {
    failure.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = '';
  }
}

async function share() {
  if (!last.value) return;
  const file = new File([last.value.blob], last.value.name, { type: 'application/x-ndjson' });
  try { await navigator.share({ files: [file], title: last.value.name }); } catch { /* 用户取消 */ }
}

async function picked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  busy.value = '正在检查备份…'; failure.value = '';
  let writing = false;
  try {
    const h = await inspectBackup(file);
    busy.value = '';
    const skipped = [!h.stores.includes('secrets') && '没带 API Key，这台设备现有的 Key 保留', !h.stores.includes('assets') && '没带图片语音素材，这台设备现有的素材保留'].filter(Boolean);
    const ok = await showConfirmDialog({
      title: '用这份备份覆盖本机？',
      message: `导出于 ${new Date(h.exportedAt).toLocaleString()}\n${summary(h)}\n\n本机的角色、预设、聊天、设置会被整份替换，不能撤销。${skipped.length ? `\n（${skipped.join('；')}）` : ''}\n完成后 App 会重新加载；连过云端的话，到「云端与同步」点一次重新连接。开着多设备同步时，导入的数据会和云端合并（同一处以导入的为准），再同步到别的设备。`,
      confirmButtonText: '覆盖并重启',
      messageAlign: 'left',
    }).then(() => true, () => false);
    if (!ok) return;
    busy.value = '正在写入…';
    writing = true;
    await restoreBackup(file, h, (done, total) => { busy.value = `正在写入 ${done} / ${total}`; });
    showToast('导入完成，正在重新加载');
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    busy.value = '';
    const message = err instanceof Error ? err.message : String(err);
    // 已经开始覆盖：本机数据可能只写了一部分，自动保存也已停止
    failure.value = writing ? `导入中断：${message}\n本机数据可能不完整，请再导入一次同一个文件（或重新打开 App）。` : message;
  }
}
</script>

<template>
  <div class="page" data-page="backup">
    <PageHeader title="导出与导入" subtitle="换手机、换浏览器时整份搬走" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">导出</div>
      <van-cell-group inset>
        <van-cell title="包含 API Key 和密码" label="关掉后新设备需要重新填 Key" center>
          <template #right-icon><van-switch v-model="withSecrets" size="20" /></template>
        </van-cell>
        <van-cell title="包含图片、语音、Live2D 模型" label="素材多时文件会很大" center>
          <template #right-icon><van-switch v-model="withMedia" size="20" /></template>
        </van-cell>
      </van-cell-group>
      <div class="px-4 mt-3 grid gap-2">
        <van-button type="primary" round block :loading="!!busy" :loading-text="busy" @click="doExport">导出备份文件</van-button>
        <van-button v-if="canShare" round block :disabled="!!busy" @click="share">分享刚才的备份（发到微信、存到文件）</van-button>
      </div>
      <p class="note">备份包括角色卡、预设、世界书、所有聊天和记忆、朋友圈与社群、节律与日程、每个功能的 API 设置、主题外观等全部本机数据。</p>
      <p v-if="withSecrets" class="note text-danger">备份文件里的 API Key 是明文，请只存在自己的设备或网盘里，不要发给别人。</p>

      <div class="group-title">导入</div>
      <van-cell-group inset>
        <label class="pick">
          <span>选择备份文件（.jsonl）</span>
          <input type="file" class="sr-only" aria-label="选择备份文件" :disabled="!!busy" @change="picked" />
          <span class="text-accent-ink">选择</span>
        </label>
      </van-cell-group>
      <p class="note">导入会用备份整份替换这台设备的数据。导入前建议先在这台设备导出一份留底。导入时请关掉 App 的其他窗口或标签页。</p>
      <p v-if="failure" class="note text-danger whitespace-pre-line" role="alert">{{ failure }}</p>
    </div>
  </div>
</template>

<style scoped>
.pick {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  font-size: 14px;
  cursor: pointer;
}
</style>
