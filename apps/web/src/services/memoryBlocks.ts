import { dayLabel, LexicalIndex, lineTime, rankRecall } from '@app/ai';
import { estimateTokens, parseTimeQuery, pronounText, type AppBlockFill, type Character, type Chat, type Memory } from '@app/shared';
import { useMemoryStore } from '@/stores/memory';
import { useMessageSettingsStore } from '@/stores/messageSettings';
import { isPhatic, timeOnlyQuery, type RecallLine } from './recall';
import { communityMemoryLines } from './community';
import { recentMomentsLines } from './social';
import { parallelNotesLines } from './parallel';

/** 摘要、记忆和动态先按当前话题选择，再按完整渲染文本共用一个 token 预算。 */
const DAY = 86_400_000;

/** 演示角色还没总结过时的梗概 */
const DEMO_SUMMARIES: Record<string, string> = {
  suwan: '上周两人一起看了电影；你最近在赶论文、经常熬夜，{{pronoun}}很担心；约好周六去水族馆。',
  jiangyu: '他最近每天早上跟江屿在操场晨跑；昨天下雨跑了 3.1 公里，比第一天快了一分钟；约好每天六点见，迟到一分钟加一圈。',
};

/** 每次都带的：置顶的，和到期要问的待跟进（已经到期的、12 小时内到期的；过期超过一周的交给整理改时态） */
export function alwaysOn(characterId: string, now: number): Memory[] {
  return useMemoryStore()
    .activeOf(characterId)
    .filter((m) => m.pinned || (m.type === 'followup' && m.dueAt !== null && m.dueAt <= now + DAY / 2 && m.dueAt >= now - 7 * DAY))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || (a.dueAt ?? 0) - (b.dueAt ?? 0) || b.importance - a.importance);
}

export function relationshipLine(character: Character): string {
  const rel = character.relationship;
  const parts = [
    rel.affection !== 50 ? `好感 ${rel.affection}` : '',
    rel.mood ? `心情"${rel.mood}"` : '',
    rel.userNickname ? `${character.pronoun}叫你"${rel.userNickname}"` : '',
    rel.charNickname ? `你叫${character.pronoun}"${rel.charNickname}"` : '',
  ].filter(Boolean);
  return parts.length ? `关系：${parts.join('，')}` : '';
}

function memoryLine(m: Memory, timeZone: string): string {
  const due = m.type === 'followup' && m.dueAt ? `（${lineTime(m.dueAt, timeZone)} 到期，到时候问问）` : '';
  return `- ${m.content}${due}`;
}

type Section = 'relationship' | 'fixed' | 'recall' | 'profile' | 'timeline' | 'moments' | 'community' | 'parallel';
interface Entry {
  key: string;
  section: Section;
  text: string;
  search: string;
  at: number;
  toAt?: number;
  timeless?: boolean;
  importance: number;
  priority: number;
  score: number;
  recall?: RecallLine;
}

export interface MemoryBlocks {
  summary: AppBlockFill;
  memory: AppBlockFill;
  /** 通过总预算后真正保留下来的检索结果。 */
  recall: RecallLine[];
}

export function memoryBlocks(chat: Chat | undefined, character: Character, now: number, timeZone: string, opts: {
  query?: string;
  recall?: RecallLine[];
  proactive?: boolean;
  /** 发朋友圈和留言时动态另给，不在记忆里重复。 */
  moments?: boolean;
} = {}): MemoryBlocks {
  const policy = useMessageSettingsStore().memoryOptions();
  const mem = useMemoryStore();
  const profile = mem.profileOf(character.id)?.lines ?? [];
  const timeline = chat ? mem.timelineOf(chat.id) : [];
  const query = opts.query?.trim() ?? '';
  const pool: Entry[] = [];
  const ranked: Entry[] = [];
  const entry = (section: Section, key: string, text: string, search: string, at: number, importance = 5): Entry =>
    ({ section, key, text, search, at, importance, priority: 1, score: 0 });

  const rel = relationshipLine(character);
  if (rel) ranked.push({ ...entry('relationship', 'relationship', rel, rel, now), priority: -2 });
  const fixed = alwaysOn(character.id, now).filter((m) => m.pinned || opts.proactive);
  const fixedIds = new Set(fixed.map((m) => m.id));
  for (const m of fixed) ranked.push({ ...entry('fixed', `m:${m.id}`, memoryLine(m, timeZone), m.content, m.happenedAt ?? m.createdAt, m.importance), priority: -1 });
  for (const l of opts.recall ?? []) {
    if (l.kind === 'memory' && fixedIds.has(l.id)) continue;
    ranked.push({ ...entry('recall', l.key, `- ${dayLabel(l.at, timeZone)}：${l.text}`, l.text, l.at), priority: l.reason === 'time' ? 0 : 1, score: l.score, recall: l });
  }
  for (const l of profile) pool.push({ ...entry('profile', `p:${l.id}`, `【${l.section}】${l.text}`, l.text, l.updatedAt), timeless: true });
  for (const s of timeline) {
    const a = dayLabel(s.fromAt, timeZone);
    const b = dayLabel(s.toAt, timeZone);
    pool.push({ ...entry('timeline', `t:${s.id}`, `- ${a === b ? a : `${a} ~ ${b}`}：${s.text}`, s.text, s.fromAt), toAt: s.toAt });
  }
  if (!profile.length && !timeline.length && DEMO_SUMMARIES[character.id]) {
    const text = pronounText(DEMO_SUMMARIES[character.id]!, character);
    pool.push(entry('timeline', 'demo', text, text, now));
  }
  if (opts.proactive) {
    for (const m of mem.activeOf(character.id)) {
      if (!fixedIds.has(m.id)) pool.push(entry('recall', `m:${m.id}`, memoryLine(m, timeZone), m.content, m.happenedAt ?? m.createdAt, m.importance));
    }
  }
  if (opts.moments !== false) {
    const add = (section: 'moments' | 'community' | 'parallel', lines: { text: string; at: number | null }[]) => {
      lines.forEach((line, i) => pool.push({ ...entry(section, `${section}:${i}`, line.text, line.text, line.at ?? now), timeless: line.at === null }));
    };
    add('moments', recentMomentsLines(character));
    add('community', communityMemoryLines(character));
    add('parallel', parallelNotesLines(character));
  }

  if (opts.proactive) {
    // 主动消息没有用户查询，按重要度和新近度取少量内容，仍受同一条目数和总预算约束。
    ranked.push(...pool.map((e) => ({ ...e, score: e.importance })));
  } else if (query && !isPhatic(query)) {
    const index = new LexicalIndex();
    for (const e of pool) index.add(e.key, e.search);
    const time = parseTimeQuery(query, now, timeZone);
    const out = rankRecall({
      candidates: pool.map((e) => ({ key: e.key, id: e.key, kind: 'slice' as const, text: e.search, importance: e.importance, vector: null, timeless: e.timeless,
        // 合并后的时间线是一段日期范围，范围内任一天都可以命中。
        at: time.range && e.section === 'timeline' && (e.toAt ?? e.at) >= time.range.from && e.at < time.range.to ? Math.max(e.at, time.range.from) : e.at })),
      lexical: index, query, queryVector: null, now, time, timeOnly: timeOnlyQuery(query, time.phrase),
      quotas: { basic: pool.length, important: 0, special: 0, state: 0, time: policy.maxItems },
      maxItems: pool.length,
    });
    const byKey = new Map(pool.map((e) => [e.key, e]));
    for (const h of out.hits) ranked.push({ ...byKey.get(h.key)!, priority: h.reason === 'time' ? 0 : 1, score: h.score });
  }
  ranked.sort((a, b) => a.priority - b.priority || b.score - a.score || b.at - a.at);

  const headings: Record<Section, string> = {
    relationship: '', fixed: `${character.name}一直记着的：`, recall: `${character.name}想起来的事：`,
    profile: `${character.name}知道的你：`, timeline: opts.proactive ? '近期时间线：' : '与本轮有关的时间线：',
    moments: '相关的朋友圈：', community: '相关的社群动态：', parallel: '相关的平行时空留言：',
  };
  const summarySections: Section[] = ['profile', 'timeline'];
  const memorySections: Section[] = ['relationship', 'fixed', 'recall', 'moments', 'community', 'parallel'];
  const render = (entries: Entry[], sections: Section[]) => sections.map((section) => {
    const rows = entries.filter((e) => e.section === section).sort((a, b) => a.at - b.at);
    return rows.length ? [headings[section], ...rows.map((e) => e.text)].filter(Boolean).join('\n') : '';
  }).filter(Boolean).join('\n\n');
  const tokens = (entries: Entry[]) => estimateTokens(render(entries, summarySections)) + estimateTokens(render(entries, memorySections));
  const selected: Entry[] = [];
  const seen = new Set<string>();
  let items = 0;
  for (const e of ranked) {
    const key = e.search.replace(/\s+/g, '').normalize('NFKC');
    if (seen.has(key) || (e.priority >= 0 && items >= policy.maxItems)) continue;
    // 包含标题、日期、分隔符和固定记忆；第一条超长也不能突破预算。
    if (tokens([...selected, e]) > policy.tokenBudget) continue;
    selected.push(e);
    seen.add(key);
    if (e.priority >= 0) items += 1;
  }
  const count = (section: Section) => selected.filter((e) => e.section === section).length;
  const usage = `两块合计估算 ${tokens(selected)} / ${policy.tokenBudget} tokens`;
  return {
    summary: { content: render(selected, summarySections), source: `画像卡 ${count('profile')} / ${profile.length} 行 + 时间线 ${count('timeline')} / ${timeline.length} 段 · ${usage}` },
    memory: { content: render(selected, memorySections), source: `置顶和到期 ${count('fixed')} 条 + 相关记忆 ${count('recall')} 条 + 动态 ${count('moments') + count('community') + count('parallel')} 条 · ${usage}` },
    recall: selected.flatMap((e) => e.recall ? [e.recall] : []),
  };
}
