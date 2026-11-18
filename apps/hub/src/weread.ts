/**
 * 微信读书 MCP（照 freestylefly/mcp-server-weread 移植）：那个仓库是 stdio 服务器，手机和浏览器跑不了，
 * 所以在你自己的 Hub 里兼容原有四个工具，并增加目录和章节正文工具，提供 Streamable HTTP 的 MCP 端点（/v1/weread/mcp，要登录 Hub）。
 * - 无状态：每个请求自己带登录信息，不发 Mcp-Session-Id；只实现 initialize、ping、tools/list、tools/call；
 * - 微信读书的登录信息放在请求头里（WEREAD_HEADERS）：直接给 Cookie，或者给 CookieCloud（每次去取最新的，Cookie 不怕过期），
 *   两样都给时先用 CookieCloud，取不到再用 Cookie（和那个仓库一样）。Hub 不存它们；
 * - 返回的 JSON 照那个仓库的字段写，多给封面、简介、划线位置（range），划线和想法按在章里的位置排。
 */
import { WEREAD_HEADERS, WEREAD_TOOLS } from '@app/shared';
import { WeReadReader } from './weread-reader.ts';

const BASE = 'https://weread.qq.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
const PROTOCOL = '2025-06-18';
/** 点评（整本书的书评）挂在这个章节号下（那个仓库的约定） */
const REVIEW_CHAPTER = 1_000_000;

type Obj = Record<string, any>;

interface Auth {
  cookie: string;
  cookieCloud: { url: string; id: string; password: string } | null;
}

function https(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password;
  } catch {
    return false;
  }
}

function authOf(request: Request): Auth {
  const h = (name: string) => request.headers.get(name)?.trim() ?? '';
  const url = h(WEREAD_HEADERS.cookieCloudUrl).replace(/\/+$/, '');
  const id = h(WEREAD_HEADERS.cookieCloudId);
  const password = h(WEREAD_HEADERS.cookieCloudPassword);
  return { cookie: h(WEREAD_HEADERS.cookie), cookieCloud: url && id && password && https(url) ? { url, id, password } : null };
}

/** CookieCloud：POST {url}/get/{id} { password } 拿到解密好的 Cookie，挑出 weread.qq.com 的 */
async function cloudCookie(cc: NonNullable<Auth['cookieCloud']>): Promise<string> {
  const res = await fetch(`${cc.url}/get/${encodeURIComponent(cc.id)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: cc.password }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`CookieCloud 返回 HTTP ${res.status}`);
  const data = (await res.json().catch(() => null)) as { cookie_data?: Record<string, { name?: string; value?: string; domain?: string }[]> } | null;
  const all = Object.values(data?.cookie_data ?? {}).flatMap((xs) => (Array.isArray(xs) ? xs : []));
  const mine = all.filter((c) => c.name && c.value !== undefined && /(^|\.)weread\.qq\.com$/.test(c.domain ?? ''));
  return [...new Map(mine.map((c) => [c.name!, `${c.name}=${c.value}`])).values()].join('; ');
}

async function cookieOf(auth: Auth): Promise<string> {
  if (auth.cookieCloud) {
    try {
      const c = await cloudCookie(auth.cookieCloud);
      if (c) return c;
    } catch (e) {
      if (!auth.cookie) throw new Error(`从 CookieCloud 取微信读书 Cookie 失败：${e instanceof Error ? e.message : String(e)}`);
    }
    if (!auth.cookie) throw new Error('CookieCloud 里没有微信读书（weread.qq.com）的 Cookie：浏览器插件的同步域名里加上 weread，再同步一次');
  }
  if (!auth.cookie) throw new Error('没有微信读书的 Cookie：在 App 的"看书设置"里填 Cookie 或 CookieCloud');
  return auth.cookie;
}

class WeRead {
  constructor(private readonly cookie: string) {}

  reader() { return new WeReadReader(this.cookie); }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Cookie: this.cookie, 'User-Agent': UA, Accept: 'application/json, text/plain, */*', 'Accept-Language': 'zh-CN,zh;q=0.9', Referer: `${BASE}/`, ...extra };
  }

  private async send(path: string, init: RequestInit, attempt = 1): Promise<Obj> {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      if (attempt < 2) return this.send(path, init, attempt + 1);
      throw new Error(`连不上微信读书（${e instanceof Error ? e.message : String(e)}）`);
    }
    if (res.status >= 500 && attempt < 2) return this.send(path, init, attempt + 1);
    const data = (await res.json().catch(() => null)) as Obj | null;
    if (!data) throw new Error(`微信读书返回 HTTP ${res.status}，不是 JSON（${path.split('?')[0]}）`);
    const code = data.errcode ?? data.errCode;
    if (code !== undefined && code !== 0) {
      if (code === -2012 || code === -2010) throw new Error('微信读书 Cookie 过期了：重新复制一次 Cookie（或者让 CookieCloud 再同步一次）');
      throw new Error(`微信读书报错：${data.errmsg ?? data.errMsg ?? '未知'}（${code}）`);
    }
    return data;
  }

  get(path: string, params: Record<string, string | number> = {}): Promise<Obj> {
    const q = new URLSearchParams({ ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), _: String(Date.now()) });
    return this.send(`${path}?${q}`, { headers: this.headers() });
  }

  /** 完整书架（书、进度、书单） */
  shelf() {
    return this.get('/web/shelf/sync');
  }
  /** 有笔记的书 */
  notebooks() {
    return this.get('/api/user/notebook');
  }
  bookInfo(bookId: string) {
    return this.get('/api/book/info', { bookId });
  }
  progress(bookId: string) {
    return this.get('/web/book/getProgress', { bookId });
  }
  async bookmarks(bookId: string): Promise<Obj[]> {
    const data = await this.get('/web/book/bookmarklist', { bookId });
    return (Array.isArray(data.updated) ? data.updated : []).filter((m: Obj) => m.markText && m.chapterUid);
  }
  /** 想法和点评 */
  async reviews(bookId: string): Promise<Obj[]> {
    const data = await this.get('/web/review/list', { bookId, listType: 4, maxIdx: 0, count: 0, listMode: 2, syncKey: 0 });
    return (Array.isArray(data.reviews) ? data.reviews : [])
      .map((x: Obj) => x.review as Obj)
      .filter(Boolean)
      .map((r: Obj) => (r.type === 4 ? { chapterUid: REVIEW_CHAPTER, ...r } : r));
  }
  bestReviews(bookId: string, count: number, maxIdx: number, synckey: number) {
    return this.get('/web/review/list/best', { bookId, synckey, maxIdx, count });
  }
  /** 章节目录（加上"点评"这一章） */
  async chapters(bookId: string): Promise<Obj[]> {
    // 先访问一次首页（那个仓库也这样做，让会话有效）
    await fetch(`${BASE}/`, { headers: this.headers({ Accept: 'text/html' }), signal: AbortSignal.timeout(15_000) }).then((r) => r.body?.cancel()).catch(() => undefined);
    const data = await this.send('/web/book/chapterInfos', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json;charset=UTF-8', Origin: BASE, Referer: `${BASE}/web/reader/${bookId}` }),
      body: JSON.stringify({ bookIds: [bookId] }),
    });
    const raw: unknown = Array.isArray(data.data) ? data.data[0]?.updated : Array.isArray(data.updated) ? data.updated : null;
    if (!Array.isArray(raw)) throw new Error('微信读书的章节目录格式不对');
    return [...raw, { chapterUid: REVIEW_CHAPTER, chapterIdx: REVIEW_CHAPTER, title: '点评', level: 1 }];
  }
}

const formatTime = (seconds: number): string => {
  if (!seconds) return '0分钟';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}小时${m > 0 ? `${m}分钟` : ''}` : `${m}分钟`;
};
const iso = (sec: unknown) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : '');
const rangeStart = (r: unknown) => {
  const n = parseInt(String(r ?? ''), 10);
  return Number.isFinite(n) ? n : Infinity;
};
const byRange = <T extends { range?: string }>(xs: T[]) => xs.sort((a, b) => rangeStart(a.range) - rangeStart(b.range));
const text = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });

// —— 原有的书架/笔记工具，以及目录、正文扩展 ——
const TOOLS = [
  {
    name: WEREAD_TOOLS.catalog,
    description: 'Get the complete book chapter catalog from the web reader, including chapters without notes',
    inputSchema: { type: 'object', properties: { book_id: { type: 'string', description: 'Book ID' } }, required: ['book_id'] },
  },
  {
    name: WEREAD_TOOLS.chapter,
    description: 'Read the full text of one chapter with the current WeRead session. Call for every chapter in get_book_catalog to import a whole book',
    inputSchema: { type: 'object', properties: { book_id: { type: 'string', description: 'Book ID' }, chapter_uid: { type: 'string', description: 'Chapter UID from get_book_catalog' } }, required: ['book_id', 'chapter_uid'] },
  },
  {
    name: WEREAD_TOOLS.shelf,
    description: "Get all books in the user's bookshelf with comprehensive statistics and categorization information",
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: WEREAD_TOOLS.search,
    description: "Search for books in the user's bookshelf by keywords and return matching books with details and reading progress",
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Search keyword to match book title, author, translator or category' },
        exact_match: { type: 'boolean', description: 'Whether to use exact matching, default is fuzzy matching', default: false },
        include_details: { type: 'boolean', description: 'Whether to include detailed information', default: true },
        max_results: { type: 'integer', description: 'Maximum number of results to return', default: 5 },
      },
      required: ['keyword'],
    },
  },
  {
    name: WEREAD_TOOLS.notes,
    description: 'Get all highlights and notes for a specific book, organized by chapter',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string', description: 'Book ID' },
        include_chapters: { type: 'boolean', description: 'Whether to include chapter information', default: true },
        organize_by_chapter: { type: 'boolean', description: 'Whether to organize by chapter', default: true },
        highlight_style: { type: ['integer', 'null'], description: 'Highlight style filter, null means all', default: null },
      },
      required: ['book_id'],
    },
  },
  {
    name: WEREAD_TOOLS.reviews,
    description: 'Get popular reviews for a specific book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'string', description: 'Book ID' },
        count: { type: 'integer', description: 'Number of reviews to return', default: 10 },
        max_idx: { type: 'integer', description: 'Pagination index', default: 0 },
        synckey: { type: 'integer', description: 'Sync key for pagination', default: 0 },
      },
      required: ['book_id'],
    },
  },
].map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: true } }));

async function getBookshelf(api: WeRead) {
  const [shelf, notebook] = await Promise.all([api.shelf(), api.notebooks()]);
  const progress: Obj[] = shelf.bookProgress ?? [];
  const books: Obj[] = shelf.books ?? [];
  const archive: Obj[] = shelf.archive ?? [];
  const notebooks: Obj[] = notebook.books ?? [];
  const progressOf = (id: string) => progress.find((p) => p.bookId === id);
  const categoryStats: Record<string, number> = {};
  for (const b of books) for (const c of b.categories ?? []) categoryStats[c.title || 'unknown'] = (categoryStats[c.title || 'unknown'] ?? 0) + 1;
  const counts = archive.map((a) => ({ name: a.name, count: a.bookIds?.length ?? 0 })).sort((a, b) => b.count - a.count);
  const imported = books.filter((b) => String(b.bookId).startsWith('CB_')).length;
  return {
    stats: {
      totalBooks: books.length,
      readingStatus: {
        unreadBooks: books.filter((b) => b.finishReading !== 1 && !(progressOf(b.bookId)?.progress > 0)).length,
        readingBooks: books.filter((b) => b.finishReading !== 1 && progressOf(b.bookId)?.progress > 0).length,
        finishedBooks: books.filter((b) => b.finishReading === 1).length,
      },
      bookSource: { importedBooks: imported, wereadBooks: books.length - imported },
      paidBooks: books.filter((b) => b.paid === 1).length,
      booksWithNotes: notebooks.length,
      categories: { categoryStats, mainCategories: Object.entries(categoryStats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([category, count]) => ({ category, count })) },
    },
    booklistStats: { totalCategories: archive.length, largestCategory: counts[0] ?? null, smallestCategory: counts.at(-1) ?? null },
    booklists: archive.map((a) => ({ name: a.name, id: a.archiveId, bookCount: a.bookIds?.length ?? 0 })),
    books: books.map((b) => {
      const p = progressOf(b.bookId);
      const nb = notebooks.find((n) => n.bookId === b.bookId);
      return {
        bookId: b.bookId ?? '',
        title: b.title ?? '',
        author: b.author ?? '',
        translator: b.translator ?? '',
        cover: b.cover ?? '',
        categories: (b.categories ?? []).map((c: Obj) => c.title),
        bookLists: archive.filter((a) => a.bookIds?.includes(b.bookId)).map((a) => a.name),
        publishTime: b.publishTime ?? '',
        finishReading: b.finishReading === 1,
        price: b.price ?? 0,
        paid: b.paid === 1,
        isImported: String(b.bookId).startsWith('CB_'),
        progress: p?.progress ?? 0,
        readingTime: p?.readingTime ?? 0,
        readingTimeFormatted: formatTime(p?.readingTime ?? 0),
        updateTime: iso(p?.updateTime),
        noteCount: nb?.noteCount ?? 0,
        reviewCount: nb?.reviewCount ?? 0,
        bookmarkCount: nb?.bookmarkCount ?? 0,
      };
    }),
  };
}

async function searchBooks(api: WeRead, args: Obj) {
  const keyword = String(args.keyword ?? '').trim().toLowerCase();
  if (!keyword) throw new Error('搜索关键词不能为空');
  const exact = args.exact_match === true;
  const details = args.include_details !== false;
  const max = Math.min(50, Math.max(1, Number(args.max_results) || 5));
  const [shelf, notebook] = await Promise.all([api.shelf(), api.notebooks()]);
  const progress: Obj[] = shelf.bookProgress ?? [];
  const archive: Obj[] = shelf.archive ?? [];
  const notebooks: Obj[] = notebook.books ?? [];
  const hit = (s: unknown) => (exact ? String(s ?? '').toLowerCase() === keyword : String(s ?? '').toLowerCase().includes(keyword));
  const matched = ((shelf.books ?? []) as Obj[])
    .filter(
      (b) =>
        hit(b.title) ||
        hit(b.author) ||
        hit(b.translator) ||
        (b.categories ?? []).some((c: Obj) => String(c.title ?? '').toLowerCase().includes(keyword)) ||
        archive.some((a) => String(a.name ?? '').toLowerCase().includes(keyword) && a.bookIds?.includes(b.bookId)),
    )
    .slice(0, max);
  if (!details) {
    return {
      total_matches: matched.length,
      books: matched.map((b) => {
        const p = progress.find((x) => x.bookId === b.bookId);
        return { book_id: b.bookId, title: b.title ?? '', author: b.author ?? '', translator: b.translator ?? '', format: b.format ?? '', is_imported: String(b.bookId).startsWith('CB_'), finish_reading: b.finishReading === 1, paid: b.paid === 1, progress: p?.progress ?? 0, reading_time_formatted: formatTime(p?.readingTime ?? 0) };
      }),
    };
  }
  const books = [];
  for (const b of matched) {
    const [info, read] = await Promise.all([api.bookInfo(b.bookId), api.progress(b.bookId)]);
    const p = progress.find((x) => x.bookId === b.bookId);
    const nb = notebooks.find((n) => n.bookId === b.bookId);
    const readingTime = read.book?.readingTime || p?.readingTime || 0;
    books.push({
      book_id: b.bookId,
      title: b.title ?? '',
      author: b.author ?? '',
      translator: b.translator ?? '',
      cover: b.cover ?? '',
      categories: (b.categories ?? []).map((c: Obj) => c.title),
      book_lists: archive.filter((a) => a.bookIds?.includes(b.bookId)).map((a) => a.name),
      publish_info: `${b.publisher ?? ''} ${String(b.publishTime ?? '').slice(0, 10)}`.trim(),
      format: b.format ?? '',
      finish_reading: b.finishReading === 1,
      paid: b.paid === 1,
      is_imported: String(b.bookId).startsWith('CB_'),
      reading_status: {
        progress: read.book?.progress || p?.progress || 0,
        reading_time: readingTime,
        reading_time_formatted: formatTime(readingTime),
        start_reading_time: iso(read.book?.startReadingTime),
        has_started_reading: (read.book?.startReadingTime ?? 0) > 0,
        last_read_time: iso(read.book?.updateTime ?? p?.updateTime),
        note_count: nb?.noteCount ?? 0,
        bookmark_count: nb?.bookmarkCount ?? 0,
        review_count: nb?.reviewCount ?? 0,
      },
      book_info: {
        word_count: info.totalWords ?? 0,
        price: info.price ?? 0,
        rating: info.newRating ? info.newRating / 100 : 0,
        rating_count: info.newRatingCount ?? 0,
        description: info.intro ?? '',
        publisher: info.publisher ?? '',
        isbn: info.isbn ?? '',
        category: info.category ?? '',
      },
    });
  }
  return { total_matches: books.length, books };
}

async function getNotes(api: WeRead, args: Obj) {
  const bookId = String(args.book_id ?? '').trim();
  if (!bookId) throw new Error('书籍ID不能为空');
  const withChapters = args.include_chapters !== false;
  const byChapter = args.organize_by_chapter !== false;
  const style = args.highlight_style === undefined || args.highlight_style === null ? null : Number(args.highlight_style);
  const [info, read, marks, reviews, chapters] = await Promise.all([
    api.bookInfo(bookId),
    api.progress(bookId),
    api.bookmarks(bookId),
    api.reviews(bookId),
    withChapters ? api.chapters(bookId) : Promise.resolve([] as Obj[]),
  ]);
  const highlights = marks
    .filter((m) => style === null || m.colorStyle === style)
    .map((m) => ({ chapterUid: m.chapterUid, text: m.markText as string, style: m.colorStyle ?? m.style ?? 0, create_time: iso(m.createTime), range: String(m.range ?? '') }));
  const notes = reviews
    .filter((r) => r.content && r.chapterUid)
    .map((r) => ({ chapterUid: r.chapterUid, content: r.content as string, highlight_text: (r.abstract as string) ?? '', create_time: iso(r.createTime), range: String(r.range ?? '') }));
  const result: Obj = {
    book_id: bookId,
    book_title: info.title ?? '',
    book_info: {
      author: info.author ?? '',
      translator: info.translator ?? '',
      publisher: info.publisher ?? '',
      publish_time: info.publishTime ?? '',
      word_count: info.totalWords ?? 0,
      rating: info.newRating ? info.newRating / 100 : 0,
      category: info.category ?? '',
      intro: info.intro ?? '',
      cover: info.cover ?? '',
    },
    reading_status: {
      progress: read.book?.progress ?? 0,
      reading_time: read.book?.readingTime ?? 0,
      reading_time_formatted: formatTime(read.book?.readingTime ?? 0),
      start_reading_time: iso(read.book?.startReadingTime),
      has_started_reading: (read.book?.startReadingTime ?? 0) > 0,
      last_read_time: iso(read.book?.updateTime),
      finish_reading: info.finishReading === 1,
    },
    total_highlights: highlights.length,
    total_notes: notes.length,
    last_updated: new Date().toISOString(),
  };
  const titleOf = new Map(chapters.map((c) => [String(c.chapterUid), String(c.title ?? '')]));
  const strip = ({ chapterUid: _, ...rest }: Obj) => rest;
  if (!byChapter || !withChapters) {
    const tag = (x: Obj) => ({ ...strip(x), chapter_uid: x.chapterUid, chapter_title: titleOf.get(String(x.chapterUid)) || '未知章节' });
    result.highlights = highlights.map(tag);
    result.notes = notes.map(tag);
    return result;
  }
  // 按书里的顺序（chapterIdx）排，层级（level）决定父子：每一章挂在它前面最近的、层级更高的那一章下面
  interface Node { uid: number; title: string; level: number; children: Node[]; highlights: Obj[]; notes: Obj[] }
  const nodes = new Map<string, Node>();
  const roots: Node[] = [];
  const stack: Node[] = [];
  for (const c of [...chapters].sort((a, b) => (a.chapterIdx ?? 0) - (b.chapterIdx ?? 0))) {
    const node: Node = { uid: c.chapterUid, title: c.title ?? '', level: c.level ?? 1, children: [], highlights: [], notes: [] };
    nodes.set(String(c.chapterUid), node);
    while (stack.length && stack.at(-1)!.level >= node.level) stack.pop();
    (stack.at(-1)?.children ?? roots).push(node);
    stack.push(node);
  }
  result.uncategorized = { highlights: [] as Obj[], notes: [] as Obj[] };
  for (const h of highlights) (nodes.get(String(h.chapterUid))?.highlights ?? result.uncategorized.highlights).push(strip(h));
  for (const n of notes) (nodes.get(String(n.chapterUid))?.notes ?? result.uncategorized.notes).push(strip(n));
  const clean = (xs: Node[]): Obj[] =>
    xs
      .map((n) => ({ uid: n.uid, title: n.title, children: clean(n.children), highlights: byRange(n.highlights), notes: byRange(n.notes) }))
      .filter((n) => n.highlights.length || n.notes.length || n.children.length);
  result.chapters = clean(roots);
  return result;
}

async function getBestReviews(api: WeRead, args: Obj) {
  const bookId = String(args.book_id ?? '').trim();
  if (!bookId) throw new Error('书籍ID不能为空');
  const count = Math.min(50, Math.max(1, Number(args.count) || 10));
  const [info, data] = await Promise.all([api.bookInfo(bookId), api.bestReviews(bookId, count, Number(args.max_idx) || 0, Number(args.synckey) || 0)]);
  const level: Record<number, number> = { 1: 5, 2: 3, 3: 1 };
  const reviews = ((data.reviews ?? []) as Obj[])
    .filter((item) => item?.review?.review && (item.review.review.content || item.review.review.htmlContent))
    .map((item) => {
      const r = item.review.review as Obj;
      return {
        review_id: item.review.reviewId ?? '',
        content: r.content || r.htmlContent || '',
        rating: r.star ? r.star / 20 : (level[r.newRatingLevel] ?? 0),
        likes: r.liked || item.review.likesCount || 0,
        comments: r.comments || 0,
        created_time: iso(r.createTime),
        author_nickname: r.author?.name ?? '',
        is_spoiler: !!r.notVisibleToFriends,
        is_top: item.idx === 1 || !!item.isTop,
      };
    });
  return { book_id: bookId, book_title: info.title ?? '', book_author: info.author ?? '', total_reviews: data.reviewsCnt ?? 0, has_more: !!data.reviewsHasMore, sync_key: data.synckey ?? 0, reviews };
}

const HANDLERS: Record<string, (api: WeRead, args: Obj) => Promise<unknown>> = {
  [WEREAD_TOOLS.catalog]: (api, args) => api.reader().catalog(String(args.book_id)),
  [WEREAD_TOOLS.chapter]: (api, args) => api.reader().chapter(String(args.book_id), String(args.chapter_uid)),
  [WEREAD_TOOLS.shelf]: (api) => getBookshelf(api),
  [WEREAD_TOOLS.search]: searchBooks,
  [WEREAD_TOOLS.notes]: getNotes,
  [WEREAD_TOOLS.reviews]: getBestReviews,
};

interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Obj;
}

async function handle(msg: RpcRequest, auth: Auth): Promise<Obj | null> {
  const id = msg.id ?? null;
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
  // 通知不回
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof msg.params?.protocolVersion === 'string' ? msg.params.protocolVersion : PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: 'weread', title: '微信读书', version: '1.1.0' },
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS });
    case 'tools/call': {
      const name = String(msg.params?.name ?? '');
      const run = HANDLERS[name];
      if (!run) return fail(-32602, `未知的工具：${name}`);
      try {
        const api = new WeRead(await cookieOf(auth));
        return ok(text(await run(api, (msg.params?.arguments as Obj) ?? {})));
      } catch (e) {
        return ok({ content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    default:
      return fail(-32601, `不支持的方法：${msg.method}`);
  }
}

/** /v1/weread/mcp：Streamable HTTP（只回 JSON，不开 SSE 流） */
export async function wereadMcp(request: Request): Promise<Response> {
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST, DELETE' } });
  const raw = await request.text();
  if (raw.length > 100_000) return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求太大' } }, { status: 413 });
  let msg: RpcRequest | RpcRequest[];
  try {
    msg = JSON.parse(raw) as RpcRequest | RpcRequest[];
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '无效的 JSON' } }, { status: 400 });
  }
  const auth = authOf(request);
  const out = Array.isArray(msg) ? (await Promise.all(msg.map((m) => handle(m, auth)))).filter((r): r is Obj => !!r) : await handle(msg, auth);
  if (!out || (Array.isArray(out) && !out.length)) return new Response(null, { status: 202 });
  return Response.json(out, { headers: { 'Cache-Control': 'no-store' } });
}
