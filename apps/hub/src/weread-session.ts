/** 一次 MCP 请求里的微信读书会话；接口和阅读器共用，更新后的 Cookie 交回客户端保存。 */
export class WeReadSession {
  private readonly cookies: Map<string, string>;

  constructor(cookie: string) {
    this.cookies = new Map(cookie.split(/;\s*/).filter(Boolean).map((item) => {
      const at = item.indexOf('=');
      return [item.slice(0, at), item.slice(at + 1)];
    }));
  }

  get cookie(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Cookie', this.cookie);
    const response = await fetch(url, { ...init, headers });
    for (const value of response.headers.getSetCookie()) {
      const [pair, ...attributes] = value.split(';').map((part) => part.trim());
      const at = pair!.indexOf('=');
      const name = pair!.slice(0, at);
      const attrs = new Map(attributes.map((part) => {
        const equals = part.indexOf('=');
        return [part.slice(0, equals < 0 ? undefined : equals).toLowerCase(), equals < 0 ? '' : part.slice(equals + 1)];
      }));
      const expired = attrs.has('max-age') ? Number(attrs.get('max-age')) <= 0 : Date.parse(attrs.get('expires') ?? '') <= Date.now();
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, pair!.slice(at + 1));
    }
    return response;
  }
}
