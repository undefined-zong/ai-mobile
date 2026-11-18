import type { CharacterLive2D, Live2DPose } from '@app/shared';
import { motionEntries, type ModelManifest, type MotionEntry } from './model';

const aliases: Record<string, string[]> = {
  neutral: ['neutral', 'calm', 'normal', '平静'], smile: ['smile', 'smirk', 'happy', 'joy', '微笑'],
  laugh: ['laugh', 'smirk', 'happy'], blush: ['blush', 'soft', 'shy'], shy: ['shy', 'soft', 'blush'],
  pout: ['pout', 'angry', 'cool'], surprised: ['surprised', 'surprise', 'shock'],
  sad: ['sad', 'sadness', 'soft'], angry: ['angry', 'anger', '生气'], sleepy: ['sleepy', 'cool', 'calm'], sleep: ['sleep', 'cool', 'calm'],
};
export const ACTION_LABELS: Record<string, string> = { greeting: '打招呼', agree: '赞同', disagree: '否定' };
export type Cue = keyof typeof ACTION_LABELS;
/** motionMap value: stay still for this cue instead of picking a motion by name. */
export const NO_MOTION = 'none';
const norm = (text: string) => text.normalize('NFKC').trim().toLowerCase();
/** A pose by id, name or one of its other names: what a mapping stores or the model writes in [pose:…]. */
export function findPose(poses: readonly Live2DPose[] | undefined, value: string): Live2DPose | undefined {
  const key = norm(value);
  if (!key || !poses?.length) return undefined;
  return poses.find(p => norm(p.id) === key || norm(p.name) === key)
    ?? poses.find(p => (p.match ?? '').split(/[,，、\n]/).some(alias => norm(alias) === key));
}
/** The pose that goes with a cue or mood when nothing else is chosen. Applied only if the rig has that pose. */
const POSE_DEFAULTS: Record<string, string> = { greeting: 'wave', disagree: 'crossed', angry: 'crossed', pout: 'crossed' };
/** Model expressions that carry a pose of their own: an aloof or angry face goes with folded arms. */
const POSE_BY_FACE: Record<string, string> = { cool: 'crossed', angry: 'crossed' };

/**
 * What a motion is for, read from its group and file name. Latin words must match a whole word
 * ("no" is not "nod", "hi" is not "hiyori"); CJK words match anywhere in the name.
 */
const MOTION_WORDS: Record<string, string[]> = {
  greeting: ['greeting', 'greet', 'wave', 'waving', 'hello', 'hi', 'bye', 'goodbye', '挥手', '招手', '打招呼', '问好', '你好', '再见', '手を振', 'あいさつ', '挨拶'],
  agree: ['nod', 'nodding', 'agree', 'yes', 'ok', '点头', '同意', '赞同', 'うなず', '頷'],
  disagree: ['shake', 'shaking', 'disagree', 'no', 'deny', 'refuse', '摇头', '否定', '拒绝', '首を振', 'いいえ'],
  smile: ['smile', 'happy', 'joy', 'glad', '微笑', '开心', '高兴'],
  laugh: ['laugh', 'laughing', '大笑'],
  blush: ['blush', '脸红'],
  shy: ['shy', 'embarrassed', '害羞'],
  pout: ['pout', 'sulk', '嘟嘴', '撒娇'],
  surprised: ['surprise', 'surprised', 'shock', 'shocked', '惊讶', '吃惊', '驚'],
  sad: ['sad', 'cry', 'crying', 'sorrow', '难过', '伤心', '哭'],
  angry: ['angry', 'anger', 'mad', '生气', '愤怒'],
  sleepy: ['sleepy', 'yawn', '犯困', '哈欠'],
  sleep: ['sleep', 'sleeping', '睡着', '睡觉'],
};
const IDLE_WORDS = ['idle', 'standby', 'wait', 'waiting', 'home', '待机', '待機'];
const BLINK_WORDS = ['blink', 'eyeblink', '眨眼', 'まばたき'];

function words(text: string): { tokens: Set<string>; raw: string } {
  const raw = text.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return { tokens: new Set(raw.split(/[^a-z]+/).filter(Boolean)), raw };
}
function has(name: { tokens: Set<string>; raw: string }, list: string[]): boolean {
  return list.some(word => /^[a-z]+$/.test(word) ? name.tokens.has(word) : name.raw.includes(word));
}
/** "wave-to-rest" ends at rest: a transition clip is named after where it arrives, not where it starts. */
function destination(stem: string): string {
  return /^.+[-_\s]to[-_\s](.+)$/i.exec(stem)?.[1] ?? stem;
}

export interface AutoMotions {
  /** Played in turn whenever nothing else is playing. */
  idle: string[];
  /** greeting / agree / disagree / mood → motion key, for whatever the names give away. */
  map: Record<string, string>;
  /** greeting / disagree / mood → pose id that goes with it on a rig that has poses. */
  pose: Record<string, string>;
  /** Pose ids the rig has. */
  poses: string[];
}

/** "rest-to-wave" on a rig whose poses are rest and wave: the way between two poses, not a motion of its own. */
export function isPoseTransition(stem: string, poses: readonly Live2DPose[] | undefined): boolean {
  const parts = /^(.+?)[-_\s]to[-_\s](.+)$/i.exec(stem);
  return !!parts && !!poses?.some(p => norm(p.id) === norm(parts[1]!)) && poses.some(p => norm(p.id) === norm(parts[2]!));
}

/** Runtime fallback for every motionMap entry left on "auto", and the first guess written at upload. */
export function autoMotions(entries: Pick<MotionEntry, 'key' | 'group' | 'stem'>[], poses: readonly Live2DPose[] = []): AutoMotions {
  const named = entries.filter(e => !isPoseTransition(e.stem, poses))
    .map(e => ({ key: e.key, group: words(e.group), name: words(destination(e.stem)), full: words(`${e.group} ${e.stem}`) }));
  const idle = named.filter(e => has(e.group, IDLE_WORDS) || has(e.name, IDLE_WORDS));
  const usable = named.filter(e => !idle.includes(e) && !has(e.full, BLINK_WORDS));
  const map: Record<string, string> = {};
  const pose: Record<string, string> = {};
  for (const [cue, list] of Object.entries(MOTION_WORDS)) {
    // The file name is more specific than the group it was filed under.
    const hit = usable.find(e => has(e.name, list)) ?? usable.find(e => has(e.group, list));
    if (hit) map[cue] = hit.key;
    const posed = poses.find(p => has(words(`${p.id} ${p.name}`), list)) ?? poses.find(p => p.id === POSE_DEFAULTS[cue]);
    if (posed) pose[cue] = posed.id;
  }
  return { idle: idle.map(e => e.key), map, pose, poses: poses.map(p => p.id) };
}

/**
 * The pose "auto" picks for a cue or mood, '' when it leaves the pose alone.
 * face is the model expression the mood shows with; some faces bring a pose even when the mood has none.
 */
export function autoPose(auto: AutoMotions, key: string, face = ''): string {
  const byFace = POSE_BY_FACE[norm(face)];
  return auto.pose[key] ?? (byFace && auto.poses.includes(byFace) ? byFace : '');
}

/** Rebuild the entries the settings page needs from what is stored on the character. */
export function storedMotions(config: Pick<CharacterLive2D, 'motions' | 'motionLabels'>): MotionEntry[] {
  return config.motions.map(key => {
    const group = key.slice(0, key.lastIndexOf(':'));
    const label = config.motionLabels?.[key] ?? key;
    return { key, group, label, stem: (label.split(' · ').pop() ?? label).replace(/ #\d+$/, '') };
  });
}

export function motionLabel(config: Pick<CharacterLive2D, 'motionLabels'>, key: string): string {
  return config.motionLabels?.[key] ?? key;
}

export function defaultBindings(m: ModelManifest, poses: readonly Live2DPose[] = []): Pick<CharacterLive2D, 'expressions' | 'motions' | 'motionLabels' | 'expressionMap' | 'motionMap'> {
  const expressions = (m.FileReferences.Expressions ?? []).map(e => e.Name);
  const entries = motionEntries(m);
  const find = (candidates: string[]) => candidates.map(a => expressions.find(e => e.toLowerCase() === a)).find(Boolean) ?? '';
  const expressionMap = Object.fromEntries(Object.entries(aliases).map(([key, candidates]) => [key, find(candidates) || find(aliases.neutral!)]));
  const auto = autoMotions(entries, poses).map;
  const motionMap = Object.fromEntries([...Object.keys(ACTION_LABELS), ...Object.keys(aliases)].map(key => [key, auto[key] ?? '']));
  return { expressions, motions: entries.map(e => e.key), motionLabels: Object.fromEntries(entries.map(e => [e.key, e.label])), expressionMap, motionMap };
}

const PUNCT = '[\\s，。！？!?,.~～…、”"）)」』]';
const SOFT = '[呀啊哇哦喔呢吗嘛哈]';
const START = '(?:^|[\\s，。！？!?,.~～…、“"（(「『])';
const GREETING = new RegExp([
  // "你好像…""你好厉害""对你好" are not greetings: the word has to open a clause and end the phrase.
  `${START}(?:你好|您好|大家好|嗨|哈喽|哈啰|早安|早上好|早呀|早啊|中午好|下午好|晚上好|好久不见|欢迎回来)(?=$|${PUNCT}|${SOFT})`,
  // "再见面""再见到你" go on; a farewell stops there.
  `(?:晚安|再见|拜拜|回头见|明天见)(?=$|${PUNCT}|${SOFT}|[啦了咯喽])`,
  '挥手|招手|挥了挥手|招了招手',
  '\\b(?:hello|hi|hey|goodbye|bye|good (?:morning|afternoon|evening|night)|see you)\\b',
].join('|'), 'i');
// A reply opens its clause with the word: "对你好的""可不可以陪我" contain 好的 / 可以 without agreeing to anything.
const LEAD = '(?:当然|绝对|肯定|就是|[那嗯哦噢啊哈哼才就可]){0,2}';
// "不要紧""不对劲""不能再等了" go on; a refusal stops, or points at what is refused.
const DISAGREE = new RegExp([
  `${START}${LEAD}(?:不行|不可以|不同意|不对|不要|不能)(?=$|${PUNCT}|${SOFT}|[啦了咯的呢]|这样|那样)`,
  '别这样|才不|不是的|没门|休想|想都别想|拒绝|摇头|摇了摇头',
  '\\b(?:no|nope|disagree)\\b',
].join('|'), 'i');
const AGREE = new RegExp([
  `${START}${LEAD}(?:好呀|好啊|好的|好吧|可以|没问题|当然|嗯嗯|行啊|行吧|对的|是的|没错|同意)`,
  '点头|点了点头',
  '\\b(?:yes|yeah|yep|sure|agree|agreed|no problem|no worries)\\b',
].join('|'), 'i');
// 呢 / 嘛 also end plain statements ("才不要呢"), so only 吗 / 么 and question marks count.
const QUESTION = /[?？]|[吗么][。！!~～…\s"”」』）)]*$/;

/** Which gesture the spoken sentence calls for. Questions are not answers, so they neither nod nor shake. */
export function dialogueCue(text: string): Cue | '' {
  const line = text.trim();
  if (!line) return '';
  if (GREETING.test(line)) return 'greeting';
  if (QUESTION.test(line)) return '';
  if (/\bno (?:problem|worries)\b/i.test(line)) return 'agree';
  if (DISAGREE.test(line)) return 'disagree';
  if (AGREE.test(line)) return 'agree';
  return '';
}

export function mouthLevel(level: number, audible: boolean): number {
  return audible && Number.isFinite(level) && level > 0.035 ? Math.min(1, Math.max(0, level)) : 0;
}
