import { getOne, write, writeOrThrow } from '@/db/idb';
import { uid } from '@/utils/id';

/**
 * 本机素材库：生成的配图、语音按内容哈希存在 IndexedDB 的 assets 表，消息里只记 key。
 * 连着云端时按同一个哈希传进同步用的大文件（同一个文件只传一次）；图片缓存会清掉本机很久没用的，用到时再从云端取。
 */

interface StoredAsset {
  mime: string;
  data: ArrayBuffer;
  createdAt: number;
}

const urls = new Map<string, string>();

/** 用到了一张图（显示、播放、存进来）：图片缓存记下哪天用过（services/assetCache 设置） */
let onUse: ((key: string) => void) | null = null;
export function setAssetUseHook(fn: (key: string) => void) {
  onUse = fn;
}
const noteAssetUse = (key: string) => onUse?.(key);

/** SHA-256 内容哈希；不是安全上下文（局域网 http 调试）时没有 crypto.subtle，退回随机 id */
async function contentKey(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  try {
    if (crypto.subtle) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }
  } catch {
    // 退回随机 id
  }
  return uid('asset');
}

/**
 * 存一份素材，返回它的 key。存不进本机库时（存储满了、数据库连接断了）重试一次，还不行就报错：
 * 以前写失败也照样返回 key、图放在内存里显示——这台设备看着有图，库里却没有，也不会进发件箱，
 * 别的设备永远拿不到，重新打开 App 后这台也没了
 */
export async function putAsset(bytes: Uint8Array<ArrayBuffer>, mime: string): Promise<string> {
  const key = await contentKey(bytes);
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const value = { mime, data, createdAt: Date.now() } satisfies StoredAsset;
  try {
    await writeOrThrow('assets', [{ key, value }]);
  } catch {
    // 数据库连接断了时 open() 会重新连
    try {
      await writeOrThrow('assets', [{ key, value }]);
    } catch (e) {
      const why = e instanceof Error ? `${e.name && e.name !== 'Error' ? `${e.name}：` : ''}${e.message}` : String(e);
      throw new Error(`图片存不进这台设备的本机存储（${why}）`);
    }
  }
  noteAssetUse(key);
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(new Blob([bytes], { type: mime })));
  return key;
}

export async function assetUrl(key: string): Promise<string | null> {
  const cached = urls.get(key);
  if (cached) {
    noteAssetUse(key);
    return cached;
  }
  // 本机没有（图片缓存清掉了、别的设备刚同步过来）时 getOne 会去云端取
  const a = await getOne<StoredAsset>('assets', key);
  if (!a) return null;
  noteAssetUse(key);
  const url = URL.createObjectURL(new Blob([a.data], { type: a.mime }));
  urls.set(key, url);
  return url;
}

/** 删掉一份素材（调用的地方确认没有别处再用它） */
export async function dropAsset(key: string): Promise<void> {
  const url = urls.get(key);
  if (url) URL.revokeObjectURL(url);
  urls.delete(key);
  await write('assets', [], [key]);
}
