import { AgentSystem, AiError, buildDiaryMessages, diaryInput, samplerRequest } from '@app/ai';
import { diaryId, dueDiaryDates, estimateTokens, parseDiaryDraft, shiftDate, type DiaryContext, type DiaryEntry, type HubNotification, type ProactiveCredentials, type SocialDay } from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { sendChannel, type Channel } from './push.ts';
import { release, releaseExpired, reserve, setMeta } from './scheduler.ts';
import { todayOf } from './social.ts';

/**
 * 日记（"日记"的 API 和预设）：开了"主动写日记"的角色每晚 22:00（按上传的时区）写当天的日记，PWA 关着也写。
 * - 写什么：手机上传的角色卡、今天的节律（云端排过今天的以云端为准）、今天和你、记得的事、最近几篇日记；
 *   手机上传之后云端又写过的也带上，免得好几天不开 App 时重复；
 * - 每个角色、每一天单独领取（租约），重叠的 Cron 不会重复写；失败在后面的 Cron 里重试，过了补写窗口（第二天中午）的不补；
 * - 图不在云端画：模型写下要配的画面，手机收到后用"生图"画。
 */

interface ContextRow { character_id: string; revision: number; data: string; updated_at: number }
const LEASE_MS = 180_000;

export function diaryRequest(context: DiaryContext, now: number, date: string, day: SocialDay | null) {
  if (!context.preset) throw new Error('没有日记预设');
  return { messages: buildDiaryMessages(diaryInput(context, now, date, day), context.preset), ...samplerRequest(context.preset.sampler) };
}

export async function generateDiary(context: DiaryContext, credentials: ProactiveCredentials, date: string, now: number, day: SocialDay | null): Promise<{ entry: DiaryEntry; tokens: number }> {
  // The scheduler reserves the user-configured budget in D1 across concurrent characters.
  const system = new AgentSystem({ config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null, textObfuscation: () => credentials.textObfuscation }, outputFilters: credentials.outputFilters, jsonRetry: () => context.preset?.texts?.['common.jsonRetry'] });
  const { value, result } = await system.json('diary', diaryRequest(context, now, date, day), parseDiaryDraft, { signal: AbortSignal.timeout(150_000) });
  const entry: DiaryEntry = {
    id: diaryId(context.character.id, date), characterId: context.character.id, date,
    title: value.title, weather: value.weather, mood: value.mood, text: value.text, highlights: value.highlights,
    images: value.image && context.settings.image ? [{ caption: value.image, assetKey: null }] : [],
    source: 'hub', model: result.model, unread: true, createdAt: now, updatedAt: now,
  };
  return { entry, tokens: system.usedToday('diary') };
}

export type DiaryGenerator = typeof generateDiary;

function notificationFor(context: DiaryContext, entry: DiaryEntry): HubNotification {
  return {
    title: context.preview === 'hidden' ? 'AI 陪伴' : context.character.name,
    body: context.preview === 'full' ? `日记${entry.title ? `《${entry.title}》` : ''}：${entry.text.slice(0, 300)}` : context.preview === 'name-only' ? '写了今天的日记' : '有一篇新日记',
    tag: entry.id, route: `/memories?char=${encodeURIComponent(context.character.id)}&tab=diary`,
  };
}

async function writeOne(env: Env, row: ContextRow, date: string, dueAt: number, credentials: ProactiveCredentials, now: number, generate: DiaryGenerator) {
  const context = JSON.parse(row.data) as DiaryContext;
  const id = row.character_id;
  const lease = crypto.randomUUID();
  // Each character/date has its own atomic claim. Other characters start immediately.
  const claim = await env.DB.prepare(`INSERT INTO diary_entries(character_id, date, due_at, lease, lease_until, attempts)
    SELECT ?, ?, ?, ?, ?, 1 WHERE EXISTS (
      SELECT 1 FROM diary_contexts c WHERE c.character_id = ? AND c.revision = ?
      AND NOT EXISTS (SELECT 1 FROM sync_records r WHERE r.kind = 'characters' AND r.parent = '' AND r.id = c.character_id AND r.deleted = 1)
    ) ON CONFLICT(character_id, date) DO UPDATE SET
      due_at = excluded.due_at, lease = excluded.lease, lease_until = excluded.lease_until, attempts = diary_entries.attempts + 1
    WHERE diary_entries.data IS NULL AND diary_entries.lease_until <= ? AND diary_entries.retry_at <= ? RETURNING attempts`)
    .bind(id, date, dueAt, lease, now + LEASE_MS, id, row.revision, now, now).first<{ attempts: number }>();
  if (!claim) return;
  let used = 0;
  try {
    const [day, later] = await Promise.all([
      // 云端排过那一天的节律就用云端那份（手机上改过的以手机为准）
      todayOf(env, { character: context.character, timezone: context.timezone, day: context.day }, now),
      // 手机上传之后云端又写过的：手机没来得及拉的那几篇也算"写过的"
      env.DB.prepare('SELECT data FROM diary_entries WHERE character_id = ? AND done_at > ? AND data IS NOT NULL ORDER BY done_at DESC LIMIT 3')
        .bind(id, row.updated_at).all<{ data: string }>(),
    ]);
    const mine = later.results.map((r) => JSON.parse(r.data) as DiaryEntry).reverse()
      .map((e) => `${e.date.slice(5)} ${context.character.name}的日记${e.title ? `《${e.title}》` : ''}：「${e.text.replace(/\s+/g, ' ').slice(0, 220)}」`);
    const current: DiaryContext = { ...context, previous: [context.previous, ...mine].filter(Boolean).join('\n') };
    const route = credentials.routes.find((r) => r.role === 'diary');
    const request = diaryRequest(current, now, date, day);
    const estimate = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? route?.params?.maxTokens ?? 0);
    if (!await reserve(env, lease, `diary:${date}`, estimate, route?.dailyTokenBudget ?? 0, now)) throw new AiError('budget', '日记每日 token 预算已用完');
    const result = await generate(current, credentials, date, now, day);
    used = result.tokens;
    // A settings change/removal during the call invalidates the output, without blocking any other role.
    const saved = await env.DB.prepare(`UPDATE diary_entries SET data = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL, done_at = ?
      WHERE character_id = ? AND date = ? AND lease = ?
      AND EXISTS (SELECT 1 FROM diary_contexts c WHERE c.character_id = ? AND c.revision = ?
        AND NOT EXISTS (SELECT 1 FROM sync_records r WHERE r.kind = 'characters' AND r.parent = '' AND r.id = c.character_id AND r.deleted = 1))`)
      .bind(JSON.stringify(result.entry), Date.now(), id, date, lease, id, row.revision).run();
    if (!saved.meta.changes) throw new Error('生成期间日记设置更新');
    // 通知发一次就好：发不出去不重发（打开 App 就能看到），也不算这一篇失败
    const channels = await env.DB.prepare('SELECT * FROM push_channels').all<Channel>();
    await Promise.allSettled(channels.results.map((ch) => sendChannel(env, ch, notificationFor(context, result.entry))));
  } catch (e) {
    // Provider messages may contain keys or response bodies; sync only a safe failure summary.
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.name : 'Error';
    await env.DB.prepare('UPDATE diary_entries SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE character_id = ? AND date = ? AND lease = ?')
      .bind(now + Math.min(30, 5 * 2 ** Math.min(claim.attempts - 1, 3)) * 60_000, `日记生成失败（${reason}），云端将自动重试`, id, date, lease).run();
  } finally {
    await release(env, lease, used);
  }
}

/** 每 5 分钟的 Cron 里跑；和主动消息的总开关无关，手机没开也写 */
export async function runDiaryScheduled(env: Env, now = Date.now(), generate: DiaryGenerator = generateDiary) {
  try {
    // 删除记录来自任意设备；即使这台设备没上传过上下文，也要注销角色的云端任务。
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM diary_contexts WHERE character_id IN (
        SELECT id FROM sync_records WHERE kind = 'characters' AND parent = '' AND deleted = 1
      )`),
      env.DB.prepare(`DELETE FROM diary_entries WHERE data IS NULL AND character_id IN (
        SELECT id FROM sync_records WHERE kind = 'characters' AND parent = '' AND deleted = 1
      )`),
    ]);
    const rows = await env.DB.prepare('SELECT character_id, revision, data, updated_at FROM diary_contexts').all<ContextRow>();
    if (!rows.results.length) { await setMeta(env, 'lastDiaryError', null); return; }
    const due = rows.results.flatMap((row) => {
      const context = JSON.parse(row.data) as DiaryContext;
      return context.settings.enabled ? dueDiaryDates(now, context.timezone).map((d) => ({ row, ...d })) : [];
    });
    if (due.length) {
      // 已经写好的那几天不用领取（少一次写入）
      const done = await env.DB.prepare(`SELECT character_id, date FROM diary_entries WHERE data IS NOT NULL AND date >= ?`)
        .bind(shiftDate(new Date(now).toISOString().slice(0, 10), -2)).all<{ character_id: string; date: string }>();
      const written = new Set(done.results.map((r) => `${r.character_id}\n${r.date}`));
      const todo = due.filter((d) => !written.has(`${d.row.character_id}\n${d.date}`));
      if (todo.length) {
        const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'diary'").first<{ ciphertext: string; iv: string }>();
        if (!sealed) throw new Error('未设置云端日记 API，请打开 App 同步');
        const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
        await releaseExpired(env, now);
        const results = await Promise.allSettled(todo.map((d) => writeOne(env, d.row, d.date, d.dueAt, credentials, now, generate)));
        if (results.some((r) => r.status === 'rejected')) throw new Error('部分日记任务失败，下一轮继续检测');
      }
    }
    await Promise.all([
      env.DB.prepare('DELETE FROM diary_entries WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
      setMeta(env, 'lastDiaryError', null),
    ]);
  } catch (e) {
    await setMeta(env, 'lastDiaryError', e instanceof Error ? e.message : '云端日记检测失败');
    throw e;
  }
}
