/**
 * 一起观影的"找真的视频"：她在聊天里只说了片名（[watch:片名]）时，按片名搜 B 站，给出能嵌入播放的真实视频（BV 号）。
 * 浏览器直接请求 B 站会被跨域和风控挡住，所以由你自己的 Hub 直接请求（要登录 Hub 才能用，不是公开代理）。
 * B 站的搜索要 buvid3 Cookie 和 WBI 签名：优先用用户的 buvid，缺少时再取（/x/frontend/finger/spi），全程带同一套 Cookie。
 * 参考 siios 的 scripts/update_bilibili.py（同一个搜索接口）。
 */
import type { VideoHit } from '@app/shared';
import { connect } from 'cloudflare:sockets';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];

/** 同一份用户 Cookie 的 buvid 和签名 key 复用一小时；切换 Cookie 时重新建立会话 */
let cached: { at: number; userCookie: string; cookie: string; mixin: string } | null = null;

const cookieHeader = (value: string) => value.trim() && (value.includes('=') ? value.trim() : `SESSDATA=${value.trim()}`);

async function md5(text: string): Promise<string> {
  // Workers 的 crypto.subtle 支持 MD5（B 站签名要用）
  const buf = await crypto.subtle.digest('MD5', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 使用 Worker 的 TLS socket 出口；HTTP/1.0 + close + identity 让 JSON 响应按连接结束分帧。 */
async function getJson(url: string, headers: Record<string, string>): Promise<Record<string, unknown>> {
  const target = new URL(url);
  const socket = connect({ hostname: 'api.bilibili.com', port: 443 }, { secureTransport: 'on', allowHalfOpen: false });
  socket.closed.catch(() => {});
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void socket.close().catch(() => {}); }, 12_000);
  try {
    const fields = new Headers({ 'User-Agent': UA, Referer: 'https://www.bilibili.com/', ...headers });
    const writer = socket.writable.getWriter();
    await writer.write(new TextEncoder().encode(
      `GET ${target.pathname}${target.search} HTTP/1.0\r\nHost: api.bilibili.com\r\nAccept: application/json\r\nAccept-Encoding: identity\r\nConnection: close\r\n`
      + [...fields].map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n',
    ));
    const raw = await new Response(socket.readable).text();
    const boundary = raw.indexOf('\r\n\r\n');
    const status = Number(raw.split(' ', 2)[1]);
    if (status < 200 || status >= 300) throw new Error(`B 站返回 HTTP ${status}（${target.pathname}）`);
    return JSON.parse(raw.slice(boundary + 4)) as Record<string, unknown>;
  } catch (error) {
    if (timedOut) throw new Error(`B 站请求超时（${target.pathname}）`);
    throw error;
  } finally {
    clearTimeout(timer);
    await socket.close().catch(() => {});
  }
}

async function session(userCookie: string): Promise<{ cookie: string; mixin: string }> {
  const mine = cookieHeader(userCookie);
  if (cached && cached.userCookie === mine && Date.now() - cached.at < 3_600_000) return cached;
  let cookie = mine;
  if (!/(?:^|;\s*)buvid3=/.test(mine)) {
    const spi = (await getJson('https://api.bilibili.com/x/frontend/finger/spi', mine ? { Cookie: mine } : {})).data as { b_3?: string; b_4?: string } | undefined;
    if (!spi?.b_3) throw new Error('B 站没有给 buvid');
    const parts = [mine, `buvid3=${spi.b_3}`];
    if (!/(?:^|;\s*)buvid4=/.test(mine)) parts.push(`buvid4=${encodeURIComponent(spi.b_4 ?? '')}`);
    cookie = parts.filter(Boolean).join('; ');
  }
  const nav = (await getJson('https://api.bilibili.com/x/web-interface/nav', { Cookie: cookie })).data as { wbi_img?: { img_url?: string; sub_url?: string } } | undefined;
  const key = (u?: string) => u?.split('/').pop()?.split('.')[0] ?? '';
  const raw = key(nav?.wbi_img?.img_url) + key(nav?.wbi_img?.sub_url);
  if (raw.length < 64) throw new Error('B 站没有给签名用的 key');
  cached = { at: Date.now(), userCookie: mine, cookie, mixin: MIXIN.map((i) => raw[i]).join('').slice(0, 32) };
  return cached;
}

async function signed(params: Record<string, string | number>, mixin: string): Promise<string> {
  const all: Record<string, string> = { ...Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])), wts: String(Math.floor(Date.now() / 1000)) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k]!.replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${await md5(query + mixin)}`;
}

const plain = (s: unknown) =>
  String(s ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .trim();

/**
 * 按关键词搜 B 站视频，最多 limit 条；搜不到为空数组，被风控、接口变了时抛出写好原因的错误。
 * userCookie：App"观影设置"里填的 B 站登录 Cookie（SESSDATA=…），带上它 B 站的风控松一些；只贴了 SESSDATA 的值也行。
 */
export async function searchBilibili(keyword: string, limit = 8, userCookie = ''): Promise<VideoHit[]> {
  const q = keyword.trim().slice(0, 60);
  if (!q) return [];
  let cookie = cookieHeader(userCookie);
  let list: Record<string, unknown>[];
  const referer = `https://search.bilibili.com/all?keyword=${encodeURIComponent(q)}`;
  try {
    let s = await session(userCookie);
    const run = async () => {
      cookie = s.cookie;
      const query = await signed({ search_type: 'video', keyword: q, page: 1, page_size: 20 }, s.mixin);
      return getJson(`https://api.bilibili.com/x/web-interface/wbi/search/type?${query}`, { Cookie: cookie, Referer: referer });
    };
    let data = await run();
    // buvid 过期、key 换了：重新取一次
    if (data.code !== 0) {
      cached = null;
      s = await session(userCookie);
      data = await run();
    }
    if (data.code !== 0) throw new Error(`B 站搜索没成功（${String(data.code)} ${plain(data.message)}）`);
    list = ((data.data as { result?: Record<string, unknown>[] } | undefined)?.result ?? []);
  } catch {
    // spi / nav 也可能被 412 拦截；综合搜索直接使用现有 Cookie，不依赖这些初始化请求。
    const data = await getJson(`https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(q)}&page=1`, { Cookie: cookie, Referer: referer });
    if (data.code !== 0) throw new Error(`B 站搜索没成功（${String(data.code)} ${plain(data.message)}）`);
    const groups = (data.data as { result?: { result_type?: string; data?: Record<string, unknown>[] }[] } | undefined)?.result ?? [];
    list = groups.find((group) => group.result_type === 'video')?.data ?? [];
  }
  const hits = list.filter((r) => typeof r.bvid === 'string' && /^BV[0-9A-Za-z]{10}$/.test(r.bvid)).slice(0, Math.min(20, Math.max(1, limit)));
  // 搜索结果没有 cid：按 BV 号取第一 P 的 cid。App 的嵌入播放器带上 aid + cid 才不用请求视频信息接口
  // （iOS 上那个请求没有 Cookie，B 站回 412、显示失效）；取不到就不带
  // Workers 同一请求最多同时打开 6 条连接；分组读取，及时关闭每一条 TLS socket。
  const cids: number[] = [];
  for (let i = 0; i < hits.length; i += 4) {
    cids.push(...await Promise.all(hits.slice(i, i + 4).map((r) =>
      getJson(`https://api.bilibili.com/x/player/pagelist?bvid=${r.bvid as string}`, { Cookie: cookie }).then(
        (d) => Number((d.data as { cid?: unknown }[] | undefined)?.[0]?.cid) || 0,
        () => 0,
      ),
    )));
  }
  return hits.map((r, i) => {
    const aid = Number(r.aid) || 0;
    return {
      bvid: r.bvid as string,
      title: plain(r.title),
      author: plain(r.author),
      duration: plain(r.duration),
      cover: String(r.pic ?? '').replace(/^\/\//, 'https://').replace(/^http:\/\//, 'https://'),
      plays: Number(r.play) || 0,
      url: `https://www.bilibili.com/video/${r.bvid as string}${aid && cids[i] ? `?aid=${aid}&cid=${cids[i]}` : ''}`,
    };
  });
}

/**
 * 一个 B 站视频（BV 号或 av 号）第 page P 的 aid 和 cid：贴的链接里没有它们时 App 来问。
 * 嵌入播放器带上它们就不用请求视频信息接口（iOS 上那个请求没有 Cookie，B 站回 412、显示失效）。
 */
export async function bilibiliIds(id: string, page = 1): Promise<{ aid: number; cid: number }> {
  const s = await session('');
  const query = id.startsWith('BV') ? `bvid=${id}` : `aid=${id.replace(/^av/i, '')}`;
  const data = await getJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { Cookie: s.cookie });
  const d = data.data as { aid?: unknown; pages?: { cid?: unknown }[] } | undefined;
  const aid = Number(d?.aid) || 0;
  const cid = Number(d?.pages?.[page - 1]?.cid) || 0;
  if (data.code !== 0 || !aid || !cid) throw new Error(`B 站没给这个视频的信息（${String(data.code)} ${plain(data.message)}）`);
  return { aid, cid };
}
