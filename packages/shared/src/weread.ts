/**
 * 微信读书 MCP（兼容 freestylefly/mcp-server-weread，另有目录/正文工具）：云端 Hub 内置一份（/v1/weread/mcp，Streamable HTTP），
 * 也可以连你自己部署的、工具同名的 MCP 服务器（例如把 mcp-server-weread 用 stdio → HTTP 的网关包一层）。
 * 这里是两边共用的约定：工具名、返回的 JSON 怎么读。返回的字段照那个仓库的写法；Hub 多给的（封面、简介、划线位置）是可选的。
 */
export const WEREAD_TOOLS = {
  shelf: 'get_bookshelf',
  search: 'search_books',
  notes: 'get_book_notes_and_highlights',
  reviews: 'get_book_best_reviews',
  catalog: 'get_book_catalog',
  chapter: 'get_book_chapter',
} as const;

/** 云端 Hub 内置的微信读书 MCP 认的请求头：直接给 Cookie，或者给 CookieCloud 让 Hub 每次去取最新的 */
export const WEREAD_HEADERS = {
  cookie: 'X-WeRead-Cookie',
  cookieCloudUrl: 'X-CookieCloud-Url',
  cookieCloudId: 'X-CookieCloud-Id',
  cookieCloudPassword: 'X-CookieCloud-Password',
} as const;

export interface WereadShelfBook {
  bookId: string;
  title: string;
  author: string;
  cover?: string;
  categories: string[];
  finishReading: boolean;
  /** 0–100 */
  progress: number;
  /** 秒 */
  readingTime: number;
  /** 上次读的时间（毫秒，没有为 0） */
  readAt: number;
  noteCount: number;
  reviewCount: number;
  bookmarkCount: number;
}

export interface WereadHighlight {
  text: string;
  /** 在章里的位置（划线的起点）；没有为 null */
  at: number | null;
}

export interface WereadThought {
  content: string;
  /** 想法挂在哪一句上（没有为空） */
  quote: string;
  at: number | null;
}

export interface WereadChapterNotes {
  uid?: string;
  title: string;
  highlights: WereadHighlight[];
  thoughts: WereadThought[];
}

export interface WereadBookNotes {
  bookId: string;
  title: string;
  author: string;
  /** 简介；null = 服务器没给这一项（自己部署的服务器，要用 search_books 补） */
  intro: string | null;
  cover: string;
  progress: number;
  finishReading: boolean;
  /** 按书里的顺序摊平（子章节跟在父章节后面），没归到章节的放最后 */
  chapters: WereadChapterNotes[];
}

export interface WereadReview {
  author: string;
  content: string;
  /** 0–5 */
  rating: number;
  likes: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);

/** 工具返回的文字 → JSON 对象；不是 JSON（服务器报错的话）时把那段话当错误抛出去 */
function parse(text: string): Obj {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error(text.trim().slice(0, 300) || '微信读书 MCP 没有返回内容');
  }
  if (!isObj(v)) throw new Error('微信读书 MCP 返回的格式不对');
  if (isObj(v.error) && typeof v.error.message === 'string') throw new Error(v.error.message);
  return v;
}

/** 划线的位置写成 "起-止"（例如 "2345-2401"）：取起点 */
const rangeStart = (v: unknown): number | null => {
  const n = parseInt(str(v), 10);
  return Number.isFinite(n) ? n : null;
};
const isoMs = (v: unknown) => {
  const t = Date.parse(str(v));
  return Number.isFinite(t) ? t : 0;
};

/** get_bookshelf 的结果 → 书架上的书 */
export function readWereadShelf(text: string): WereadShelfBook[] {
  return list(parse(text).books)
    .map((b) => ({
      bookId: str(b.bookId ?? b.book_id),
      title: str(b.title),
      author: str(b.author),
      ...(str(b.cover) ? { cover: str(b.cover) } : {}),
      categories: (Array.isArray(b.categories) ? b.categories : []).map(str).filter(Boolean),
      finishReading: b.finishReading === true || b.finish_reading === true,
      progress: Math.min(100, Math.max(0, num(b.progress))),
      readingTime: num(b.readingTime ?? b.reading_time),
      readAt: isoMs(b.updateTime ?? b.last_read_time),
      noteCount: num(b.noteCount),
      reviewCount: num(b.reviewCount),
      bookmarkCount: num(b.bookmarkCount),
    }))
    .filter((b) => b.bookId && b.title);
}

function byPosition<T extends { at: number | null }>(xs: T[]): T[] {
  return xs.every((x) => x.at !== null) ? [...xs].sort((a, b) => a.at! - b.at!) : xs;
}

function chapterNotes(title: string, c: Obj): WereadChapterNotes {
  return {
    uid: str(c.uid ?? c.chapter_uid) || undefined,
    title,
    highlights: byPosition(list(c.highlights).map((h) => ({ text: str(h.text), at: rangeStart(h.range) })).filter((h) => h.text)),
    thoughts: byPosition(list(c.notes).map((n) => ({ content: str(n.content), quote: str(n.highlight_text), at: rangeStart(n.range) })).filter((n) => n.content)),
  };
}

export interface WereadCatalog {
  bookId: string;
  title: string;
  author: string;
  cover: string;
  intro: string;
  chapters: { uid: string; title: string; level: number }[];
}

/** 目录保留所有章节，包括没有划线和想法的章节。 */
export function readWereadCatalog(text: string): WereadCatalog {
  const o = parse(text);
  const info = isObj(o.book_info) ? o.book_info : {};
  return {
    bookId: str(o.book_id), title: str(o.book_title), author: str(info.author), cover: str(info.cover), intro: str(info.intro),
    chapters: list(o.chapters).map((c) => ({ uid: str(c.uid), title: str(c.title), level: num(c.level) })),
  };
}

export function readWereadChapter(text: string): { uid: string; html: string; text: string } {
  const o = parse(text);
  return { uid: str(o.chapter_uid), html: str(o.html), text: str(o.text) };
}

/** get_book_notes_and_highlights（按章节组织）的结果 → 一章一章的划线和想法 */
export function readWereadNotes(text: string): WereadBookNotes {
  const o = parse(text);
  const info = isObj(o.book_info) ? o.book_info : {};
  const status = isObj(o.reading_status) ? o.reading_status : {};
  const chapters: WereadChapterNotes[] = [];
  const walk = (cs: Obj[]) => {
    for (const c of cs) {
      chapters.push(chapterNotes(str(c.title) || '未命名章节', c));
      walk(list(c.children));
    }
  };
  walk(list(o.chapters));
  // 不按章节组织时：所有划线和想法都在顶层，带着章名
  if (!chapters.length && (Array.isArray(o.highlights) || Array.isArray(o.notes))) {
    const byTitle = new Map<string, { highlights: Obj[]; notes: Obj[] }>();
    const slot = (t: string) => byTitle.get(t) ?? byTitle.set(t, { highlights: [], notes: [] }).get(t)!;
    for (const h of list(o.highlights)) slot(str(h.chapter_title) || '未命名章节').highlights.push(h);
    for (const n of list(o.notes)) slot(str(n.chapter_title) || '未命名章节').notes.push(n);
    for (const [t, c] of byTitle) chapters.push(chapterNotes(t, c));
  }
  if (isObj(o.uncategorized)) chapters.push(chapterNotes('其他', o.uncategorized));
  return {
    bookId: str(o.book_id),
    title: str(o.book_title),
    author: str(info.author),
    intro: 'intro' in info || 'description' in info ? str(info.intro ?? info.description) : null,
    cover: str(info.cover),
    progress: Math.min(100, Math.max(0, num(status.progress))),
    finishReading: status.finish_reading === true,
    chapters: chapters.filter((c) => c.highlights.length || c.thoughts.length),
  };
}

/** search_books（带详情）的第一本：补简介和封面（自己部署的服务器的划线结果里没有这两样时用） */
export function readWereadSearchFirst(text: string): { bookId: string; intro: string; cover: string } | null {
  const b = list(parse(text).books)[0];
  if (!b) return null;
  const info = isObj(b.book_info) ? b.book_info : {};
  return { bookId: str(b.book_id ?? b.bookId), intro: str(info.description ?? info.intro), cover: str(b.cover) };
}

/** get_book_best_reviews 的结果 → 书评 */
export function readWereadReviews(text: string): WereadReview[] {
  return list(parse(text).reviews)
    .map((r) => ({ author: str(r.author_nickname), content: str(r.content), rating: num(r.rating), likes: num(r.likes) }))
    .filter((r) => r.content);
}
