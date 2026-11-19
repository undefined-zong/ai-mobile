const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function digest(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

export async function equalSecret(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

async function key(kek: string) {
  const bytes = decode(kek);
  if (bytes.length !== 32) throw new Error('KEK 必须是 32 字节的 base64 密钥');
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(kek: string, value: unknown) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(kek), new TextEncoder().encode(JSON.stringify(value)));
  return { iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) };
}

export async function unseal<T>(kek: string, value: { iv: string; ciphertext: string }): Promise<T> {
  const bytes = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(value.iv) }, await key(kek), decode(value.ciphertext));
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

const base64url = (bytes: Uint8Array) => encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 随机的密钥（base64url，不带 =），能直接放进网址 */
export function randomKey(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** 签票用的 HMAC 密钥：从 KEK 按用途派生（不同用途的票不能混用，也不和加密用同一把） */
async function ticketKey(kek: string, purpose: string) {
  const base = await crypto.subtle.importKey('raw', decode(kek), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: new TextEncoder().encode(purpose) }, base, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** 短时间有效的票：`内容.过期时间.签名`，放在网址上代替长期的登录信息（WebSocket 带不了 Authorization） */
export async function signTicket(kek: string, purpose: string, value: string, ttlMs: number): Promise<string> {
  if (!/^[\w-]+$/.test(value)) throw new Error('票的内容只能是字母、数字、- 和 _');
  const payload = `${value}.${Date.now() + ttlMs}`;
  const signature = await crypto.subtle.sign('HMAC', await ticketKey(kek, purpose), new TextEncoder().encode(payload));
  return `${payload}.${base64url(new Uint8Array(signature))}`;
}

/** 票没过期、没被改过时返回内容，否则为 null */
export async function verifyTicket(kek: string, purpose: string, ticket: string): Promise<string | null> {
  const m = /^([\w-]+)\.(\d{1,16})\.([\w-]{16,})$/.exec(ticket);
  if (!m || Number(m[2]) < Date.now()) return null;
  let signature: Uint8Array;
  try {
    signature = decode(m[3]!.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (m[3]!.length % 4)) % 4));
  } catch {
    return null;
  }
  const ok = await crypto.subtle.verify('HMAC', await ticketKey(kek, purpose), signature, new TextEncoder().encode(`${m[1]}.${m[2]}`));
  return ok ? m[1]! : null;
}
