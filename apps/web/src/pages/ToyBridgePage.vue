<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/layouts/PageHeader.vue';
import { DEFAULT_INTIFACE_ADDRESS } from '@/services/intiface';
import { emptyBridgeStatus, loadBridgeAddress, readBridgeParams, saveBridgeAddress, ToyBridge } from '@/services/toyBridge';

/**
 * 电脑上的玩具桥接页（services/toyBridge.ts）：开在装着 Intiface Central 的电脑上，
 * 手机上的心跳经自己 Worker 上的中转连到这里，再交给本机的 Intiface。链接在手机的心跳设置 → 玩具 → 经云端中转里复制。
 */
const route = useRoute();
const params = computed(() => readBridgeParams(route.query));
const address = ref(loadBridgeAddress());
watch(address, saveBridgeAddress);
const status = reactive(emptyBridgeStatus());
let bridge: ToyBridge | null = null;

onMounted(() => {
  if (!params.value) return;
  bridge = new ToyBridge({ ...params.value, address: () => address.value, status });
  bridge.start();
});
onBeforeUnmount(() => bridge?.stop());

const hubHost = computed(() => (params.value ? new URL(params.value.hub).host : ''));
const rows = computed(() => [
  {
    label: `云端中转（${hubHost.value}）`,
    state: status.relay === 'up' ? 'good' : status.relay === 'connecting' ? 'busy' : 'off',
    text: status.relay === 'up' ? '连着' : status.relay === 'connecting' ? '在连…' : status.running ? '没连上，会自己重连' : '停着',
  },
  {
    label: '手机',
    state: status.phone ? 'good' : 'off',
    text: status.phone ? '连着' : '还没连（手机上：心跳设置 → 玩具 → 连接）',
  },
  {
    label: '本机的 Intiface Central',
    state: status.intiface === 'busy' ? 'good' : status.intiface === 'connecting' ? 'busy' : status.intifaceOk === false ? 'bad' : status.intifaceOk ? 'good' : 'off',
    text:
      status.intiface === 'busy'
        ? '手机正在用'
        : status.intiface === 'connecting'
          ? '在连…'
          : status.intifaceOk === false
            ? '连不上'
            : status.intifaceOk
              ? '能连上'
              : '还没试',
  },
]);

function toggle() {
  if (!bridge) return;
  if (status.running) bridge.stop();
  else bridge.start();
}
</script>

<template>
  <div class="page" data-page="toy-bridge">
    <PageHeader title="玩具桥接" subtitle="手机上的心跳经这台电脑连 Intiface Central" :back="false" />
    <div class="page-scroll pb-10">
      <div v-if="!params" class="card mx-4 mt-3">
        <p class="para">这一页要用手机上复制的桥接链接打开：心跳 → 设置 → 玩具 → 连接方式选"经云端中转" → 复制桥接链接，发到这台电脑上打开。</p>
      </div>
      <template v-else>
        <div class="card mx-4 mt-3">
          <div v-for="r in rows" :key="r.label" class="row">
            <span class="dot" :class="r.state" />
            <span class="flex-1 min-w-0 text-[13.5px] text-ink-2">{{ r.label }}</span>
            <span class="text-[13px] text-right">{{ r.text }}</span>
          </div>
          <p v-if="status.error" class="err" role="alert">{{ status.error }}</p>
          <p v-if="status.forwarded" class="text-[12px] text-ink-3 mt-2">转过 {{ status.forwarded }} 条消息</p>
          <div class="flex gap-2 mt-3">
            <input v-model.trim="address" class="field" :placeholder="DEFAULT_INTIFACE_ADDRESS" aria-label="本机 Intiface Central 的地址" autocapitalize="off" spellcheck="false" />
            <van-button size="small" round plain :disabled="!status.running || status.intiface !== 'idle'" @click="bridge?.checkIntiface()">再试一次</van-button>
          </div>
          <van-button round block :type="status.running ? 'default' : 'primary'" class="!mt-3" @click="toggle">{{ status.running ? '停下桥接' : '开始桥接' }}</van-button>
        </div>

        <div class="group-title">怎么用</div>
        <div class="card mx-4">
          <ol class="steps">
            <li>在这台电脑上打开 Intiface Central，在 Devices 里连上玩具，点 Start Server（上面的地址默认是 {{ DEFAULT_INTIFACE_ADDRESS }}，Intiface 里改过端口就跟着改）。</li>
            <li>这一页用 Chrome、Edge 或 Firefox 打开（Mac 上的 Safari 也连不了本机的 Intiface）；浏览器问要不要允许访问本地网络设备时选允许。</li>
            <li>这一页开着别关（可以放到后台），在手机上点"连接"。手机断开或者这一页关掉，Intiface 会让玩具停下。</li>
          </ol>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card {
  padding: 14px 16px;
  border-radius: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.para {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
}
.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-3);
}
.dot.good {
  background: var(--good);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 25%, transparent);
}
.dot.busy {
  background: var(--warn);
  animation: twinkle 1s infinite;
}
.dot.bad {
  background: var(--bad);
}
.err {
  margin: 8px 2px 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bad);
}
.field {
  flex: 1;
  min-width: 0;
  height: 34px;
  padding: 0 12px;
  border-radius: 17px;
  border: 1px solid var(--border);
  background: var(--panel);
  outline: none;
  font-size: 14px;
}
.steps {
  margin: 0;
  padding-left: 20px;
  list-style: decimal;
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--ink);
}
.steps li + li {
  margin-top: 4px;
}
</style>
