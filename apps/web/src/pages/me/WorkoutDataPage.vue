<script setup lang="ts">
import { watchWorkoutLine, type WatchWorkout } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useHealthStore, type WatchMode } from '@/stores/health';
import { useHubStore } from '@/stores/hub';
import { copyText } from '@/utils/errors';

/**
 * 我的 → 手表数据（设计文档 §9.1）：iPhone 的网页读不到健康数据，Apple Watch 记的心率、消耗、距离、步数
 * 由 iPhone 上的快捷指令或 Health Auto Export 推到你自己的 Worker（/v1/ingest/*，用单独的上报令牌），App 同步时拉回来：
 * 和"健身"里记的那一次对上就换成手表的数（运动卡片一起改），只在手表上练的单独记一条。
 * - 快捷指令：免费，格式由 App 定；"健身"练完页上点"用手表的数据更新"带着这次的开始、结束时刻去查（一定是解锁的），
 *   也能加一个"Apple Watch 体能训练结束时"的自动化（锁屏时可能读不到）。
 * - Health Auto Export：它的 REST API 自动化（付费功能）在后台按间隔推，没推成的下次补上；不用按按钮。
 * 选哪种、快捷指令叫什么存在健康计划里（会同步）；上报令牌只在这台设备上留一份（云端只存哈希）。
 */
const health = useHealthStore();
const hub = useHubStore();

const MODES: { value: WatchMode; label: string; icon: string }[] = [
  // 手机上三格放不下"Health Auto Export"：按钮上写短的，下面的标题写全名
  { value: 'off', label: '不接', icon: 'i-lucide-circle-off' },
  { value: 'shortcut', label: '快捷指令', icon: 'i-lucide-layers' },
  { value: 'hae', label: 'Auto Export', icon: 'i-lucide-cloud-upload' },
];
const mode = computed({
  get: () => health.watch.mode,
  set: (m: WatchMode) => health.setWatch({ mode: m }),
});
const shortcutName = ref(health.watch.shortcutName);
function saveName() {
  health.setWatch({ shortcutName: shortcutName.value });
  shortcutName.value = health.watch.shortcutName;
}

const ready = computed(() => hub.connected && hub.supportsIngest);
const endpoint = computed(() => (hub.config.url ? `${hub.config.url}${mode.value === 'hae' ? '/v1/ingest/hae' : '/v1/ingest/workout'}` : ''));
const token = computed(() => hub.config.ingestToken ?? '');
const configured = computed(() => !!hub.status?.ingestConfigured);
const shownToken = ref(false);

async function copy(text: string, what: string) {
  showToast((await copyText(text)) ? `${what}已复制` : '复制不了，长按选中手动复制');
}

const busy = ref(false);
async function run(task: () => Promise<unknown>) {
  busy.value = true;
  try {
    await task();
  } catch (e) {
    showToast(e instanceof Error ? e.message : String(e));
  } finally {
    busy.value = false;
  }
}
async function makeToken() {
  if (configured.value) {
    try {
      await showConfirmDialog({ title: '换一个上报令牌？', message: '旧的马上失效：快捷指令、Health Auto Export 里的要换成新的。', confirmButtonText: '换', cancelButtonText: '算了' });
    } catch {
      return;
    }
  }
  await run(async () => {
    await hub.createIngestToken();
    shownToken.value = true;
    showToast('建好了，复制到快捷指令或 Health Auto Export 里');
  });
}
async function revokeToken() {
  try {
    await showConfirmDialog({ title: '停用上报令牌？', message: '停用以后快捷指令、Health Auto Export 推不上来了；已经收到的还在。', confirmButtonText: '停用', cancelButtonText: '算了' });
  } catch {
    return;
  }
  await run(() => hub.revokeIngestToken());
}

/** 用这台设备发一条测试（快捷指令的格式），看令牌和地址对不对 */
const testResult = ref<{ ok: boolean; text: string } | null>(null);
async function sendTest() {
  if (!token.value) return showToast('这台设备上没存令牌：先建一个');
  testResult.value = null;
  await run(async () => {
    const end = Date.now();
    const iso = (t: number) => new Date(t).toISOString();
    try {
      const r = await fetch(`${hub.config.url}/v1/ingest/workout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ start: iso(end - 30 * 60_000), end: iso(end), logId: `test-${end}`, sport: '测试', hr: '118\n126\n131', kcal: 180, km: 3.2, steps: 4200 }),
        cache: 'no-store',
      });
      const data = (await r.json()) as { message?: string; error?: string };
      testResult.value = r.ok ? { ok: true, text: `${data.message ?? '收到了'}（测试的这一条不会记进运动记录）` } : { ok: false, text: data.error ?? `HTTP ${r.status}` };
    } catch (e) {
      testResult.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
  });
  // 刷新"上次收到"和下面的列表
  // （上面在回调里改的，TS 看不出来）
  if ((testResult.value as { ok: boolean } | null)?.ok) void hub.syncNow();
}

async function syncNow() {
  await run(async () => {
    await hub.pullWatchWorkouts();
    showToast('同步好了');
  });
}

const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
/** 最近收到的：用到了哪条记录上 */
const recent = computed(() =>
  health.watchInbox.slice(0, 12).map((w: WatchWorkout) => {
    const log = health.logs.find((l) => l.watch?.id === w.id);
    const state = w.logId?.startsWith('test-')
      ? '测试'
      : !log
        ? w.logId
          ? '等这次发给她'
          : '还没对上'
        : log.watch?.only
          ? '单独记了一条'
          : log.watch?.used
            ? '用到了健身的记录上'
            : '对上了，没用（见说明）';
    return { w, state, note: log?.watch?.note };
  }),
);
const lastAt = computed(() => hub.status?.lastIngestAt ?? null);
</script>

<template>
  <div class="page" data-page="workout-data">
    <PageHeader title="手表数据" subtitle="Apple Watch 的心率、消耗、距离" fallback="/me" />
    <div class="page-scroll pb-12">
      <p class="note !mt-3">
        iPhone 上的网页读不到"健康"里的数据。接上以后，iPhone 上的快捷指令或 Health Auto Export 把 Apple Watch 记的运动推到你自己的云端，App 同步时拿回来：
        和"健身"里记的那一次对上，就换成手表的心率、消耗、距离、步数（发出去的运动卡片也一起改）；没开 App、只在手表上练的，单独记一条。
      </p>

      <div class="group-title"><span class="i-lucide-watch" />从哪来</div>
      <div class="px-4"><Segmented v-model="mode" :options="MODES" /></div>

      <template v-if="mode !== 'off'">
        <div class="group-title"><span class="i-lucide-cloud" />云端<span v-if="lastAt" class="ml-auto text-[12px]">上次收到 {{ fmt(lastAt) }}</span></div>
        <van-cell-group inset>
          <van-cell title="云端 Hub" :value="hub.connected ? '已连接' : '未连接'" label="手表的数据先推到它这里" is-link to="/me/sync" />
          <van-cell v-if="hub.connected && hub.status && !hub.supportsIngest" title="Worker 是旧版" label="收不了手表的数据：按 docs/CLOUDFLARE.md 重新部署一次（含数据库迁移 0012）" />
          <template v-if="ready">
            <van-cell title="地址" :label="endpoint" is-link @click="copy(endpoint, '地址')" />
            <van-cell v-if="configured && token" title="上报令牌" :label="shownToken ? token : `${token.slice(0, 7)}••••••••（点一下显示）`" @click="shownToken = !shownToken">
              <template #right-icon><button type="button" class="text-accent-ink text-[13px]" @click.stop="copy(`Bearer ${token}`, '「Bearer 令牌」')">复制</button></template>
            </van-cell>
            <van-cell v-else-if="configured" title="上报令牌" label="建过了，但这台设备上没存：要复制的话换一个新的（旧的会失效）" />
            <van-cell v-else title="上报令牌" label="还没建：建一个，复制到快捷指令或 Health Auto Export 的请求头里" />
          </template>
        </van-cell-group>
        <div v-if="ready" class="px-4 mt-3 flex gap-2">
          <van-button round size="small" type="primary" :loading="busy" @click="makeToken">{{ configured ? '换一个令牌' : '建上报令牌' }}</van-button>
          <van-button v-if="configured && token" round size="small" :disabled="busy" @click="sendTest">发一条测试</van-button>
          <van-button v-if="configured" round size="small" :disabled="busy" @click="revokeToken">停用</van-button>
        </div>
        <p v-if="testResult" class="note" :class="testResult.ok ? 'text-good' : 'text-bad'">{{ testResult.text }}</p>
        <p v-if="ready" class="note">请求头写 <code>Authorization</code> = <code>Bearer 令牌</code>（"复制"复制的就是这一整串）。令牌只能往云端推运动数据，读不了别的；云端只存它的哈希。</p>

        <!-- 快捷指令 -->
        <template v-if="mode === 'shortcut'">
          <div class="group-title"><span class="i-lucide-layers" />做一个快捷指令</div>
          <van-cell-group inset>
            <van-field v-model="shortcutName" label="叫什么" placeholder="运动回填" autocomplete="off" @blur="saveName" />
          </van-cell-group>
          <p class="note">"健身"练完页上的"用手表的数据更新"按这个名字打开它，带着这次的开始、结束时刻和记录 id（一段 JSON 文字）。</p>
          <ol class="steps">
            <li>打开"快捷指令" → 右上角 ＋，名字叫「{{ health.watch.shortcutName }}」。</li>
            <li>
              加「如果」：<b>快捷指令输入</b> 有任何值 ——
              <ul>
                <li>「从输入中获取词典」；「获取词典值」键 <code>start</code> →「从输入中获取日期」→ 设为变量 <b>开始</b>；键 <code>end</code> 同样设为 <b>结束</b>；键 <code>logId</code> 设为 <b>记录</b>。</li>
              </ul>
              否则（自动化跑的，没有输入）——
              <ul>
                <li>「查找健康样本」：类型选<b>体能训练</b>，按开始日期排序、最新的在前，限制 1 个；「获取健康样本的详细信息」取<b>开始日期</b>设为 <b>开始</b>、<b>结束日期</b>设为 <b>结束</b>。</li>
              </ul>
            </li>
            <li>「查找健康样本」：<b>心率</b>，开始日期在 <b>开始</b> 和 <b>结束</b> 之间；「获取健康样本的详细信息」取<b>值</b>，设为 <b>心率</b>。同样查<b>活动能量</b>、<b>步行 + 跑步距离</b>、<b>步数</b>，设为 <b>消耗</b>、<b>距离</b>、<b>步数</b>。</li>
            <li>「格式化日期」：<b>开始</b>、<b>结束</b> 各一次，格式选 <b>ISO 8601</b>（要带时区）。</li>
            <li>
              「获取 URL 内容」：URL 填上面的地址，方法 <b>POST</b>；头部加 <code>Authorization</code> = <code>Bearer 令牌</code>；请求体选 <b>JSON</b>，加这些文本字段：
              <code>start</code>（格式化后的开始）、<code>end</code>（格式化后的结束）、<code>logId</code>（记录）、<code>hr</code>（心率）、<code>kcal</code>（消耗）、<code>km</code>（距离）、<code>steps</code>（步数）。
              一串值放进文本里是一行一个，云端会自己算平均、最高、加起来。
            </li>
            <li>（可以不加）「显示结果」：云端会回一句"收到了：跑步 32 分钟 · 3.10 公里……"。</li>
          </ol>
          <p class="note">
            距离的单位是英里时加一个字段 <code>distanceUnit</code> = <code>mi</code>；能量用千焦时加 <code>energyUnit</code> = <code>kJ</code>。做好以后可以分享成 iCloud 链接，别人装上改一下地址和令牌就能用。
          </p>
          <p class="note">
            想练完自动推：快捷指令 → 自动化 → 新建 →「Apple Watch 体能训练」→「结束时」→ 立即运行 → 运行「{{ health.watch.shortcutName }}」。
            手机锁着时读不到健康数据，这样跑可能是空的；在 App 的练完页上点按钮跑一定是解锁的，最稳。
          </p>
        </template>

        <!-- Health Auto Export -->
        <template v-else>
          <div class="group-title"><span class="i-lucide-cloud-upload" />设置 Health Auto Export</div>
          <ol class="steps">
            <li>在 Health Auto Export 里新建一个自动化（Automations → New Automation），Automation Type 选 <b>REST API</b>（这是它的付费功能）。</li>
            <li>URL 填上面的地址；HTTP Headers 加一项：Key <code>Authorization</code>，Value <code>Bearer 令牌</code>。</li>
            <li>Data Type 选 <b>Workouts</b>；打开 <b>Include Workout Metrics</b>，Time Grouping 选 <b>Minutes</b>（手表忘了停时靠它截取 App 那一段）；<b>Include Route Data</b> 关掉（用不上，请求会很大）。</li>
            <li>Export Format 选 <b>JSON</b>，Export Version 选 <b>Version 2</b>，Date Range 选 <b>Since Last Sync</b>（或 Default）。</li>
            <li>Sync Frequency 比如每 15 分钟；打开 Enabled，点 Update 保存。打开它的"Background App Refresh"，别开低电量模式。</li>
            <li>先用 Manual Upload 传今天的试一下，下面"最近收到的"里会出现。</li>
          </ol>
          <p class="note">iOS 不保证后台按时跑，而且手机解锁时才读得到健康数据：多半在练完、解锁手机以后的几分钟到几十分钟里推上来。先发给她也行，到了会改记录和卡片。</p>
        </template>

        <div class="group-title"><span class="i-lucide-inbox" />最近收到的<button v-if="ready" type="button" class="action" :disabled="busy" @click="syncNow">同步一下</button></div>
        <van-cell-group v-if="recent.length" inset>
          <van-cell v-for="r in recent" :key="r.w.id" :title="watchWorkoutLine(r.w)" :label="`${fmt(r.w.startedAt)} · ${r.w.source === 'hae' ? 'Health Auto Export' : '快捷指令'}${r.w.device ? ` · ${r.w.device}` : ''}${r.note ? ` · ${r.note}` : ''}`" :value="r.state" />
        </van-cell-group>
        <p v-else class="note">还没有。推上来以后，App 同步时（打开 App、每分钟一次）拉回来。</p>
        <p class="note">
          怎么对：快捷指令从练完页跑的按记录 id 对；别的按时间，和"健身"里那一次重叠超过一半就算同一次。手表忘了停的（比 App 里长得多），有逐分钟的数时只取 App 那段时间，没有就不用；
          App 里忘了按结束的，时长按手表结束的时刻算。只在手表上练的，结束 2 小时以后还没对上就单独记一条（选了这里以后的才记）。云端只存这些数（不存路线），留 120 天。
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.steps {
  margin: 4px 16px 0 28px;
  padding-left: 18px;
  list-style: decimal;
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--ink-2);
}
.steps li + li {
  margin-top: 6px;
}
.steps ul {
  margin: 2px 0;
  padding-left: 14px;
  list-style: disc;
}
code {
  font-size: 11.5px;
  word-break: break-all;
}
</style>
