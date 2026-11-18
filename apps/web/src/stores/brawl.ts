import { brawlId, starterBrawlFighter, type BrawlDifficulty, type BrawlFighter, type BrawlOwner, type BrawlResult } from '@app/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';

interface Saved { fighters: BrawlFighter[]; results: BrawlResult[]; difficulty: BrawlDifficulty }

export const useBrawlStore = defineStore('brawl', () => {
  const fighters = ref<BrawlFighter[]>([]);
  const results = ref<BrawlResult[]>([]);
  const difficulty = ref<BrawlDifficulty>('normal');
  // 别的设备上的大乱斗（同步）：放进来
  const saver = autoSave('settings', () => [{ key: 'brawl', value: { fighters: fighters.value, results: results.value, difficulty: difficulty.value } satisfies Saved }], () => [fighters.value, results.value, difficulty.value],
    { apply: ([c]) => { if (c && !c.deleted && c.value) load(c.value as Saved); } });

  function load(saved: Saved) {
    fighters.value = saved.fighters;
    results.value = saved.results;
    difficulty.value = saved.difficulty;
  }

  async function hydrate() {
    const saved = await getOne<Saved>('settings', 'brawl');
    if (saved) load(saved);
    saver.start();
  }

  const byId = (id: string) => fighters.value.find(f => f.id === id);
  function ensure(kind: BrawlOwner, ownerId: string, name: string, accent?: string, hairColor?: string, appearance = '') {
    const id = brawlId(kind, ownerId);
    let fighter = byId(id);
    if (!fighter) {
      const starter = starterBrawlFighter(kind, ownerId, name, accent, hairColor);
      starter.look.hair = /ponytail|马尾/i.test(appearance) ? 'pony' : /spiky|翘发/i.test(appearance) ? 'spiky' : /long hair|长发/i.test(appearance) ? 'long' : 'short';
      fighters.value.push(starter);
      fighter = byId(id)!;
    }
    if (fighter.name !== name) fighter.name = name;
    return fighter;
  }
  function save(fighter: BrawlFighter) {
    const copy = JSON.parse(JSON.stringify(fighter)) as BrawlFighter;
    const i = fighters.value.findIndex(f => f.id === fighter.id);
    if (i < 0) fighters.value.push(copy);
    else fighters.value[i] = copy;
  }
  function record(result: BrawlResult) {
    results.value = [result, ...results.value].slice(0, 50);
  }
  return { fighters, results, difficulty, hydrate, byId, ensure, save, record };
});
