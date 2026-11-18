import { McpClient, McpCredentials } from '@app/ai';
import {
  readWereadCatalog,
  readWereadChapter,
  readWereadNotes,
  readWereadReviews,
  readWereadSearchFirst,
  readWereadShelf,
  WEREAD_HEADERS,
  WEREAD_TOOLS,
  type WereadBookNotes,
  type WereadReview,
  type WereadShelfBook,
} from '@app/shared';
import { useBookStore } from '@/stores/books';
import { useHubStore } from '@/stores/hub';
import { normalizeBase, SECRET_IDS, useServicesStore } from '@/stores/services';
import { uid } from '@/utils/id';
import { bookParasFromHtml, paraProgress, splitBookParas, type BookBody, type BookChapter, type BookMeta, type BookNote } from './books';

/**
 * 一起看书接微信读书（用 @app/ai 的 MCP 客户端连）：
 * - 连哪儿：云端 Hub 内置的微信读书 MCP（Cookie / CookieCloud 随请求头发给你自己的 Hub），或者你自己部署的同名工具的 MCP 地址；
 * - 点一本按完整目录逐章取正文，连同划线、想法和书评放上本机书架；章节分别请求，长书不会挤在一次 Hub 请求里。
 * - 旧版笔记书可原位更新为正文，保留这里的批注和阅读位置。
 */

type Connection = { ok: true; url: string; headers: Record<string, string> } | { ok: false; reason: string; to: string };

/** 现在怎么连微信读书；连不上时说为什么、去哪儿设置 */
export function wereadConnection(): Connection {
  const svc = useServicesStore();
  const w = svc.weread;
  if (w.source === 'url') {
    const url = normalizeBase(w.url);
    if (!url) return { ok: false, reason: '还没填微信读书 MCP 的地址', to: '/me/read' };
    const value = svc.secrets[SECRET_IDS.wereadHeader];
    return { ok: true, url, headers: value ? { [w.headerName.trim() || 'Authorization']: value } : {} };
  }
  const hub = useHubStore();
  const ep = hub.endpoint('/v1/weread/mcp');
  if (!ep) return { ok: false, reason: '内置的微信读书 MCP 在云端 Hub 上：先连云端', to: '/me/sync' };
  if (hub.status && !hub.supportsWeread) return { ok: false, reason: '云端 Hub 的版本太旧，没有微信读书 MCP：重新部署一次 Hub', to: '/me/sync' };
  const cookie = svc.secrets[SECRET_IDS.wereadCookie];
  const ccPassword = svc.secrets[SECRET_IDS.cookieCloudPassword];
  const cc = w.cookieCloudUrl.trim() && w.cookieCloudId.trim() && ccPassword;
  if (!cookie && !cc) return { ok: false, reason: '还没填微信读书的 Cookie（或 CookieCloud）', to: '/me/read' };
  return {
    ok: true,
    url: ep.url,
    headers: {
      ...ep.headers,
      ...(cookie ? { [WEREAD_HEADERS.cookie]: cookie } : {}),
      ...(cc ? { [WEREAD_HEADERS.cookieCloudUrl]: normalizeBase(w.cookieCloudUrl), [WEREAD_HEADERS.cookieCloudId]: w.cookieCloudId.trim(), [WEREAD_HEADERS.cookieCloudPassword]: ccPassword } : {}),
    },
  };
}

/** 连上 MCP 做几件事，做完关掉 */
async function withWeread<T>(run: (call: (tool: string, args?: Record<string, unknown>) => Promise<string>, client: McpClient) => Promise<T>): Promise<T> {
  const c = wereadConnection();
  if (!c.ok) throw new Error(c.reason);
  // 每章正文和笔记都要访问多个接口：单次工具调用多等一会儿
  const client = new McpClient({ url: c.url, credentials: new McpCredentials({ url: c.url, headers: c.headers }), timeoutMs: 120_000 });
  try {
    return await run(async (tool, args = {}) => {
      const r = await client.callTool(tool, args);
      if (r.isError) throw new Error(r.text.trim() || `${tool} 出错了`);
      return r.text;
    }, client);
  } finally {
    void client.close();
  }
}

/** 测试连接：工具齐不齐，书架上有几本 */
export async function testWeread(): Promise<string> {
  return withWeread(async (call, client) => {
    const names = new Set((await client.listTools()).map((t) => t.name));
    const missing = Object.values(WEREAD_TOOLS).filter((n) => !names.has(n));
    if (missing.includes(WEREAD_TOOLS.shelf) || missing.includes(WEREAD_TOOLS.notes)) throw new Error(`这台 MCP 服务器没有 ${missing.join('、')}，不是微信读书 MCP`);
    const books = readWereadShelf(await call(WEREAD_TOOLS.shelf));
    shelfCache = { at: Date.now(), books };
    const noted = books.filter((b) => b.noteCount + b.bookmarkCount > 0).length;
    return `接通了：微信读书书架上 ${books.length} 本书，${noted} 本有划线或想法${missing.includes(WEREAD_TOOLS.catalog) || missing.includes(WEREAD_TOOLS.chapter) ? '；这台服务器只有笔记接口，更新 Hub 后可读取全书正文' : '；支持读取全书正文'}`;
  });
}

let shelfCache: { at: number; books: WereadShelfBook[] } | null = null;

/** 微信读书的书架（这次打开 App 期间记住，force 时重新取） */
export async function wereadShelf(force = false): Promise<WereadShelfBook[]> {
  if (shelfCache && !force) return shelfCache.books;
  const books = await withWeread(async (call) => readWereadShelf(await call(WEREAD_TOOLS.shelf)));
  shelfCache = { at: Date.now(), books };
  return books;
}
export function cachedWereadShelf(): WereadShelfBook[] | null {
  return shelfCache?.books ?? null;
}

export type WereadImportProgress = (loaded: number, total: number, title: string) => void;

/** 按目录取全书正文，再带上划线、想法和书评。任何一章失败都不替换本机已有的书。 */
async function fetchBook(bookId: string, title: string, onProgress?: WereadImportProgress): Promise<{ notes: WereadBookNotes; reviews: WereadReview[]; chapters: BookChapter[] }> {
  const count = useServicesStore().weread.reviews;
  return withWeread(async (call) => {
    const catalog = readWereadCatalog(await call(WEREAD_TOOLS.catalog, { book_id: bookId }));
    const chapters: BookChapter[] = [];
    for (const [index, c] of catalog.chapters.entries()) {
      onProgress?.(index, catalog.chapters.length, c.title);
      try {
        const content = readWereadChapter(await call(WEREAD_TOOLS.chapter, { book_id: bookId, chapter_uid: c.uid }));
        const paras = content.html ? bookParasFromHtml(content.html) : splitBookParas(content.text);
        chapters.push({ title: c.title, wereadUid: c.uid, paras: paras.length ? paras : [`## ${c.title}`] });
      } catch (e) {
        throw new Error(`《${title}》第 ${index + 1} 章「${c.title}」获取失败：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!chapters.length) throw new Error(`《${title}》没有取到正文目录`);
    onProgress?.(chapters.length, chapters.length, '划线和想法');
    const notes = readWereadNotes(await call(WEREAD_TOOLS.notes, { book_id: bookId, include_chapters: true, organize_by_chapter: true }));
    notes.title ||= catalog.title;
    notes.author ||= catalog.author;
    notes.cover ||= catalog.cover;
    notes.intro ||= catalog.intro || null;
    if (notes.intro === null) {
      const hit = await call(WEREAD_TOOLS.search, { keyword: notes.title || title, exact_match: true, include_details: true, max_results: 1 })
        .then(readWereadSearchFirst)
        .catch(() => null);
      if (hit?.bookId === bookId) Object.assign(notes, { intro: hit.intro, cover: notes.cover || hit.cover });
    }
    const reviews = count > 0 ? await call(WEREAD_TOOLS.reviews, { book_id: bookId, count }).then(readWereadReviews).catch(() => []) : [];
    return { notes, reviews, chapters };
  });
}

const oneLine = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

/**
 * 正文、划线和想法 → 章、段、批注。旧的笔记集也可以用这个函数整理。
 */
export function wereadBody(n: WereadBookNotes, reviews: WereadReview[], contents?: BookChapter[]): BookBody {
  const chapters: BookChapter[] = [];
  const notes: BookNote[] = [];
  const now = Date.now();
  if (n.intro) chapters.push({ title: '简介', paras: splitBookParas(n.intro) });
  if (contents) chapters.push(...contents);
  for (const c of n.chapters) {
    const existing = contents ? chapters.findIndex((chapter) => c.uid ? chapter.wereadUid === c.uid : chapter.title === c.title) : -1;
    if (existing >= 0) {
      const paras = chapters[existing]!.paras;
      for (const h of c.highlights) {
        notes.push({ chapter: existing, para: Math.max(0, findQuotePara(paras, h.text)), who: 'you', quote: h.text, text: '划线', at: now, from: 'weread' });
      }
      for (const t of c.thoughts) {
        notes.push({ chapter: existing, para: Math.max(0, findQuotePara(paras, t.quote)), who: 'you', ...(t.quote ? { quote: t.quote } : {}), text: t.content, at: now, from: 'weread' });
      }
      continue;
    }
    const items = c.highlights.map((h) => ({ text: oneLine(h.text), at: h.at }));
    for (const t of c.thoughts) if (t.quote && !items.some((x) => x.text === oneLine(t.quote))) items.push({ text: oneLine(t.quote), at: t.at });
    if (items.every((x) => x.at !== null)) items.sort((a, b) => a.at! - b.at!);
    const paras = [...new Set(items.map((x) => x.text).filter(Boolean))];
    if (!paras.length) paras.push(`## ${c.title}`);
    const ci = chapters.length;
    chapters.push({ title: c.title, ...(c.uid ? { wereadUid: c.uid } : {}), paras });
    for (const t of c.thoughts) {
      const quote = t.quote ? oneLine(t.quote) : '';
      const para = Math.max(0, quote ? paras.indexOf(quote) : 0);
      // 划的就是这一整段时不用再引一遍
      notes.push({ chapter: ci, para, who: 'you', ...(quote && quote !== paras[para] ? { quote } : {}), text: t.content, at: now, from: 'weread' });
    }
  }
  if (reviews.length) {
    chapters.push({
      title: '热门书评',
      paras: reviews.map((r) => `**${r.author || '书友'}**${r.rating ? ` ${'★'.repeat(Math.round(r.rating))}` : ''}：${oneLine(r.content)}`),
    });
  }
  if (!chapters.length) throw new Error(`《${n.title}》在微信读书里还没有划线和想法，也没取到简介`);
  return { chapters, notes };
}

/** 划线常是段落中的一句，也可能跨段；定位到包含它开头的那一段。 */
function findQuotePara(paras: string[], quote: string): number {
  if (!quote) return 0;
  const normalized = quote.replace(/\s+/g, '');
  const texts = paras.map((p) => p.replace(/\s+/g, ''));
  const offset = texts.join('').indexOf(normalized);
  if (offset < 0) return -1;
  let end = 0;
  return texts.findIndex((p) => (end += p.length) > offset);
}

/** 放上我们的书架（已经放过的直接返回那一本）；返回书的 id */
export async function importWereadBook(b: WereadShelfBook, onProgress?: WereadImportProgress): Promise<string> {
  const shelf = useBookStore();
  const have = shelf.books.find((m) => m.weread?.bookId === b.bookId);
  if (have) {
    if (have.weread?.content !== 'full') await refreshWereadBook(have.id, onProgress);
    return have.id;
  }
  const { notes, reviews, chapters } = await fetchBook(b.bookId, b.title, onProgress);
  const now = Date.now();
  const meta = await shelf.add({
    id: uid('book'),
    title: notes.title || b.title,
    author: notes.author || b.author,
    cover: notes.cover || b.cover,
    format: 'weread',
    createdAt: now,
    updatedAt: now,
    pos: { chapter: 0, para: 0 },
    chapterCount: 0,
    weread: { bookId: b.bookId, syncedAt: now, content: 'full' },
    ...wereadBody(notes, reviews, chapters),
  });
  return meta.id;
}

/**
 * 从微信读书更新一本：正文和微信笔记换成新的，本机批注按章节 UID / 章名和原句挪过去。
 * 原句变化时保留引用；已经移除的章节留下本机批注，阅读位置和前情提要也保留。
 */
export async function refreshWereadBook(id: string, onProgress?: WereadImportProgress): Promise<void> {
  const shelf = useBookStore();
  const book = await shelf.load(id);
  if (!book?.weread) throw new Error('这本书不是从微信读书来的');
  const { notes, reviews, chapters } = await fetchBook(book.weread.bookId, book.title, onProgress);
  const next = wereadBody(notes, reviews, chapters);
  const where = (ci: number, para: number): [number, number] | null => {
    const oldChapter = book.chapters[ci];
    const title = oldChapter?.title;
    const text = book.chapters[ci]?.paras[para];
    const candidates = next.chapters.map((c, i) => ({ c, i })).filter(({ c }) => oldChapter?.wereadUid ? c.wereadUid === oldChapter.wereadUid : c.title === title);
    for (const { c, i } of candidates) {
      const npi = text === undefined ? -1 : findQuotePara(c.paras, text);
      if (npi >= 0) return [i, npi];
    }
    return candidates.length ? [candidates[0]!.i, -1] : null;
  };
  const retained = new Map<number, number>();
  for (const old of book.notes) {
    if (old.from === 'weread') continue;
    const at = where(old.chapter, old.para);
    if (at) {
      next.notes.push({ ...old, chapter: at[0], para: Math.max(0, at[1]), ...(at[1] < 0 && !old.quote ? { quote: book.chapters[old.chapter]?.paras[old.para] } : {}) });
    } else {
      if (!retained.has(old.chapter)) {
        retained.set(old.chapter, next.chapters.length);
        const c = book.chapters[old.chapter];
        next.chapters.push({ title: `${c?.title ?? '原章节'} · 本机批注`, paras: c?.paras ?? ['本机批注'] });
      }
      next.notes.push({ ...old, chapter: retained.get(old.chapter)! });
    }
  }
  const back = where(book.pos.chapter, book.pos.para);
  const pos = back ? { chapter: back[0], para: Math.max(0, back[1]) } : { chapter: 0, para: 0 };
  const now = Date.now();
  const updated = { ...book, ...next, summary: book.summary, pos, updatedAt: now };
  shelf.saveBody(updated, 0);
  await shelf.flushBody(id);
  const patch: Partial<BookMeta> = {
    pos,
    updatedAt: now,
    chapterCount: next.chapters.length,
    chapterTitle: next.chapters[pos.chapter]?.title,
    progress: paraProgress(next.chapters, pos),
    noteCount: next.notes.length,
    weread: { bookId: book.weread.bookId, syncedAt: now, content: 'full' },
    ...(notes.cover ? { cover: notes.cover } : {}),
    ...(notes.author ? { author: notes.author } : {}),
  };
  shelf.patch(id, patch);
}
