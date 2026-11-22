import { lrcIndexAt, parseLrc, type LrcLine } from '@app/shared';
import { reactive } from 'vue';
import { platform } from '@/pwa';
import { acquireAudioContext, playbackSession, resumeAudioContext, type AudioContextLease } from './audio';
import { services } from './index';
import type { MusicClient, SongInfo } from './types';

/**
 * 网易云的播放器（同 SleepTogether 的网易云面板：播放器放在模块里）。一起听歌、哄睡、共同的家、健身、陪伴学习、一起吃饭的音乐各用一个，播放列表各存各的：
 * - 一起听歌（player 等导出）：离开"一起听歌"这一页时停（ScenePage 的 leaveScene；去聊天、打电话也算离开）；
 * - 哄睡的音乐（sleepMusic）：离开哄睡这一页时停；不取歌词；她说话时压低（duck），定时到点慢慢变小（fadeOut）；
 * - 歌曲地址播放前现取（约 20 分钟过期），播放出错先重取一次地址接着放，还不行就跳下一首；
 * - 播放列表、播放模式记在本机，下次打开还在（不自动播放）；
 * - 锁屏 / 通知栏的播放控制（Media Session）；iPhone 静音键打开时也有声（audioSession = playback）。
 * - 音量 = 你调的音量 × 压低 × 渐弱，调的是这首歌自己的音量，不碰系统音量。iPhone 不让网页改 <audio>.volume：
 *   在 iPhone 上音量 100% 时照常用 <audio> 放（省电、不受页面卡顿影响），不是 100%（拖了音量、她说话时压低、定时渐弱）
 *   才把歌接进 Web Audio，用一个增益节点调（见下面的 elementVolumeLocked）。
 * 没填网易云 Worker 时是演示：虚构的歌、不出声，进度按时间走。
 */

export type PlayMode = 'list' | 'single' | 'shuffle';

/** 播放列表是从哪个歌单来的（哄睡里显示"正在放：睡前钢琴"，再点同一个歌单是接着放） */
export interface QueueSource {
  key: string;
  name: string;
}

export interface PlayerState {
  queue: SongInfo[];
  index: number;
  mode: PlayMode;
  /** 换列表时带上的歌单；搜歌、加歌拼出来的列表是 null */
  source: QueueSource | null;
  playing: boolean;
  /** 正在取播放地址 */
  loading: boolean;
  posMs: number;
  durationMs: number;
  /** 最近一次出错（地址取不到、播放失败） */
  error: string;
  lines: LrcLine[];
  lyricState: 'idle' | 'loading' | 'ok' | 'none' | 'error';
  /** 演示：不出声 */
  demo: boolean;
  /** 实际拿到的音质 */
  level: string;
  /** 你调的音量 0–1（压低、渐弱在这上面再乘） */
  volume: number;
  /** 被浏览器拦了自动播放，要点一下播放 */
  needsTap: boolean;
  /** 定时到点，正在慢慢变小 */
  fading: boolean;
}

export type PlayerEvent = { kind: 'track'; song: SongInfo } | { kind: 'seek' } | { kind: 'stop' };

export interface PlayerOptions {
  /** A scene may require a real service instead of the shared demo fallback. */
  client?: MusicClient;
  /** 播放列表、播放模式、音量存在本机的哪一项 */
  storageKey: string;
  /** 取不取歌词（哄睡不显示歌词，不取） */
  lyrics: boolean;
  /** 第一次用时的音量 */
  volume?: number;
}

/** 她说话时音乐压到多少 */
const DUCK_LEVEL = 0.35;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 解锁 <audio> 用的一小段静音 */
const SILENT_WAV = 'data:audio/wav;base64,UklGRiYAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQIAAAAAAA==';

/**
 * <audio>.volume 改不了的设备：iPhone、iPad（改了读出来是新值，下一刻又变回去，声音不变），别的设备也试一下。
 * 这些设备上音量不是 100% 时歌接进 Web Audio，后面接一个增益节点调这首歌的音量。接进去要求音频地址允许跨域：
 * 网易云的音频 CDN（m7 / m8 / m10 / m701 / m801.music.126.net）都回 access-control-allow-origin: *。
 * 锁屏接着放靠 audioSession = playback（iOS 17 起 Web Audio 也算播放，不算环境音）。
 * 用的 AudioContext 要在设好 playback 会话之后才建（acquireAudioContext）：先建好再改会话的，iPhone 上放着却没声音。
 */
let elementVolumeLocked = platform() === 'ios';
try {
  const probe = new Audio();
  probe.volume = 0.5;
  if (probe.volume !== 0.5) elementVolumeLocked = true;
  else
    setTimeout(() => {
      if (probe.volume !== 0.5) elementVolumeLocked = true;
    }, 0);
} catch {
  // 没有 <audio> 的环境：也放不了歌
}

/** 这个音频地址是不是不让跨域（不让的话接进 Web Audio 就放不出来）：跨域取两个字节取不到、不跨域取得到 */
async function corsBlocked(src: string): Promise<boolean> {
  const get = (mode: RequestMode) => fetch(src, { mode, headers: { Range: 'bytes=0-1' }, signal: AbortSignal.timeout?.(8000) });
  try {
    const res = await get('cors');
    void res.body?.cancel().catch(() => undefined);
    return false;
  } catch {
    try {
      await get('no-cors');
      return true;
    } catch {
      return false;
    }
  }
}

function readSaved(key: string, fallbackVolume: number): Pick<PlayerState, 'queue' | 'index' | 'mode' | 'source' | 'volume'> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<PlayerState> | null;
    if (v && Array.isArray(v.queue)) {
      const index = typeof v.index === 'number' && v.index < v.queue.length ? v.index : -1;
      const mode = v.mode === 'single' || v.mode === 'shuffle' ? v.mode : 'list';
      const s = v.source;
      const source = s && typeof s.key === 'string' && typeof s.name === 'string' ? { key: s.key, name: s.name } : null;
      const volume = typeof v.volume === 'number' && v.volume >= 0 && v.volume <= 1 ? v.volume : fallbackVolume;
      return { queue: v.queue, index, mode, source, volume };
    }
  } catch {
    // 读不出来就从空的开始
  }
  return { queue: [], index: -1, mode: 'list', source: null, volume: fallbackVolume };
}

export function createMusicPlayer(opts: PlayerOptions) {
  const client = () => opts.client ?? services.music;
  const player = reactive<PlayerState>({
    ...readSaved(opts.storageKey, opts.volume ?? 1),
    playing: false,
    loading: false,
    posMs: 0,
    durationMs: 0,
    error: '',
    lines: [],
    lyricState: 'idle',
    demo: false,
    level: '',
    needsTap: false,
    fading: false,
  });

  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(
          opts.storageKey,
          JSON.stringify({ queue: player.queue.slice(0, 300), index: player.index, mode: player.mode, source: player.source, volume: player.volume }),
        );
      } catch {
        // 存不了也不影响播放
      }
    }, 400);
  }

  function current(): SongInfo | null {
    return player.index >= 0 ? (player.queue[player.index] ?? null) : null;
  }

  /** 现在唱到第几行 */
  function lyricIndex(): number {
    return lrcIndexAt(player.lines, player.posMs);
  }

  // —— <audio> ——

  let audio: HTMLAudioElement | null = null;
  /** 接进 Web Audio 时这首歌的音量节点（<audio>.volume 改不了的设备上、音量不是 100% 时才接） */
  let gain: GainNode | null = null;
  /** 碰到过不让跨域的音频地址、或者不支持网页音频：这个播放器之后不接 Web Audio（这时 iPhone 上音量只归侧面的按键） */
  let unrouted = false;
  /** <audio>.volume 改不了的设备上借着的 AudioContext（连带 playback 会话）：点播放时借、停下时还，没接进去时挂着不跑 */
  let lease: AudioContextLease | null = null;
  /** 正在等 AudioContext 跑起来再接进去 */
  let routing = false;
  /**
   * 在点击里解锁好的普通 <audio>：接进 Web Audio 的拿不出来，音量回到 100% 后换歌时换成它；
   * 碰到不让跨域的地址也换它接着放。iPhone 上新建的 <audio> 要再点一下才能出声
   */
  let spare: HTMLAudioElement | null = null;
  let primed = false;
  let url = '';
  let expiresAt = 0;
  let retried = false;
  let token = 0;
  let releaseSession: (() => void) | null = null;
  let demoTimer: ReturnType<typeof setInterval> | undefined;
  /** 这一次听了哪些歌（离开时记进聊天） */
  const played: string[] = [];
  const listeners = new Set<(e: PlayerEvent) => void>();

  /** 换歌、拖进度、停下时通知（场景里排她的弹幕用） */
  function onPlayerEvent(cb: (e: PlayerEvent) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }
  function emit(e: PlayerEvent) {
    for (const cb of listeners) cb(e);
  }

  // —— 音量：你调的音量 × 压低 × 渐弱 ——

  let duckGain = 1;
  let duckTarget = 1;
  let duckTimer: ReturnType<typeof setInterval> | undefined;
  let fadeGain = 1;
  let fadeTimer: ReturnType<typeof setInterval> | undefined;
  let fadeDone: (() => void) | null = null;

  /** 现在该有的音量：你调的 × 压低 × 渐弱 */
  const level = () => clamp01(player.volume * duckGain * fadeGain);

  /** iPhone 这类改不了 <audio>.volume 的设备上，还能不能接进 Web Audio 调音量 */
  const canRoute = () => elementVolumeLocked && !unrouted;

  function applyVolume() {
    const v = level();
    if (gain) {
      // 几十毫秒里滑过去：拖滑块、压低时不咔哒
      const t = gain.context.currentTime;
      gain.gain.cancelScheduledValues(t);
      gain.gain.setTargetAtTime(v, t, 0.015);
    } else if (audio) {
      audio.volume = v;
      // iPhone 上 <audio>.volume 不管用：音量不是 100% 才接进 Web Audio
      if (v < 1) void route(audio);
    }
  }

  /**
   * 把正在用的 <audio> 接进 Web Audio，后面接增益节点调音量（改不了 <audio>.volume、音量不是 100% 时）。
   * AudioContext 在点播放时已经借好、跑起来过（prime），这里恢复它不用再点；等它跑起来再接，接上那一刻声音就改走它，没跑会断一下
   */
  async function route(a: HTMLAudioElement): Promise<void> {
    const l = lease;
    // 没按跨域取的 <audio> 接进去没声（这台设备是后来才检测出改不了音量的）：不接
    if (!canRoute() || !l || gain || routing || a.crossOrigin !== 'anonymous') return;
    routing = true;
    l.setActive(true);
    const ctx = l.ctx;
    if (ctx.state !== 'running') await ctx.resume().catch(() => undefined);
    routing = false;
    // 等的时候换了 <audio>、停了、音量回到 100%，或者 AudioContext 没跑起来：这次不接（下次调音量再试）
    if (a !== audio || lease !== l || gain || ctx.state !== 'running' || level() >= 1) {
      if (!gain) l.setActive(false);
      return;
    }
    try {
      const g = ctx.createGain();
      g.gain.value = level();
      ctx.createMediaElementSource(a).connect(g).connect(ctx.destination);
      gain = g;
    } catch {
      l.setActive(false);
    }
  }

  /** 换掉现在的 <audio>（接进 Web Audio 的再也不能直接出声）：断开增益节点、AudioContext 挂起，下次 el() 换新的 */
  function dropAudio() {
    const old = audio;
    if (gain) {
      gain.disconnect();
      lease?.setActive(false);
    }
    gain = null;
    audio = null;
    primed = false;
    if (old) {
      old.pause();
      old.removeAttribute('src');
      old.load();
    }
  }

  /** 还回 AudioContext：不还的话 iPhone 的音频会话一直占着（别的 App 的音乐接不回来） */
  function releaseLease() {
    lease?.release();
    lease = null;
  }

  /** 在点击里解锁一个备用的普通 <audio>（只在能接进 Web Audio 的设备上需要） */
  function unlockSpare() {
    if (spare || !canRoute()) return;
    const s = new Audio();
    s.preload = 'auto';
    s.setAttribute('playsinline', '');
    s.muted = true;
    s.src = SILENT_WAV;
    spare = s;
    s.play()
      .then(() => {
        if (s !== audio) s.pause();
        s.muted = false;
      })
      .catch(() => {
        s.muted = false;
        if (spare === s) spare = null;
      });
  }

  /** 现在放的是不是真的歌（不是解锁用的那段静音，也不是换下来的旧 <audio>） */
  function isSong(a: HTMLAudioElement): boolean {
    return a === audio && !!url && a.src === url;
  }

  function el(): HTMLAudioElement {
    if (audio) return audio;
    // 先用点击里解锁好的备用 <audio>：iPhone 上新建的要再点一下才能出声
    const a = spare ?? new Audio();
    primed = a === spare;
    spare = null;
    a.preload = 'auto';
    a.setAttribute('playsinline', '');
    // 以后可能接进 Web Audio（音量不是 100% 时）：跨域的音频要在设地址之前就按跨域取，不然接进去没声
    if (canRoute()) a.crossOrigin = 'anonymous';
    else a.removeAttribute('crossorigin');
    a.volume = level();
    // 解锁用的静音片段也会触发这些事件（而且一放就完）：只认真的歌
    a.addEventListener('timeupdate', () => {
      if (!player.demo && isSong(a)) player.posMs = Math.round(a.currentTime * 1000);
    });
    a.addEventListener('loadedmetadata', () => {
      if (isSong(a) && Number.isFinite(a.duration) && a.duration > 0) player.durationMs = Math.round(a.duration * 1000);
    });
    a.addEventListener('play', () => {
      if (!isSong(a)) return;
      player.playing = true;
      player.needsTap = false;
      releaseSession ??= playbackSession();
      setMediaState('playing');
    });
    a.addEventListener('pause', () => {
      if (!isSong(a)) return;
      player.playing = false;
      setMediaState('paused');
    });
    a.addEventListener('ended', () => {
      if (!isSong(a)) return;
      if (player.mode === 'single') {
        a.currentTime = 0;
        void a.play().catch(() => undefined);
        emit({ kind: 'seek' });
      } else void next();
    });
    a.addEventListener('error', () => a === audio && void onAudioError());
    audio = a;
    return a;
  }

  /**
   * 在点击里调用：iPhone 上只有在用户点过之后"解锁"过的 <audio> 才能在网络请求之后播放。
   * 先用一段静音放一下，等取到歌曲地址再换成真的。
   * 改不了 <audio>.volume 的设备：顺手借好 AudioContext（先设好 playback 会话再建，在点击里跑起来一次就挂着），
   * 之后拖音量、她说话时压低、定时渐弱要接进 Web Audio 时不用再点；接进去的被挂起了（切后台、来电）也在这里恢复
   */
  function prime() {
    if (player.demo) return;
    const a = el();
    if (canRoute()) {
      if (!lease) {
        try {
          lease = acquireAudioContext('playback', false);
        } catch {
          // 不支持网页音频：音量只归侧面的按键
          unrouted = true;
        }
      }
      resumeAudioContext();
      unlockSpare();
    }
    if (primed) return;
    primed = true;
    if (a.src) return;
    a.muted = true;
    a.src = SILENT_WAV;
    a.play()
      .then(() => {
        // 这期间可能已经换成真的歌了：那就别停
        if (!isSong(a)) a.pause();
        a.muted = false;
      })
      .catch(() => {
        a.muted = false;
        primed = false;
      });
  }

  async function onAudioError() {
    const song = current();
    if (!song || player.demo || !url) return;
    const mine = token;
    // 地址过期或者临时出错：重取一次地址，从刚才的位置接着放
    if (!retried) {
      retried = true;
      const at = player.posMs;
      try {
        const r = await client().resolve(song.id);
        if (mine !== token) return;
        url = r.url;
        expiresAt = r.expiresAt;
        const a = el();
        a.src = url;
        a.currentTime = at / 1000;
        await a.play();
        return;
      } catch {
        // 落到下面
      }
    }
    if (mine !== token) return;
    // 能接进 Web Audio 的设备上 <audio> 都按跨域取：可能只是这个地址不让跨域，是的话换成不按跨域取的 <audio> 接着放
    if (canRoute() && (await corsBlocked(url))) {
      if (mine === token && !unrouted) await playUnrouted(mine);
      return;
    }
    if (mine !== token) return;
    player.error = `《${song.title}》放不出来（地址失效或者被限制），跳到下一首`;
    player.playing = false;
    if (player.queue.length > 1) setTimeout(() => mine === token && void next(), 1200);
  }

  /** 不接 Web Audio 了：换一个不按跨域取的普通 <audio>（有解锁好的备用就用它），从刚才的位置接着放这首 */
  async function playUnrouted(mine: number) {
    unrouted = true;
    dropAudio();
    releaseLease();
    const a = el();
    a.src = url;
    a.currentTime = player.posMs / 1000;
    try {
      await a.play();
    } catch (e) {
      // 新的 <audio> 还没在点击里解锁过（iPhone）：要点一下播放；别的错误由 onAudioError 接着处理
      if (mine === token && (e as DOMException)?.name === 'NotAllowedError') {
        player.needsTap = true;
        player.playing = false;
      }
    }
  }

  // —— 锁屏控制 ——

  function setMediaState(state: 'playing' | 'paused' | 'none') {
    try {
      if ('mediaSession' in navigator) navigator.mediaSession.playbackState = state;
    } catch {
      // 不支持就算了
    }
  }

  function setMediaMetadata(song: SongInfo) {
    try {
      if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
      navigator.mediaSession.metadata = new MediaMetadata({
        title: song.title,
        artist: song.artist,
        album: song.album ?? '',
        artwork: song.cover ? [{ src: song.cover, sizes: '512x512' }] : [],
      });
      const ms = navigator.mediaSession;
      ms.setActionHandler('play', () => void toggle(true));
      ms.setActionHandler('pause', () => void toggle(false));
      ms.setActionHandler('previoustrack', () => void prev());
      ms.setActionHandler('nexttrack', () => void next());
      ms.setActionHandler('seekto', (d) => typeof d.seekTime === 'number' && seek(d.seekTime * 1000));
    } catch {
      // 有的浏览器不认某些动作
    }
  }

  // —— 演示（不出声，进度按时间走） ——

  function startDemoClock() {
    clearInterval(demoTimer);
    demoTimer = setInterval(() => {
      if (!player.playing || !player.demo) return;
      player.posMs += 250;
      if (player.durationMs && player.posMs >= player.durationMs) {
        player.posMs = 0;
        if (player.mode !== 'single') void next();
        else emit({ kind: 'seek' });
      }
    }, 250);
  }

  // —— 歌词 ——

  async function loadLyrics(song: SongInfo, mine: number) {
    player.lines = [];
    if (!opts.lyrics) {
      player.lyricState = 'idle';
      return;
    }
    player.lyricState = 'loading';
    try {
      const { lrc, tlyric } = await client().lyric(song.id);
      if (mine !== token) return;
      const lines = parseLrc(lrc, tlyric);
      player.lines = lines;
      player.lyricState = lines.length ? 'ok' : 'none';
    } catch {
      if (mine === token) player.lyricState = 'error';
    }
  }

  // —— 播放控制 ——

  /** 放第 i 首：取地址（演示不取）→ 播放 → 取歌词 */
  async function playAt(i: number): Promise<void> {
    const song = player.queue[i];
    if (!song) return;
    const mine = ++token;
    player.index = i;
    player.error = '';
    player.posMs = 0;
    player.durationMs = song.durationMs;
    player.level = '';
    player.demo = !client().ready;
    retried = false;
    persist();
    setMediaMetadata(song);
    if (!played.includes(song.title)) played.push(song.title);
    emit({ kind: 'track', song });
    void loadLyrics(song, mine);
    if (player.demo) {
      audio?.pause();
      player.playing = true;
      startDemoClock();
      return;
    }
    clearInterval(demoTimer);
    player.loading = true;
    // 接进 Web Audio 的、音量已经回到 100%：换歌时换回普通 <audio>（有解锁好的备用才换，iPhone 上新建的放不出来）
    if (gain && spare && level() >= 1) dropAudio();
    const a = el();
    a.pause();
    try {
      const r = await client().resolve(song.id);
      if (mine !== token) return;
      url = r.url;
      expiresAt = r.expiresAt;
      player.level = r.level ?? '';
      a.src = url;
      // 音量不是 100%：先接进 Web Audio 再放，免得开头一下子是满音量
      if (level() < 1) await route(a);
      if (mine !== token) return;
      applyVolume();
      try {
        await a.play();
      } catch (e) {
        if (mine !== token) return;
        if ((e as DOMException)?.name === 'NotAllowedError') {
          player.needsTap = true;
          player.playing = false;
        } else if (!a.error) throw e;
        // 音频加载失败（a.error）：交给 onAudioError（重取地址、不让跨域时换不按跨域取的、还不行跳下一首），这里不再跳
      }
    } catch (e) {
      if (mine !== token) return;
      player.playing = false;
      player.error = e instanceof Error ? e.message : String(e);
      // 这首拿不到地址：几秒后自动跳下一首，免得卡住
      if (player.queue.length > 1) setTimeout(() => mine === token && void next(), 2500);
    } finally {
      if (mine === token) player.loading = false;
    }
  }

  /**
   * 换一个列表从第 start 首开始放；source：这个列表是哪个歌单。
   * 你挑的歌不再渐弱；一首放完自动接下一首时照样接着变小（playAt 不管渐弱）
   */
  function playList(songs: SongInfo[], start = 0, source: QueueSource | null = null): Promise<void> {
    cancelFade();
    player.queue = songs.slice();
    player.source = source;
    return playAt(Math.max(0, Math.min(start, songs.length - 1)));
  }

  /** 放这首：已经在列表里就跳过去，不在就插到当前这首后面 */
  function playSong(song: SongInfo): Promise<void> {
    cancelFade();
    const at = player.queue.findIndex((s) => s.id === song.id);
    if (at >= 0) return playAt(at);
    const i = player.index >= 0 ? player.index + 1 : player.queue.length;
    player.queue.splice(i, 0, song);
    return playAt(i);
  }

  function enqueue(songs: SongInfo[]) {
    const fresh = songs.filter((s) => !player.queue.some((q) => q.id === s.id));
    const wasEmpty = !player.queue.length;
    player.queue.push(...fresh);
    persist();
    if (wasEmpty && fresh.length) void playAt(0);
    return fresh.length;
  }

  function removeAt(i: number) {
    if (i < 0 || i >= player.queue.length) return;
    const wasCurrent = i === player.index;
    player.queue.splice(i, 1);
    if (wasCurrent) {
      if (player.queue.length) void playAt(Math.min(i, player.queue.length - 1));
      else stop();
    } else if (i < player.index) player.index -= 1;
    persist();
  }

  function clearQueue() {
    stop();
    player.queue = [];
    player.index = -1;
    player.source = null;
    persist();
  }

  function randomIndex(): number {
    if (player.queue.length <= 1) return 0;
    let i = player.index;
    while (i === player.index) i = Math.floor(Math.random() * player.queue.length);
    return i;
  }

  function next(): Promise<void> {
    if (!player.queue.length) return Promise.resolve();
    if (player.mode === 'shuffle') return playAt(randomIndex());
    return playAt((player.index + 1) % player.queue.length);
  }

  function prev(): Promise<void> {
    if (!player.queue.length) return Promise.resolve();
    // 放了 3 秒以上：先回到这首开头
    if (player.posMs > 3000) {
      seek(0);
      return Promise.resolve();
    }
    if (player.mode === 'shuffle') return playAt(randomIndex());
    return playAt((player.index - 1 + player.queue.length) % player.queue.length);
  }

  /** 播放 / 暂停；on 指定要哪个。渐弱时点播放：不再变小，回到原来的音量 */
  async function toggle(on?: boolean): Promise<void> {
    const want = on ?? !player.playing;
    if (want) cancelFade();
    // 锁屏上点播放时 AudioContext 可能被挂起了：接进 Web Audio 的先恢复，不然放了也没声
    if (want && gain) resumeAudioContext();
    if (!current()) {
      if (want && player.queue.length) await playAt(0);
      return;
    }
    if (player.demo) {
      player.playing = want;
      if (want) startDemoClock();
      return;
    }
    const a = el();
    if (!want) {
      a.pause();
      return;
    }
    // 还没取过地址（刚打开、恢复的列表），或者地址快过期了：重新取
    if (!a.src || a.src.startsWith('data:') || !url || Date.now() > expiresAt - 60_000) {
      const at = player.posMs;
      await playAt(player.index);
      if (at > 0) seek(at);
      return;
    }
    try {
      await a.play();
    } catch (e) {
      if ((e as DOMException)?.name === 'NotAllowedError') player.needsTap = true;
      else player.error = e instanceof Error ? e.message : String(e);
    }
  }

  function seek(ms: number) {
    const t = Math.max(0, ms);
    player.posMs = t;
    if (!player.demo && audio && url) audio.currentTime = t / 1000;
    emit({ kind: 'seek' });
  }

  function setVolume(v: number) {
    player.volume = clamp01(v);
    applyVolume();
    persist();
  }

  function setMode(m: PlayMode) {
    player.mode = m;
    persist();
  }

  function cycleMode() {
    const order: PlayMode[] = ['list', 'single', 'shuffle'];
    setMode(order[(order.indexOf(player.mode) + 1) % order.length]!);
  }

  /** 她说话时压低一点，说完慢慢回来（下去快、回来慢） */
  function duck(on: boolean) {
    duckTarget = on ? DUCK_LEVEL : 1;
    if (duckTimer) return;
    duckTimer = setInterval(() => {
      const step = duckTarget < duckGain ? -0.08 : 0.04;
      duckGain = Math.abs(duckTarget - duckGain) <= Math.abs(step) ? duckTarget : duckGain + step;
      applyVolume();
      if (duckGain === duckTarget) {
        clearInterval(duckTimer);
        duckTimer = undefined;
      }
    }, 50);
  }

  function finishFade(pause: boolean) {
    clearInterval(fadeTimer);
    fadeTimer = undefined;
    if (pause) {
      if (player.demo) player.playing = false;
      else audio?.pause();
    }
    fadeGain = 1;
    applyVolume();
    player.fading = false;
    const done = fadeDone;
    fadeDone = null;
    done?.();
  }

  /** 渐弱到一半又点了播放、换了歌：不再变小 */
  function cancelFade() {
    if (fadeTimer) finishFade(false);
  }

  /** 定时到点：seconds 秒里慢慢变小，到了就暂停（列表和位置留着，下次接着放） */
  function fadeOut(seconds: number): Promise<void> {
    if (!player.playing) return Promise.resolve();
    cancelFade();
    player.fading = true;
    const started = Date.now();
    const total = Math.max(1, seconds * 1000);
    return new Promise((resolve) => {
      fadeDone = resolve;
      fadeTimer = setInterval(() => {
        const t = Math.min(1, (Date.now() - started) / total);
        fadeGain = 1 - t;
        applyVolume();
        if (t >= 1) finishFade(true);
      }, 200);
    });
  }

  /** 这一次一起听了什么："一起听了《A》《B》等 5 首"；一首都没放过时为空 */
  function sessionSummary(): string | undefined {
    if (!played.length) return undefined;
    const names = played.slice(0, 3).map((t) => `《${t}》`).join('');
    return `一起听了${names}${played.length > 3 ? `等 ${played.length} 首` : ''}`;
  }

  /** 不听了（离开这件事）：停下、松开 iPhone 的音频会话；列表留着 */
  function stop() {
    token += 1;
    played.length = 0;
    clearInterval(demoTimer);
    cancelFade();
    clearInterval(duckTimer);
    duckTimer = undefined;
    duckGain = duckTarget = 1;
    if (gain) dropAudio();
    else if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    }
    releaseLease();
    url = '';
    player.playing = false;
    player.loading = false;
    player.posMs = 0;
    releaseSession?.();
    releaseSession = null;
    setMediaState('none');
    emit({ kind: 'stop' });
  }

  return {
    state: player,
    current,
    lyricIndex,
    onPlayerEvent,
    prime,
    playAt,
    playList,
    playSong,
    enqueue,
    removeAt,
    clearQueue,
    next,
    prev,
    toggle,
    seek,
    setVolume,
    setMode,
    cycleMode,
    duck,
    fadeOut,
    sessionSummary,
    stop,
  };
}

export type MusicPlayer = ReturnType<typeof createMusicPlayer>;

/** 一起听歌 */
const together = createMusicPlayer({ storageKey: 'ai-mobile:music:queue:v1', lyrics: true });

/** 哄睡的音乐：播放列表和一起听歌的分开存，不取歌词，默认小声一点 */
export const sleepMusic = createMusicPlayer({ storageKey: 'ai-mobile:sleep:music:v1', lyrics: false, volume: 0.7 });

/** 共同的家（做家务时）的音乐：播放列表单独存 */
export const choreMusic = createMusicPlayer({ storageKey: 'ai-mobile:home:music:v1', lyrics: false, volume: 0.8 });

/** 健身时的音乐：播放列表单独存 */
export const fitMusic = createMusicPlayer({ storageKey: 'ai-mobile:fit:music:v1', lyrics: false, volume: 0.85 });

/** 陪伴学习时的音乐：播放列表单独存，默认小声一点，不抢注意力 */
export const studyMusic = createMusicPlayer({ storageKey: 'ai-mobile:study:music:v1', lyrics: false, volume: 0.6 });

/** 一起吃饭时的音乐：播放列表单独存，默认小声一点，不盖过她说话和下饭视频 */
export const mealMusic = createMusicPlayer({ storageKey: 'ai-mobile:meal:music:v1', lyrics: false, volume: 0.6 });

/** 戳戳乐时的音乐：播放列表单独存，默认小声一点，不盖过她说话 */
export const pokeMusic = createMusicPlayer({ storageKey: 'ai-mobile:poke:music:v1', lyrics: false, volume: 0.6 });

/** 出逃时的音乐：播放列表单独存，默认小声一点，和白噪音叠着也不吵 */
export const escapeMusic = createMusicPlayer({ storageKey: 'ai-mobile:escape:music:v1', lyrics: false, volume: 0.6 });

/** 休息时的音乐：播放列表单独存，默认小声一点，和白噪音叠着也不吵 */
export const restMusic = createMusicPlayer({ storageKey: 'ai-mobile:rest:music:v1', lyrics: false, volume: 0.6 });

/** 心跳时的音乐：播放列表单独存，默认小声一点，不盖过她说话 */
export const heartMusic = createMusicPlayer({ storageKey: 'ai-mobile:heart:music:v1', lyrics: false, volume: 0.5 });

/** 约会时的音乐：播放列表单独存，默认小声一点，当背景音乐 */
export const dateMusic = createMusicPlayer({ storageKey: 'ai-mobile:date:music:v1', lyrics: false, volume: 0.5 });

/** 一件事自带的几个歌单（components/scene/PlaylistMusic.vue）：按这些词去网易云搜，搜到的歌就是这个歌单 */
export interface PlaylistSearch {
  name: string;
  keyword: string;
  icon: string;
}

export const {
  state: player,
  current,
  lyricIndex,
  onPlayerEvent,
  prime,
  playAt,
  playList,
  playSong,
  enqueue,
  removeAt,
  clearQueue,
  next,
  prev,
  toggle,
  seek,
  setVolume,
  cycleMode,
  sessionSummary,
  stop,
} = together;
