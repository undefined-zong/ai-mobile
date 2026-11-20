import { illustrate, samplerRequest } from '@app/ai';
import { assembleTaskPrompt, KINGDOM_OFFICES, kingdomDate, kingdomDynasty, kingdomNpcAge, textFn, type KingdomNpc, type KingdomPortrait, type KingdomRun, type TextFn } from '@app/shared';
import { enqueueImage } from './ai';
import { putAsset } from './assets';
import { MissingPresetError } from './prompt';
import type { IllustrateStage } from './types';
import { useAiStore } from '@/stores/ai';
import { textsFor, useLibraryStore, withTexts } from '@/stores/library';

/** 按键名表把一份数据写成给模型看的 JSON（键名在程序文字 kingdom.key.* 里） */
function keyed(t: TextFn, data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [t(`kingdom.key.${k}`), v]));
}

/** 独立任务提示词不依赖聊天会话，也不会把未加入对局的角色送入王国世界。 */
function kingdomRequest(run: KingdomRun, task: string, input: (t: TextFn) => unknown) {
  const preset = useLibraryStore().presetForUse('game-kingdom');
  if (!preset) throw new MissingPresetError('一起游戏 · 王国模拟');
  const t = textFn(textsFor(preset));
  return {
    ...samplerRequest(preset.sampler),
    messages: assembleTaskPrompt({ preset, type: task, macros: { char: t('kingdom.narrator'), user: run.ruler }, fills: {
      kingdomWorld: JSON.stringify(keyed(t, { name: run.name, ruler: run.ruler, rulerTitle: run.rulerTitle, dynasty: kingdomDynasty(run.dynastyId), setting: run.setting, time: kingdomDate(run),
        stats: run.stats, rulerSkills: run.rulerSkills, factions: run.factions, provinces: run.provinces, policies: run.policies })),
      kingdomTask: JSON.stringify(input(t)),
    } }).messages,
  };
}

export interface KingdomNpcWriting { id: string; name: string; title: string; personality: string; biography: string; appearanceTags: string }
export async function writeKingdomNpcs(run: KingdomRun, npcs: KingdomNpc[], signal: AbortSignal): Promise<KingdomNpcWriting[]> {
  const request = kingdomRequest(run, 'kingdom-npcs', () => npcs.map(n => ({ ...n, portrait: undefined, age: kingdomNpcAge(run, n) })));
  const { value } = await useAiStore().system.json('companion', request, raw => {
    const list = (raw as { npcs?: KingdomNpcWriting[] } | null)?.npcs;
    if (!Array.isArray(list)) return null;
    return list.filter(n => n && typeof n.id === 'string' && typeof n.name === 'string' && typeof n.biography === 'string' && typeof n.appearanceTags === 'string');
  }, { signal });
  return value;
}

export async function writeKingdomChronicle(run: KingdomRun, signal: AbortSignal): Promise<string> {
  const report = run.reports.at(-1);
  const request = kingdomRequest(run, run.result ? 'kingdom-ending' : 'kingdom-quarter', (t) => keyed(t, {
    report, result: run.result,
    people: run.npcs.map(n => ({ name: n.name, role: n.role, title: n.title, personality: n.personality, characterDescription: n.characterDescription, affection: n.affection })),
    heirs: run.heirs, recent: run.reports.slice(-4, -1).map(r => ({ title: r.title, entries: r.entries, narrative: r.narrative })),
  }));
  const { value } = await useAiStore().system.json('companion', request, raw => {
    const narrative = (raw as { narrative?: unknown } | null)?.narrative;
    return typeof narrative === 'string' && narrative.trim() ? narrative.trim() : null;
  }, { signal });
  return value;
}

export async function talkKingdomNpc(run: KingdomRun, npc: KingdomNpc, user: string, signal: AbortSignal): Promise<string> {
  const request = kingdomRequest(run, 'kingdom-talk', (t) => keyed(t, {
    person: { ...npc, portrait: undefined, age: kingdomNpcAge(run, npc) },
    talk: run.conversations.filter(c => c.npcId === npc.id).slice(-6), user,
  }));
  const { value } = await useAiStore().system.json('companion', request, raw => {
    const reply = (raw as { narrative?: unknown } | null)?.narrative;
    return typeof reply === 'string' && reply.trim() ? reply.trim() : null;
  }, { signal });
  return value;
}

/** 使用既有 NovelAI/生图路由、排队和素材库；锁定人物外观与朝代服装，不借用聊天角色的现代衣柜。 */
export async function drawKingdomNpc(run: KingdomRun, npc: KingdomNpc, signal: AbortSignal, onStage: (stage: IllustrateStage) => void): Promise<KingdomPortrait> {
  const dynasty = kingdomDynasty(run.dynastyId);
  const office = KINGDOM_OFFICES.find(o => run.cabinet[o] === npc.id);
  const title = office ? dynasty.offices[office] : npc.title;
  onStage('queued');
  return enqueueImage('user', async () => {
    const preset = useLibraryStore().presetForUse('game-kingdom-image');
    // 画朝代立绘的写法在王国立绘预设的程序文字里（kingdom.portrait.*）
    const t = textFn(textsFor(preset));
    const image = await illustrate(useAiStore().system, {
      mode: 'portrait', moment: 'kingdom-portrait', size: 'portrait',
      character: { name: npc.name, appearanceTags: npc.appearanceTags,
        outfit: { name: t('kingdom.portrait.outfit', { dynasty: dynasty.name, title }), tags: dynasty.clothing } },
      lockOutfit: true,
      caption: t('kingdom.portrait.caption'),
      scene: { place: t('kingdom.portrait.place', { kingdom: run.name, dynasty: dynasty.name }) },
      recent: [t('kingdom.portrait.world', { setting: run.setting }), t('kingdom.portrait.person', { name: npc.name, age: kingdomNpcAge(run, npc), title, personality: npc.personality, biography: npc.biography })],
    }, { preset: withTexts(preset) ?? undefined, signal, onStage });
    const first = image.image.images[0];
    if (!first) throw new Error('生图接口没有返回图片，可以重新生成');
    return { assetKey: first.bytes ? await putAsset(first.bytes, first.mime) : null, url: first.url,
      prompt: image.image.prompt, negative: image.image.negative, seed: image.image.seed, model: image.image.model };
  }, signal);
}
