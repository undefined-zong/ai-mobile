import { AgentSystem, discoverOAuth, exchangeOAuthCode, openMcpSession, registerOAuthClient } from '@app/ai';
import { communitySettingsValid, normalizeMcpServer, WEREAD_HEADERS, normalizePlanner, PARALLEL_PER_DAY_MAX, shiftDate, SOCIAL_PER_DAY_MAX, zonedParts, type CommunityContext, type ParallelContext, type ParallelNote, type ParallelPlan, type ParallelPlanContext, type HealthPlanContext, type HealthRunResult, type McpOAuthToken, type McpServerSecret, type PlannerContext, type PlannerRunResult, type CommunityPost, type MemoryConsolidationContext, type MemoryJobResult, type Moment, type ProactiveContext, type ProactiveCredentials, type RhythmContext, type SocialContext, type Touchpoint } from '@app/shared';
import { digest, equalSecret, seal } from './crypto.ts';
import { assert, HttpError, json, readJson } from './http.ts';
import { syncApi, syncStatus } from './sync.ts';
import type { Env } from './env.ts';
import { PushDeliveryError, sendChannel, type Channel, type Webhook } from './push.ts';
import { getMeta, runScheduled, setMeta } from './scheduler.ts';
import { runRhythmScheduled } from './rhythm.ts';
import { runMemoryScheduled } from './memory.ts';
import { runSocialScheduled } from './social.ts';
import { runCommunityScheduled } from './community.ts';
import { runParallelScheduled } from './parallel.ts';
import { runParallelPlanScheduled } from './parallelPlan.ts';
import { runHealthScheduled } from './health.ts';
import { mcpSecret, runPlannerNow, runPlannerScheduled, saveMcpSecret } from './planner.ts';
import { bilibiliIds, searchBilibili } from './video.ts';
import { wereadMcp } from './weread.ts';
import { publicPage } from './publicPages.ts';
import { relayPage } from './relay.ts';

const body = <T>(request: Request): Promise<T> => readJson<T>(request);
function https(value: string): boolean {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; } catch { return false; }
}

async function login(request: Request, env: Env) {
  if (!env.HUB_PASSWORD || !env.KEK) throw new HttpError(503, 'Worker 尚未设置 HUB_PASSWORD / KEK');
  const now = Date.now();
  const bucket = `${await digest(request.headers.get('CF-Connecting-IP') ?? 'local')}:${Math.floor(now / 600_000)}`;
  const count = await env.DB.prepare(`INSERT INTO login_attempts(bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1 RETURNING attempts`).bind(bucket, now + 600_000).first<{ attempts: number }>();
  if (count!.attempts > 10) throw new HttpError(429, '登录尝试过多，10 分钟后重试');
  const data = await body<{ password: string }>(request);
  if (typeof data.password !== 'string' || !await equalSecret(data.password, env.HUB_PASSWORD)) throw new HttpError(401, '密码不正确');
  const token = crypto.randomUUID() + crypto.randomUUID();
  const deviceId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO devices(id, token_hash, expires_at) VALUES (?, ?, ?)').bind(deviceId, await digest(token), now + 90 * 86_400_000),
    env.DB.prepare('DELETE FROM login_attempts WHERE expires_at < ?').bind(now),
  ]);
  return json({ token, deviceId });
}

function validateContext(c: ProactiveContext, id: string) {
  assert(c && c.character?.id === id && c.chat?.characterId === id, '角色与聊天不匹配');
  assert(c.persona?.name && c.environment?.timezone && c.environment?.meals, '缺少人设或作息');
  try { zonedParts(Date.now(), c.environment.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
  assert(Array.isArray(c.history) && c.history.length <= 200 && c.history.every((m) => m.chatId === c.chat.id), '聊天上下文无效（最多 200 条）');
  assert(Array.isArray(c.rules) && c.rules.length <= 50 && Array.isArray(c.lorebooks) && Array.isArray(c.memories), '规则或世界书无效');
  assert(typeof c.character.proactive?.enabled === 'boolean' && Array.isArray(c.character.proactive.triggers), '主动消息设置无效');
  assert(Number.isFinite(c.busyUntil) && ['full', 'name-only', 'hidden'].includes(c.preview), '状态或通知预览无效');
  const times = [c.environment.wakeTime, c.environment.sleepTime, c.character.proactive.quietHours.start, c.character.proactive.quietHours.end,
    ...Object.values(c.environment.meals).flatMap((w) => [w.start, w.end])];
  assert(times.every((t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)), '作息时间须为 HH:mm');
}

async function api(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path === '/health' && request.method === 'GET') return json({ ok: true });
  if (request.method === 'GET') {
    if (path === '/relay') return relayPage(env);
    const page = publicPage(path, env);
    if (page) return page;
  }
  if (path === '/v1/auth/login' && request.method === 'POST') return login(request, env);
  const token = request.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token) throw new HttpError(401, '需要登录');
  const device = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ? AND expires_at > ?').bind(await digest(token), Date.now()).first<{ id: string }>();
  if (!device) throw new HttpError(401, '登录已过期');

  // 一起观影：按片名搜 B 站的真实视频（聊天里的 [watch:片名] 卡片、逛 B 站的搜索）。
  // 填了 B 站 Cookie 时 App 用 POST { q, cookie }，Cookie 不放进网址
  if (path === '/v1/video/search' && (request.method === 'GET' || request.method === 'POST')) {
    const input = request.method === 'POST' ? await body<{ q?: unknown; cookie?: unknown }>(request) : { q: url.searchParams.get('q'), cookie: '' };
    const q = typeof input.q === 'string' ? input.q.trim() : '';
    const cookie = typeof input.cookie === 'string' ? input.cookie.trim() : '';
    assert(q, '缺少关键词 q');
    assert(cookie.length <= 4000 && !/[\r\n]/.test(cookie), 'B 站 Cookie 格式不对');
    try {
      return json({ hits: await searchBilibili(q, 8, cookie) });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
  }

  // 一起观影：贴的 B 站链接没带 aid + cid 时查一下（iOS 上的嵌入播放器要靠它们才放得了）
  if (path === '/v1/video/ids' && request.method === 'GET') {
    const id = url.searchParams.get('id') ?? '';
    const page = Number(url.searchParams.get('p') ?? '1');
    assert(/^(BV[0-9A-Za-z]{10}|av\d{1,20})$/.test(id), 'id 要是 BV 号或 av 号');
    assert(Number.isInteger(page) && page >= 1 && page <= 1000, 'p 不对');
    try {
      return json(await bilibiliIds(id, page));
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message : String(e));
    }
  }

  // 一起看书：内置的微信读书 MCP（书架、笔记和章节正文；微信读书的登录信息在请求头里，Hub 不存）
  if (path === '/v1/weread/mcp') return wereadMcp(request);

  // 多设备同步：聊天、朋友圈、社群、记忆、角色、设置……（按条推拉），图片和文件按哈希存
  if (path.startsWith('/v1/sync/')) return syncApi(request, env, url, device.id);

  if (path === '/v1/auth/session' && request.method === 'DELETE') {
    await env.DB.prepare('DELETE FROM devices WHERE id = ?').bind(device.id).run();
    return json({ ok: true });
  }

  if (path === '/v1/status' && request.method === 'GET') {
    const [enabled, lastCronAt, lastError, configured, channels, rhythmConfigured, lastRhythmError, memoryConfigured, lastMemoryError, socialConfigured, lastSocialError, lastCommunityError,
      plannerConfigured, lastPlannerError, plannerMcp, parallelConfigured, lastParallelError, lastParallelPlanError, healthConfigured, lastHealthError, mapsConfigured] = await Promise.all([
      getMeta(env, 'enabled', false), getMeta<number | null>(env, 'lastCronAt', null), getMeta<string | null>(env, 'lastError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'proactive'").first(),
      env.DB.prepare('SELECT id, kind, label, last_ok_at AS lastOkAt FROM push_channels').all(),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'rhythm'").first(), getMeta<string | null>(env, 'lastRhythmError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'consolidate'").first(), getMeta<string | null>(env, 'lastMemoryError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'social'").first(), getMeta<string | null>(env, 'lastSocialError', null),
      getMeta<string | null>(env, 'lastCommunityError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'planner'").first(), getMeta<string | null>(env, 'lastPlannerError', null),
      env.DB.prepare('SELECT server_id FROM planner_mcp').all<{ server_id: string }>(),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'parallel'").first(), getMeta<string | null>(env, 'lastParallelError', null),
      getMeta<string | null>(env, 'lastParallelPlanError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'health'").first(), getMeta<string | null>(env, 'lastHealthError', null),
      env.DB.prepare("SELECT id FROM secrets WHERE id = 'maps'").first(),
    ]);
    return json({ enabled, lastCronAt, lastError, configured: !!configured, rhythmConfigured: !!rhythmConfigured, lastRhythmError,
      memoryConfigured: !!memoryConfigured, lastMemoryError, socialConfigured: !!socialConfigured, lastSocialError, lastCommunityError,
      plannerConfigured: !!plannerConfigured, lastPlannerError, plannerMcp: plannerMcp.results.map((r) => r.server_id),
      parallelConfigured: !!parallelConfigured, lastParallelError, lastParallelPlanError, healthConfigured: !!healthConfigured, lastHealthError, mapsConfigured: !!mapsConfigured,
      weread: true, mcpCall: true, ...syncStatus(env), vapidPublicKey: env.VAPID_PUBLIC_KEY ?? null, channels: channels.results });
  }
  if (path === '/v1/proactive/enabled' && request.method === 'PUT') {
    const { enabled } = await body<{ enabled: boolean }>(request);
    assert(typeof enabled === 'boolean', 'enabled 必须为布尔值');
    if (enabled) assert(await env.DB.prepare("SELECT id FROM secrets WHERE id = 'proactive'").first(), '请先上传主动消息 API');
    await setMeta(env, 'enabled', enabled);
    return json({ enabled });
  }
  if (path === '/v1/proactive/contexts' && request.method === 'GET') {
    const rows = await env.DB.prepare('SELECT character_id AS id, revision FROM contexts').all();
    return json({ contexts: rows.results });
  }
  if (path.startsWith('/v1/proactive/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/proactive/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM contexts WHERE character_id = ?').bind(id),
        env.DB.prepare("DELETE FROM touchpoints WHERE character_id = ? AND status = 'planned'").bind(id),
      ]);
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context, revision } = await body<{ context: ProactiveContext; revision: number }>(request);
      validateContext(context, id);
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(context), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了角色上下文，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/rhythm/contexts' && request.method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT character_id AS id, revision FROM rhythm_contexts').all()).results });
  }
  if (path.startsWith('/v1/rhythm/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/rhythm/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM rhythm_contexts WHERE character_id = ?').bind(id),
        env.DB.prepare('DELETE FROM rhythm_days WHERE character_id = ? AND data IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context: c, revision } = await body<{ context: RhythmContext; revision: number }>(request);
      assert(c?.character?.id === id && c.character.card && typeof c.userName === 'string' && typeof c.promises === 'string', '节律角色无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少节律时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(c.settings?.mode === 'daily' && ['pick', 'new'].includes(c.settings.outfitMode)
        && ['schedule', 'meals', 'outfits'].every((k) => typeof c.settings.vary?.[k as keyof typeof c.settings.vary] === 'boolean'), '节律设置无效');
      assert(Array.isArray(c.template?.schedule) && c.template.schedule.length && c.template.meals && Array.isArray(c.template.wardrobe)
        && Array.isArray(c.world?.locations) && c.world.locations.length && Array.isArray(c.people), '缺少节律模板或世界');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO rhythm_contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM rhythm_contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = rhythm_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE rhythm_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了节律设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/rhythm/days' && request.method === 'GET') {
    const rows = await env.DB.prepare(`SELECT d.character_id, d.date, d.data, d.last_error FROM rhythm_days d
      INNER JOIN rhythm_contexts c ON c.character_id = d.character_id ORDER BY d.date DESC`).all<{ character_id: string; date: string; data: string | null; last_error: string | null }>();
    return json({ days: rows.results.filter((d) => d.data).map((d) => JSON.parse(d.data!)),
      errors: rows.results.filter((d) => d.last_error).map((d) => ({ characterId: d.character_id, date: d.date, reason: d.last_error })) });
  }
  if (path === '/v1/memory/contexts' && request.method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT character_id AS id, revision FROM memory_contexts').all()).results });
  }
  if (path.startsWith('/v1/memory/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/memory/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM memory_contexts WHERE character_id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context: c, revision } = await body<{ context: MemoryConsolidationContext; revision: number }>(request);
      assert(c?.characterId === id && c.character?.name && typeof c.userName === 'string', '记忆整理的角色无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(Array.isArray(c.mergeGroups) && c.mergeGroups.length <= 50 && Array.isArray(c.rollups) && c.rollups.length <= 50
        && Array.isArray(c.followups) && c.followups.length <= 200 && Array.isArray(c.newMemories) && c.newMemories.length <= 200
        && Array.isArray(c.profile?.lines), '记忆整理的内容无效');
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"整理"预设');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO memory_contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM memory_contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = memory_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE memory_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了记忆整理的内容，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/memory/results' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const rows = await env.DB.prepare('SELECT result, done_at FROM memory_jobs WHERE done_at > ? AND result IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ result: string; done_at: number }>();
    const errors = await env.DB.prepare('SELECT character_id, date, last_error FROM memory_jobs WHERE result IS NULL AND last_error IS NOT NULL').all<{ character_id: string; date: string; last_error: string }>();
    return json({
      results: rows.results.map((r) => ({ doneAt: r.done_at, result: JSON.parse(r.result) as MemoryJobResult })),
      errors: errors.results.map((e) => ({ characterId: e.character_id, date: e.date, reason: e.last_error })),
    });
  }
  if (path === '/v1/social/contexts' && request.method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT character_id AS id, revision FROM social_contexts').all()).results });
  }
  if (path.startsWith('/v1/social/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/social/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM social_contexts WHERE character_id = ?').bind(id),
        env.DB.prepare('DELETE FROM social_posts WHERE character_id = ? AND data IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context: c, revision } = await body<{ context: SocialContext; revision: number }>(request);
      assert(c?.character?.id === id && c.character.name && c.character.card && typeof c.userName === 'string', '朋友圈的角色无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(typeof c.settings?.enabled === 'boolean' && Number.isInteger(c.settings.perDay) && c.settings.perDay >= 1 && c.settings.perDay <= SOCIAL_PER_DAY_MAX, '朋友圈设置无效');
      assert([c.awake?.from, c.awake?.to].every((t, i) => typeof t === 'string' && (/^([01]\d|2[0-3]):[0-5]\d$/.test(t) || (i === 1 && t === '24:00'))), '作息时间须为 HH:mm');
      assert([c.memories, c.recent, c.feed].every((t) => typeof t === 'string') && (c.day === null || Array.isArray(c.day?.schedule)), '朋友圈的内容无效');
      // 不自己发朋友圈、只在社群里发帖的角色可以没有朋友圈预设
      assert(c.settings.enabled ? c.preset && Array.isArray(c.preset.blocks) : c.preset === null || Array.isArray(c.preset?.blocks), '缺少"社媒 · 朋友圈"预设');
      assert(['full', 'name-only', 'hidden'].includes(c.preview), '通知预览无效');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO social_contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM social_contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = social_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE social_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了朋友圈设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/social/posts' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    // since 那一刻的也返回（同一毫秒可能有两条）：手机按 id 去重
    const rows = await env.DB.prepare('SELECT data, done_at FROM social_posts WHERE done_at >= ? AND data IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ data: string; done_at: number }>();
    const errors = await env.DB.prepare('SELECT character_id, date, last_error FROM social_posts WHERE data IS NULL AND last_error IS NOT NULL AND due_at > ?')
      .bind(Date.now() - 86_400_000).all<{ character_id: string; date: string; last_error: string }>();
    return json({
      posts: rows.results.map((r) => ({ doneAt: r.done_at, moment: JSON.parse(r.data) as Moment })),
      errors: errors.results.map((e) => ({ characterId: e.character_id, date: e.date, reason: e.last_error })),
    });
  }
  if (path === '/v1/community/contexts' && request.method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT community_id AS id, revision FROM community_contexts').all()).results });
  }
  if (path.startsWith('/v1/community/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/community/contexts/'.length));
    if (request.method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM community_contexts WHERE community_id = ?').bind(id),
        env.DB.prepare('DELETE FROM community_posts WHERE community_id = ? AND data IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (request.method === 'PUT') {
      const { context: c, revision } = await body<{ context: CommunityContext; revision: number }>(request);
      assert(c?.community?.id === id && c.community.name && typeof c.community.description === 'string' && typeof c.community.vibe === 'string'
        && Array.isArray(c.community.tags) && typeof c.userName === 'string', '社群无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(communitySettingsValid(c.settings, ['perDay', 'batchSize', 'memberPerDay']) && typeof c.settings.notify === 'boolean', '社群设置无效');
      assert([c.awake?.from, c.awake?.to].every((t) => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t)), '作息时间须为 HH:mm');
      assert(Array.isArray(c.members) && c.members.length <= 50 && c.members.every((m) => typeof m?.id === 'string' && typeof m.name === 'string') && typeof c.feed === 'string', '社群的内容无效');
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"社媒 · 社群"预设');
      assert(['full', 'name-only', 'hidden'].includes(c.preview), '通知预览无效');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO community_contexts(community_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM community_contexts WHERE community_id = ?)
        ON CONFLICT(community_id) DO UPDATE SET revision = community_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE community_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了社群设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/community/posts' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    // since 那一刻的也返回（同一毫秒可能有两批）：手机按 id 去重
    const rows = await env.DB.prepare('SELECT data, done_at FROM community_posts WHERE done_at >= ? AND data IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ data: string; done_at: number }>();
    const errors = await env.DB.prepare('SELECT community_id, date, last_error FROM community_posts WHERE data IS NULL AND last_error IS NOT NULL AND due_at > ?')
      .bind(Date.now() - 86_400_000).all<{ community_id: string; date: string; last_error: string }>();
    return json({
      batches: rows.results.map((r) => ({ doneAt: r.done_at, posts: JSON.parse(r.data) as CommunityPost[] })),
      errors: errors.results.map((e) => ({ communityId: e.community_id, date: e.date, reason: e.last_error })),
    });
  }
  if (path.startsWith('/v1/planner/')) return plannerApi(request, env, url);
  if (path.startsWith('/v1/parallel/')) return parallelApi(request, env, url);
  if (path.startsWith('/v1/health/')) return healthApi(request, env, url);
  // 给云端的 Google 地图 Key（排健康计划时查家附近的店）：加密存，只写不读
  if (path === '/v1/secrets/maps' && request.method === 'PUT') {
    const { key } = await body<{ key: string }>(request);
    assert(typeof key === 'string' && key.trim().length >= 10 && key.length <= 200, 'Google 地图 Key 无效');
    const secret = await seal(env.KEK, { key: key.trim() });
    await env.DB.prepare("INSERT INTO secrets(id, ciphertext, iv) VALUES ('maps', ?, ?) ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv")
      .bind(secret.ciphertext, secret.iv).run();
    return json({ ok: true });
  }
  if (path === '/v1/secrets/maps' && request.method === 'DELETE') {
    await env.DB.prepare("DELETE FROM secrets WHERE id = 'maps'").run();
    return json({ ok: true });
  }
  if (['/v1/secrets/proactive', '/v1/secrets/rhythm', '/v1/secrets/consolidate', '/v1/secrets/social', '/v1/secrets/planner', '/v1/secrets/parallel', '/v1/secrets/health'].includes(path) && request.method === 'PUT') {
    const role = path === '/v1/secrets/rhythm' ? 'rhythm' : path === '/v1/secrets/consolidate' ? 'consolidate' : path === '/v1/secrets/social' ? 'social'
      : path === '/v1/secrets/planner' ? 'planner' : path === '/v1/secrets/parallel' ? 'parallel' : path === '/v1/secrets/health' ? 'health' : 'proactive';
    const credentials = await body<ProactiveCredentials>(request);
    assert(Array.isArray(credentials.routes) && credentials.keys && Array.isArray(credentials.outputFilters), 'API 配置无效');
    const system = new AgentSystem({ config: { routes: () => credentials.routes, keyOf: (id) => credentials.keys[id] || null, textObfuscation: () => credentials.textObfuscation } });
    const chain = system.router.chain(role);
    assert(credentials.routes.every((r) => chain.includes(r.role)), '只接受该功能及其跟随的 API 配置');
    const status = system.status(role);
    assert(status.live, status.live ? '' : status.reason);
    const secret = await seal(env.KEK, credentials);
    await env.DB.prepare('INSERT INTO secrets(id, ciphertext, iv) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv')
      .bind(role, secret.ciphertext, secret.iv).run();
    return json({ ok: true });
  }
  if (path === '/v1/inbox' && request.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const [messages, points] = await Promise.all([
      env.DB.prepare('SELECT seq, character_id, data FROM messages WHERE seq > ? ORDER BY seq LIMIT 201').bind(since).all<{ seq: number; character_id: string; data: string }>(),
      env.DB.prepare('SELECT data, status, last_error, push_error FROM touchpoints WHERE due_at >= ?').bind(Date.now() - 3 * 86_400_000).all<{ data: string; status: string; last_error: string | null; push_error: string | null }>(),
    ]);
    const page = messages.results.slice(0, 200);
    return json({
      messages: page.map((m) => ({ seq: m.seq, characterId: m.character_id, message: JSON.parse(m.data) })),
      next: page.at(-1)?.seq ?? since, more: messages.results.length > 200,
      touchpoints: points.results.map((t) => ({ ...JSON.parse(t.data) as Touchpoint, status: t.status, lastError: t.last_error, pushError: t.push_error })),
    });
  }
  if (path === '/v1/push/subscribe' && request.method === 'POST') {
    const data = await body<{ kind: 'webpush' | 'webhook'; label: string; config: { endpoint?: string; keys?: { p256dh?: string; auth?: string } } & Partial<Webhook> }>(request);
    assert(['webpush', 'webhook'].includes(data.kind) && typeof data.label === 'string' && data.label.length <= 100, '推送通道无效');
    assert(data.config && https(data.kind === 'webpush' ? data.config.endpoint ?? '' : data.config.url ?? ''), '推送地址必须为 HTTPS');
    if (data.kind === 'webpush') assert(data.config.keys?.p256dh && data.config.keys.auth, '缺少 Web Push 订阅密钥');
    else assert(['bark', 'ntfy', 'custom'].includes(data.config.preset ?? ''), '未知 webhook 类型');
    const id = await digest(data.kind + ':' + (data.config.endpoint ?? data.config.url));
    const sealed = await seal(env.KEK, data.config);
    await env.DB.prepare(`INSERT INTO push_channels(id, device_id, kind, label, ciphertext, iv) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET label = excluded.label, ciphertext = excluded.ciphertext, iv = excluded.iv`)
      .bind(id, device.id, data.kind, data.label, sealed.ciphertext, sealed.iv).run();
    return json({ id });
  }
  if (path.startsWith('/v1/push/channels/')) {
    const id = decodeURIComponent(path.slice('/v1/push/channels/'.length));
    if (request.method === 'DELETE') {
      await env.DB.prepare('DELETE FROM push_channels WHERE id = ?').bind(id).run();
      return json({ ok: true });
    }
    if (request.method === 'POST') {
      const ch = await env.DB.prepare('SELECT * FROM push_channels WHERE id = ?').bind(id).first<Channel>();
      if (!ch) throw new HttpError(404, '推送通道不存在');
      await sendChannel(env, ch, { title: 'AI 陪伴', body: '云端通知已接通，关闭 App 后也能接收', tag: `test:${Date.now()}`, route: '/me/proactive' });
      return json({ ok: true });
    }
  }
  throw new HttpError(404, '接口不存在');
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** 健康计划：每个人设拼好的材料（上传、删掉）、云端排好的计划（手机按 done_at 拉） */
async function healthApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/v1/health/contexts' && method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT persona_id AS id, revision FROM health_contexts').all()).results });
  }
  if (path.startsWith('/v1/health/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/health/contexts/'.length));
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM health_contexts WHERE persona_id = ?').bind(id),
        env.DB.prepare('DELETE FROM health_jobs WHERE persona_id = ? AND result IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const { context: c, revision } = await body<{ context: HealthPlanContext; revision: number }>(request);
      assert(c?.persona?.id === id && typeof c.persona.name === 'string', '健康计划的人设无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(typeof c.runAt === 'string' && HHMM.test(c.runAt), '排计划的时间须为 HH:mm');
      assert(c.base && ['healthProfile', 'healthTime', 'healthKitchen'].every((k) => typeof c.base[k as keyof typeof c.base] === 'string'), '健康设置无效');
      assert(Array.isArray(c.weekMinutes) && c.weekMinutes.length === 7 && c.weekMinutes.every((m) => Number.isInteger(m) && m >= 0), '每天能练多久无效');
      assert(Array.isArray(c.days) && c.days.length <= 3 && c.days.every((d) => typeof d?.date === 'string' && ['today', 'recent', 'nearby', 'near'].every((k) => typeof d[k as keyof typeof d] === 'string')), '健康计划的材料无效');
      assert(c.home === null || (typeof c.home?.lat === 'number' && typeof c.home.lng === 'number' && Math.abs(c.home.lat) <= 90 && Math.abs(c.home.lng) <= 180), '家的坐标无效');
      assert(Array.isArray(c.weeks) && c.weeks.length <= 3 && c.weeks.every((w) => typeof w?.weekStart === 'string' && Array.isArray(w.days)), '这周的计划无效');
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"健康"预设');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO health_contexts(persona_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM health_contexts WHERE persona_id = ?)
        ON CONFLICT(persona_id) DO UPDATE SET revision = health_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE health_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了健康设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/health/results' && method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const rows = await env.DB.prepare('SELECT result, done_at FROM health_jobs WHERE done_at > ? AND result IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ result: string; done_at: number }>();
    const errors = await env.DB.prepare(`SELECT j.persona_id, j.date, j.last_error FROM health_jobs j
      INNER JOIN health_contexts c ON c.persona_id = j.persona_id WHERE j.result IS NULL AND j.last_error IS NOT NULL AND j.date >= ?`)
      .bind(shiftDate(new Date().toISOString().slice(0, 10), -1)).all<{ persona_id: string; date: string; last_error: string }>();
    return json({
      results: rows.results.map((r) => ({ doneAt: r.done_at, result: JSON.parse(r.result) as HealthRunResult })),
      errors: errors.results.map((e) => ({ personaId: e.persona_id, date: e.date, reason: e.last_error })),
    });
  }
  throw new HttpError(404, '接口不存在');
}

/** 平行时空：每个角色给你留言要的东西（上传、删掉）、云端留好的言（手机按 done_at 拉） */
async function parallelApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/v1/parallel/contexts' && method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT character_id AS id, revision FROM parallel_contexts').all()).results });
  }
  if (path.startsWith('/v1/parallel/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/parallel/contexts/'.length));
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM parallel_contexts WHERE character_id = ?').bind(id),
        env.DB.prepare('DELETE FROM parallel_notes WHERE character_id = ? AND data IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const { context: c, revision } = await body<{ context: ParallelContext; revision: number }>(request);
      assert(c?.character?.id === id && c.character.name && c.character.card && typeof c.persona?.id === 'string' && typeof c.persona.name === 'string', '平行时空的角色无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(typeof c.settings?.enabled === 'boolean' && Number.isInteger(c.settings.perDay) && c.settings.perDay >= 1 && c.settings.perDay <= PARALLEL_PER_DAY_MAX, '平行时空设置无效');
      const times = [c.awake?.from, c.awake?.to, c.env?.wakeTime, c.env?.sleepTime, ...Object.values(c.env?.meals ?? {}).flatMap((w) => [w?.start, w?.end])];
      assert(times.length === 10 && times.every((t, i) => typeof t === 'string' && (HHMM.test(t) || (i === 1 && t === '24:00'))), '作息时间须为 HH:mm');
      assert([c.memories, c.recent, c.notes].every((t) => typeof t === 'string') && (c.her === null || Array.isArray(c.her?.schedule))
        && (c.mine === null || (typeof c.mine?.date === 'string' && Array.isArray(c.mine.entries) && c.mine.entries.length <= 200)), '平行时空的内容无效');
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"平行时空"预设');
      assert(['full', 'name-only', 'hidden'].includes(c.preview), '通知预览无效');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO parallel_contexts(character_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM parallel_contexts WHERE character_id = ?)
        ON CONFLICT(character_id) DO UPDATE SET revision = parallel_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE parallel_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了平行时空设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  // —— 整理你的一天：每个人设的材料（今天、明天的家务和健康计划）、整理好的计划 ——
  if (path === '/v1/parallel/plan-contexts' && method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT persona_id AS id, revision FROM parallel_plan_contexts').all()).results });
  }
  if (path.startsWith('/v1/parallel/plan-contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/parallel/plan-contexts/'.length));
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM parallel_plan_contexts WHERE persona_id = ?').bind(id),
        env.DB.prepare('DELETE FROM parallel_plans WHERE persona_id = ? AND result IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const { context: c, revision } = await body<{ context: ParallelPlanContext; revision: number }>(request);
      assert(c?.persona?.id === id && typeof c.persona.name === 'string', '平行时空的人设无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(typeof c.planAt === 'string' && HHMM.test(c.planAt), '整理时间须为 HH:mm');
      const times = [c.env?.wakeTime, c.env?.sleepTime, ...Object.values(c.env?.meals ?? {}).flatMap((w) => [w?.start, w?.end])];
      assert(times.length === 8 && times.every((t) => typeof t === 'string' && HHMM.test(t)), '作息时间须为 HH:mm');
      assert(Array.isArray(c.days) && c.days.length <= 3 && c.days.every((d) => typeof d?.date === 'string' && Array.isArray(d.chores) && d.chores.length <= 200
        && (d.health === null || typeof d.health === 'object') && (d.plan === null || Array.isArray(d.plan?.items))), '整理你的一天的内容无效');
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"平行时空 · 整理你的一天"预设');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const updated = await env.DB.prepare(`INSERT INTO parallel_plan_contexts(persona_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM parallel_plan_contexts WHERE persona_id = ?)
        ON CONFLICT(persona_id) DO UPDATE SET revision = parallel_plan_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE parallel_plan_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(c), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了平行时空设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/parallel/plans' && method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const rows = await env.DB.prepare('SELECT result, done_at FROM parallel_plans WHERE done_at > ? AND result IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ result: string; done_at: number }>();
    const errors = await env.DB.prepare(`SELECT p.persona_id, p.date, p.last_error FROM parallel_plans p
      INNER JOIN parallel_plan_contexts c ON c.persona_id = p.persona_id WHERE p.result IS NULL AND p.last_error IS NOT NULL AND p.date >= ?`)
      .bind(shiftDate(new Date().toISOString().slice(0, 10), -1)).all<{ persona_id: string; date: string; last_error: string }>();
    return json({
      plans: rows.results.map((r) => ({ doneAt: r.done_at, plan: JSON.parse(r.result) as ParallelPlan })),
      errors: errors.results.map((e) => ({ personaId: e.persona_id, date: e.date, reason: e.last_error })),
    });
  }
  if (path === '/v1/parallel/notes' && method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    // since 那一刻的也返回（同一毫秒可能有两条）：手机按 id 去重
    const rows = await env.DB.prepare('SELECT data, done_at FROM parallel_notes WHERE done_at >= ? AND data IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ data: string; done_at: number }>();
    const errors = await env.DB.prepare('SELECT character_id, date, last_error FROM parallel_notes WHERE data IS NULL AND last_error IS NOT NULL AND due_at > ?')
      .bind(Date.now() - 86_400_000).all<{ character_id: string; date: string; last_error: string }>();
    return json({
      notes: rows.results.map((r) => ({ doneAt: r.done_at, note: JSON.parse(r.data) as ParallelNote })),
      errors: errors.results.map((e) => ({ characterId: e.character_id, date: e.date, reason: e.last_error })),
    });
  }
  throw new HttpError(404, '接口不存在');
}

function validSecret(s: McpServerSecret | null | undefined): s is McpServerSecret {
  if (!s || !https(s.url)) return false;
  if (s.headers && (typeof s.headers !== 'object' || Object.values(s.headers).some((v) => typeof v !== 'string'))) return false;
  const o = s.oauth;
  return !o || (https(o.tokenEndpoint) && typeof o.clientId === 'string' && typeof o.accessToken === 'string' && ['post', 'basic', 'none'].includes(o.authMethod));
}

/**
 * 日程系统（日程计划）：人设的设置和材料、MCP 服务器的密钥（加密存、读不回来）、OAuth 登录（换 Token 在这里做，Token 不回到手机）、
 * 现在就排、拉排好的结果
 */
/** /v1/planner/mcp/:id/call 能调的工具：日历里看、建、改、删日程 */
const MCP_CALL_TOOLS = new Set(['list_events', 'get_event', 'create_event', 'update_event', 'delete_event']);

async function plannerApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  if (path === '/v1/planner/contexts' && method === 'GET') {
    return json({ contexts: (await env.DB.prepare('SELECT persona_id AS id, revision FROM planner_contexts').all()).results });
  }
  if (path.startsWith('/v1/planner/contexts/')) {
    const id = decodeURIComponent(path.slice('/v1/planner/contexts/'.length));
    if (method === 'DELETE') {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM planner_contexts WHERE persona_id = ?').bind(id),
        env.DB.prepare('DELETE FROM planner_jobs WHERE persona_id = ? AND result IS NULL').bind(id),
      ]);
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const { context: c, revision } = await body<{ context: PlannerContext; revision: number }>(request);
      assert(c?.persona?.id === id && typeof c.persona.name === 'string' && typeof c.persona.description === 'string', '人设无效');
      assert(typeof c.timezone === 'string' && c.timezone, '缺少时区');
      try { zonedParts(Date.now(), c.timezone); } catch { throw new HttpError(400, '无效的 IANA 时区'); }
      assert(c.preset && Array.isArray(c.preset.blocks), '缺少"计划"预设');
      assert(typeof c.life === 'string' && typeof c.recent === 'string' && (c.character === null || typeof c.character?.name === 'string'), '日程系统的内容无效');
      const settings = normalizePlanner(c.settings);
      assert(settings.servers.every((s) => !s.url || https(s.url)), 'MCP 地址必须是 HTTPS');
      assert(Number.isSafeInteger(revision) && revision >= 0, 'revision 无效');
      const data: PlannerContext = { ...c, settings };
      const updated = await env.DB.prepare(`INSERT INTO planner_contexts(persona_id, revision, data, updated_at)
        SELECT ?, 1, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM planner_contexts WHERE persona_id = ?)
        ON CONFLICT(persona_id) DO UPDATE SET revision = planner_contexts.revision + 1, data = excluded.data, updated_at = excluded.updated_at
        WHERE planner_contexts.revision = ? RETURNING revision`)
        .bind(id, JSON.stringify(data), Date.now(), revision, id, revision).first<{ revision: number }>();
      if (!updated) throw new HttpError(409, '另一台设备更新了日程设置，请在「云端与同步」选择「用本机设置重新同步」');
      return json(updated);
    }
  }
  if (path === '/v1/planner/results' && method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0);
    assert(Number.isSafeInteger(since) && since >= 0, 'since 无效');
    const rows = await env.DB.prepare('SELECT result, done_at FROM planner_jobs WHERE done_at > ? AND result IS NOT NULL ORDER BY done_at LIMIT 50')
      .bind(since).all<{ result: string; done_at: number }>();
    const errors = await env.DB.prepare(`SELECT j.persona_id, j.date, j.last_error FROM planner_jobs j
      INNER JOIN planner_contexts c ON c.persona_id = j.persona_id WHERE j.last_error IS NOT NULL AND j.date >= ?`)
      .bind(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10)).all<{ persona_id: string; date: string; last_error: string }>();
    return json({
      results: rows.results.map((r) => ({ doneAt: r.done_at, result: JSON.parse(r.result) as PlannerRunResult })),
      errors: errors.results.map((e) => ({ personaId: e.persona_id, date: e.date, reason: e.last_error })),
    });
  }
  if (path.startsWith('/v1/planner/run/') && method === 'POST') {
    const id = decodeURIComponent(path.slice('/v1/planner/run/'.length));
    const want = await body<{ week: boolean; day: boolean }>(request);
    assert(typeof want.week === 'boolean' && typeof want.day === 'boolean' && (want.week || want.day), '要排哪一份？');
    try {
      return json({ result: await runPlannerNow(env, id, want) });
    } catch (e) {
      throw new HttpError(502, e instanceof Error ? e.message.slice(0, 500) : String(e));
    }
  }
  const mcp = path.match(/^\/v1\/planner\/mcp\/([^/]+)(\/tools|\/call)?$/);
  if (mcp) {
    const serverId = decodeURIComponent(mcp[1]!);
    if (!mcp[2] && method === 'PUT') {
      const secret = await body<McpServerSecret>(request);
      assert(validSecret(secret), 'MCP 的地址或登录信息无效（地址必须是 HTTPS）');
      await saveMcpSecret(env, serverId, secret);
      return json({ ok: true });
    }
    if (!mcp[2] && method === 'DELETE') {
      await env.DB.prepare('DELETE FROM planner_mcp WHERE server_id = ?').bind(serverId).run();
      return json({ ok: true });
    }
    if (mcp[2] === '/call' && method === 'POST') {
      // 调日历的一个工具（平行时空把记的事同步进 Google 日历、看这几天日历里已有的）：用云端存的登录信息，Token 不回到手机；只放日程相关的几个工具
      const { server: raw, tool, args } = await body<{ server: unknown; tool: string; args: unknown }>(request);
      const server = normalizeMcpServer(raw, serverId);
      assert(server && server.id === serverId && server.kind === 'calendar', '服务器无效');
      assert(typeof tool === 'string' && MCP_CALL_TOOLS.has(tool), '不能调这个工具');
      assert(!!args && typeof args === 'object' && !Array.isArray(args), '参数无效');
      const secret = await mcpSecret(env, serverId);
      assert(secret || (server.auth === 'none' && https(server.url)), server.auth === 'none' ? 'MCP 地址必须是 HTTPS' : '云端还没有它的登录信息');
      try {
        const session = await openMcpSession(server, secret ?? { url: server.url }, { onUpdate: (s) => saveMcpSecret(env, serverId, s), signal: AbortSignal.timeout(60_000) });
        try {
          return json({ result: await session.call(tool, args as Record<string, unknown>) });
        } finally {
          await session.close();
        }
      } catch (e) {
        throw new HttpError(502, e instanceof Error ? e.message.slice(0, 500) : String(e));
      }
    }
    if (mcp[2] === '/tools' && method === 'POST') {
      // 列出工具：用云端存的登录信息（不用登录的服务器按手机给的地址连）
      const { server: raw } = await body<{ server: unknown }>(request);
      const server = normalizeMcpServer(raw, serverId);
      assert(server && server.id === serverId, '服务器无效');
      const secret = await mcpSecret(env, serverId);
      assert(secret || (server.auth === 'none' && https(server.url)), server.auth === 'none' ? 'MCP 地址必须是 HTTPS' : '云端还没有它的登录信息');
      try {
        const session = await openMcpSession(server, secret ?? { url: server.url }, { onUpdate: (s) => saveMcpSecret(env, serverId, s), signal: AbortSignal.timeout(60_000) });
        await session.close();
        return json({ tools: session.tools });
      } catch (e) {
        throw new HttpError(502, e instanceof Error ? e.message.slice(0, 500) : String(e));
      }
    }
  }
  if (path === '/v1/planner/oauth/discover' && method === 'POST') {
    const { url: target } = await body<{ url: string }>(request);
    assert(https(target), 'MCP 地址必须是 HTTPS');
    try { return json(await discoverOAuth(target)); } catch (e) { throw new HttpError(502, e instanceof Error ? e.message : String(e)); }
  }
  if (path === '/v1/planner/oauth/register' && method === 'POST') {
    const d = await body<{ registrationEndpoint: string; redirectUri: string; clientName: string; scope?: string }>(request);
    assert(https(d.registrationEndpoint) && typeof d.redirectUri === 'string' && typeof d.clientName === 'string', '注册信息无效');
    try { return json(await registerOAuthClient(d.registrationEndpoint, d)); } catch (e) { throw new HttpError(502, e instanceof Error ? e.message : String(e)); }
  }
  if (path === '/v1/planner/oauth/token' && method === 'POST') {
    // 用授权码换 Token，直接加密存进 D1：Token 不回到手机
    const d = await body<Omit<McpOAuthToken, 'accessToken' | 'refreshToken' | 'expiresAt'> & { serverId: string; url: string; code: string; verifier: string; redirectUri: string }>(request);
    assert(typeof d.serverId === 'string' && d.serverId && https(d.url) && https(d.tokenEndpoint) && typeof d.clientId === 'string' && typeof d.code === 'string' && typeof d.verifier === 'string', '授权信息无效');
    const { serverId, url: serverUrl, ...input } = d;
    let token: McpOAuthToken;
    try { token = await exchangeOAuthCode(input); } catch (e) { throw new HttpError(502, e instanceof Error ? e.message : String(e)); }
    await saveMcpSecret(env, serverId, { url: serverUrl, oauth: token });
    return json({ ok: true, expiresAt: token.expiresAt ?? null, refresh: !!token.refreshToken });
  }
  throw new HttpError(404, '接口不存在');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = env.APP_ORIGIN.split(',').map((s) => s.trim());
    if (origin && !allowed.includes(origin)) return json({ error: '来源不允许' }, 403);
    let response: Response;
    try {
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await api(request, env);
    } catch (e) {
      response = e instanceof HttpError ? json({ error: e.message }, e.status)
        : e instanceof PushDeliveryError ? json({ error: e.message }, 502)
        : json({ error: 'Worker 操作失败，请检查云端配置和日志' }, 500);
    }
    if (origin) response.headers.set('Access-Control-Allow-Origin', origin);
    response.headers.set('Vary', 'Origin');
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    // MCP 客户端会带协议版本和会话号；微信读书 MCP 的登录信息也在请求头里；同步的大文件分块传时类型放在 X-Blob-Type
    response.headers.set('Access-Control-Allow-Headers', ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'X-Blob-Type', ...Object.values(WEREAD_HEADERS)].join(', '));
    response.headers.set('Access-Control-Expose-Headers', ['Mcp-Session-Id', 'X-Blob-Type', WEREAD_HEADERS.cookie].join(', '));
    return response;
  },
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Scheduled execution is independent of HTTP requests and browser/service-worker lifetime.
    const jobs = await Promise.allSettled([runScheduled(env, controller.scheduledTime), runRhythmScheduled(env, controller.scheduledTime), runMemoryScheduled(env, controller.scheduledTime),
      runSocialScheduled(env, controller.scheduledTime), runCommunityScheduled(env, controller.scheduledTime), runPlannerScheduled(env, controller.scheduledTime),
      runParallelScheduled(env, controller.scheduledTime), runHealthScheduled(env, controller.scheduledTime), runParallelPlanScheduled(env, controller.scheduledTime)]);
    const failure = jobs.find((r) => r.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  },
} satisfies ExportedHandler<Env>;
