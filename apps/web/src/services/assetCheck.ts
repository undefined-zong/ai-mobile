import { closeToast, showDialog, showLoadingToast } from 'vant';
import { checkAsset } from '@/services/sync';
import { copyWithToast } from '@/utils/errors';

/**
 * 同步检查：这张图在这台设备和云端各是什么状态，弹窗告诉你卡在哪一步（可以复制）。
 * 别的设备画的图这里显示不出来、或者这台设备画的图别的设备看不到时用；云端有、本机没有时顺手取回来
 */
export async function showAssetCheck(key: string): Promise<void> {
  showLoadingToast({ message: '正在检查…', forbidClick: true, duration: 0 });
  let text: string;
  let title: string;
  try {
    const r = await checkAsset(key);
    title = r.verdict;
    text = r.lines.join('\n');
  } catch (e) {
    title = '检查没做完';
    text = e instanceof Error ? e.message : String(e);
  } finally {
    closeToast();
  }
  await showDialog({
    title: '同步检查',
    message: `${title}\n\n${text}`,
    messageAlign: 'left',
    className: 'error-dialog',
    showCancelButton: true,
    cancelButtonText: '关闭',
    confirmButtonText: '复制',
  })
    .then(() => copyWithToast(`${title}\n${text}`))
    .catch(() => undefined);
}
