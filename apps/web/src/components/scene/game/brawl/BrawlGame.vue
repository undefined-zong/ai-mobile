<script setup lang="ts">
import { BRAWL_DIFFICULTIES, BRAWL_KINDS, BRAWL_PASSIVES, BRAWL_STYLES, brawlId, isBrawlPreset, readBrawlFighter, type BrawlDifficulty, type BrawlFighter, type BrawlResult } from '@app/shared';
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from '@/stores/app';
import { useCharacterStore } from '@/stores/characters';
import { useChatStore } from '@/stores/chat';
import { usePersonaStore } from '@/stores/personas';
import { useLibraryStore } from '@/stores/library';
import { useBrawlStore } from '@/stores/brawl';
import { useAiStore } from '@/stores/ai';
import { generateBrawlFighter } from '@/services/brawl';
import { isHandheld, useTheater } from '@/composables/useTheater';
import { uid } from '@/utils/id';
import { BrawlEngine } from './engine';
import { BrawlRenderer } from './renderer';

const line = defineModel<string>('line', { required: true });
const phase = defineModel<string>('phase', { required: true });
const emit = defineEmits<{ fail: [r: { reason: string; notConnected?: boolean }]; progress: [summary: string | null]; done: [summary: string] }>();
const app = useAppStore(), chars = useCharacterStore(), chat = useChatStore(), personas = usePersonaStore();
const store = useBrawlStore(), lib = useLibraryStore(), ai = useAiStore();
const router = useRouter(), route = useRoute();
const opponent = computed(() => chars.byId(app.activeCharacterId) ?? chars.list[0]!);
const chatId = computed(() => chat.chatOfCharacter(opponent.value.id)?.id ?? '');
const persona = personas.forChat(chat.chatById(chatId.value));
const selection = ref(brawlId('persona', persona.id));

watch(() => [chars.list.map(c => [c.id, c.name]), personas.list.map(p => [p.id, p.name])], () => {
  for (const c of chars.list) store.ensure('character', c.id, c.name, c.accent, c.hairColor, c.appearanceTags);
  for (const p of personas.list) store.ensure('persona', p.id, p.name, '#71d9c8');
}, { immediate: true, deep: true });
const roster = computed(() => store.fighters.filter(f => f.ownerKind === 'character' ? chars.byId(f.ownerId) : personas.byId(f.ownerId)));
const you = computed(() => store.byId(selection.value) ?? store.byId(brawlId('persona', personas.defaultPersona.id))!);
const her = computed(() => store.byId(brawlId('character', opponent.value.id))!);
const preset = computed(() => lib.presetForUse('game-brawl', opponent.value));
const presets = computed(() => [...lib.presets].sort((a, b) => Number(isBrawlPreset(b)) - Number(isBrawlPreset(a))));
const connected = computed(() => ai.status('companion').live);
const stage = ref<HTMLElement | null>(null), canvas = ref<HTMLCanvasElement | null>(null), screen = ref<HTMLElement | null>(null), layer = ref<HTMLElement | null>(null);
/**
 * 横屏（同一起观影的放映厅）：手机、平板开打就进，能进系统全屏就锁横屏；
 * 锁不了（iPhone、装成 App 后 manifest 定了竖屏）而屏幕还竖着时，战斗层宽高对调、顺时针转 90°。
 */
const handheld = isHandheld();
const { on: theater, rotate, size, enter: enterTheater, exit: exitTheater } = useTheater(screen);
const boxStyle = computed(() => (rotate.value ? { width: `${size.value.h}px`, height: `${size.value.w}px`, left: `${size.value.w}px` } : {}));
const active = ref(true), renderError = ref(''), message = ref(''), generating = ref(''), wish = ref('');
const editor = ref<BrawlFighter | null>(null), result = ref<BrawlResult | null>(null);
const tick = ref(0), soundOn = ref(false);
let engine = new BrawlEngine(you.value, her.value, store.difficulty);
let renderer: BrawlRenderer | null = null, observer: ResizeObserver | null = null;
let frame = 0, previous = 0, accumulator = 0, hudClock = 0, roundId = '', roundChatId = '', roundCharacterId = '';
let request: AbortController | null = null, lineRequest: AbortController | null = null;
let audio: AudioContext | null = null, sounded = 0, alive = true;
const held = new Map<string, string>();
let stickPointer: number | null = null, stickX = 0, stickGuard = false, stickUp = false;
/** 屏幕坐标换回战斗层坐标（战斗层转了 90° 时，手指在屏幕上往下推是摇杆往右） */
let stickMatrix = new DOMMatrixReadOnly();
const stickOffset = ref({ x: 0, y: 0 });
const inArena = computed(() => phase.value !== 'menu');
const hud = computed(() => {
  tick.value;
  return engine.fighters.map(f => ({ name: f.profile.name, hp: Math.ceil(f.hp), maxHp: f.profile.hp, mp: Math.floor(f.mp), maxMp: f.profile.mp, shield: Math.ceil(f.shield), combo: f.combo, cds: [...f.cooldowns], dash: f.dashCooldown, skills: f.profile.skills }));
});
const time = computed(() => { tick.value; return Math.ceil(engine.time); });
const countdown = computed(() => { tick.value; return Math.ceil(engine.countdown); });
const announcement = computed(() => { tick.value; return engine.announcementTime > 0 ? engine.announcement : ''; });
const floaters = computed(() => { tick.value; return engine.effects.filter(e => e.text).map(e => ({ ...e, point: renderer?.screenPoint(e.x, e.y + e.age * 60) ?? { x: 50, y: 50 } })); });
const recent = computed(() => store.results.filter(r => r.characterId === opponent.value.id).slice(0, 3));
const resultTitle = computed(() => result.value?.winner === 'you' ? '这局，你赢了' : result.value?.winner === 'draw' ? '不分胜负' : `${result.value?.opponent ?? ''}赢了这局`);

function refreshPreview() {
  if (phase.value !== 'menu') return;
  engine = new BrawlEngine(you.value, her.value, store.difficulty); engine.countdown = 0;
  tick.value++;
}
watch([you, her, () => store.difficulty], refreshPreview);

function cueTone() {
  if (!soundOn.value || !audio || audio.state !== 'running') return;
  const effect = engine.effects.find(e => e.id > sounded && (e.kind === 'hit' || e.kind === 'cast'));
  sounded = engine.effects.at(-1)?.id ?? sounded;
  if (!effect) return;
  const osc = audio.createOscillator(), gain = audio.createGain();
  const t = audio.currentTime;
  osc.type = effect.kind === 'hit' ? 'triangle' : 'sine';
  osc.frequency.setValueAtTime(effect.kind === 'hit' ? 170 : 460, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + .1);
  gain.gain.setValueAtTime(.07, t); gain.gain.exponentialRampToValueAtTime(.001, t + .12);
  osc.connect(gain); gain.connect(audio.destination); osc.start(t); osc.stop(t + .13);
  osc.onended = () => { osc.disconnect(); gain.disconnect(); };
}
function toggleSound() {
  soundOn.value = !soundOn.value;
  if (soundOn.value) { audio ??= new AudioContext(); void audio.resume(); }
}

function loop(now: number) {
  frame = 0;
  if (!alive || !active.value || document.hidden) return;
  const dt = previous ? Math.min(.05, (now - previous) / 1000) : 0;
  previous = now;
  if (phase.value === 'playing') {
    accumulator += dt;
    while (accumulator >= 1 / 60) { engine.step(1 / 60); accumulator -= 1 / 60; }
    if (engine.outcome) finish();
    cueTone();
  } else accumulator = 0;
  renderer?.draw(engine, phase.value === 'paused' ? 0 : dt);
  hudClock += dt;
  if (hudClock > .05) { tick.value++; hudClock = 0; }
  frame = requestAnimationFrame(loop);
}
function runFrames() { previous = 0; if (!frame) frame = requestAnimationFrame(loop); }
function resize() { if (active.value && stage.value?.clientWidth && stage.value.clientHeight) renderer?.resize(stage.value.clientWidth, stage.value.clientHeight); }

function syncHeld() {
  const values = [...held.values()];
  engine.controls.move = Math.max(-1, Math.min(1, stickX + (values.includes('right') ? 1 : 0) - (values.includes('left') ? 1 : 0)));
  engine.controls.guard = stickGuard || values.includes('guard');
  engine.controls.basic = values.includes('basic');
}
function clearInput() {
  held.clear(); stickPointer = null; stickX = 0; stickGuard = false; stickUp = false; stickOffset.value = { x: 0, y: 0 };
  engine.clearInput();
}
function hold(event: PointerEvent, action: string) {
  if (phase.value !== 'playing') return;
  event.preventDefault(); (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  held.set(`p${event.pointerId}`, action); syncHeld();
}
function release(event: PointerEvent) { held.delete(`p${event.pointerId}`); syncHeld(); }
function tapBasic() {
  if (phase.value !== 'playing') return;
  const current = engine;
  engine.controls.basic = true;
  window.setTimeout(() => { if (current === engine) syncHeld(); }, 100);
}
function action(name: 'jump' | 'dash' | number) {
  if (phase.value !== 'playing') return;
  if (typeof name === 'number') engine.controls.skill = name;
  else engine.controls[name] = true;
}
function stick(event: PointerEvent) {
  if (phase.value !== 'playing') return;
  if (event.type === 'pointerdown') {
    if (stickPointer !== null) return;
    stickPointer = event.pointerId; (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const t = layer.value ? getComputedStyle(layer.value).transform : 'none';
    stickMatrix = (t === 'none' ? new DOMMatrixReadOnly() : new DOMMatrixReadOnly(t)).inverse();
  }
  if (event.pointerId !== stickPointer) return;
  event.preventDefault();
  const r = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const dx = event.clientX - r.left - r.width / 2, dy = event.clientY - r.top - r.height / 2;
  const x = stickMatrix.a * dx + stickMatrix.c * dy, y = stickMatrix.b * dx + stickMatrix.d * dy;
  const length = Math.max(1, Math.hypot(x, y) / 36);
  stickOffset.value = { x: x / length, y: y / length };
  stickX = Math.abs(x) > 12 ? Math.sign(x) : 0; stickGuard = y > 24;
  const up = y < -24; if (up && !stickUp) action('jump'); stickUp = up; syncHeld();
}
function stopStick(event: PointerEvent) {
  if (event.pointerId !== stickPointer) return;
  stickPointer = null; stickX = 0; stickGuard = false; stickUp = false; stickOffset.value = { x: 0, y: 0 }; syncHeld();
}

const MOVE_KEYS: Record<string, string> = { KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', KeyS: 'guard', ArrowDown: 'guard', KeyJ: 'basic' };
function keyDown(event: KeyboardEvent) {
  if (!active.value || !inArena.value || /INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName)) return;
  if (event.code === 'Escape' || event.code === 'KeyP') { event.preventDefault(); if (!event.repeat) togglePause(); return; }
  if (phase.value !== 'playing') return;
  if (MOVE_KEYS[event.code]) { event.preventDefault(); held.set(event.code, MOVE_KEYS[event.code]!); syncHeld(); return; }
  const actions: Record<string, 'jump' | 'dash' | number> = { KeyW: 'jump', ArrowUp: 'jump', Space: 'jump', KeyK: 'dash', ShiftLeft: 'dash', KeyU: 0, KeyI: 1, KeyO: 2 };
  const value = actions[event.code];
  if (value !== undefined) { event.preventDefault(); if (!event.repeat) action(value); }
}
function keyUp(event: KeyboardEvent) { held.delete(event.code); syncHeld(); }
function pause() {
  clearInput();
  if (phase.value === 'playing') { phase.value = 'paused'; emit('progress', `大乱斗（${you.value.name}与${her.value.name}，暂停在剩余 ${Math.ceil(engine.time)} 秒）`); }
}
function togglePause() {
  if (phase.value === 'playing') pause();
  else if (phase.value === 'paused') { clearInput(); phase.value = 'playing'; previous = 0; }
}
function visibility() { if (document.hidden) { pause(); cancelAnimationFrame(frame); frame = 0; } else runFrames(); }
function blur() { pause(); }

async function say(task: 'brawl-open' | 'brawl-end', input: string, id: string) {
  if (!connected.value || !preset.value || !roundChatId) return;
  lineRequest?.abort(); const controller = new AbortController(); lineRequest = controller;
  const targetChat = roundChatId;
  const response = await chat.sceneJson(targetChat, { name: task, input }, value => {
    const v = value as { line?: unknown } | null;
    return typeof v?.line === 'string' ? v.line.trim().slice(0, 160) : null;
  }, controller.signal, { use: 'game-brawl' });
  if (!alive || controller.signal.aborted || id !== roundId) return;
  if (response.ok) {
    line.value = response.value;
    chat.push(targetChat, 'assistant', [{ type: 'text', text: response.value }], { meta: { scene: 'game', cue: task === 'brawl-open' ? '大乱斗开场' : '大乱斗结算' } });
  }
}
function begin() {
  if (handheld) enterTheater();
  request?.abort(); generating.value = ''; editor.value = null;
  engine = new BrawlEngine(you.value, her.value, store.difficulty);
  roundId = uid('brawl'); roundChatId = chatId.value || chat.startChat(opponent.value).id; roundCharacterId = opponent.value.id;
  result.value = null; line.value = ''; message.value = ''; clearInput(); sounded = 0;
  phase.value = 'playing'; tick.value++; previous = 0;
  emit('progress', `大乱斗（${you.value.name}对战${her.value.name}，${BRAWL_DIFFICULTIES[store.difficulty]}）`);
  void nextTick(resize);
  void say('brawl-open', `玩家操控${you.value.name}，你操控${her.value.name}；难度${BRAWL_DIFFICULTIES[store.difficulty]}。双方的战斗档案：${JSON.stringify([you.value, her.value])}`, roundId);
}
function finish() {
  if (result.value || !engine.outcome) return;
  const [a, b] = engine.fighters;
  const r: BrawlResult = { id: roundId, at: Date.now(), you: a.profile.name, opponent: b.profile.name, characterId: roundCharacterId, ...engine.outcome, seconds: Math.round(90 - engine.time), difficulty: engine.difficulty, damage: a.damage, combo: a.bestCombo, hpLeft: [Math.ceil(a.hp), Math.ceil(b.hp)] };
  result.value = r; store.record(r); phase.value = 'end'; clearInput(); tick.value++;
  const winner = r.winner === 'draw' ? '平局' : `${r.winner === 'you' ? r.you : r.opponent}获胜`;
  const summary = `大乱斗（${r.you}对战${r.opponent}，${winner}，${r.seconds} 秒，最高 ${r.combo} 连击）`;
  emit('progress', null); emit('done', summary);
  chat.push(roundChatId, 'narrator', [{ type: 'game', game: 'brawl', logId: r.id, result: r }], { meta: { scene: 'game', cue: '大乱斗战绩' } });
  void say('brawl-end', `本局真实结果：${JSON.stringify(r)}。只围绕这局结果说一句话。`, roundId);
}
function concede() { engine.forfeit(); finish(); }
function backToGames() {
  pause(); exitTheater();
  const { g: _game, fighter: _fighter, ...query } = route.query;
  void router.push({ path: route.path, query });
}
function lobby() {
  lineRequest?.abort(); exitTheater(); phase.value = 'menu'; result.value = null; clearInput();
  void nextTick(() => { refreshPreview(); resize(); });
}
function fullscreen() { if (theater.value) exitTheater(); else enterTheater(); }

async function generate(f: BrawlFighter) {
  if (generating.value) return;
  if (!preset.value) { message.value = '先选择一个预设，再生成专属招式。'; return; }
  const controller = new AbortController(); request = controller;
  generating.value = f.id; message.value = '';
  const targetChat = chatId.value || chat.startChat(opponent.value).id;
  const r = await generateBrawlFighter(targetChat, JSON.parse(JSON.stringify(f)), wish.value, controller.signal);
  if (!alive || controller.signal.aborted) return;
  generating.value = '';
  if (r.ok) { store.save(r.value); editor.value = null; message.value = `${f.name}的专属招式已保存。`; }
  else message.value = r.reason;
}
function cancelGeneration() { request?.abort(); generating.value = ''; }
function edit(f: BrawlFighter) { editor.value = JSON.parse(JSON.stringify(f)); }
function saveEditor() {
  if (!editor.value) return;
  const base = store.byId(editor.value.id)!;
  store.save({ ...readBrawlFighter(editor.value, base), source: 'manual', updatedAt: Date.now() });
  editor.value = null; message.value = '战斗档案已保存，下次开局使用。';
}
function askAssistant(f: BrawlFighter) { void router.push({ path: '/me/assistant', query: { target: `fighter:${f.id}` } }); }
function selectPreset(event: Event) { lib.setUse('game-brawl', (event.target as HTMLSelectElement).value); }

// iOS（主屏幕 App、旋转后的战斗画面）不一定认 touch-action：连点照样双击放大，双指照样捏合放大。
// 战斗全屏里兜底：两次抬手间隔不到 350ms 就取消第二次的默认动作，系统不再当成双击放大；被取消的那次点击替普通按钮补上
// （招式键靠 pointerdown 出招，不补，补了会多出一招）。多指移动和缩放手势一律拦下；打斗期间把页面缩放锁在 1 倍，已放大的会弹回。
const fighting = () => active.value && inArena.value;
let lastTouchEnd = -Infinity;
function touchEnd(event: TouchEvent) {
  if (!fighting()) return;
  const quick = event.timeStamp - lastTouchEnd < 350;
  lastTouchEnd = event.timeStamp;
  if (!quick || !event.cancelable) return;
  event.preventDefault();
  const button = event.target instanceof Element ? event.target.closest('button') : null;
  if (button && !button.disabled && !button.classList.contains('combat')) button.click();
}
function touchMove(event: TouchEvent) { if (fighting() && event.touches.length > 1 && event.cancelable) event.preventDefault(); }
function gesture(event: Event) { if (fighting()) event.preventDefault(); }
const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
let viewportBefore: string | null = null;
function lockZoom(on: boolean) {
  if (!viewport) return;
  if (on && viewportBefore === null) { viewportBefore = viewport.content; viewport.content = `${viewportBefore}, maximum-scale=1, user-scalable=no`; }
  else if (!on && viewportBefore !== null) { viewport.content = viewportBefore; viewportBefore = null; }
}
watch(fighting, lockZoom, { immediate: true });

onMounted(() => {
  const el = screen.value!;
  el.addEventListener('touchend', touchEnd, { passive: false }); el.addEventListener('touchmove', touchMove, { passive: false });
  document.addEventListener('gesturestart', gesture, { passive: false }); document.addEventListener('gesturechange', gesture, { passive: false });
  try { renderer = new BrawlRenderer(canvas.value!); observer = new ResizeObserver(resize); observer.observe(stage.value!); resize(); runFrames(); }
  catch { renderError.value = '战场未能打开。请开启浏览器的硬件加速，或换一个支持 WebGL 的浏览器。'; }
  window.addEventListener('keydown', keyDown); window.addEventListener('keyup', keyUp); window.addEventListener('blur', blur);
  document.addEventListener('visibilitychange', visibility);
  const target = typeof route.query.fighter === 'string' ? store.byId(route.query.fighter) : undefined;
  if (target) edit(target);
});
onActivated(() => { active.value = true; if (handheld && inArena.value) enterTheater(); runFrames(); void nextTick(resize); });
onDeactivated(() => { active.value = false; pause(); exitTheater(); cancelGeneration(); lineRequest?.abort(); cancelAnimationFrame(frame); frame = 0; });
onBeforeUnmount(() => {
  alive = false; cancelGeneration(); lineRequest?.abort(); clearInput(); cancelAnimationFrame(frame); observer?.disconnect(); renderer?.dispose();
  lockZoom(false); screen.value?.removeEventListener('touchend', touchEnd); screen.value?.removeEventListener('touchmove', touchMove);
  document.removeEventListener('gesturestart', gesture); document.removeEventListener('gesturechange', gesture);
  void audio?.close(); window.removeEventListener('keydown', keyDown); window.removeEventListener('keyup', keyUp); window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', visibility);
});
</script>

<template>
  <Teleport to="body" :disabled="!inArena">
    <section v-show="active" ref="screen" class="brawl" :class="{ 'fight-screen': inArena }" aria-label="大乱斗" data-game="brawl">
      <div ref="layer" class="brawl-box" :class="{ rot: rotate }" :style="boxStyle">
        <div class="brawl-body">
          <header class="brawl-heading">
            <div><h2>大乱斗</h2><p>{{ inArena ? '屋顶擂台' : `与${opponent.name}，过两招。` }}</p></div>
            <div class="heading-actions">
              <button type="button" class="icon-action" :aria-label="soundOn ? '关闭音效' : '打开音效'" :aria-pressed="soundOn" @click="toggleSound"><span :class="soundOn ? 'i-lucide-volume-2' : 'i-lucide-volume-x'" /></button>
              <button v-if="inArena" type="button" class="icon-action" :aria-label="theater ? '退出全屏' : '全屏'" @click="fullscreen"><span :class="theater ? 'i-lucide-shrink' : 'i-lucide-expand'" /></button>
              <button v-if="phase === 'playing' || phase === 'paused'" type="button" class="icon-action" :aria-label="phase === 'paused' ? '继续战斗' : '暂停战斗'" @click="togglePause"><span :class="phase === 'paused' ? 'i-lucide-play' : 'i-lucide-pause'" /></button>
              <button v-if="phase === 'end'" type="button" class="text-action" @click="lobby">回到备战</button>
            </div>
          </header>

          <div ref="stage" class="arena" :class="{ preview: !inArena }">
            <canvas ref="canvas" aria-label="横版战斗场地；使用下方按钮或键盘操控" />
            <div v-if="renderError" class="arena-error" role="alert">{{ renderError }}</div>
            <div class="hud" aria-label="双方血量和蓝量">
              <div v-for="(f, i) in hud" :key="i" class="fighter-hud" :class="{ rival: i === 1 }">
                <div class="hud-name"><b>{{ f.name }}</b><span>{{ i === 0 ? '你操控' : '对手' }}</span></div>
                <div class="meter health" role="progressbar" :aria-label="`${f.name}血量`" :aria-valuenow="f.hp" :aria-valuemax="f.maxHp" aria-valuemin="0"><i :style="{ width: `${f.hp / f.maxHp * 100}%` }" /><span>{{ f.hp }} / {{ f.maxHp }}</span></div>
                <div class="meter mana" role="progressbar" :aria-label="`${f.name}蓝量`" :aria-valuenow="f.mp" :aria-valuemax="f.maxMp" aria-valuemin="0"><i :style="{ width: `${f.mp / f.maxMp * 100}%` }" /><span>{{ f.mp }} / {{ f.maxMp }}</span></div>
                <span v-if="f.shield" class="shield-label">护盾 {{ f.shield }}</span>
              </div>
              <div class="clock" :class="{ urgent: time <= 15 }">{{ inArena ? time : 'VS' }}<small>{{ inArena ? '秒' : '切磋' }}</small></div>
            </div>
            <template v-if="inArena">
              <p v-if="line && phase === 'playing'" class="battle-line">{{ line }}</p>
              <div v-if="countdown && phase === 'playing'" class="countdown" aria-live="polite">{{ countdown }}<span>准备出招</span></div>
              <div v-if="announcement && phase === 'playing'" class="ultimate-line">{{ announcement }}</div>
              <div v-for="(f, i) in hud" :key="`combo-${i}`" class="combo" :class="{ right: i === 1 }"><template v-if="f.combo > 1"><b>{{ f.combo }}</b> 连击</template></div>
              <span v-for="e in floaters" :key="e.id" class="damage-float" :style="{ left: `${e.point.x}%`, top: `${e.point.y}%`, opacity: 1 - e.age / e.life }">{{ e.text }}</span>
            </template>
            <div v-else class="stage-caption"><span class="i-lucide-moon-star" />屋顶擂台<span>90 秒 · 实时对战</span></div>

            <div v-if="phase === 'paused'" class="arena-overlay">
              <div class="pause-panel"><h3>歇一会儿</h3><p>战斗已暂停，双方都停在原地。</p><button class="primary" @click="togglePause">继续战斗 <span class="i-lucide-play" /></button><button class="text-action" @click="backToGames">返回游戏列表</button><button class="text-action" @click="concede">认输并结算</button></div>
            </div>
            <div v-if="phase === 'end' && result" class="arena-overlay result-overlay" aria-live="polite">
              <div class="result-panel"><span class="result-icon" :class="result.winner === 'you' ? 'i-lucide-trophy' : 'i-lucide-swords'" /><h3>{{ resultTitle }}</h3><p>{{ result.reason === 'time' ? '时间到，按剩余生命比例结算' : result.reason === 'forfeit' ? '这次先让你一局' : '漂亮的一场交手' }}</p><div class="result-stats"><span><b>{{ result.damage }}</b>造成伤害</span><span><b>{{ result.combo }}</b>最高连击</span><span><b>{{ result.seconds }}s</b>对战时长</span></div><p v-if="line" class="end-line">{{ line }}</p><div class="result-actions"><button class="primary" @click="begin">再来一局 <span class="i-lucide-rotate-ccw" /></button><button class="secondary" @click="lobby">调整招式</button></div></div>
            </div>
          </div>

          <template v-if="!inArena">
            <div class="matchup">
              <label class="player-select">你操控<select v-model="selection" aria-label="选择你操控的角色"><option v-for="f in roster" :key="f.id" :value="f.id">{{ f.name }}{{ f.ownerKind === 'persona' ? ' · 我的人设' : '' }}</option></select></label>
              <span class="versus">VS</span>
              <div class="opponent-name"><small>本次对手</small><strong>{{ her.name }}</strong><span>{{ BRAWL_STYLES[her.style] }}</span></div>
            </div>
            <div class="difficulty-row"><span>对战难度</span><div class="difficulty" aria-label="难度"><button v-for="(label, key) in BRAWL_DIFFICULTIES" :key="key" :aria-pressed="store.difficulty === key" :class="{ chosen: store.difficulty === key }" @click="store.difficulty = key as BrawlDifficulty">{{ label }}</button></div></div>
            <button class="primary start" :disabled="!!renderError" @click="begin">开始对战 <span class="i-lucide-swords" /></button>
            <p class="start-note">已有基础招式，随时开打。手机上开打会转成横屏。</p>

            <div class="loadout-heading"><h3>专属招式</h3><span>生成后保留，下次直接用</span></div>
            <div class="loadouts">
              <article v-for="(f, index) in [you, her]" :key="`${index}-${f.id}`" class="loadout">
                <header><div><strong>{{ f.name }}</strong><span>{{ f.title }} · {{ BRAWL_STYLES[f.style] }}</span></div><span class="source-label">{{ { template: '基础配招', ai: 'AI 专属', manual: '已编辑' }[f.source] }}</span></header>
                <div class="stats-line"><span><i class="i-lucide-heart" />{{ f.hp }} 血量</span><span><i class="i-lucide-droplet" />{{ f.mp }} 蓝量</span></div>
                <ol class="skill-list"><li v-for="(s, i) in f.skills" :key="i"><span class="skill-slot" :class="{ ult: i === 2 }">{{ i === 2 ? '奥义' : `技能${i + 1}` }}</span><div><b>{{ s.name }}</b><p>{{ s.description }}</p><small>{{ BRAWL_KINDS[s.kind] }} · {{ s.kind === 'shield' ? '护盾' : '伤害' }} {{ s.damage }} · {{ s.mana }} 蓝 · {{ s.cooldown }} 秒</small></div></li></ol>
                <p class="passive"><span class="i-lucide-sparkle" /><span>{{ f.passive.name }}：{{ BRAWL_PASSIVES[f.passive.kind] }}</span></p>
                <div class="loadout-actions"><button class="secondary" :disabled="!!generating" @click="generate(f)"><span :class="generating === f.id ? 'i-lucide-loader-circle spin' : 'i-lucide-wand-sparkles'" />{{ generating === f.id ? '生成中…' : '生成专属招式' }}</button><button class="text-action" @click="edit(f)">编辑</button><button class="text-action" @click="askAssistant(f)">交给助手</button></div>
              </article>
            </div>
            <label class="wish">招式想法<input v-model="wish" placeholder="例如：擅长剑术，突进后接浮空斩" /></label>
            <button v-if="generating" class="text-action" @click="cancelGeneration">取消这次生成</button>
            <p v-if="!connected" class="connection-note">专属招式生成使用「陪伴 · 快速」API；基础配招可以直接玩。<RouterLink to="/me/api?feature=companion">设置 API</RouterLink></p>
            <div class="preset-row"><label>大乱斗预设<select :value="preset?.id" @change="selectPreset"><option v-for="p in presets" :key="p.id" :value="p.id">{{ p.name }}</option></select></label><RouterLink v-if="preset" :to="`/me/presets/${preset.id}`">编辑预设</RouterLink></div>

            <form v-if="editor" class="fighter-editor" novalidate @submit.prevent="saveEditor">
              <header><h3>编辑 {{ editor.name }}的战斗档案</h3><button type="button" class="icon-action" aria-label="关闭编辑" @click="editor = null"><span class="i-lucide-x" /></button></header>
              <div class="editor-fields"><label>称号<input v-model="editor.title" /></label><label>战斗风格<select v-model="editor.style"><option v-for="(label, key) in BRAWL_STYLES" :key="key" :value="key">{{ label }}</option></select></label><label>血量<input v-model.number="editor.hp" type="number" min="600" max="1600" /></label><label>蓝量<input v-model.number="editor.mp" type="number" min="80" max="200" /></label><label>普攻伤害<input v-model.number="editor.attack" type="number" min="20" max="65" /></label><label>移动速度<input v-model.number="editor.speed" type="number" min="160" max="320" /></label><label>被动名称<input v-model="editor.passive.name" /></label><label>被动效果<select v-model="editor.passive.kind"><option v-for="(label, key) in BRAWL_PASSIVES" :key="key" :value="key">{{ label }}</option></select></label><label>发型<select v-model="editor.look.hair"><option value="short">短发</option><option value="long">长发</option><option value="spiky">翘发</option><option value="pony">马尾</option></select></label><label>发色<input v-model="editor.look.hairColor" type="color" /></label><label>衣服颜色<input v-model="editor.look.outfit" type="color" /></label><label>技能颜色<input v-model="editor.color" type="color" /></label></div>
              <details v-for="(s, i) in editor.skills" :key="i" class="skill-editor"><summary>{{ i === 2 ? '奥义' : `技能${i + 1}` }} · {{ s.name }}</summary><div class="editor-fields"><label>招式名<input v-model="s.name" /></label><label>招式类型<select v-model="s.kind"><option v-for="(label, key) in BRAWL_KINDS" :key="key" :value="key">{{ label }}</option></select></label><label>伤害／护盾<input v-model.number="s.damage" type="number" min="30" :max="i === 2 ? 420 : 210" /></label><label>耗蓝<input v-model.number="s.mana" type="number" :min="i === 2 ? 45 : 10" :max="i === 2 ? 80 : 60" /></label><label>冷却（秒）<input v-model.number="s.cooldown" type="number" :min="i === 2 ? 14 : 3" max="35" step="0.1" /></label><label>范围<input v-model.number="s.range" type="number" min="70" :max="s.kind === 'burst' ? 300 : 650" /></label><label>前摇（秒）<input v-model.number="s.windup" type="number" min="0.1" max="1.2" step="0.01" /></label><label>后摇（秒）<input v-model.number="s.recovery" type="number" min="0.15" max="1" step="0.01" /></label><label>击退<input v-model.number="s.knockback" type="number" min="50" max="380" /></label><label class="check-label"><input v-model="s.launch" type="checkbox" />命中浮空</label></div><label>说明<input v-model="s.description" /></label></details>
              <button class="primary" type="submit">保存战斗档案 <span class="i-lucide-check" /></button>
            </form>
            <details class="how-to"><summary>怎么玩</summary><p>摇杆左右移动，上推跳跃，下拉防御。普攻可以按住，连续三段的末段会挑起对手；闪避消耗 8 蓝，短暂避开攻击。技能需要蓝量，冷却结束后可再次使用。蓝量会缓慢恢复，普攻命中也会回蓝。</p><p>键盘：A / D 移动，W 或空格跳跃，S 防御，J 普攻，K 闪避，U / I 技能，O 奥义，P 或 Esc 暂停。</p><p>90 秒内打空对手的血量即可获胜；超时比较剩余血量比例。返回游戏列表会暂停，回来后点继续。</p></details>
            <div v-if="recent.length" class="history"><h3>最近的交手</h3><div v-for="r in recent" :key="r.id"><span>{{ r.winner === 'draw' ? '平局' : r.winner === 'you' ? '胜利' : '惜败' }}</span><b>{{ r.you }} vs {{ r.opponent }}</b><small>{{ r.seconds }} 秒 · {{ r.combo }} 连击</small></div></div>
          </template>

          <div v-if="inArena && phase !== 'end'" class="controls" :class="{ inactive: phase !== 'playing' }" aria-label="战斗操作">
            <div class="movement"><div class="stick" role="group" aria-label="方向摇杆：上跳下防，左右移动" @pointerdown="stick" @pointermove="stick" @pointerup="stopStick" @pointercancel="stopStick" @lostpointercapture="stopStick"><span class="i-lucide-chevron-up up" /><span class="i-lucide-chevron-down down" /><span class="i-lucide-chevron-left left" /><span class="i-lucide-chevron-right right" /><i class="stick-knob" :style="{ transform: `translate(${stickOffset.x}px, ${stickOffset.y}px)` }" /></div><small>上跳 · 下防</small></div>
            <div class="buttons"><button class="combat utility" aria-label="闪避，K" :disabled="hud[0]!.dash > 0 || hud[0]!.mp < 8" @pointerdown.prevent="action('dash')" @click="($event.detail === 0) && action('dash')"><span class="i-lucide-wind" /><b>闪避</b><small>{{ hud[0]!.dash > 0 ? hud[0]!.dash.toFixed(1) : 'K · 8蓝' }}</small></button><button class="combat basic" aria-label="普通攻击，J，按住连击" @pointerdown="hold($event, 'basic')" @pointerup="release" @pointercancel="release" @lostpointercapture="release" @click="($event.detail === 0) && tapBasic()"><span class="i-lucide-swords" /><b>普攻</b><small>J</small></button><button v-for="(s, i) in hud[0]!.skills" :key="i" class="combat skill" :class="{ ultimate: i === 2 }" :disabled="hud[0]!.cds[i]! > 0 || hud[0]!.mp < s.mana" :aria-label="`${s.name}，${['U','I','O'][i]}，${s.mana} 蓝`" @pointerdown.prevent="action(i)" @click="($event.detail === 0) && action(i)"><span :class="i === 2 ? 'i-lucide-flame' : s.kind === 'shield' ? 'i-lucide-shield' : s.kind === 'dash' ? 'i-lucide-zap' : 'i-lucide-orbit'" /><b>{{ s.name }}</b><small>{{ hud[0]!.cds[i]! > 0 ? `${hud[0]!.cds[i]!.toFixed(1)}s` : `${['U','I','O'][i]} · ${s.mana}蓝` }}</small></button></div>
          </div>
          <p v-if="inArena && phase === 'playing'" class="keyboard-note">A D 移动 · W 跳跃 · S 防御 · J 普攻 · K 闪避 · U I O 技能 · P 暂停</p>
          <p v-if="message" class="message" role="status">{{ message }}</p>
        </div>
      </div>
    </section>
  </Teleport>
</template>

<style scoped>
.brawl { color: var(--ink); width: 100%; min-width: 0; }
.brawl-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 14px; }
.brawl h2 { font-size: 25px; font-weight: 800; letter-spacing: -.025em; line-height: 1.2; margin: 0; }
.brawl h3 { font-size: 16px; font-weight: 700; margin: 0; }
.brawl-heading p { font-size: 12px; color: var(--ink-2); margin: 4px 0 0; }
.heading-actions { display: flex; gap: 6px; align-items: center; }
button, input, select { font: inherit; }
button { cursor: pointer; }
button:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid #d89b40; outline-offset: 3px; }
button:disabled { opacity: .42; cursor: default; }
.icon-action { display: grid; place-items: center; width: 40px; height: 40px; border-radius: 12px; background: var(--panel); font-size: 20px; border: 1px solid var(--border); }
.arena { width: 100%; min-width: 0; position: relative; overflow: hidden; border-radius: 14px; background: #171e38; color: #f8f2e8; isolation: isolate; min-height: 220px; }
.arena.preview { aspect-ratio: 1.85; }
.arena canvas { width: 100%; height: 100%; display: block; position: absolute; inset: 0; }
.hud { position: absolute; z-index: 2; top: 13px; left: 14px; right: 14px; display: grid; grid-template-columns: 1fr 1fr; gap: 58px; pointer-events: none; }
.fighter-hud { min-width: 0; }
.hud-name { display: flex; justify-content: space-between; gap: 4px; align-items: baseline; margin-bottom: 5px; font-size: 13px; }
.hud-name b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hud-name span { font-size: 10px; color: #d0d7e8; flex-shrink: 0; }
.meter { background: #0a1024; position: relative; height: 16px; border-radius: 3px; overflow: hidden; margin-bottom: 4px; }
.meter i { position: absolute; height: 100%; inset: 0 auto 0 0; background: #52ad89; transition: width .08s linear; }
.rival .meter i { left: auto; right: 0; }
.rival .health i { background: #d17a72; }
.meter span { position: relative; display: block; text-align: center; color: #fff; font-size: 10px; font-weight: 700; line-height: 16px; font-variant-numeric: tabular-nums; text-shadow: 0 1px 3px #000; }
.meter.mana { height: 12px; }
.mana i { background: #557fcd; }.mana span { font-size: 9px; line-height: 12px; }
.clock { position: absolute; left: 50%; top: 0; transform: translateX(-50%); font-weight: 800; font-size: 27px; text-align: center; line-height: 1; font-variant-numeric: tabular-nums; }
.clock small { display: block; margin-top: 5px; font-size: 10px; font-weight: 400; color: #c9d1e2; }.clock.urgent { color: #ffc482; }
.battle-line { position: absolute; z-index: 2; top: 85px; left: 16%; right: 16%; margin: 0; text-align: center; font-size: 12px; line-height: 1.6; color: #f7e5c8; text-shadow: 0 2px 4px #000; pointer-events: none; }
.shield-label { font-size: 10px; color: #aadeff; }.stage-caption { position: absolute; bottom: 10px; left: 14px; right: 14px; display: flex; gap: 6px; align-items: center; font-size: 11px; color: #e2dddb; }.stage-caption > span:last-child { margin-left: auto; color: #b9c3d8; }
.matchup { display: grid; grid-template-columns: 1fr 28px 1fr; align-items: center; gap: 10px; margin: 18px 0; }
.player-select, .opponent-name { min-width: 0; font-size: 11px; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px; }
.player-select select { font-size: 16px; font-weight: 700; width: 100%; }.opponent-name strong { font-size: 16px; color: var(--ink); }.opponent-name > span { font-size: 11px; }.versus { text-align: center; font-size: 12px; font-weight: 800; color: var(--ink-3); }
input, select { width: 100%; min-width: 0; color: var(--ink); background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 8px; }
.difficulty-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; font-size: 12px; margin: 14px 0; }.difficulty { display: flex; gap: 4px; }.difficulty button { padding: 7px 13px; border-radius: 7px; color: var(--ink-2); background: var(--surface); }.difficulty .chosen { color: #201b15; background: #edc485; font-weight: 700; }
.primary, .secondary { display: inline-flex; justify-content: center; align-items: center; gap: 8px; border-radius: 9px; min-height: 40px; padding: 9px 14px; font-size: 13px; font-weight: 650; }
.primary { background: #edc485; color: #241e18; }.primary:hover { background: #f6d49d; }.secondary { background: var(--surface); color: var(--ink); border: 1px solid var(--border); }.secondary:hover { background: var(--panel); }.start { width: 100%; font-size: 16px; min-height: 48px; }.start-note { color: var(--ink-3); font-size: 11px; text-align: center; margin: 8px 0 25px; }
.text-action { color: var(--ink-2); font-size: 12px; padding: 8px 4px; text-underline-offset: 3px; }.text-action:hover { text-decoration: underline; }
.loadout-heading { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; margin-bottom: 12px; }.loadout-heading > span { font-size: 11px; color: var(--ink-3); }.loadouts { display: grid; gap: 22px; }.loadout { border-top: 1px solid var(--border); padding-top: 14px; }.loadout header { display: flex; align-items: start; justify-content: space-between; gap: 8px; }.loadout header strong { font-size: 16px; }.loadout header div > span { display: block; font-size: 11px; color: var(--ink-3); margin-top: 3px; }.source-label { font-size: 10px; color: var(--ink-3); padding-top: 3px; }.stats-line { display: flex; gap: 18px; font-size: 12px; margin: 12px 0; }.stats-line > span { display: flex; align-items: center; gap: 5px; }.stats-line i { color: var(--accent-ink); }
.skill-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 14px; }.skill-list li { display: flex; align-items: start; gap: 10px; }.skill-slot { flex-shrink: 0; font-size: 10px; min-width: 38px; padding-top: 3px; color: var(--ink-3); }.skill-slot.ult { color: #b87825; font-weight: 700; }.skill-list b { font-size: 13px; }.skill-list p { font-size: 12px; color: var(--ink-2); line-height: 1.5; margin: 3px 0; }.skill-list small { font-size: 10px; color: var(--ink-3); }.passive { display: flex; gap: 6px; font-size: 11px; color: var(--ink-2); padding-top: 9px; }.loadout-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 12px; }.loadout-actions .secondary { font-size: 12px; }
.wish { display: grid; gap: 7px; font-size: 12px; margin-top: 24px; }.connection-note, .message { font-size: 12px; line-height: 1.6; color: var(--ink-2); }.connection-note a { margin-left: 5px; color: var(--accent-ink); }.preset-row { display: flex; align-items: end; gap: 10px; margin: 15px 0; font-size: 11px; }.preset-row label { display: grid; flex: 1; min-width: 0; gap: 6px; }.preset-row a { flex-shrink: 0; padding-bottom: 10px; color: var(--accent-ink); }
.fighter-editor { margin: 20px 0; border-top: 1px solid var(--border); padding-top: 16px; }.fighter-editor header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 14px; }.editor-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.fighter-editor label { font-size: 11px; display: grid; gap: 5px; }.fighter-editor input[type='color'] { padding: 3px; height: 36px; }.fighter-editor .check-label { display: flex; align-items: center; }.check-label input { width: auto; }.skill-editor { padding: 12px 0; border-bottom: 1px solid var(--border); }.skill-editor summary { font-size: 13px; cursor: pointer; }.skill-editor .editor-fields { padding: 14px 0; }.fighter-editor > .primary { margin-top: 16px; width: 100%; }.how-to { border-top: 1px solid var(--border); margin-top: 20px; padding: 16px 0; font-size: 12px; color: var(--ink-2); }.how-to summary { cursor: pointer; color: var(--ink); }.how-to p { line-height: 1.7; }.history { margin-top: 16px; }.history > div { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 11px 0; font-size: 11px; border-bottom: 1px solid var(--border); }.history b { font-weight: 500; flex: 1; }.history small { color: var(--ink-3); }
/* 战斗页：铺满屏幕的固定层（横屏按它的大小算）；.brawl-box 是战斗层，竖屏时转 90°（左上角放在屏幕右上角，手机往左横过来看就是正的），安全区跟着换边；下面的布局按战斗层自己的宽高（容器查询），转没转都一样 */
.fight-screen { position: fixed; inset: 0; z-index: 100; overflow: hidden; background: #141a2b; color: #f3ede4; overscroll-behavior: contain; touch-action: manipulation; -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; --ink: #f3ede4; --ink-2: #ccd4e4; --ink-3: #a5b2ca; --panel: #252e43; --surface: #20293d; --border: #3b465e; }
.fight-screen .brawl-box { position: absolute; inset: 0; container: brawl / size; --safe-t: env(safe-area-inset-top, 0px); --safe-r: env(safe-area-inset-right, 0px); --safe-b: env(safe-area-inset-bottom, 0px); --safe-l: env(safe-area-inset-left, 0px); }
.fight-screen .brawl-box.rot { inset: auto; top: 0; transform-origin: 0 0; transform: rotate(90deg); --safe-t: env(safe-area-inset-right, 0px); --safe-r: env(safe-area-inset-bottom, 0px); --safe-b: env(safe-area-inset-left, 0px); --safe-l: env(safe-area-inset-top, 0px); }
.fight-screen .brawl-body { height: 100%; display: flex; flex-direction: column; padding: calc(var(--safe-t) + 10px) max(12px, var(--safe-r)) calc(var(--safe-b) + 8px) max(12px, var(--safe-l)); }
.fight-screen .brawl-heading { margin-bottom: 8px; }.fight-screen h2 { font-size: 20px; }.fight-screen .brawl-heading p { font-size: 10px; }.fight-screen .arena { flex: 1; min-height: 160px; }.controls { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 8px 2px; user-select: none; touch-action: none; }.controls.inactive { opacity: .3; pointer-events: none; }.movement { display: flex; flex-direction: column; align-items: center; gap: 5px; flex-shrink: 0; }.movement small { font-size: 10px; color: #aab7d0; }.stick { width: 100px; height: 100px; border-radius: 50%; position: relative; border: 1px solid #5d6b83; background: #242d42; touch-action: none; }.stick > span { position: absolute; color: #b4c0d7; font-size: 17px; }.stick .up { left: 41px; top: 3px; }.stick .down { left: 41px; bottom: 3px; }.stick .left { top: 41px; left: 3px; }.stick .right { top: 41px; right: 3px; }.stick-knob { position: absolute; width: 39px; height: 39px; top: 30px; left: 30px; background: #71809b; border: 2px solid #b1bed5; border-radius: 50%; pointer-events: none; }.buttons { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; max-width: 520px; }.combat { width: 68px; min-height: 72px; border-radius: 13px; background: #2c3750; color: #ecf2ff; border: 1px solid #596883; display: flex; flex-direction: column; justify-content: center; align-items: center; gap: 4px; touch-action: none; user-select: none; padding: 6px 3px; }.combat > span { font-size: 21px; }.combat b { font-size: 11px; max-width: 100%; line-height: 1.15; overflow-wrap: anywhere; }.combat small { font-size: 10px; color: #bdc9dd; font-variant-numeric: tabular-nums; }.combat.basic { min-height: 82px; background: #425b69; border-color: #81adba; }.combat.ultimate { background: #554329; border-color: #c99752; }.combat.ultimate small { color: #ecd3ad; }.combat:active:not(:disabled) { background: #657d9f; transform: translateY(2px); }.combat:disabled { pointer-events: none; }.keyboard-note { color: #acbad3; text-align: center; font-size: 10px; margin: 8px 0 0; }.countdown { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; font-size: 70px; font-weight: 800; text-shadow: 0 4px 15px #000; }.countdown span { font-size: 13px; font-weight: 500; }.ultimate-line { position: absolute; top: 29%; left: 10%; right: 10%; text-align: center; font-weight: 700; color: #ffdc98; font-size: 18px; text-shadow: 0 2px 6px #000; }.combo { position: absolute; top: 33%; left: 4%; color: #ffda9c; font-size: 13px; }.combo.right { left: auto; right: 4%; }.combo b { font-size: 30px; font-style: italic; }.damage-float { position: absolute; font-size: 17px; font-weight: 750; color: #fff1ce; text-shadow: 0 2px 4px #000; pointer-events: none; }.arena-overlay { position: absolute; inset: 0; background: #11182bc9; display: grid; place-items: center; z-index: 5; padding: 18px; overflow: auto; touch-action: manipulation; }.pause-panel, .result-panel { text-align: center; max-width: 470px; width: 100%; }.pause-panel h3, .result-panel h3 { font-size: 25px; }.pause-panel p, .result-panel > p { font-size: 12px; color: #d3dced; margin: 9px 0 20px; }.pause-panel .primary { min-width: 160px; }.pause-panel > .text-action { display: block; margin: 8px auto 0; }.result-icon { font-size: 32px; color: #edc485; margin-bottom: 12px; display: inline-block; }.result-stats { display: flex; justify-content: center; gap: 28px; margin: 14px 0 20px; }.result-stats span { font-size: 10px; color: #bdc9e0; display: flex; flex-direction: column; gap: 4px; }.result-stats b { font-size: 24px; color: #fff3df; font-variant-numeric: tabular-nums; }.result-actions { display: flex; gap: 10px; justify-content: center; }.end-line { max-width: 36em; line-height: 1.6; }.arena-error { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; font-size: 13px; line-height: 1.7; z-index: 8; background: #182139; }.spin { animation: spin 1.3s linear infinite; }@keyframes spin { to { transform: rotate(360deg); } }
@container brawl (min-width: 680px) { .fight-screen .brawl-heading { padding: 0 6px; }.fight-screen .hud { left: 25px; right: 25px; top: 18px; gap: 140px; }.fight-screen .hud-name { font-size: 16px; }.fight-screen .meter.health { height: 20px; }.fight-screen .health span { line-height: 20px; }.fight-screen .clock { font-size: 34px; } }
@container brawl (max-width: 520px) { .controls { gap: 10px; padding-left: 0; padding-right: 0; }.buttons { gap: 6px; max-width: 228px; }.combat { width: 64px; min-height: 66px; }.combat.basic { min-height: 72px; }.fight-screen .arena { flex: none; height: min(53cqh, 86cqw); min-height: 245px; }.keyboard-note { display: none; }.fight-screen .brawl-body { justify-content: center; }.fight-screen .brawl-heading { flex: none; }.fight-screen .controls { flex: none; } }
@container brawl (max-height: 500px) and (min-width: 521px) { .fight-screen .brawl-body { padding-top: max(5px, var(--safe-t)); }.fight-screen .brawl-heading { margin-bottom: 4px; }.fight-screen h2 { font-size: 17px; }.fight-screen .brawl-heading p, .keyboard-note { display: none; }.controls { position: absolute; bottom: max(12px, var(--safe-b)); left: max(25px, var(--safe-l)); right: max(25px, var(--safe-r)); padding: 0; pointer-events: none; z-index: 6; }.movement, .buttons { pointer-events: auto; }.stick { width: 90px; height: 90px; }.stick-knob { top: 25px; left: 25px; }.stick .up, .stick .down { left: 36px; }.stick .left, .stick .right { top: 36px; }.combat { width: 59px; min-height: 61px; background: #26334ce8; }.combat.basic { min-height: 68px; }.hud { top: 9px !important; }.result-panel h3 { font-size: 21px; }.result-icon { display: none; }.result-panel > p { margin: 4px 0 9px; }.result-stats { margin: 8px 0 12px; }.controls.inactive { pointer-events: none; }.controls.inactive .movement, .controls.inactive .buttons { pointer-events: none; } }
@media (prefers-reduced-motion: reduce) { .meter i { transition: none; }.spin { animation: none; }.combat:active { transform: none; } }
</style>
