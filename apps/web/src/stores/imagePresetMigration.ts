import type { Preset, PromptBlock } from '@app/shared';

/**
 * 生图里以前程序自己加的东西，一次性变成预设里看得见、能改的块（升级 image:all-in-preset）：
 * - 四个程序填充块（角色和外观、地点时间天气表情、最近的对话、要画的画面）换成带宏的普通块；预设里没放、以前由程序补在最后的，补在最后；
 * - "你可以入画"那块（imageCharacters）删掉（程序不再填）；
 * - 各场景拼的画面描述、出图时加的外观衣服和画风词、格式不对时的重写提醒、带不带你立绘的 Vibe：照自带预设的块加进来；
 *   你自己的预设按它负责的用途（配图、心跳、学习……）加那些场景的块；
 * - 立绘以前由程序接在负面词后面的角色负面 tags，变成负面块里的 {{char_negative}}。
 * 以前 API 设置 → 生图风格里的前缀、后缀、负面词和 NovelAI 的质量词、负面预设：出图时不再加，也不写进预设。
 * 块已经在的不重复加；刚放进来的自带预设本来就是新的，不动。
 */

/** 以前的程序填充块 → 换成自带预设里的这几块（后面紧跟着的 cap… 场景块一起） */
const MARKER_GROUPS: Record<string, string[]> = {
  imageSubject: ['imageSubject', 'imageOutfit', 'imageOutfitLocked'],
  imageScene: ['imageScene', 'imageTime', 'imageWeather', 'imageExpression', 'imageSizeLine'],
  imageRecent: ['imageRecent'],
  imageCaption: ['imageCaption'],
};

/** 出图、重写、Vibe 这几块（放在最后） */
const TAIL = ['imageFinal', 'imageFinalNoHumans', 'imageFinalBackground', 'imageNegative', 'imageNegativeBackground', 'imageSizeDefault', 'imageSizeBackground', 'imageRetry', 'imageVibe'];

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** 自带预设里从 id 那块开始的这一组，加上紧跟着的场景块（cap…） */
function seedGroup(seed: Preset, ids: string[]): PromptBlock[] {
  const out: PromptBlock[] = [];
  const at = seed.blocks.findIndex((b) => b.identifier === ids[0]);
  if (at < 0) return out;
  for (const id of ids) {
    const b = seed.blocks.find((x) => x.identifier === id);
    if (b) out.push(clone(b));
  }
  const last = Math.max(...ids.map((id) => seed.blocks.findIndex((b) => b.identifier === id)));
  for (let i = last + 1; i < seed.blocks.length && seed.blocks[i]!.identifier.startsWith('cap'); i++) out.push(clone(seed.blocks[i]!));
  return out;
}

/**
 * 改一个生图预设：primary 是照着改的自带预设（自带的那份是它自己的文件；你自己的是它负责的第一个用途的），
 * others 是它还负责的别的用途的自带预设（加那些场景的块）。改了返回 true
 */
export function moveImageIntoPreset(p: Preset, primary: Preset, others: Preset[]): boolean {
  let changed = false;
  const has = (id: string) => p.blocks.some((b) => b.identifier === id);
  // 1. 程序填充块换成普通块（原来关着的照样关着）；"你可以入画"那块删掉
  const next: PromptBlock[] = [];
  for (const b of p.blocks) {
    if (b.marker && b.identifier === 'imageCharacters') {
      changed = true;
      continue;
    }
    const ids = b.marker ? MARKER_GROUPS[b.identifier] : undefined;
    if (!ids) {
      next.push(b);
      continue;
    }
    const group = seedGroup(primary, ids).filter((g) => g.identifier === b.identifier || !has(g.identifier));
    for (const g of group) next.push({ ...g, enabled: b.enabled && g.enabled });
    changed = true;
  }
  p.blocks = next;
  // 2. 以前程序补在最后的（预设里没放这几块）：补在最后
  for (const [marker, ids] of Object.entries(MARKER_GROUPS)) {
    if (has(marker)) continue;
    p.blocks.push(...seedGroup(primary, ids).filter((g) => !has(g.identifier)));
    changed = true;
  }
  // 3. 它还负责的别的用途的场景块：放在"要画的画面"后面
  for (const seed of others) {
    const extra = seed.blocks.filter((b) => b.identifier.startsWith('cap') && !has(b.identifier)).map(clone);
    if (!extra.length) continue;
    const at = p.blocks.findIndex((b) => b.identifier === 'imageCaption');
    let end = at < 0 ? p.blocks.length : at + 1;
    while (end < p.blocks.length && p.blocks[end]!.identifier.startsWith('cap')) end++;
    p.blocks.splice(end, 0, ...extra);
    changed = true;
  }
  // 4. 出图、重写、Vibe：照自带预设加；Vibe 的触发条件合上它负责的各个场景的
  for (const id of TAIL) {
    if (has(id)) continue;
    const b = primary.blocks.find((x) => x.identifier === id);
    if (!b) continue;
    const add = clone(b);
    if (id === 'imageVibe') {
      const triggers = new Set([...(add.triggers ?? []), ...others.flatMap((s) => s.blocks.find((x) => x.identifier === 'imageVibe')?.triggers ?? [])]);
      add.triggers = [...triggers];
    }
    p.blocks.push(add);
    changed = true;
  }
  return changed;
}

/** 立绘预设：以前由程序接在负面词后面的角色负面 tags，变成负面块里的 {{char_negative}} */
export function moveCharNegativeIntoSprite(p: Preset): boolean {
  let changed = false;
  for (const b of p.blocks) {
    if (b.marker || !b.triggers?.includes('sprite-negative') || b.content.includes('{{char_negative}}')) continue;
    b.content = [b.content.trim().replace(/,+$/, ''), '{{char_negative}}'].filter(Boolean).join(', ');
    changed = true;
  }
  return changed;
}
