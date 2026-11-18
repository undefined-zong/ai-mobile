import { authorizeUrl, canonicalResource, createPkce, discoverOAuth, exchangeOAuthCode, openMcpSession, registerOAuthClient, type McpOAuthDiscovery, type PlannerOpen } from '@app/ai';
import type { McpOAuthConfig, McpOAuthToken, McpServerConfig, McpServerSecret, McpToolInfo } from '@app/shared';
import { getOne, write } from '@/db/idb';
import { useHubStore } from '@/stores/hub';
import { usePersonaStore } from '@/stores/personas';

/**
 * 日程系统接的 MCP 服务器（设计文档 §9.15）在手机上的这一半：
 * - 密钥只存在本机的 secrets 表：请求头的值（mcp-header:id）、OAuth 的 Client Secret（mcp-client:id）、
 *   没连云端时授权拿到的 Token（mcp-token:id）。连了云端时换 Token 在你的 Worker 里做，Token 不回到手机；
 * - 连了云端：列工具、发现授权服务器、自动注册、换 Token 都让 Worker 去做（浏览器直连多半被跨域拦住）；
 *   没连云端：浏览器直连（对方不允许跨域时会失败，报错里会说）；
 * - OAuth 登录跳到授权页再跳回 App（回调地址是 App 自己的地址），App 打开时接住 ?code=&state=；没跳回来时可以把地址粘贴回来。
 */

const headerKey = (id: string) => `mcp-header:${id}`;
const clientKey = (id: string) => `mcp-client:${id}`;
const tokenKey = (id: string) => `mcp-token:${id}`;
const PENDING_KEY = 'mcp-oauth-pending';

export async function headerValue(id: string): Promise<string> {
  return (await getOne<string>('secrets', headerKey(id))) ?? '';
}
export async function saveHeaderValue(id: string, value: string): Promise<boolean> {
  return value ? write('secrets', [{ key: headerKey(id), value }]) : write('secrets', [], [headerKey(id)]);
}
export async function clientSecret(id: string): Promise<string> {
  return (await getOne<string>('secrets', clientKey(id))) ?? '';
}
export async function saveClientSecret(id: string, value: string): Promise<boolean> {
  return value ? write('secrets', [{ key: clientKey(id), value }]) : write('secrets', [], [clientKey(id)]);
}
export async function localToken(id: string): Promise<McpOAuthToken | null> {
  return (await getOne<McpOAuthToken>('secrets', tokenKey(id))) ?? null;
}
export async function saveLocalToken(id: string, token: McpOAuthToken | null): Promise<boolean> {
  return token ? write('secrets', [{ key: tokenKey(id), value: JSON.parse(JSON.stringify(token)) as McpOAuthToken }]) : write('secrets', [], [tokenKey(id)]);
}
/** 删掉一台服务器在本机的所有密钥 */
export async function forgetServer(id: string): Promise<void> {
  await write('secrets', [], [headerKey(id), clientKey(id), tokenKey(id)]);
}

/** 本机这一份密钥（本机直连、上传云端用）；没填 / 没授权时为空 */
export async function localSecret(server: McpServerConfig): Promise<McpServerSecret | null> {
  if (!server.url) return null;
  if (server.auth === 'none') return { url: server.url };
  if (server.auth === 'header') {
    const value = await headerValue(server.id);
    return value ? { url: server.url, headers: { [server.headerName || 'Authorization']: value } } : null;
  }
  const token = await localToken(server.id);
  return token ? { url: server.url, oauth: token } : null;
}

/** 云端能用吗（连着、Worker 是新版） */
async function cloud() {
  const hub = useHubStore();
  if (!hub.connected) return null;
  await hub.ensureStatus();
  return hub.supportsPlanner ? hub : null;
}

/** 本机直连（没连云端时排计划用）：刷新到的新 Token 存回本机 */
export function localOpener(signal?: AbortSignal): PlannerOpen {
  return async (server) =>
    openMcpSession(server, await localSecret(server), {
      signal,
      onUpdate: async (s) => {
        if (s.oauth) await saveLocalToken(server.id, s.oauth);
      },
    });
}

/** 列出这台服务器的工具：连了云端时让 Worker 去连（先把本机这一份密钥传上去），没连时本机直连 */
export async function listServerTools(server: McpServerConfig): Promise<McpToolInfo[]> {
  const hub = await cloud();
  if (hub) {
    if (server.auth === 'header' || server.authorized?.via === 'device') await hub.pushMcpSecret(server);
    return hub.plannerTools(server);
  }
  const session = await localOpener(AbortSignal.timeout(60_000))(server);
  await session.close();
  return session.tools;
}

/** 发现授权服务器（OAuth 的授权地址、换 Token 的地址、支持的权限） */
export async function discover(url: string): Promise<McpOAuthDiscovery> {
  const hub = await cloud();
  return hub ? hub.oauthDiscover(url) : discoverOAuth(url);
}

/** App 自己的地址：OAuth 授权完跳回来的地方（要加进 OAuth Client 的回调地址里） */
export function redirectUri(): string {
  return `${location.origin}${location.pathname}`;
}

interface Pending {
  personaId: string;
  serverId: string;
  url: string;
  state: string;
  verifier: string;
  redirectUri: string;
  tokenEndpoint: string;
  clientId: string;
  authMethod: McpOAuthConfig['authMethod'];
  resource?: string;
  at: number;
}

/** 按发现的结果补上 OAuth 设置里空着的（填过的不动） */
export function applyDiscovery(server: McpServerConfig, d: McpOAuthDiscovery): void {
  const o: McpOAuthConfig = server.oauth ?? { authorizationEndpoint: '', tokenEndpoint: '', clientId: '', scope: '', extraParams: '', resource: true, authMethod: 'post' };
  o.issuer = d.issuer;
  o.authorizationEndpoint = d.authorizationEndpoint;
  o.tokenEndpoint = d.tokenEndpoint;
  if (d.registrationEndpoint) o.registrationEndpoint = d.registrationEndpoint;
  else delete o.registrationEndpoint;
  if (!o.scope) o.scope = d.scope ?? d.scopesSupported.join(' ');
  if (d.authMethods.length && !d.authMethods.includes(o.authMethod === 'basic' ? 'client_secret_basic' : o.authMethod === 'post' ? 'client_secret_post' : 'none')) {
    o.authMethod = d.authMethods.includes('client_secret_post') ? 'post' : d.authMethods.includes('client_secret_basic') ? 'basic' : o.authMethod;
  }
  server.oauth = o;
}

/** 开始 OAuth 登录：缺的设置先发现、没有 Client ID 时自动注册，然后跳到授权页 */
export async function startOAuth(personaId: string, server: McpServerConfig): Promise<void> {
  if (!server.url) throw new Error('先填 MCP 地址');
  if (!server.oauth?.authorizationEndpoint || !server.oauth.tokenEndpoint) applyDiscovery(server, await discover(server.url));
  const o = server.oauth!;
  const redirect = redirectUri();
  if (!o.clientId) {
    if (!o.registrationEndpoint) throw new Error('这个授权服务器不支持自动注册：要自己建一个 OAuth Client，填上 Client ID（和 Secret）');
    const hub = await cloud();
    const input = { redirectUri: redirect, clientName: 'AI 陪伴 · 日程系统', scope: o.scope || undefined };
    const reg = hub ? await hub.oauthRegister({ registrationEndpoint: o.registrationEndpoint, ...input }) : await registerOAuthClient(o.registrationEndpoint, input);
    o.clientId = reg.clientId;
    o.registered = true;
    o.authMethod = reg.authMethod;
    await saveClientSecret(server.id, reg.clientSecret ?? '');
  }
  const pkce = await createPkce();
  const resource = o.resource ? canonicalResource(server.url) : undefined;
  const pending: Pending = {
    personaId,
    serverId: server.id,
    url: server.url,
    state: pkce.state,
    verifier: pkce.verifier,
    redirectUri: redirect,
    tokenEndpoint: o.tokenEndpoint,
    clientId: o.clientId,
    authMethod: (await clientSecret(server.id)) ? o.authMethod : 'none',
    ...(resource ? { resource } : {}),
    at: Date.now(),
  };
  const personas = usePersonaStore();
  const persona = personas.byId(personaId);
  if (persona) personas.touch(persona);
  // 页面要跳走了：自动注册来的 Client ID 这些先写进本机
  await personas.flush();
  if (!(await write('settings', [{ key: PENDING_KEY, value: pending }]))) throw new Error('本机存储写不进去，没法登录');
  location.href = authorizeUrl({ authorizationEndpoint: o.authorizationEndpoint, clientId: o.clientId, redirectUri: redirect, challenge: pkce.challenge, state: pkce.state, scope: o.scope, resource, extraParams: o.extraParams });
}

/** 这个地址是不是 OAuth 跳回来的（带 code 或 error 和 state） */
export function isOAuthReturn(href: string): boolean {
  try {
    const p = new URL(href).searchParams;
    return p.has('state') && (p.has('code') || p.has('error'));
  } catch {
    return false;
  }
}

/**
 * 接住跳回来的授权码，换成 Token：连了云端时在 Worker 里换、直接存在云端；没连时本机换、存在本机。
 * 返回授权的是哪个人设、哪台服务器（跳回那个人设的日程系统页）
 */
export async function finishOAuth(href: string): Promise<{ personaId: string; serverId: string }> {
  const params = new URL(href).searchParams;
  const pending = await getOne<Pending>('settings', PENDING_KEY);
  if (!pending) throw new Error('没有正在进行的授权（可能已经完成了，或者是在另一个浏览器里开始的）');
  if (params.get('state') !== pending.state) throw new Error('授权的 state 对不上，请重新授权');
  const error = params.get('error');
  if (error) {
    await write('settings', [], [PENDING_KEY]);
    throw new Error(`授权没成功：${params.get('error_description') ?? error}`);
  }
  const code = params.get('code') ?? '';
  const persona = usePersonaStore().byId(pending.personaId);
  const server = persona?.planner?.servers.find((s) => s.id === pending.serverId);
  if (!persona || !server) throw new Error('授权的服务器已经删掉了');
  const secret = await clientSecret(server.id);
  const base = { tokenEndpoint: pending.tokenEndpoint, clientId: pending.clientId, authMethod: pending.authMethod, ...(secret ? { clientSecret: secret } : {}), ...(pending.resource ? { resource: pending.resource } : {}) };
  const hub = await cloud();
  if (hub) {
    await hub.oauthToken({ ...base, serverId: server.id, url: pending.url, code, verifier: pending.verifier, redirectUri: pending.redirectUri });
    await saveLocalToken(server.id, null);
    server.authorized = { via: 'hub', at: Date.now() };
  } else {
    const token = await exchangeOAuthCode({ ...base, code, verifier: pending.verifier, redirectUri: pending.redirectUri });
    await saveLocalToken(server.id, token);
    server.authorized = { via: 'device', at: Date.now() };
  }
  usePersonaStore().touch(persona);
  await write('settings', [], [PENDING_KEY]);
  return { personaId: persona.id, serverId: server.id };
}
