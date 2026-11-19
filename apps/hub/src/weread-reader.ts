/** 微信读书网页阅读器：目录和章节正文。一次 MCP 请求取一章，整书由客户端逐章导入。 */
import { WeReadSession } from './weread-session.ts';

const BASE = 'https://weread.qq.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
type Obj = Record<string, any>;

async function md5(value: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('MD5', new TextEncoder().encode(value)));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** 网页阅读器的书号、章节号和时间编码（不是 API 使用的十进制 ID）。 */
export async function readerId(value: string | number): Promise<string> {
  const source = String(value);
  const hash = await md5(source);
  const numeric = /^\d+$/.test(source);
  const parts = numeric
    ? source.match(/.{1,9}/g)!.map((part) => Number(part).toString(16))
    : [source.split('').map((char) => char.charCodeAt(0).toString(16)).join('')];
  let result = hash.slice(0, 3) + (numeric ? '3' : '4') + '2' + hash.slice(-2);
  result += parts.map((part) => part.length.toString(16).padStart(2, '0') + part).join('g');
  result += hash.slice(0, Math.max(0, 20 - result.length));
  return result + (await md5(result)).slice(0, 3);
}

export function readerSignature(params: Record<string, string | number | boolean>): string {
  const query = Object.keys(params).sort().map((key) => `${key}=${encodeURIComponent(String(params[key]))}`).join('&');
  const hashes = [0x15051505, 0x15051505];
  for (let i = query.length - 1; i > 0; i -= 2) {
    hashes[0] = (hashes[0]! ^ (query.charCodeAt(i) << ((query.length - i) % 30))) & 0x7fffffff;
    hashes[1] = (hashes[1]! ^ (query.charCodeAt(i - 1) << (i % 30))) & 0x7fffffff;
  }
  return (hashes[0]! + hashes[1]!).toString(16);
}

/** e_0/e_1/e_3（EPUB）或 t_0/t_1（TXT）依次拼接，恢复网页正文。 */
export function decodeReaderContent(shards: string[]): string {
  const encoded = shards.map((shard) => shard.slice(32)).join('').slice(1);
  const chars = encoded.split('');
  const pairs: number[] = [];
  if (chars.length >= 4 && chars.length < 11) pairs.push(0, 2);
  else if (chars.length >= 11) {
    const tailLength = Math.min(4, Math.ceil(chars.length / 10));
    const seed = chars.slice(-tailLength).reverse().map((char) => parseInt(char.charCodeAt(0).toString(2), 4).toString()).join('');
    const span = chars.length - tailLength - 2;
    const width = String(span).length;
    for (let at = 0; pairs.length < 10 && at + width < seed.length; at += width) {
      pairs.push(Number(seed.slice(at, at + width)) % span, Number(seed.slice(at + 1, at + width + 1)) % span);
    }
  }
  for (let at = pairs.length - 2; at >= 0; at -= 2) {
    for (const delta of [1, 0]) {
      const left = pairs[at]! + delta;
      const right = pairs[at + 1]! + delta;
      [chars[left], chars[right]] = [chars[right]!, chars[left]!];
    }
  }
  const base64 = chars.join('').replace(/-/g, '+').replace(/_/g, '/').replace(/[^A-Za-z0-9+/]/g, '');
  const binary = atob(base64 + '='.repeat((4 - base64.length % 4) % 4));
  // 网页编码里未组成 UTF-8 的单字节字符按原值保留（如拉丁文重音符号）。
  let text = '';
  for (let i = 0; i < binary.length;) {
    const first = binary.charCodeAt(i);
    const length = first >= 0xf0 && first < 0xf8 ? 4 : first >= 0xe0 && first < 0xf0 ? 3 : first >= 0xc0 && first < 0xe0 ? 2 : 1;
    const rest = Array.from(binary.slice(i + 1, i + length), (c) => c.charCodeAt(0));
    if (length > 1 && rest.length === length - 1 && rest.every((b) => b >= 0x80 && b < 0xc0)) {
      const code = rest.reduce((n, b) => (n << 6) | (b & 0x3f), first & (0x7f >> length));
      text += String.fromCodePoint(code);
      i += length;
    } else {
      text += binary[i];
      i += 1;
    }
  }
  return text;
}

export class WeReadReader {
  constructor(private readonly session: WeReadSession) {}

  private async request(path: string, referer: string, body?: Obj): Promise<string> {
    const res = await this.session.fetch(`${BASE}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'User-Agent': UA, Referer: referer, Origin: BASE, 'Content-Type': 'application/json;charset=UTF-8' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`微信读书正文返回 HTTP ${res.status}`);
    if (raw.trimStart().startsWith('{')) {
      const data = JSON.parse(raw) as Obj;
      const code = data.errcode ?? data.errCode;
      if (code === -2012 || code === -2010) throw new Error('微信读书 Cookie 过期了：请更新看书设置里的 Cookie');
      throw new Error(data.errmsg ?? data.errMsg ?? '微信读书没有返回这一章的正文，请在网页版打开该章节后重试');
    }
    return raw;
  }

  private async open(bookId: string, chapterUid?: string): Promise<{ reader: Obj; referer: string }> {
    const path = `/web/reader/${await readerId(bookId)}${chapterUid ? `k${await readerId(chapterUid)}` : ''}`;
    const html = await this.request(path, `${BASE}/`);
    const state = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*;\s*\(function/);
    if (!state) throw new Error('微信读书没有返回阅读器内容，请在网页版打开这本书后重试');
    return { reader: JSON.parse(state[1]!).reader, referer: `${BASE}${path}` };
  }

  async catalog(bookId: string) {
    const { reader } = await this.open(bookId);
    return {
      book_id: bookId,
      book_title: reader.bookInfo.title,
      book_info: { author: reader.bookInfo.author, cover: reader.bookInfo.cover, intro: reader.bookInfo.intro, format: reader.bookInfo.format },
      chapters: [...reader.chapterInfos].sort((a: Obj, b: Obj) => a.chapterIdx - b.chapterIdx)
        .map((c: Obj) => ({ uid: String(c.chapterUid), title: c.title, level: c.level, word_count: c.wordCount })),
    };
  }

  async chapter(bookId: string, chapterUid: string) {
    const { reader, referer } = await this.open(bookId, chapterUid);
    const format = reader.bookInfo.format;
    const paths = format === 'txt' ? ['t_0', 't_1'] : ['e_0', 'e_1', 'e_3'];
    let ct = Math.floor(Date.now() / 1000);
    if (await readerId(ct) === reader.psvts) ct += 1;
    const params = {
      b: await readerId(bookId), c: await readerId(chapterUid), r: String(Math.floor(Math.random() * 10000) ** 2),
      ct: String(ct), ps: String(reader.psvts), pc: await readerId(ct), sc: 1, prevChapter: false, st: 0,
    };
    const body = { ...params, s: readerSignature(params) };
    const shards = await Promise.all(paths.map((path) => this.request(`/web/book/chapter/${path}`, referer, body)));
    const content = decodeReaderContent(shards);
    if (!content.trim()) throw new Error('微信读书返回了空章节，请在网页版打开该章节后重试');
    return { book_id: bookId, chapter_uid: chapterUid, format, ...(format === 'txt' ? { text: content } : { html: content }) };
  }
}
