import { NeteaseMusic } from '@/services/music';
import { createMusicPlayer } from '@/services/musicPlayer';
import { musicLibrary } from '@/services/musicLibrary';
import { useServicesStore } from '@/stores/services';
import type { ActionResult } from './activities';

export const radioClient = new NeteaseMusic();
export const decorRadio = createMusicPlayer({
  storageKey: 'ai-mobile:decor:radio:v1',
  lyrics: false,
  volume: .65,
  client: radioClient,
});

/** 角色和用户操作的是同一台真实播放器；不以动画代替音乐播放结果。 */
export async function operateRadio(on: boolean, signal: AbortSignal): Promise<ActionResult> {
  if (signal.aborted) return { ok: false, cancelled: true };
  if (!on) { decorRadio.stop(); return { ok: true }; }
  if (!useServicesStore().musicReady) return { ok: false, reason: '收音机需要先连接网易云音乐服务' };
  const stop = () => decorRadio.stop();
  signal.addEventListener('abort', stop, { once: true });
  try {
    if (decorRadio.state.queue.length) await decorRadio.toggle(true);
    else {
      const saved = musicLibrary.lists[0];
      const list = saved?.songs.length ? saved : musicLibrary.liked.length ? { songs: [...musicLibrary.liked], name: '一起喜欢的歌', key: 'liked' } : { ...await radioClient.playlist('3778678'), key: 'playlist:3778678' };
      if (signal.aborted) return { ok: false, cancelled: true };
      if (!list.songs.length) return { ok: false, reason: '歌单里没有可播放的歌曲' };
      await decorRadio.playList(list.songs, 0, { key: list.key, name: list.name });
    }
    if (signal.aborted) return { ok: false, cancelled: true };
    return decorRadio.state.playing ? { ok: true } : { ok: false, reason: decorRadio.state.needsTap ? '点一下收音机的播放键，就能听见音乐' : decorRadio.state.error || '这首歌暂时没有播放成功，可以换一首' };
  } finally { signal.removeEventListener('abort', stop); }
}
