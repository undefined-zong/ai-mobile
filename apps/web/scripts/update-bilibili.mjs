#!/usr/bin/env node
/**
 * 一起观影的 B 站片单（移植自 siios 的 scripts/update_bilibili.py）：从 B 站的热门、排行榜取真实视频，
 * 每个分类写一个 JSON。GitHub Actions 每小时跑一次（.github/workflows/bilibili-data.yml），推到 bilibili-data 分支，
 * App 从 raw.githubusercontent.com 读（apps/web/src/services/bilibili.ts）。不用登录、不用自己的服务器。
 *
 *   node apps/web/scripts/update-bilibili.mjs <输出目录>
 *
 * 有一个分类一条都没取到就以失败退出（不推送，分支上还是上一次的片单）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const OUT = process.argv[2] || 'bilibili-data';
const API = 'https://api.bilibili.com/x/web-interface/';
// 和 siios 一样的几个分类；直播间不是视频，嵌入播放器放不了，不要
const CATEGORIES = [
  { id: 'recommend', label: '推荐', apis: ['popular?ps=50', 'ranking/v2?rid=0&type=all'] },
  { id: 'anime', label: '番剧', apis: ['ranking/v2?rid=1&type=all'] },
  { id: 'hot', label: '热门', apis: ['popular?ps=50&pn=1', 'popular?ps=50&pn=2'] },
  { id: 'games', label: '游戏', apis: ['ranking/v2?rid=4&type=all'] },
];
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  Referer: 'https://www.bilibili.com/',
  Accept: 'application/json, text/plain, */*',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function list(path) {
  try {
    const res = await fetch(API + path, { headers: HEADERS, signal: AbortSignal.timeout(15_000) });
    const data = await res.json();
    if (data.code !== 0) throw new Error(`${data.code} ${data.message}`);
    return data.data?.list ?? [];
  } catch (e) {
    console.log(`  ✗ ${path}：${e.message}`);
    return [];
  }
}

const videos = (items) =>
  items
    .filter((v) => /^BV[0-9A-Za-z]{10}$/.test(v.bvid ?? ''))
    .map((v) => ({
      bvid: v.bvid,
      // 嵌入播放器带上 aid + cid 就不用请求视频信息接口（iOS 上那个请求没有 Cookie，B 站回 412、显示失效）
      aid: v.aid ?? 0,
      cid: v.cid ?? 0,
      title: v.title ?? '',
      cover: String(v.pic ?? '').replace(/^http:\/\//, 'https://'),
      views: v.stat?.view ?? 0,
      danmu: v.stat?.danmaku ?? 0,
      duration: v.duration ?? 0,
      owner: v.owner?.name ?? '',
      tag: v.tname ?? '',
    }));

mkdirSync(OUT, { recursive: true });
let failed = false;
for (const c of CATEGORIES) {
  console.log(`${c.label}（${c.id}）`);
  const seen = new Set();
  const all = [];
  for (const path of c.apis) {
    for (const v of videos(await list(path))) if (!seen.has(v.bvid)) seen.add(v.bvid), all.push(v);
    await sleep(800);
  }
  console.log(`  ✓ ${all.length} 部`);
  if (!all.length) failed = true;
  writeFileSync(join(OUT, `${c.id}.json`), JSON.stringify({ category: c.id, label: c.label, updated_at: new Date().toISOString(), videos: all }));
}
if (failed) {
  console.error('有分类一条都没取到，不更新');
  process.exit(1);
}
