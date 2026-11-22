<script setup lang="ts">
import { ref } from 'vue';
import { showToast } from 'vant';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useHubStore } from '@/stores/hub';
import { SECRET_IDS, useServicesStore } from '@/stores/services';

/**
 * 我的 → 观影设置：一起观影里"逛 B 站"的搜索和收藏夹（参考 siios 的 Bilibili 设置：自己的 Worker + 登录 Cookie）。
 * 浏览器直接请求 B 站会被跨域和来源检查挡住，所以真的搜 B 站要经过你自己的云端 Hub（/v1/video/search）。
 * B 站 Cookie 只存在这台设备（secrets 表），搜索、读收藏夹时随请求发给你的 Hub：B 站对登录过的请求风控松一些，收藏夹要靠它知道是哪个账号。
 */
const svc = useServicesStore();
const hub = useHubStore();

const cookieDraft = ref(svc.biliCookie);
function saveCookie() {
  svc.setSecret(SECRET_IDS.biliCookie, cookieDraft.value);
}

const test = ref<{ ok: boolean; text: string } | null>(null);
const testing = ref(false);
async function testSearch() {
  saveCookie();
  if (!hub.connected) return showToast('先连云端 Hub');
  testing.value = true;
  test.value = null;
  try {
    const { hits } = await hub.searchVideos('周杰伦', svc.biliCookie);
    test.value = { ok: true, text: `B 站搜索 ✓ 搜"周杰伦"得到 ${hits.length} 个${hits[0] ? `，第一个：${hits[0].title}` : ''}` };
  } catch (e) {
    test.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="page" data-page="watch-settings">
    <PageHeader title="观影设置" subtitle="一起观影 · 逛 B 站" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title"><span class="i-lucide-tv" />Bilibili（逛 B 站）<span class="ml-auto text-[12px]">{{ hub.connected ? '真的搜 B 站' : '只在片单里找' }}</span></div>
      <van-cell-group inset>
        <van-cell title="云端 Hub" :value="hub.connected ? '已连接' : '未连接'" label="搜索经过它去 B 站" is-link to="/me/sync" />
        <van-field
          v-model="cookieDraft"
          label="B 站 Cookie"
          type="textarea"
          rows="2"
          autosize
          placeholder="SESSDATA=…（登录后的 Cookie：搜索不容易被风控，逛 B 站里的收藏夹要靠它）"
          autocomplete="off"
          data-testid="bili-cookie"
          @blur="saveCookie"
        />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :loading="testing" data-testid="bili-test" @click="testSearch">测试搜索</van-button>
        <div v-if="test?.ok" class="ok-line">{{ test.text }}</div>
        <ErrorDetails v-else-if="test" class="mt-2" :detail="test.text" :title="test.text" max-height="160px" />
      </div>
      <p class="note">
        浏览器不能直接请求 B 站（跨域、来源检查），所以逛 B 站的搜索经过你自己的云端 Hub：连上 Hub 就是真的搜 B 站；没连时只在每小时更新的推荐 / 番剧 / 热门 / 游戏片单里找，搜索结果上会写明。
      </p>
      <p class="note">
        B 站对 Cloudflare 的请求风控很严，不带 Cookie 时可能搜不到或者报 412；逛 B 站里的「收藏夹」读的是这份 Cookie 登录的账号自己建的收藏夹，不填就读不了。在电脑浏览器登录 bilibili.com，F12 →「Application / 存储」→ Cookie → 复制 <b>SESSDATA</b> 的值，填成 <code>SESSDATA=…</code>（只贴值也行）。
        Cookie 只存在这台设备、不进同步，搜索、读收藏夹时随请求发给你自己的 Hub，Hub 不存；大约一个月过期，过期了重新复制一次。Hub 要是旧版（提示"接口不存在"、搜索换不了一批、读不了收藏夹），重新部署一次 Hub。
      </p>
    </div>
  </div>
</template>

<style scoped>
.ok-line {
  margin-top: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--good);
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
code {
  font-size: 11.5px;
  word-break: break-all;
}
</style>
