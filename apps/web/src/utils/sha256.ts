/**
 * SHA-256 的十六进制。有 crypto.subtle 时用它；不是安全上下文时没有它（套在 http 中转页里、局域网 http 调试），
 * 用下面的 JS 实现算，结果一样——多设备同步的文件按这个哈希存，下载时还要对一遍，不能换成别的哈希。
 */
export async function sha256Hex(data: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256(bytes);
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** 整块直接从原数据里读（大文件不复制一份），最后不满一块的部分和补位、长度另放一两块 */
function sha256(msg: Uint8Array): Uint8Array {
  const h = new Uint32Array(H0);
  const w = new Uint32Array(64);
  const whole = msg.length - (msg.length % 64);
  const view = new DataView(msg.buffer, msg.byteOffset, msg.byteLength);
  for (let off = 0; off < whole; off += 64) block(h, w, view, off);
  const tail = new Uint8Array(msg.length - whole < 56 ? 64 : 128);
  tail.set(msg.subarray(whole));
  tail[msg.length - whole] = 0x80;
  const tv = new DataView(tail.buffer);
  // 长度按位数写成 64 位大端
  tv.setUint32(tail.length - 8, Math.floor(msg.length / 0x20000000));
  tv.setUint32(tail.length - 4, (msg.length * 8) >>> 0);
  for (let off = 0; off < tail.length; off += 64) block(h, w, tv, off);
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}

/** 压缩一块（64 字节）；Uint32Array 写进去时自动取模 2^32 */
function block(h: Uint32Array, w: Uint32Array, v: DataView, off: number) {
  for (let i = 0; i < 16; i += 1) w[i] = v.getUint32(off + i * 4);
  for (let i = 16; i < 64; i += 1) {
    const x = w[i - 15];
    const y = w[i - 2];
    w[i] = w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10));
  }
  let [a, b, c, d, e, f, g, k] = h;
  for (let i = 0; i < 64; i += 1) {
    const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
    const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
    k = g;
    g = f;
    f = e;
    e = (d + t1) | 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) | 0;
  }
  h[0] += a;
  h[1] += b;
  h[2] += c;
  h[3] += d;
  h[4] += e;
  h[5] += f;
  h[6] += g;
  h[7] += k;
}
