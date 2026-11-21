/**
 * 请求记录："请求记录"页看每一个请求实际发了什么用。request() 发出去的每一个请求（对话、生图、生图提示词、语音、向量……）
 * 都在这里记一笔：地址、方法、请求头（Key 打码）、请求体（图片之类的 base64 只记长度）、状态码、用时、返回内容。
 * App 没接上记录（observeRequests）时什么都不做。
 */

export interface RequestRecord {
  id: string;
  at: number;
  /** 哪个功能发的（主对话 main、生图提示词 imagePrompt、生图 image……）；不是经功能路由发的（测试连接等）为空 */
  role?: string;
  /** 渠道名称 */
  provider: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  status?: number;
  /** 到收到响应头用了多久 */
  ms?: number;
  contentType?: string;
  response?: string;
  error?: string;
}

export interface RequestObserver {
  begin(record: RequestRecord): void;
  end(id: string, patch: Partial<RequestRecord>): void;
}

let observer: RequestObserver | null = null;

/** 接上 / 断开请求记录 */
export function observeRequests(o: RequestObserver | null): void {
  observer = o;
}

export function requestObserver(): RequestObserver | null {
  return observer;
}

/** 带着"哪个功能发的"的发请求函数（功能路由给每个端点套一层） */
export interface LabeledTransport {
  (url: string, init: RequestInit): Promise<Response>;
  role?: string;
}

let seq = 0;
export function nextRecordId(): string {
  seq += 1;
  return `req-${Date.now().toString(36)}-${seq}`;
}

/** 请求头和地址里的 Key、Token 打码 */
const SECRET = /(?:^|[-_])(?:authorization|key|token|secret|cookie|password)$|^authorization$|api[-_]?key/i;

export function headersOf(h: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const entries: [string, string][] = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? (h as [string, string][]) : Object.entries(h as Record<string, string>);
  for (const [k, v] of entries) out[k] = SECRET.test(k) ? masked(String(v)) : String(v);
  return out;
}

function masked(v: string): string {
  const bearer = /^(bearer|token|basic)\s+/i.exec(v)?.[0] ?? '';
  const rest = v.slice(bearer.length);
  return `${bearer}${rest.length > 8 ? `${rest.slice(0, 4)}***${rest.slice(-2)}` : '***'}`;
}

export function urlOf(url: string): string {
  try {
    const u = new URL(url);
    for (const k of [...u.searchParams.keys()]) if (SECRET.test(k)) u.searchParams.set(k, masked(u.searchParams.get(k) ?? ''));
    return u.toString();
  } catch {
    return url;
  }
}

/** 一段很长、看起来是 base64（图片、音频、Vibe 编码）的字符串：只记长度 */
const BASE64 = /^(?:data:[^;,]+;base64,)?[A-Za-z0-9+/=\r\n]+$/;
function trimValue(v: unknown): unknown {
  if (typeof v === 'string') return v.length > 600 && BASE64.test(v.slice(0, 2000)) ? `<base64，${Math.round((v.length * 3) / 4 / 1024)} KB，没记下来>` : v;
  if (Array.isArray(v)) return v.map(trimValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trimValue(x)]));
  return v;
}

const MAX_TEXT = 300_000;
const capped = (t: string) => (t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT)}\n…（太长了，后面 ${t.length - MAX_TEXT} 个字没记）` : t);

/** 文字形式的 JSON：base64 只记长度，排好版 */
function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(trimValue(JSON.parse(text)), null, 2);
  } catch {
    return null;
  }
}

/** 请求体变成能看的文字 */
export function describeBody(body: RequestInit['body']): string {
  if (body == null) return '';
  if (typeof body === 'string') return capped(prettyJson(body) ?? body);
  if (body instanceof URLSearchParams) return capped(body.toString());
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const lines: string[] = [];
    body.forEach((v, k) => {
      lines.push(typeof v === 'string' ? `${k}: ${String(trimValue(v))}` : `${k}: <文件 ${(v as File).name || ''} ${v.type || ''} ${v.size} 字节>`);
    });
    return lines.join('\n');
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) return `<二进制 ${body.type || ''} ${body.size} 字节>`;
  if (body instanceof ArrayBuffer) return `<二进制 ${body.byteLength} 字节>`;
  if (ArrayBuffer.isView(body)) return `<二进制 ${body.byteLength} 字节>`;
  return '<没法显示的请求体>';
}

/** 返回内容变成能看的文字：JSON、文字、流式（SSE）照原样记，图片、zip、音频只记类型和大小 */
export async function describeResponse(res: Response): Promise<{ contentType: string; response: string }> {
  const contentType = res.headers.get('content-type') ?? '';
  try {
    const copy = res.clone();
    if (/json|text|event-stream|xml|javascript/i.test(contentType) || !contentType) {
      const text = await copy.text();
      return { contentType, response: capped(prettyJson(text) ?? text) };
    }
    const bytes = (await copy.arrayBuffer()).byteLength;
    return { contentType, response: `<二进制 ${contentType} ${bytes} 字节>` };
  } catch (e) {
    return { contentType, response: `<读不出返回内容：${e instanceof Error ? e.message : String(e)}>` };
  }
}
