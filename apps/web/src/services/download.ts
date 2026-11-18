import { assetUrl } from './assets';

/**
 * 把生成的图片、语音存到这台设备。
 * - 手机上（能分享文件时）弹系统分享，图片可以直接"存储图像"进相册；
 * - 电脑上下载成文件；
 * - 本机清掉了缓存的素材先从云端取回来（assetUrl 会去取）；服务商只给了链接、跨域读不到的，新开一页打开。
 */
export interface SaveTarget {
  /** 本机素材库的 key，或者 data: / blob: / http(s) 链接 */
  key?: string | null;
  url?: string | null;
  /** 文件名（不带扩展名，按类型补） */
  name?: string;
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/ogg': 'ogg', 'audio/webm': 'webm', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
  'video/mp4': 'mp4', 'video/webm': 'webm',
};

function fileName(name: string | undefined, mime: string, i: number): string {
  const base = (name ?? '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `ai-mobile-${new Date().toISOString().slice(0, 10)}${i ? `-${i + 1}` : ''}`;
  const type = mime.split(';')[0]!.trim();
  return `${base}.${EXT[type] ?? type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'}`;
}

/** 取出文件内容；跨域读不到的服务商链接返回 null（交给调用的地方新开一页） */
async function blobOf(t: SaveTarget): Promise<Blob | null | 'external'> {
  const ref = t.key || t.url;
  if (!ref) return null;
  const url = /^(?:https?:|data:|blob:)/.test(ref) ? ref : await assetUrl(ref);
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(String(res.status));
    return await res.blob();
  } catch {
    return /^https?:/.test(url) ? 'external' : null;
  }
}

/** 手机（没有鼠标悬停的触屏）上用系统分享 */
function preferShare(files: File[]): boolean {
  try {
    return matchMedia('(hover: none) and (pointer: coarse)').matches && typeof navigator.canShare === 'function' && navigator.canShare({ files });
  } catch {
    return false;
  }
}

function download(file: File) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}

/** 存这几个；返回 saved：存了几个（分享时是交给系统的），missing：找不到的几个 */
export async function saveFiles(targets: SaveTarget[]): Promise<{ saved: number; missing: number }> {
  const files: File[] = [];
  let missing = 0;
  for (const [i, t] of targets.entries()) {
    const blob = await blobOf(t);
    if (blob === 'external') {
      window.open((t.key || t.url)!, '_blank', 'noopener');
      continue;
    }
    if (!blob) {
      missing++;
      continue;
    }
    files.push(new File([blob], fileName(t.name, blob.type || 'application/octet-stream', i), { type: blob.type }));
  }
  if (!files.length) return { saved: 0, missing };
  if (preferShare(files)) {
    try {
      await navigator.share({ files });
      return { saved: files.length, missing };
    } catch (e) {
      // 取消了分享：不算出错，也不改成下载
      if (e instanceof DOMException && e.name === 'AbortError') return { saved: 0, missing };
      // 等下载等太久、浏览器不让分享了：改成下载
    }
  }
  for (const [i, f] of files.entries()) {
    if (i) await new Promise((r) => setTimeout(r, 400));
    download(f);
  }
  return { saved: files.length, missing };
}
