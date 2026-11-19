import { isAbortError, linkSignals, rankRecall, type EchoEntry, type RecallHit, type RecallReason } from '@app/ai';
import { detectStates, estimateTokens, parseTimeQuery, type Character, type Chat } from '@app/shared';
import { reactive } from 'vue';
import { useAiStore } from '@/stores/ai';
import { useEnvironmentStore } from '@/stores/environment';
import { useMemoryStore } from '@/stores/memory';
import { useMessageSettingsStore } from '@/stores/messageSettings';

/**
 * 发送前按本轮用户输入检索；同一查询的向量可以复用，结果每次从当前记忆库重新排名。
 * 查看提示词保持同步：向量尚未就绪时按字面检索，不沿用其他话题的结果。
 */

export interface RecallLine {
  key: string;
  kind: 'memory' | 'slice';
  id: string;
  text: string;
  at: number;
  reason: RecallReason;
  score: number;
  dense: number | null;
  lexical: number | null;
}

export interface RecallSnapshot {
  /** 这次查询对应的用户消息 */
  afterMessageId: string | null;
  at: number;
  query: string;
  lines: RecallLine[];
  echo: EchoEntry[];
  /** 这次用上了向量（按意思搜） */
  dense: boolean;
  /** 没用上向量的原因；用上了为空 */
  denseNote: string;
  time: string | null;
  specials: string[];
  states: string[];
}

/** 每条聊天最近 3 份结果（最新的在最后） */
const snapshots = reactive<Record<string, RecallSnapshot[]>>({});
/** 每条回复生成时用的那份（重新生成时沿用） */
const used = new Map<string, RecallLine[]>();
const running = new Map<string, AbortController>();

const vectors = new Map<string, { query: string; vector: Float32Array; space: { model: string; dims: number } }>();
const PHATIC = /^[\s\p{P}\p{S}]*(嗯+|嗯嗯|哦+|噢+|好+|好的|好呀|好哒|行|ok|okay|收到|晚安|早安|早|哈+|嘿+|呜+|啊+|在吗|在|谢谢|么么哒?|抱抱|亲亲|贴贴)?[\s\p{P}\p{S}]*$/iu;

/** 只有寒暄、表情、标点 */
export function isPhatic(text: string): boolean {
  return PHATIC.test(text.trim());
}

function linesOf(hits: RecallHit[], characterId: string): RecallLine[] {
  const mem = useMemoryStore();
  const byKey = new Map(mem.candidates(characterId, null).map((c) => [c.key, c]));
  return hits
    .map((h) => ({ ...h, text: byKey.get(h.key)?.text ?? '' }))
    .filter((l) => l.text)
    .map(({ key, kind, id, text, at, reason, score, dense, lexical }) => ({ key, kind, id, text, at, reason, score, dense, lexical }));
}

/** 只有日期和回顾用语时，允许按时间找；“昨天吃饭”仍须匹配吃饭。 */
export function timeOnlyQuery(text: string, phrase: string | null): boolean {
  if (!phrase) return false;
  return !text.replace(phrase, '').replace(/发生|做|干|什么|事情|事|回顾|回忆|记得|还记得|我们|咱们|你|我|过|了|的|在|时候|都|有|吗|呢|[\s\p{P}\p{S}]/gu, '');
}

function cues(text: string, now: number) {
  const timeZone = useEnvironmentStore().settings.timezone;
  const time = parseTimeQuery(text, now, timeZone);
  return {
    time,
    timeOnly: timeOnlyQuery(text, time.phrase),
    states: detectStates(text),
  };
}

function rankForQuery(chat: Chat, character: Character, text: string, now: number) {
  const mem = useMemoryStore();
  const policy = useMessageSettingsStore().memoryOptions();
  const cached = vectors.get(chat.id);
  const vector = cached?.query === text ? cached : undefined;
  const c = cues(text, now);
  const prev = latestRecall(chat.id);
  const out = rankRecall({
    candidates: mem.candidates(character.id, vector?.space ?? null),
    query: text,
    queryVector: vector?.vector ?? null,
    lexical: mem.lexical,
    now,
    time: c.time,
    timeOnly: c.timeOnly,
    states: c.states,
    echo: prev?.query === text ? prev.echo : undefined,
    quotas: { basic: policy.maxItems, important: 0, special: 0, state: policy.maxItems, time: policy.maxItems },
    ...policy,
    countTokens: estimateTokens,
  });
  return { ...out, cues: c, dense: !!vector, lines: linesOf(out.hits, character.id) };
}

/** 这条聊天最新的一份结果 */
export function latestRecall(chatId: string): RecallSnapshot | undefined {
  return snapshots[chatId]?.at(-1);
}

/** 发送前或打开聊天时调用；只搜索用户输入，不把模型自己的回复当成下一轮主题。 */
export async function prefetchRecall(chat: Chat, character: Character, query: string, afterMessageId: string | null, signal?: AbortSignal): Promise<RecallSnapshot | undefined> {
  const mem = useMemoryStore();
  const text = query.trim();
  running.get(chat.id)?.abort();
  if (!mem.ready || !useMessageSettingsStore().memoryOptions().tokenBudget || !text || isPhatic(text)) return undefined;
  const abort = new AbortController();
  running.set(chat.id, abort);
  const ai = useAiStore();
  let denseNote = '';
  const cached = vectors.get(chat.id);
  if (cached?.query !== text) vectors.delete(chat.id);
  if (ai.isLive('embedding') && cached?.query !== text) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 15_000);
    const linked = linkSignals(abort.signal, timeout.signal, signal);
    try {
      const r = await ai.system.embed([text], { purpose: 'query', signal: linked.signal });
      const vector = r.vectors[0];
      if (vector && !linked.signal.aborted) vectors.set(chat.id, { query: text, vector, space: { model: r.model, dims: vector.length } });
    } catch (e) {
      denseNote = isAbortError(e) ? '向量化超时，只按字面搜' : '向量化失败，只按字面搜（完整报错在“API 设置 → 向量化”）';
    } finally {
      clearTimeout(timer);
      linked.dispose();
    }
  } else if (!ai.isLive('embedding')) {
    vectors.delete(chat.id);
    const st = ai.status('embedding');
    denseNote = `向量化没接通${'reason' in st ? `：${st.reason}` : ''}`;
  }
  if (abort.signal.aborted || signal?.aborted) return undefined;
  running.delete(chat.id);
  const now = Date.now();
  const out = rankForQuery(chat, character, text, now);
  const snap: RecallSnapshot = {
    afterMessageId,
    at: now,
    query: text,
    lines: out.lines,
    echo: out.echo,
    dense: out.dense,
    denseNote,
    time: out.cues.time.phrase,
    specials: [],
    states: out.cues.states,
  };
  snapshots[chat.id] = [...(snapshots[chat.id] ?? []), snap].slice(-3);
  return snap;
}

export interface RecallForTurn {
  lines: RecallLine[];
  snapshot: RecallSnapshot | undefined;
  /** 发送时用本轮消息在本机补的条数 */
  added: number;
  /** 沿用了重新生成前那一轮的结果 */
  reused: boolean;
}

/** 拼提示词时按当前查询重新排名；重生成保留原选择，但读取当前仍有效的内容。 */
export function recallForTurn(chat: Chat, character: Character, userText: string, targetId?: string): RecallForTurn {
  const text = userText.trim();
  const latest = latestRecall(chat.id);
  const snapshot = latest?.query === text ? latest : undefined;
  const mem = useMemoryStore();
  if (targetId && used.has(targetId)) {
    const candidates = new Map(mem.candidates(character.id, null).map((c) => [c.key, c]));
    const lines = (used.get(targetId) ?? []).flatMap((l) => {
      const c = candidates.get(l.key);
      return c ? [{ ...l, text: c.text, at: c.at }] : [];
    });
    return { lines, snapshot, added: 0, reused: true };
  }
  if (!mem.ready || !text || isPhatic(text) || !useMessageSettingsStore().memoryOptions().tokenBudget) return { lines: [], snapshot, added: 0, reused: false };
  const out = rankForQuery(chat, character, text, Date.now());
  const have = new Set(snapshot?.lines.map((l) => l.key));
  return { lines: out.lines, snapshot, added: out.lines.filter((l) => !have.has(l.key)).length, reused: false };
}

/** 这条回复生成时用了哪些记忆（重新生成时沿用）；被带进提示词的记一次"想起过" */
export function noteRecallUsed(messageId: string, lines: RecallLine[], countRecall: boolean) {
  used.set(messageId, lines);
  while (used.size > 40) used.delete(used.keys().next().value as string);
  if (countRecall) useMemoryStore().noteRecalled(lines.map((l) => l.key));
}

/** 清掉一条聊天的结果（聊天删除时） */
export function clearRecall(chatId: string) {
  delete snapshots[chatId];
  running.get(chatId)?.abort();
  running.delete(chatId);
  vectors.delete(chatId);
}
