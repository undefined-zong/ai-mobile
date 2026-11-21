<script setup lang="ts">
import { errorText, isAbortError } from '@app/ai';
import {
  KINGDOM_ACTIONS, KINGDOM_DYNASTIES, KINGDOM_FOCUSES, KINGDOM_METRICS, KINGDOM_OFFICES, KINGDOM_POLICIES, KINGDOM_ROLES, KINGDOM_SCENARIOS, KINGDOM_TURNS,
  appointKingdomMinister, imageAppearance, kingdomAge, kingdomBattleChance, kingdomBuffs, kingdomDate, kingdomDynasty, kingdomLands, kingdomNpcAge,
  kingdomOrderCost, kingdomOrderReason, kingdomQuarterIncome, scoreKingdom, toggleKingdomPolicy,
  type KingdomAction, type KingdomNpc, type KingdomOffice, type KingdomRole,
} from '@app/shared';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import { drawKingdomNpc, talkKingdomNpc, writeKingdomChronicle, writeKingdomNpcs } from '@/services/kingdom';
import { personaOf } from '@/services/prompt';
import { useAiStore } from '@/stores/ai';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useKingdomStore } from '@/stores/kingdom';
import palaceArt from '@/assets/kingdom/palace.webp';
import KingdomCity from './KingdomCity.vue';
import KingdomDialog from './KingdomDialog.vue';
import KingdomMap from './KingdomMap.vue';
import KingdomPerson from './KingdomPerson.vue';

const line = defineModel<string>('line', { required: true });
const phase = defineModel<string>('phase', { required: true });
const emit = defineEmits<{ exit: []; progress: [summary: string | null]; done: [summary: string]; fail: [r: { reason: string; notConnected?: boolean }] }>();
const store = useKingdomStore();
const chars = useCharacterStore();
const ai = useAiStore();
const app = useAppStore();
const router = useRouter();
const run = computed(() => store.byId(store.selectedId));
const view = ref<'saves' | 'setup' | 'reign'>(run.value ? 'reign' : store.runs.length ? 'saves' : 'setup');
const tab = ref('city');
const setupStep = ref(0);
const panelTitles: Record<string, string> = { court: '太极殿', people: '内阁', palace: '后宫', map: '天下舆图', policy: '户部', history: '起居注', study: '御书房', report: '四时纪事' };
const panelCaptions: Record<string, string> = { court: '临朝听政 · 朱批奏折', people: '任贤使能 · 共理山河', palace: '宫墙深处 · 一世相伴', map: '十二州山河 · 金戈铁马', policy: '计天下之利 · 定一朝之策', history: '秉笔直书 · 留名青史', study: '为君之道 · 修身养性', report: '四时递嬗 · 史官呈报' };
const skillNames = { politics: '政治', technology: '科技', culture: '文化' };
const draft = reactive({ dynastyId: 'tang', scenarioId: 'balanced', name: '', ruler: personaOf(undefined).name, rulerTitle: '皇帝', era: '启元', setting: '' });
const participants = reactive<Record<string, KingdomRole | ''>>({});
const aiOpening = ref(ai.isLive('companion'));
const aiNarrative = ref(false);
const dynasty = computed(() => kingdomDynasty(run.value?.dynastyId ?? draft.dynastyId));
const busy = ref('');
const problem = ref('');
const stepping = ref(false);
const viewNpcId = ref('');
const viewNpc = computed(() => run.value?.npcs.find(n => n.id === viewNpcId.value));
const talkText = ref('');
const talks = computed(() => run.value?.conversations.filter(t => t.npcId === viewNpcId.value).slice(-6) ?? []);
const latest = computed(() => run.value?.reports.at(-1));
const buffs = computed(() => run.value ? kingdomBuffs(run.value) : []);
const income = computed(() => run.value ? kingdomQuarterIncome(run.value) : null);
const cost = computed(() => run.value ? kingdomOrderCost(run.value) : null);
const orderReason = computed(() => run.value ? kingdomOrderReason(run.value) : '');
const selectedProvince = computed(() => run.value?.provinces.find(p => p.id === run.value!.plan.targetProvince));
const ministers = computed(() => run.value?.npcs.filter(n => n.role === 'minister') ?? []);
const consorts = computed(() => run.value?.npcs.filter(n => n.role === 'consort') ?? []);
const foreigners = computed(() => run.value?.npcs.filter(n => n.role === 'foreign') ?? []);
const estimate = computed(() => run.value ? (run.value.result ?? scoreKingdom(run.value)) : null);
const focus = computed(() => KINGDOM_FOCUSES.find(f => f.id === run.value?.plan.focus));
const action = computed(() => KINGDOM_ACTIONS.find(a => a.id === run.value?.plan.action));
const policyExpense = computed(() => run.value?.policies.reduce((s, id) => s + (KINGDOM_POLICIES.find(p => p.id === id)?.cost ?? 0), 0) ?? 0);
const statText = (n: number) => Number(n.toFixed(1)).toLocaleString('zh-CN');
const deltaText = (n = 0) => `${n > 0 ? '+' : ''}${statText(n)}`;
let controller: AbortController | null = null;
onBeforeUnmount(() => { controller?.abort(); void store.save(); });
watch([run, view], () => {
  line.value = '';
  phase.value = view.value === 'reign' && run.value ? run.value.result ? 'ended' : 'playing' : 'menu';
  const r = run.value;
  emit('progress', r && view.value === 'reign' && r.npcs.some(n => n.characterId === app.activeCharacterId)
    ? `王国模拟「${r.name}」（${kingdomAge(r)}岁，${kingdomLands(r).length}州）` : null);
}, { immediate: true, deep: true });

async function task(label: string, work: (signal: AbortSignal) => Promise<void>) {
  if (busy.value) return;
  problem.value = '';
  busy.value = label;
  controller = new AbortController();
  try { await work(controller.signal); }
  catch (e) { if (!isAbortError(e)) problem.value = errorText(e); }
  finally { busy.value = ''; controller = null; }
}
async function begin() {
  if (stepping.value) return;
  stepping.value = true;
  problem.value = '';
  try {
    await store.start({ ...draft, participants: chars.list.filter(c => participants[c.id]).map(c => ({
      characterId: c.id, name: c.name, role: participants[c.id] as KingdomRole,
      description: [c.card.description, c.card.personality, c.card.scenario].filter(Boolean).join('\n'),
      appearanceTags: imageAppearance(c), gender: c.pronoun === '他' ? 'male' : 'female',
    })) });
    view.value = 'reign'; tab.value = 'city';
  } catch (e) { problem.value = errorText(e); }
  finally { stepping.value = false; }
  if (run.value && view.value === 'reign' && aiOpening.value && ai.isLive('companion')) await generatePeople();
}
function openRun(id: string) { store.selectedId = id; view.value = 'reign'; tab.value = 'city'; problem.value = ''; }
function officeOf(npc: KingdomNpc) {
  const key = KINGDOM_OFFICES.find(o => run.value?.cabinet[o] === npc.id);
  return key ? dynasty.value.offices[key] : '';
}
function chooseAction(id: KingdomAction) {
  const r = run.value!;
  r.plan.action = id;
  if (['farm', 'trade'].includes(id) && selectedProvince.value?.owner !== 'player') r.plan.targetProvince = kingdomLands(r)[0]!.id;
}
function selectProvince(id: string) {
  const r = run.value!;
  r.plan.targetProvince = id;
  const p = r.provinces.find(p => p.id === id)!;
  r.plan.action = p.owner === 'player' ? 'farm' : 'war';
}
function appoint(office: KingdomOffice, event: Event) {
  appointKingdomMinister(run.value!, office, (event.target as HTMLSelectElement).value);
}
function designate(id: string) { for (const h of run.value!.heirs) h.designated = h.id === id; }
async function nextQuarter() {
  const r = run.value;
  if (!r || stepping.value || busy.value || orderReason.value) return;
  stepping.value = true; problem.value = '';
  try {
    const next = await store.advance(r.id);
    if (next && !next.result) tab.value = 'report';
    if (next?.result && next.npcs.some(n => n.characterId === app.activeCharacterId)) emit('done', `王国模拟「${next.name}」：${next.result.title}，${next.result.score}分`);
  } catch (e) { problem.value = errorText(e); }
  finally { stepping.value = false; }
  if (aiNarrative.value && ai.isLive('companion')) await narrate();
}
async function generatePeople(npc?: KingdomNpc) {
  const r = run.value;
  if (!r) return;
  await task('正在写朝代人物', async signal => {
    const results = await writeKingdomNpcs(r, npc ? [npc] : r.npcs, signal);
    const current = store.byId(r.id)!;
    for (const result of results) {
      const person = current.npcs.find(n => n.id === result.id);
      if (!person) continue;
      if (!person.characterId) { person.name = result.name; person.appearanceTags = result.appearanceTags; }
      if (typeof result.title === 'string') person.title = result.title;
      if (typeof result.personality === 'string') person.personality = result.personality;
      person.biography = result.biography;
    }
    await store.save();
  });
}
async function narrate() {
  const r = run.value;
  const report = r?.reports.at(-1);
  if (!r || !report) return;
  await task(r.result ? '史官正在评定一生' : '史官正在记述本季', async signal => {
    const text = await writeKingdomChronicle(r, signal);
    store.byId(r.id)!.reports.find(h => h.turn === report.turn)!.narrative = text;
    await store.save();
  });
}
async function draw(npc: KingdomNpc) {
  const r = run.value!;
  await task('立绘排队中', async signal => {
    const portrait = await drawKingdomNpc(r, npc, signal, stage => {
      busy.value = { queued: '立绘排队中', prompt: '正在写立绘提示词', image: '正在生成朝代立绘' }[stage];
    });
    store.byId(r.id)!.npcs.find(n => n.id === npc.id)!.portrait = portrait;
    await store.save();
  });
}
async function talk() {
  const r = run.value!; const npc = viewNpc.value; const user = talkText.value.trim();
  if (!npc || !user) return;
  await task(`${npc.name}正在回应`, async signal => {
    const reply = await talkKingdomNpc(r, npc, user, signal);
    store.byId(r.id)!.conversations.push({ npcId: npc.id, turn: r.turn, user, reply });
    talkText.value = '';
    await store.save();
  });
}
</script>

<template>
  <div class="kingdom" data-game="kingdom">
    <div v-if="busy" class="status floating" role="status"><span class="i-lucide-loader-circle spin" /><span>{{ busy }}…</span><button type="button" @click="controller?.abort()">取消</button></div>
    <div v-if="problem" class="problem floating" role="alert"><span>{{ problem }}</span><button type="button" @click="problem = ''" aria-label="关闭提示"><span class="i-lucide-x" /></button></div>

    <template v-if="view !== 'reign'">
      <div class="opening-art" :style="{ backgroundImage: `url(${palaceArt})` }"><button type="button" class="opening-back" aria-label="返回游戏列表" @click="emit('exit')"><span class="i-lucide-chevron-left" /></button><div class="game-title"><small>一 纸 诏 书 · 四 十 二 载</small><h1>帝 业</h1><p>王 国 模 拟</p></div><span class="red-seal">御<br />览</span></div>
      <section v-if="view === 'saves'" class="opening-paper scroll">
        <div class="section-title"><h2>王朝旧事</h2><button type="button" class="text-button" @click="setupStep = 0; view = 'setup'">另起一朝</button></div>
        <button v-for="r in store.runs" :key="r.id" type="button" class="save-row" @click="openRun(r.id)"><span class="save-seal">{{ r.name.slice(0, 1) }}</span><span><strong>{{ r.name }} · {{ r.ruler }}</strong><small>{{ kingdomDynasty(r.dynastyId).name }} · {{ kingdomDate(r) }} · {{ kingdomAge(r) }} 岁</small><small>{{ r.result ? `${r.result.title} · ${r.result.score} 分` : `${kingdomLands(r).length} 州 · 国库 ${statText(r.stats.treasury)} 万两` }}</small></span><span class="i-lucide-chevron-right" /></button>
        <p v-if="!store.runs.length" class="muted">十八岁初登大位，四十二载功业由你写下。</p>
      </section>
      <form v-else class="opening-paper setup" @submit.prevent="setupStep < 2 ? setupStep++ : begin()">
        <nav class="setup-steps" aria-label="开朝步骤"><button v-for="(step, i) in ['择一时代', '立国登基', '人物入局']" :key="step" type="button" :class="{ current: setupStep === i }" :aria-current="setupStep === i ? 'step' : undefined" @click="setupStep = i"><span>{{ ['壹', '贰', '叁'][i] }}</span>{{ step }}</button></nav>
        <div class="scroll setup-content">
          <template v-if="setupStep === 0">
            <div class="section-title"><h2>江山待君临</h2><button v-if="store.runs.length" type="button" class="text-button" @click="view = 'saves'">续写旧朝</button></div>
            <p class="muted">十八岁登基，一季一回合，六十岁定一生功业。</p>
            <label class="form-label">选择时代<select v-model="draft.dynastyId" class="field"><option v-for="d in KINGDOM_DYNASTIES" :key="d.id" :value="d.id">{{ d.name }}</option></select></label>
            <p class="dynasty-description">{{ kingdomDynasty(draft.dynastyId).setting }}</p>
            <h3 class="chapter-title">开局篇章</h3>
            <div class="scenario-list"><label v-for="(s, i) in KINGDOM_SCENARIOS" :key="s.id" class="scenario" :class="{ chosen: draft.scenarioId === s.id }"><input v-model="draft.scenarioId" type="radio" :value="s.id" name="kingdom-scenario" /><span class="scenario-number">{{ ['壹', '贰', '叁', '肆'][i] }}</span><span><strong>{{ s.name }}</strong><small>{{ s.description }}</small></span><span v-if="draft.scenarioId === s.id" class="chosen-seal">选</span></label></div>
          </template>
          <template v-else-if="setupStep === 1">
            <h2>承天命，启新朝</h2><p class="muted">国号与年号，将记在往后的每一季史册上。</p>
            <div class="form-pair"><label>君主姓名<input v-model="draft.ruler" class="field" placeholder="新君" /></label><label>君主称谓<select v-model="draft.rulerTitle" class="field"><option>皇帝</option><option>国王</option><option>统领</option></select></label></div>
            <div class="form-pair"><label>国号<input v-model="draft.name" class="field" :placeholder="draft.dynastyId === 'fantasy' ? '云岚' : kingdomDynasty(draft.dynastyId).name" /></label><label>年号<input v-model="draft.era" class="field" placeholder="启元" /></label></div>
            <label class="form-label">你的天下<textarea v-model="draft.setting" class="field area" rows="4" placeholder="可补充架空世界、礼制与人物风格；留空采用所选朝代背景" /></label>
            <p class="footnote">朝代决定人物、官职和服饰风格。人物与十二州山河为架空演绎。</p>
          </template>
          <template v-else>
            <h2>谁与你共此江山</h2><p class="muted">可让已有角色入朝、入宫或成为他国人物。全部选择「不加入」，也能独自开局。</p>
            <label v-for="c in chars.list" :key="c.id" class="participant"><span>{{ c.name }}</span><select :value="participants[c.id] ?? ''" class="field" :aria-label="`${c.name}在王国中的身份`" @change="participants[c.id] = ($event.target as HTMLSelectElement).value as KingdomRole | ''"><option value="">不加入</option><option v-for="(label, role) in KINGDOM_ROLES" :key="role" :value="role">{{ label }}</option></select></label>
            <p v-if="!chars.list.length" class="empty-verse">百官待诏，宫人初至。<br />新的人物会随这座王朝一同诞生。</p>
            <label class="toggle"><input v-model="aiOpening" type="checkbox" :disabled="!ai.isLive('companion')" />由 AI 创作开局人物设定</label>
            <p class="muted">{{ ai.isLive('companion') ? '采用「王国模拟」预设，保留入局角色的外貌与性格。' : '直接开局即可获得朝代人物；配置陪伴 API 后可扩写人物与交谈。' }}</p>
            <div class="accession-note"><span>十八</span><div>岁，初登大位<small>一百六十八季，写下你的帝王一生。</small></div></div>
          </template>
        </div>
        <footer class="setup-footer"><button v-if="setupStep" type="button" class="secondary" @click="setupStep--">上一步</button><button type="submit" class="primary" :disabled="stepping || !!busy">{{ stepping ? '正在开朝…' : setupStep === 2 ? '登 基' : '继续' }}<span class="i-lucide-arrow-right" /></button></footer>
      </form>
    </template>

    <template v-else-if="run">
      <header class="royal-hud">
        <div class="sovereign"><button type="button" class="hud-back" aria-label="返回游戏列表" @click="emit('exit')"><span class="i-lucide-chevron-left" /></button><button type="button" class="dynasty-seal" aria-label="查看王朝存档" @click="view = 'saves'">{{ run.name.slice(0, 2) }}</button><div class="ruler-name"><strong>{{ run.ruler }}<small>{{ run.rulerTitle }}</small></strong><span>{{ kingdomAge(run) }} 岁 · {{ kingdomLands(run).length }} 州山河</span></div><div class="reign-date"><strong>{{ run.result ? '功业已定' : kingdomDate(run) }}</strong><span>{{ run.result ? '四十二载，留名青史' : `在位第 ${Math.floor(run.turn / 4) + 1} 年` }}</span></div><button type="button" class="hud-archive" aria-label="查看王朝存档" @click="view = 'saves'"><span class="i-lucide-scroll-text" /></button></div>
        <div class="resource-bar"><button v-for="m in KINGDOM_METRICS.slice(0, 4)" :key="m.id" type="button" @click="tab = m.id === 'troops' ? 'map' : 'policy'"><small>{{ m.name }}</small><strong>{{ statText(run.stats[m.id]) }}<em>{{ m.unit }}</em></strong></button></div>
      </header>
      <div v-if="run.result && estimate" class="scroll ending parchment">
        <div class="ending-title"><span class="i-lucide-crown" /><h3>{{ run.result.title }}</h3><strong>{{ run.result.score }}<small> / 1000</small></strong><p>四十二载 · {{ run.turn }} 季 · {{ kingdomLands(run).length }} 州</p></div>
        <p class="muted">十一项各 100 分，平均折算为千分制。后宫按人数与亲密计分，子嗣按人数与教育计分。</p>
        <div v-for="d in run.result.dimensions" :key="d.label" class="score-row"><span>{{ d.label }}</span><span>{{ d.value }}</span><strong>{{ d.points }}<small> / 100</small></strong></div>
        <h3>这一生的成就</h3>
        <div v-for="a in run.result.achievements" :key="a.name" class="achievement"><span class="i-lucide-award" /><div><strong>{{ a.name }}</strong><p>{{ a.description }}</p></div></div>
        <p v-if="latest?.narrative" class="narrative">{{ latest.narrative }}</p>
        <button type="button" class="secondary wide" :disabled="!!busy || !ai.isLive('companion')" @click="narrate">{{ latest?.narrative ? '重写史官评语' : '请史官写一生评语' }}</button>
        <details class="ending-history"><summary>查看四十二年史册</summary><article v-for="h in [...run.reports].reverse()" :key="h.turn" class="report"><h4>{{ h.title }}</h4><p v-for="(e, i) in h.entries" :key="i">{{ e }}</p></article></details>
        <div class="form-pair"><button type="button" class="secondary" @click="view = 'saves'">回王朝存档</button><button type="button" class="primary" @click="view = 'setup'">再起一朝</button></div>
      </div>


      <template v-else>
        <KingdomCity :season="run.turn % 4" :event="run.event.title" :buffs="buffs.map(b => b.name)" @enter="tab = $event" />
        <footer class="royal-footer">
          <nav class="desk-tools" aria-label="御前事务"><button type="button" @click="tab = 'court'"><span class="i-lucide-scroll-text" />奏折<small>壹</small></button><button type="button" @click="tab = 'study'"><span class="i-lucide-book-open" />修养</button><button type="button" @click="tab = 'policy'"><span class="i-lucide-landmark" />国势</button><button type="button" @click="tab = 'history'"><span class="i-lucide-feather" />史册</button></nav>
          <p v-if="orderReason" class="order-reason">{{ orderReason }}</p>
          <div class="turn-row"><button type="button" class="current-order" @click="tab = 'court'"><small>本季旨意</small><strong>{{ action?.name }}</strong><span>{{ focus?.name }} · {{ cost?.treasury }} 万两</span></button><button type="button" class="decree-button" :disabled="!!orderReason || stepping || !!busy" @click="nextQuarter"><span class="decree-seal">敕</span><span>{{ stepping ? '四时流转…' : run.turn === KINGDOM_TURNS - 1 ? '合卷 · 评功业' : '下诏 · 过一季' }}<small>{{ run.turn === KINGDOM_TURNS - 1 ? '六十岁，留名青史' : '朝政既定，四时轮转' }}</small></span></button></div>
        </footer>
        <KingdomDialog v-if="tab !== 'city'" :title="panelTitles[tab] ?? '宫城'" :caption="panelCaptions[tab]" @close="tab = 'city'">
          <template v-if="tab === 'court'">
            <div class="memorial-heading"><span class="memorial-seal">御前奏报</span><small>{{ kingdomDate(run) }}</small><h3>{{ run.event.title }}</h3></div>
            <p class="event-text">{{ run.event.text }}</p>
            <label v-for="(c, i) in run.event.choices" :key="i" class="event-choice" :class="{ chosen: run.eventChoice === i }"><input v-model="run.eventChoice" type="radio" :value="i" name="kingdom-event" /><span>{{ c.label }}</span><b v-if="run.eventChoice === i">准</b></label>
            <h3 class="chapter-title"><span>贰</span> 拟定政务</h3>
            <div class="action-grid"><button v-for="a in KINGDOM_ACTIONS" :key="a.id" type="button" :class="{ on: run.plan.action === a.id }" :aria-pressed="run.plan.action === a.id" @click="chooseAction(a.id)">{{ a.name }}<small>{{ a.cost }} 万两</small></button></div>
            <p class="effect">{{ action?.description }}</p>
            <label v-if="run.plan.action === 'farm' || run.plan.action === 'trade'" class="form-label">经营州郡<select v-model="run.plan.targetProvince" class="field"><option v-for="p in kingdomLands(run)" :key="p.id" :value="p.id">{{ p.name }} · 发展 {{ p.development }}</option></select></label>
            <label v-if="run.plan.action === 'diplomacy'" class="form-label">出使国家<select v-model="run.plan.targetFaction" class="field"><option v-for="f in run.factions.filter(f => run!.provinces.some(p => p.owner === f.id))" :key="f.id" :value="f.id">{{ f.name }} · 关系 {{ f.relation }}</option></select></label>
            <button v-if="run.plan.action === 'war'" type="button" class="secondary wide" @click="tab = 'map'">{{ selectedProvince?.owner !== 'player' ? `出征 ${selectedProvince?.name} · 调整兵力与战术` : '前往疆域选择出征目标' }}<span class="i-lucide-arrow-right" /></button>
          </template>

          <template v-else-if="tab === 'people'">
            <div class="section-title"><h3>任贤使能</h3><button type="button" class="text-button" :disabled="!!busy || !ai.isLive('companion')" @click="generatePeople()">AI 写人物</button></div>
            <p class="muted">每人担任一职。才能与忠诚共同影响季度收入、科技、文化和出征战力。</p>
            <label v-for="o in KINGDOM_OFFICES" :key="o" class="appointment"><span>{{ dynasty.offices[o] }}</span><select :value="run.cabinet[o]" class="field" :aria-label="`任命${dynasty.offices[o]}`" @change="appoint(o, $event)"><option value="">暂缺</option><option v-for="n in ministers" :key="n.id" :value="n.id">{{ n.name }} · 忠诚 {{ Math.round(n.loyalty) }}</option></select></label>
            <KingdomPerson v-for="n in ministers" :key="n.id" :npc="n" :run="run" :office="officeOf(n)" @select="viewNpcId = n.id" />
            <button type="button" class="secondary wide" @click="chooseAction('talent'); tab = 'court'">安排本季访求贤才</button>
          </template>

          <template v-else-if="tab === 'palace'">
            <div class="section-title"><h3>宫苑相伴</h3><span class="muted">{{ consorts.length }} 位知己 · {{ run.heirs.length }} 位子嗣</span></div>
            <p class="muted">安排一季相伴可增进亲密，亲密达到 50 后有机会迎来家族喜讯。子嗣在三季后降生。</p>
            <div class="portrait-gallery"><KingdomPerson v-for="n in consorts" :key="n.id" :npc="n" :run="run" gallery @select="viewNpcId = n.id" /></div>
            <button type="button" class="secondary wide" @click="chooseAction('visit'); tab = 'court'">安排本季宫廷雅集</button>
            <h3>子嗣与储君</h3><p v-if="!run.heirs.length" class="muted">尚无子嗣。与宫中知己相伴，家族的故事会随季度展开。</p>
            <article v-for="h in run.heirs" :key="h.id" class="heir"><div class="section-title"><strong>{{ h.name }} · {{ Math.floor((run.turn - h.bornTurn) / 4) }} 岁</strong><button type="button" class="secondary" :class="{ on: h.designated }" @click="designate(h.id)">{{ h.designated ? '已立储君' : '立为储君' }}</button></div><p>{{ run.npcs.find(n => n.id === h.parentId)?.name }}所育 · {{ h.gender === 'female' ? '皇女' : '皇子' }}</p><p>政 {{ Math.round(h.education.politics) }} · 军 {{ Math.round(h.education.military) }} · 科 {{ Math.round(h.education.technology) }} · 文 {{ Math.round(h.education.culture) }}</p></article>
            <button v-if="run.heirs.length" type="button" class="secondary wide" @click="run.plan.focus = 'education'; tab = 'study'">本季亲授子嗣</button>
          </template>

          <template v-else-if="tab === 'map'">
            <div class="section-title"><h3>十二州天下</h3><span class="muted">已领 {{ kingdomLands(run).length }} / 12 州</span></div>
            <KingdomMap :run="run" @select="selectProvince" />
            <template v-if="selectedProvince">
              <h3>{{ selectedProvince.name }} · {{ selectedProvince.owner === 'player' ? '本国州郡' : run.factions.find(f => f.id === selectedProvince?.owner)?.name }}</h3>
              <div v-if="selectedProvince.owner === 'player'"><p class="muted">发展 {{ selectedProvince.development }}，每点发展增加税收与粮食产出。</p><div class="form-pair"><button type="button" class="secondary" :class="{ on: run.plan.action === 'farm' }" @click="chooseAction('farm')">兴修农田</button><button type="button" class="secondary" :class="{ on: run.plan.action === 'trade' }" @click="chooseAction('trade')">发展商贸</button></div></div>
              <template v-else>
                <label class="form-label">出征兵力 · {{ run.plan.troops }} 万 / 可用 {{ statText(run.stats.troops) }} 万<input v-model.number="run.plan.troops" type="range" min="1" :max="Math.max(1, Math.floor(run.stats.troops))" step="1" /></label>
                <label class="form-label">战术<select v-model="run.plan.tactic" class="field"><option value="balanced">稳扎稳打 · 均衡</option><option value="assault">急攻 · 战力 +18%，伤亡 +30%</option><option value="siege">围城 · 山地水网 +20%，平原 −5%</option></select></label>
                <p class="effect">预计胜率 {{ Math.round(kingdomBattleChance(run) * 100) }}% · 出征耗粮 {{ cost?.grain }} 万石</p>
                <p class="muted">胜负由兵力、将领、科技、地形、战术与国势共同决定。胜利收取该州，失败退兵；敌对国家也会袭扰边境。</p>
              </template>
            </template>
            <h3>邻国与外交</h3>
            <div v-for="f in run.factions" :key="f.id" class="faction"><div><strong>{{ f.name }}</strong><p>{{ run.provinces.filter(p => p.owner === f.id).length }} 州 · 关系 {{ f.relation }}<template v-if="f.truceUntil > run.turn"> · 停战余 {{ f.truceUntil - run.turn }} 季</template></p></div><button type="button" class="secondary" :disabled="!run.provinces.some(p => p.owner === f.id)" @click="run.plan.targetFaction = f.id; chooseAction('diplomacy'); tab = 'court'">遣使</button></div>
            <KingdomPerson v-for="n in foreigners" :key="n.id" :npc="n" :run="run" @select="viewNpcId = n.id" />
          </template>

          <template v-else-if="tab === 'policy'">
            <div class="state-metrics"><div v-for="m in KINGDOM_METRICS.slice(4)" :key="m.id"><small>{{ m.name }}</small><strong>{{ statText(run.stats[m.id]) }}</strong></div></div><h3>当朝国策</h3><p class="muted">选中的国策每季生效。轻徭薄赋与重税互斥；其余可组合，留意持续开支。</p>
            <label v-for="p in KINGDOM_POLICIES" :key="p.id" class="policy"><input type="checkbox" :checked="run.policies.includes(p.id)" @change="toggleKingdomPolicy(run, p.id)" /><span><strong>{{ p.name }}<small>{{ p.cost ? `每季拨款 ${p.cost} 万两` : '无固定拨款' }}</small></strong><span>{{ p.description }}</span></span></label>
            <div v-if="income" class="ledger"><h3>季度收支底账</h3><p>税收与治理收入 <strong>+{{ statText(income.income) }} 万两</strong></p><p>军饷与朝廷支出 <strong>−{{ statText(income.expense) }} 万两</strong></p><p>国策固定拨款 <strong>−{{ policyExpense }} 万两</strong></p><p>粮食产消净额 <strong>{{ deltaText(income.grain) }} 万石</strong></p><small>另计当季政务、国策效果、奏报与国势；实际变化见每季结算。</small></div>
            <h3>当朝国势</h3><p v-if="!buffs.length" class="muted">暂无生效国势。高民生与稳定可获「国泰民安」；科技 200、文化 220、领土 8 州也会开启对应国势。</p>
            <article v-for="b in buffs" :key="b.id" class="buff"><strong><span class="i-lucide-sparkles" />{{ b.name }}<small>{{ b.remaining < 0 ? '条件持续' : `余 ${b.remaining} 季` }}</small></strong><p>{{ b.description }}</p><small>{{ b.source }}</small></article>
          </template>

          <template v-else-if="tab === 'history'">
            <div class="section-title"><h3>起居注</h3><button type="button" class="text-button" @click="router.push('/me/presets')">功能预设</button></div>
            <p class="muted">已历 {{ run.turn }} 季，距六十岁还有 {{ KINGDOM_TURNS - run.turn }} 季。当前功业 {{ estimate?.score }} / 1000。</p>
            <details><summary>查看当前功业分项</summary><div v-for="d in estimate?.dimensions" :key="d.label" class="score-row"><span>{{ d.label }}</span><span>{{ d.value }}</span><strong>{{ d.points }}/100</strong></div></details>
            <label class="toggle"><input v-model="aiNarrative" type="checkbox" :disabled="!ai.isLive('companion')" />每季请 AI 写一段史记</label>
            <button v-if="latest" type="button" class="secondary wide" :disabled="!!busy || !ai.isLive('companion')" @click="narrate">为最近一季书写纪事</button>
            <p v-if="!ai.isLive('companion')" class="muted">已保存的季度记录可离线阅读。<button type="button" class="text-button" @click="router.push('/me/api?feature=companion')">配置陪伴 API</button></p>
            <p v-if="!run.reports.length" class="muted">初登大位，史册待书。处理本季奏报并安排政务，即可推进第一季。</p>
            <article v-for="h in [...run.reports].reverse()" :key="h.turn" class="report"><h4>{{ h.title }}</h4><p v-for="(e, i) in h.entries" :key="i">{{ e }}</p><p v-if="h.battle" class="effect">{{ h.battle.won ? '战胜' : '战败' }} · 战前胜率 {{ Math.round(h.battle.chance * 100) }}%</p><div class="delta-list"><span v-for="m in KINGDOM_METRICS" :key="m.id" :class="(h.delta[m.id] ?? 0) < 0 ? 'negative' : 'positive'">{{ m.name }} {{ deltaText(h.delta[m.id]) }}</span></div><p v-if="h.narrative" class="narrative">{{ h.narrative }}</p></article>
          </template>

          <template v-else-if="tab === 'study'">
            <div class="cultivation"><div v-for="(name, key) in skillNames" :key="key"><span>{{ name }}</span><strong>{{ run.rulerSkills[key] }}</strong><small>/ 一百</small><div class="skill-track"><i :style="{ width: `${run.rulerSkills[key]}%` }" /></div></div></div>
            <h3>本季起居</h3><p class="muted">选一项亲自践行。与朝廷政务一同在季度结束时生效。</p>
            <label v-for="f in KINGDOM_FOCUSES" :key="f.id" class="study-choice" :class="{ chosen: run.plan.focus === f.id }"><input v-model="run.plan.focus" type="radio" :value="f.id" name="kingdom-focus" /><span><strong>{{ f.name }}</strong><small>{{ f.description }}</small></span><b v-if="run.plan.focus === f.id">定</b></label>
            <label v-if="run.plan.focus === 'audience' || run.plan.focus === 'palace'" class="form-label">召见何人<select v-model="run.plan.targetNpc" class="field"><option value="">{{ run.plan.focus === 'audience' ? '首位大臣' : '首位后宫' }}</option><option v-for="n in run.plan.focus === 'audience' ? ministers : consorts" :key="n.id" :value="n.id">{{ n.name }}</option></select></label>
          </template>
          <template v-else-if="tab === 'report' && latest">
            <div class="memorial-heading"><span class="memorial-seal">史官记</span><small>四时轮转，万象更新</small><h3>{{ latest.title }}</h3></div>
            <div v-if="latest.battle" class="battle-result" :class="{ won: latest.battle.won }"><span class="i-lucide-swords" /><strong>{{ latest.battle.won ? '捷报传来' : '鸣金收兵' }}</strong><small>战前胜率 {{ Math.round(latest.battle.chance * 100) }}%</small></div>
            <ol class="season-entries"><li v-for="(entry, i) in latest.entries" :key="i">{{ entry }}</li></ol>
            <div class="season-deltas"><div v-for="m in KINGDOM_METRICS" :key="m.id"><small>{{ m.name }}</small><strong :class="(latest.delta[m.id] ?? 0) < 0 ? 'negative' : 'positive'">{{ deltaText(latest.delta[m.id]) }}</strong></div></div>
            <p v-if="latest.narrative" class="narrative">{{ latest.narrative }}</p><p class="season-next">{{ kingdomDate(run) }} · {{ kingdomAge(run) }} 岁</p>
          </template>
          <template #footer><button type="button" class="primary wide" @click="tab = 'city'">{{ tab === 'report' ? '朕知道了 · 返回宫城' : '返回宫城' }}<span class="i-lucide-arrow-right" /></button></template>
        </KingdomDialog>
      </template>
    </template>

    <KingdomDialog v-if="viewNpc && run" :title="viewNpc.name" :caption="`${officeOf(viewNpc) || viewNpc.title} · ${kingdomNpcAge(run, viewNpc)} 岁`" @close="viewNpcId = ''">
      <div class="portrait-stage" :class="viewNpc.role"><AssetImg v-if="viewNpc.portrait" :asset-key="viewNpc.portrait.assetKey" :url="viewNpc.portrait.url" :alt="`${viewNpc.name}立绘`" /><div v-else class="unpainted"><span>{{ viewNpc.name }}</span><small>丹青待绘</small><button type="button" class="secondary" :disabled="!!busy || !ai.isLive('image')" @click="draw(viewNpc)">绘制此人</button></div><span class="portrait-inscription">{{ viewNpc.personality }}</span></div>
      <div class="person-attributes"><span v-for="(name, key) in { politics: '政', military: '军', technology: '科', culture: '文' }" :key="key">{{ name }}<strong>{{ viewNpc.skills[key] }}</strong></span><span>{{ viewNpc.role === 'consort' ? '亲密' : '忠诚' }}<strong>{{ Math.round(viewNpc.role === 'consort' ? viewNpc.affection : viewNpc.loyalty) }}</strong></span></div>
      <p class="biography">{{ viewNpc.biography }}</p>
      <div v-if="!run.result && viewNpc.role !== 'foreign'" class="npc-action"><button type="button" class="primary wide" @click="run.plan.focus = viewNpc.role === 'minister' ? 'audience' : 'palace'; run.plan.targetNpc = viewNpc.id; viewNpcId = ''; tab = 'study'">{{ viewNpc.role === 'minister' ? '本季召见议政' : '本季与其相伴' }}</button></div>
      <div class="form-pair"><button type="button" class="secondary" :disabled="!!busy || !ai.isLive('image')" @click="draw(viewNpc)">{{ viewNpc.portrait ? '重绘立绘' : 'NovelAI 绘像' }}</button><button type="button" class="secondary" :disabled="!!busy || !ai.isLive('companion')" @click="generatePeople(viewNpc)">扩写人物</button></div>
      <p v-if="busy" class="status" role="status">{{ busy }}…<button type="button" @click="controller?.abort()">取消</button></p><p v-if="problem" class="problem" role="alert">{{ problem }}</p>
      <p v-if="!ai.isLive('image')" class="muted">配置 NovelAI 后，可绘制符合朝代的专属立绘。<button type="button" class="text-button" @click="router.push('/me/api?feature=image')">生图设置</button></p>
      <h3>御前叙话</h3><p class="muted">聊朝政、家事与志向；相处的数值收益在季度结算时生效。</p>
      <div v-for="(t, i) in talks" :key="i" class="talk"><p class="your-words">{{ run.ruler }}：{{ t.user }}</p><p>{{ viewNpc.name }}：{{ t.reply }}</p></div>
      <form class="talk-form" @submit.prevent="talk"><input v-model="talkText" class="field" :aria-label="`对${viewNpc.name}说的话`" placeholder="卿有何见解？" :disabled="!ai.isLive('companion')" /><button type="submit" class="primary" :disabled="!!busy || !talkText.trim() || !ai.isLive('companion')">交谈</button></form>
      <button v-if="!ai.isLive('companion')" type="button" class="text-button" @click="router.push('/me/api?feature=companion')">配置陪伴 API 后即可交谈</button>
    </KingdomDialog>
  </div>
</template>
<style scoped>
.kingdom {
  --paper: #f2e8cf; --ink: #473827; --ink-2: #7d6b51; --border: #d1be94; --panel: #e9dcbd;
  --accent: #923e30; --accent-ink: #8d382b; --accent-soft: #e6d2af; --accent-line: #ac8150; --on-accent: #fff1d2;
  --good: #426f57; --bad: #a04232; --warn: #b75c36; --bg: #f2e8cf;
  --royal-serif: 'Songti SC', 'STSong', 'Noto Serif SC', 'SimSun', serif;
  --font-serif: var(--royal-serif);
  position: relative; display: flex; flex: 1; flex-direction: column; min-height: 0; overflow: hidden;
  background: #28352e; color: var(--ink); font-size: 14px; line-height: 1.65;
}
.kingdom ::selection { background: #b49657; color: #fff7df; }
.kingdom :is(input, textarea) { caret-color: var(--accent); accent-color: var(--accent); }
.kingdom :is(button, input, select, textarea, summary):focus-visible { outline: 2px solid #c59b50; outline-offset: 3px; }
.kingdom button:disabled { opacity: .45; cursor: default; }
.kingdom h2, .kingdom h3, .kingdom h4, .kingdom p { margin: 0; }
.kingdom h2 { font-family: var(--royal-serif); font-size: 23px; font-weight: 600; letter-spacing: 2px; line-height: 1.4; }
.kingdom h3 { font-family: var(--royal-serif); font-size: 17px; font-weight: 600; margin: 23px 0 10px; }
.kingdom h4 { font-size: 14px; margin-bottom: 8px; }
.scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--border) transparent; }
.muted { color: var(--ink-2); font-size: 12px; line-height: 1.8; }
.kingdom p.muted { margin: 8px 0; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 20px 0 10px; }
.section-title:first-child { margin-top: 0; }.section-title h3 { margin: 0; }
.primary, .secondary { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 42px; padding: 9px 14px; border-radius: 2px; font-size: 13px; }
.primary { background: linear-gradient(#a34c39, #88382c); color: #fff0cd; border: 1px solid #773126; box-shadow: inset 0 0 0 2px #b2764e; font-family: var(--royal-serif); letter-spacing: 1px; }
.secondary { background: #e9dab9; color: #65482d; border: 1px solid #bda171; box-shadow: inset 0 0 0 2px #f2e6cd; }
.secondary.on { background: #d0ddcd; color: #385440; border-color: #759078; }
.text-button { font-size: 12px; color: var(--accent-ink); text-decoration: underline; text-underline-offset: 4px; min-height: 34px; }
.wide { width: 100%; margin-top: 12px; }
.field { display: block; width: 100%; min-width: 0; min-height: 44px; border: 1px solid #c5af81; border-radius: 2px; padding: 9px 10px; background: #faf2dd; color: var(--ink); font-size: 16px; }
.field::placeholder { color: #9b8b70; }
.form-label { display: flex; flex-direction: column; gap: 7px; margin-top: 16px; font-size: 12px; color: var(--ink-2); }
.form-pair { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 16px; }
.form-pair > label { display: flex; flex-direction: column; gap: 7px; font-size: 12px; color: var(--ink-2); min-width: 0; }
.area { resize: vertical; min-height: 90px; }
.participant, .appointment { display: flex; align-items: center; gap: 12px; margin: 12px 0; padding-bottom: 10px; border-bottom: 1px solid #d8c8a7; }
.participant > span, .appointment > span { flex: 1; min-width: 0; overflow-wrap: anywhere; font-family: var(--royal-serif); font-size: 16px; }
.participant select, .appointment select { width: 56%; flex-shrink: 0; font-size: 16px; }
.toggle { display: flex; align-items: center; gap: 9px; font-size: 13px; margin: 20px 0 8px; }
.toggle input, .policy > input { width: 17px; height: 17px; flex-shrink: 0; }
.footnote { font-size: 11px; color: var(--ink-2); margin-top: 16px !important; }
.opening-art { position: relative; flex: none; height: 29%; min-height: 180px; background-position: center 38%; background-size: cover; isolation: isolate; border-bottom: 3px solid #b29251; }
.opening-art::after { content: ''; position: absolute; inset: 0; z-index: -1; background: linear-gradient(90deg, #142f2a99, #20352a60, #192e2677); }
.opening-back { position: absolute; top: calc(12px + var(--safe-top, 0px)); left: 12px; display: grid; place-items: center; width: 36px; height: 36px; background: #20352b99; color: #f2e0b8; border: 1px solid #b5a473; font-size: 20px; }
.game-title { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; color: #ffedbc; text-shadow: 0 3px 6px #1b302b; }
.game-title small { font-size: 10px; letter-spacing: 4px; }.game-title h1 { font-family: var(--royal-serif); font-size: clamp(48px, 8vh, 68px); font-weight: 600; margin: 3px 0 -1px; letter-spacing: 8px; }.game-title p { font-size: 12px; letter-spacing: 5px; }
.red-seal { position: absolute; right: 24%; top: 42%; padding: 4px 5px; background: #9a3e2b; border: 1px solid #e1bb7c; color: #fce7bc; font-family: var(--royal-serif); font-size: 11px; line-height: 1.3; transform: rotate(-6deg); }
.opening-paper { position: relative; flex: 1; min-height: 0; background: var(--paper); background-image: linear-gradient(90deg, #95764219, transparent 8%, transparent 92%, #95764219); padding: 22px; }
.setup.opening-paper { display: flex; flex-direction: column; padding: 0; }
.setup-steps { display: flex; justify-content: space-between; gap: 7px; padding: 14px 18px; border-bottom: 1px solid #cebb95; }
.setup-steps button { display: flex; align-items: center; gap: 6px; color: #8c7859; font-size: 12px; min-height: 28px; }
.setup-steps button > span { display: grid; place-items: center; width: 23px; height: 23px; border: 1px solid #b9a783; font-family: var(--royal-serif); font-size: 11px; }
.setup-steps .current { color: #8e392b; }.setup-steps .current > span { background: #8e392b; color: #fce9c2; border-color: #8e392b; }
.setup-content { padding: 22px 22px 14px; }.setup-content .section-title { margin: 0; }
.dynasty-description { color: #867254; font-family: var(--royal-serif); font-size: 13px; margin: 12px 0 20px !important; }
.scenario { position: relative; display: flex; align-items: center; gap: 12px; padding: 12px 10px; margin-bottom: 9px; border: 1px solid #d0bd94; cursor: pointer; }
.scenario input { position: absolute; width: 1px; height: 1px; opacity: 0; }.scenario:focus-within { outline: 2px solid #9c703a; }
.scenario .scenario-number { font-family: var(--royal-serif); font-size: 24px; color: #b19b71; flex-shrink: 0; }
.scenario strong { display: block; font-family: var(--royal-serif); font-size: 16px; letter-spacing: 2px; }.scenario small { display: block; font-size: 11px; color: var(--ink-2); margin-top: 4px; padding-right: 10px; }
.scenario.chosen { border-color: #a5603d; background: #eadbb9; }.scenario.chosen strong { color: #8e392b; }.chosen-seal { margin-left: auto; padding: 1px 4px; color: #8e392b; border: 1px solid #a55e44; font-family: var(--royal-serif); flex: none; }
.setup-footer { display: flex; gap: 12px; padding: 14px 22px calc(14px + var(--safe-bottom, 0px)); border-top: 1px solid #d1bc93; }.setup-footer .primary { flex: 1; }
.accession-note { display: flex; align-items: center; gap: 17px; margin: 28px 0 12px; padding: 20px 0; border-block: 1px solid #c8b289; font-family: var(--royal-serif); }.accession-note > span { font-size: 34px; color: #913c2c; }.accession-note small { display: block; color: var(--ink-2); font-family: var(--font-sans); font-size: 11px; margin-top: 5px; }
.empty-verse { padding: 25px 0; font-family: var(--royal-serif); line-height: 2; color: #867252; }
.save-row { display: flex; width: 100%; gap: 14px; align-items: center; text-align: left; padding: 20px 0; border-bottom: 1px solid #cdb88c; }
.save-row > span:nth-child(2) { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 4px; }.save-row strong { font-family: var(--royal-serif); font-size: 18px; overflow-wrap: anywhere; }.save-row small { font-size: 11px; color: var(--ink-2); }
.save-seal { display: grid; place-items: center; width: 48px; height: 56px; flex-shrink: 0; border: 3px double #a0553b; color: #8c3b2a; font-family: var(--royal-serif); font-size: 28px; }
.royal-hud { flex: none; padding-top: var(--safe-top, 0px); background: #28362f; color: #eddbb1; border-bottom: 2px solid #a68a52; }
.sovereign { display: flex; align-items: center; gap: 9px; padding: 11px 10px 9px 5px; }
.hud-back { width: 25px; height: 36px; display: grid; place-items: center; flex-shrink: 0; font-size: 19px; color: #c4af82; }
.dynasty-seal { width: 36px; height: 42px; flex-shrink: 0; display: grid; place-items: center; background: #974232; color: #ffe2a4; border: 3px double #dbb878; font-family: var(--royal-serif); font-size: 20px; }
.ruler-name { flex: 1; min-width: 0; }.ruler-name > strong { display: block; font-family: var(--royal-serif); font-size: 17px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.ruler-name small { font-family: var(--font-sans); font-size: 9px; color: #bea779; font-weight: 400; margin-left: 6px; }.ruler-name > span { display: block; color: #bdaf8d; font-size: 10px; }
.reign-date { text-align: right; flex-shrink: 0; }.reign-date strong { font-family: var(--royal-serif); font-size: 13px; font-weight: 500; }.reign-date span { display: block; color: #bdaf8d; font-size: 9px; letter-spacing: 1px; }
.hud-archive { width: 27px; height: 36px; display: grid; place-items: center; color: #d1bc8e; font-size: 18px; flex-shrink: 0; }
.resource-bar { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid #b99a5933; padding: 8px 10px 9px; background: #1e2c2677; }
.resource-bar button { text-align: center; border-right: 1px solid #a792603d; }.resource-bar button:last-child { border-right: 0; }.resource-bar small { display: block; font-size: 9px; color: #c3b18d; letter-spacing: 2px; }.resource-bar strong { font-size: 13px; font-weight: 500; font-variant-numeric: tabular-nums; }.resource-bar em { font-size: 8px; font-style: normal; margin-left: 3px; color: #b7a784; }
.royal-footer { flex: none; background: #28362f; color: #f0dfb4; border-top: 2px solid #b69a60; padding: 0 12px calc(12px + var(--safe-bottom, 0px)); box-shadow: 0 -4px 13px #24372a40; }
.desk-tools { display: flex; justify-content: space-between; border-bottom: 1px solid #ad956047; margin-bottom: 11px; padding: 2px 0; }.desk-tools button { display: flex; align-items: center; justify-content: center; gap: 6px; min-height: 37px; flex: 1; font-family: var(--royal-serif); font-size: 12px; color: #ddcc9d; }.desk-tools button > span { color: #b6a170; font-size: 15px; }.desk-tools small { display: grid; place-items: center; width: 14px; height: 14px; background: #9c4735; color: #f7dfaa; font-size: 9px; }
.turn-row { display: flex; align-items: center; gap: 10px; justify-content: space-between; }.current-order { text-align: left; min-width: 0; padding-left: 3px; }.current-order > small { display: block; font-size: 9px; color: #baa780; letter-spacing: 2px; }.current-order strong { display: block; font-family: var(--royal-serif); font-size: 16px; font-weight: 500; }.current-order > span { display: block; font-size: 9px; color: #c1b08a; }
.decree-button { display: flex; align-items: center; gap: 9px; flex-shrink: 0; padding: 9px 12px; min-height: 58px; background: linear-gradient(#a34d3b, #843729); border: 1px solid #d1a968; box-shadow: inset 0 0 0 2px #ad7445, 0 2px 5px #111e1c33; font-family: var(--royal-serif); color: #ffebbc; font-size: 16px; letter-spacing: 1px; }.decree-seal { border: 1px solid #c69a5c; padding: 0 3px; font-size: 22px; }.decree-button small { display: block; font-size: 8px; letter-spacing: 2px; color: #e0ba86; margin-top: 2px; }
.order-reason { color: #f0bd89; font-size: 11px; margin-bottom: 8px !important; }
.memorial-heading { text-align: center; position: relative; padding: 9px 28px 20px; margin-bottom: 15px; border-bottom: 1px solid #cbb58a; }.memorial-heading > small { color: #9a8060; font-size: 10px; letter-spacing: 3px; }.memorial-heading h3 { font-size: 24px; margin: 11px 0 0; letter-spacing: 3px; }.memorial-seal { position: absolute; right: 0; top: 0; writing-mode: vertical-rl; border: 1px solid #a34b35; padding: 5px 2px; color: #a34b35; font-family: var(--royal-serif); font-size: 10px; letter-spacing: 2px; }
.event-text { font-family: var(--royal-serif); color: #5d4b33; font-size: 16px; line-height: 2; text-indent: 2em; margin-bottom: 18px !important; }
.event-choice { position: relative; display: flex; align-items: center; gap: 9px; padding: 13px 12px; border: 1px solid #ccb78b; margin-top: 10px; font-size: 13px; cursor: pointer; }.event-choice input { width: 15px; height: 15px; flex-shrink: 0; }.event-choice.chosen { background: #e9d8b5; border-color: #a46c45; }.event-choice > span { flex: 1; }.event-choice b, .study-choice b { display: grid; place-items: center; width: 29px; height: 29px; flex-shrink: 0; border: 2px solid #a24a35; color: #9a3c2c; font-family: var(--royal-serif); font-size: 20px; font-weight: 400; transform: rotate(-8deg); }
.chapter-title { display: flex; align-items: center; gap: 9px; }.chapter-title > span { font-size: 12px; padding: 0 4px; border: 1px solid #ac9268; color: #856a44; }
.action-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }.action-grid button { min-height: 61px; padding: 9px 2px; background: #eadcbc; border: 1px solid #c6af7d; box-shadow: inset 0 0 0 2px #f2e6cb; font-family: var(--royal-serif); font-size: 14px; }.action-grid small { display: block; color: var(--ink-2); font-size: 10px; font-family: var(--font-sans); margin-top: 4px; }.action-grid button.on { background: #344b3e; border-color: #bda568; box-shadow: inset 0 0 0 2px #61715a; color: #f9e8bd; }.action-grid button.on small { color: #cebd95; }
.effect { color: var(--accent-ink); font-size: 12px; margin-top: 12px !important; }
.cultivation { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; text-align: center; padding: 10px 0 20px; border-bottom: 1px solid var(--border); }.cultivation span { display: block; font-family: var(--royal-serif); font-size: 15px; }.cultivation strong { display: block; font-family: var(--royal-serif); font-size: 32px; font-weight: 400; color: #933f2d; }.cultivation small { color: #96815e; font-size: 9px; }.skill-track { height: 3px; margin-top: 12px; background: #dac9a6; }.skill-track i { display: block; height: 100%; background: #a86a40; }
.study-choice { display: flex; align-items: center; gap: 12px; padding: 13px 0; border-bottom: 1px solid #d3c29e; }.study-choice > span { flex: 1; }.study-choice strong { font-family: var(--royal-serif); font-size: 16px; font-weight: 500; }.study-choice small { display: block; color: #877353; font-size: 11px; margin-top: 2px; }.study-choice input { accent-color: #8d3e2b; }
.state-metrics { display: grid; grid-template-columns: repeat(4, 1fr); padding: 10px 0 17px; border-bottom: 1px solid var(--border); }.state-metrics small { color: #8c7758; font-size: 11px; display: block; }.state-metrics strong { font-family: var(--royal-serif); color: #8a482f; font-size: 23px; font-weight: 500; }
.policy { display: flex; align-items: flex-start; gap: 12px; padding: 15px 0; border-bottom: 1px solid var(--border); }.policy > input { margin-top: 4px; accent-color: #6e7550; }.policy > span { flex: 1; }.policy strong { display: block; font-family: var(--royal-serif); font-size: 17px; }.policy strong small { display: block; color: var(--ink-2); font-family: var(--font-sans); font-size: 10px; font-weight: 400; margin-top: 2px; }.policy > span > span { display: block; color: var(--ink-2); font-size: 12px; margin-top: 7px; }
.ledger { margin-top: 24px; padding: 15px; background: #e6d8b7; border-block: 3px double #bfa676; }.ledger h3 { margin-top: 0; }.ledger p { display: flex; justify-content: space-between; font-size: 12px; margin-top: 6px; gap: 10px; }.ledger p strong { font-weight: 500; font-variant-numeric: tabular-nums; }.ledger > small { display: block; margin-top: 9px; font-size: 10px; color: var(--ink-2); }
.buff { padding: 14px 0; border-bottom: 1px solid var(--border); }.buff > strong { display: flex; align-items: center; gap: 7px; font-family: var(--royal-serif); font-size: 16px; color: #63734e; }.buff strong small { margin-left: auto; font-family: var(--font-sans); font-size: 10px; font-weight: 400; }.buff p { font-size: 12px; color: var(--ink-2); margin-top: 7px; }.buff > small { font-size: 10px; color: var(--ink-2); }
.portrait-gallery { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; margin: 18px 0; }
.faction, .heir { padding: 16px 0; border-bottom: 1px solid var(--border); }.faction { display: flex; align-items: center; justify-content: space-between; gap: 12px; }.faction strong, .heir strong { font-family: var(--royal-serif); font-size: 16px; }.faction p, .heir p { font-size: 12px; color: var(--ink-2); margin-top: 5px; }
.positive { color: var(--good); }.negative { color: var(--bad); }
.season-entries { margin: 0; padding: 0; list-style: none; }.season-entries li { position: relative; padding: 11px 0 11px 16px; border-bottom: 1px solid #d7c7a4; font-size: 13px; line-height: 1.9; }.season-entries li::before { content: '·'; position: absolute; left: 0; color: #a26b3c; }
.season-deltas { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 15px 6px; margin: 23px 0 10px; }.season-deltas small { display: block; font-size: 10px; color: #8a7557; }.season-deltas strong { display: block; font-family: var(--royal-serif); font-weight: 500; font-size: 19px; }.season-next { text-align: center; font-family: var(--royal-serif); color: #8e7049; margin: 24px 0 0 !important; font-size: 14px; letter-spacing: 2px; }
.battle-result { text-align: center; padding: 15px 0 20px; color: #9d4b36; }.battle-result > span { display: block; font-size: 30px; margin: 0 auto; }.battle-result strong { display: block; font-family: var(--royal-serif); font-size: 26px; letter-spacing: 3px; margin-top: 6px; }.battle-result small { display: block; color: #957e5d; font-size: 10px; margin-top: 4px; }.battle-result.won { color: #4d704e; }
.report { padding: 18px 0; border-bottom: 1px solid var(--border); }.report p { font-size: 12px; color: var(--ink-2); line-height: 1.9; margin-top: 6px; }.report h4 { font-family: var(--royal-serif); font-size: 16px; }
.delta-list { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; font-variant-numeric: tabular-nums; margin-top: 10px; }
.narrative { font-family: var(--royal-serif); line-height: 2 !important; font-size: 15px !important; white-space: pre-wrap; margin-top: 18px !important; color: var(--ink) !important; }
.score-row { display: grid; grid-template-columns: 1fr 1.3fr 1fr; gap: 6px; padding: 10px 0; border-bottom: 1px solid var(--border); font-size: 12px; font-variant-numeric: tabular-nums; }.score-row > span:nth-child(2) { color: var(--ink-2); text-align: right; }.score-row > strong { text-align: right; color: #8d452f; }.score-row small { color: var(--ink-2); font-weight: 400; }
.parchment { background: var(--paper); padding: 24px; }.ending-title { text-align: center; padding: 28px 0 24px; border-block: 3px double #b29a6c; margin-bottom: 20px; }.ending-title > span { font-size: 32px; color: #9c713b; }.ending-title h3 { font-size: 32px; margin: 12px 0 8px; letter-spacing: 4px; }.ending-title > strong { font-family: var(--royal-serif); font-size: 40px; color: #8f3f2b; font-weight: 500; }.ending-title small { font-size: 14px; color: var(--ink-2); font-weight: 400; }.ending-title p { font-size: 12px; color: var(--ink-2); margin-top: 8px; }.achievement { display: flex; gap: 12px; padding: 12px 0; }.achievement > span { font-size: 23px; color: #9c713b; flex-shrink: 0; }.achievement strong { font-family: var(--royal-serif); font-size: 17px; }.achievement p { font-size: 12px; color: var(--ink-2); margin-top: 4px; }
.kingdom details { margin: 14px 0; font-size: 12px; color: var(--ink-2); }.kingdom summary { min-height: 34px; cursor: pointer; color: var(--accent-ink); }
.status, .problem { display: flex; gap: 8px; align-items: center; padding: 12px; font-size: 12px; background: #f2e7cc; border: 1px solid #b79a67; color: #795738; }.status > span:nth-child(2), .problem > span { flex: 1; min-width: 0; overflow-wrap: anywhere; }.status button { margin-left: auto; flex-shrink: 0; text-decoration: underline; text-underline-offset: 3px; }.problem { color: #9a3a2a; max-height: 140px; overflow: auto; }.floating { position: absolute; top: calc(10px + var(--safe-top, 0px)); left: 12px; right: 12px; z-index: 10; box-shadow: 0 4px 20px #17251e55; }
.portrait-stage { position: relative; height: min(48dvh, 380px); background: #d6ccb3; overflow: hidden; border: 1px solid #b7a579; box-shadow: inset 0 0 0 4px #e3d6b8; }.portrait-stage :deep(img) { object-fit: contain; height: 100%; width: 100%; }.portrait-stage.consort { background: #dfd0bf; }.unpainted { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; background: radial-gradient(ellipse at 50% 35%, #f3ead2, #bcb797); }.unpainted > span { writing-mode: vertical-rl; font-family: var(--royal-serif); font-size: 38px; letter-spacing: 13px; color: #797b62; }.unpainted > small { font-family: var(--royal-serif); font-size: 12px; letter-spacing: 6px; color: #8a7e60; }.portrait-inscription { position: absolute; top: 16px; right: 13px; max-height: 80%; writing-mode: vertical-rl; font-family: var(--royal-serif); font-size: 13px; letter-spacing: 3px; padding: 8px 3px; background: #f2e6c9d9; color: #725b3e; }
.person-attributes { display: flex; justify-content: space-between; gap: 8px; padding: 17px 0; border-bottom: 1px solid var(--border); font-size: 10px; color: var(--ink-2); }.person-attributes strong { display: block; font-family: var(--royal-serif); font-size: 23px; color: #815231; font-weight: 500; }.biography { font-size: 14px; font-family: var(--royal-serif); line-height: 2; white-space: pre-wrap; color: #715d40; margin-top: 15px !important; }.npc-action { margin-top: 10px; }
.talk p { font-size: 13px; line-height: 1.9; margin: 8px 0; white-space: pre-wrap; }.your-words { color: var(--ink-2); }.talk-form { display: flex; gap: 8px; margin: 12px 0; }.talk-form input { flex: 1; }.talk-form button { flex-shrink: 0; }
.spin { animation: kingdom-spin 1s linear infinite; }@keyframes kingdom-spin { to { transform: rotate(360deg); } }
@media (max-width: 350px) { .sovereign { gap: 5px; }.ruler-name small { display: none; }.resource-bar strong { font-size: 12px; }.decree-button { font-size: 14px; padding: 9px; gap: 6px; }.current-order strong { font-size: 14px; }.setup-content { padding: 18px; }.setup-steps { padding-inline: 12px; }.setup-steps button { font-size: 11px; } }
@media (max-height: 700px) { .opening-art { min-height: 145px; height: 25%; }.game-title h1 { font-size: 48px; } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
