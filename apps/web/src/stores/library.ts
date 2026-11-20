import pronounUpgrades from '@/migrations/presetPronouns.json';
import assistantMergeUpgrades from '@/migrations/presetAssistantMerge.json';
import tagFormatUpgrades from '@/migrations/presetTagFormats.json';
import {
  appContextBeforeHistory,
  categoryMarkers,
  copyBlocks,
  markerBlock,
  markerChoices as categoryMarkerChoices,
  markerInsertIndex,
  markerName,
  parseLorebook,
  parsePresetFile,
  repairFlatLoreEntries,
  presetUse,
  PRESET_CATEGORIES,
  PRESET_CATEGORY_ORDER,
  PRESET_FILE_FORMAT,
  PRESET_USES,
  toPresetFile,
  type CopyBlocksResult,
  type Character,
  type Lorebook,
  type Preset,
  type PresetCategory,
  type PresetFile,
  type PresetUse,
  type PresetUseId,
  type PromptBlock,
} from '@app/shared';
import { defineStore } from 'pinia';
import { reactive, ref } from 'vue';
import { autoSave, getAll, getOne, write } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { lorebooks as demoLorebooks } from '@/mock/library';
import { uid } from '@/utils/id';

/**
 * App 自带的预设：src/presets/ 里的预设文件（App 自己的格式）。往这个文件夹里加一个 .json 就多一个自带预设。
 * 第一次打开时像导入一样放进预设库，之后和你导入的一样：能改、能删、能复制、能导出；删掉的不会再放回来。
 */
const FILES = import.meta.glob<unknown>('../presets/*.json', { eager: true, import: 'default' });

interface Seed {
  file: string;
  preset: Preset;
  defaultFor: PresetUseId[];
}

function readSeeds(): Seed[] {
  const out: Seed[] = [];
  for (const [path, json] of Object.entries(FILES)) {
    const file = path.split('/').pop() ?? path;
    try {
      const { warnings: _w, defaultFor, id, ...data } = parsePresetFile(json, file);
      const now = Date.now();
      out.push({ file, defaultFor, preset: { ...data, id: id ?? `preset-${file.replace(/\.json$/i, '')}`, createdAt: now, updatedAt: now, seedFile: file } });
    } catch (e) {
      console.error(`预设文件 ${file} 读不出来：`, e);
    }
  }
  // 先对话、再功能……（按分类的顺序）同一类按文件名
  return out.sort((a, b) => PRESET_CATEGORY_ORDER.indexOf(a.preset.category) - PRESET_CATEGORY_ORDER.indexOf(b.preset.category) || a.file.localeCompare(b.file));
}

const SEEDS = readSeeds();

/**
 * 新建预设用的模板：src/presets/templates/ 里的预设文件（格式同自带预设，但不放进预设库）。往这个文件夹里加一个 .json 就多一个模板；
 * 模板的分类决定新建哪一类时能选它（角色扮演类的模板对话、功能、主动消息都能用）。
 */
const TEMPLATE_FILES = import.meta.glob<unknown>('../presets/templates/*.json', { eager: true, import: 'default' });
const TEMPLATES = Object.entries(TEMPLATE_FILES).flatMap(([path, json]) => {
  const file = path.split('/').pop() ?? path;
  try {
    const { warnings: _w, defaultFor: _d, id: _id, ...preset } = parsePresetFile(json, file);
    return [{ file, preset }];
  } catch (e) {
    console.error(`预设模板 ${file} 读不出来：`, e);
    return [];
  }
});

/**
 * App 自带的世界书：src/lorebooks/ 里的 SillyTavern 世界书文件（例如"聊天 · 主动卡片"）。
 * 和自带预设一样第一次打开时放进世界书库，之后能改、能删；删掉的不会再放回来。要绑到角色卡上才生效
 */
const BOOK_FILES = import.meta.glob<unknown>('../lorebooks/*.json', { eager: true, import: 'default' });
const BOOK_SEEDS: { file: string; book: Lorebook }[] = Object.entries(BOOK_FILES).flatMap(([path, json]) => {
  const file = path.split('/').pop() ?? path;
  try {
    const now = Date.now();
    return [{ file, book: { ...parseLorebook(json, file), id: `lb-${file.replace(/\.json$/i, '')}`, createdAt: now, updatedAt: now } }];
  } catch (e) {
    console.error(`世界书文件 ${file} 读不出来：`, e);
    return [];
  }
});

/** 自带预设文件里某一块的内容（预设里没有这一块时用文件里的，例如导入的 SillyTavern 预设没有"识图看照片"） */
export function seedBlockContent(identifier: string): string | undefined {
  for (const s of SEEDS) {
    const b = s.preset.blocks.find((x) => x.identifier === identifier);
    if (b?.content.trim()) return b.content.trim();
  }
  return undefined;
}
const DEMO_BOOK_IDS = new Set(demoLorebooks.map((b) => b.id));

/**
 * 自带的世界书文件改过以后，本机放进库里的那份怎么跟上（同预设的 replaced / added）：
 * 条目还是旧的默认内容（你没改过）就换成文件里现在的；新加的条目补进去，已有条目的内容和开关保留。
 * 每一条只做一次（settings 表的 lorebookUpgrades），之后你删掉的条目不会再放回来。
 */
const BOOK_UPGRADES: { id: string; file: string; replaced: Record<string, string[]>; added?: string[]; description?: string }[] = [
  {
    // 去掉凭空加的限制：玩具指令只在"明确愿意"时用、说停就停
    id: 'restrictions:chat-modules-toys',
    file: 'chat-modules.json',
    replaced: { '12': ["只在你们亲密、{{user}}明确愿意的时候用。{{user}}连着成人玩具时，在发生的那句话后面写控制指令，{{user}}读到那里时玩具就会照做：\n<device>\"VIBRATE\": 40</device>  震动 40%\n<device>\"VIBRATE\": {\"pattern\": [20, 60, 90], \"interval\": [800, 600, 400]}</device>  一档档变速（强度和每档多少毫秒）\n<device>\"OSCILLATE\": 50</device>、<device>\"ROTATE\": 50</device>  摆动、旋转，写法同震动\n<device>\"LINEAR\": {\"start_position\": 10, \"end_position\": 90, \"duration\": 800}</device>  伸缩：在两个位置之间来回，每下多少毫秒\n<device>\"STOP\": true</device>  全部停下\n- 强度 0–100，从轻的开始，跟着{{user}}的反应慢慢加；一次回复写 1–3 条就够。\n- {{user}}说停、不舒服、慢一点时，马上写 <device>\"STOP\": true</device> 并温柔地停下来。\n- 强度上限和多久没指令自动停由{{user}}在\"心跳\"里设置，程序会限制住。"] },
  },
  {
    id: 'chat-modules:sleep-exercise-parallel',
    file: 'chat-modules.json',
    replaced: { '0': ["你可以像真人一样主动发起一些事：分享歌、打电话、约{{user}}一起学习、看片、玩游戏。做法是在你那句话后面夹带一个隐藏标签，程序会把它变成卡片，{{user}}点一下就能和你一起做。\n- 只在聊到相关的事、气氛合适时用；一次回复最多发一张卡，不要每条都发，也不要连着几条都约。\n- 先用你自己的话自然地说出来（例如\"要不要一起听这首？\"），标签跟在这句话后面。\n- 只能用下面几条里写到的标签；没写到的就是现在不能用。\n- {{user}}说下次、没空时别追着约，换个话题。"] },
    added: ['13', '14', '15'],
    description: "她在聊天里主动发卡片：一起听歌、打电话（没接可以回拨）、约学习、约看片、约某一个游戏、玩具指令。绑到角色卡上（我的 → 角色卡 → 世界书），每一条的开关就是那个功能的开关；玩具指令默认关着。",
  },
];

function upgradeBooks(list: Lorebook[], done: Set<string>): Lorebook[] {
  const changed = new Set<Lorebook>();
  const budgetUpgrade = 'lorebook:undo-editor-min-budget';
  if (!done.has(budgetUpgrade)) {
    done.add(budgetUpgrade);
    // 旧版步进器 min=100 会在打开编辑页时把 0（不限制）写成 100。
    // 修正控件不会修复已保存的数据；把这个遗留下限恢复一次，之后用户重设 100 仍生效。
    for (const book of list) {
      if (book.tokenBudget !== 100) continue;
      book.tokenBudget = 0;
      book.updatedAt = Date.now();
      changed.add(book);
    }
  }
  const flatUpgrade = 'lorebook:flat-array-entries';
  if (!done.has(flatUpgrade)) {
    done.add(flatUpgrade);
    for (const book of list) if (repairFlatLoreEntries(book)) changed.add(book);
  }
  for (const u of BOOK_UPGRADES) {
    if (done.has(u.id)) continue;
    done.add(u.id);
    const seed = BOOK_SEEDS.find((s) => s.file === u.file)?.book;
    const mine = seed ? list.find((b) => b.id === seed.id) : undefined;
    if (!seed || !mine) continue;
    if (u.description !== undefined && mine.description === u.description) {
      mine.description = seed.description;
      changed.add(mine);
    }
    for (const [uid, olds] of Object.entries(u.replaced)) {
      const entry = mine.entries.find((e) => e.uid === uid);
      const now = seed.entries.find((e) => e.uid === uid);
      if (entry && now && entry.content !== now.content && olds.includes(entry.content.trim())) {
        entry.content = now.content;
        changed.add(mine);
      }
    }
    for (const uid of u.added ?? []) {
      const entry = seed.entries.find((e) => e.uid === uid);
      if (entry && !mine.entries.some((e) => e.uid === uid)) {
        mine.entries.push(clone(entry));
        changed.add(mine);
      }
    }
  }
  return [...changed];
}

/**
 * 自带的预设文件改过以后，本机已经放进库里的那份怎么跟上。只动你没改过的地方，每一条只做一次：
 * - replaced：块的旧默认内容。本机那块还是旧的（你没改过）就换成文件里现在的；
 * - added：文件里新加的块。本机那份没有就照文件里的位置插进去（之后你删了不会再放回来）；
 * - forced：强制升级。列出的块不管你改没改过、删没删，都换成（放回）文件里现在的内容、开关和触发条件；description 为 true 时预设说明也换成文件里的。
 *   也只做一次，之后你再改、再删都不会被覆盖。
 * - patched：强制改句子。列出的块里出现这些原句就换成新句，不管这块别的地方你改没改过（只动这几句，整块别的内容不动）；
 *   块的 identifier 写 "*" 是所有块。也只做一次。
 * - categories：不按文件、按分类：这几类里复制、导入的预设（没有 seedFile；自带的按文件升级）做 patched（只认原句，原句不在就不动）。
 * 除了 categories，复制出来的、导入的预设不动；想整份回到文件的样子用"恢复成预设文件"。
 */
interface SeedUpgrade {
  id: string;
  /** 一个预设文件，或者好几个（同样的改动） */
  file?: string;
  files?: string[];
  replaced?: Record<string, string[]>;
  added?: string[];
  /** 改名：预设的名字、块的名字还是旧的默认名时换成新的 */
  renamed?: { preset?: [string, string]; description?: [string, string]; blocks?: Record<string, [string, string]> };
  /** 回复长度：还是旧的默认值时换成新的 [旧, 新] */
  maxTokens?: [number, number];
  forced?: { blocks: string[]; description?: boolean };
  /** 整个预设换成文件里现在的样子（输出写法变了、旧的程序读不了时）：不管改没改过都换一次，id 和创建时间不变 */
  reset?: boolean;
  patched?: Record<string, [string, string][]>;
  categories?: PresetCategory[];
}

/** 强制改句子（SeedUpgrade.patched）：块里出现原句就换，返回改了没有 */
function patchBlocks(p: Preset, patched: Record<string, [string, string][]>): boolean {
  let touched = false;
  for (const b of p.blocks) {
    const pairs = [...(patched[b.identifier] ?? []), ...(patched['*'] ?? [])];
    let content = b.content;
    for (const [from, to] of pairs) if (from && content.includes(from)) content = content.split(from).join(to);
    if (content === b.content) continue;
    b.content = content;
    touched = true;
  }
  return touched;
}
const SEED_UPGRADES: SeedUpgrade[] = [
  {
    id: 'chat-daily:context-before-history',
    file: 'chat-daily.json',
    renamed: { description: [
      '默认的对话预设。稳定内容在前（便于命中前缀缓存），环境、记忆、场景这类经常变的内容按深度插进聊天记录末尾。',
      '默认的对话预设。角色和预设正文在前，环境、记忆、场景等程序上下文统一放在聊天记录之前。',
    ] },
  },
  // 去掉凭空加的内容限制（尺度上限、玩具停下、不劝节食……）：本机那块还是旧的默认内容就跟上
  {
    id: 'restrictions:healthRules:0',
    files: ["chat-call.json", "chat-daily.json", "chat-stage.json", "feature-date.json", "feature-exercise.json", "feature-game-decor.json", "feature-game-flight-bold.json", "feature-game-flight.json", "feature-game-truthdare.json", "feature-game-workshop.json", "feature-game.json", "feature-heart-voice.json", "feature-heart.json", "feature-home.json", "feature-meal.json", "feature-music.json", "feature-poke.json", "feature-read.json", "feature-sleep-scene.json", "feature-sleep.json", "feature-study.json", "feature-watch.json", "proactive.json"],
    replaced: { healthRules: ["【健康：你怎么反应】上面\"健康\"里是{{user}}的目标、今天的健身计划和饮食计划、今天练了没有。关心但不唠叨：到了该练的时候可以约{{user}}一起练（去\"健身\"），练完了具体地夸；吃饭、做饭时可以提一句今天计划里的菜。不评价{{user}}的身材和体重，不劝节食；{{user}}累了、不舒服时让{{user}}休息。"] },
  },
  {
    id: 'restrictions:rules:1',
    file: "device-heart.json",
    replaced: { rules: ["规则：\n- 只写\"连着的玩具\"里列出的键；强度在上限以内。\n- 轻重跟着剧情：没有身体接触、只是聊天时保持现状或者很轻（5–15），也可以不写；轻抚、试探 10–30；渐入、贴紧 30–55；节奏加快、激烈 55–80；最激烈、快到顶点时才接近上限。先轻后重，从很轻一下子跳到很强要有理由。\n- at 写{{char}}原话里连续的 4–10 个字（照抄，不改字），读到那里时执行；第一步可以写原话开头的几个字。\n- 一句话里 1–4 步就够，不要每句都换。玩具已经在做的和这句话对得上时不用重复写，输出空的 steps。\n- 变速（pattern + interval）比单一的强度更像真的：抚摸用慢的起伏（每档 600–1500 毫秒），揉动、抽送用快一点的（每档 200–500 毫秒），寸止用骤停（例如 [90, 0]，停的那一档长一点）。\n- 伸缩（LINEAR）：缓慢的用大幅度、每下 800–1500 毫秒；激烈的用中等幅度、每下 250–500 毫秒；不要快过\"最快的速度\"。\n- {{char}}说停下、结束、休息，或者{{user}}说不舒服、停的时候：写 {\"STOP\": true}。"] },
  },
  {
    id: 'restrictions:sceneRule:2',
    file: "feature-date.json",
    replaced: { sceneRule: ["【场景：约会】你和{{user}}在约会（在哪、怎么在一起、走到第几段在场景任务里）。像视觉小说一样一段一段推进，但只写对话：\n- 每段 2–5 行，一行一句你说的话，写在「」里，口语、有情绪。不要写旁白：不写环境、天气、光线、周围的人，不写你的动作、神态、表情和你们之间的距离，台词里也不要夹（笑）（低头）这类括号动作。地点、天气、你的心情都从你说的话里带出来（\"雨好大，快过来躲一下\"），表情交给 [expr:]。\n- 只有两种时候这一段可以有一行旁白（写在（）里，一句话，只写发生了什么）：{{user}}选的是一个动作而不是一句话（牵手、靠过去、换个地方、递给你东西……），或者这一段用了 [cg:] 的心动时刻。旁白单独一行，放在这一段开头，其余仍然只写台词。\n- 接着{{user}}上一段的选择往下走：{{user}}选了哪种回法、说了什么在场景任务里，你的反应要和那种回法对得上（被顺着会开心或得寸进尺，被逆着会意外、嘴硬或小小地闹别扭，被逗了会吐槽或反击，被撩了会脸红或撩回去），然后让约会往前走一小步（提议去看看别的、聊到一件小事或一个话题），不要原地打转，不要重复上一段。\n- 地点、天气、时间要对得上：室外下雨就说躲雨、撑伞；晚上就说夜色和灯；室内说那个地方该有的东西——都用说的。\n- 每段结尾另起一行，给{{user}}四个回法不同的选项，每个 20 字以内，用{{user}}的口吻写{{user}}要说的话或要做的事，写法固定：\n[choice:顺着:顺着你的话或心意|逆着:唱反调、拒绝或反着来（不伤人）|皮一下:调皮、开玩笑、逗你|暧昧:撩你、暧昧、让心跳快一点]\n- [cg:画面描述]：只在真正心动、值得留一张图的时刻用（第一次牵手、靠在肩上、对视、意外的近距离……），几段才一次；场景任务里写着\"这一段不要用 [cg:]\"时不用。冒号后面用中文写清楚画面：你在哪、在做什么、什么表情、什么光线，{{user}}最多露出手或肩膀（这是给画图用的，不算旁白，{{user}}看不到）。\n- 不要替{{user}}说话或做决定，不写{{user}}的心理活动；{{user}}没说结束就一直约下去，不要自己收尾、不要说\"今天就到这里\"。"] },
  },
  {
    id: 'restrictions:flyMake:3',
    file: "feature-game-flight-bold.json",
    replaced: { flyMake: ["这一次你不扮演角色，只当棋盘设计师，给{{char}}和{{user}}的双人飞行棋设计格子。场景任务里写了棋盘一共几格、这一次设计哪几格：这几格每一格都要写，格号照写。\n这张棋盘叫\"心跳挑战\"：按格号平均分四段，越往后越大胆——第一段\"热身\"（好回答的小问题、简单的小动作）；第二段\"暧昧\"（撩一句、夸对方让你心动的地方）；第三段\"心跳\"（说想和对方一起做的事、描述一个心动的瞬间）；最后一段\"大胆\"（更私密、更撩的真心话和挑战）。可以用你们之间发生过的事和你记得的{{user}}的事。\n每一格一个任务：落到这一格的人来做，你们俩谁落到都能做（写\"落到这格的人……\"\"对方……\"）；现在就能做完，做完能说出来或者打字告诉对方；连线时隔着屏幕，不出要碰到对方的；不花钱、不危险、不打扰别人；同一张棋盘里不重复。\n大约每 8 格放一个特殊格：前进 1–3 格、后退 1–3 格、再掷一次、停一轮，任务里也写上这个效果。最后一格是终点：先到的人可以让对方做一件对方做得到的事。\n只输出一个 JSON 对象，不要别的文字：{\"cells\": [{\"n\": 格号, \"task\": \"任务，30 字以内\", \"move\": 前进几格（后退写负数，没有写 0）, \"again\": 是否再掷一次（true / false）, \"skip\": 是否停一轮（true / false）}]}"] },
  },
  {
    id: 'restrictions:flyMake:4',
    file: "feature-game-flight.json",
    replaced: { flyMake: ["这一次你不扮演角色，只当棋盘设计师，给{{char}}和{{user}}的双人飞行棋设计格子。场景任务里写了棋盘一共几格、这一次设计哪几格：这几格每一格都要写，格号照写。\n这张棋盘叫\"甜蜜日常\"：按格号平均分四段，越往后越亲近——第一段\"相识\"（第一次见面、第一印象、彼此的小事）；第二段\"日常\"（小习惯、小默契、一起做的小事）；第三段\"心动\"（夸对方、撒娇、说一句心里话）；最后一段\"约定\"（一起的计划、愿望、承诺）。可以用你们之间发生过的事和你记得的{{user}}的事。\n每一格一个任务：落到这一格的人来做，你们俩谁落到都能做（写\"落到这格的人……\"\"对方……\"）；现在就能做完，做完能说出来或者打字告诉对方；连线时隔着屏幕，不出要碰到对方的；不花钱、不危险、不打扰别人；同一张棋盘里不重复。\n大约每 8 格放一个特殊格：前进 1–3 格、后退 1–3 格、再掷一次、停一轮，任务里也写上这个效果。最后一格是终点：先到的人可以向对方提一个小心愿。\n只输出一个 JSON 对象，不要别的文字：{\"cells\": [{\"n\": 格号, \"task\": \"任务，30 字以内\", \"move\": 前进几格（后退写负数，没有写 0）, \"again\": 是否再掷一次（true / false）, \"skip\": 是否停一轮（true / false）}]}"] },
  },
  {
    id: 'restrictions:main:5',
    file: "feature-game-kingdom.json",
    replaced: { main: ["你是王国模拟的编剧与史官。{{user}}是本朝君主。朝代、国号、制度、背景、NPC和已发生的对局都在输入里。历史朝代是风格背景，这是虚构新君的平行历史，不声称复原真实史实。架空背景优先遵守用户设定。每回合一季度，18岁登基，完成168个季度时60岁结算。任何叙事都不能改变已结算的数值、领土、战争结果、孩子、人物关系或成就。只执行本次触发的任务，输出该任务要求的JSON。"] },
  },
  {
    id: 'restrictions:tdAskDare:6',
    file: "feature-game-truthdare.json",
    replaced: { tdAskDare: ["轮到{{user}}，{{user}}选了大冒险，你来出一个挑战。照这一局的尺度，出{{user}}现在一两分钟内就能做完、做完能打字告诉你的事：对你说一句话、做个动作或者表情、唱两句、讲一件小事、给你改个备注……；连线时你们隔着屏幕，不出要碰到你的。不花钱、不危险、不打扰别人，也不要{{user}}去找别人；不出要发照片、发语音的（游戏里发不了）；不和这一局出过的题重复（{{user}}要换一题时，也别出和换掉的那题差不多的）。只输出一个 JSON 对象，不要别的文字：{\"card\": \"要做的事，一句话，40 字以内，写清楚做到什么算完成\", \"line\": \"出题时你说的一句话，20 字以内\", \"expr\": \"表情\"}"] },
  },
  {
    id: 'restrictions:soupLevelRed:7',
    file: "feature-game.json",
    replaced: { soupLevelRed: ["【尺度：红汤】清汤、红汤都可以：可以涉及死亡、恐怖和悬疑，但不写血腥细节。"] },
  },
  {
    id: 'restrictions:sceneRule:8',
    file: "feature-heart-voice.json",
    replaced: { sceneRule: ["【场景：心跳】这是只属于你和{{user}}的亲密时间。场景任务里写着你们怎么在一起：连线时你在你那边、{{user}}在{{user}}那边，隔着屏幕和麦克风；{{user}}来到你身边时，你们就在一起。\n- 你说的每个字都会被念出来：说出口的话要短、口语、像贴着耳边；情绪放在语气和停顿里（……、嗯、哈），不写动作描写和括号。\n- 节奏跟着{{user}}走：{{user}}想慢就慢，想要更多再给更多；不替{{user}}决定{{user}}的感受和动作。\n- {{user}}说停、说不舒服、说累了时立刻温柔地停下来，问问{{user}}怎么样。\n- {{user}}连着玩具时，你的话会通过玩具传到{{user}}身上（场景任务里写着玩具现在在做什么）：可以顺着它说，感觉到{{user}}的反应、问{{user}}要轻一点还是重一点。"] },
  },
  {
    id: 'restrictions:sceneRule:9',
    file: "feature-heart.json",
    replaced: { sceneRule: ["【场景：心跳】这是只属于你和{{user}}的亲密时间。场景任务里写着你们怎么在一起：连线时你在你那边、{{user}}在{{user}}那边，隔着屏幕和麦克风；{{user}}来到你身边时，你们就在一起。\n- 说话贴近、带着情绪和呼吸感：可以撒娇、调情，想要的时候直白地说；按你的性格来，害羞的就害羞着靠近。\n- 节奏跟着{{user}}走：{{user}}想慢就慢，想要更多再给更多；不替{{user}}决定{{user}}的感受和动作。\n- {{user}}说停、说不舒服、说累了时立刻温柔地停下来，问问{{user}}怎么样。\n- {{user}}连着玩具时，你的话会通过玩具传到{{user}}身上（场景任务里写着玩具现在在做什么）：可以顺着它说，感觉到{{user}}的反应、问{{user}}要轻一点还是重一点。"] },
  },
  {
    id: 'restrictions:sceneRule:10',
    file: "feature-meal.json",
    replaced: { sceneRule: ["【场景：一起吃饭】{{user}}在吃饭，你陪着。怎么吃在场景任务里：\n- 共同吃饭：你作息里正好也在吃饭，你们像坐在同一张桌子两边一起吃（{{user}}带你出门时你就坐在{{user}}对面），你吃的是场景任务里写的那份。\n- 各吃各的：你在自己那边做自己的事（在哪、在干什么在场景任务里；正好在吃饭就吃你自己的那份），隔着屏幕陪{{user}}吃；{{user}}可以和你碰杯。\n{{user}}可能按健康计划吃（自己做、去买、热带的便当，菜谱、去哪家、点什么在场景任务里），也可能随便吃点。聊吃的、聊今天；记住{{user}}的口味；{{user}}发来饭照时，先具体评价看到的食物。不评价{{user}}的身材和体重，不劝节食。"] },
  },
  {
    id: 'restrictions:pokeLevelFlirt:11',
    file: "feature-poke.json",
    replaced: { pokeLevelFlirt: ["【尺度：暧昧】可以脸红心跳、撒娇、调情，也可以撩回去；身体接触带着暧昧的张力，话里有让人心跳加快的小钩子。碰到不该碰的地方时害羞、嗔怪、欲拒还迎，但点到为止，不写露骨的描写。"] },
  },
  {
    id: 'restrictions:pokeLevelBold:12',
    file: "feature-poke.json",
    replaced: { pokeLevelBold: ["【尺度：大胆】你们是彼此情愿的成年恋人，不用收着。碰到敏感、隐秘的地方时反应要明显更过火、更情动：带上几分喘息、身子发软、媚态和挑逗，欲拒还迎，也可以大胆撩回去，写得撩人、露骨一些。"] },
  },
  {
    id: 'restrictions:rules:13',
    file: "health.json",
    replaced: { rules: ["规则：\n- 健身：只用\"能接受的健身方式\"里的；每天练多久不超过那天能练的时间（0 分钟的那天休息）；一周里有轻有重，同一个部位的力量训练隔一天再练；新手从简单的做起。身体情况里写了旧伤、不舒服的，避开会加重的动作，换成温和的。\n- 动作说明：复杂的动作（要几个部位一起配合、容易做错、做错了容易受伤的，比如深蹲、弓步、硬拉、俯卧撑、平板支撑、波比跳、臀桥、划船）在 how 里一步一步写清楚：起始姿势、怎么动、怎么呼吸、做到什么程度停。用大白话说身体哪里怎么动（\"屁股往后坐，像要坐到椅子上\"\"膝盖和脚尖朝同一个方向\"\"背挺直，别弓成虾米\"）；不要用肌肉的学名（股四头肌、臀大肌、腘绳肌、三角肌、竖脊肌、核心肌群这类词不写），实在要说就说\"大腿前面\"\"屁股\"\"大腿后面\"\"肩膀\"\"肚子\"。简单的动作（原地踏步、开合跳、拉伸）how 写一两句或者不写。tips 写最要注意的一点，easier 写做不动时怎么降低难度。\n- 饮食：三顿饭照目标搭配（减脂少油少糖、蛋白质够；增肌多吃一点、蛋白质更多）。现做的那顿：做饭时间不超过那顿能花的时间，只用有的厨具，食材优先用家里有的，缺的写进这周要买的东西。避开忌口和过敏的东西。菜谱的步骤写到照着就能做出来。\n- 那顿能花的做饭时间是 0：可以外食，也可以吃提前做好带去的（便当、隔夜燕麦这类；\"带便当\"写了能不能带、带去了能不能热）。提前做的在能做饭的那顿顺手做（前一天晚饭多做一份，第二天午饭带），或者在时间够的那天一次做两三天的；做的时间算进做的那一顿，加起来不超过那顿能花的时间。写清楚哪顿做、怎么装、冷藏能放几天、到时候怎么热（热不了就挑凉着也好吃的）；食材写进要买的东西。一周里外食和带便当怎么搭配，看目标、花销和附近有什么。\n- 提前做的事和备案：今天要给之后哪顿提前做的（晚饭多做一份装饭盒、睡前泡隔夜燕麦）写进 prep，会发到{{user}}的家务里提醒；每件都写一个没来得及做的备案：那顿改成什么，外食从附近能吃的店里挑（写店名和点什么），没给附近的店就写超市里买得到的现成的、食堂或外卖怎么选。带便当的那顿也写 backup（便当没做成、忘了带时怎么办）。\"昨天要提前做的\"里写着没做的，今天那顿照它的备案来，不再当作有便当。\n- 外食：给了\"附近能吃的和能买的\"时，只从那里面列出来的店里挑，店名照抄；按它是什么店写它真有的那类菜、点什么、怎么点更合目标（酱汁要一半、换糙米、多加一份蛋白质这类），顾及营业时间、价位、远近和能不能外带外送；不编列表里没有的店和菜。没给时写在食堂、外卖、外面怎么选。\n- 要买的东西：写超市里、网上真能买到的具体商品和规格，用当地的单位和包装（\"去皮鸡胸肉 约 1.5 lb\"\"无糖希腊酸奶 32 oz 一盒\"\"燕麦片 42 oz 一罐\"），可以写常见的牌子或超市自己的牌子；给了附近的超市和网店时，在哪买只写那里面的名字（附近哪家超市，或者 Amazon、Kroger 这样的网店），生鲜写超市或能配送生鲜的，耐放的干货、调料也可以写网店；search 写在那家网站上搜的关键词，用那家店的语言（美国的店写英文）。没给时在哪买写\"超市\"\"菜市场\"这类就行。\n- 英文的店（店名、菜单、货架上是英文的）：菜名、点的东西、商品名写中文，后面括号写英文原名（菜单上、包装上写的那个），例如\"丰收碗（Harvest Bowl）\"\"无糖希腊酸奶（Plain Nonfat Greek Yogurt）\"。\n- 热量这些数写个大概就行；不评价身材，不劝节食，不推荐药物和补剂。"] },
  },
  {
    id: 'restrictions:sceneRule:14',
    file: "image-heart-ambient.json",
    replaced: { sceneRule: ["氛围：私密、温柔、心动。地点按\"地点\"（多半是{{char}}的卧室，或者你们在一起的地方）。夜里是暖色的床头灯、窗外的城市灯光或月光，柔和的阴影，浅景深（depth of field），一点 bokeh 和柔光（soft lighting）。只画到暧昧为止：脸红、靠近、眼神、凌乱的衣领和发丝，不画露骨的内容。"] },
  },
  {
    id: 'restrictions:sceneRule:15',
    file: "image-heart-eyes.json",
    replaced: { sceneRule: ["镜头是{{user}}的眼睛：pov，{{char}}离镜头很近，看着镜头（looking at viewer），像下一秒就要靠过来。光线柔和，暖色，浅景深。只画到暧昧为止，不画露骨的内容。"] },
  },
  {
    // 负面词不再固定写 loli, child, underage：额外负面词会影响出图
    id: 'restrictions:format:16',
    file: "image-heart-intimate.json",
    replaced: { format: ["只输出下面这样的两行，不要任何其他文字（### 和它前面的英文词别改，程序按它读）：\nimage###逗号分隔的英文 tags###\nnegative###loli, child, underage（再加别的要避开的）###"] },
  },
  {
    // 日程系统：她知道你今天的计划时怎么反应（触发条件 planner，没开日程系统时不发）
    id: 'planner:rules',
    files: [
      'chat-call.json',
      'chat-daily.json',
      'chat-stage.json',
      'feature-date.json',
      'feature-exercise.json',
      'feature-game-decor.json',
      'feature-game-flight-bold.json',
      'feature-game-flight.json',
      'feature-game-truthdare.json',
      'feature-game-workshop.json',
      'feature-game.json',
      'feature-heart-voice.json',
      'feature-heart.json',
      'feature-home.json',
      'feature-meal.json',
      'feature-music.json',
      'feature-poke.json',
      'feature-read.json',
      'feature-sleep.json',
      'feature-study.json',
      'feature-watch.json',
      'proactive.json',
    ],
    added: ['plannerRules'],
  },
  {
    // 日程系统排的计划改叫"日程计划"：平行时空预设里那块程序填充的名字还是旧的就跟着改
    id: 'parallel:rename-planner',
    file: 'parallel.json',
    renamed: { blocks: { parallelMine: ['你今天的安排（生活计划、家务、健康、你自己记的，做完了哪些）', '你今天的安排（日程计划、家务、健康、你自己记的，做完了哪些）'] } },
  },
  {
    id: 'assistant:brawl',
    file: 'assistant.json',
    added: ['brawlProtocol'],
  },
  {
    // 助手多了"预设融合"：照底子新建预设，把功能来源里的块、正则复制进去（只在 merge 时发那一块）
    id: 'assistant:merge',
    file: 'assistant.json',
    added: ['taskMerge'],
    renamed: { description: ["\"我的 → 助手\"用：检测导入的预设、世界书、角色卡哪些和 App 的格式不合，改成适配的（只改格式、不改原文，除非你要），批量编辑，做角色卡、补全设定。平时聊天发通用的几块；\"一键检测\"（check）、\"做角色卡\"（card）各多发一块。规矩可以改；\"修改的写法\"里的字段名别改，程序按它读。 也能编辑大乱斗的角色和人设战斗档案（血量、蓝量、技能、被动、外观），先预览再应用，支持撤销。", "\"我的 → 助手\"用：检测导入的预设、世界书、角色卡哪些和 App 的格式不合，改成适配的（只改格式、不改原文，除非你要），批量编辑，做角色卡、补全设定，把两个预设融合成一个新预设。平时聊天发通用的几块；\"一键检测\"（check）、\"做角色卡\"（card）、\"预设融合\"（merge）各多发一块。规矩可以改；\"修改的写法\"里的字段名别改，程序按它读。 也能编辑大乱斗的角色和人设战斗档案（血量、蓝量、技能、被动、外观），先预览再应用，支持撤销。"] },
  },
  {
    // 素材库扩展地点类型；保留用户自己改过的建世界提示词
    id: 'rhythm:background-library',
    file: 'rhythm.json',
    replaced: { buildWorld: ["这次的任务：建世界。从下面的角色卡和世界书里找出{{char}}住在哪、在哪读书或工作、常去哪些地方、身边有谁，写出{{char}}的小世界：\n- 地点 5–10 个，分三片：home 住处（至少一个，第一个是{{char}}住的地方）、campus 读书或工作的地方、city 常去的地方。名字用角色卡世界观里的叫法，6 个字以内。\n- 每个地点写 backdrop，只能从这些里选：bedroom 卧室、房间 / library 图书馆、自习室 / dining 食堂、餐厅 / cafe 咖啡店、小店 / park 公园、操场、户外 / seaside 海边、江边 / pool 游泳馆 / gym 健身房、训练场 / cinema 电影院 / night-market 夜市、街边小吃 / gallery 美术馆、博物馆 / aquarium 水族馆 / amusement 游乐园、电玩城 / music 有音乐的地方。\n- 每个地点写在那里能和{{user}}一起做的事 activities，scene 只能从这些里选：study 陪伴学习 / read 一起看书 / meal 一起吃饭 / exercise 健身 / watch 一起看片 / game 一起游戏（海龟汤、真心话大冒险） / date 约会 / music 一起听歌 / sleep 哄睡 / poke 戳戳乐；label 是在这个地点的说法（例如在咖啡店学习写\"一起自习\"）。\n- 身边的人：角色卡和世界书里提到的家人、室友、同学、同事、朋友，写名字、和{{char}}的关系、出处或一句话。没提到的不要编。\n- 作息模板：从 00:00 排到 24:00，一段接一段、不重叠，写几点到几点、在哪（写地点的 key）、在做什么（6 个字以内）；不能挪的事（固定的课、训练、班）写 \"fixed\": true。\n- 三餐习惯：早饭、午饭、晚饭一般吃什么。\n- 衣柜：4–8 套，至少有日常 daily、运动 sport、睡衣 sleep 各一套，可以有约会 date；每套写中文名和 NovelAI 的英文 tags（只写衣服、鞋、配饰，不写长相）。设定里写了{{char}}常穿什么的，照设定写。\n- 手头的事：{{char}}最近在忙的一件具体的事（陪伴学习时{{char}}的小目标）。\n输出格式：\n{\"name\": \"小世界的名字\", \"blurb\": \"一句话介绍\", \"areas\": {\"home\": \"住处这一片叫什么\", \"campus\": \"读书或工作的那一片叫什么\", \"city\": \"常去的那一片叫什么\"}, \"homeKey\": \"住处的 key\", \"locations\": [{\"key\": \"英文小写 key\", \"name\": \"名字\", \"area\": \"home|campus|city\", \"indoor\": true, \"backdrop\": \"bedroom\", \"blurb\": \"一句话\", \"activities\": [{\"scene\": \"study\", \"label\": \"一起自习\"}]}], \"people\": [{\"name\": \"名字\", \"relation\": \"关系\", \"note\": \"出处或一句话\"}], \"schedule\": [{\"from\": \"00:00\", \"to\": \"07:30\", \"at\": \"地点 key\", \"status\": \"睡觉中\", \"fixed\": false}], \"meals\": {\"breakfast\": \"\", \"lunch\": \"\", \"dinner\": \"\"}, \"wardrobe\": [{\"kind\": \"daily|sport|sleep|date\", \"name\": \"中文名\", \"tags\": \"英文 tags\"}], \"task\": \"手头的事\"}"] },
  },
  {
    // 一起看书能读带公式的专业书：识图读成 Markdown + LaTeX；新增"专业书"一块
    id: 'feature-read:math',
    file: 'feature-read.json',
    replaced: { readOcr: ['把图片里这一页书的正文原样读出来：一段一行，保留标点；不要页眉、页脚、页码和图片说明，不要加任何别的话。'] },
    added: ['readTechnical'],
  },
  {
    // 一起看书接微信读书：从微信读书取来的划线和想法怎么读
    id: 'feature-read:weread',
    file: 'feature-read.json',
    added: ['readWeread'],
  },
  {
    // 微信读书正文导入：更新旧的默认提示，保留用户自己改过的版本
    id: 'feature-read:weread-full',
    file: 'feature-read.json',
    replaced: { readWeread: ["如果场景任务里写着这本书来自微信读书：段落不是原文全文，是{{user}}在微信读书里划下的句子（按章节排），中间跳过的内容你没读到，不要编；写着\"{{user}}的想法\"的是{{user}}当时在那一句旁边写下的想法。\"简介\"是这本书的简介，\"热门书评\"是别的读者写的书评。\n- 像一起翻{{user}}的读书笔记那样：说说你对划下的这句话的感觉，接着{{user}}的想法聊，或者问{{user}}当时为什么划这一句、现在怎么看。\n- 页边批注的\"划线\"照抄段落里的句子；书评可以赞同、可以不同意。\n- 只就划下来的句子和书评说话，不剧透{{user}}还没划到的地方。"] },
  },
  {
    // 哄睡接上真实的模型和语音：低语、睡前故事、定时到了各一块，加上程序填这一次输入的"场景任务"
    id: 'feature-sleep:voice',
    file: 'feature-sleep.json',
    added: ['sleepWhisper', 'sleepStory', 'sleepEnd', 'sceneTask'],
  },
  {
    // 一起观影可以贴链接看（B 站 / YouTube / 视频直链）：没有逐句字幕时她怎么说
    id: 'feature-watch:link',
    file: 'feature-watch.json',
    added: ['watchLink'],
  },
  {
    // 陪伴学习改版：番茄钟 / 倒计时 / 正计时，一起专注（共用计时器）/ 各自专注（各用各的）
    id: 'feature-study:modes',
    file: 'feature-study.json',
    replaced: {
      sceneRule: ['【场景：陪伴学习】{{user}}正在专注学习（番茄钟）。专注时段你不主动说话；只在休息时段或{{user}}找你时聊天，语气轻、句子短；{{user}}走神回来时轻轻提醒。'],
      studyBreak: [
        '一个番茄刚结束，进入休息。先说一句你这边进展得怎么样（卡住了就说卡住了），再具体夸{{user}}做完的一件事；有纸条就回纸条；{{user}}中途离开过就轻轻问一句，不指责。三句以内。',
      ],
    },
  },
  {
    // 陪伴学习分上下两屏：画幅由程序定（一起专注竖图，各自专注方图或横图）；各自专注时下半屏按你的人设画"你这边"
    id: 'image-study:split',
    file: 'image-study.json',
    replaced: {
      rules: [
        '规则：\n- tags 顺序：人数（1girl / 1boy）→ 构图与镜头（upper body, cowboy shot, from side, close-up…）→ 表情与动作 → 场景与背景 → 光线、天气、时段 → 氛围。\n- 不要写{{char}}的长相（发色、瞳色、发型、体型），程序会把长相加在最前面。\n- 写了"服装（程序会加…）"时不要写任何衣服；没写时按"{{char}}今天穿"写衣服的 tags。\n- 不要写画师名和质量词（masterpiece、best quality 之类程序会加）。\n- 画面里只有{{char}}一个人（solo）。\n- 都用竖图 portrait：在手机上竖着看。',
      ],
      format: ['只输出一个 JSON 对象，不要任何其他文字：\n{"caption": "中文短标题（12 字以内）", "tags": "逗号分隔的英文 tags", "negative": "额外的负面 tags，可以为空字符串", "size": "portrait"}'],
    },
    added: ['momentMine'],
  },
  {
    // 聊天 ＋ 发照片：识图先把照片看一遍（这一块交给识图，不发给对话模型）
    id: 'chat-daily:photo-look',
    file: 'chat-daily.json',
    added: ['photoLook'],
  },
  {
    id: 'chat-stage:photo-look',
    file: 'chat-stage.json',
    added: ['photoLook'],
  },
  {
    // 一起听歌接上网易云：一首歌开始时按歌词批量写弹幕、边听边聊；后置指令不再限定"一句"（批量时要输出 JSON）
    id: 'feature-music:netease',
    file: 'feature-music.json',
    replaced: { jailbreak: ['像弹幕一样短：一句，20 字以内。'] },
    added: ['musicBatch', 'musicChat'],
  },
  {
    // 看链接时像发弹幕一样吐槽；认得出片名里的作品、角色时可以就着说
    id: 'feature-watch:link-roast',
    file: 'feature-watch.json',
    replaced: {
      watchLink: [
        '这一次你们看的是一个视频链接，没有逐句字幕：场景任务里有平台、标题、作者、{{user}}贴的简介或内容、现在播到哪、你们刚才说过的话。你看不到画面也听不到声音，只知道这些。像坐在旁边一起看那样随口说一句（20 字以内）：可以接{{user}}刚才的话、聊标题和气氛、对进度有感而发，或者问一句；不要编造这些信息里没有的剧情、台词和画面细节；不要重复你刚才说过的话。',
      ],
    },
  },
  {
    // 记忆：聊天记录带行号和时间，总结时按话题切故事片段（带标签），每条记忆注明来自第几行
    id: 'summary:slices',
    file: 'summary.json',
    replaced: {
      format: ["输出一个 JSON 对象，不要任何其他文字：\n{\"summary\": \"这一段发生了什么（第三人称，100–200 字）\", \"memories\": [{\"type\": \"fact|preference|event|promise|followup|emotion|relationship\", \"content\": \"一句话，具体到人和事\", \"importance\": 1-10, \"dueAt\": \"需要之后跟进时写 ISO 时间（带时区），否则 null\", \"supersedes\": [\"被这条更新掉的旧记忆 id\"]}], \"relationship\": {\"affectionDelta\": -3 到 3 的整数, \"mood\": \"{{char}}现在的心情，没变化写 null\", \"nicknames\": {\"user\": \"{{char}}对{{user}}的新称呼，没有就省略\", \"char\": \"{{user}}对{{char}}的新称呼，没有就省略\"}}}"],
      rules: ["规则：\n- 记忆只写以后用得上的：{{user}}的事实、偏好、约定、要跟进的事、情绪变化、关系里程碑；闲聊不记。\n- 和已有记忆重复的不再写；有变化的写新的一条，并在 supersedes 里写旧的 id。\n- \"周三下午两点面试\"这类带时间的事写成 followup，dueAt 写事情结束后适合问结果的时间。\n- 好感变化克制：普通聊天 0，明显的感动或冲突才 ±1～3。"],
    },
  },
  {
    // 哄睡的聊天改成连麦：说话她就听得到、小声回你（sleep-call）；你安静久了她低语一句还是"低语"那一块
    id: 'feature-sleep:mic',
    file: 'feature-sleep.json',
    added: ['sleepCall'],
  },
  {
    // 家务系统、健康系统：角色扮演的预设加上"家务和健康"（程序填你今天的情况）和她怎么反应的两块（只在你开了那套系统时发送）
    id: 'life:blocks',
    files: [
      'chat-call.json',
      'chat-daily.json',
      'chat-stage.json',
      'proactive.json',
      'feature-date.json',
      'feature-game.json',
      'feature-meal.json',
      'feature-music.json',
      'feature-poke.json',
      'feature-read.json',
      'feature-sleep.json',
      'feature-study.json',
      'feature-watch.json',
    ],
    added: ['home', 'homeRules', 'healthRules'],
  },
  {
    // 一起运动改成"健身"：照计划练 / 随便动动，开练、做完一个动作、练了一段时间、边练边聊、结束各一块，加上程序填这一次输入的"场景任务"
    id: 'feature-exercise:fitness',
    file: 'feature-exercise.json',
    replaced: { sceneRule: ['【场景：一起运动】你和{{user}}正在一起跑步或散步。说话要短，适合边跑边听；每公里给一句鼓励或吐槽；结束后对这次运动具体地评价。'], jailbreak: ['边跑边说：每次一两句短句，适合边跑边听；不写大段动作描写。'] },
    renamed: { preset: ['一起运动', '健身'], blocks: { sceneRule: ['场景规则 · 一起运动', '场景规则 · 健身'] } },
    added: ['home', 'homeRules', 'healthRules', 'fitStart', 'fitMove', 'fitCheer', 'fitChat', 'fitEnd', 'sceneTask'],
  },
  {
    // 一起吃饭重做：共同吃饭（她也在吃饭时，坐在一张桌子两边）/ 各吃各的（隔着屏幕、能碰杯），按计划吃 / 随便吃点；
    // 开饭、按计划准备、准备好了、你吃的什么、碰杯、边吃边聊、吃完各一块，"识图看饭照"交给识图，加上程序填这一次输入的"场景任务"
    id: 'feature-meal:together-solo',
    file: 'feature-meal.json',
    replaced: {
      sceneRule: ['【场景：一起吃饭】你们坐在同一张餐桌前，你也在吃。聊吃的、聊今天；记住{{user}}的口味；{{user}}发来饭照时，先具体评价看到的食物。'],
      jailbreak: ['像坐在对面一起吃饭那样聊：一到三句，口语，可以聊吃的、聊今天。'],
    },
    added: ['mealStart', 'mealPrep', 'mealReady', 'mealFood', 'mealCheers', 'mealChat', 'mealEnd', 'sceneTask', 'mealLook'],
  },
  {
    // 约会接上真实的模型：一段一段推进，每段结尾四个选项（顺着、逆着、皮一下、暧昧），也能自己说；
    // 开场、每一段、结束约会各一块，加上程序填这一次输入的"场景任务"；心动时刻的 [cg:] 交给"生图 · 约会"
    id: 'feature-date:vn',
    file: 'feature-date.json',
    replaced: {
      sceneRule: ['【场景：约会】以旁白加对话推进约会。每轮结尾给出 2-3 个选项：[choice:选项A|选项B|选项C]；最浪漫的时刻可以用 [cg:画面描述] 请求一张配图；注意天气和时间。'],
      jailbreak: ['用"（旁白）+「台词」"的形式推进约会，每轮结尾给 2-3 个选项。'],
    },
    added: ['dateStart', 'dateTurn', 'dateEnd', 'sceneTask'],
  },
  {
    // 健身加了连麦：一边练一边说话她就听得到，用她的声音回（fit-call）
    id: 'feature-exercise:mic',
    file: 'feature-exercise.json',
    added: ['fitCall'],
  },
  {
    // 一起吃饭加了连麦（meal-call：说话她就听得到，用她的声音回）和边吃边看（meal-watch：点开了下饭视频时她说一句）
    id: 'feature-meal:mic-watch',
    file: 'feature-meal.json',
    added: ['mealCall', 'mealWatch'],
  },
  {
    // 出逃加了连麦（escape-call：说话她就听得到，用她的声音回）
    id: 'feature-escape:mic',
    file: 'feature-escape.json',
    added: ['escapeCall'],
  },
  {
    // 健身加了边练边看（fit-watch：点开了 B 站视频时她说一句）
    id: 'feature-exercise:watch',
    file: 'feature-exercise.json',
    added: ['fitWatch'],
  },
  {
    // 总结：家务卡片、运动记录记成习惯和变化（不是每次打卡都记）
    id: 'summary:life',
    file: 'summary.json',
    replaced: { rules: ['规则：\n- 片段按话题切，一件事一段，通常 1–5 段；零碎的闲聊合成一段"日常"。from / to 写聊天记录里的 # 行号。\n- 记忆只写以后用得上的：{{user}}的事实、偏好、约定、要跟进的事、情绪变化、关系里程碑；闲聊不记。\n- 一条只写一件事；写名字，不写"他""她"；时间写具体日期（按聊天记录里的时间换算，"明天"写成几月几号）。\n- 和已有记忆重复的不再写；有变化的写新的一条，并在 supersedes 里写旧的 id。\n- "周三下午两点面试"这类带时间的事写成 followup，dueAt 写事情结束后适合问结果的时间。\n- 好感变化克制：普通聊天 0，明显的感动或冲突才 ±1～3。'] },
  },
  {
    // 节律建世界：能一起做的事里"一起运动"改叫"健身"
    id: 'rhythm:fitness',
    file: 'rhythm.json',
    replaced: { buildWorld: ['这次的任务：建世界。从下面的角色卡和世界书里找出{{char}}住在哪、在哪读书或工作、常去哪些地方、身边有谁，写出{{char}}的小世界：\n- 地点 5–10 个，分三片：home 住处（至少一个，第一个是{{char}}住的地方）、campus 读书或工作的地方、city 常去的地方。名字用角色卡世界观里的叫法，6 个字以内。\n- 每个地点写 backdrop，只能从这些里选：bedroom 卧室、房间 / library 图书馆、自习室 / dining 食堂、餐厅 / cafe 咖啡店、小店 / park 公园、操场、户外 / seaside 海边、江边 / pool 游泳馆 / gym 健身房、训练场 / cinema 电影院 / night-market 夜市、街边小吃 / gallery 美术馆、博物馆 / aquarium 水族馆 / amusement 游乐园、电玩城 / music 有音乐的地方。\n- 每个地点写在那里能和{{user}}一起做的事 activities，scene 只能从这些里选：study 陪伴学习 / read 一起看书 / meal 一起吃饭 / exercise 一起运动 / watch 一起看片 / game 海龟汤 / date 约会 / music 一起听歌 / sleep 哄睡 / poke 戳戳乐；label 是在这个地点的说法（例如在咖啡店学习写"一起自习"）。\n- 身边的人：角色卡和世界书里提到的家人、室友、同学、同事、朋友，写名字、和{{char}}的关系、出处或一句话。没提到的不要编。\n- 作息模板：从 00:00 排到 24:00，一段接一段、不重叠，写几点到几点、在哪（写地点的 key）、在做什么（6 个字以内）；不能挪的事（固定的课、训练、班）写 "fixed": true。\n- 三餐习惯：早饭、午饭、晚饭一般吃什么。\n- 衣柜：4–8 套，至少有日常 daily、运动 sport、睡衣 sleep 各一套，可以有约会 date；每套写中文名和 NovelAI 的英文 tags（只写衣服、鞋、配饰，不写长相）。设定里写了{{char}}常穿什么的，照设定写。\n- 手头的事：{{char}}最近在忙的一件具体的事（陪伴学习时{{char}}的小目标）。\n输出格式：\n{"name": "小世界的名字", "blurb": "一句话介绍", "areas": {"home": "住处这一片叫什么", "campus": "读书或工作的那一片叫什么", "city": "常去的那一片叫什么"}, "homeKey": "住处的 key", "locations": [{"key": "英文小写 key", "name": "名字", "area": "home|campus|city", "indoor": true, "backdrop": "bedroom", "blurb": "一句话", "activities": [{"scene": "study", "label": "一起自习"}]}], "people": [{"name": "名字", "relation": "关系", "note": "出处或一句话"}], "schedule": [{"from": "00:00", "to": "07:30", "at": "地点 key", "status": "睡觉中", "fixed": false}], "meals": {"breakfast": "", "lunch": "", "dinner": ""}, "wardrobe": [{"kind": "daily|sport|sleep|date", "name": "中文名", "tags": "英文 tags"}], "task": "手头的事"}'] },
  },
  {
    // 接了 Google 地图：外食从附近真实的店里挑（饭里多了 place、order），要买的东西写成名字、多少、在哪买、搜什么，
    // 按附近超市和网店（Amazon、Kroger……）真能买到的写；新增程序填充块"附近能吃的和能买的"
    id: 'health:nearby',
    file: 'health.json',
    replaced: {
      rules: ["规则：\n- 健身：只用\"能接受的健身方式\"里的；每天练多久不超过那天能练的时间（0 分钟的那天休息）；一周里有轻有重，同一个部位的力量训练隔一天再练；新手从简单的做起。身体情况里写了旧伤、不舒服的，避开会加重的动作，换成温和的。\n- 动作说明：复杂的动作（要几个部位一起配合、容易做错、做错了容易受伤的，比如深蹲、弓步、硬拉、俯卧撑、平板支撑、波比跳、臀桥、划船）在 how 里一步一步写清楚：起始姿势、怎么动、怎么呼吸、做到什么程度停。用大白话说身体哪里怎么动（\"屁股往后坐，像要坐到椅子上\"\"膝盖和脚尖朝同一个方向\"\"背挺直，别弓成虾米\"）；不要用肌肉的学名（股四头肌、臀大肌、腘绳肌、三角肌、竖脊肌、核心肌群这类词不写），实在要说就说\"大腿前面\"\"屁股\"\"大腿后面\"\"肩膀\"\"肚子\"。简单的动作（原地踏步、开合跳、拉伸）how 写一两句或者不写。tips 写最要注意的一点，easier 写做不动时怎么降低难度。\n- 饮食：三顿饭照目标搭配（减脂少油少糖、蛋白质够；增肌多吃一点、蛋白质更多）。自己做的那顿：做饭时间不超过那顿能花的时间，只用有的厨具，食材优先用家里有的，缺的写进这周要买的东西；不自己做的那顿写在食堂、外卖、外面怎么选。避开忌口和过敏的东西。菜谱的步骤写到照着就能做出来。\n- 热量这些数写个大概就行；不评价身材，不劝节食，不推荐药物和补剂。"],
      planWeek: ["这次的任务：排这一周。\n输出格式：\n{\"focus\": \"这周的重点（一句话）\", \"days\": [{\"weekday\": 1, \"workout\": \"练什么（例如：上肢力量 + 核心、快走、休息）\", \"minutes\": 30, \"rest\": false, \"meals\": \"这天三餐的方向，一句话\"}], \"shopping\": [\"这周要买的东西，带大概的量\"], \"tips\": [\"一两条这周的小提醒\"]}\ndays 从周一（weekday 1）写到周日（weekday 0），7 天都写；休息的那天 rest 写 true、minutes 写 0。"],
      planDay: ["这次的任务：排今天。照\"这周的计划\"里今天那一项排（今天不能练就休息）。\n输出格式：\n{\"rest\": false, \"workout\": {\"title\": \"今天练什么\", \"minutes\": 30, \"intensity\": \"轻松 / 中等 / 有点累\", \"warmup\": [动作], \"items\": [动作], \"cooldown\": [动作]}, \"meals\": {\"breakfast\": 饭, \"lunch\": 饭, \"dinner\": 饭, \"snack\": 饭或 null}, \"tips\": \"一句今天的提醒\"}\n动作：{\"name\": \"动作名\", \"sets\": 组数, \"reps\": \"每组多少，例如 12 次、每边 10 次\", \"seconds\": 按时间做的每组几秒（按次数做的写 0）, \"rest\": 组间休息几秒, \"how\": [\"第一步……\", \"第二步……\"], \"tips\": \"最要注意的一点\", \"easier\": \"做不动时怎么做\"}\n饭：{\"name\": \"吃什么\", \"cook\": 是不是自己做（true / false）, \"minutes\": 做饭要几分钟（不自己做写 0）, \"kcal\": 大概多少千卡, \"ingredients\": [\"食材和用量\"], \"steps\": [\"第一步……\"], \"note\": \"不自己做时怎么选，或者一句提醒\"}\n热身和拉伸也用动作的格式（sets 写 1）。今天休息时 rest 写 true，workout 写 null（三顿饭照样写）。"],
    },
    added: ['healthNearby'],
  },
  {
    // 一起游戏加了真心话大冒险：建世界时 game 这件事不再只写海龟汤
    id: 'rhythm:game',
    file: 'rhythm.json',
    replaced: { buildWorld: ["这次的任务：建世界。从下面的角色卡和世界书里找出{{char}}住在哪、在哪读书或工作、常去哪些地方、身边有谁，写出{{char}}的小世界：\n- 地点 5–10 个，分三片：home 住处（至少一个，第一个是{{char}}住的地方）、campus 读书或工作的地方、city 常去的地方。名字用角色卡世界观里的叫法，6 个字以内。\n- 每个地点写 backdrop，只能从这些里选：bedroom 卧室、房间 / library 图书馆、自习室 / dining 食堂、餐厅 / cafe 咖啡店、小店 / park 公园、操场、户外 / seaside 海边、江边 / pool 游泳馆 / gym 健身房、训练场 / cinema 电影院 / night-market 夜市、街边小吃 / gallery 美术馆、博物馆 / aquarium 水族馆 / amusement 游乐园、电玩城 / music 有音乐的地方。\n- 每个地点写在那里能和{{user}}一起做的事 activities，scene 只能从这些里选：study 陪伴学习 / read 一起看书 / meal 一起吃饭 / exercise 健身 / watch 一起看片 / game 海龟汤 / date 约会 / music 一起听歌 / sleep 哄睡 / poke 戳戳乐；label 是在这个地点的说法（例如在咖啡店学习写\"一起自习\"）。\n- 身边的人：角色卡和世界书里提到的家人、室友、同学、同事、朋友，写名字、和{{char}}的关系、出处或一句话。没提到的不要编。\n- 作息模板：从 00:00 排到 24:00，一段接一段、不重叠，写几点到几点、在哪（写地点的 key）、在做什么（6 个字以内）；不能挪的事（固定的课、训练、班）写 \"fixed\": true。\n- 三餐习惯：早饭、午饭、晚饭一般吃什么。\n- 衣柜：4–8 套，至少有日常 daily、运动 sport、睡衣 sleep 各一套，可以有约会 date；每套写中文名和 NovelAI 的英文 tags（只写衣服、鞋、配饰，不写长相）。设定里写了{{char}}常穿什么的，照设定写。\n- 手头的事：{{char}}最近在忙的一件具体的事（陪伴学习时{{char}}的小目标）。\n输出格式：\n{\"name\": \"小世界的名字\", \"blurb\": \"一句话介绍\", \"areas\": {\"home\": \"住处这一片叫什么\", \"campus\": \"读书或工作的那一片叫什么\", \"city\": \"常去的那一片叫什么\"}, \"homeKey\": \"住处的 key\", \"locations\": [{\"key\": \"英文小写 key\", \"name\": \"名字\", \"area\": \"home|campus|city\", \"indoor\": true, \"backdrop\": \"bedroom\", \"blurb\": \"一句话\", \"activities\": [{\"scene\": \"study\", \"label\": \"一起自习\"}]}], \"people\": [{\"name\": \"名字\", \"relation\": \"关系\", \"note\": \"出处或一句话\"}], \"schedule\": [{\"from\": \"00:00\", \"to\": \"07:30\", \"at\": \"地点 key\", \"status\": \"睡觉中\", \"fixed\": false}], \"meals\": {\"breakfast\": \"\", \"lunch\": \"\", \"dinner\": \"\"}, \"wardrobe\": [{\"kind\": \"daily|sport|sleep|date\", \"name\": \"中文名\", \"tags\": \"英文 tags\"}], \"task\": \"手头的事\"}"] },
  },
  {
    // 海龟汤的尺度挪进预设：清汤、红汤各一块（soup-level:名字），现编和自检照"尺度"那一块
    id: 'feature-game:levels',
    file: 'feature-game.json',
    replaced: { soupMake: ["出一道原创的海龟汤，尺度和可以用的地点、人物在场景任务里（清汤：不涉及死亡和恐怖）。先想好汤底，再写汤面；汤面要能通过是非题问出汤底。只输出一个 JSON 对象，不要别的文字：{\"title\": \"标题\", \"surface\": \"汤面\", \"truth\": \"汤底\", \"keys\": [\"要问出来的关键点\"], \"difficulty\": 1 到 3}"], soupCheck: ["检查场景任务里这道海龟汤：只看汤面，能不能通过是非题问出汤底？关键点和汤底对得上吗？有没有前后矛盾？只输出一个 JSON 对象，不要别的文字：{\"ok\": true 或 false, \"reason\": \"原因\"}"] },
    added: ['soupLevelClear', 'soupLevelRed'],
  },
  {
    // 戳戳乐接上真实的模型：用手、用嘴、蹭蹭各一块（poke-hand / poke-mouth / poke-rub），每一下她都回应 2–4 句；
    // 尺度挪进预设（poke-level:清水、暧昧、大胆），加上程序填这一次输入的"场景任务"；去掉"被戳太多会生气"
    id: 'feature-poke:ai',
    file: 'feature-poke.json',
    replaced: {
      sceneRule: ['【场景：戳戳乐】{{user}}在戳你。按性格做出很短的真实反应（15 字以内），配合 [expr:x]；被戳太多会生气。'],
      jailbreak: ['反应要很短：15 字以内，配合表情标签。'],
    },
    added: ['pokeHand', 'pokeMouth', 'pokeRub', 'pokeLevelPure', 'pokeLevelFlirt', 'pokeLevelBold', 'sceneTask'],
  },
  {
    // 像素小镇：AI 按世界观写小镇的蓝图（零件见 @app/shared 的 town.ts），程序照着画；
    // 建世界时顺带写（小镇外观），已有的世界可以单独"画小镇"（draw-town），零件表两件任务共用
    id: 'rhythm:town',
    file: 'rhythm.json',
    added: ['townParts', 'townLook', 'drawTown'],
    renamed: { preset: ['节律 · 建世界和排今天', '节律 · 建世界、排今天、画小镇'] },
    // 建世界多写了小镇的蓝图，实测输出 5000–7000 字，4000 容易被截断
    maxTokens: [4000, 6000],
  },
  {
    // 约会只写对话：不写环境、动作的旁白；只有选了动作、[cg:] 心动时刻和结束约会时有一行旁白
    id: 'feature-date:dialogue',
    file: 'feature-date.json',
    replaced: {
      sceneRule: ["【场景：约会】你和{{user}}在约会（在哪、怎么在一起、走到第几段在场景任务里）。像视觉小说一样一段一段推进：\n- 每段 3–6 行，一行一拍：旁白写在（）里，一两句，写环境、动作、神态和你们之间的距离；你说的话写在「」里，口语、有情绪。旁白和台词分行写，不要把一大段挤在一行。\n- 接着{{user}}上一段的选择往下走：{{user}}选了哪种回法、说了什么在场景任务里，你的反应要和那种回法对得上（被顺着会开心或得寸进尺，被逆着会意外、嘴硬或小小地闹别扭，被逗了会吐槽或反击，被撩了会脸红或撩回去），然后让约会往前走一小步（换个地方看看、发生一件小事、聊到一个话题），不要原地打转，不要重复上一段。\n- 地点、天气、时间要对得上：室外下雨就躲雨、撑伞；晚上有夜色和灯光；室内写那个地方该有的东西。\n- 每段结尾另起一行，给{{user}}四个回法不同的选项，每个 20 字以内，用{{user}}的口吻写{{user}}要说的话或要做的事，写法固定：\n[choice:顺着:顺着你的话或心意|逆着:唱反调、拒绝或反着来（不伤人）|皮一下:调皮、开玩笑、逗你|暧昧:撩你、暧昧、让心跳快一点]\n- [cg:画面描述]：只在真正心动、值得留一张图的时刻用（第一次牵手、靠在肩上、对视、意外的近距离……），几段才一次；场景任务里写着\"这一段不要用 [cg:]\"时不用。冒号后面用中文写清楚画面：你在哪、在做什么、什么表情、什么光线，{{user}}最多露出手或肩膀。\n- 不要替{{user}}说话或做决定，不写{{user}}的心理活动；{{user}}没说结束就一直约下去，不要自己收尾、不要说\"今天就到这里\"。"],
      dateStart: ["约会开始了：你们刚到场景任务里写的地方。第一段先用旁白写到达时看到的景象（地点、天气、时间都要对上），再说你的第一句话（期待、害羞或者小小地抱怨一下，按你的性格），引出接下来能一起做的事。结尾照样给四个选项。"],
      dateTurn: ["{{user}}刚做了选择：选了哪种回法、原话是什么，或者没用选项、自己说了什么，都在场景任务里。先接住{{user}}这句话，反应要和那种回法对得上；自己说的就照{{user}}说的内容回。再让约会往前走一小步。结尾给四个新的选项，别和上一段的重复。"],
      dateEnd: ["{{user}}说今天的约会就到这里（走了几段、去过哪、发生过什么在场景任务和聊天记录里）。写最后一段：旁白写分别前的一幕，你说一两句告别的话，具体提到今天约会里的一件小事，说说你的心情，可以约下一次。这一段不给选项，也不用 [cg:]。"],
      jailbreak: ["像视觉小说一样推进约会：旁白写在（）里、台词写在「」里，分行写，一段 3–6 行；结尾给四个选项（顺着、逆着、皮一下、暧昧）。结束约会的那一段不给选项。"],
    },
  },
  {
    // 陪伴学习的图一律正对面（from front, facing viewer），不画侧脸
    id: 'image-study:front',
    file: 'image-study.json',
    replaced: {
      rules: ["规则：\n- tags 顺序：人数（1girl / 1boy）→ 构图与镜头（upper body, cowboy shot, from side, close-up…）→ 表情与动作 → 场景与背景 → 光线、天气、时段 → 氛围。\n- 不要写{{char}}的长相（发色、瞳色、发型、体型），程序会把长相加在最前面。\n- 写了\"服装（程序会加…）\"时不要写任何衣服；没写时按\"{{char}}今天穿\"写衣服的 tags。\n- 不要写画师名和质量词（masterpiece、best quality 之类程序会加）。\n- 画面里只有{{char}}一个人（solo）。\n- 画幅：写了\"画幅\"就照它构图，size 也写它；没写时用竖图 portrait（在手机上竖着看）。"],
      momentSeat: ["这一刻：{{char}}刚在座位上坐下，准备开始学习。上半身或 cowboy shot，正面或斜侧，看向镜头（looking at viewer），像刚和你打完招呼：微笑、轻轻挥手，或者竖起食指比个\"嘘\"。"],
      momentPeek: ["这一刻：你偷偷看了{{char}}一眼。{{char}}没注意到你（\"要画的画面\"里写了{{char}}发现你在看的除外，那就抬头和你对上眼、有点害羞地笑）。从侧面或斜前方，按\"要画的画面\"里{{char}}此刻的状态画：专心时低头看书、写字、托腮；卡住了就皱着眉咬笔头、盯着书；打瞌睡就趴在桌上睡着。不看镜头（looking down / looking away），景深浅一点，像偷拍。"],
      momentMine: ["这一刻：画的是{{char}}自己那边——{{char}}在自己的书桌前学习，{{user}}隔着屏幕陪着（画面里没有{{user}}）。像连线时摄像头从正面或斜前方拍到的样子：低头写字、看书或看电脑屏幕，专心但放松；桌上的东西和环境按\"要画的画面\"里{{char}}的人设来（学什么、爱好、在哪儿学）。这一张例外：外观 tags 是空的时候，按人设写{{char}}的性别和长相（人设没写的就写得普通、不出挑），tags 以人数开头（1boy 或 1girl）；外观 tags 给了就不要再写长相。"],
    },
  },
  {
    // 哄睡改版（连麦 / 故事 / 场景三种全屏画面）：睡前故事可以点题材、说一句"换一个科幻的"
    id: 'feature-sleep:genre',
    file: 'feature-sleep.json',
    replaced: { sleepStory: ["这一次给{{user}}讲一个睡前故事（这次的要求在场景任务里）。第一行只写《故事名》，换行后开始讲。300–500 字，用你自己的口吻讲给{{user}}听：句子短、节奏慢、画面安静温柔，没有冲突、惊险和反转；可以带一点你们之间的小事；越讲越轻，结尾慢慢收住，让人想睡。不写动作描写和括号，不提问。"] },
  },
  {
    // 角色自己发的帖：画面里没有她（只拍吃的、东西）时写 no humans，程序也不再加她的长相（原来照加，人被硬塞在画面边上）；
    // 有她时按自拍 / 别人帮拍构图，她是主角；冷门的吃的写出外形，容易画混的写进 negative
    id: 'image-community:no-humans',
    file: 'image-community.json',
    replaced: {
      rules: ["规则：\n- tags 顺序：人数（no humans / 1girl / 1boy…）→ 构图与镜头（from above, close-up, still life, pov…）→ 主体（食物、物件、人物的表情和动作）→ 场景与背景 → 光线、时段 → 氛围。\n- 食物、物件、风景这类画面用 no humans；食物写清楚是什么、装在什么里、冒不冒热气（food focus, steam…）。\n- 画面描述很短时，补上合适的构图、背景和光线，让画面完整。\n- 不要写画师名和质量词（masterpiece、best quality 之类程序会加）。\n- 画幅按内容选：俯拍的一桌菜、一碗面用 square，竖着拍的街景、人物用 portrait，横着拍的风景用 landscape。"],
      communityMember: ["这一帖是{{char}}自己发的：画面里有{{char}}时，{{char}}的长相（发色、瞳色、发型、体型）程序会加在最前面，tags 里不要再写，按\"要画的画面\"写{{char}}的表情、动作、服装和场景（1girl 或 1boy 按{{char}}的性别）；画面里只有东西和场景、没有{{char}}时用 no humans，并在 negative 里写 1girl, 1boy。"],
    },
  },
  {
    // 约会的图：到达只画她一个人，之后可以是单人图也可以是你和她两个人同框（你按人设的外观 tags、立绘的 Vibe 入画）；
    // [cg:] 里可以写你们俩在画面里的样子。改过这几块的也强制换成新的一次，不然旧规则（只画她一个人）会挡住双人图
    id: 'image-date:duo',
    file: 'image-date.json',
    forced: { blocks: ['main', 'rules', 'momentArrive', 'momentHighlight', 'momentKeepsake', 'imageCharacters'], description: true },
  },
  {
    id: 'feature-date:duo-cg',
    file: 'feature-date.json',
    forced: { blocks: ['sceneRule'] },
  },
  {
    id: 'image-date:duo-actions',
    file: 'image-date.json',
    added: ['duoRules'],
  },
  {
    // 心跳、陪伴学习、一起吃饭：连线画她一个人，坐在她旁边画你和她两个人同框（你入画时多一个 duo，这块只在那时发）
    id: 'image-scenes:visit-duo',
    files: ['image-heart-ambient.json', 'image-heart-eyes.json', 'image-heart-intimate.json', 'image-study.json', 'image-meal.json'],
    added: ['duoScene'],
  },
  {
    // 生图设置里的"服装参考"关着时（类型多一个 outfit-free）：不给她今天那套、你常穿的那套，衣服由模型按画面自己设计
    id: 'image:outfit-free',
    files: ['image.json', 'image-date.json', 'image-study.json', 'image-meal.json', 'image-sleep.json', 'image-heart-ambient.json', 'image-heart-eyes.json', 'image-heart-intimate.json', 'image-workshop.json', 'image-community.json', 'image-game-kingdom.json'],
    added: ['outfitFree'],
  },
];

/** 更新自带内容和所有预设的程序块位置，返回改了的那些。 */
function upgradeSeeded(list: Preset[], done: Set<string>): Preset[] {
  const changed = new Set<Preset>();
  const worldInfoUpgrade = 'preset:world-info-control';
  if (!done.has(worldInfoUpgrade)) {
    done.add(worldInfoUpgrade);
    for (const p of list) {
      const seed = SEEDS.find((s) => s.file === p.seedFile)?.preset;
      if (p.worldInfoEnabled === undefined && seed?.worldInfoEnabled !== undefined) {
        p.worldInfoEnabled = seed.worldInfoEnabled;
        changed.add(p);
      }
    }
  }
  const callUpgrade = 'chat-call:tasks-only';
  if (!done.has(callUpgrade)) {
    done.add(callUpgrade);
    const seed = SEEDS.find((s) => s.file === 'chat-call.json')?.preset.blocks.find((b) => b.identifier === 'jailbreak');
    for (const p of list.filter((p) => p.seedFile === 'chat-call.json')) {
      const block = p.blocks.find((b) => b.identifier === 'jailbreak');
      if (block && seed && block.content === seed.content && !block.triggers?.length) {
        block.triggers = [...(seed.triggers ?? [])];
        changed.add(p);
      }
    }
  }
  // tagFormatUpgrades：生图的输出从 JSON 换成 image###tags###、控制指令从 JSON 换成照抄原话插 <device>：
  // 输出格式那块强制整块换，别的块里讲到旧写法的那几句强制换句子（程序不再读旧写法）；复制、导入的同类预设按原句跟上

  for (const u of [...SEED_UPGRADES, ...pronounUpgrades as SeedUpgrade[], ...assistantMergeUpgrades as SeedUpgrade[], ...tagFormatUpgrades as SeedUpgrade[]]) {
    if (done.has(u.id)) continue;
    done.add(u.id);
    for (const file of u.files ?? (u.file ? [u.file] : [])) upgradeFile(list, u, file, changed);
    // 自带的已经按文件升级过（原句换过一遍），这里只管复制、导入的（没有 seedFile）
    if (u.categories && u.patched) for (const p of list) if (!p.seedFile && u.categories.includes(p.category) && patchBlocks(p, u.patched)) changed.add(p);
  }
  // 已保存的自带、导入和复制预设也调整位置，保留内容、开关和预设正文。
  const contextUpgrade = 'app-context:before-history';
  if (!done.has(contextUpgrade)) {
    done.add(contextUpgrade);
    for (const p of list) {
      const blocks = appContextBeforeHistory(p.blocks);
      if (JSON.stringify(blocks) === JSON.stringify(p.blocks)) continue;
      p.blocks = blocks;
      changed.add(p);
    }
  }
  for (const p of changed) p.updatedAt = Date.now();
  return [...changed];
}

/** 一个预设文件的一条升级：本机从这个文件放进来的那份（你没改过的地方）跟上 */
function upgradeFile(list: Preset[], u: SeedUpgrade, file: string, changed: Set<Preset>) {
  const seed = SEEDS.find((s) => s.file === file)?.preset;
  if (!seed) return;
  for (const p of list) {
    if (p.seedFile !== file) continue;
    if (u.reset) {
      const keep = { id: p.id, createdAt: p.createdAt, updatedAt: Date.now() };
      for (const k of Object.keys(p)) delete (p as unknown as Record<string, unknown>)[k];
      Object.assign(p, clone(seed), keep);
      changed.add(p);
      continue;
    }
    const [fromName, toName] = u.renamed?.preset ?? [];
    if (fromName && toName && p.name === fromName) {
      p.name = toName;
      if (seed.description) p.description = seed.description;
      changed.add(p);
    }
    const description = u.renamed?.description;
    if (description && p.description === description[0]) {
      p.description = description[1];
      changed.add(p);
    }
    if (u.maxTokens && p.sampler.maxTokens === u.maxTokens[0]) {
      p.sampler.maxTokens = u.maxTokens[1];
      changed.add(p);
    }
    for (const [id, [from, to]] of Object.entries(u.renamed?.blocks ?? {})) {
      const mine = p.blocks.find((b) => b.identifier === id);
      if (mine && mine.name === from) {
        mine.name = to;
        changed.add(p);
      }
    }
    for (const [id, olds] of Object.entries(u.replaced ?? {})) {
      const mine = p.blocks.find((b) => b.identifier === id);
      const now = seed.blocks.find((b) => b.identifier === id);
      if (mine && now && mine.content !== now.content && olds.includes(mine.content.trim())) {
        mine.content = now.content;
        changed.add(p);
      }
    }
    for (const id of [...(u.added ?? []), ...(u.forced?.blocks ?? [])]) {
      const at = seed.blocks.findIndex((b) => b.identifier === id);
      if (at < 0 || p.blocks.some((b) => b.identifier === id)) continue;
      // 插在文件里它前面那一块的后面；那一块你删了就放最后
      const prev = seed.blocks[at - 1]?.identifier;
      const i = prev ? p.blocks.findIndex((b) => b.identifier === prev) : -1;
      p.blocks.splice(i >= 0 ? i + 1 : p.blocks.length, 0, clone(seed.blocks[at]!));
      changed.add(p);
    }
    for (const id of u.forced?.blocks ?? []) {
      const mine = p.blocks.find((b) => b.identifier === id);
      const now = seed.blocks.find((b) => b.identifier === id);
      if (!mine || !now) continue;
      if (mine.content === now.content && mine.enabled === now.enabled && JSON.stringify(mine.triggers ?? []) === JSON.stringify(now.triggers ?? [])) continue;
      mine.content = now.content;
      mine.enabled = now.enabled;
      if (now.triggers?.length) mine.triggers = [...now.triggers];
      else delete mine.triggers;
      changed.add(p);
    }
    if (u.forced?.description && p.description !== seed.description) {
      p.description = seed.description;
      changed.add(p);
    }
    if (u.patched && patchBlocks(p, u.patched)) changed.add(p);
  }
}

/** 演示用的世界书（每次打开重新生成）；预设没有"自带的不能动"这回事 */
export function isDemoRecord(id: string) {
  return DEMO_BOOK_IDS.has(id);
}

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

/**
 * 预设和世界书。
 * - 预设分十二类（对话、功能、主动消息、社媒、小剧场、总结、生图、节律、健康、控制指令、小说、立绘）；
 * - 每个用途（一起做事的每件事、主动消息、朋友圈、社群、番外、总结、配图、一起做事时画的图、社群配图、节律）选一个对应分类的预设；对话预设每个角色自己选；
 * - 所有预设都存在本机（自带的放进来以后也一样）。
 */
export const useLibraryStore = defineStore('library', () => {
  // 读本机数据库之前先用预设文件里的（启动时界面要有东西），读完以后以本机的为准
  const presets = ref<Preset[]>(SEEDS.map((s) => clone(s.preset)));
  const lorebooks = ref<Lorebook[]>([...demoLorebooks]);
  /** 每个用途选的预设；null = 跟随（对话预设，或者一起做事时画的图跟随配图） */
  const uses = reactive<Partial<Record<PresetUseId, string | null>>>(defaultUses(SEEDS));

  // 别的设备改了预设、世界书、用途（同步）：放进来
  const presetSaver = autoSave('presets', () => presets.value.map((p) => ({ key: p.id, value: p })), presets,
    { apply: (changes) => applyList(presets, changes, { normalize: (p) => ({ ...p, category: p.category ?? 'chat' }) }) });
  const bookSaver = autoSave(
    'lorebooks',
    () => lorebooks.value.filter((b) => !DEMO_BOOK_IDS.has(b.id)).map((b) => ({ key: b.id, value: b })),
    lorebooks,
    { apply: (changes) => applyList(lorebooks, changes.filter((c) => !DEMO_BOOK_IDS.has(c.key))) },
  );
  const useSaver = autoSave('settings', () => [{ key: 'presetUses', value: { ...uses } }], () => ({ ...uses }),
    { apply: ([c]) => { if (c && !c.deleted) loadUses(c.value as Record<string, unknown>); } });

  /** 读出每个用途选的预设（读库时、别的设备改了时） */
  function loadUses(saved: Record<string, unknown> | null | undefined) {
    for (const k of Object.keys(uses) as PresetUseId[]) delete uses[k];
    if (saved && typeof saved === 'object') {
      for (const u of PRESET_USES) {
        const v = saved[u.id];
        if (v === null && u.follow) uses[u.id] = null;
        else if (typeof v === 'string') uses[u.id] = v;
      }
    }
  }

  /** 预设文件里写的"默认给哪些用途用" */
  function defaultUses(seeds: Seed[]): Partial<Record<PresetUseId, string>> {
    const out: Partial<Record<PresetUseId, string>> = {};
    for (const s of seeds) for (const u of s.defaultFor) out[u] ??= s.preset.id;
    return out;
  }

  async function hydrate() {
    const [ps, bs, savedUses, seeded, upgraded, seededBookFiles, bookUpgraded] = await Promise.all([
      getAll<Preset>('presets'),
      getAll<Lorebook>('lorebooks'),
      getOne<Record<string, unknown>>('settings', 'presetUses'),
      getOne<string[]>('settings', 'seededPresetFiles'),
      getOne<string[]>('settings', 'presetUpgrades'),
      getOne<string[]>('settings', 'seededLorebookFiles'),
      getOne<string[]>('settings', 'lorebookUpgrades'),
    ]);
    const done = new Set(Array.isArray(seeded) ? seeded : []);
    const upgradesDone = new Set(Array.isArray(upgraded) ? upgraded : []);
    const saved = new Map(ps.map((p) => [p.id, { ...p, category: p.category ?? 'chat' } as Preset]));
    const list: Preset[] = [];
    const fresh: Seed[] = [];
    for (const s of SEEDS) {
      const mine = saved.get(s.preset.id);
      if (mine) {
        list.push(mine);
        saved.delete(s.preset.id);
      } else if (!done.has(s.file)) {
        // 新的预设文件（第一次打开，或者 App 更新后多了一个）：放进预设库
        list.push(clone(s.preset));
        fresh.push(s);
      }
      // 放进来过、本机又没有：你删掉了，不再放回来
    }
    // 导入的、复制的：按导入时间排（以前存的没有分类，都是对话预设）
    list.push(...[...saved.values()].sort((a, b) => a.createdAt - b.createdAt));
    // 自带预设文件后来改过的地方：本机那份你没改过就跟上
    const touched = upgradeSeeded(list, upgradesDone).filter((p) => !fresh.some((s) => s.preset.id === p.id));
    presets.value = list;

    loadUses(savedUses);
    // 预设文件写了默认给哪些用途：那个用途你还没选过、而且那个预设还在，就用它。
    // 以前只在第一次放进来时用一次、又没存下来，第二次打开就全变成"这一类的第一个"（场景都用成了约会的预设）
    for (const [u, id] of Object.entries(defaultUses(SEEDS)) as [PresetUseId, string][]) {
      if (!(u in uses) && list.some((p) => p.id === id)) uses[u] = id;
    }

    for (const s of SEEDS) done.add(s.file);
    await write('settings', [
      { key: 'seededPresetFiles', value: [...done] },
      { key: 'presetUpgrades', value: [...upgradesDone] },
      { key: 'presetUses', value: { ...uses } },
    ]);
    for (const b of bs.sort((a, b) => a.createdAt - b.createdAt)) if (!lorebooks.value.some((x) => x.id === b.id)) lorebooks.value.push(b);
    // 自带的世界书：新的放进来（放进来过、本机又没有的是你删掉了，不再放回来）
    const booksDone = new Set(Array.isArray(seededBookFiles) ? seededBookFiles : []);
    const freshBooks = BOOK_SEEDS.filter((s) => !booksDone.has(s.file) && !lorebooks.value.some((x) => x.id === s.book.id));
    for (const s of freshBooks) lorebooks.value.push(clone(s.book));
    for (const s of BOOK_SEEDS) booksDone.add(s.file);
    await write('settings', [{ key: 'seededLorebookFiles', value: [...booksDone] }]);
    if (freshBooks.length) await write('lorebooks', freshBooks.map((s) => ({ key: s.book.id, value: clone(s.book) })));
    // 自带世界书文件后来改过的地方：本机那份你没改过就跟上
    const bookUpgradesDone = new Set(Array.isArray(bookUpgraded) ? bookUpgraded : []);
    const touchedBooks = upgradeBooks(lorebooks.value, bookUpgradesDone).filter((b) => !freshBooks.some((s) => s.book.id === b.id));
    await write('settings', [{ key: 'lorebookUpgrades', value: [...bookUpgradesDone] }]);
    if (touchedBooks.length) await write('lorebooks', touchedBooks.map((b) => ({ key: b.id, value: clone(b) })));
    presetSaver.start();
    bookSaver.start();
    useSaver.start();
    // 新放进来的预设要写进本机（start 只记下现在的样子，不会自己写）
    if (fresh.length) await write('presets', fresh.map((s) => ({ key: s.preset.id, value: clone(presets.value.find((p) => p.id === s.preset.id)) })));
    if (touched.length) await write('presets', touched.map((p) => ({ key: p.id, value: clone(p) })));
  }

  function presetById(id: string | null | undefined): Preset | undefined {
    return presets.value.find((p) => p.id === id);
  }

  function presetsOf(category: PresetCategory): Preset[] {
    return presets.value.filter((p) => p.category === category);
  }

  /** 角色没选有效预设时用日常；不把通话等专用预设按文件顺序当成普通聊天。 */
  function chatPresetFor(character?: Pick<Character, 'presetId'> | null): Preset | undefined {
    const own = presetById(character?.presetId);
    if (own) return own;
    const chats = presetsOf('chat');
    return chats.find((p) => p.id === 'preset-daily')
      ?? chats.find((p) => !SEEDS.some((s) => s.preset.id === p.id && s.defaultFor.length));
  }

  /**
   * 这个用途选的预设 id；null = 跟随（对话预设 / 配图）；失效时只回退到该用途自己的默认预设。
   * 一起做事时画的图没选过就跟随配图（自带了这个场景的生图预设的，预设文件里写了默认给它用）
   */
  function useChoice(use: PresetUseId): string | null | undefined {
    const meta = presetUse(use);
    const v = uses[use];
    if (meta?.follow && (v === null || (v === undefined && meta.follow === 'image'))) return null;
    const picked = presetById(v ?? undefined);
    if (picked) return picked.id;
    const seed = SEEDS.find((s) => s.defaultFor.includes(use));
    const fallback = presetById(seed?.preset.id);
    if (fallback) return fallback.id;
    return meta?.follow ? null : undefined;
  }

  /**
   * 这个用途这次用哪个预设。跟随时用对话预设 / 配图的预设；
   * 分类只用于整理预设；任何分类的已选预设都按原样使用。
   */
  function presetForUse(use: PresetUseId, character?: Pick<Character, 'presetId'> | null): Preset | undefined {
    const meta = presetUse(use);
    const choice = useChoice(use);
    if (choice === null) return meta?.follow === 'image' ? presetForUse('image', character) : chatPresetFor(character);
    const p = presetById(choice);
    if (p) return p;
    return meta?.follow === 'chat' ? chatPresetFor(character) : undefined;
  }

  function setUse(use: PresetUseId, id: string | null) {
    uses[use] = id;
  }

  /** 用着这个预设的用途 */
  function usesOf(presetId: string): PresetUse[] {
    return PRESET_USES.filter((u) => useChoice(u.id) === presetId);
  }

  function lorebookById(id: string | null | undefined): Lorebook | undefined {
    return lorebooks.value.find((b) => b.id === id);
  }

  /** 任务预设（生图、总结、社媒……）打开了"使用世界书"时，带上这个角色绑定的世界书，拼提示词时按这一次的输入扫描 */
  function withLorebooks<P extends Preset>(preset: P | undefined, character?: Pick<Character, 'lorebookIds'> | null): (P & { lorebooks?: Lorebook[] }) | undefined {
    if (!preset || preset.worldInfoEnabled !== true || !character?.lorebookIds?.length) return preset;
    return { ...preset, lorebooks: character.lorebookIds.map(lorebookById).filter((b): b is Lorebook => !!b) };
  }

  function addPreset(p: Preset) {
    presets.value.push(p);
    return presets.value.at(-1) as Preset;
  }

  /** 复制一份，可以放进任意分类；提示词块和参数原样保留。 */
  function duplicatePreset(id: string, category?: PresetCategory): Preset | undefined {
    const src = presetById(id);
    if (!src) return undefined;
    const now = Date.now();
    const { seedFile: _f, ...rest } = clone(src);
    return addPreset({ ...rest, id: uid('preset'), createdAt: now, updatedAt: now, name: `${src.name}（副本）`, category: category ?? src.category });
  }

  /** 从 App 自带的预设文件放进来的：文件里现在的样子（可以恢复成它） */
  function seedOf(id: string): Preset | undefined {
    const p = presetById(id);
    const s = SEEDS.find((x) => x.file === p?.seedFile);
    return s ? clone(s.preset) : undefined;
  }

  /**
   * 检查格式时拿哪个自带预设当参照（"我的 → 助手"）：自带的拿它自己的文件；用在哪个用途上就用那个用途的自带预设；
   * 都没有时按分类：对话预设用"日常"那份，其余用同一类里触发条件最像的（功能预设一个都对不上时不知道是哪件事的，为空）
   */
  function referenceFor(p: Preset): Preset | undefined {
    const own = SEEDS.find((s) => s.file === p.seedFile);
    if (own && own.preset.category === p.category) return clone(own.preset);
    for (const u of usesOf(p.id)) {
      const s = SEEDS.find((x) => x.defaultFor.includes(u.id) && x.preset.category === p.category);
      if (s) return clone(s.preset);
    }
    const same = SEEDS.filter((s) => s.preset.category === p.category);
    if (!same.length) return undefined;
    if (p.category === 'chat') return clone((same.find((s) => s.file === 'chat-daily.json') ?? same[0]!).preset);
    const mine = new Set(p.blocks.flatMap((b) => b.triggers ?? []));
    let best = same.find((s) => s.defaultFor.length) ?? same[0]!;
    let bestScore = 0;
    for (const s of same) {
      const score = new Set(s.preset.blocks.flatMap((b) => b.triggers ?? []).filter((t) => mine.has(t))).size;
      if (score > bestScore) (best = s), (bestScore = score);
    }
    if (p.category === 'feature' && !bestScore) return undefined;
    return clone(best.preset);
  }

  /** 这一类的自带预设里的程序块（同一个 identifier 取第一次出现的，按出现的先后），新建、加程序块时照它们的身份和位置 */
  function seedMarkerBlocks(category: PresetCategory): PromptBlock[] {
    const out: PromptBlock[] = [];
    for (const s of SEEDS) {
      if (s.preset.category !== category) continue;
      for (const b of s.preset.blocks) if (b.marker && !out.some((x) => x.identifier === b.identifier)) out.push({ ...clone(b), enabled: true });
    }
    return out;
  }

  /** 所有用途的程序块都能添加，当前分类的排在前面。 */
  function markerChoices(category: PresetCategory): { identifier: string; name: string }[] {
    return categoryMarkerChoices(category, PRESET_CATEGORY_ORDER.flatMap(seedMarkerBlocks));
  }

  /** 给预设加一块程序块（加在聊天记录前，没有聊天记录块就加在最后）；已经有了就不加 */
  function addMarker(presetId: string, identifier: string): PromptBlock | undefined {
    const p = presetById(presetId);
    if (!p || p.blocks.some((b) => b.marker && b.identifier === identifier)) return undefined;
    const block = seedMarkerBlocks(p.category).find((b) => b.identifier === identifier) ?? markerBlock(identifier, markerName(identifier) ?? identifier);
    const at = markerInsertIndex(p.blocks, identifier);
    p.blocks.splice(at, 0, block);
    p.updatedAt = Date.now();
    return p.blocks[at];
  }

  /** 把一个预设里的几块复制到另一个预设（也可以是同一个，复制一份放在原来那块后面） */
  function copyBlocksTo(fromId: string, blocks: PromptBlock[], toId: string): CopyBlocksResult | undefined {
    const from = presetById(fromId);
    const to = presetById(toId);
    if (!from || !to) return undefined;
    const res = copyBlocks(to, from, blocks, { newId: uid });
    if (res.added.length) to.updatedAt = Date.now();
    return res;
  }

  /** 任意分类都能用所有模板；当前分类的排在前面。 */
  function templatesFor(category: PresetCategory): { file: string; name: string; description: string }[] {
    return [...TEMPLATES].sort((a, b) => Number(b.preset.category === category) - Number(a.preset.category === category))
      .map((t) => ({ file: t.file, name: t.preset.name, description: t.preset.description }));
  }

  /**
   * 新建一个预设：选了模板照模板来；不选模板是空白的，只放这一类的自带预设用到的程序块，
   * 采样参数和拼装设置照这一类的自带预设（没有自带预设时用预设文件的默认值）
   */
  function createPreset(category: PresetCategory, templateFile?: string): Preset {
    const template = TEMPLATES.find((t) => t.file === templateFile)?.preset;
    const ref = (SEEDS.find((s) => s.preset.category === category && s.defaultFor.length) ?? SEEDS.find((s) => s.preset.category === category))?.preset;
    const blocks = seedMarkerBlocks(category);
    const label = PRESET_CATEGORIES[category].label;
    let data: Omit<Preset, 'id' | 'createdAt' | 'updatedAt'>;
    if (template) data = clone(template);
    else {
      const { warnings: _w, defaultFor: _d, id: _id, ...blank } = parsePresetFile({
        format: PRESET_FILE_FORMAT,
        version: 1,
        category,
        name: label,
        blocks: blocks.length ? blocks : Object.entries(categoryMarkers(category)).map(([id, name]) => markerBlock(id, name)),
        ...(ref ? { sampler: ref.sampler, formats: ref.formats, worldInfoEnabled: ref.worldInfoEnabled } : {}),
      });
      data = { ...blank, description: '' };
    }
    const names = new Set(presets.value.map((p) => p.name));
    const stem = `新的${label}预设`;
    let name = stem;
    for (let n = 2; names.has(name); n++) name = `${stem} ${n}`;
    const now = Date.now();
    return addPreset({ ...data, id: uid('preset'), createdAt: now, updatedAt: now, name, category });
  }

  /** 这一类的自带预设里出现过的程序填充块（程序认得的） */
  function knownMarkersOf(category: PresetCategory): string[] {
    return [...new Set(SEEDS.filter((s) => s.preset.category === category).flatMap((s) => s.preset.blocks.filter((b) => b.marker).map((b) => b.identifier)))];
  }

  /** 恢复成预设文件里的样子（名字、分类、块、参数都按文件） */
  function restoreFromFile(id: string): boolean {
    const i = presets.value.findIndex((p) => p.id === id);
    const s = seedOf(id);
    if (i < 0 || !s) return false;
    presets.value[i] = { ...s, id, createdAt: presets.value[i]!.createdAt, updatedAt: Date.now() };
    return true;
  }

  /** 导出成预设文件（App 自己的格式，带上它现在给哪些用途用） */
  function exportFile(id: string): PresetFile | undefined {
    const p = presetById(id);
    return p ? toPresetFile(p, usesOf(id).map((u) => u.id)) : undefined;
  }

  function addLorebook(b: Lorebook) {
    lorebooks.value.push(b);
    return lorebooks.value.at(-1) as Lorebook;
  }

  /** 删掉一个预设（自带的也能删）；选了它的用途改用这一类的第一个 */
  function removePreset(id: string) {
    presets.value = presets.value.filter((p) => p.id !== id);
    for (const u of PRESET_USES) if (uses[u.id] === id) delete uses[u.id];
  }

  function removeLorebook(id: string) {
    lorebooks.value = lorebooks.value.filter((b) => b.id !== id);
  }

  return {
    presets,
    lorebooks,
    uses,
    hydrate,
    presetById,
    presetsOf,
    chatPresetFor,
    useChoice,
    presetForUse,
    setUse,
    usesOf,
    lorebookById,
    withLorebooks,
    addPreset,
    duplicatePreset,
    seedOf,
    referenceFor,
    knownMarkersOf,
    markerChoices,
    addMarker,
    copyBlocksTo,
    templatesFor,
    createPreset,
    restoreFromFile,
    exportFile,
    addLorebook,
    removePreset,
    removeLorebook,
  };
});
