<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { showConfirmDialog, showToast } from 'vant';
import PageHeader from '@/layouts/PageHeader.vue';
import { resetSync, runSync, setSyncEnabled, syncState } from '@/services/sync';
import { useHubStore } from '@/stores/hub';

const cloud = useHubStore();
const state = computed(() => cloud);
const workerUrl = ref(cloud.config.url);
const password = ref(cloud.savedPassword);
watch(() => cloud.savedPassword, (value) => { password.value = value; });
const changed = computed(() => workerUrl.value.trim() !== cloud.config.url || (!!password.value && password.value !== cloud.savedPassword));
const working = ref(false);
const failure = ref('');
async function run(task: () => Promise<void>) {
  working.value = true; failure.value = '';
  try { await task(); } catch (e) { failure.value = e instanceof Error ? e.message : String(e); }
  finally { working.value = false; }
}
async function connect() {
  await cloud.connect(workerUrl.value.trim(), password.value);
  workerUrl.value = cloud.config.url;
  showToast(cloud.error ? '已登录，同步尚未完成，请查看下方原因' : '已连接并同步');
}
async function disconnect() { await cloud.disconnect(); showToast('已断开连接'); }
const time = (value: number | null | undefined) => value ? new Date(value).toLocaleString() : '尚未';

// —— 多设备同步 ——
// 和上面的 state 一样包一层 computed（模板里直接用模块里的 reactive 会被 vue-tsc 当成 ref）
const data = computed(() => syncState);
const syncText = computed(() => {
  if (!cloud.status) return '待检测';
  if (!cloud.supportsSync) return '需要更新 Worker';
  if (!data.value.enabled) return '已关闭';
  if (data.value.running && data.value.phase === 'scan') return '正在整理本机数据';
  if (data.value.running && data.value.phase === 'pull' && data.value.head > data.value.cursor) return `正在下载 ${Math.floor((data.value.cursor / Math.max(1, data.value.head)) * 100)}%`;
  if (data.value.running && data.value.phase === 'push') return `正在上传${data.value.pending ? `（还有 ${data.value.pending} 条）` : ''}`;
  if (data.value.running) return '同步中';
  if (data.value.error) return '上次没同步成';
  if (data.value.pending) return `${data.value.pending} 条待上传`;
  return data.value.lastAt ? '已同步' : '等待同步';
});
const blobText = computed(() => cloud.status?.syncBlobs === 'r2' ? 'R2' : cloud.status?.syncBlobs === 'd1' ? 'D1' : '—');
const blobLabel = computed(() => cloud.status?.syncBlobs === 'd1'
  ? `没绑 R2：图片、语音、模型分块存在 D1，${cloud.status.syncBlobQuota ? `最多 ${Math.round(cloud.status.syncBlobQuota / 1024 / 1024)} MB` : '不限大小'}。图片多的话绑一个 R2 桶（便宜得多）`
  : '图片、语音、Live2D 模型、书的原文件按内容存一份，别的设备用到时才下载');
async function toggleSync(on: boolean) {
  await setSyncEnabled(on);
  showToast(on ? '已开启：先下载云端的，再上传这台设备独有的' : '已关闭：这台设备的改动不再同步');
}
async function syncData() {
  await runSync();
  showToast(data.value.error ? '没同步成，请查看下方原因' : '已同步');
}
async function realign() {
  await showConfirmDialog({
    title: '从云端重新下载',
    message: '重新下载云端的全部数据。这台设备上和云端不一样的记录以云端为准；只在这台设备上的会再传上去。Key 不受影响。',
    confirmButtonText: '重新下载',
  });
  await resetSync();
  showToast(data.value.error ? '没下载完，请查看下方原因' : '已和云端对齐');
}
const reload = () => location.reload();
</script>

<template>
  <div class="page" data-page="sync">
    <PageHeader title="云端与同步" subtitle="关掉 App，也能生成节律、收到消息" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">我的 Cloudflare Worker</div>
      <van-cell-group inset>
        <van-cell v-if="state.connected" :title="state.error ? '已登录 · 同步异常' : state.lastSyncAt ? '已登录 · 已同步' : '已登录 · 等待同步'" :value="state.syncing ? '同步中' : ''" label="登录信息已保存；设置是否生效以上次完整同步为准。" class="hub-connected" />
        <van-field v-model="workerUrl" label="Worker 地址" placeholder="https://你的域名" autocomplete="url" />
        <van-field v-model="password" label="登录密码" type="password" :placeholder="state.connected ? '••••••••••••' : '输入登录密码'" autocomplete="current-password" />
      </van-cell-group>
      <div class="px-4 mt-3 grid gap-2">
        <van-button v-if="state.connected" round block :loading="working" @click="run(disconnect)">断开连接</van-button>
        <van-button v-if="!state.connected || changed" type="primary" round block :loading="working" :disabled="!workerUrl || !password || state.syncing" @click="run(connect)">{{ state.connected ? '保存修改并重新连接' : '连接 Worker' }}</van-button>
      </div>
      <p v-if="state.connected" class="note">断开连接会停止这台设备的同步，云端仍继续运行。主动消息可用下方开关停止；每日节律可在连接时改为「固定」并同步后停止。</p>
      <p class="note">输入自己部署的 Worker 地址和密码。部署步骤见仓库 docs/CLOUDFLARE.md；国内网络可使用绑定的自定义域名。</p>
      <template v-if="state.connected">
        <div class="group-title">多设备同步</div>
        <van-cell-group inset>
          <van-cell center title="和其他设备同步" label="连着这个 Worker 的手机、平板、电脑看到同一份聊天、朋友圈、社群和设置" data-sync="toggle">
            <template #right-icon><van-switch :model-value="data.enabled" :disabled="!state.supportsSync" size="22px" @update:model-value="(v: boolean) => run(() => toggleSync(v))" /></template>
          </van-cell>
          <van-cell title="同步状态" :value="syncText" data-sync="status" />
          <van-cell title="上次同步数据" :value="time(data.lastAt)" />
          <van-cell title="图片和文件存在" :value="blobText" :label="blobLabel" />
        </van-cell-group>
        <div class="px-4 mt-3 grid gap-2">
          <van-button round block :loading="data.running" :disabled="!state.supportsSync || !data.enabled" @click="run(syncData)">立即同步数据</van-button>
          <van-button round block :disabled="!state.supportsSync || !data.enabled || data.running" @click="run(realign)">从云端重新下载</van-button>
        </div>
        <p v-if="data.needsReload" class="note">别的设备改了只在打开 App 时读的设置，<a class="text-accent-ink" @click="reload">重新打开 App</a> 后显示。</p>
        <p v-if="data.error || data.blobNote" class="note text-danger whitespace-pre-line" role="alert">{{ [data.error, data.blobNote].filter(Boolean).join('\n') }}</p>
        <p class="note">同步聊天记录、朋友圈（点赞、评论、已读）、社群和帖子、角色、预设、世界书、记忆、节律、日程和健康计划、平行时空、书架、图库和各项设置；改动几秒后上传，开着 App 时每 20 秒看一次别的设备的。图片、语音、Live2D 模型和书的原文件按内容存一份，用到时才下载。</p>
        <p class="note">不同步：API Key、Cookie 等密钥（每台设备自己填）、外观和主题、家的地址、这台设备此刻开着的场景。第一次连上已经有数据的 Worker 时，先下载云端的（同一条以云端为准），再把这台设备独有的传上去；空设备不会清掉云端。两台设备同时改了同一条时按字段合并，同一处都改了以后改的为准。</p>
        <van-cell-group inset>
          <van-cell title="云端主动消息" :value="state.config.active ? '已开启' : '未开启'" :label="state.config.url" />
          <van-cell title="云端每日节律" :value="!state.status ? '待检测' : !state.supportsRhythm ? '需要更新 Worker' : state.status.rhythmConfigured ? 'API 已接通' : '尚未配置'" label="每天变化的角色在凌晨 4 点生成，不受主动消息开关影响" is-link to="/me/rhythm" />
          <van-cell title="云端记忆整理" :value="!state.status ? '待检测' : !state.supportsMemory ? '需要更新 Worker' : state.status.memoryConfigured ? 'API 已接通' : '尚未配置'" label="每天凌晨 4 点合并重复的记忆、合并时间线、改时态、修改画像卡；用「记忆整理」的 API" is-link to="/memories?tab=book" />
          <van-cell title="云端朋友圈" :value="!state.status ? '待检测' : !state.supportsSocial ? '需要更新 Worker' : state.status.socialConfigured ? 'API 已接通' : '尚未配置'" label="她们每天在随机的时间发朋友圈（按节律和最近的聊天），不受主动消息开关影响；用「社媒」的 API" is-link to="/me?open=social" />
          <van-cell title="云端社群" :value="!state.status ? '待检测' : !state.supportsCommunity ? '需要更新 Worker' : state.status.lastCommunityError ? '上一轮出错' : state.status.socialConfigured ? 'API 已接通' : '尚未配置'" :label="state.status?.lastCommunityError || '你加入的社群每天在随机的时间由网友发帖，你邀请进去的角色也会发；和朋友圈共用「社媒」的 API'" is-link to="/me?open=social" />
          <van-cell title="云端日程计划" :value="!state.status ? '待检测' : !state.supportsPlanner ? '需要更新 Worker' : state.status.lastPlannerError ? '上一轮出错' : state.status.plannerConfigured ? 'API 已接通' : '尚未配置'" :label="state.status?.lastPlannerError || '开了日程系统的人设每天到点（默认凌晨 4 点）看新邮件和日程、排这周和今天的计划；用「日程计划」的 API'" is-link to="/me/planner" />
          <van-cell title="云端平行时空" :value="!state.status ? '待检测' : !state.supportsParallel ? '需要更新 Worker' : state.status.lastParallelError ? '上一轮出错' : state.status.parallelConfigured ? 'API 已接通' : '尚未配置'" :label="state.status?.lastParallelError || '她们每天在随机的时间看着你们俩今天的安排给你留言（地图上她的世界 → 平行时空），不受主动消息开关影响；用「平行时空」的 API'" />
          <van-cell title="上次云端检测" :value="time(state.status?.lastCronAt)" />
          <van-cell title="上次完整同步" :value="time(state.lastSyncAt)" />
        </van-cell-group>
        <div class="px-4 mt-3 grid gap-2">
          <van-button v-if="!state.config.active" type="primary" round block :loading="working" @click="run(() => state.enable())">启用云端主动消息</van-button>
          <van-button v-else round block :loading="working" @click="run(() => state.disable())">停止云端主动消息</van-button>
          <van-button round block :loading="state.syncing" @click="state.syncNow()">立即同步</van-button>
          <van-button round block :loading="working" :disabled="state.syncing" @click="run(() => state.resyncFromDevice())">用本机设置重新同步</van-button>
          <RouterLink class="text-accent-ink text-center py-2" to="/me/proactive">设置角色与通知通道 →</RouterLink>
        </div>
        <p class="note">启用后，角色卡、所选预设、世界书、最近 200 条聊天、作息，以及主动消息使用的 API 和 Key 会交给你自己的 Worker。Key 经独立接口加密保存，只写不读。设置改动后自动更新；关闭 App 后云端每 5 分钟继续检测、生成并保存消息。</p>
        <p class="note">每日节律在连接后自动同步角色设置、世界、模板、预设和节律 API，Key 加密保存。按「我的环境」里的时区在凌晨 4 点生成，失败会自动重试；打开 App 时同步结果。固定模式的角色不会调用节律 API。</p>
        <p class="note">云端生成用的上下文（主动消息、节律、朋友圈、社群、日程、平行时空、健康计划）由每台设备各自上传；开着多设备同步时，别的设备先上传了更新的版本会自动以这台设备的重传。没开同步时多个设备修改同一角色会提示版本冲突，点击「用本机设置重新同步」会读取云端最新版本，再采用这台设备的角色设置、时区和作息。</p>
      </template>
      <p v-if="failure || state.error || state.status?.lastError || state.status?.lastRhythmError || state.status?.lastMemoryError || state.status?.lastSocialError" class="note text-danger whitespace-pre-line" role="alert">{{ [failure, state.error, state.status?.lastError, state.status?.lastRhythmError, state.status?.lastMemoryError, state.status?.lastSocialError].filter(Boolean).join('\n') }}</p>
    </div>
  </div>
</template>
