import { AgentSystem, AiError, buildCommunityMessages, communityFeedInput, communityMemberPostInput, samplerRequest } from '@app/ai';
import { COMMUNITY_CATCH_UP_MS, communityJobs, communityPostText, estimateTokens, isNetizen, MOMENT_USER, netizenName, parseCommunityBatch, postsFromDrafts, shiftDate, zonedDateKey,
  type CommunityContext, type CommunityJob, type CommunityPost, type HubNotification, type ProactiveCredentials, type SocialContext, type SocialDay } from '@app/shared';
import { unseal } from './crypto.ts';
import type { Env } from './env.ts';
import { sendChannel, type Channel } from './push.ts';
import { release, releaseExpired, reserve, setMeta } from './scheduler.ts';
import { todayOf } from './social.ts';

/**
 * 社群（"社媒"的 API 和"社媒 · 社群"预设）：你加入的每个社群，每天在随机的时间替网友发几批帖子，
 * 你邀请进社群的角色也在她醒着的时段里自己发帖。PWA 关着也发。
 * - 什么时候发：按社群和日期算出来的随机时间（@app/shared 的 communityJobs，手机算的也是这一组），到点的 Cron 领取那一格；
 * - 发什么：手机上传的社群介绍、设置和最近的帖子；角色的帖子再加上她自己上传的朋友圈上下文（角色卡、记忆、最近的聊天）
 *   和今天的节律；手机上传之后云端又发过的帖子也带上，免得好几天不开 App 时重复；
 * - 每个社群、每一天、每一格单独领取（租约），重叠的 Cron 不会重复发；失败在后面的 Cron 里重试，超过 3 小时的不补；
 * - API 和每日 token 预算用云端朋友圈的那一份（secrets 里的 social）；
 * - 图不在云端画：模型写下要配的画面，手机收到后用"生图"画。一小页 HTML 随正文一起存。
 */

interface ContextRow { community_id: string; revision: number; data: string; updated_at: number }
/** 这一格要发的：网友的一批，或者某个角色的一帖（带着她的朋友圈上下文） */
type Due = CommunityJob & { row: ContextRow; member?: SocialContext };
const LEASE_MS = 180_000;

/** 你和角色的名字 → id：模型不能替这些人发帖、回复 */
function knownNames(context: CommunityContext, member?: SocialContext): Record<string, string> {
  return { [context.userName]: MOMENT_USER, ...(member?.userName ? { [member.userName]: MOMENT_USER } : {}), ...Object.fromEntries(context.members.map((m) => [m.name, m.id])) };
}

export function communityRequest(context: CommunityContext, now: number, member?: { context: SocialContext; day: SocialDay | null }) {
  if (!context.preset) throw new Error('没有社群预设');
  const input = member ? communityMemberPostInput(context, member.context, now, member.day) : communityFeedInput(context, now);
  return { messages: buildCommunityMessages(input, context.preset), ...samplerRequest(context.preset.sampler) };
}

export async function generateCommunityPosts(context: CommunityContext, credentials: ProactiveCredentials, job: CommunityJob, now: number,
  member?: { context: SocialContext; day: SocialDay | null }): Promise<{ posts: CommunityPost[]; tokens: number }> {
  // The scheduler reserves the user-configured budget in D1 across concurrent communities.
  const system = new AgentSystem({ config: { routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })), keyOf: (k) => credentials.keys[k] || null }, outputFilters: credentials.outputFilters });
  const { value, result } = await system.json('social', communityRequest(context, now, member), parseCommunityBatch, { signal: AbortSignal.timeout(150_000) });
  const posts = postsFromDrafts(member ? value.slice(0, 1) : value.slice(0, context.settings.batchSize), {
    communityId: context.community.id, batchId: job.id, now, source: 'hub', model: result.model, known: knownNames(context, member?.context), unread: true,
    ...(member ? { authorId: member.context.character.id } : {}),
  });
  if (!posts.length) throw new AiError('bad_response', '模型没有写出能用的帖子', { retryable: true });
  return { posts, tokens: system.usedToday('social') };
}

export type CommunityGenerator = typeof generateCommunityPosts;

function notificationFor(context: CommunityContext, posts: CommunityPost[]): HubNotification {
  const first = posts[0]!;
  const author = context.members.find((m) => m.id === first.authorId)?.name;
  const where = `社群「${context.community.name}」`;
  const line = first.title || first.text;
  return {
    title: context.preview === 'hidden' ? 'AI 陪伴' : (author ?? context.community.name),
    body: context.preview === 'hidden' ? '社群有新帖'
      : context.preview === 'full' ? `${author ? `在${where}发帖` : `${posts.length} 条新帖`}：${line.slice(0, 300)}`
      : author ? `在${where}发了一帖` : `${posts.length} 条新帖`,
    tag: first.id, route: `/community/${encodeURIComponent(context.community.id)}`,
  };
}

async function postOne(env: Env, due: Due, credentials: ProactiveCredentials, now: number, generate: CommunityGenerator) {
  const { row } = due;
  const context = JSON.parse(row.data) as CommunityContext;
  const id = row.community_id;
  const lease = crypto.randomUUID();
  // Each community/date/slot has its own atomic claim. Other communities start immediately.
  const claim = await env.DB.prepare(`INSERT INTO community_posts(community_id, date, slot, due_at, lease, lease_until, attempts)
    VALUES (?, ?, ?, ?, ?, ?, 1) ON CONFLICT(community_id, date, slot) DO UPDATE SET
      due_at = excluded.due_at, lease = excluded.lease, lease_until = excluded.lease_until, attempts = community_posts.attempts + 1
    WHERE community_posts.data IS NULL AND community_posts.lease_until <= ? AND community_posts.retry_at <= ? RETURNING attempts`)
    .bind(id, due.date, due.slot, due.dueAt, lease, now + LEASE_MS, now, now).first<{ attempts: number }>();
  if (!claim) return;
  let used = 0;
  try {
    const [day, later] = await Promise.all([
      due.member ? todayOf(env, due.member, now) : null,
      // 手机上传之后云端又发过的：手机没来得及拉的那几批也算"发过的"
      env.DB.prepare('SELECT data FROM community_posts WHERE community_id = ? AND done_at > ? AND data IS NOT NULL ORDER BY done_at DESC LIMIT 4')
        .bind(id, row.updated_at).all<{ data: string }>(),
    ]);
    const names = (who: string) => (who === MOMENT_USER ? context.userName : isNetizen(who) ? netizenName(who) : (context.members.find((m) => m.id === who)?.name ?? who));
    const mine = later.results.reverse().flatMap((r) => JSON.parse(r.data) as CommunityPost[])
      .map((p) => communityPostText(p, names, { timeZone: context.timezone, comments: 2, textMax: 200 }));
    const current: CommunityContext = { ...context, feed: [context.feed, ...mine].filter(Boolean).join('\n') };
    const member = due.member ? { context: due.member, day } : undefined;
    const route = credentials.routes.find((r) => r.role === 'social');
    const request = communityRequest(current, now, member);
    const estimate = estimateTokens(JSON.stringify(request.messages)) + (request.maxTokens ?? route?.params?.maxTokens ?? 0);
    if (!await reserve(env, lease, `social:${due.date}`, estimate, route?.dailyTokenBudget ?? 0, now)) throw new AiError('budget', '社媒每日 token 预算已用完');
    const result = await generate(current, credentials, due, now, member);
    used = result.tokens;
    // A settings change/removal during the call invalidates the output, without blocking any other community.
    const saved = await env.DB.prepare(`UPDATE community_posts SET data = ?, lease = NULL, lease_until = 0, retry_at = 0, last_error = NULL, done_at = ?
      WHERE community_id = ? AND date = ? AND slot = ? AND lease = ?
      AND EXISTS (SELECT 1 FROM community_contexts WHERE community_id = ? AND revision = ?)`)
      .bind(JSON.stringify(result.posts), Date.now(), id, due.date, due.slot, lease, id, row.revision).run();
    if (!saved.meta.changes) throw new Error('生成期间社群设置更新');
    if (context.settings.notify) {
      // 通知发一次就好：发不出去不重发（打开 App 就能看到），也不算这一批失败
      const channels = await env.DB.prepare('SELECT * FROM push_channels').all<Channel>();
      await Promise.allSettled(channels.results.map((ch) => sendChannel(env, ch, notificationFor(context, result.posts))));
    }
  } catch (e) {
    // Provider messages may contain keys or response bodies; sync only a safe failure summary.
    const reason = e instanceof AiError ? `${e.code}${e.status ? ` / HTTP ${e.status}` : ''}` : e instanceof Error ? e.name : 'Error';
    await env.DB.prepare(`UPDATE community_posts SET lease = NULL, lease_until = 0, retry_at = ?, last_error = ? WHERE community_id = ? AND date = ? AND slot = ? AND lease = ?`)
      .bind(now + Math.min(30, 5 * 2 ** Math.min(claim.attempts - 1, 3)) * 60_000, `社群帖子生成失败（${reason}），云端将自动重试`, id, due.date, due.slot, lease).run();
  } finally {
    await release(env, lease, used);
  }
}

/** 这个社群现在到点、还在补发窗口里的那几格（昨天深夜的和今天的）。角色只算上传了朋友圈上下文的 */
function dueJobs(row: ContextRow, members: Map<string, SocialContext>, now: number): Due[] {
  const context = JSON.parse(row.data) as CommunityContext;
  const today = zonedDateKey(now, context.timezone);
  const present = context.members.flatMap((m) => { const c = members.get(m.id); return c ? [{ id: m.id, awake: c.awake }] : []; });
  return [shiftDate(today, -1), today].flatMap((date) =>
    communityJobs({ communityId: context.community.id, date, timezone: context.timezone, settings: context.settings, awake: context.awake, members: present })
      .filter((j) => j.dueAt <= now && now - j.dueAt < COMMUNITY_CATCH_UP_MS)
      .map((j): Due => ({ ...j, row, ...(j.characterId ? { member: members.get(j.characterId) } : {}) })));
}

/** 每 5 分钟的 Cron 里跑；和主动消息的总开关无关，手机没开也发 */
export async function runCommunityScheduled(env: Env, now = Date.now(), generate: CommunityGenerator = generateCommunityPosts) {
  try {
    const rows = await env.DB.prepare('SELECT community_id, revision, data, updated_at FROM community_contexts').all<ContextRow>();
    if (!rows.results.length) { await setMeta(env, 'lastCommunityError', null); return; }
    const social = await env.DB.prepare('SELECT character_id, data FROM social_contexts').all<{ character_id: string; data: string }>();
    const members = new Map(social.results.map((r) => [r.character_id, JSON.parse(r.data) as SocialContext]));
    const due = rows.results.flatMap((row) => dueJobs(row, members, now));
    if (due.length) {
      const sealed = await env.DB.prepare("SELECT ciphertext, iv FROM secrets WHERE id = 'social'").first<{ ciphertext: string; iv: string }>();
      if (!sealed) throw new Error('未设置云端社媒 API，请打开 App 同步');
      const credentials = await unseal<ProactiveCredentials>(env.KEK, sealed);
      await releaseExpired(env, now);
      const results = await Promise.allSettled(due.map((d) => postOne(env, d, credentials, now, generate)));
      if (results.some((r) => r.status === 'rejected')) throw new Error('部分社群任务失败，下一轮继续检测');
    }
    await Promise.all([
      env.DB.prepare('DELETE FROM community_posts WHERE date < ?').bind(shiftDate(new Date(now).toISOString().slice(0, 10), -14)).run(),
      setMeta(env, 'lastCommunityError', null),
    ]);
  } catch (e) {
    await setMeta(env, 'lastCommunityError', e instanceof Error ? e.message : '云端社群检测失败');
    throw e;
  }
}
