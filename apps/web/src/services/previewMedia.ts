/**
 * Pexels 的视频和封面（出逃、休息的实拍画面）平时直接从 Pexels 播放。
 * 预览页（Claude Artifact，`--mode preview`）只能加载和页面一起发布的文件，外站的视频、图片都会被拦下：
 * 预览时改成同目录下 media/<Pexels 编号>.mp4 / .jpg（发布预览时把用到的几段视频转小一点放进去）。正式版原样返回。
 */
const isPreview = import.meta.env.MODE === 'preview';

export function pexelsMedia(url: string): string {
  if (!isPreview) return url;
  const m = /^https:\/\/(videos|images)\.pexels\.com\/(?:video-files|videos)\/(\d+)\//.exec(url);
  if (!m) return url;
  return `./media/${m[2]}.${m[1] === 'videos' ? 'mp4' : 'jpg'}`;
}
