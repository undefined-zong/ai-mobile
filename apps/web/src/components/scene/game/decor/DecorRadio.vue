<script setup lang="ts">
import { computed, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';
import { showToast } from 'vant';
import { extractId } from '@/services/music';
import { musicLibrary, saveList, type SavedList } from '@/services/musicLibrary';
import type { SongList } from '@/services/types';
import { normalizeBase, useServicesStore } from '@/stores/services';
import { clock } from '@/utils/time';
import { volumeLocked } from '@/services/musicPlayer';
import { decorRadio as music, radioClient } from './radio';

const open = defineModel<boolean>({ required: true });
const svc = useServicesStore();
const state = music.state;
const song = computed(() => music.current());
const endpoint = ref(svc.netease.workerUrl);
const link = ref('');
const loading = ref(false);
const error = ref('');
const list = ref<(SongList & { key: string; type: 'playlist' | 'album' }) | null>(null);
const tab = ref<'library' | 'queue'>('library');
let request = 0;

// Closing the sheet keeps music playing; leaving the room cancels pending selection too.
function leave() { request++; music.stop(); loading.value = false; }
onBeforeUnmount(leave);
onDeactivated(leave);
watch(() => svc.neteaseBase, () => { leave(); list.value = null; error.value = ''; });

function connect() {
  svc.netease.workerUrl = normalizeBase(endpoint.value);
}
async function loadPlaylist(value: string, type: 'playlist' | 'album' = 'playlist') {
  const input = value.trim();
  if (!input) return;
  const run = ++request;
  loading.value = true;
  error.value = '';
  list.value = null;
  try {
    const data = type === 'album' ? await radioClient.album(input) : await radioClient.playlist(input);
    if (run !== request) return;
    list.value = { ...data, key: `${type}:${extractId(input)}`, type };
    if (!data.songs.length) error.value = '这个歌单暂时没有可读取的歌曲，可以换个歌单。';
  } catch (e) {
    if (run === request) error.value = e instanceof Error ? e.message : '歌单加载失败，请重试。';
  } finally {
    if (run === request) loading.value = false;
  }
}
function chooseSaved(saved: SavedList) {
  link.value = saved.key.slice(saved.type.length + 1);
  void loadPlaylist(link.value, saved.type);
}
function play(index = 0) {
  const current = list.value;
  if (!current?.songs.length) return;
  music.prime();
  void music.playList(current.songs, index, { key: current.key, name: current.name });
}
function playQueue(index: number) { music.prime(); void music.playAt(index); }
function toggle() { music.prime(); void music.toggle(); }
function skip(direction: 'next' | 'prev') { music.prime(); void music[direction](); }
function save() {
  if (list.value) showToast(saveList(list.value) ? '已收藏，可在一起听歌中找到' : '收藏未保存，设备存储空间不足');
}
function liked() {
  request++;
  loading.value = false;
  error.value = '';
  list.value = { key: 'liked', type: 'playlist', name: '一起喜欢的歌', cover: musicLibrary.liked[0]?.cover ?? null, songs: [...musicLibrary.liked] };
}
const modeName = computed(() => ({ list: '顺序播放', single: '单曲循环', shuffle: '随机播放' })[state.mode]);
</script>

<template>
  <van-popup v-model:show="open" position="bottom" round teleport="body" :style="{ maxHeight: '88%', width: 'min(100%, 480px)', left: 'max(0px, calc((100% - 480px) / 2))' }">
    <section class="radio-sheet" aria-label="小屋收音机">
      <header class="radio-header"><div><h2>小屋收音机</h2><p>给这个房间，选一段背景音乐</p></div><button type="button" class="icon-button" aria-label="关闭收音机面板" @click="open = false"><span class="i-lucide-x" /></button></header>

      <form v-if="!svc.musicReady" class="connect" @submit.prevent="connect">
        <span class="i-lucide-radio receiver" aria-hidden="true" />
        <h3>连接你的网易云音乐</h3>
        <p>使用与「一起听歌」相同的音乐服务。连接后可读取网易云歌单并播放。</p>
        <label for="radio-endpoint">网易云 API 地址</label>
        <input id="radio-endpoint" v-model="endpoint" type="url" inputmode="url" placeholder="https://你的音乐服务地址" autocomplete="off" required />
        <button class="primary" type="submit">保存并选择歌单</button>
        <RouterLink to="/me/services">音乐服务设置与接入说明 <span class="i-lucide-arrow-up-right" /></RouterLink>
      </form>

      <template v-else>
        <div class="receiver-player">
          <div class="now-playing">
            <img v-if="song?.cover" class="cover" :src="song.cover" alt="" referrerpolicy="no-referrer" />
            <span v-else class="cover cover-empty i-lucide-radio" aria-hidden="true" />
            <div class="song-copy"><strong>{{ song?.title ?? '今天，想听什么？' }}</strong><span>{{ song?.artist ?? '选择歌单，再点一首歌开始' }}</span><small v-if="state.source">{{ state.source.name }}</small></div>
          </div>
          <div class="transport">
            <button type="button" class="icon-button" :aria-label="modeName" :title="modeName" @click="music.cycleMode()"><span :class="state.mode === 'shuffle' ? 'i-lucide-shuffle' : state.mode === 'single' ? 'i-lucide-repeat-1' : 'i-lucide-repeat'" /></button>
            <button type="button" class="icon-button" aria-label="上一首" :disabled="!state.queue.length" @click="skip('prev')"><span class="i-lucide-skip-back" /></button>
            <button type="button" class="play-button" :aria-label="state.playing ? '暂停音乐' : '播放音乐'" :disabled="!state.queue.length || state.loading" @click="toggle"><span :class="state.loading ? 'i-lucide-loader-circle loading' : state.playing ? 'i-lucide-pause' : 'i-lucide-play'" /></button>
            <button type="button" class="icon-button" aria-label="下一首" :disabled="!state.queue.length" @click="skip('next')"><span class="i-lucide-skip-forward" /></button>
            <button type="button" class="icon-button" aria-label="停止音乐" :disabled="!state.queue.length" @click="music.stop()"><span class="i-lucide-square" /></button>
          </div>
          <label class="progress-control"><span>{{ clock(state.posMs / 1000) }}</span><input type="range" min="0" step="1000" :max="state.durationMs || 1" :value="state.posMs" :disabled="!song || !state.durationMs" aria-label="播放进度" @change="music.seek(Number(($event.target as HTMLInputElement).value))" /><span>{{ clock(state.durationMs / 1000) }}</span></label>
          <span v-if="volumeLocked" class="volume-control"><span class="i-lucide-volume-2" aria-hidden="true" /><span>音量用手机侧面的按键调</span></span><label v-else class="volume-control"><span class="i-lucide-volume-2" aria-hidden="true" /><span>音量</span><input type="range" min="0" max="100" :value="Math.round(state.volume * 100)" aria-label="收音机音量" @input="music.setVolume(Number(($event.target as HTMLInputElement).value) / 100)" /></label>
        </div>
        <p v-if="state.needsTap" class="message" role="status">浏览器需要你点一下播放，才能出声。</p>
        <p v-if="state.error" class="message error" role="alert">{{ state.error }}</p>

        <div class="radio-tabs" role="tablist" aria-label="音乐列表">
          <button type="button" role="tab" :aria-selected="tab === 'library'" @click="tab = 'library'">选择歌单</button>
          <button type="button" role="tab" :aria-selected="tab === 'queue'" @click="tab = 'queue'">播放队列 <span>{{ state.queue.length }}</span></button>
        </div>
        <div v-if="tab === 'library'">
          <form class="import-form" @submit.prevent="loadPlaylist(link)"><label for="radio-playlist">网易云歌单链接或 ID</label><div><input id="radio-playlist" v-model="link" placeholder="粘贴歌单链接或数字 ID" autocomplete="off" /><button class="primary" type="submit" :disabled="!link.trim() || loading">{{ loading ? '读取中…' : '读取歌单' }}</button></div></form>
          <div class="quick-lists" aria-label="网易云榜单"><button type="button" @click="link = '3778678'; loadPlaylist(link)">热歌榜 <span class="i-lucide-arrow-up-right" /></button><button type="button" @click="link = '19723756'; loadPlaylist(link)">飙升榜 <span class="i-lucide-arrow-up-right" /></button><button type="button" @click="link = '2884035'; loadPlaylist(link)">原创榜 <span class="i-lucide-arrow-up-right" /></button></div>
          <p v-if="loading" class="message" role="status"><span class="i-lucide-loader-circle loading" /> 正在读取网易云歌单…</p>
          <p v-if="error" class="message error" role="alert">{{ error }}</p>
          <div v-if="list" class="playlist-detail">
            <button type="button" class="back-lists" @click="list = null; error = ''"><span class="i-lucide-arrow-left" /> 收藏的歌单</button>
            <div class="list-heading"><img v-if="list.cover" :src="list.cover" alt="" referrerpolicy="no-referrer" /><div><h3>{{ list.name }}</h3><span>{{ list.songs.length }} 首可读取歌曲</span></div><button v-if="list.key !== 'liked'" type="button" class="icon-button" aria-label="收藏这个歌单" @click="save"><span class="i-lucide-bookmark-plus" /></button></div>
            <button type="button" class="primary play-all" :disabled="!list.songs.length" @click="play()"><span class="i-lucide-play" /> 播放歌单</button>
            <ol class="track-list"><li v-for="(track, index) in list.songs" :key="`${track.id}:${index}`"><button type="button" :class="{ current: song?.id === track.id }" :aria-label="`播放 ${track.title}`" @click="play(index)"><span class="track-index">{{ index + 1 }}</span><span class="track-copy"><strong>{{ track.title }}</strong><small>{{ track.artist }}</small></span><span :class="song?.id === track.id && state.playing ? 'i-lucide-volume-2' : 'i-lucide-play'" /></button></li></ol>
          </div>
          <div v-else-if="!loading" class="saved-lists"><h3>收藏的歌单</h3><button v-if="musicLibrary.liked.length" type="button" @click="liked"><span class="i-lucide-heart" /><span>一起喜欢的歌<small>{{ musicLibrary.liked.length }} 首</small></span><span class="i-lucide-chevron-right" /></button><button v-for="saved in musicLibrary.lists" :key="saved.key" type="button" @click="chooseSaved(saved)"><img v-if="saved.cover" :src="saved.cover" alt="" referrerpolicy="no-referrer" /><span v-else class="i-lucide-list-music" /><span>{{ saved.name }}<small>{{ saved.songs.length }} 首</small></span><span class="i-lucide-chevron-right" /></button><p v-if="!musicLibrary.lists.length && !musicLibrary.liked.length">还没有收藏。先读取一个歌单，点收藏后，下次就能在这里找到。</p></div>
          <RouterLink class="settings-link" to="/me/services">音乐服务设置 <span class="i-lucide-arrow-up-right" /></RouterLink>
        </div>
        <div v-else><p v-if="!state.queue.length" class="message">播放队列是空的，先选择一个歌单。</p><ol v-else class="track-list"><li v-for="(track, index) in state.queue" :key="`${track.id}:${index}`"><button type="button" :class="{ current: index === state.index }" @click="playQueue(index)"><span class="track-index">{{ index + 1 }}</span><span class="track-copy"><strong>{{ track.title }}</strong><small>{{ track.artist }}</small></span><span :class="index === state.index && state.playing ? 'i-lucide-volume-2' : 'i-lucide-play'" /></button></li></ol></div>
      </template>
    </section>
  </van-popup>
</template>

<style scoped>
.radio-sheet { padding: 22px 20px max(24px, env(safe-area-inset-bottom)); color: var(--ink); }
.radio-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
h2 { font-size: 21px; font-weight: 650; margin: 0; }
h3 { font-size: 15px; font-weight: 600; margin: 0; }
p { line-height: 1.65; }
.radio-header p { font-size: 12px; color: var(--ink-2); margin: 5px 0 0; }
button { cursor: pointer; }
button:disabled { opacity: .4; cursor: default; }
button:focus-visible, a:focus-visible, input:focus-visible { outline: 2px solid var(--accent-ink); outline-offset: 3px; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; min-width: 44px; min-height: 44px; font-size: 19px; border-radius: 12px; }
.icon-button:hover { background: var(--panel); }
.receiver-player { padding: 18px; border-radius: 16px; background: var(--panel); }
.now-playing { display: flex; align-items: center; gap: 12px; }
.cover { width: 62px; height: 62px; border-radius: 8px; object-fit: cover; flex: none; }
.cover-empty { width: 44px; height: 44px; margin: 9px; color: var(--accent-ink); }
.song-copy, .track-copy { display: flex; flex-direction: column; min-width: 0; gap: 4px; flex: 1; }
.song-copy strong, .track-copy strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; font-weight: 600; }
.song-copy span, .song-copy small, .track-copy small { color: var(--ink-2); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transport { display: flex; align-items: center; justify-content: space-between; gap: 4px; margin-top: 18px; }
.play-button { display: flex; align-items: center; justify-content: center; width: 54px; height: 54px; border-radius: 50%; background: var(--accent); color: var(--on-accent); font-size: 24px; }
.progress-control, .volume-control { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--ink-2); margin-top: 13px; font-variant-numeric: tabular-nums; }
input[type='range'] { flex: 1; min-width: 0; height: 28px; accent-color: var(--accent-ink); }
.volume-control input { max-width: 140px; }
.volume-control { justify-content: flex-end; margin-top: 0; }
.radio-tabs { display: flex; gap: 24px; border-bottom: 1px solid var(--border); margin: 24px 0 20px; }
.radio-tabs button { min-height: 44px; font-size: 14px; color: var(--ink-2); border-bottom: 2px solid transparent; }
.radio-tabs button[aria-selected='true'] { color: var(--accent-ink); border-bottom-color: currentColor; font-weight: 600; }
.radio-tabs span { font-size: 11px; margin-left: 5px; }
input:not([type='range']) { width: 100%; min-width: 0; min-height: 44px; border-radius: 10px; border: 1px solid var(--border); background: var(--panel); padding: 10px 12px; color: var(--ink); font-size: 13px; caret-color: var(--accent-ink); }
input::placeholder { color: var(--ink-2); }
.import-form label, .connect label { display: block; margin-bottom: 8px; font-size: 12px; color: var(--ink-2); }
.import-form > div { display: flex; gap: 8px; }
.primary { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 10px 14px; min-height: 44px; border-radius: 10px; background: var(--accent); color: var(--on-accent); white-space: nowrap; font-size: 13px; font-weight: 600; }
.quick-lists { display: flex; flex-wrap: wrap; gap: 16px; margin-top: 6px; }
.quick-lists button { display: flex; align-items: center; gap: 4px; min-height: 44px; font-size: 12px; color: var(--accent-ink); }
.message { font-size: 12px; color: var(--ink-2); padding: 8px 0; overflow-wrap: anywhere; }
.error { color: var(--danger, #a33f48); }
.back-lists { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; font-size: 12px; color: var(--accent-ink); }
.list-heading { display: flex; align-items: center; gap: 12px; margin-top: 16px; }
.list-heading img { width: 54px; height: 54px; border-radius: 8px; }
.list-heading > div { flex: 1; min-width: 0; }
.list-heading span { display: block; margin-top: 5px; font-size: 12px; color: var(--ink-2); }
.play-all { margin: 16px 0 8px; width: 100%; }
.track-list { list-style: none; margin: 0; padding: 0; }
.track-list button { display: flex; align-items: center; width: 100%; min-height: 62px; gap: 12px; text-align: left; border-bottom: 1px solid var(--border); }
.track-list .current { color: var(--accent-ink); }
.track-index { width: 24px; text-align: center; font-size: 11px; font-variant-numeric: tabular-nums; color: var(--ink-2); }
.saved-lists h3 { margin: 22px 0 8px; }
.saved-lists > button { display: flex; align-items: center; gap: 12px; min-height: 68px; width: 100%; border-bottom: 1px solid var(--border); text-align: left; }
.saved-lists img { width: 42px; height: 42px; border-radius: 7px; }
.saved-lists button > span:nth-last-child(2) { flex: 1; font-size: 13px; }
.saved-lists small { display: block; font-size: 11px; color: var(--ink-2); margin-top: 4px; }
.saved-lists p, .connect p { font-size: 13px; color: var(--ink-2); }
.settings-link, .connect a { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; margin-top: 16px; font-size: 12px; color: var(--accent-ink); text-underline-offset: 3px; }
.connect .receiver { display: block; width: 56px; height: 56px; color: var(--accent-ink); margin: 8px 0 20px; }
.connect p { margin: 10px 0 24px; }
.connect .primary { width: 100%; margin-top: 12px; }
.loading { animation: turn 1.3s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading { animation: none; } }
</style>
