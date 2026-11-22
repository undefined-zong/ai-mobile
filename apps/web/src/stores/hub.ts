import type { McpCallResult, McpOAuthDiscovery } from '@app/ai';
import { AGENT_META, apiKeyId, DEFAULT_PROACTIVE_RULES, packProactiveContext, watchWorkoutLine, type HubWatchWorkouts, type WatchWorkout, type HubCommunityPosts, type HubHealthResults, type HubParallelNotes, type HubParallelPlans, type HubPlannerResults, type McpOAuthConfig, type McpOAuthToken, type McpServerConfig, type McpToolInfo, type PlannerRunResult, type HubInbox, type HubMemoryResults, type HubMoments, type HubStatus, type HubTouchpoint,
  type Character, type HubDiaries, type HubRhythms, type Message, type NotificationPreview, type ProactiveContext, type ProactiveCredentials, type VideoHit } from '@app/shared';
import { defineStore } from 'pinia';
import { computed, reactive, ref, watch } from 'vue';
import { getOne, msgKey, write } from '@/db/idb';
import { applyMemoryOps, packConsolidation } from '@/services/consolidate';
import { alwaysOn, memoryBlocks } from '@/services/memoryBlocks';
import { personaOf } from '@/services/prompt';
import { homeBlock, lifeFlags } from '@/services/homeBlock';
import { settleSyncJobs } from '@/services/hubSync';
import { communityCloudContext, receiveHubPosts } from '@/services/community';
import { receiveHubMoments, socialCloudContext } from '@/services/social';
import { parallelCloudContext, parallelPlanCloudContexts, receiveHubNotes } from '@/services/parallel';
import { diaryCloudContext, receiveHubDiaries } from '@/services/diary';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useChatStore } from './chat';
import { useCommunityStore } from './community';
import { useEnvironmentStore } from './environment';
import { useLibraryStore } from './library';
import { useMemoryStore } from './memory';
import { afterSummarized, lastN, useMessageSettingsStore } from './messageSettings';
import { useRhythmStore } from './rhythm';
import { useHealthStore } from './health';
import { useParallelStore } from './parallel';
import { useDiaryStore } from './diary';
import { useServicesStore } from './services';
import { useSocialStore } from './social';
import { usePersonaStore } from './personas';
import { usePlannerStore } from './planner';
import { localSecret, localToken, saveLocalToken } from '@/services/mcp';
import { configureSync, runSync, syncState, type SyncApi } from '@/services/sync';

/** Worker 回的错误（带 HTTP 状态：409 是别的设备先更新了同一份上下文） */
class HubError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
interface SavedHub {
  url: string; cursor: number; deviceId: string; active: boolean; preview: NotificationPreview;
  revisions: Record<string, number>; hashes: Record<string, string>; apiHash: string;
  rhythmRevisions: Record<string, number>; rhythmHashes: Record<string, string>; rhythmApiHash: string;
  /** 记忆整理：每个角色上传过的版本和内容指纹、API 指纹、已经应用到哪一次云端结果 */
  memoryRevisions?: Record<string, number>; memoryHashes?: Record<string, string>; memoryApiHash?: string; memoryAppliedAt?: number;
  /** 朋友圈：每个角色上传过的版本和内容指纹、API 指纹 */
  socialRevisions?: Record<string, number>; socialHashes?: Record<string, string>; socialApiHash?: string;
  /** 社群：每个社群上传过的版本和内容指纹（API 用朋友圈的那一份） */
  communityRevisions?: Record<string, number>; communityHashes?: Record<string, string>;
  /** 日程计划：每个人设上传过的版本和内容指纹、API 指纹、每台 MCP 服务器上传过的密钥指纹 */
  plannerRevisions?: Record<string, number>; plannerHashes?: Record<string, string>; plannerApiHash?: string; plannerMcpHashes?: Record<string, string>;
  /** 平行时空：每个角色上传过的版本和内容指纹、API 指纹 */
  parallelRevisions?: Record<string, number>; parallelHashes?: Record<string, string>; parallelApiHash?: string;
  /** 日记：每个角色上传过的版本和内容指纹、API 指纹 */
  diaryRevisions?: Record<string, number>; diaryHashes?: Record<string, string>; diaryApiHash?: string;
  /** 健康计划：每个人设上传过的版本和内容指纹、API 指纹 */
  healthRevisions?: Record<string, number>; healthHashes?: Record<string, string>; healthApiHash?: string; healthCursor?: number;
  /** 给云端的 Google 地图 Key 上传过的指纹（空 = 没传） */
  mapsCloudHash?: string;
  /** 手表的运动数据拉到哪了（workout_ingest 的 seq） */
  watchCursor?: number;
  /** 上报令牌（快捷指令、Health Auto Export 用；云端只存哈希，这里留一份方便再复制。hub 这一项不进多设备同步） */
  ingestToken?: string;
  /** 平行时空里整理你的一天：每个人设上传过的版本和内容指纹（API 用平行时空的那一份） */
  parallelPlanRevisions?: Record<string, number>; parallelPlanHashes?: Record<string, string>;
  lastSyncAt?: number;
}
export const useHubStore = defineStore('hub', () => {
  const config = reactive<SavedHub>({ url: '', cursor: 0, deviceId: '', active: false, preview: 'name-only', revisions: {}, hashes: {}, apiHash: '', rhythmRevisions: {}, rhythmHashes: {}, rhythmApiHash: '',
    memoryRevisions: {}, memoryHashes: {}, memoryApiHash: '', memoryAppliedAt: 0, socialRevisions: {}, socialHashes: {}, socialApiHash: '', communityRevisions: {}, communityHashes: {},
    plannerRevisions: {}, plannerHashes: {}, plannerApiHash: '', plannerMcpHashes: {}, parallelRevisions: {}, parallelHashes: {}, parallelApiHash: '', parallelPlanRevisions: {}, parallelPlanHashes: {}, healthRevisions: {}, healthHashes: {}, healthApiHash: '', diaryRevisions: {}, diaryHashes: {}, diaryApiHash: '' });
  /** 云端没留出来的言（"云端与同步"、平行时空里显示） */
  const parallelErrors = ref<HubParallelNotes['errors']>([]);
  /** 云端没写出来的日记（"云端与同步"、回忆 → 日记里显示） */
  const diaryErrors = ref<HubDiaries['errors']>([]);
  /** 云端没发出来的社群帖子（"云端与同步"、社群设置里显示） */
  const communityErrors = ref<HubCommunityPosts['errors']>([]);
  /** 云端没发出来的朋友圈（"云端与同步"、朋友圈设置里显示） */
  const socialErrors = ref<HubMoments['errors']>([]);
  /** 云端记忆整理失败的角色（"云端与同步"里显示） */
  const memoryErrors = ref<HubMemoryResults['errors']>([]);
  const token = ref('');
  const savedPassword = ref('');
  const connected = computed(() => !!config.url && !!token.value);
  const status = ref<HubStatus | null>(null);
  const points = ref<HubTouchpoint[]>([]);
  const lastSyncAt = ref<number | null>(null);
  const error = ref('');
  const supportsRhythm = computed(() => typeof status.value?.rhythmConfigured === 'boolean');
  const supportsMemory = computed(() => typeof status.value?.memoryConfigured === 'boolean');
  /** 旧版 Worker 没有朋友圈：不算"必须升级"，只是云端不会自动发 */
  const supportsSocial = computed(() => typeof status.value?.socialConfigured === 'boolean');
  /** 旧版 Worker 没有社群：同样不算"必须升级"，只是云端不会替网友和角色发帖 */
  const supportsCommunity = computed(() => status.value?.lastCommunityError !== undefined);
  /** 旧版 Worker 没有日程系统：不算"必须升级"，只是云端不会排计划（本机照样能排） */
  const supportsPlanner = computed(() => typeof status.value?.plannerConfigured === 'boolean');
  /** 旧版 Worker 没有平行时空：不算"必须升级"，只是云端不会替她留言（App 开着照样留） */
  const supportsParallel = computed(() => typeof status.value?.parallelConfigured === 'boolean');
  /** 旧版 Worker 没有日记：不算"必须升级"，只是云端不会每晚替她写（App 开着照样写） */
  const supportsDiary = computed(() => typeof status.value?.diaryConfigured === 'boolean');
  /** 云端会不会每天到点排健康计划（旧版 Worker 没有：手机开着时自己排） */
  const supportsHealth = computed(() => typeof status.value?.healthConfigured === 'boolean');
  /** 云端会不会每天到点整理你的一天（旧版 Worker 没有：手机开着时自己整理） */
  const supportsParallelPlan = computed(() => !!status.value && 'lastParallelPlanError' in status.value);
  /** 云端有内置的微信读书 MCP（一起看书接微信读书用） */
  const supportsWeread = computed(() => status.value?.weread === true);
  /** 云端能用存着的登录信息调日历的单个工具（平行时空把记的事同步进 Google 日历） */
  const supportsMcpCall = computed(() => status.value?.mcpCall === true);
  /** 云端有多设备同步（聊天、朋友圈、社群、记忆、角色、设置……连着同一个 Worker 的设备都一样） */
  const supportsSync = computed(() => status.value?.sync === true);
  /** 云端能收手表的运动数据（快捷指令、Health Auto Export 推到 /v1/ingest/*） */
  const supportsIngest = computed(() => status.value?.ingest === true);
  const upgradeRequired = computed(() => !!status.value && (!supportsRhythm.value || !supportsMemory.value));
  const syncing = ref(false);
  let started = false;
  let connectionVersion = 0;
  const uploading = new Set<string>();
  const save = () => write('settings', [{ key: 'hub', value: clone(config) }]);

  async function request<T>(path: string, method = 'GET', data?: unknown, timeoutMs = 30_000): Promise<T> {
    const version = connectionVersion;
    const response = await fetch(`${config.url}${path}`, {
      method, headers: { Authorization: `Bearer ${token.value}`, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(timeoutMs), cache: 'no-store',
    });
    const result = await response.json() as T & { error?: string };
    if (version !== connectionVersion) throw new Error('连接已切换');
    if (!response.ok) throw new HubError(result.error || `Worker HTTP ${response.status}`, response.status);
    return result;
  }

  /** 多设备同步用的：JSON 接口和原样的请求（大文件） */
  const syncApi: SyncApi = {
    json: <T>(path: string, init: { method?: string; body?: unknown; timeout?: number } = {}) => request<T>(path, init.method ?? 'GET', init.body, init.timeout ?? 30_000),
    async raw(path, init = {}) {
      const version = connectionVersion;
      const response = await fetch(`${config.url}${path}`, {
        method: init.method ?? 'GET', headers: { Authorization: `Bearer ${token.value}`, ...init.headers }, body: init.body,
        signal: AbortSignal.timeout(init.timeout ?? 60_000), cache: 'no-store',
      });
      if (version !== connectionVersion) throw new Error('连接已切换');
      return response;
    },
  };

  /** 告诉同步现在连着哪个 Worker、它支不支持同步、大文件存在哪 */
  function configureDataSync() {
    return configureSync({ api: connected.value ? syncApi : null, hub: connected.value ? config.url : '', supported: connected.value && supportsSync.value, blobStore: status.value?.syncBlobs ?? 'd1' });
  }

  /**
   * 上传一份上下文（带版本号）。开着多设备同步时，别的设备上传过更新的版本（409）是正常的：
   * 两台设备的数据是同一份，读云端最新的版本号、用这台设备的再传一次
   */
  async function putContext(base: string, id: string, context: unknown, revisions: Record<string, number>): Promise<{ revision: number }> {
    const path = `${base}/${encodeURIComponent(id)}`;
    try {
      return await request<{ revision: number }>(path, 'PUT', { context, revision: revisions[id] ?? 0 });
    } catch (e) {
      if (!(e instanceof HubError) || e.status !== 409 || !supportsSync.value || !syncState.enabled) throw e;
      const list = await request<{ contexts: { id: string; revision: number }[] }>(base);
      return request<{ revision: number }>(path, 'PUT', { context, revision: list.contexts.find((c) => c.id === id)?.revision ?? 0 });
    }
  }

  async function hydrate() {
    const [saved, secret, password] = await Promise.all([getOne<SavedHub>('settings', 'hub'), getOne<string>('secrets', 'hub:token'), getOne<string>('secrets', 'hub:password')]);
    if (saved) Object.assign(config, saved);
    token.value = secret ?? '';
    savedPassword.value = password ?? '';
    lastSyncAt.value = saved?.lastSyncAt ?? null;
    await configureDataSync();
  }

  async function connect(url: string, password: string) {
    if (syncing.value) throw new Error('正在同步，请稍后再连接');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) throw new Error('Worker 地址必须是 HTTPS');
    const base = parsed.origin;
    const response = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), signal: AbortSignal.timeout(30_000) });
    const result = await response.json() as { token: string; deviceId: string; error?: string };
    if (!response.ok) throw new Error(result.error || `登录失败 HTTP ${response.status}`);
    connectionVersion++;
    syncing.value = false;
    error.value = '';
    if (config.url !== base) Object.assign(config, { cursor: 0, active: false, revisions: {}, hashes: {}, apiHash: '', rhythmRevisions: {}, rhythmHashes: {}, rhythmApiHash: '',
      memoryRevisions: {}, memoryHashes: {}, memoryApiHash: '', memoryAppliedAt: 0, socialRevisions: {}, socialHashes: {}, socialApiHash: '', communityRevisions: {}, communityHashes: {},
      plannerRevisions: {}, plannerHashes: {}, plannerApiHash: '', plannerMcpHashes: {}, parallelRevisions: {}, parallelHashes: {}, parallelApiHash: '', parallelPlanRevisions: {}, parallelPlanHashes: {}, healthRevisions: {}, healthHashes: {}, healthApiHash: '', diaryRevisions: {}, diaryHashes: {}, diaryApiHash: '', lastSyncAt: undefined });
    status.value = null; points.value = []; lastSyncAt.value = config.lastSyncAt ?? null;
    config.url = base;
    config.deviceId = result.deviceId;
    token.value = result.token;
    if (!await write('secrets', [{ key: 'hub:token', value: result.token }, { key: 'hub:password', value: password }])) throw new Error('无法保存登录信息，请允许浏览器存储');
    savedPassword.value = password;
    if (!await save()) throw new Error('无法保存连接地址，请允许浏览器存储');
    await resyncFromDevice();
  }

  /** Explicit recovery chooses this device's settings; ordinary sync never overwrites a revision conflict. */
  async function resyncFromDevice() {
    if (!connected.value || syncing.value) return;
    const version = connectionVersion;
    syncing.value = true;
    try {
      await refreshStatus();
      const jobs = [
        { label: '主动消息版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/proactive/contexts');
          config.revisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.hashes = {}; config.apiHash = '';
        } },
        ...(supportsRhythm.value ? [{ label: '节律版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/rhythm/contexts');
          config.rhythmRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.rhythmHashes = Object.fromEntries(Object.keys(config.rhythmHashes).map((id) => [id, '']));
          config.rhythmApiHash = '';
        } }] : []),
        ...(supportsMemory.value ? [{ label: '记忆版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/memory/contexts');
          config.memoryRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.memoryHashes = {}; config.memoryApiHash = '';
        } }] : []),
        ...(supportsSocial.value ? [{ label: '朋友圈版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/social/contexts');
          config.socialRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.socialHashes = Object.fromEntries(Object.keys(config.socialHashes ?? {}).map((id) => [id, '']));
          config.socialApiHash = '';
        } }] : []),
        ...(supportsCommunity.value ? [{ label: '社群版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/community/contexts');
          config.communityRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.communityHashes = Object.fromEntries(Object.keys(config.communityHashes ?? {}).map((id) => [id, '']));
        } }] : []),
        ...(supportsPlanner.value ? [{ label: '日程计划版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/planner/contexts');
          config.plannerRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.plannerHashes = Object.fromEntries(Object.keys(config.plannerHashes ?? {}).map((id) => [id, '']));
          config.plannerApiHash = ''; config.plannerMcpHashes = {};
        } }] : []),
        ...(supportsParallel.value ? [{ label: '平行时空版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/parallel/contexts');
          config.parallelRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.parallelHashes = Object.fromEntries(Object.keys(config.parallelHashes ?? {}).map((id) => [id, '']));
          config.parallelApiHash = '';
        } }] : []),
        ...(supportsDiary.value ? [{ label: '日记版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/diary/contexts');
          config.diaryRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.diaryHashes = Object.fromEntries(Object.keys(config.diaryHashes ?? {}).map((id) => [id, '']));
          config.diaryApiHash = '';
        } }] : []),
        ...(supportsHealth.value ? [{ label: '健康计划版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/health/contexts');
          config.healthRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.healthHashes = Object.fromEntries(Object.keys(config.healthHashes ?? {}).map((id) => [id, '']));
          config.healthApiHash = '';
        } }] : []),
        ...(supportsParallelPlan.value ? [{ label: '整理你的一天版本', run: async () => {
          const data = await request<{ contexts: { id: string; revision: number }[] }>('/v1/parallel/plan-contexts');
          config.parallelPlanRevisions = Object.fromEntries(data.contexts.map((c) => [c.id, c.revision]));
          config.parallelPlanHashes = Object.fromEntries(Object.keys(config.parallelPlanHashes ?? {}).map((id) => [id, '']));
        } }] : []),
      ];
      await settleSyncJobs(jobs);
      if (!await save()) throw new Error('无法保存同步版本，请允许浏览器存储');
    } catch (e) {
      if (version === connectionVersion) error.value = e instanceof Error ? e.message : String(e);
      throw e;
    } finally { if (version === connectionVersion) syncing.value = false; }
    if (version === connectionVersion) await syncNow();
  }

  async function disconnect() {
    // Disconnect this device; the separate cloud switch controls scheduled generation.
    try { await request('/v1/auth/session', 'DELETE'); } catch { /* Local disconnect also works offline. */ }
    connectionVersion++;
    token.value = ''; status.value = null; points.value = []; lastSyncAt.value = null;
    config.active = false; config.deviceId = ''; error.value = ''; syncing.value = false;
    await configureDataSync();
    const [saved, removed] = await Promise.all([save(), write('secrets', [], ['hub:token'])]);
    if (!saved || !removed) throw new Error('已断开，但本机未能保存状态，请允许浏览器存储');
  }

  async function refreshStatus() {
    status.value = await request<HubStatus>('/v1/status');
    config.active = status.value.enabled;
    await configureDataSync();
  }
  /** 刚打开 App、还没同步过时先读一次状态（判断 Worker 支不支持某个功能） */
  async function ensureStatus() {
    if (connected.value && !status.value) await refreshStatus().catch(() => undefined);
  }

  async function hash(value: unknown): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** 云端主动消息要的记忆：待跟进（排期）、置顶和到期的、最重要的 30 条 */
  function cloudMemories(characterId: string): ProactiveContext['memories'] {
    const mem = useMemoryStore();
    const active = mem.activeOf(characterId);
    const keep = new Map<string, (typeof active)[number]>();
    for (const m of active) if (m.type === 'followup' && m.dueAt) keep.set(m.id, m);
    for (const m of alwaysOn(characterId, Date.now())) keep.set(m.id, m);
    for (const m of [...active].sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt).slice(0, 30)) keep.set(m.id, m);
    return [...keep.values()].slice(0, 120).map(({ id, content, dueAt, type }) => ({ id, content, ...(dueAt ? { dueAt } : {}), type }));
  }

  /** 家务和健康：上传实际情况，时间按半小时取整，免得每分钟都要重新上传。 */
  function homeSnapshot(persona: ReturnType<typeof personaOf>): { home?: string } {
    const b = homeBlock(persona, { stepMin: 30 });
    return b ? { home: b.content } : {};
  }

  function contexts(): ProactiveContext[] {
    const chars = useCharacterStore();
    const chats = useChatStore();
    const lib = useLibraryStore();
    const msgSettings = useMessageSettingsStore();
    const timeZone = useEnvironmentStore().settings.timezone;
    return chars.list.flatMap((character) => {
      const chat = chats.chatOfCharacter(character.id);
      if (!chat || chats.streams[chat.id]) return [];
      const blocks = memoryBlocks(chat, character, Date.now(), timeZone, { proactive: true });
      return [packProactiveContext({ character, chat, persona: personaOf(chat),
        preset: lib.presetForUse('proactive', character) ?? null,
        lorebooks: character.lorebookIds.map((id) => lib.lorebookById(id)).filter((b) => !!b),
        chatLength: chats.list(chat.id).filter((m) => !m.deleted && !m.meta.error && !m.meta.interrupted).length,
        // 消息设置 → 发送条数、已总结的消息不发送：云端主动消息的上下文同样截取
        history: lastN(
          (msgSettings.settings.dropSummarized ? afterSummarized(chats.list(chat.id), chat.summaryUntilMessageId) : chats.list(chat.id)).filter((m) => !m.meta.error && !m.meta.interrupted),
          msgSettings.sendCount(),
        ).slice(-200),
        // 只传排期要用的待跟进、每次都带的和最重要的几十条，记忆再多也不会超长
        memories: cloudMemories(character.id),
        memoryBlocks: {
          summary: blocks.summary.content,
          memory: blocks.memory.content,
          // 家务和健康：上传那一刻的（写着"截至几点"）；没开这两套系统时没有
          ...homeSnapshot(personaOf(chat)),
        },
        flags: lifeFlags(personaOf(chat)),
        environment: useEnvironmentStore().settings, rules: DEFAULT_PROACTIVE_RULES,
        // 正陪着你学习、哄睡、休息时不来打扰
        busyUntil: ['study', 'sleep', 'rest'].includes(chat.currentScene ?? '') ? chat.lastMessageAt + 4 * 3_600_000 : 0,
        preview: config.preview })];
    });
  }

  async function uploadContexts() {
    const snapshots = clone(contexts());
    const present = new Set(useCharacterStore().list.map((c) => c.id));
    // Independent characters upload concurrently. A change during its own upload is picked up next tick.
    const outcomes = await Promise.allSettled(snapshots.map(async (context) => {
      const id = context.character.id;
      if (uploading.has(id)) return;
      uploading.add(id);
      try {
        const fingerprint = await hash(context);
        if (config.hashes[id] === fingerprint) return;
        const result = await putContext('/v1/proactive/contexts', id, context, config.revisions);
        config.revisions[id] = result.revision;
        config.hashes[id] = fingerprint;
      } finally { uploading.delete(id); }
    }).concat(Object.keys(config.hashes).filter((id) => !present.has(id)).map(async (id) => {
      await request(`/v1/proactive/contexts/${encodeURIComponent(id)}`, 'DELETE');
      delete config.hashes[id]; delete config.revisions[id];
    })));
    await save();
    const failed = outcomes.find((o) => o.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }

  async function uploadApi(role: 'proactive' | 'rhythm' | 'consolidate' | 'social' | 'planner' | 'parallel' | 'health' | 'diary' = 'proactive') {
    const ai = useAiStore();
    if (!ai.isLive(role)) throw new Error(`请先在 API 设置中接通${AGENT_META[role].label}`);
    // 主动消息可能跟随「陪伴 · 快速」、它再跟随主对话：一路上的设置都要带上，云端才解析得出用哪个 API
    const chain = ai.system.router.chain(role);
    const source = chain.at(-1) ?? role;
    const credentials: ProactiveCredentials = clone({
      routes: ai.routes.filter((r) => chain.includes(r.role)),
      keys: Object.fromEntries([apiKeyId(source), apiKeyId(source, true)].map((id) => [id, ai.keyOf(id) ?? ''])),
      outputFilters: ai.outputFilters,
      textObfuscation: ai.textObfuscation,
    });
    const fingerprint = await hash(credentials);
    const key = role === 'rhythm' ? 'rhythmApiHash' : role === 'consolidate' ? 'memoryApiHash' : role === 'social' ? 'socialApiHash' : role === 'planner' ? 'plannerApiHash' : role === 'parallel' ? 'parallelApiHash' : role === 'health' ? 'healthApiHash' : role === 'diary' ? 'diaryApiHash' : 'apiHash';
    const configured = role === 'rhythm' ? status.value?.rhythmConfigured : role === 'consolidate' ? status.value?.memoryConfigured
      : role === 'social' ? status.value?.socialConfigured : role === 'planner' ? status.value?.plannerConfigured : role === 'parallel' ? status.value?.parallelConfigured : role === 'health' ? status.value?.healthConfigured : role === 'diary' ? status.value?.diaryConfigured : status.value?.configured;
    if (config[key] === fingerprint && configured) return;
    await request(`/v1/secrets/${role}`, 'PUT', credentials);
    config[key] = fingerprint;
    await save();
  }

  function rhythmContexts() {
    const rhythm = useRhythmStore();
    return useCharacterStore().list.flatMap((c) => {
      if (rhythm.configOf(c.id).settings.mode !== 'daily') return [];
      const context = rhythm.cloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadRhythms() {
    const snapshots = clone(rhythmContexts());
    const present = new Set(snapshots.map((c) => c.character.id));
    // Only unregister this device's previously uploaded roles. Empty devices cannot erase other roles.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.character.id;
        const fingerprint = await hash(context);
        if (config.rhythmHashes[id] === fingerprint) return;
        const result = await putContext('/v1/rhythm/contexts', id, context, config.rhythmRevisions);
        config.rhythmRevisions[id] = result.revision; config.rhythmHashes[id] = fingerprint;
      }),
      ...Object.keys(config.rhythmHashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/rhythm/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete config.rhythmHashes[id]; delete config.rhythmRevisions[id];
      }),
      ...(snapshots.length ? [uploadApi('rhythm')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /**
   * 记忆整理：每个角色打包这次要整理的东西上传（内容没变不传），凌晨 4 点云端整理。
   * "记忆整理"没接通 API 时不传（打开 App 时会在本机补跑）
   */
  async function uploadMemories() {
    if (!useAiStore().isLive('consolidate')) return;
    config.memoryRevisions ??= {};
    config.memoryHashes ??= {};
    const revisions = config.memoryRevisions;
    const hashes = config.memoryHashes;
    let any = false;
    const results = await Promise.allSettled(useCharacterStore().list.map(async (c) => {
      const context = await packConsolidation(c.id);
      if (!context?.preset) return;
      any = true;
      // 打包时间每次都变，不算进指纹
      const fingerprint = await hash({ ...context, packedAt: 0 });
      if (hashes[c.id] === fingerprint) return;
      const result = await putContext('/v1/memory/contexts', c.id, clone(context), revisions);
      revisions[c.id] = result.revision;
      hashes[c.id] = fingerprint;
    }));
    if (any) await uploadApi('consolidate');
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 朋友圈：开着"自动发朋友圈"的角色各上传一份（角色卡、节律、记忆、最近的聊天和朋友圈），云端每天在随机的时间替她发 */
  function socialContexts() {
    // "社媒"没接通时不传（传了云端也发不出来）
    if (!useAiStore().isLive('social')) return [];
    return useCharacterStore().list.flatMap((c) => {
      const context = socialCloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadSocial() {
    if (!useSocialStore().ready) return;
    config.socialRevisions ??= {};
    config.socialHashes ??= {};
    const revisions = config.socialRevisions;
    const hashes = config.socialHashes;
    const snapshots = clone(socialContexts());
    const present = new Set(snapshots.map((c) => c.character.id));
    // Only unregister this device's previously uploaded roles. Empty devices cannot erase other roles.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.character.id;
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/social/contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/social/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...(snapshots.length ? [uploadApi('social')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 社群：你加入的社群各上传一份（介绍、设置、你邀请进来的角色、最近的帖子），云端每天在随机的时间替网友和角色发帖 */
  function communityContexts() {
    // "社媒"没接通时不传（传了云端也发不出来）
    if (!useAiStore().isLive('social')) return [];
    return useCommunityStore().joined.flatMap((c) => {
      const context = communityCloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadCommunities() {
    if (!useCommunityStore().ready) return;
    config.communityRevisions ??= {};
    config.communityHashes ??= {};
    const revisions = config.communityRevisions;
    const hashes = config.communityHashes;
    const snapshots = clone(communityContexts());
    const present = new Set(snapshots.map((c) => c.community.id));
    // Only unregister this device's previously uploaded communities. Empty devices cannot erase others.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.community.id;
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/community/contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/community/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      // 社群用的是云端朋友圈的那一份 API
      ...(snapshots.length ? [uploadApi('social')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 日程计划：开了日程系统的人设各上传一份（设置、"计划"预设、家务和健康、最近几天的完成情况） */
  function plannerContexts() {
    const planner = usePlannerStore();
    if (!planner.ready) return [];
    return usePersonaStore().list.flatMap((p) => {
      const context = planner.context(p.id);
      return context ? [context] : [];
    });
  }

  /** 把一台 MCP 服务器在本机的这一份密钥传上去（请求头的 Token、没连云端时本机授权拿到的 Token）；内容没变不传 */
  async function pushMcpSecret(server: McpServerConfig) {
    const secret = await localSecret(server);
    if (!secret || server.auth === 'none') return;
    config.plannerMcpHashes ??= {};
    const fingerprint = await hash(secret);
    if (config.plannerMcpHashes[server.id] === fingerprint && status.value?.plannerMcp?.includes(server.id)) return;
    await request(`/v1/planner/mcp/${encodeURIComponent(server.id)}`, 'PUT', secret);
    config.plannerMcpHashes[server.id] = fingerprint;
    // 本机授权的 Token 交给云端以后由云端刷新：本机不再留一份（免得两边各自刷新、互相作废）
    if (secret.oauth && (await localToken(server.id))) {
      await saveLocalToken(server.id, null);
      server.authorized = { via: 'hub', at: Date.now() };
    }
    await save();
  }

  async function uploadPlanner() {
    config.plannerRevisions ??= {};
    config.plannerHashes ??= {};
    config.plannerMcpHashes ??= {};
    const revisions = config.plannerRevisions;
    const hashes = config.plannerHashes;
    const mcpHashes = config.plannerMcpHashes;
    const snapshots = clone(plannerContexts());
    const present = new Set(snapshots.map((c) => c.persona.id));
    const servers = usePersonaStore().list.flatMap((p) => (p.planner?.enabled ? p.planner.servers : []));
    const serverIds = new Set(servers.map((s) => s.id));
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.persona.id;
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/planner/contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/planner/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...servers.filter((s) => s.enabled && (s.auth === 'header' || s.authorized?.via === 'device')).map((s) => pushMcpSecret(s)),
      // 删掉了的服务器：云端那一份也删掉（只删这台设备传过的）
      ...Object.keys(mcpHashes).filter((id) => !serverIds.has(id)).map(async (id) => {
        await request(`/v1/planner/mcp/${encodeURIComponent(id)}`, 'DELETE');
        delete mcpHashes[id];
      }),
      ...(snapshots.length ? [uploadApi('planner')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 平行时空：开着"她自己留言"的角色各上传一份（角色卡、两边今天的安排、记忆、最近的聊天和留言），云端每天在随机的时间替她留言 */
  function parallelContexts() {
    // "平行时空"没接通时不传（传了云端也留不出来）
    if (!useAiStore().isLive('parallel')) return [];
    return useCharacterStore().list.flatMap((c) => {
      const context = parallelCloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadParallel() {
    if (!useParallelStore().ready) return;
    config.parallelRevisions ??= {};
    config.parallelHashes ??= {};
    const revisions = config.parallelRevisions;
    const hashes = config.parallelHashes;
    const snapshots = clone(parallelContexts());
    const present = new Set(snapshots.map((c) => c.character.id));
    // Only unregister this device's previously uploaded roles. Empty devices cannot erase other roles.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.character.id;
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/parallel/contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/parallel/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...(snapshots.length ? [uploadApi('parallel')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 日记：开着"主动写日记"的角色各上传一份（角色卡、今天的节律、今天和你、记得的事、最近几篇日记），云端每晚 22:00 替她写 */
  function diaryContexts() {
    // "日记"没接通时不传（传了云端也写不出来）
    if (!useAiStore().isLive('diary')) return [];
    return useCharacterStore().list.flatMap((c) => {
      const context = diaryCloudContext(c.id);
      return context ? [context] : [];
    });
  }

  async function uploadDiary() {
    if (!useDiaryStore().ready) return;
    config.diaryRevisions ??= {};
    config.diaryHashes ??= {};
    const revisions = config.diaryRevisions;
    const hashes = config.diaryHashes;
    const snapshots = clone(diaryContexts());
    const present = new Set(snapshots.map((c) => c.character.id));
    // Only unregister this device's previously uploaded roles. Empty devices cannot erase other roles.
    const results = await Promise.allSettled([
      ...snapshots.map(async (context) => {
        const id = context.character.id;
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/diary/contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/diary/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...(snapshots.length ? [uploadApi('diary')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 拉云端写好的日记：放进来；有新的弹一条横幅 */
  async function pullDiary() {
    const diary = useDiaryStore();
    if (!diary.ready) return;
    const data = await request<HubDiaries>(`/v1/diary/entries?since=${diary.cursor}`);
    diaryErrors.value = data.errors;
    const added = receiveHubDiaries(data.entries.map((e) => e.entry));
    diary.cursor = Math.max(diary.cursor, ...data.entries.map((e) => e.doneAt));
    const latest = added.at(-1);
    const author = useCharacterStore().byId(latest?.characterId);
    if (latest && author) useAppStore().showBanner({ characterId: author.id, title: author.name, text: `写了今天的日记${latest.title ? `《${latest.title}》` : ''}`, to: `/memories?char=${encodeURIComponent(author.id)}&tab=diary`, icon: 'i-lucide-notebook-tabs' });
  }

  /** 健康计划：开着健康系统的人设各上传一份（拼好的今天、明天的材料），云端每天到点替你排 */
  function healthContexts() {
    return usePersonaStore().list.flatMap((p) => {
      const context = useHealthStore().cloudContext(p);
      return context ? [{ id: p.id, context }] : [];
    });
  }

  async function uploadHealth() {
    config.healthRevisions ??= {};
    config.healthHashes ??= {};
    const revisions = config.healthRevisions;
    const hashes = config.healthHashes;
    const snapshots = clone(healthContexts());
    const present = new Set(snapshots.map((c) => c.id));
    const results = await Promise.allSettled([
      ...snapshots.map(async ({ id, context }) => {
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/health/contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/health/contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...(snapshots.length ? [uploadApi('health'), uploadMapsKey()] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 给云端的 Google 地图 Key：填了就加密传上去（换了重传），清空了就从云端删掉 */
  async function uploadMapsKey() {
    const key = useServicesStore().cloudMapsKey;
    if (!key) {
      if (!config.mapsCloudHash && !status.value?.mapsConfigured) return;
      await request('/v1/secrets/maps', 'DELETE');
      config.mapsCloudHash = '';
      return save();
    }
    const fingerprint = await hash({ key });
    if (config.mapsCloudHash === fingerprint && status.value?.mapsConfigured) return;
    await request('/v1/secrets/maps', 'PUT', { key });
    config.mapsCloudHash = fingerprint;
    await save();
  }

  /**
   * 拉手表的运动数据（快捷指令、Health Auto Export 推上来的），交给健康计划对上"健身"里记的那一次；
   * 用上了、单独记了的说一句。没有新的也对一遍（只在手表上练的要等结束 2 小时以后才单独记）
   */
  async function pullWatchWorkouts() {
    const health = useHealthStore();
    if (health.watch.mode === 'off') return;
    config.watchCursor ??= 0;
    const got: WatchWorkout[] = [];
    let more = true;
    while (more) {
      const data: HubWatchWorkouts = await request<HubWatchWorkouts>(`/v1/ingest/workouts?since=${config.watchCursor}`);
      got.push(...data.workouts.map((r) => r.workout));
      config.watchCursor = data.next;
      more = data.more && data.workouts.length > 0;
    }
    const outcomes = health.ingestWatch(got);
    if (got.length) await save();
    const app = useAppStore();
    const first = outcomes[0];
    if (first) {
      const w = first.workout;
      app.showBanner({
        characterId: first.log.characterId ?? app.activeCharacterId,
        title: first.kind === 'created' ? '手表记了一次运动' : '用上了手表的数',
        text: `${watchWorkoutLine(w)}${outcomes.length > 1 ? `（还有 ${outcomes.length - 1} 次）` : ''}${first.log.watch?.note ? `；${first.log.watch.note}` : ''}`,
        to: '/me/health',
        icon: 'i-lucide-watch',
      });
    }
  }
  /** 建（或者换）上报令牌：旧的马上失效 */
  async function createIngestToken(): Promise<string> {
    const r = await request<{ token: string; createdAt: number }>('/v1/ingest/token', 'POST');
    config.ingestToken = r.token;
    await save();
    await refreshStatus();
    return r.token;
  }
  async function revokeIngestToken() {
    await request('/v1/ingest/token', 'DELETE');
    config.ingestToken = '';
    await save();
    await refreshStatus();
  }

  /** 拉云端排好的健康计划 */
  async function pullHealth() {
    const health = useHealthStore();
    config.healthCursor ??= 0;
    const data = await request<HubHealthResults>(`/v1/health/results?since=${config.healthCursor}`);
    health.cloudErrors = data.errors;
    for (const { result } of data.results) health.ingestCloud(result);
    config.healthCursor = Math.max(config.healthCursor, ...data.results.map((r) => r.doneAt));
    if (data.results.length) await save();
  }

  /** 整理你的一天：平行时空里用到的人设各上传一份（今天、明天的家务和健康计划），云端每天到点替你整理 */
  async function uploadParallelPlans() {
    if (!useParallelStore().ready) return;
    config.parallelPlanRevisions ??= {};
    config.parallelPlanHashes ??= {};
    const revisions = config.parallelPlanRevisions;
    const hashes = config.parallelPlanHashes;
    const snapshots = clone(parallelPlanCloudContexts());
    const present = new Set(snapshots.map((c) => c.id));
    const results = await Promise.allSettled([
      ...snapshots.map(async ({ id, context }) => {
        const fingerprint = await hash(context);
        if (hashes[id] === fingerprint) return;
        const result = await putContext('/v1/parallel/plan-contexts', id, context, revisions);
        revisions[id] = result.revision; hashes[id] = fingerprint;
      }),
      ...Object.keys(hashes).filter((id) => !present.has(id)).map(async (id) => {
        await request(`/v1/parallel/plan-contexts/${encodeURIComponent(id)}`, 'DELETE');
        delete hashes[id]; delete revisions[id];
      }),
      ...(snapshots.length ? [uploadApi('parallel')] : []),
    ]);
    await save();
    const failure = results.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }

  /** 拉云端整理好的你的一天 */
  async function pullParallelPlans() {
    const parallel = useParallelStore();
    if (!parallel.ready) return;
    const data = await request<HubParallelPlans>(`/v1/parallel/plans?since=${parallel.planCursor}`);
    parallel.planErrors = data.errors;
    for (const { plan } of data.plans) parallel.setPlan(plan);
    parallel.planCursor = Math.max(parallel.planCursor, ...data.plans.map((p) => p.doneAt));
  }

  /** 拉云端留的言：放进来；有新的弹一条横幅 */
  async function pullParallel() {
    const parallel = useParallelStore();
    if (!parallel.ready) return;
    const data = await request<HubParallelNotes>(`/v1/parallel/notes?since=${parallel.cursor}`);
    parallelErrors.value = data.errors;
    const added = receiveHubNotes(data.notes.map((n) => n.note));
    parallel.cursor = Math.max(parallel.cursor, ...data.notes.map((n) => n.doneAt));
    const latest = added.at(-1);
    const author = useCharacterStore().byId(latest?.characterId);
    if (latest && author) useAppStore().showBanner({ characterId: author.id, title: author.name, text: `在平行时空给你留言：${latest.text}`, to: `/parallel/${encodeURIComponent(author.id)}`, icon: 'i-lucide-orbit' });
  }

  /** 拉云端排好的计划 */
  async function pullPlanner() {
    const planner = usePlannerStore();
    if (!planner.ready) return;
    const data = await request<HubPlannerResults>(`/v1/planner/results?since=${planner.cursor}`);
    planner.cloudErrors = data.errors;
    for (const { doneAt, result } of data.results) {
      planner.ingest(result);
      planner.cursor = Math.max(planner.cursor, doneAt);
    }
  }

  /** "立即生成"之前：只同步日程计划这一块（设置、密钥、API） */
  async function syncPlannerNow() {
    if (!status.value) await refreshStatus();
    if (!supportsPlanner.value) throw new Error('云端的 Worker 版本太旧，没有日程系统：部署最新 main 的 Worker 和数据库迁移');
    await uploadPlanner();
  }
  async function runPlanner(personaId: string, want: { week: boolean; day: boolean }): Promise<PlannerRunResult> {
    // 云端要连邮箱和日程、查几轮、写两份计划：多等一会儿
    const { result } = await request<{ result: PlannerRunResult }>(`/v1/planner/run/${encodeURIComponent(personaId)}`, 'POST', want, 600_000);
    return result;
  }
  /** 用云端存的登录信息调日历的一个工具（Token 不回到手机） */
  async function mcpCall(server: McpServerConfig, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    if (!supportsMcpCall.value) throw new Error('云端的 Worker 版本太旧，不能替你写 Google 日历：部署最新 main 的 Worker');
    return (await request<{ result: McpCallResult }>(`/v1/planner/mcp/${encodeURIComponent(server.id)}/call`, 'POST', { server: { ...clone(server), tools: [] }, tool, args }, 90_000)).result;
  }
  async function plannerTools(server: McpServerConfig): Promise<McpToolInfo[]> {
    return (await request<{ tools: McpToolInfo[] }>(`/v1/planner/mcp/${encodeURIComponent(server.id)}/tools`, 'POST', { server: { ...clone(server), tools: [] } }, 90_000)).tools;
  }
  async function oauthDiscover(url: string): Promise<McpOAuthDiscovery> {
    return request<McpOAuthDiscovery>('/v1/planner/oauth/discover', 'POST', { url }, 60_000);
  }
  async function oauthRegister(input: { registrationEndpoint: string; redirectUri: string; clientName: string; scope?: string }): Promise<{ clientId: string; clientSecret?: string; authMethod: McpOAuthConfig['authMethod'] }> {
    return request('/v1/planner/oauth/register', 'POST', input, 60_000);
  }
  /** 授权码交给云端换 Token（Token 直接加密存在云端，不回到手机） */
  async function oauthToken(input: Omit<McpOAuthToken, 'accessToken' | 'refreshToken' | 'expiresAt'> & { serverId: string; url: string; code: string; verifier: string; redirectUri: string }) {
    await request('/v1/planner/oauth/token', 'POST', input, 60_000);
    config.plannerMcpHashes ??= {};
    delete config.plannerMcpHashes[input.serverId];
    await refreshStatus();
  }

  /** 拉云端发的社群帖子：放进来、角色发的记进记忆、把要配的图画出来；角色发了帖弹一条横幅 */
  async function pullCommunities() {
    const store = useCommunityStore();
    if (!store.ready) return;
    const data = await request<HubCommunityPosts>(`/v1/community/posts?since=${store.cursor}`);
    communityErrors.value = data.errors;
    const added = receiveHubPosts(data.batches.flatMap((b) => b.posts));
    store.cursor = Math.max(store.cursor, ...data.batches.map((b) => b.doneAt));
    const latest = added.filter((p) => useCharacterStore().byId(p.authorId)).at(-1);
    const author = useCharacterStore().byId(latest?.authorId);
    const where = store.byId(latest?.communityId);
    if (latest && author && where) useAppStore().showBanner({ characterId: author.id, title: author.name, text: `在社群「${where.name}」发了一帖${latest.title || latest.text ? `：${latest.title || latest.text}` : ''}`, to: `/community/${encodeURIComponent(where.id)}`, icon: 'i-lucide-users-round' });
  }

  /** 拉云端发的朋友圈：放进来、记进记忆、把要配的图画出来；有新的弹一条横幅 */
  async function pullSocial() {
    const social = useSocialStore();
    if (!social.ready) return;
    const data = await request<HubMoments>(`/v1/social/posts?since=${social.cursor}`);
    socialErrors.value = data.errors;
    const added = receiveHubMoments(data.posts.map((p) => p.moment));
    social.cursor = Math.max(social.cursor, ...data.posts.map((p) => p.doneAt));
    const latest = added.at(-1);
    const author = useCharacterStore().byId(latest?.authorId);
    if (latest && author) useAppStore().showBanner({ characterId: author.id, title: author.name, text: `发了一条朋友圈${latest.text ? `：${latest.text}` : ''}`, to: '/social/moments', icon: 'i-lucide-aperture' });
  }

  /** 拉云端整理好的结果，按顺序应用（你在手机上改过的那一处跳过） */
  async function pullMemories() {
    const since = config.memoryAppliedAt ?? 0;
    const data = await request<HubMemoryResults>(`/v1/memory/results?since=${since}`);
    memoryErrors.value = data.errors;
    if (!useMemoryStore().ready) return;
    for (const { doneAt, result } of data.results) {
      await applyMemoryOps(result.context, result.ops);
      config.memoryAppliedAt = Math.max(config.memoryAppliedAt ?? 0, doneAt);
      // 这份上下文整理完了：下次内容有变化再上传
      if (config.memoryHashes) delete config.memoryHashes[result.characterId];
    }
    if (data.results.length) await save();
  }

  async function pullRhythms() {
    const result = await request<HubRhythms>('/v1/rhythm/days');
    const rhythm = useRhythmStore();
    await rhythm.ingestCloud(result.days);
    for (const failure of result.errors) {
      if (failure.date === rhythm.today && rhythm.configOf(failure.characterId).settings.mode === 'daily') {
        rhythm.errors[failure.characterId] = { at: Date.now(), reason: failure.reason };
      }
    }
  }

  async function ingest(rows: HubInbox['messages']) {
    const chats = useChatStore();
    const app = useAppStore();
    const changed = new Set<string>();
    const added: { key: string; value: unknown }[] = [];
    for (const row of rows) {
      const chat = chats.chatOfCharacter(row.characterId);
      if (!chat) throw new Error('云端消息对应的角色尚未导入这台设备，请导入后再次同步');
      if (chats.streams[chat.id]) throw new Error('角色正在回复，生成结束后会补齐云端消息');
      changed.add(chat.id);
      if (chats.list(chat.id).some((m) => m.id === row.message.id)) continue;
      const message: Message = { ...row.message, chatId: chat.id, read: app.viewingChatId === chat.id };
      chats.messages[chat.id] ??= [];
      chats.messages[chat.id]!.push(message);
      chats.messages[chat.id]!.sort((a, b) => a.createdAt - b.createdAt);
      added.push({ key: msgKey(chat.id, message.id), value: clone(message) });
      chat.lastMessageAt = Math.max(chat.lastMessageAt, message.createdAt);
      changed.add(chat.id);
      if (!message.read) app.showBanner({ characterId: row.characterId, title: useCharacterStore().byId(row.characterId)?.name ?? '新消息', text: message.text,
        to: message.parts.some((p) => p.type === 'call-log') ? `/call/${row.characterId}?incoming=1` : `/chat/${chat.id}`, icon: 'i-lucide-bell-ring' });
    }
    // Persist before advancing the server cursor. Repeated pages are safe because message IDs are stable.
    const saved = await Promise.all([
      write('chatMessages', added),
      write('chats', [...changed].map((id) => ({ key: id, value: clone(chats.chatById(id)) }))),
    ]);
    if (saved.some((ok) => !ok)) throw new Error('消息未能写入本机存储，下次同步会重试');
  }

  async function pull() {
    // Pagination is a data dependency, not a job queue; it does not run or delay generation.
    let more = true;
    while (more) {
      const inbox = await request<HubInbox>(`/v1/inbox?since=${config.cursor}`);
      await ingest(inbox.messages);
      if (!await write('settings', [{ key: 'hub', value: { ...clone(config), cursor: inbox.next } }])) throw new Error('无法保存同步进度');
      config.cursor = inbox.next;
      points.value = inbox.touchpoints;
      more = inbox.more;
    }
  }

  async function syncNow() {
    if (!connected.value || syncing.value) return;
    const version = connectionVersion;
    syncing.value = true;
    try {
      await refreshStatus();
      // 多设备同步先做：别的设备收到、发出、改过的先拉下来，下面拉云端生成的东西时就不会重复处理
      const dataError = supportsSync.value ? await runSync().then(() => '', (e) => `多设备同步：${e instanceof Error ? e.message : String(e)}`) : '';
      // Context updates and inbox reads are independent. Neither starts cloud generation.
      // 记忆：先拉云端整理好的结果并应用，再上传这次要整理的
      const jobs = [
        { label: '收件箱', run: pull },
        ...(supportsRhythm.value ? [
          { label: '节律结果', run: pullRhythms },
          { label: '节律设置', run: uploadRhythms },
        ] : []),
        ...(supportsMemory.value ? [{ label: '记忆整理', run: () => pullMemories().then(uploadMemories) }] : []),
        ...(supportsSocial.value ? [{ label: '朋友圈', run: () => pullSocial().then(uploadSocial) }] : []),
        ...(supportsCommunity.value ? [{ label: '社群', run: () => pullCommunities().then(uploadCommunities) }] : []),
        ...(supportsPlanner.value ? [{ label: '日程计划', run: () => pullPlanner().then(uploadPlanner) }] : []),
        ...(supportsParallel.value ? [{ label: '平行时空', run: () => pullParallel().then(uploadParallel) }] : []),
        ...(supportsDiary.value ? [{ label: '日记', run: () => pullDiary().then(uploadDiary) }] : []),
        ...(supportsHealth.value ? [{ label: '健康计划', run: () => pullHealth().then(uploadHealth) }] : []),
        ...(supportsIngest.value && useHealthStore().watch.mode !== 'off' ? [{ label: '手表数据', run: pullWatchWorkouts }] : []),
        ...(supportsParallelPlan.value ? [{ label: '整理你的一天', run: () => pullParallelPlans().then(uploadParallelPlans) }] : []),
        ...(config.active ? [
          { label: '角色上下文（含时区和作息）', run: uploadContexts },
          { label: '主动消息 API', run: () => uploadApi() },
        ] : []),
        ...(upgradeRequired.value ? [{ label: 'Worker 版本', run: async () => { throw new Error('云端版本过旧，请部署最新 main 的 Worker 和数据库迁移；当前节律、记忆及排期设置可能未生效'); } }] : []),
      ];
      try {
        await settleSyncJobs(jobs);
      } catch (e) {
        throw new Error([dataError, e instanceof Error ? e.message : String(e)].filter(Boolean).join('\n'));
      }
      if (dataError) throw new Error(dataError);
      // 上面拉到的云端消息、朋友圈……推给别的设备
      if (supportsSync.value) void runSync().catch(() => undefined);
      if (version === connectionVersion) {
        config.lastSyncAt = Date.now();
        if (!await save()) throw new Error('无法保存同步状态');
        lastSyncAt.value = config.lastSyncAt; error.value = '';
      }
    } catch (e) { if (version === connectionVersion) error.value = e instanceof Error ? e.message : String(e); }
    finally { if (version === connectionVersion) syncing.value = false; }
  }

  async function enable() {
    await Promise.all([uploadContexts(), uploadApi()]);
    await request('/v1/proactive/enabled', 'PUT', { enabled: true });
    await refreshStatus(); await save(); error.value = '';
  }
  async function disable() {
    await request('/v1/proactive/enabled', 'PUT', { enabled: false });
    config.active = false; await save(); await refreshStatus();
  }
  async function subscribe() {
    // Called directly from a click: iOS requires a user gesture for this permission.
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('此浏览器不支持 Web Push；iPhone 请先添加到主屏幕再打开');
    if (await Notification.requestPermission() !== 'granted') throw new Error('未允许通知，请在系统设置中开启');
    const key = status.value?.vapidPublicKey;
    if (!key) throw new Error('Worker 尚未设置 VAPID 密钥');
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.active) throw new Error('请先安装或打开正式版 App，等待 Service Worker 就绪');
    const subscription = await reg.pushManager.getSubscription() ?? await reg.pushManager.subscribe({ userVisibleOnly: true,
      applicationServerKey: Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)) });
    await request('/v1/push/subscribe', 'POST', { kind: 'webpush', label: '这台设备', config: subscription.toJSON() });
    await refreshStatus();
  }
  async function addWebhook(data: { url: string; preset: string; headers?: Record<string, string>; body?: unknown }) {
    await request('/v1/push/subscribe', 'POST', { kind: 'webhook', label: data.preset === 'custom' ? '自定义 webhook' : data.preset, config: data });
    await refreshStatus();
  }
  /** 一起观影：按片名在你的 Worker 上搜 B 站的真实视频（聊天里的看片邀请点开时用） */
  /** 让 Hub 搜 B 站；cookie 是观影设置里的 B 站 Cookie，有就用 POST 带过去（不放进网址） */
  async function searchVideos(q: string, cookie = ''): Promise<VideoHit[]> {
    if (!connected.value) throw new Error('还没连云端 Hub（我的 → 云端同步），搜不了 B 站');
    const path = '/v1/video/search';
    return (cookie ? await request<{ hits: VideoHit[] }>(path, 'POST', { q, cookie }) : await request<{ hits: VideoHit[] }>(`${path}?q=${encodeURIComponent(q)}`)).hits;
  }
  /** 让 Hub 查 B 站视频第 page P 的 aid、cid（id 是 BV 号或 av 号）：iOS 上的嵌入播放器要靠它们才放得了 */
  async function videoIds(id: string, page: number): Promise<{ aid: number; cid: number }> {
    if (!connected.value) throw new Error('还没连云端 Hub');
    return request<{ aid: number; cid: number }>(`/v1/video/ids?id=${encodeURIComponent(id)}&p=${page}`);
  }
  /** 直接连 Hub 上的一个端点（例如内置的微信读书 MCP）：地址和登录用的请求头 */
  function endpoint(path: string): { url: string; headers: Record<string, string> } | null {
    return connected.value ? { url: `${config.url}${path}`, headers: { Authorization: `Bearer ${token.value}` } } : null;
  }
  async function removeChannel(id: string) { await request(`/v1/push/channels/${encodeURIComponent(id)}`, 'DELETE'); await refreshStatus(); }
  async function testChannel(id: string) { await request(`/v1/push/channels/${encodeURIComponent(id)}`, 'POST'); await refreshStatus(); }

  function start() {
    if (started) return;
    started = true;
    void syncNow();
    setInterval(() => void syncNow(), 60_000);
    // 开着 App 时每 20 秒看一眼别的设备有没有新东西（只拉同步的数据，没有新的时就是一个很小的请求）
    setInterval(() => {
      if (document.visibilityState === 'visible' && connected.value && supportsSync.value && !syncing.value) void runSync().catch(() => undefined);
    }, 20_000);
    const refresh = () => { if (document.visibilityState === 'visible') void syncNow(); };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', () => void syncNow());
    navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'hub-inbox') void syncNow(); });
    watch(() => config.preview, () => { void save(); });
    let debounce: ReturnType<typeof setTimeout>;
    watch(() => [contexts(), rhythmContexts(), socialContexts(), communityContexts(), plannerContexts(), parallelContexts(), parallelPlanCloudContexts(), healthContexts(), diaryContexts(), useAiStore().routes, useAiStore().outputFilters, useAiStore().textObfuscation,
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('planner'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('planner'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('proactive'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('proactive'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('rhythm'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('rhythm'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('social'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('social'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('parallel'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('parallel'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('diary'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('diary'), true)),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('health'))),
      useAiStore().keyOf(apiKeyId(useAiStore().system.router.source('health'), true)), useServicesStore().cloudMapsKey, useChatStore().streams], () => {
      clearTimeout(debounce); debounce = setTimeout(() => void syncNow(), 500);
    }, { deep: true });
  }
  return { config, savedPassword, connected, status, points, error, syncing, lastSyncAt, memoryErrors, socialErrors, communityErrors, parallelErrors, diaryErrors, supportsRhythm, supportsMemory, supportsSocial, supportsCommunity, supportsPlanner, supportsParallel, supportsDiary, supportsParallelPlan, supportsHealth, supportsWeread, supportsMcpCall, supportsSync, supportsIngest, upgradeRequired, hydrate, connect, resyncFromDevice, disconnect, syncNow, enable, disable, subscribe, addWebhook, removeChannel, testChannel, searchVideos, videoIds, endpoint,
    ensureStatus, pushMcpSecret, syncPlannerNow, runPlanner, mcpCall, plannerTools, oauthDiscover, oauthRegister, oauthToken, pullWatchWorkouts, createIngestToken, revokeIngestToken, start };
});
