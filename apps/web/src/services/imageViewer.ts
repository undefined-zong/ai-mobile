import { reactive } from 'vue';

/**
 * 全屏看图（替代 vant 的 showImagePreview）：一样左右翻、点一下关掉，底下多一个"下载"——
 * 手机上弹系统分享（能存进相册），电脑上下载成文件（components/common/ImageViewer.vue，App.vue 里放一个）。
 * AI 画的图带上 redraw 时还有"重新生成"：同一个画面再画一张，画好换掉（拍的照片不给）。
 */
export interface ViewerImage {
  url: string;
  /** 下载时的文件名（不带扩展名） */
  name?: string;
  /** 对比图的说明，显示在操作按钮上方。 */
  label?: string;
  /** 重画这张：画好返回新图的链接（失败抛出原因） */
  redraw?: () => Promise<string | ViewerImage | null>;
  /** 保留这一张，生成一张关闭 Vibe 的图并排在后面。 */
  compareVibe?: () => Promise<ViewerImage | null>;
}

export const imageViewer = reactive({
  show: false,
  images: [] as ViewerImage[],
  start: 0,
  index: 0,
});

/** 打开看图：images 是链接（blob: / data: / http），或者带文件名的 { url, name } */
export function previewImages(images: (string | ViewerImage)[], opts: { startPosition?: number; name?: string } = {}) {
  const list = images.filter(Boolean).map((i, n) => (typeof i === 'string' ? { url: i, name: opts.name ? `${opts.name}${images.length > 1 ? `-${n + 1}` : ''}` : undefined } : i));
  if (!list.length) return;
  const start = Math.max(0, Math.min(opts.startPosition ?? 0, list.length - 1));
  // 换成一个新的列表（正在重画的上一组画好时不会改到这一组）
  Object.assign(imageViewer, { images: [...list], start, index: start, show: true });
}
