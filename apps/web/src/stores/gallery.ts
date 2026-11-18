import { errorReport, errorText, isAbortError } from '@app/ai';
import { getLocation, momentLabel, rhythmDate, sceneImageUse } from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useCharacterStore } from './characters';
import { useRhythmStore } from './rhythm';
import { autoSave, getAll, getOne, write } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { services } from '@/services';
import type { IllustrateOutcome } from '@/services/types';
import { uid } from '@/utils/id';

/**
 * 图库（设计文档 §10.6 的第一步）：一起做事时画的图都记下来——哪个角色、哪个场景、哪个时刻、在哪、穿的什么、哪天。
 * - 进场景时先在图库里找今天同一个地方、同一身衣服画过的，有就直接用，不重新画；
 * - 画图排队（所有出图一次一张，你点的排在自动的前面，见 services/ai.ts）；
 * - 自动画可以关（场景右上角）。NovelAI 只在不花点的设置下自动画（§10.2）。
 * 图片本身存在本机素材库（按内容哈希），这里只记索引。
 */

export interface GalleryItem {
  id: string;
  characterId: string;
  sceneId: string;
  /** 时刻：seat / peek / reward…… */
  moment: string;
  /** 要画的画面（中文） */
  caption: string;
  /** 生图提示词智能体起的标题 */
  title: string;
  assetKey: string | null;
  url?: string;
  prompt: string;
  negative: string;
  seed: number | null;
  model: string;
  locationId: string | null;
  outfit: string | null;
  /** 程序定的画幅（陪伴学习：一起专注竖图，各自专注上半屏方图或横图）；以前的图没记，都是竖图 */
  size?: ImageShape;
  /** 画的时候没锁今天那身衣服（心跳）；以前的图没记，按场景算 */
  lockOutfit?: boolean;
  /** 节律日 */
  day: string;
  at: number;
}

export type ImageShape = 'portrait' | 'landscape' | 'square';

export interface SceneDrawRequest {
  characterId: string;
  sceneId: string;
  moment: string;
  caption: string;
  /** user：你点的（排在前面）；auto：场景自己画的 */
  priority: 'user' | 'auto';
  locationId?: string | null;
  expression?: string | null;
  recent?: string[];
  /** 画幅由程序定；不给按生图预设（模型写的） */
  size?: ImageShape;
  /** 衣服锁成节律里今天这一套（默认锁）；心跳里不锁，衣服按画面写 */
  lockOutfit?: boolean;
}

/** 图库里这张图的画幅（以前没记的都是竖图） */
export function shapeOf(item: Pick<GalleryItem, 'size'>): ImageShape {
  return item.size ?? 'portrait';
}

/** 一个场景此刻在画什么 */
export interface DrawingState {
  moment: string;
  stage: 'queued' | 'prompt' | 'image';
  priority: 'user' | 'auto';
}

const KEEP = 400;

export const useGalleryStore = defineStore('gallery', () => {
  const items = ref<GalleryItem[]>([]);
  /** 场景自动画图（默认开）；关了只在你点"看她一眼"之类时画 */
  const autoDraw = ref(true);
  /** 正在画的：按"角色:场景" */
  const drawing = reactive<Record<string, DrawingState | undefined>>({});
  /** 上一次没画出来：按"角色:场景" */
  const failures = reactive<Record<string, { moment: string; reason: string; detail: string } | undefined>>({});

  // 别的设备画的图（同步；图片本身用到时再下载）、自动画图的开关：放进来
  const saver = autoSave('gallery', () => items.value.map((i) => ({ key: i.id, value: i })), items,
    { apply: (changes) => applyList(items, changes, { sort: (a, b) => a.at - b.at }) });
  const settingSaver = autoSave('settings', () => [{ key: 'sceneAutoDraw', value: autoDraw.value }], autoDraw,
    { apply: ([c]) => { if (c && !c.deleted && typeof c.value === 'boolean') autoDraw.value = c.value; } });

  async function hydrate() {
    const [list, auto] = await Promise.all([getAll<GalleryItem>('gallery'), getOne<boolean>('settings', 'sceneAutoDraw')]);
    items.value = list.filter((i) => i && i.id).sort((a, b) => a.at - b.at);
    if (typeof auto === 'boolean') autoDraw.value = auto;
    // 太多了删最旧的索引（图片还在素材库里）
    if (items.value.length > KEEP) {
      const drop = items.value.slice(0, items.value.length - KEEP);
      items.value = items.value.slice(-KEEP);
      await write('gallery', [], drop.map((d) => d.id));
    }
    saver.start();
    settingSaver.start();
  }

  const key = (characterId: string, sceneId: string) => `${characterId}:${sceneId}`;

  /** 这个角色在这个场景里画过的，最新的在前（today：只要今天的；locationId + outfit：同一个地方、同一身衣服；size：同一种画幅） */
  function find(
    characterId: string,
    sceneId: string,
    opts: { moment?: string; today?: boolean; locationId?: string | null; outfit?: string | null; size?: ImageShape } = {},
  ): GalleryItem[] {
    const day = rhythmDate(new Date());
    return items.value
      .filter(
        (i) =>
          i.characterId === characterId &&
          i.sceneId === sceneId &&
          (!opts.moment || i.moment === opts.moment) &&
          (!opts.today || i.day === day) &&
          (opts.locationId === undefined || i.locationId === opts.locationId) &&
          (opts.outfit === undefined || i.outfit === opts.outfit) &&
          (!opts.size || shapeOf(i) === opts.size),
      )
      .sort((a, b) => b.at - a.at);
  }

  /**
   * 能不能自动画：生图接通了、自动画开着；NovelAI 只在不花点的设置下（步数不超过 28、不用 V5；尺寸和张数程序本来就守着）
   */
  function autoCheck(opts: { /** 不看场景的"自动画"开关（朋友圈的配图有自己的开关） */ ignoreSwitch?: boolean } = {}): { ok: true } | { ok: false; reason: string } {
    if (!autoDraw.value && !opts.ignoreSwitch) return { ok: false, reason: '自动画关着' };
    const ai = useAiStore();
    const s = ai.status('image');
    if (!s.live) return { ok: false, reason: `生图 API 还没接通：${s.reason}` };
    const route = ai.effectiveRoute('image');
    if (route.api?.channel === 'novelai') {
      const model = route.api.model || 'nai-diffusion-4-5-full';
      if (/nai-diffusion-5/.test(model)) return { ok: false, reason: 'V5 有用量上限，自动画只用 V4.5 或更早的模型（点"看一眼"照样能画）' };
      if ((route.imageStyle?.steps ?? 28) > 28) return { ok: false, reason: '步数超过 28 会扣点，自动画先停着（API 设置 → 生图 → 步数改到 28 以内）' };
    }
    return { ok: true };
  }

  function isDrawing(characterId: string, sceneId: string): DrawingState | undefined {
    return drawing[key(characterId, sceneId)];
  }

  /**
   * 画场景里的一个时刻：用这个场景的生图预设（没单独选就跟随配图），衣服锁成节律里今天这个场景该穿的那套。
   * 同一个场景同时只画一张；画好记进图库
   */
  async function draw(req: SceneDrawRequest): Promise<{ ok: true; item: GalleryItem } | { ok: false; reason: string; detail?: string; busy?: boolean }> {
    const r = await paint(req);
    if (!r.ok) return r;
    const { out } = r;
    const item: GalleryItem = {
      id: uid('gal'),
      characterId: req.characterId,
      sceneId: req.sceneId,
      moment: req.moment,
      caption: req.caption,
      title: out.caption || momentLabel(req.moment) || '',
      assetKey: out.assetKey,
      url: out.url,
      prompt: out.prompt,
      negative: out.negative,
      seed: out.seed,
      model: out.model,
      locationId: r.locationId,
      outfit: r.outfit,
      ...(req.size ? { size: req.size } : {}),
      ...(req.lockOutfit === false ? { lockOutfit: false } : {}),
      day: rhythmDate(new Date()),
      at: Date.now(),
    };
    items.value.push(item);
    return { ok: true, item: items.value.at(-1) as GalleryItem };
  }

  /**
   * 重画图库里的一张：同一个画面（场景、时刻、描述、地点、画幅）再画一张，换掉这一张的图（还是这一条，时间不变）。
   * 返回换下来的旧图 key（聊天卡片里用着它的跟着换，见 services/redraw.ts）
   */
  async function redraw(id: string): Promise<{ ok: true; item: GalleryItem; oldKey: string | null; oldUrl?: string } | { ok: false; reason: string; detail?: string; busy?: boolean }> {
    const before = items.value.find((i) => i.id === id);
    if (!before) return { ok: false, reason: '图库里已经没有这张了' };
    const r = await paint({
      characterId: before.characterId, sceneId: before.sceneId, moment: before.moment, caption: before.caption, priority: 'user',
      locationId: before.locationId, ...(before.size ? { size: before.size } : {}), lockOutfit: before.lockOutfit ?? before.sceneId !== 'heart',
    });
    if (!r.ok) return r;
    // await 之后按 id 重新取（期间可能被删掉了）
    const item = items.value.find((i) => i.id === id);
    if (!item) return { ok: false, reason: '图库里已经没有这张了' };
    const oldKey = item.assetKey;
    const oldUrl = item.url;
    const { out } = r;
    Object.assign(item, { assetKey: out.assetKey, prompt: out.prompt, negative: out.negative, seed: out.seed, model: out.model, title: out.caption || item.title });
    if (out.url) item.url = out.url;
    else delete item.url;
    return { ok: true, item, oldKey, oldUrl };
  }

  /** 照一个请求画一张（不进图库）：draw 和 redraw 共用。同一个场景同时只画一张 */
  async function paint(req: SceneDrawRequest): Promise<{ ok: true; out: IllustrateOutcome; locationId: string | null; outfit: string | null } | { ok: false; reason: string; detail?: string; busy?: boolean }> {
    const k = key(req.characterId, req.sceneId);
    if (drawing[k]) return { ok: false, reason: '正在画上一张', busy: true };
    const c = useCharacterStore().byId(req.characterId);
    if (!c) return { ok: false, reason: '找不到这个角色' };
    const status = useAiStore().status('image');
    if (!status.live) return { ok: false, reason: `生图 API 还没接通：${status.reason}` };
    const outfit = useRhythmStore().outfitFor(c.id, req.sceneId);
    const locationId = req.locationId ?? c.locationId;
    drawing[k] = { moment: req.moment, stage: 'queued', priority: req.priority };
    delete failures[k];
    try {
      const out = await services.image.illustrate(
        {
          characterId: c.id,
          caption: req.caption,
          use: sceneImageUse(req.sceneId),
          moment: req.moment,
          sceneId: req.sceneId,
          lockOutfit: req.lockOutfit ?? true,
          place: getLocation(locationId)?.name,
          expression: req.expression,
          recent: req.recent,
          ...(req.size ? { size: req.size } : {}),
        },
        {
          priority: req.priority,
          onStage: (stage) => {
            const d = drawing[k];
            if (d) d.stage = stage;
          },
        },
      );
      return { ok: true, out, locationId: locationId ?? null, outfit: outfit?.name ?? null };
    } catch (e) {
      if (isAbortError(e)) return { ok: false, reason: '取消了' };
      failures[k] = { moment: req.moment, reason: errorText(e), detail: errorReport(e) };
      return { ok: false, reason: errorText(e), detail: errorReport(e) };
    } finally {
      delete drawing[k];
    }
  }

  return { items, autoDraw, drawing, failures, hydrate, find, autoCheck, isDrawing, draw, redraw };
});
