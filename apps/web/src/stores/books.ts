import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getEntriesWhere, getOne, registerFlusher, write } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { paraProgress, type Book, type BookBody, type BookMeta } from '@/services/books';

/**
 * 我们的书架：一起看书的书存在本机（books 表），连着自己的 Worker 时随多设备同步走（书目、正文和批注；
 * PDF 原文件存成同步用的大文件，别的设备翻开原版页面时才下载）。一本书分三条存：
 * - {id}：书目（BookMeta，很小）。打开 App 时只读这些，书架页只用它们，自动保存；
 * - body:{id}：正文、批注、前情提要（BookBody）。翻开这本书时才读，阅读页改了以后（防抖）单独写回；
 * - file:{id}：PDF 原文件（原版页面、交给识图时要用）。
 * 以前的版本一条里存着整本书：第一次打开时拆成书目和正文两条。
 */
const bodyKey = (id: string) => `body:${id}`;
const fileKey = (id: string) => `file:${id}`;
const isMetaKey = (key: string) => !key.includes(':');
/** 书目里有的字段：阅读页改了它们时抄回书架 */
const META_FIELDS = ['title', 'author', 'cover', 'updatedAt', 'pos', 'chapterCount', 'chapterTitle', 'progress', 'noteCount', 'pageCount', 'technical', 'view', 'weread'] as const satisfies readonly (keyof BookMeta)[];

type Legacy = BookMeta & Partial<BookBody>;
const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

function split(book: Legacy): { meta: BookMeta; body: BookBody } {
  const { chapters = [], notes = [], summary, ...rest } = book;
  const pos = rest.pos ?? { chapter: 0, para: 0 };
  return {
    meta: { ...rest, pos, chapterCount: chapters.length, chapterTitle: chapters[pos.chapter]?.title, progress: rest.progress ?? paraProgress(chapters, pos), noteCount: notes.length },
    body: { chapters, notes, ...(summary ? { summary } : {}) },
  };
}

export const useBookStore = defineStore('books', () => {
  const books = ref<BookMeta[]>([]);
  // 别的设备加的书、读到哪（同步）：书目放进来；正文、原文件翻开时再读
  const saver = autoSave('books', () => books.value.map((b) => ({ key: b.id, value: b })), books,
    { apply: (changes) => applyList(books, changes, { sort: (a, b) => b.updatedAt - a.updatedAt }), owns: isMetaKey });
  /** 书架页的看法（搜什么、怎么排、哪个页签）：从阅读页回来时还在 */
  const shelfView = reactive({ tab: 'local' as 'local' | 'weread', query: '', sort: 'recent', filter: 'all' });

  async function hydrate() {
    const rows = await getEntriesWhere<Legacy>('books', isMetaKey);
    const metas: BookMeta[] = [];
    const puts: { key: string; value: unknown }[] = [];
    for (const { key, value } of rows) {
      if (!value || typeof value !== 'object' || typeof value.id !== 'string') continue;
      if (Array.isArray(value.chapters)) {
        const { meta, body } = split(value);
        metas.push(meta);
        puts.push({ key, value: meta }, { key: bodyKey(key), value: body });
      } else metas.push({ ...value, chapterCount: value.chapterCount ?? 0 });
    }
    if (puts.length) await write('books', puts);
    books.value = metas.sort((a, b) => b.updatedAt - a.updatedAt);
    saver.start();
  }

  function byId(id: string | null | undefined): BookMeta | undefined {
    return books.value.find((b) => b.id === id);
  }

  async function add(book: Legacy, file?: Blob): Promise<BookMeta> {
    const { meta, body } = split(book);
    await write('books', [{ key: bodyKey(meta.id), value: plain(body) }, ...(file ? [{ key: fileKey(meta.id), value: file }] : [])]);
    books.value.unshift(meta);
    return books.value[0]!;
  }

  function remove(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    pendingBodies.delete(id);
    books.value = books.value.filter((b) => b.id !== id);
    void write('books', [], [id, bodyKey(id), fileKey(id)]);
  }

  async function fileOf(id: string): Promise<Blob | undefined> {
    return getOne<Blob>('books', fileKey(id));
  }

  /** 翻开一本书：书目 + 正文（一个新的对象，阅读页改它，再用 patch / saveBody 写回） */
  async function load(id: string): Promise<Book | null> {
    const meta = byId(id);
    if (!meta) return null;
    await flushBody(id);
    const body = await getOne<BookBody>('books', bodyKey(id));
    if (!body || !Array.isArray(body.chapters)) return null;
    return { ...plain(meta), chapters: body.chapters, notes: body.notes ?? [], ...(body.summary ? { summary: body.summary } : {}) };
  }

  /** 书目改了（读到哪、看法、读了多少……）：抄回书架，自动保存 */
  function patch(id: string, next: Partial<BookMeta>) {
    const meta = byId(id);
    if (!meta) return;
    for (const k of META_FIELDS) {
      if (!(k in next)) continue;
      const v = next[k];
      if (JSON.stringify(v) === JSON.stringify(meta[k])) continue;
      if (v === undefined) delete meta[k];
      else (meta as unknown as Record<string, unknown>)[k] = plain(v);
    }
  }

  // —— 正文：改了以后防抖写回；切后台、关页面前写掉 ——
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 改过、还没写回的书（写的时候才序列化，连着改几次只写最后一次） */
  const pendingBodies = new Map<string, Book>();
  async function flushBody(id: string) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const book = pendingBodies.get(id);
    if (!book) return;
    pendingBodies.delete(id);
    const body: BookBody = plain({ chapters: book.chapters, notes: book.notes, ...(book.summary ? { summary: book.summary } : {}) });
    if (byId(id)) await write('books', [{ key: bodyKey(id), value: body }]);
  }
  function saveBody(book: Book, wait = 600) {
    pendingBodies.set(book.id, book);
    clearTimeout(timers.get(book.id));
    timers.set(book.id, setTimeout(() => void flushBody(book.id), wait));
  }
  const flushAll = () => [...pendingBodies.keys()].forEach((id) => void flushBody(id));
  // 同步合并前先把改了的正文写掉
  registerFlusher(() => Promise.all([...pendingBodies.keys()].map((id) => flushBody(id))));
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushAll());
    window.addEventListener('pagehide', flushAll);
  }

  return { books, shelfView, hydrate, byId, add, remove, fileOf, load, patch, saveBody, flushBody };
});
