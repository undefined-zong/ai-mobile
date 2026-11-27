import { SCENES, type SceneId } from './scenes.ts';
import type { Preset, PresetCategory, PromptBlock } from './types/preset.ts';
import { SOCIAL_TASKS } from './types/social.ts';

/**
 * 用预设的地方：每个调用 AI 的功能独立选择预设，category 只决定设置页分组和推荐排序。
 * - 对话：每个角色自己选（Character.presetId），不在这张表里；
 * - 语音通话（call）：选一个对话预设（默认"通话 · 短句"），或者"跟随对话预设"；
 * - 一起做事的每件事（scene:meal 等）、主动消息：选一个预设，或者"跟随对话预设"（用这个角色的对话预设）；
 * - 小剧场（番外）、总结、配图（image）、节律：选一个预设；
 * - 一起做事时画的图（image:study 等）：选一个生图预设，或者"跟随配图"（用配图选的那个）；
 * - 心跳：打字聊用"心跳"（scene:heart），连麦用"心跳 · 语音"（heart-voice），玩具的控制指令用"控制指令"（device），背景图用 image:heart。
 * - 哄睡：连麦、故事、定时到点的晚安用"哄睡"（scene:sleep），"场景"模式（挑一个睡前的地方、像约会那样沉浸地陪你睡着）用"哄睡 · 场景"（sleep-scene），
 *   连麦时铺满整屏的图用 image:sleep。
 * - 一起游戏：海龟汤用 scene:game，真心话大冒险用"一起游戏 · 真心话大冒险"（game-truthdare），飞行棋用"一起游戏 · 飞行棋"（game-flight，选的预设就是棋盘），
 *   装修小屋用"一起游戏 · 装修小屋"（game-decor）。
 * - 创意工坊：写小说用"小说"预设（novel，调"创作 · 小说"的 API），画画用"一起游戏 · 创意工坊"的生图预设（game-workshop-image，可以跟随配图），
 *   把作品给她看、她捧场或吐槽用"一起游戏 · 创意工坊"（game-workshop）。
 * - 日记：开了"主动写日记"的角色每晚 22:00 写当天的日记用 diary（"日记"分类的预设、调"日记"的 API），配图用"配图"的生图预设。
 * - 社媒：朋友圈（她发朋友圈、回应你的朋友圈和评论）用 social，社群（按关键字建社群、网友发帖和回应、加入社群的角色发帖和回应）用 community，
 *   都是"社媒"分类的预设、调"社媒"的 API；朋友圈的配图用"配图"的生图预设，社群帖子的配图用"社群配图"（community-image，可以跟随配图）。
 * - 立绘：AI 画立绘用"立绘"预设（sprite）：写外观 tags、各个表情和动作的 tags、出图参数都在它里面。
 * - 助手："我的 → 助手"用"助手"预设（assistant），调"助手"的 API。
 * - 平行时空：她给你留言、回你的留言、你请她改日程都用"平行时空"预设（parallel），调"平行时空"的 API；
 *   每天到点把日程计划、家务、健康计划整理成你的一份计划用"平行时空 · 整理你的一天"（parallel-plan，同一类预设、同一个 API）；
 *   "记一件事"里让 AI 把随口说的整理成要做的事、避开冲突排进去用"平行时空 · AI 记一件事"（parallel-capture，同一类预设、同一个 API）。
 */
export type FeatureSceneId = Exclude<SceneId, 'free'>;
export type PresetUseId =
  | 'call'
  | 'secondary'
  | 'proactive'
  | 'social'
  | 'community'
  | 'diary'
  | 'theater'
  | 'summary'
  | 'consolidate'
  | 'image'
  | 'rhythm'
  | 'health'
  | 'planner'
  | 'parallel'
  | 'parallel-plan'
  | 'parallel-capture'
  | 'heart-voice'
  | 'sleep-scene'
  | 'game-truthdare'
  | 'game-flight'
  | 'game-decor'
  | 'game-brawl'
  | 'game-kingdom'
  | 'game-kingdom-image'
  | 'decor-life'
  | 'game-workshop'
  | 'game-workshop-image'
  | 'community-image'
  | 'novel'
  | 'device'
  | 'sprite'
  | 'assistant'
  | `scene:${FeatureSceneId}`
  | `image:${FeatureSceneId}`;

export interface PresetUse {
  id: PresetUseId;
  category: PresetCategory;
  label: string;
  desc: string;
  icon: string;
  /** 可以选"跟随…"：chat 跟随对话预设（一起做事、主动消息）；image 跟随配图（一起做事时画的图）；null 不能跟随 */
  follow: 'chat' | 'image' | null;
}

/**
 * 一起做事时自动画图的时刻（设计文档 §10.3）：生图预设里块的触发条件写时刻名，画哪个时刻就只发那一块。
 * 名字是协议（写进预设文件），中文是界面文字。还没有时刻的场景，画图时跟随配图的"画一个场景"。
 */
export const IMAGE_MOMENTS: Partial<Record<FeatureSceneId, Record<string, string>>> = {
  study: { seat: '入座', peek: '偷拍', reward: '奖励', mine: '你这边' },
  meal: { table: '对面', side: 'Ta那边', cheers: '碰杯' },
  date: { arrive: '到达', highlight: '关键时刻', keepsake: '留念' },
  sleep: { mic: '连麦', now: '这一刻' },
  heart: { open: '开场', now: '这一刻' },
};

/** 时刻的中文名（所有场景一起查） */
export function momentLabel(moment: string): string | undefined {
  for (const m of Object.values(IMAGE_MOMENTS)) if (m?.[moment]) return m[moment];
  return undefined;
}

/**
 * 一起游戏、戳戳乐里的尺度不写在代码里：功能预设里触发条件写了 `前缀名字` 的块就是一个尺度（名字是冒号后面的字）：
 * 真心话大冒险 `td-level:名字`，海龟汤 `soup-level:名字`，戳戳乐 `poke-level:名字`。
 * 开始前按块的顺序列出来让你选；选了哪个，就把那个触发条件当作额外的触发条件，只发那一块。
 * 有几个尺度、叫什么、每个尺度出什么样的题，都在预设里改（预设编辑页里给一块填"…的尺度"）。
 */
export const TRUTH_DARE_LEVEL = 'td-level:';
export const SOUP_LEVEL = 'soup-level:';
export const POKE_LEVEL = 'poke-level:';
export const LEVEL_PREFIXES = [TRUTH_DARE_LEVEL, SOUP_LEVEL, POKE_LEVEL] as const;

/** 这一块是哪个尺度（按前缀）；不是尺度时为空 */
export function blockLevel(block: Pick<PromptBlock, 'triggers'>, prefix: string): string {
  const t = block.triggers?.find((x) => x.startsWith(prefix));
  return t ? t.slice(prefix.length).trim() : '';
}

/** 预设里的尺度：按块的顺序，只算开着的普通块，同名的取前面那块 */
export function presetLevels(preset: Pick<Preset, 'blocks'> | undefined, prefix: string): { name: string; block: PromptBlock }[] {
  const out: { name: string; block: PromptBlock }[] = [];
  for (const block of preset?.blocks ?? []) {
    const name = block.enabled && !block.marker ? blockLevel(block, prefix) : '';
    if (name && !out.some((l) => l.name === name)) out.push({ name, block });
  }
  return out;
}

/** 预设里有没有触发条件以这个前缀开头的块（一个游戏各步的任务名都用同一个前缀） */
function hasTasks(preset: Pick<Preset, 'blocks'> | undefined, prefix: string): boolean {
  return !!preset?.blocks.some((b) => b.triggers?.some((t) => t.startsWith(prefix)));
}

/** 真心话大冒险的预设（td- 开头：出题 td-ask-truth、她选 td-pick……）：换成别的功能预设时出题、选择的格式会不对 */
export const isTruthDarePreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'td-');
/** 海龟汤的预设（soup- 开头：判定 soup-judge、现编 soup-make……） */
export const isSoupPreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'soup-');
/** 飞行棋的棋盘预设（fly- 开头：设计格子 fly-make、她走到的格子 fly-do……） */
export const isFlightPreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'fly-');
/** 装修小屋的预设（decor- 开头：看看屋子 decor-look、动手布置 decor-plan……）：换成别的功能预设时她的布置方案读不出来 */
export const isDecorPreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'decor-');
/** 创意工坊的预设（ws- 开头：看你的小说 ws-novel、看你的画 ws-image……） */
export const isWorkshopPreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'ws-');
/** 大乱斗：角色配招、开场和结算。 */
export const isBrawlPreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'brawl-');
/** 社群的预设（community- 开头：建社群 community-create、网友发帖 community-feed……）：换成朋友圈的预设时建不出社群、发不出帖 */
export const isCommunityPreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'community-');
/** 朋友圈的预设（有"她发一条朋友圈" post、"回应" react 的块）：换成社群的预设时发不出朋友圈 */
export const isMomentsPreset = (p: Pick<Preset, 'blocks'> | undefined) => !!p?.blocks.some((b) => b.triggers?.some((t) => t in SOCIAL_TASKS));
/** 整理你一天的预设（有触发条件 parallel-plan 的块）：选成留言那份时排不出计划 */
export const isParallelPlanPreset = (p: Pick<Preset, 'blocks'> | undefined) => !!p?.blocks.some((b) => b.triggers?.includes('parallel-plan'));
/** AI 记一件事的预设（有触发条件 parallel-capture 的块）：选成别的那份时记不了 */
export const isParallelCapturePreset = (p: Pick<Preset, 'blocks'> | undefined) => !!p?.blocks.some((b) => b.triggers?.includes('parallel-capture'));
/** 戳戳乐的预设（poke- 开头：用手 poke-hand、用嘴 poke-mouth、蹭蹭 poke-rub，尺度 poke-level:名字）；跟随对话预设时没有 */
export const isPokePreset = (p: Pick<Preset, 'blocks'> | undefined) => hasTasks(p, 'poke-');

/** 一起做事的用途里名字、说明和场景名不一样的（一个场景分了好几个用途的） */
const SCENE_USE_TEXT: Partial<Record<FeatureSceneId, { label?: string; desc: string }>> = {
  heart: { desc: '心跳里打字聊天时Ta说的话' },
  game: { label: '一起游戏 · 海龟汤', desc: '一起游戏里玩海龟汤时：主持、判定、当队友、猜你出的题' },
  poke: { desc: '戳戳乐时Ta的反应：用手戳、用嘴亲、蹭一蹭各一块，尺度也在里面' },
  rest: { desc: '休息（午睡、散步、泡澡、静坐）时Ta说的话：开始、换了画面、计时到点、回你说的话各一块' },
};

export const PRESET_USES: PresetUse[] = [
  { id: 'secondary', category: 'feature', label: '副对话', desc: '主回复写完后参考它决定主动卡片、生图和附加任务，生成内容追加在主回复末尾', icon: 'i-lucide-messages-square', follow: null },
  { id: 'call', category: 'chat', label: '语音通话', desc: '打电话时Ta说的话：短句、口语、不写动作，方便边生成边合成语音', icon: 'i-lucide-phone', follow: 'chat' },
  ...SCENES.map((s): PresetUse => {
    const text = SCENE_USE_TEXT[s.id as FeatureSceneId];
    return { id: `scene:${s.id as FeatureSceneId}`, category: 'feature', label: text?.label ?? s.name, desc: text?.desc ?? `${s.name}时的对话`, icon: s.icon, follow: 'chat' };
  }),
  { id: 'heart-voice', category: 'feature', label: '心跳 · 语音', desc: '心跳里连麦时Ta说的话：口语、短句、不写动作，边生成边合成语音', icon: 'i-lucide-audio-lines', follow: null },
  {
    id: 'sleep-scene',
    category: 'feature',
    label: '哄睡 · 场景',
    desc: '哄睡的"场景"模式：挑一个睡前的地方（列车、温泉、飞机、林间小屋……），Ta像约会那样一段一段沉浸地陪你睡着',
    icon: 'i-lucide-tent-tree',
    follow: null,
  },
  {
    id: 'game-truthdare',
    category: 'feature',
    label: '一起游戏 · 真心话大冒险',
    desc: '一起游戏里玩真心话大冒险时：Ta给你出题、选真心话还是大冒险、回答和做挑战、帮你想题',
    icon: 'i-lucide-bottle-wine',
    follow: null,
  },
  {
    id: 'game-flight',
    category: 'feature',
    label: '一起游戏 · 飞行棋',
    desc: '一起游戏里下双人飞行棋时用的棋盘：照它设计 128 格的任务，Ta走到的格子怎么做、你做完时Ta的反应',
    icon: 'i-lucide-dice-5',
    follow: null,
  },
  {
    id: 'game-brawl',
    category: 'feature',
    label: '一起游戏 · 大乱斗',
    desc: '根据角色卡和人设生成血量、蓝量、技能、被动与战斗风格；开场和结算时的回应',
    icon: 'i-lucide-swords',
    follow: null,
  },
  {
    id: 'game-kingdom',
    category: 'feature',
    label: '一起游戏 · 王国模拟',
    desc: '生成符合朝代的大臣、后宫和他国人物，书写季度纪事与六十岁功业评语；数值按实际对局',
    icon: 'i-lucide-crown',
    follow: null,
  },
  {
    id: 'game-decor',
    category: 'feature',
    label: '一起游戏 · 装修小屋',
    desc: '一起游戏里装修小屋时：Ta看看屋子说想法、自己动手布置、给自己（或者给你）捏小人、边装边聊、收工时的话',
    icon: 'i-lucide-sofa',
    follow: null,
  },
  {
    id: 'decor-life',
    category: 'feature',
    label: '小屋 · 角色生活',
    desc: '小人观察房间和双方状态，决定使用哪件家具、如何回应你；使用「小屋 · 角色生活」API',
    icon: 'i-lucide-house-heart',
    follow: null,
  },
  {
    id: 'game-workshop',
    category: 'feature',
    label: '一起游戏 · 创意工坊',
    desc: '一起游戏里把你写的小说、画的画给Ta看：Ta读完捧场、吐槽、追问后续，或者陪你聊聊创作',
    icon: 'i-lucide-palette',
    follow: null,
  },
  { id: 'proactive', category: 'proactive', label: '主动消息', desc: '到点时角色先发来的那条', icon: 'i-lucide-bell-ring', follow: 'chat' },
  { id: 'social', category: 'social', label: '朋友圈', desc: 'Ta发朋友圈（云端每天随机时间发，或者在朋友圈页里让Ta现在发）、给你的朋友圈点赞评论、回你的评论', icon: 'i-lucide-aperture', follow: null },
  {
    id: 'community',
    category: 'social',
    label: '社群',
    desc: '搜不到社群时按关键字建一个；你加入的社群里网友每天发帖（云端随机时间发）、给你的帖子点赞顶帖回复；你邀请进社群的角色发帖、回应你',
    icon: 'i-lucide-users-round',
    follow: null,
  },
  {
    id: 'diary',
    category: 'diary',
    label: '日记',
    desc: '开了"主动写日记"的角色每晚 22:00 按今天的节律写一篇当天的日记（云端写，App 关着也写），回忆 → 日记里也能让Ta现在写；要配的图交给"配图"画',
    icon: 'i-lucide-notebook-tabs',
    follow: null,
  },
  { id: 'theater', category: 'theater', label: '番外', desc: '"我的 → 试一试 → 写一段番外"', icon: 'i-lucide-book-heart', follow: null },
  { id: 'summary', category: 'summary', label: '总结聊天', desc: '每攒够几条（"我的 → 消息设置"里改）自动写梗概、故事片段和记忆，聊天 ⋯ 里也能手动整理', icon: 'i-lucide-notebook-pen', follow: null },
  { id: 'consolidate', category: 'summary', label: '记忆整理', desc: '每天凌晨 4 点在云端合并重复的记忆、合并时间线、过期的事改时态、修改画像卡；记忆本里也能"立即整理"', icon: 'i-lucide-sparkles', follow: null },
  { id: 'novel', category: 'novel', label: '创意工坊 · 小说', desc: '创意工坊里写小说：和你商量设定、大纲、人物，写下一章、写番外（调"创作 · 小说"的 API）', icon: 'i-lucide-feather', follow: null },
  { id: 'image', category: 'image', label: '配图', desc: '聊天 ＋ → 生成配图、聊天里的 [cg:]、番外的那一幕：先写成 NovelAI tags 再调生图 API', icon: 'i-lucide-image', follow: null },
  ...SCENES.map((s): PresetUse => {
    const moments = IMAGE_MOMENTS[s.id as FeatureSceneId];
    return {
      id: `image:${s.id as FeatureSceneId}`,
      category: 'image',
      label: s.name,
      desc: moments ? `${s.name}时自动画的图：${Object.values(moments).join('、')}` : `${s.name}时画的图`,
      icon: s.icon,
      follow: 'image',
    };
  }),
  {
    id: 'game-workshop-image',
    category: 'image',
    label: '创意工坊 · 画画',
    desc: '创意工坊里你想画的东西（可以画Ta、画你小说里的一幕、画什么都行）：先写成 NovelAI tags 再调生图 API',
    icon: 'i-lucide-paintbrush',
    follow: 'image',
  },
  {
    id: 'game-kingdom-image',
    category: 'image',
    label: '王国模拟 · 人物立绘',
    desc: '按朝代服饰、人物身份和固定外观生成 NovelAI 立绘 tags',
    icon: 'i-lucide-contact-round',
    follow: 'image',
  },
  {
    id: 'community-image',
    category: 'image',
    label: '社群配图',
    desc: '社群里帖子要配的图（网友随手拍的吃的、东西、场景，或者Ta自己发帖时配的图）：先写成 NovelAI tags 再调生图 API',
    icon: 'i-lucide-images',
    follow: 'image',
  },
  { id: 'rhythm', category: 'rhythm', label: '节律', desc: '导入角色后建Ta的世界；每天排Ta的作息、三餐和穿着（"我的 → 节律"）', icon: 'i-lucide-calendar-clock', follow: null },
  { id: 'health', category: 'health', label: '健康计划', desc: '按你人设里的健康设置排这周和今天的健身计划、饮食计划（"我的 → 健康计划"）', icon: 'i-lucide-heart-pulse', follow: null },
  { id: 'planner', category: 'planner', label: '日程计划', desc: '日程系统：每天到点看邮件、日程、家务和健康计划，排你这周和今天的计划（"我的 → 日程计划"）', icon: 'i-lucide-calendar-check', follow: null },
  {
    id: 'parallel',
    category: 'parallel',
    label: '平行时空',
    desc: '平行时空里Ta给你留言（云端每天在随机的时间留）、回你的留言、你请Ta改今天的日程时决定答不答应（地图上Ta的世界"一起做点什么"里，紧挨着心跳）',
    icon: 'i-lucide-orbit',
    follow: null,
  },
  {
    id: 'parallel-plan',
    category: 'parallel',
    label: '平行时空 · 整理你的一天',
    desc: '每天到点（平行时空设置里改，默认在日程计划之后）把日程计划、家务、健康计划整理成平行时空里你的一份计划，重复的合成一项',
    icon: 'i-lucide-list-checks',
    follow: null,
  },
  {
    id: 'parallel-capture',
    category: 'parallel',
    label: '平行时空 · AI 记一件事',
    desc: '平行时空"记一件事"里的 AI 记：你随口说一句（"明天下午找时间去趟超市"），整理成要做的事，避开这几天已有的安排（和 Google 日历里的）排进去，必要时挪一挪能挪的',
    icon: 'i-lucide-sparkles',
    follow: null,
  },
  { id: 'device', category: 'device', label: '控制指令', desc: '心跳里按Ta说的话给连着的玩具写指令（震动、摆动、伸缩……），读到、念到那里时执行', icon: 'i-lucide-activity', follow: null },
  {
    id: 'sprite',
    category: 'sprite',
    label: '立绘',
    desc: '"角色 → 立绘 → AI 画立绘"：缺外观 tags 时写 tags，画透明底的底图，再照着底图画别的表情、动作（写 tags 调"生图提示词"的 API，出图调"生图"的 API）',
    icon: 'i-lucide-person-standing',
    follow: null,
  },
  {
    id: 'assistant',
    category: 'assistant',
    label: '助手',
    desc: '"我的 → 助手"：检测导入的预设、世界书、角色卡哪些不适配并改格式，批量编辑，做角色卡、补全设定（调"助手"的 API）',
    icon: 'i-lucide-bot',
    follow: null,
  },
];

export function presetUse(id: PresetUseId): PresetUse | undefined {
  return PRESET_USES.find((u) => u.id === id);
}

/** 在这个场景里对话用哪个用途（自由聊天没有，用对话预设） */
export function sceneUse(sceneId: string | null | undefined): PresetUseId | null {
  return sceneId && SCENES.some((s) => s.id === sceneId) ? (`scene:${sceneId}` as PresetUseId) : null;
}

/** 在这个场景里画图用哪个用途（自由聊天没有，用配图） */
export function sceneImageUse(sceneId: string | null | undefined): PresetUseId {
  return sceneId && SCENES.some((s) => s.id === sceneId) ? (`image:${sceneId}` as PresetUseId) : 'image';
}
