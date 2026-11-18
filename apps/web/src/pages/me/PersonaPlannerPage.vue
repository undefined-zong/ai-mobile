<script setup lang="ts">
import {
  argsDraft,
  MCP_AUTH_LABEL,
  MCP_KIND_LABEL,
  MCP_TEMPLATES,
  PLANNER_LIMITS,
  PLANNER_MACROS,
  WEEKDAY_LABEL,
  WEEKDAY_ORDER,
  type McpAuthMode,
  type McpServerConfig,
  type McpToolInfo,
  type McpServerKind,
  type McpTemplate,
} from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import PageHeader from '@/layouts/PageHeader.vue';
import { applyDiscovery, clientSecret, discover, finishOAuth, forgetServer, headerValue, listServerTools, redirectUri, saveClientSecret, saveHeaderValue, startOAuth } from '@/services/mcp';
import { useAiStore } from '@/stores/ai';
import { useCharacterStore } from '@/stores/characters';
import { useHubStore } from '@/stores/hub';
import { usePersonaStore } from '@/stores/personas';
import { copyText } from '@/utils/errors';
import { uid } from '@/utils/id';

/**
 * 人设 → 日程系统（设计文档 §9.15）：
 * - 接上邮箱和日程软件的 MCP 服务器（Gmail、Google 日历的官方 MCP 用 OAuth 登录；别的填地址和 Token），列出工具，勾上 AI 能用的（只勾查询类的），
 *   也可以写"每次都先查"的工具和参数；
 * - 你的情况（上班上课时间、这阵子的目标）、谁帮你排、每天几点排、一周从哪天开始、这周的计划多久重排一次、写不写进聊天；
 * - AI 自己查最多几轮、每轮调几个工具、每个结果留多少字。
 * 地址、设置存在本机的人设里；Token、Client Secret 只存在本机的 secrets 表，连了云端时加密存在你的 Worker 里。
 */
const route = useRoute();
const personas = usePersonaStore();
const persona = computed(() => personas.byId(route.params.id as string) ?? personas.defaultPersona);
const s = computed(() => personas.planner(persona.value));
const hub = useHubStore();
const ai = useAiStore();
const chars = useCharacterStore();
const status = computed(() => ai.status('planner'));
const cloud = computed(() => hub.connected && hub.supportsPlanner);
void hub.ensureStatus();

function touch() {
  personas.touch(persona.value);
}

const open = ref<string | null>(null);
/** 每台服务器的密钥输入框（只在本机） */
const secrets = reactive<Record<string, { header: string; client: string; shown: boolean }>>({});
const busy = reactive<Record<string, string | undefined>>({});
const pasted = reactive<Record<string, string>>({});
const showAdvanced = reactive<Record<string, boolean>>({});

async function loadSecrets(id: string) {
  if (secrets[id]) return;
  secrets[id] = { header: await headerValue(id), client: await clientSecret(id), shown: false };
}
watch(open, (id) => id && void loadSecrets(id), { immediate: true });

function templateOf(server: McpServerConfig): McpTemplate | undefined {
  return MCP_TEMPLATES.find((t) => t.url && t.url === server.url);
}

function addServer(t: McpTemplate) {
  const server: McpServerConfig = {
    id: uid('mcp'),
    name: t.name,
    kind: t.kind,
    enabled: true,
    url: t.url,
    auth: t.auth,
    headerName: 'Authorization',
    oauth: t.auth === 'oauth' ? { authorizationEndpoint: '', tokenEndpoint: '', clientId: '', scope: t.scope ?? '', extraParams: t.extraParams ?? '', resource: true, authMethod: 'post' } : null,
    authorized: null,
    tools: [],
    toolsAt: null,
    allowed: [],
    fixed: [],
  };
  s.value.servers.push(server);
  open.value = server.id;
  touch();
}

async function removeServer(server: McpServerConfig) {
  const ok = await showConfirmDialog({ title: `删掉"${server.name}"？`, message: '这台服务器的地址、Token 一起删掉（云端那一份下次同步时删）。', confirmButtonText: '删掉', confirmButtonColor: 'var(--bad)' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  s.value.servers = s.value.servers.filter((x) => x.id !== server.id);
  await forgetServer(server.id);
  touch();
}

function setKind(server: McpServerConfig, kind: McpServerKind) {
  server.kind = kind;
  touch();
}
function setAuth(server: McpServerConfig, auth: McpAuthMode) {
  server.auth = auth;
  server.authorized = null;
  if (auth === 'oauth' && !server.oauth) server.oauth = { authorizationEndpoint: '', tokenEndpoint: '', clientId: '', scope: '', extraParams: '', resource: true, authMethod: 'post' };
  touch();
}
/** 地址改了：之前的授权、工具清单都对不上了 */
function urlChanged(server: McpServerConfig) {
  server.url = server.url.trim();
  if (server.authorized && server.auth === 'oauth') {
    server.authorized = null;
    showToast('地址改了，要重新授权');
  }
  if (server.oauth) Object.assign(server.oauth, { authorizationEndpoint: '', tokenEndpoint: '', registrationEndpoint: undefined });
  server.tools = [];
  server.toolsAt = null;
  touch();
}

async function saveHeader(server: McpServerConfig) {
  const v = secrets[server.id]?.header.trim() ?? '';
  if (!(await saveHeaderValue(server.id, v))) showToast('本机存储写不进去');
  touch();
}
async function saveClient(server: McpServerConfig) {
  const v = secrets[server.id]?.client.trim() ?? '';
  if (!(await saveClientSecret(server.id, v))) showToast('本机存储写不进去');
  touch();
}

function authState(server: McpServerConfig): { text: string; on: boolean } {
  if (!server.url) return { text: '没填地址', on: false };
  if (server.auth === 'none') return { text: '不用登录', on: true };
  if (server.auth === 'header') return { text: '请求头', on: true };
  if (server.authorized) return { text: server.authorized.via === 'hub' ? '已授权 · 云端' : '已授权 · 本机', on: true };
  return { text: '没授权', on: false };
}

async function runStep(server: McpServerConfig, label: string, fn: () => Promise<void>) {
  busy[server.id] = label;
  try {
    await fn();
  } catch (e) {
    showToast({ message: e instanceof Error ? e.message : String(e), duration: 4000 });
  } finally {
    busy[server.id] = undefined;
  }
}

function detect(server: McpServerConfig) {
  return runStep(server, '检测中', async () => {
    if (!server.url) throw new Error('先填地址');
    applyDiscovery(server, await discover(server.url));
    touch();
    showToast(server.oauth?.registrationEndpoint ? '找到了，支持自动注册（Client ID 可以留空）' : '找到了，要填自己的 Client ID');
  });
}
function login(server: McpServerConfig) {
  return runStep(server, '准备登录', async () => {
    await saveClient(server);
    await startOAuth(persona.value.id, server);
  });
}
function finishPasted(server: McpServerConfig) {
  return runStep(server, '换 Token', async () => {
    await finishOAuth((pasted[server.id] ?? '').trim());
    pasted[server.id] = '';
    showToast('授权好了');
  });
}

function listTools(server: McpServerConfig) {
  return runStep(server, '连接中', async () => {
    if (server.auth === 'header') await saveHeader(server);
    const first = !server.toolsAt;
    server.tools = await listServerTools(server);
    server.toolsAt = Date.now();
    // 第一次列出来：默认全勾（邮箱只勾只读的）；以后只去掉已经没有的
    const names = new Set(server.tools.map((t) => t.name));
    server.allowed = first ? server.tools.filter((t) => toolAllowed(server, t)).map((t) => t.name) : server.allowed.filter((n) => names.has(n));
    touch();
    showToast(`有 ${server.tools.length} 个工具`);
  });
}
/** 邮箱只能用只读的工具 */
function toolAllowed(server: McpServerConfig, t: McpToolInfo): boolean {
  return server.kind !== 'mail' || !!t.readOnly;
}
function toggleTool(server: McpServerConfig, name: string) {
  server.allowed = server.allowed.includes(name) ? server.allowed.filter((n) => n !== name) : [...server.allowed, name];
  touch();
}

function addFixed(server: McpServerConfig) {
  const tool = server.tools.find((t) => server.allowed.includes(t.name)) ?? server.tools[0];
  server.fixed.push({ id: uid('fx'), tool: tool?.name ?? '', args: tool ? argsDraft(tool.inputSchema) : '{}' });
  touch();
}
function fixedToolChanged(server: McpServerConfig, i: number) {
  const f = server.fixed[i];
  const tool = server.tools.find((t) => t.name === f?.tool);
  if (f && tool) f.args = argsDraft(tool.inputSchema);
  touch();
}
function argsError(args: string): string {
  try {
    const v = JSON.parse(args.replace(/\{\{\s*\w+\s*\}\}/g, 'x')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? '' : '要是一个 JSON 对象';
  } catch {
    return 'JSON 格式不对（变量要写在引号里）';
  }
}

const WEEK_REFRESH = [
  { value: 'start' as const, label: '一周第一天排一次' },
  { value: 'daily' as const, label: '每天跟着重排' },
];
const macroText = Object.entries(PLANNER_MACROS)
  .map(([k, v]) => `{{${k}}} ${v}`)
  .join('；');

function stepper(key: 'maxRounds' | 'maxCalls' | 'resultChars') {
  return { min: PLANNER_LIMITS[key][0], max: PLANNER_LIMITS[key][1] };
}
</script>

<template>
  <div class="page" data-page="persona-planner">
    <PageHeader title="日程系统" :subtitle="`${persona.name} · 接邮箱和日程，每天排计划`" fallback="/me/personas" />
    <div class="page-scroll pb-8">
      <div class="mx-4 mt-3 card-box flex items-center gap-3">
        <span class="big-icon"><span class="i-lucide-calendar-check" /></span>
        <div class="flex-1 min-w-0">
          <div class="text-[15px] font-600">打开日程系统</div>
          <div class="text-[12px] text-ink-3 leading-relaxed">每天到点（默认凌晨 4 点）看一遍新邮件、日程软件里的安排、家务和健康计划，排出这周和今天的计划；她也会知道你今天要忙什么</div>
        </div>
        <van-switch v-model="s.enabled" size="22px" data-testid="planner-switch" @change="touch" />
      </div>
      <RouterLink v-if="s.enabled" to="/me/planner" class="go mx-4 mt-2"><span class="i-lucide-arrow-right" />去看日程计划</RouterLink>

      <div v-if="!status.live" class="notice mx-4 mt-3">
        <span class="i-lucide-plug-zap shrink-0" />
        <span class="flex-1 min-w-0">「日程计划」还没接通：{{ status.reason }}</span>
        <RouterLink to="/me/api?feature=planner" class="text-accent-ink shrink-0">去设置</RouterLink>
      </div>
      <div class="notice mx-4 mt-2" data-testid="planner-cloud">
        <span :class="cloud ? 'i-lucide-cloud' : 'i-lucide-cloud-off'" class="shrink-0" />
        <span v-if="cloud" class="flex-1 min-w-0">连着云端：每天 {{ s.runAt }} 由你的 Worker 排，App 关着也排；授权拿到的 Token 只存在 Worker 里</span>
        <span v-else-if="hub.connected" class="flex-1 min-w-0">云端的 Worker 版本太旧，没有日程系统：部署最新的 Worker 和数据库迁移后才会在云端排</span>
        <span v-else class="flex-1 min-w-0">没连云端：只在打开 App 时补排。Gmail、Google 日历这类服务器多半不让浏览器直连，建议连上云端</span>
        <RouterLink v-if="!cloud" to="/me/sync" class="text-accent-ink shrink-0">云端与同步</RouterLink>
      </div>

      <div class="group-title">邮箱和日程（MCP）</div>
      <div class="mx-4 grid gap-2.5">
        <div v-for="server in s.servers" :key="server.id" class="card-box !p-0 overflow-hidden" :data-server="server.id">
          <button type="button" class="srv-head" :aria-expanded="open === server.id" @click="open = open === server.id ? null : server.id">
            <span class="sys-icon"><span :class="MCP_KIND_LABEL[server.kind].icon" /></span>
            <span class="flex-1 min-w-0 text-left">
              <span class="block text-[14.5px] font-600 truncate">{{ server.name }}</span>
              <span class="block text-[12px] text-ink-3 truncate">{{ server.url || '还没填地址' }}</span>
            </span>
            <span class="chip" :class="{ on: authState(server).on }">{{ authState(server).text }}</span>
            <van-switch v-model="server.enabled" size="18px" @click.stop @change="touch" />
          </button>

          <div v-if="open === server.id" class="px-3.5 pb-3.5">
            <p v-if="templateOf(server)" class="hint">{{ templateOf(server)!.hint }}</p>
            <div class="grid grid-cols-[1fr_auto] gap-x-2 items-end">
              <div>
                <label class="field-label !mt-1" :for="`sn-${server.id}`">名字</label>
                <input :id="`sn-${server.id}`" v-model="server.name" class="input" maxlength="40" @change="touch" />
              </div>
              <div class="flex gap-1">
                <button v-for="(k, key) in MCP_KIND_LABEL" :key="key" type="button" class="opt" :class="{ on: server.kind === key }" @click="setKind(server, key)">{{ k.label }}</button>
              </div>
            </div>
            <label class="field-label" :for="`su-${server.id}`">MCP 地址（Streamable HTTP，https）</label>
            <input :id="`su-${server.id}`" v-model="server.url" class="input" inputmode="url" placeholder="https://…/mcp" @change="urlChanged(server)" />

            <div class="field-label">登录方式</div>
            <div class="flex flex-wrap gap-1.5">
              <button v-for="(label, mode) in MCP_AUTH_LABEL" :key="mode" type="button" class="opt" :class="{ on: server.auth === mode }" @click="setAuth(server, mode)">{{ label }}</button>
            </div>

            <template v-if="server.auth === 'header' && secrets[server.id]">
              <div class="grid grid-cols-[38%_1fr] gap-2">
                <div>
                  <label class="field-label" :for="`sh-${server.id}`">请求头</label>
                  <input :id="`sh-${server.id}`" v-model="server.headerName" class="input" @change="touch" />
                </div>
                <div>
                  <label class="field-label" :for="`sv-${server.id}`">值（只存在本机）</label>
                  <input :id="`sv-${server.id}`" v-model="secrets[server.id]!.header" class="input" :type="secrets[server.id]!.shown ? 'text' : 'password'" placeholder="Bearer …" autocomplete="off" @change="saveHeader(server)" />
                </div>
              </div>
              <button type="button" class="text-[12px] text-ink-3 mt-1" @click="secrets[server.id]!.shown = !secrets[server.id]!.shown">{{ secrets[server.id]!.shown ? '隐藏' : '显示' }}</button>
            </template>

            <template v-if="server.auth === 'oauth' && server.oauth && secrets[server.id]">
              <div class="flex items-center gap-2 mt-2.5">
                <van-button size="small" round :loading="busy[server.id] === '检测中'" @click="detect(server)">检测授权服务器</van-button>
                <span class="text-[12px] text-ink-3 truncate">{{ server.oauth.issuer || (server.oauth.authorizationEndpoint ? '已填' : '还没检测') }}</span>
              </div>
              <label class="field-label" :for="`ci-${server.id}`">Client ID{{ server.oauth.registrationEndpoint ? '（可以留空，登录时自动注册）' : '' }}</label>
              <input :id="`ci-${server.id}`" v-model="server.oauth.clientId" class="input" autocomplete="off" @change="touch" />
              <label class="field-label" :for="`cs-${server.id}`">Client Secret（Google 的"Web 应用"要填；只存在本机）</label>
              <input :id="`cs-${server.id}`" v-model="secrets[server.id]!.client" class="input" type="password" autocomplete="off" @change="saveClient(server)" />
              <label class="field-label" :for="`sc-${server.id}`">权限（scope，空格隔开；只要读的就够）</label>
              <textarea :id="`sc-${server.id}`" v-model="server.oauth.scope" class="textarea !min-h-[56px]" @change="touch" />
              <div class="field-label">回调地址（加进 OAuth Client 的"已获授权的重定向 URI"）</div>
              <div class="flex items-center gap-2">
                <code class="redirect">{{ redirectUri() }}</code>
                <button type="button" class="text-accent-ink text-[13px] shrink-0" @click="copyText(redirectUri()).then(() => showToast('复制了'))">复制</button>
              </div>
              <button type="button" class="text-[12.5px] text-ink-3 mt-2" @click="showAdvanced[server.id] = !showAdvanced[server.id]">{{ showAdvanced[server.id] ? '收起高级设置' : '高级设置' }}</button>
              <template v-if="showAdvanced[server.id]">
                <label class="field-label" :for="`ae-${server.id}`">授权地址</label>
                <input :id="`ae-${server.id}`" v-model="server.oauth.authorizationEndpoint" class="input" inputmode="url" @change="touch" />
                <label class="field-label" :for="`te-${server.id}`">换 Token 的地址</label>
                <input :id="`te-${server.id}`" v-model="server.oauth.tokenEndpoint" class="input" inputmode="url" @change="touch" />
                <label class="field-label" :for="`xp-${server.id}`">额外的授权参数（Google 要 access_type=offline&amp;prompt=consent 才给 Refresh Token）</label>
                <input :id="`xp-${server.id}`" v-model="server.oauth.extraParams" class="input" @change="touch" />
                <div class="field-label">Client Secret 怎么带</div>
                <div class="flex flex-wrap gap-1.5">
                  <button v-for="m in (['post', 'basic'] as const)" :key="m" type="button" class="opt" :class="{ on: server.oauth.authMethod === m }" @click="(server.oauth!.authMethod = m), touch()">{{ m === 'post' ? '表单里' : 'Basic 头' }}</button>
                </div>
                <div class="flex items-center gap-3 mt-3">
                  <span class="flex-1 text-[13px]">带上 resource 参数（MCP 规范要求；授权服务器报错时关掉）</span>
                  <van-switch v-model="server.oauth.resource" size="18px" @change="touch" />
                </div>
              </template>
              <div class="flex items-center gap-2 mt-3">
                <van-button type="primary" size="small" round :loading="busy[server.id] === '准备登录'" :disabled="!server.url" data-testid="mcp-login" @click="login(server)">{{ server.authorized ? '重新授权' : '登录授权' }}</van-button>
                <span class="text-[12px] text-ink-3">{{ cloud ? 'Token 交给你的 Worker 保存' : 'Token 存在本机' }}</span>
              </div>
              <div class="flex gap-2 mt-2">
                <input v-model="pasted[server.id]" class="input !h-[34px]" placeholder="授权后没跳回来？把地址栏的网址粘贴到这里" aria-label="粘贴授权后的网址" />
                <van-button size="small" round :disabled="!pasted[server.id]" :loading="busy[server.id] === '换 Token'" @click="finishPasted(server)">完成</van-button>
              </div>
            </template>

            <div class="field-label flex items-center">
              <span class="flex-1">工具（勾上的 AI 才能调{{ server.kind === 'mail' ? '；邮箱只能用只读的' : '' }}）</span>
              <van-button size="mini" round :loading="busy[server.id] === '连接中'" :disabled="!server.url" data-testid="mcp-tools" @click="listTools(server)">{{ server.toolsAt ? '重新列出' : '列出工具' }}</van-button>
            </div>
            <p v-if="!server.tools.length" class="text-[12.5px] text-ink-3 my-1">还没列出来（要先授权或填好 Token）</p>
            <label v-for="t in server.tools" :key="t.name" class="tool">
              <input type="checkbox" :checked="server.allowed.includes(t.name) && toolAllowed(server, t)" :disabled="!toolAllowed(server, t)" @change="toggleTool(server, t.name)" />
              <span class="flex-1 min-w-0">
                <span class="text-[13.5px] font-600">{{ t.title || t.name }}</span>
                <span v-if="t.title" class="text-[11.5px] text-ink-3 ml-1">{{ t.name }}</span>
                <span v-if="t.readOnly" class="badge">只读</span>
                <span v-else-if="t.destructive" class="badge bad">会删改东西</span>
                <span v-else class="badge warn">没标只读</span>
                <span class="block text-[12px] text-ink-3 line-clamp-2">{{ t.description }}</span>
              </span>
            </label>

            <div class="field-label flex items-center">
              <span class="flex-1">每次都先查（可以不写，AI 会自己查）</span>
              <van-button size="mini" round :disabled="!server.tools.length" @click="addFixed(server)">加一个</van-button>
            </div>
            <div v-for="(f, i) in server.fixed" :key="f.id" class="fixed-call">
              <div class="flex items-center gap-2">
                <select v-model="f.tool" class="input !h-[34px] flex-1" :aria-label="`第 ${i + 1} 个每次都查的工具`" @change="fixedToolChanged(server, i)">
                  <option v-for="t in server.tools" :key="t.name" :value="t.name">{{ t.title || t.name }}</option>
                  <option v-if="f.tool && !server.tools.some((t) => t.name === f.tool)" :value="f.tool">{{ f.tool }}（没列出来）</option>
                </select>
                <button type="button" class="text-bad text-[13px]" @click="(server.fixed.splice(i, 1), touch())">删</button>
              </div>
              <textarea v-model="f.args" class="textarea mono !min-h-[110px] mt-1.5" spellcheck="false" :aria-label="`第 ${i + 1} 个的参数`" @change="touch" />
              <p v-if="argsError(f.args)" class="text-[12px] text-bad m-0">{{ argsError(f.args) }}</p>
            </div>
            <p v-if="server.fixed.length" class="hint">参数里能用的变量（按你的时区）：{{ macroText }}</p>

            <button type="button" class="text-[13px] text-bad mt-3" @click="removeServer(server)">删掉这台服务器</button>
          </div>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="t in MCP_TEMPLATES" :key="t.key" type="button" class="add-opt" :data-template="t.key" @click="addServer(t)"><span class="i-lucide-plus" />{{ t.name }}</button>
        </div>
        <p class="text-[12px] text-ink-3 m-0 leading-relaxed">日程软件可以不接；Todoist、Notion、滴答清单这类有 MCP 的，填它们的地址（支持自动注册的 Client ID 可以留空）。</p>
      </div>

      <div class="group-title">排计划</div>
      <div class="mx-4 card-box">
        <label class="field-label !mt-0" for="pl-note">你的情况（作息、上班上课时间、这阵子的目标、排计划的偏好）</label>
        <textarea id="pl-note" v-model="s.note" class="textarea !min-h-[90px]" placeholder="例如：工作日 9:30–18:30 上班，通勤 40 分钟；这个月在准备雅思；晚上 10 点以后不排事" @change="touch" />

        <div class="field-label">谁帮你排（计划里那句提醒用她的口吻；可以不选）</div>
        <div class="flex flex-wrap gap-1.5">
          <button type="button" class="opt" :class="{ on: !s.characterId }" @click="(s.characterId = null), touch()">不选</button>
          <button v-for="c in chars.list" :key="c.id" type="button" class="opt" :class="{ on: s.characterId === c.id }" @click="(s.characterId = c.id), touch()">{{ c.name }}</button>
        </div>

        <div class="grid grid-cols-2 gap-x-3">
          <div>
            <label class="field-label" for="pl-run">每天几点排</label>
            <input id="pl-run" v-model="s.runAt" class="input" type="time" required @change="touch" />
          </div>
          <div>
            <label class="field-label" for="pl-week">一周从哪天开始</label>
            <select id="pl-week" v-model.number="s.weekStart" class="input" @change="touch">
              <option v-for="d in WEEKDAY_ORDER" :key="d" :value="d">{{ WEEKDAY_LABEL[d] }}</option>
            </select>
          </div>
        </div>
        <div class="field-label">这周的计划</div>
        <div class="flex flex-wrap gap-1.5">
          <button v-for="o in WEEK_REFRESH" :key="o.value" type="button" class="opt" :class="{ on: s.weekRefresh === o.value }" @click="(s.weekRefresh = o.value), touch()">{{ o.label }}</button>
        </div>
        <div class="flex items-center gap-3 mt-3.5">
          <div class="flex-1 min-w-0">
            <div class="text-[14px]">写进聊天</div>
            <div class="text-[12px] text-ink-3 leading-relaxed">聊天、通话、一起做事、主动消息里她知道你今天的安排（预设里"日程：你怎么反应"那一块决定她怎么说）</div>
          </div>
          <van-switch v-model="s.inChat" size="20px" @change="touch" />
        </div>

        <div class="field-label">AI 自己查</div>
        <div class="day-row">
          <span class="flex-1 text-[13.5px]">最多几轮（0 = 只查"每次都先查"的）</span>
          <van-stepper v-model="s.maxRounds" v-bind="stepper('maxRounds')" integer button-size="26px" input-width="40px" @change="touch" />
        </div>
        <div class="day-row">
          <span class="flex-1 text-[13.5px]">每轮最多调几个工具</span>
          <van-stepper v-model="s.maxCalls" v-bind="stepper('maxCalls')" integer button-size="26px" input-width="40px" @change="touch" />
        </div>
        <div class="day-row">
          <span class="flex-1 text-[13.5px]">每个结果最多留多少字</span>
          <van-stepper v-model="s.resultChars" v-bind="stepper('resultChars')" :step="500" integer button-size="26px" input-width="56px" @change="touch" />
        </div>
      </div>
      <p class="note">地址和设置存在这台设备的人设里；Token、Client Secret 只存在本机，连了云端时加密存在你的 Worker 里（读不回来）。排计划时查到的邮件、日程只发给「日程计划」用的模型（API 设置里能单独设置，默认跟随主对话），提示词在预设"计划"一类里改。</p>
    </div>
  </div>
</template>

<style scoped>
.card-box {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.big-icon,
.sys-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  flex-shrink: 0;
}
.big-icon {
  width: 42px;
  height: 42px;
  border-radius: 14px;
  font-size: 21px;
}
.sys-icon {
  width: 34px;
  height: 34px;
  font-size: 17px;
}
.go {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--accent-ink);
  text-decoration: none;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.srv-head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 12px 14px;
}
.chip {
  flex-shrink: 0;
  max-width: 30%;
  padding: 2px 8px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 32px;
  padding: 0 12px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.opt.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
  outline: 1px solid var(--accent-line);
}
.add-opt {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 34px;
  padding: 0 12px;
  border-radius: 99px;
  border: 1.5px dashed var(--border);
  color: var(--ink-2);
  font-size: 13px;
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
  overflow-wrap: anywhere;
}
.redirect {
  flex: 1;
  min-width: 0;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--panel);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.tool {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 0;
  border-top: 1px solid var(--border);
}
.tool input {
  margin-top: 3px;
}
.badge {
  display: inline-block;
  margin-left: 6px;
  padding: 0 6px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11px;
  line-height: 18px;
}
.badge.warn {
  background: var(--panel);
  color: var(--ink-3);
}
.badge.bad {
  background: var(--panel);
  color: var(--bad);
}
.fixed-call {
  padding: 8px 0;
  border-top: 1px solid var(--border);
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12.5px;
}
.day-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 5px 0;
}
.note {
  margin: 14px 16px 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
</style>
