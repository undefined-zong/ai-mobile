import type { McpOAuthConfig, McpOAuthToken } from '@app/shared';

/**
 * MCP 的 OAuth 登录（规范 2025-06-18 的授权部分）：
 * 1. 发现：先不带 Token 连一次，401 里的 WWW-Authenticate 指向受保护资源的元数据（RFC 9728），里面写着授权服务器；
 *    再读授权服务器的元数据（RFC 8414 / OpenID），拿到授权、换 Token、自动注册的地址。
 * 2. Client：自己填 Client ID（Google 的官方 MCP 要自己在 Google Cloud 建），或者授权服务器支持时自动注册（RFC 7591）。
 * 3. 授权码 + PKCE（S256），带 resource（RFC 8707）；换 Token、快过期时用 Refresh Token 换新的。
 * 只用 fetch 和 crypto.subtle：浏览器、Cloudflare Worker 都能跑（连了云端时换 Token、刷新都在 Worker 里做）。
 */

type FetchLike = typeof fetch;
const defaultFetch: FetchLike = (input, init) => fetch(input, init);

export interface McpOAuthDiscovery {
  /** 规范化后的 MCP 地址（resource 参数用） */
  resource: string;
  issuer?: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  /** 授权服务器或资源写着支持的权限 */
  scopesSupported: string[];
  /** 401 里建议要的权限 */
  scope?: string;
  /** 换 Token 时支持的认证方式 */
  authMethods: string[];
}

/** MCP 地址规范化（RFC 8707 的 resource）：去掉 #，主机小写，只有 / 的路径去掉 */
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = '';
  const href = u.href;
  return u.pathname === '/' && !u.search ? href.replace(/\/$/, '') : href;
}

/** 读 WWW-Authenticate：Bearer resource_metadata="…", scope="…" */
export function parseWwwAuthenticate(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const m of header.matchAll(/([a-zA-Z_][\w-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[m[1]!.toLowerCase()] = (m[2] ?? m[3] ?? '').replace(/\\(.)/g, '$1');
  return out;
}

async function getJson(url: string, f: FetchLike): Promise<Record<string, unknown> | null> {
  try {
    const res = await f(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const v = (await res.json()) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** 授权服务器元数据的候选地址（RFC 8414 + OpenID，issuer 带路径时路径插在 well-known 后面） */
function metadataUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/$/, '');
  return path
    ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
}

/** 发现这台 MCP 服务器的 OAuth 设置；不要登录或者找不到授权服务器时报错 */
export async function discoverOAuth(serverUrl: string, opts: { fetch?: FetchLike } = {}): Promise<McpOAuthDiscovery> {
  const f = opts.fetch ?? defaultFetch;
  const resource = canonicalResource(serverUrl);
  let www: Record<string, string> = {};
  try {
    const res = await f(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ai-mobile', version: '1.0.0' } } }),
      signal: AbortSignal.timeout(15_000),
    });
    await res.body?.cancel().catch(() => undefined);
    if (res.status !== 401) throw new Error(res.ok ? '这台服务器不用登录（没有返回 401），登录方式选"不用登录"或"请求头"就行' : `服务器返回 HTTP ${res.status}`);
    www = parseWwwAuthenticate(res.headers.get('WWW-Authenticate'));
  } catch (e) {
    if (e instanceof Error && /不用登录|HTTP \d/.test(e.message)) throw e;
    throw new Error(`连不上 ${serverUrl}（${e instanceof Error ? e.message : String(e)}）`);
  }
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/$/, '');
  const prmUrls = [www.resource_metadata, `${u.origin}/.well-known/oauth-protected-resource${path}`, `${u.origin}/.well-known/oauth-protected-resource`].filter((x): x is string => !!x);
  let prm: Record<string, unknown> | null = null;
  for (const url of [...new Set(prmUrls)]) if ((prm = await getJson(url, f))) break;
  // 没有受保护资源元数据的老服务器（2025-03-26）：授权服务器就是 MCP 服务器自己
  const issuer = strs(prm?.authorization_servers)[0] ?? u.origin;
  let meta: Record<string, unknown> | null = null;
  for (const url of metadataUrls(issuer)) if ((meta = await getJson(url, f))) break;
  const authorizationEndpoint = typeof meta?.authorization_endpoint === 'string' ? meta.authorization_endpoint : '';
  const tokenEndpoint = typeof meta?.token_endpoint === 'string' ? meta.token_endpoint : '';
  if (!authorizationEndpoint || !tokenEndpoint) throw new Error(`找不到授权服务器（${issuer}）的授权地址，可以手动填`);
  return {
    resource: typeof prm?.resource === 'string' ? prm.resource : resource,
    issuer: typeof meta?.issuer === 'string' ? meta.issuer : issuer,
    authorizationEndpoint,
    tokenEndpoint,
    ...(typeof meta?.registration_endpoint === 'string' ? { registrationEndpoint: meta.registration_endpoint } : {}),
    scopesSupported: [...new Set([...strs(prm?.scopes_supported), ...strs(meta?.scopes_supported)])],
    ...(www.scope ? { scope: www.scope } : {}),
    authMethods: strs(meta?.token_endpoint_auth_methods_supported),
  };
}

/** 自动注册一个 Client（授权服务器支持时）；公共客户端，不要 Secret */
export async function registerOAuthClient(
  registrationEndpoint: string,
  input: { redirectUri: string; clientName: string; scope?: string },
  opts: { fetch?: FetchLike } = {},
): Promise<{ clientId: string; clientSecret?: string; authMethod: McpOAuthConfig['authMethod'] }> {
  const f = opts.fetch ?? defaultFetch;
  const res = await f(registrationEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: input.clientName,
      redirect_uris: [input.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(input.scope ? { scope: input.scope } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.client_id !== 'string') throw new Error(`自动注册失败（HTTP ${res.status}）：${String(data.error_description ?? data.error ?? '')}`.trim());
  const secret = typeof data.client_secret === 'string' ? data.client_secret : undefined;
  const method = data.token_endpoint_auth_method;
  return { clientId: data.client_id, ...(secret ? { clientSecret: secret } : {}), authMethod: secret ? (method === 'client_secret_basic' ? 'basic' : 'post') : 'none' };
}

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** PKCE：随机的 verifier 和它的 S256 challenge；state 也顺便给一个 */
export async function createPkce(): Promise<{ verifier: string; challenge: string; state: string }> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return { verifier, challenge, state: base64url(crypto.getRandomValues(new Uint8Array(16))) };
}

/** 授权页的地址 */
export function authorizeUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
  resource?: string;
  extraParams?: string;
}): string {
  const u = new URL(input.authorizationEndpoint);
  const p = u.searchParams;
  p.set('response_type', 'code');
  p.set('client_id', input.clientId);
  p.set('redirect_uri', input.redirectUri);
  p.set('code_challenge', input.challenge);
  p.set('code_challenge_method', 'S256');
  p.set('state', input.state);
  if (input.scope?.trim()) p.set('scope', input.scope.trim());
  if (input.resource) p.set('resource', input.resource);
  for (const [k, v] of new URLSearchParams(input.extraParams ?? '')) if (k) p.set(k, v);
  return u.href;
}

async function tokenRequest(
  t: Pick<McpOAuthToken, 'tokenEndpoint' | 'clientId' | 'clientSecret' | 'authMethod' | 'resource'>,
  params: Record<string, string>,
  f: FetchLike,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams(params);
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (t.clientSecret && t.authMethod === 'basic') headers.Authorization = `Basic ${btoa(`${encodeURIComponent(t.clientId)}:${encodeURIComponent(t.clientSecret)}`)}`;
  else {
    body.set('client_id', t.clientId);
    if (t.clientSecret) body.set('client_secret', t.clientSecret);
  }
  if (t.resource) body.set('resource', t.resource);
  let res: Response;
  try {
    res = await f(t.tokenEndpoint, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`连不上换 Token 的地址（${e instanceof Error ? e.message : String(e)}）。浏览器直连时多半是对方不允许跨域，连上云端后由 Worker 去换`);
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || typeof data.access_token !== 'string') throw new Error(`换 Token 失败（HTTP ${res.status}）：${String(data.error_description ?? data.error ?? '')}`.trim());
  return data;
}

function tokenFrom(base: Omit<McpOAuthToken, 'accessToken'>, data: Record<string, unknown>): McpOAuthToken {
  const expires = typeof data.expires_in === 'number' ? data.expires_in : Number(data.expires_in);
  return {
    ...base,
    accessToken: data.access_token as string,
    ...(typeof data.refresh_token === 'string' ? { refreshToken: data.refresh_token } : base.refreshToken ? { refreshToken: base.refreshToken } : {}),
    ...(Number.isFinite(expires) && expires > 0 ? { expiresAt: Date.now() + expires * 1000 } : {}),
  };
}

/** 用授权码换 Token */
export async function exchangeOAuthCode(
  input: Omit<McpOAuthToken, 'accessToken' | 'refreshToken' | 'expiresAt'> & { code: string; verifier: string; redirectUri: string },
  opts: { fetch?: FetchLike } = {},
): Promise<McpOAuthToken> {
  const { code, verifier, redirectUri, ...base } = input;
  const data = await tokenRequest(base, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri }, opts.fetch ?? defaultFetch);
  return tokenFrom(base, data);
}

/** 用 Refresh Token 换新的（新回复里没给 Refresh Token 就留着旧的） */
export async function refreshOAuthToken(token: McpOAuthToken, opts: { fetch?: FetchLike } = {}): Promise<McpOAuthToken> {
  if (!token.refreshToken) throw new Error('没有 Refresh Token，请重新授权');
  const { accessToken: _a, expiresAt: _e, ...base } = token;
  const data = await tokenRequest(base, { grant_type: 'refresh_token', refresh_token: token.refreshToken }, opts.fetch ?? defaultFetch);
  return tokenFrom(base, data);
}
