<script setup lang="ts">
import { characterPronoun, type Character } from '@app/shared';
import { SCALAR_KINDS, TOY_KIND_LABEL, type ScalarKind, type ToyKind } from '@app/shared';
import { showConfirmDialog } from 'vant';
import { computed, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import Segmented from '@/components/common/Segmented.vue';
import { DEFAULT_INTIFACE_ADDRESS, type ToyDevice } from '@/services/intiface';
import { useAiStore } from '@/stores/ai';
import { useHubStore } from '@/stores/hub';
import { useToyStore, type CommandSource, type ToyLink } from '@/stores/toys';
import { copyWithToast } from '@/utils/errors';

/**
 * 心跳设置里"玩具"那一页：连 Intiface Central（直连，或者经云端中转连电脑上的桥接页）、连着的玩具（能做什么、电量、试一下）、
 * 指令从哪来、强度上限、安全。设置存在本机（stores/toys.ts）；连接留着，点"断开"才断。
 */
const props = defineProps<{ character?: Character }>();
const toys = useToyStore();
const ai = useAiStore();
const hub = useHubStore();
const router = useRouter();
const s = toys.settings;

const LINKS = computed<{ value: ToyLink; label: string; disabled?: boolean }[]>(() =>
  (['direct', 'relay'] as const).map((value) => ({ value, label: value === 'direct' ? '直连' : '经云端中转', disabled: toys.status !== 'idle' && s.link !== value })),
);
const LINK_HINT: Record<ToyLink, string> = {
  direct: `直接连 Intiface Central：和这个页面在同一台设备上填 ${DEFAULT_INTIFACE_ADDRESS}；iPhone / iPad 上的浏览器连不了 ws://（连本机也不行），用"经云端中转"。`,
  relay:
    '手机经你自己的 Worker 连电脑上的桥接页，桥接页连那台电脑上的 Intiface Central（iPhone 用这个）。把下面的桥接链接发到装着 Intiface 的电脑上，用 Chrome / Edge / Firefox 打开，开着别关。',
};
/** 经云端中转时还差什么（没连 Worker、Worker 太旧） */
const relayBlocked = computed(() => {
  if (!hub.connected) return 'none';
  if (hub.status && !hub.supportsToyRelay) return 'old';
  return '';
});
const hubHost = computed(() => {
  try {
    return new URL(hub.config.url).host;
  } catch {
    return '';
  }
});
const linkError = ref('');
const linkBusy = ref(false);
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

async function fetchLink(rotate = false) {
  linkBusy.value = true;
  linkError.value = '';
  try {
    await toys.loadBridgeLink(rotate);
  } catch (e) {
    linkError.value = `取不到桥接链接：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    linkBusy.value = false;
  }
}
// 选了经云端中转、Worker 也支持时取一次桥接链接（显示出来，复制、分享时不用再等网络）
watch(
  () => s.link === 'relay' && !relayBlocked.value && !toys.bridgeLink,
  (need) => {
    if (need && !linkBusy.value) void fetchLink();
  },
  { immediate: true },
);
async function rotateLink() {
  const ok = await showConfirmDialog({
    title: '换一个桥接链接？',
    message: '旧链接马上失效，用旧链接打开的桥接页会断开。之后把新链接发到电脑上重新打开。',
    confirmButtonText: '换一个',
  }).then(
    () => true,
    () => false,
  );
  if (ok) await fetchLink(true);
}
async function shareLink() {
  try {
    await navigator.share({ title: '玩具桥接', url: toys.bridgeLink });
  } catch {
    // 取消了
  }
}

const SOURCES = computed<{ value: CommandSource; label: string }[]>(() => [
  { value: 'separate', label: '单独生成' },
  { value: 'inline', label: `${characterPronoun(props.character)}自己写` },
  { value: 'off', label: '不控制' },
]);
const SOURCE_HINT = computed<Record<CommandSource, string>>(() => ({
  separate: `${characterPronoun(props.character)}每说完一句，"控制指令"预设按这句话另写一份指令（「控制指令」的 API，默认跟随「陪伴 · 快速」），读到、念到那几个字时执行。多一次调用，指令更稳。`,
  inline: `${characterPronoun(props.character)}在回复里自己写 <device>…</device>（心跳功能预设里"${characterPronoun(props.character)}自己写指令"那一块），写到哪执行到哪，不多花一次调用；模型不听话时可能漏写。`,
  off: `${characterPronoun(props.character)}的话不控制玩具；还能在这里"试一下"。`,
}));
const SAFETY = [
  { v: 3, label: '3 分钟' },
  { v: 5, label: '5 分钟' },
  { v: 10, label: '10 分钟' },
  { v: 20, label: '20 分钟' },
  { v: 0, label: '不停' },
];

const deviceStatus = computed(() => ai.status('device'));
const statusText = computed(() => {
  const via = s.link === 'relay' ? '（经云端中转）' : '';
  if (toys.status === 'connecting') return `正在连 Intiface Central${via}…`;
  if (toys.status === 'connected') return `已连上 ${toys.server || 'Intiface Central'}${via}${toys.devices.length ? ` · ${toys.devices.length} 个玩具` : ' · 还没有玩具'}`;
  return '没连';
});
/** 上限：连着的玩具有的那几种；没连时都列出来 */
const capKinds = computed<ScalarKind[]>(() => {
  const have = new Set<ToyKind>(toys.kinds);
  const list = SCALAR_KINDS.filter((k) => have.has(k));
  return list.length ? list : ['vibrate', 'oscillate', 'rotate'];
});
const hasLinear = computed(() => toys.kinds.includes('linear') || !toys.ready);

function featureLine(d: ToyDevice): string {
  const by = new Map<ToyKind, number>();
  for (const f of d.features) by.set(f.kind, (by.get(f.kind) ?? 0) + 1);
  const parts = [...by].map(([k, n]) => `${TOY_KIND_LABEL[k]}${n > 1 ? ` ×${n}` : ''}`);
  return parts.join(' · ') || '没有能控制的';
}

const helpOpen = ref(false);
async function toggleConnect() {
  if (toys.status === 'connected') await toys.disconnect();
  else await toys.connect();
}
</script>

<template>
  <div class="toy-panel" data-testid="toy-panel">
    <div class="conn">
      <span class="dot" :class="toys.status" />
      <span class="flex-1 min-w-0 text-[13.5px] truncate">{{ statusText }}</span>
      <button type="button" class="text-[12.5px] text-accent-ink shrink-0" @click="helpOpen = !helpOpen">{{ helpOpen ? '收起' : '怎么连' }}</button>
    </div>
    <div v-if="helpOpen" class="help">
      <p>1. 装 Intiface Central（电脑、安卓都行），打开蓝牙，在 Devices 里连上玩具，点 Start Server。</p>
      <p>2. Intiface 和这个页面在同一台设备上（电脑、安卓）：直连，地址填 {{ DEFAULT_INTIFACE_ADDRESS }}；浏览器问要不要允许访问本地网络设备时选允许。</p>
      <p>3. 这个页面开在 iPhone / iPad 上：苹果的浏览器不让 https 页面连 ws://，连本机的 Intiface 也不行（iPhone 上装 Intiface 连不上）。把 Intiface 装在电脑上，连接方式选"经云端中转"，把桥接链接发到那台电脑上用 Chrome / Edge / Firefox 打开（要先在 我的 → 云端与同步 连上自己的 Worker）。</p>
      <p>4. 也可以给 Intiface 套一层 https（例如 Caddy、cloudflared），直连填 wss://…。</p>
    </div>
    <Segmented v-model="s.link" :options="LINKS" class="mt-2.5" />
    <div class="flex gap-2 mt-2.5">
      <input
        v-if="s.link === 'direct'"
        v-model.trim="s.url"
        class="field"
        :disabled="toys.status !== 'idle'"
        :placeholder="DEFAULT_INTIFACE_ADDRESS"
        aria-label="Intiface Central 的地址"
        autocapitalize="off"
        spellcheck="false"
      />
      <span v-else class="field relay">{{ hub.connected ? `经 ${hubHost} 中转` : '还没连上自己的 Worker' }}</span>
      <van-button size="small" round :type="toys.status === 'connected' ? 'default' : 'primary'" :loading="toys.status === 'connecting'" loading-text="在连" data-testid="toy-connect" @click="toggleConnect">
        {{ toys.status === 'connected' ? '断开' : '连接' }}
      </van-button>
    </div>
    <p class="hint">{{ LINK_HINT[s.link] }}</p>
    <template v-if="s.link === 'relay'">
      <p v-if="relayBlocked === 'none'" class="err">
        先在 我的 → 云端与同步 连上自己的 Worker<button type="button" class="text-accent-ink ml-2" @click="router.push('/me/sync')">去设置</button>
      </p>
      <p v-else-if="relayBlocked === 'old'" class="err">云端的 Worker 还没有玩具中转：重新部署一次 Worker（推到 main 会自动部署）。</p>
      <template v-else>
        <div class="link" data-testid="toy-bridge-link">
          <span class="flex-1 min-w-0 truncate text-[12.5px] text-ink-2">{{ toys.bridgeLink || (linkBusy ? '正在取桥接链接…' : '还没有桥接链接') }}</span>
          <button type="button" class="mini" :disabled="!toys.bridgeLink" @click="copyWithToast(toys.bridgeLink)">复制</button>
          <button v-if="canShare" type="button" class="mini" :disabled="!toys.bridgeLink" @click="shareLink">分享</button>
        </div>
        <p v-if="linkError" class="err">
          {{ linkError }}<button type="button" class="text-accent-ink ml-2" @click="fetchLink()">再试一次</button>
        </p>
        <button type="button" class="text-[12px] text-ink-3 mt-1.5" :disabled="linkBusy" @click="rotateLink">换一个桥接链接（旧链接打开的桥接页会断开）</button>
      </template>
    </template>
    <p v-if="toys.error" class="err" role="alert">{{ toys.error }}</p>
    <p v-if="toys.sendError" class="err">{{ toys.sendError }}</p>

    <template v-if="toys.status === 'connected'">
      <div v-for="d in toys.devices" :key="d.index" class="device">
        <span class="i-lucide-heart-handshake text-[18px] text-accent-ink shrink-0" />
        <span class="flex-1 min-w-0">
          <span class="block text-[14px] truncate">{{ d.name }}</span>
          <span class="block text-[12px] text-ink-3 truncate">{{ featureLine(d) }}<template v-if="typeof toys.battery[d.index] === 'number'"> · 电量 {{ toys.battery[d.index] }}%</template></span>
        </span>
        <button type="button" class="mini" @click="toys.test(d)">试一下</button>
      </div>
      <button type="button" class="scan" :disabled="toys.scanning" @click="toys.scan()">
        <span :class="toys.scanning ? 'i-lucide-loader-circle spin' : 'i-lucide-radar'" />{{ toys.scanning ? '在找玩具…（Intiface 里配对过的会自己出现）' : toys.devices.length ? '再找找' : '找玩具' }}
      </button>
    </template>

    <div class="label">指令从哪来</div>
    <Segmented v-model="s.source" :options="SOURCES" />
    <p class="hint">{{ SOURCE_HINT[s.source] }}</p>
    <p v-if="s.source === 'separate' && !deviceStatus.live" class="err">
      「控制指令」还没接通：{{ deviceStatus.reason }}<button type="button" class="text-accent-ink ml-2" @click="router.push('/me/api?feature=device')">去设置</button>
    </p>

    <div class="label">强度上限（{{ characterPronoun(character) }}写得再重也不超过）</div>
    <div v-for="k in capKinds" :key="k" class="slide">
      <span class="w-10 shrink-0 text-[13px] text-ink-2">{{ TOY_KIND_LABEL[k] }}</span>
      <van-slider v-model="s.caps[k]" class="flex-1" :min="0" :max="100" bar-height="4px" button-size="16px" :aria-label="`${TOY_KIND_LABEL[k]}上限`" />
      <span class="num w-9 shrink-0 text-right text-[12.5px] text-ink-2">{{ s.caps[k] }}</span>
    </div>
    <template v-if="hasLinear">
      <div class="slide">
        <span class="w-10 shrink-0 text-[13px] text-ink-2" title="伸缩从底到顶一下最快多少毫秒">伸缩</span>
        <van-slider v-model="s.caps.strokeMs" class="flex-1" :min="150" :max="1500" :step="50" bar-height="4px" button-size="16px" aria-label="伸缩一下最快多少毫秒" />
        <span class="num w-16 shrink-0 text-right text-[12px] text-ink-2">{{ s.caps.strokeMs }}ms</span>
      </div>
      <div class="slide">
        <span class="w-10 shrink-0 text-[13px] text-ink-2">范围</span>
        <van-slider v-model="s.caps.posMin" class="flex-1" :min="0" :max="Math.max(0, s.caps.posMax - 10)" bar-height="4px" button-size="16px" aria-label="伸缩最低位置" />
        <van-slider v-model="s.caps.posMax" class="flex-1" :min="Math.min(100, s.caps.posMin + 10)" :max="100" bar-height="4px" button-size="16px" aria-label="伸缩最高位置" />
        <span class="num w-16 shrink-0 text-right text-[12px] text-ink-2">{{ s.caps.posMin }}–{{ s.caps.posMax }}</span>
      </div>
    </template>

    <div class="label">安全</div>
    <div class="text-[12.5px] text-ink-2 mb-1.5">多久没有新的指令就停下</div>
    <div class="flex gap-1.5 flex-wrap">
      <button v-for="o in SAFETY" :key="o.v" type="button" class="chip" :class="{ on: s.safetyMin === o.v }" @click="s.safetyMin = o.v">{{ o.label }}</button>
    </div>
    <label class="row">
      <span class="flex-1 text-[13.5px]">切到别的 App、锁屏时停下</span>
      <van-switch v-model="s.stopOnHide" size="20px" />
    </label>
    <label class="row">
      <span class="flex-1 min-w-0">
        <span class="block text-[13.5px]">没连玩具时也在心跳上试</span>
        <span class="block text-[12px] text-ink-3">照样写指令，只在界面上显示强度（试预设用）</span>
      </span>
      <van-switch v-model="s.simulate" size="20px" />
    </label>
    <div class="slide mt-2">
      <span class="shrink-0 text-[13px] text-ink-2">打字时读多快</span>
      <van-slider v-model="s.readCps" class="flex-1" :min="3" :max="20" bar-height="4px" button-size="16px" :aria-label="`打字时${characterPronoun(character)}的话按每秒几个字读`" />
      <span class="num w-14 shrink-0 text-right text-[12px] text-ink-2">{{ s.readCps }} 字/秒</span>
    </div>

    <template v-if="toys.lastWritten">
      <div class="label">上一次写的指令</div>
      <div class="last">
        <div class="text-[12px] text-ink-3 line-clamp-2">{{ characterPronoun(character) }}说：{{ toys.lastWritten.line }}</div>
        <div v-if="toys.lastWritten.error" class="text-[12.5px] text-bad mt-1">{{ toys.lastWritten.error }}</div>
        <div v-else-if="!toys.lastWritten.steps.length" class="text-[12.5px] text-ink-2 mt-1">这句不用变</div>
        <div v-for="(st, i) in toys.lastWritten.steps" :key="i" class="text-[12.5px] text-ink-2 mt-1">{{ st }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.conn {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ink-3);
}
.dot.connecting {
  background: var(--warn);
  animation: twinkle 1s infinite;
}
.dot.connected {
  background: var(--good);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--good) 25%, transparent);
}
.help {
  margin-top: 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-2);
}
.help p {
  margin: 0 0 4px;
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
.field:disabled {
  opacity: 0.6;
}
.field.relay {
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink-2);
  font-size: 13px;
}
.link {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--panel);
}
.err {
  margin: 8px 2px 0;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--bad);
}
.device {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding: 9px 10px;
  border-radius: 14px;
  background: var(--panel);
}
.mini {
  flex-shrink: 0;
  height: 28px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--accent-soft);
  border: 1px solid var(--accent-line);
  color: var(--accent-ink);
  font-size: 12.5px;
}
.scan {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
  font-size: 12.5px;
  color: var(--accent-ink);
}
.scan:disabled {
  color: var(--ink-3);
}
.label {
  margin: 16px 0 7px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.hint {
  margin: 7px 2px 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-3);
}
.slide {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 34px;
}
.chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.last {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
}
.spin {
  animation: spin 1s linear infinite;
}
</style>
