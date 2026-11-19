<script setup lang="ts">
import { errorText } from '@app/ai';
import { ref, toRef, watch } from 'vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { testWeread, wereadConnection } from '@/services/weread';
import { useHubStore } from '@/stores/hub';
import { SECRET_IDS, useServicesStore, WEREAD_REVIEWS_MAX, type WereadSource } from '@/stores/services';

/**
 * 我的 → 看书设置：一起看书接微信读书（照 freestylefly/mcp-server-weread）。
 * - 云端 Hub 内置的微信读书 MCP：Cookie（或 CookieCloud）只存在这台设备，用的时候随请求头发给你自己的 Hub，Hub 不存；
 * - 自己部署的微信读书 MCP（Streamable HTTP，工具名和那个仓库一样）：填地址，要登录时填请求头；Cookie 配在那台服务器上。
 */
const svc = useServicesStore();
const hub = useHubStore();
/** 模板里直接用 store 的 reactive 时 vue-tsc 的类型收窄会丢，给它一个 Ref */
const weread = toRef(svc, 'weread');
void hub.ensureStatus();

const SOURCES: { value: WereadSource; label: string }[] = [
  { value: 'hub', label: '云端 Hub 内置' },
  { value: 'url', label: '自己的 MCP 地址' },
];

const cookieDraft = ref(svc.secrets[SECRET_IDS.wereadCookie] ?? '');
watch(() => svc.secrets[SECRET_IDS.wereadCookie] ?? '', (cookie, previous) => {
  if (cookieDraft.value === previous) cookieDraft.value = cookie;
});
const ccPasswordDraft = ref(svc.secrets[SECRET_IDS.cookieCloudPassword] ?? '');
const headerDraft = ref(svc.secrets[SECRET_IDS.wereadHeader] ?? '');
async function saveSecrets() {
  svc.setSecret(SECRET_IDS.wereadCookie, cookieDraft.value);
  svc.setSecret(SECRET_IDS.cookieCloudPassword, ccPasswordDraft.value);
  svc.setSecret(SECRET_IDS.wereadHeader, headerDraft.value);
  await svc.flushSecrets();
}

const test = ref<{ ok: boolean; text: string } | null>(null);
const testing = ref(false);
async function runTest() {
  await saveSecrets();
  test.value = null;
  const c = wereadConnection();
  if (!c.ok) {
    test.value = { ok: false, text: c.reason };
    return;
  }
  testing.value = true;
  try {
    test.value = { ok: true, text: await testWeread() };
  } catch (e) {
    test.value = { ok: false, text: errorText(e) };
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="page" data-page="read-settings">
    <PageHeader title="看书设置" subtitle="一起看书 · 微信读书" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title"><span class="i-lucide-book-open-text" />微信读书</div>
      <div class="px-4">
        <div class="seg" role="radiogroup" aria-label="怎么连微信读书">
          <button v-for="o in SOURCES" :key="o.value" type="button" role="radio" :aria-checked="weread.source === o.value" :class="{ on: weread.source === o.value }" @click="weread.source = o.value">{{ o.label }}</button>
        </div>
      </div>

      <van-cell-group v-if="weread.source === 'hub'" inset class="!mt-3">
        <van-cell title="云端 Hub" :value="hub.connected ? (hub.status && !hub.supportsWeread ? '版本太旧' : '已连接') : '未连接'" label="微信读书 MCP 在它上面" is-link to="/me/sync" />
        <van-field
          v-model="cookieDraft"
          label="Cookie"
          type="textarea"
          rows="2"
          autosize
          placeholder="微信读书网页版的 Cookie（wr_skey=…; wr_vid=…; …）"
          autocomplete="off"
          data-testid="weread-cookie"
          @blur="saveSecrets"
        />
        <van-field v-model="weread.cookieCloudUrl" label="CookieCloud" placeholder="可选：CookieCloud 服务器地址" autocomplete="off" />
        <van-field v-model="weread.cookieCloudId" label="用户 ID" placeholder="CookieCloud 的 UUID" autocomplete="off" />
        <van-field v-model="ccPasswordDraft" label="密码" type="password" placeholder="CookieCloud 的密码" autocomplete="off" @blur="saveSecrets" />
      </van-cell-group>

      <van-cell-group v-else inset class="!mt-3">
        <van-field v-model="weread.url" label="MCP 地址" placeholder="https://…/mcp" autocomplete="off" data-testid="weread-url" />
        <van-field v-model="weread.headerName" label="请求头" placeholder="Authorization" autocomplete="off" />
        <van-field v-model="headerDraft" label="请求头的值" type="password" placeholder="可选：Bearer …" autocomplete="off" @blur="saveSecrets" />
      </van-cell-group>

      <van-cell-group inset class="!mt-3">
        <van-cell title="热门书评" label="取一本书时带上几条别人的书评，单独一章（0 = 不带）" center>
          <template #right-icon><van-stepper v-model="weread.reviews" min="0" :max="WEREAD_REVIEWS_MAX" integer input-width="44px" class="shrink-0" /></template>
        </van-cell>
      </van-cell-group>

      <div class="px-4 mt-3">
        <van-button round block :loading="testing" data-testid="weread-test" @click="runTest">测试连接</van-button>
        <div v-if="test?.ok" class="ok-line">{{ test.text }}</div>
        <ErrorDetails v-else-if="test" class="mt-2" :detail="test.text" :title="test.text" max-height="160px" />
      </div>

      <p class="note">
        接上以后，在书架的"微信读书"页签点一本书，就会按目录逐章取全书正文，连同你的划线、想法和几条热门书评放上我们的书架。导入时会显示已取好的章节数；以前只导入了笔记的书，可以在更多操作里点"从微信读书获取全书正文"。书存在这台设备上，陪读时只把当前读到的段落交给Ta。
      </p>
      <p class="note" v-if="weread.source === 'hub'">
        Cookie：电脑浏览器登录 weread.qq.com，F12 →「Network / 网络」，刷新，点一个 weread.qq.com 的请求，复制请求头里 Cookie 的整段。更新 Hub 后，读取书架、目录和正文时会自动保存微信读书返回的新 Cookie，重开 App 继续使用。登录被撤销或长时间不用仍可能需要重新登录。也可装 CookieCloud 浏览器插件（同步域名填 weread，保活填 https://weread.qq.com），再填上面三项，让 Hub 取浏览器同步的 Cookie。
        Cookie 和 CookieCloud 密码只存在这台设备、不进同步，用的时候随请求发给你自己的 Hub，Hub 不存。
      </p>
      <p class="note" v-else>
        自己部署的服务器要用 Streamable HTTP，除了书架、笔记工具，还需支持 get_book_catalog 和 get_book_chapter，才能获取正文。微信读书的 Cookie 配在那台服务器上。浏览器直连时对方要允许跨域。
      </p>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  padding: 3px;
  border-radius: 99px;
  background: var(--panel);
}
.seg button {
  flex: 1;
  height: 32px;
  border-radius: 99px;
  font-size: 13.5px;
  color: var(--ink-2);
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-weight: 600;
}
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
</style>
