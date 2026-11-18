import { advanceKingdom, createKingdom, type KingdomRun, type KingdomSetup } from '@app/shared';
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { autoSave, getOne } from '@/db/idb';
import { uid } from '@/utils/id';

interface SavedKingdoms { runs: KingdomRun[]; selectedId: string | null }

export const useKingdomStore = defineStore('kingdom', () => {
  const runs = ref<KingdomRun[]>([]);
  const selectedId = ref<string | null>(null);
  // 别的设备上的王国（同步）：放进来
  const saver = autoSave('settings', () => [{ key: 'kingdom', value: { runs: runs.value, selectedId: selectedId.value } satisfies SavedKingdoms }], () => [runs.value, selectedId.value],
    { apply: ([c]) => { if (c && !c.deleted && c.value) { const v = c.value as SavedKingdoms; runs.value = v.runs; selectedId.value = v.selectedId; } } });
  async function hydrate() {
    const saved = await getOne<SavedKingdoms>('settings', 'kingdom');
    if (saved) { runs.value = saved.runs; selectedId.value = saved.selectedId; }
    saver.start();
  }
  const byId = (id: string | null) => runs.value.find(r => r.id === id);
  async function start(setup: KingdomSetup) {
    const run = createKingdom(setup, uid('kingdom'), crypto.getRandomValues(new Uint32Array(1))[0]!, Date.now());
    runs.value.unshift(run);
    selectedId.value = run.id;
    await saver.flush();
    return byId(run.id)!;
  }
  async function advance(id: string) {
    const index = runs.value.findIndex(r => r.id === id);
    if (index < 0) return;
    runs.value[index] = advanceKingdom(runs.value[index]!, Date.now());
    await saver.flush();
    return runs.value[index];
  }
  return { runs, selectedId, byId, hydrate, start, advance, save: saver.flush };
});
