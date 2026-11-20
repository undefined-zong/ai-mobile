import { samplerRequest } from '@app/ai';
import { assembleTaskPrompt, textFn, type Character, type TextFn } from '@app/shared';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';
import type { Novel, NovelChapter } from '@/stores/workshop';
import { MissingPresetError } from './prompt';

/**
 * 创意工坊 · 写小说（设计文档 §9.11）：用"小说"预设（用途 novel），调"创作 · 小说"的 API。
 * 预设里每件事一块（商量 novel-chat、写下一章 novel-chapter、写番外 novel-extra、重写 novel-rewrite），按这次做的事只发那一块；
 * 这里只填这一次的输入：作品、写好的章节、最近的讨论、这一次要做的。
 */
export type NovelTask = 'novel-chat' | 'novel-chapter' | 'novel-extra' | 'novel-rewrite';

/** 前文最多带多少字（从最新的一章往前，带得下就带全文，带不下的只带标题和开头） */
const CONTEXT_CHARS = 24_000;
/** 讨论最多带最近几条 */
const TALK_KEEP = 16;
export const NOTE_MARK = '【记进设定】';

export interface NovelCallOptions {
  /** 她的名字（预设里的 {{char}}）和你的名字（{{user}}） */
  character?: Pick<Character, 'name' | 'pronoun' | 'presetId' | 'lorebookIds'> | null;
  userName: string;
  signal?: AbortSignal;
  onText?(text: string): void;
}

export function novelStatus(): { live: boolean; reason: string } {
  const s = useAiStore().status('novel');
  return s.live ? { live: true, reason: '' } : { live: false, reason: `「创作 · 小说」还没接通：${s.reason}` };
}

/** 第几章（只算正文，不算番外） */
export function chapterNo(novel: Novel, chapter?: NovelChapter): number {
  const main = novel.chapters.filter((c) => c.kind === 'chapter');
  if (!chapter) return main.length + 1;
  return main.findIndex((c) => c.id === chapter.id) + 1;
}

export function chapterLabel(novel: Novel, chapter: NovelChapter): string {
  if (chapter.kind === 'extra') return `番外 · ${chapter.title || '无题'}`;
  return `第 ${chapterNo(novel, chapter)} 章 · ${chapter.title || '无题'}`;
}

/** 写给模型看的章节名（程序文字 novel.chapterLabel.*） */
function chapterLabelText(novel: Novel, chapter: NovelChapter, t: TextFn): string {
  return chapter.kind === 'extra'
    ? t('novel.chapterLabel.extra', { title: chapter.title || t('novel.untitled') })
    : t('novel.chapterLabel.chapter', { n: chapterNo(novel, chapter), title: chapter.title || t('novel.untitled') });
}

function infoText(n: Novel, t: TextFn): string {
  return t('novel.info', { title: n.title, genre: n.genre.trim(), setting: n.setting.trim(), outline: n.outline.trim(), style: n.style.trim() });
}

/** 已经写好的章节：从最新的往前带全文，带不下的只带标题和开头；番外只在重写它时带全文 */
function chaptersText(n: Novel, t: TextFn, skip?: string): string {
  const list = n.chapters.filter((c) => c.id !== skip);
  if (!list.length) return t('novel.chapters.none');
  let budget = CONTEXT_CHARS;
  const parts: string[] = [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const c = list[i]!;
    const head = chapterLabelText(n, c, t);
    if (c.kind === 'chapter' && c.text.length <= budget) {
      parts.unshift(t('novel.chapters.full', { head, text: c.text.trim() }));
      budget -= c.text.length;
    } else {
      parts.unshift(t('novel.chapters.head', { head, text: c.text.trim().replace(/\s+/g, ' ').slice(0, 120) }));
    }
  }
  return t('novel.chapters', { parts });
}

function talkText(n: Novel, userName: string, t: TextFn): string {
  const recent = n.talk.slice(-TALK_KEEP);
  if (!recent.length) return '';
  return t('novel.talk', {
    lines: recent.map((x) => t('novel.talk.line', { who: x.role === 'user' ? userName : t('novel.talk.you'), text: x.text.length > 800 ? `${x.text.slice(0, 800)}…` : x.text })),
  });
}

/** 写作助手的回复里拿出【记进设定】的几行 */
export function splitNotes(text: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const rest = text
    .split('\n')
    .filter((line) => {
      const i = line.indexOf(NOTE_MARK);
      if (i < 0) return true;
      const note = line.slice(i + NOTE_MARK.length).replace(/^[：:\s]+/, '').trim();
      if (note) notes.push(note);
      return false;
    })
    .join('\n')
    .trim();
  return { text: rest, notes };
}

/** 章节输出：第一行"# 标题"，空一行，正文（流式时也能边写边分） */
export function parseChapter(raw: string): { title: string; text: string } {
  const s = raw.replace(/\r/g, '').replace(/^\s+/, '');
  const m = /^#+\s*(.*)\n?/.exec(s);
  if (!m) return { title: '', text: s.trim() };
  const title = (m[1] ?? '')
    .replace(/^(第\s*[0-9一二三四五六七八九十百千]+\s*章|番外)\s*[：:·\-—\s]*/, '')
    .replace(/^[《「]|[》」]$/g, '')
    .trim();
  return { title, text: s.slice(m[0].length).trim() };
}

/** ask：这一次要它做的事（按这一次预设的程序文字写） */
async function run(novel: Novel, task: NovelTask, ask: (t: TextFn) => string, opts: NovelCallOptions, skip?: string): Promise<string> {
  const status = novelStatus();
  if (!status.live) throw new Error(status.reason);
  const lib = useLibraryStore();
  const preset = lib.withLorebooks(lib.presetForUse('novel', opts.character), opts.character);
  if (!preset) throw new MissingPresetError('小说');
  const t = textFn(preset.texts);
  const { messages } = assembleTaskPrompt({
    preset,
    fills: {
      novelInfo: infoText(novel, t),
      novelChapters: chaptersText(novel, t, skip),
      novelChat: talkText(novel, opts.userName, t),
      novelAsk: ask(t),
    },
    macros: { pronoun: opts.character?.pronoun, char: opts.character?.name ?? '', user: opts.userName },
    type: task,
  });
  const stream = preset.sampler.stream !== false && !!opts.onText;
  const r = await useAiStore().system.chat(
    'novel',
    { messages, ...samplerRequest(preset.sampler) },
    { signal: opts.signal, ...(stream ? { onDelta: (t: string) => opts.onText?.(t) } : {}) },
  );
  return r.text;
}

/** 和写作助手商量：你说一句，它回一段（最后可能带几条【记进设定】） */
export async function novelChat(novel: Novel, said: string, opts: NovelCallOptions): Promise<{ text: string; notes: string[] }> {
  const raw = await run(novel, 'novel-chat', (t) => t('novel.ask.chat', { user: opts.userName, said }), { ...opts, onText: opts.onText ? (t) => opts.onText?.(splitNotes(t).text) : undefined });
  return splitNotes(raw);
}

/** 写下一章 / 写番外 */
export async function novelWrite(novel: Novel, kind: 'chapter' | 'extra', wish: string, opts: NovelCallOptions): Promise<{ title: string; text: string }> {
  const w = wish.trim();
  const ask = (t: TextFn) => t(kind === 'chapter' ? 'novel.ask.chapter' : 'novel.ask.extra', { n: chapterNo(novel), user: opts.userName, wish: w });
  const raw = await run(novel, kind === 'chapter' ? 'novel-chapter' : 'novel-extra', ask, opts);
  return parseChapter(raw);
}

/** 照你的意见重写一章 */
export async function novelRewrite(novel: Novel, chapter: NovelChapter, wish: string, opts: NovelCallOptions): Promise<{ title: string; text: string }> {
  const ask = (t: TextFn) => t('novel.ask.rewrite', { label: chapterLabelText(novel, chapter, t), user: opts.userName, wish: wish.trim(), title: chapter.title, text: chapter.text });
  const raw = await run(novel, 'novel-rewrite', ask, opts, chapter.id);
  return parseChapter(raw);
}
