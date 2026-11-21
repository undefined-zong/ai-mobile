import type { PortraitFit, PortraitSet } from '@app/shared';
import { loadImage, readAsDataUrl, toBase64 } from './image';

/**
 * AI 画立绘用到的图片处理（都在本机 canvas 里做）：看一张图是不是透明底、按透明的轮廓猜脸在哪、
 * 把图改成 NovelAI 收的尺寸（64 的倍数）、画局部重绘的遮罩、把底图垫成精准参考要的尺寸、
 * 立绘框和图片像素之间换算（立绘框的摆法同 PortraitFigure：图底边居中放进框，再按每张图的对齐参数缩放平移）。
 */

export async function decodeImage(blob: Blob): Promise<HTMLImageElement> {
  const img = await loadImage(await readAsDataUrl(blob));
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('图片读不出来');
  return img;
}

function canvasOf(width: number, height: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('浏览器不支持 canvas');
  return { canvas, ctx };
}

async function pngOf(canvas: HTMLCanvasElement): Promise<{ bytes: Uint8Array<ArrayBuffer>; base64: string }> {
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('图片编码失败');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { bytes, base64: toBase64(bytes) };
}

/** 脸在图里的位置：中心和方框边长，都是占图宽 / 图高的比例（size 占图宽） */
export interface FaceGuess {
  x: number;
  y: number;
  size: number;
}

export interface AlphaInfo {
  width: number;
  height: number;
  /** 透明背景：上边、左右两边的上半段基本都是透明的（半身立绘的人被画布下沿截断，下边和两边靠下的地方本来就有人）；和底图比时，底图透明的地方也还是透明的 */
  transparent: boolean;
  /** 按透明的轮廓猜的脸（不是透明底时为空） */
  face: FaceGuess | null;
}

/** 缩到长边 512 读像素（只看透明不透明，够用了） */
async function pixels(blob: Blob, size?: { w: number; h: number }): Promise<{ data: Uint8ClampedArray; w: number; h: number; width: number; height: number }> {
  const img = await decodeImage(blob);
  const scale = Math.min(1, 512 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = size?.w ?? Math.max(1, Math.round(img.naturalWidth * scale));
  const h = size?.h ?? Math.max(1, Math.round(img.naturalHeight * scale));
  const { ctx } = canvasOf(w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return { data: ctx.getImageData(0, 0, w, h).data, w, h, width: img.naturalWidth, height: img.naturalHeight };
}

/** 看透明底时左右两边看到多高（往下就可能是被截断的身子、肩膀） */
const EDGE_SPAN = 0.6;

/** 二次元的头：脸（眉毛到下巴）约占头高（头顶到下巴）的六成，脸的中心在头顶往下约六成处 */
const FACE_OF_HEAD = 0.6;
const FACE_CENTER_IN_HEAD = 0.58;

/**
 * 看一张图是不是透明底，是的话按人的轮廓猜脸：最上面那一截是头（多高看构图：半身的头大、全身的头小，
 * headRatio 是立绘预设里这种构图写的"头占整个人多高"，没写就不猜）。头像框框的是脸（同默认的头像框），不是整个头。
 * 猜的脸只是给头像框一个起点，不对的话在"头像框和戳戳乐热区"里拖。
 * compare 给了（构图一样的底图，例如只重画了脸）：底图透明的地方有一成以上变得不透明了，就算没保住透明底（重画的那块铺上了背景）
 */
export async function alphaInfo(blob: Blob, opts: { headRatio: number | null; compare?: Blob }): Promise<AlphaInfo> {
  const { data, w, h, width, height } = await pixels(blob);
  const alpha = (x: number, y: number) => data[(y * w + x) * 4 + 3] ?? 255;
  // 只看上边和左右两边的上半段：半身立绘的人被画布下沿截断，肩膀、胳膊也可能碰到两边靠下的地方
  let edge = 0;
  let clear = 0;
  const look = (x: number, y: number) => {
    edge++;
    if (alpha(x, y) < 16) clear++;
  };
  for (let x = 0; x < w; x++) look(x, 0);
  for (let y = 1; y < Math.round(h * EDGE_SPAN); y++) {
    look(0, y);
    look(w - 1, y);
  }
  let transparent = edge > 0 && clear / edge >= 0.9;
  if (transparent && opts.compare) {
    const base = await pixels(opts.compare, { w, h });
    let was = 0;
    let filled = 0;
    for (let i = 3; i < data.length; i += 4) {
      if ((base.data[i] ?? 255) >= 16) continue;
      was++;
      if ((data[i] ?? 0) > 200) filled++;
    }
    if (was && filled / was > 0.1) transparent = false;
  }
  if (!transparent || !opts.headRatio) return { width, height, transparent, face: null };
  // 每一行不透明的像素
  const minRun = Math.max(2, Math.round(w * 0.01));
  const rows: number[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = 0; x < w; x++) if (alpha(x, y) > 32) n++;
    rows.push(n);
  }
  const top = rows.findIndex((n) => n >= minRun);
  let bottom = -1;
  for (let y = h - 1; y >= 0; y--) {
    if ((rows[y] ?? 0) >= minRun) {
      bottom = y;
      break;
    }
  }
  if (top < 0 || bottom <= top) return { width, height, transparent, face: null };
  // 半身立绘的人被画布下沿截断，bottom 就是画布底：头占的是画出来的那部分
  const head = (bottom - top) * opts.headRatio;
  // 脸的左右按头那一截（避开头顶的呆毛、耳朵）不透明像素的平均位置
  let sx = 0;
  let count = 0;
  for (let y = Math.round(top + head * 0.3); y <= Math.min(h - 1, Math.round(top + head * 0.9)); y++) {
    for (let x = 0; x < w; x++) {
      if (alpha(x, y) > 32) {
        sx += x;
        count++;
      }
    }
  }
  const cx = count ? sx / count : w / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    width,
    height,
    transparent,
    face: { x: clamp(cx / w, 0.05, 0.95), y: clamp((top + head * FACE_CENTER_IN_HEAD) / h, 0.03, 0.9), size: clamp((head * FACE_OF_HEAD) / w, 0.05, 0.9) },
  };
}

/**
 * 改成 NovelAI 收的样子：PNG，宽高是 64 的倍数；面积超过 maxArea 时按比例缩小（图生图、局部重绘、换表情都要用原图的宽高出图）。
 * background 给了时铺在这个颜色上（不留透明）：局部重绘的模型不认透明，透明的地方给它看什么就不一定了，铺好白底它看到的是干净的白底
 */
export async function novelaiImage(blob: Blob, maxArea: number, opts: { background?: string } = {}): Promise<{ bytes: Uint8Array<ArrayBuffer>; base64: string; width: number; height: number }> {
  const img = await decodeImage(blob);
  const w0 = img.naturalWidth;
  const h0 = img.naturalHeight;
  const s = Math.min(1, Math.sqrt(maxArea / (w0 * h0)));
  const snap = (n: number) => Math.max(64, Math.round(n / 64) * 64);
  const width = snap(w0 * s);
  const height = snap(h0 * s);
  const { canvas, ctx } = canvasOf(width, height);
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);
  return { ...(await pngOf(canvas)), width, height };
}

/** 把一张图拉成指定的宽高（照着底图画的图按 NovelAI 的尺寸回来，拉回底图的宽高，立绘框里的对齐参数才对得上） */
export async function resizeImage(blob: Blob, width: number, height: number): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; width: number; height: number }> {
  const img = await decodeImage(blob);
  if (img.naturalWidth === width && img.naturalHeight === height) return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: blob.type || 'image/png', width, height };
  const { canvas, ctx } = canvasOf(width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return { bytes: (await pngOf(canvas)).bytes, mime: 'image/png', width: canvas.width, height: canvas.height };
}

/** 像素方框 */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 不透明：底图里 alpha 到这个数才算人身上（往下是轮廓边上半透明的、背景） */
const SOLID = 250;

/**
 * 只重画脸画回来以后在本机贴回底图（局部重绘的模型画不出透明底：重画的那块会铺上背景；NovelAI 自己贴回框外时也只按 8 像素的格子对，
 * 框边上会留一圈半透明的条）。所以不用它贴好的整张，只从里面取框里新画的脸：
 * - 框外原样是底图，一像素不动；宽高也是底图的（result 是按 NovelAI 的尺寸画的，整张拉回底图的大小再取）；
 * - 透明按底图的：人的轮廓不变，框里铺上的背景去掉，换表情时不会多出一块方的；
 * - 只换轮廓里面的颜色：轮廓边上几个像素、框的四边都渐变过渡到底图，看不出方框的接缝。
 * rect 是底图像素
 */
export async function mergeInpaint(base: Blob, result: Blob, rect: PixelRect): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string; width: number; height: number }> {
  const img = await decodeImage(base);
  const out = await decodeImage(result);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const { canvas, ctx } = canvasOf(W, H);
  ctx.drawImage(img, 0, 0);
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(W, Math.ceil(rect.x + rect.w));
  const y1 = Math.min(H, Math.ceil(rect.y + rect.h));
  const rw = x1 - x0;
  const rh = y1 - y0;
  if (rw > 0 && rh > 0) {
    const orig = ctx.getImageData(x0, y0, rw, rh);
    // 新画的那块：整张按比例拉回底图大小再取框里的；铺在白底上，万一回来的图带透明，颜色也是实的
    const fresh = canvasOf(rw, rh);
    fresh.ctx.fillStyle = '#ffffff';
    fresh.ctx.fillRect(0, 0, rw, rh);
    const sx = out.naturalWidth / W;
    const sy = out.naturalHeight / H;
    fresh.ctx.drawImage(out, x0 * sx, y0 * sy, rw * sx, rh * sy, 0, 0, rw, rh);
    const next = fresh.ctx.getImageData(0, 0, rw, rh).data;
    const o = orig.data;
    const n = rw * rh;
    // 每个像素离轮廓（底图里不是实心的像素）多远（城市距离，两遍扫）
    const far = rw + rh;
    const dist = new Int32Array(n);
    for (let i = 0; i < n; i++) dist[i] = (o[i * 4 + 3] ?? 0) >= SOLID ? far : 0;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        let d = dist[i] ?? 0;
        if (x > 0) d = Math.min(d, (dist[i - 1] ?? 0) + 1);
        if (y > 0) d = Math.min(d, (dist[i - rw] ?? 0) + 1);
        dist[i] = d;
      }
    }
    for (let y = rh - 1; y >= 0; y--) {
      for (let x = rw - 1; x >= 0; x--) {
        const i = y * rw + x;
        let d = dist[i] ?? 0;
        if (x < rw - 1) d = Math.min(d, (dist[i + 1] ?? 0) + 1);
        if (y < rh - 1) d = Math.min(d, (dist[i + rw] ?? 0) + 1);
        dist[i] = d;
      }
    }
    const side = Math.min(rw, rh);
    const edge = Math.max(2, Math.round(side * 0.02));
    const feather = Math.max(4, Math.round(side * 0.08));
    const ease = (t: number) => {
      const v = Math.min(1, Math.max(0, t));
      return v * v * (3 - 2 * v);
    };
    // 框的四边往里渐变；贴着画布边的那一边外面没有东西，不用过渡
    const left = x0 > 0;
    const top = y0 > 0;
    const right = x1 < W;
    const bottom = y1 < H;
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const i = y * rw + x;
        const d = dist[i] ?? 0;
        if (!d) continue;
        const border = Math.min(left ? x + 0.5 : far, top ? y + 0.5 : far, right ? rw - x - 0.5 : far, bottom ? rh - y - 0.5 : far);
        const w = ease(border / feather) * ease(d / edge);
        if (w <= 0) continue;
        const p = i * 4;
        for (let c = 0; c < 3; c++) o[p + c] = Math.round((o[p + c] ?? 0) * (1 - w) + (next[p + c] ?? 0) * w);
      }
    }
    ctx.putImageData(orig, x0, y0);
  }
  return { bytes: (await pngOf(canvas)).bytes, mime: 'image/png', width: W, height: H };
}

/**
 * 局部重绘的遮罩：和图一样大，黑底，要重画的方框涂白（坐标是像素）。
 * NovelAI 按 8 像素一格（潜空间）重画，方框往外扩到格子上，重画的那块和遮罩对得上、盖得住要换的地方
 */
export async function rectMask(width: number, height: number, rect: PixelRect): Promise<string> {
  const { canvas, ctx } = canvasOf(width, height);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  const g = 8;
  const x0 = Math.max(0, Math.floor(rect.x / g) * g);
  const y0 = Math.max(0, Math.floor(rect.y / g) * g);
  const x1 = Math.min(canvas.width, Math.ceil((rect.x + rect.w) / g) * g);
  const y1 = Math.min(canvas.height, Math.ceil((rect.y + rect.h) / g) * g);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  return (await pngOf(canvas)).base64;
}

/**
 * 精准参考的参考图：铺在白底上（官方建议简单的背景、人在画布上尽量大、参考图的构图和要画的一样——半身的底图照样当半身的参考），
 * 按比例最接近的那种尺寸居中垫好
 */
export async function referenceImage(blob: Blob, canvases: readonly { width: number; height: number }[]): Promise<string> {
  const img = await decodeImage(blob);
  const ratio = img.naturalWidth / img.naturalHeight;
  const target = [...canvases].sort((a, b) => Math.abs(Math.log(a.width / a.height / ratio)) - Math.abs(Math.log(b.width / b.height / ratio)))[0] ?? { width: 1024, height: 1536 };
  const { canvas, ctx } = canvasOf(target.width, target.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, target.width, target.height);
  const s = Math.min(target.width / img.naturalWidth, target.height / img.naturalHeight);
  const dw = img.naturalWidth * s;
  const dh = img.naturalHeight * s;
  ctx.drawImage(img, (target.width - dw) / 2, (target.height - dh) / 2, dw, dh);
  return (await pngOf(canvas)).base64;
}

// —— 立绘框 ↔ 图片像素 ——
// 立绘框按高度算单位：宽 aspect、高 1。图按 contain 放进框、底边居中；再以框的底边中点为原点缩放 zoom、平移 (x·宽, y·高)。

interface Placement {
  /** 每个像素多少（框高的单位） */
  c: number;
  left: number;
  top: number;
  zoom: number;
  tx: number;
  ty: number;
  aspect: number;
}

function placement(aspect: number, width: number, height: number, fit?: PortraitFit): Placement {
  const c = Math.min(aspect / width, 1 / height);
  return { c, left: (aspect - width * c) / 2, top: 1 - height * c, zoom: fit?.zoom || 1, tx: (fit?.x ?? 0) * aspect, ty: fit?.y ?? 0, aspect };
}

/** 头像框（PortraitSet.face）在这张图里是哪一块（像素）：中心和方框边长 */
export function faceInImage(set: Pick<PortraitSet, 'face' | 'aspect'>, img: { width: number; height: number; fit?: PortraitFit }): { cx: number; cy: number; side: number } {
  const p = placement(set.aspect, img.width, img.height, img.fit);
  const ox = p.aspect / 2;
  // 框里的点 → 变换之前的点 → 像素
  const fx = ox + (set.face.x * p.aspect - p.tx - ox) / p.zoom;
  const fy = 1 + (set.face.y - p.ty - 1) / p.zoom;
  return { cx: (fx - p.left) / p.c, cy: (fy - p.top) / p.c, side: (set.face.size * p.aspect) / (p.zoom * p.c) };
}

/**
 * 新画的一张怎么对齐到这个角色的立绘框：让猜到的脸落在头像框上（大小也对上），切换时不跳。
 * 限制在编辑页"对齐"能调的范围里（大小 50%–200%，左右上下 ±50%），猜歪了也不至于离谱，还能再手动对齐
 */
export function alignFit(set: Pick<PortraitSet, 'face' | 'aspect'>, img: { width: number; height: number }, face: FaceGuess): PortraitFit {
  const p = placement(set.aspect, img.width, img.height);
  const zoom = Math.min(2, Math.max(0.5, (set.face.size * p.aspect) / (face.size * img.width * p.c)));
  const ox = p.aspect / 2;
  const px = p.left + face.x * img.width * p.c;
  const py = p.top + face.y * img.height * p.c;
  const tx = set.face.x * p.aspect - ox - zoom * (px - ox);
  const ty = set.face.y - 1 - zoom * (py - 1);
  const round = (n: number) => Math.round(Math.min(0.5, Math.max(-0.5, n)) * 1000) / 1000;
  return { zoom: Math.round(zoom * 1000) / 1000, x: round(tx / p.aspect), y: round(ty) };
}
