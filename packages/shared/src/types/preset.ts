import type { SyncMeta } from './common.ts';

/**
 * 预设里的一块提示词，对应 ST Chat Completion 预设的 prompts[] + prompt_order。
 * marker 块不写内容，由程序填充：角色描述、世界书、聊天历史、记忆、当前环境、场景规则等。
 */
export interface PromptBlock {
  identifier: string;
  name: string;
  role: 'system' | 'user' | 'assistant';
  content: string;
  marker: boolean;
  enabled: boolean;
  /**
   * relative：按列表顺序；absolute：插到聊天历史倒数第 depth 条之前（ST 的 in-chat）。
   * order 是同一深度里的先后（ST 的 injection_order，数字大的更靠后，默认 100）
   */
  injection: { position: 'relative' | 'absolute'; depth: number; order?: number };
  /** 不让角色卡的 system_prompt / post_history_instructions 覆盖这一块（ST 的 forbid_overrides） */
  forbidOverrides?: boolean;
  /** 只在这些生成类型里发送；为空表示都发送（ST 的 injection_trigger） */
  triggers?: string[];
  /** 这一块是 App 自己补的（记忆、环境、场景规则……），不是来自导入的预设 */
  origin?: 'app';
  /** ST 里其余没有对应字段的设置（system_prompt 等），导出时原样写回 */
  extra?: Record<string, unknown>;
}

export interface SamplerParams {
  temperature: number;
  topP: number;
  topK?: number;
  maxTokens: number;
  /** 上下文 token 预算（聊天历史按它截断） */
  contextTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  stream: boolean;
  /** 随机种子，小于 0 表示不传 */
  seed?: number;
}

/** ST 预设里控制拼装细节的文字和开关 */
export interface PresetFormats {
  /** 聊天记录开头插的一条系统消息（ST 的 new_chat_prompt，例如"[Start a new Chat]"） */
  newChatPrompt: string;
  /** 每段示例对话前的系统消息（new_example_chat_prompt） */
  newExampleChatPrompt: string;
  /** 继续生成时的提示（continue_nudge_prompt） */
  continueNudgePrompt: string;
  /** 代你说话时的提示（impersonation_prompt） */
  impersonationPrompt: string;
  /** 最后一条是她的消息时补一条你的消息（send_if_empty） */
  sendIfEmpty: string;
  /** 世界书包装格式，{0} 是内容（wi_format） */
  wiFormat: string;
  /** 场景的包装格式（scenario_format），可用 {{scenario}} */
  scenarioFormat: string;
  /** 性格的包装格式（personality_format），可用 {{personality}} */
  personalityFormat: string;
  /** 消息里带不带名字：-1 不带 / 0 默认（单人聊天不带）/ 1 写进 name 字段 / 2 写进正文"名字: " */
  namesBehavior: -1 | 0 | 1 | 2;
  /** 把相邻的系统消息合成一条 */
  squashSystemMessages: boolean;
  /** 角色卡的 system_prompt 覆盖主提示 */
  preferCharacterPrompt: boolean;
  /** 角色卡的 post_history_instructions 覆盖后置指令 */
  preferCharacterJailbreak: boolean;
}

export const DEFAULT_PRESET_FORMATS: PresetFormats = {
  newChatPrompt: '',
  newExampleChatPrompt: '',
  continueNudgePrompt: '',
  impersonationPrompt: '',
  sendIfEmpty: '',
  wiFormat: '{0}',
  scenarioFormat: '{{scenario}}',
  personalityFormat: '{{personality}}',
  namesBehavior: 0,
  squashSystemMessages: false,
  preferCharacterPrompt: true,
  preferCharacterJailbreak: true,
};

/**
 * 正则脚本作用在哪：你发的消息 / 她的回复（SillyTavern 的 placement 1 / 2）。
 * 斜杠命令、世界书、思考过程（3 / 5 / 6）导入时保留、导出时写回，App 里不执行
 */
export type RegexPlacement = 'user_input' | 'ai_output' | 'slash_command' | 'world_info' | 'reasoning';

/**
 * 预设里的一条正则脚本，字段对应 SillyTavern 的正则脚本（st/regex.ts 按 ST 的规则执行）。
 * 两个"只"都不勾：改存下来的消息（她回复、你发送时）；只改显示（markdownOnly）；只改发给 AI 的（promptOnly）
 */
export interface RegexScript {
  id: string;
  name: string;
  /** 查找：/正则/标志；不带斜杠时整串当正则、没有标志，只换第一处（同 ST） */
  find: string;
  /** 替换成：$1、$<名字> 是捕获组，{{match}} 是整段匹配，{{char}} {{user}} 这些宏会替换 */
  replace: string;
  placement: RegexPlacement[];
  enabled: boolean;
  /** 捕获到的内容里先删掉这些字（ST 的 trimStrings） */
  trimStrings?: string[];
  /** 只改显示：存下来的消息、发给 AI 的都不变（ST 的 markdownOnly） */
  markdownOnly?: boolean;
  /** 只改发给 AI 的：存下来的消息、显示都不变（ST 的 promptOnly） */
  promptOnly?: boolean;
  /** 改消息时也执行（ST 的 runOnEdit）：只对改存下来的消息的脚本有用 */
  runOnEdit?: boolean;
  /** 只改倒数第 minDepth ~ maxDepth 条（0 = 最后一条）；空着不限。显示、发给 AI 时才看 */
  minDepth?: number | null;
  maxDepth?: number | null;
  /** 查找里的宏：0 不替换 / 1 直接替换 / 2 转义后替换（ST 的 substituteRegex） */
  substituteRegex?: 0 | 1 | 2;
  /** 导入时其余没有对应字段的设置，导出时原样写回 */
  extra?: Record<string, unknown>;
}

/**
 * 预设分类：用于整理、默认模板和编辑提示，不限制给哪个场景使用。
 * - chat 对话：主对话（聊天气泡、剧场模式），每个角色选一个；
 * - feature 功能：和她一起做事时的对话（一起吃饭、健身、共同的家……），每件事选一个；
 * - proactive 主动消息：她先开口的那条；
 * - theater 小剧场：番外，你不在时她那边的一小段故事；
 * - summary 总结：整理聊天，写过往摘要、记忆、关系变化；
 * - image 生图：把画面写成 NovelAI tags；
 * - rhythm 节律：建她的世界、排她每天的作息、三餐和穿着；
 * - health 健康：按你人设里的健康设置排这周和今天的健身计划、饮食计划；
 * - planner 计划：日程系统里按邮件、日程、家务和健康排你这周和今天的计划；
 * - parallel 平行时空：她看着你们俩今天的安排给你留言、回你的留言，你请她改日程时决定答不答应、怎么改；
 * - device 控制指令：心跳里按她说的话给连着的玩具写指令（Intiface Central）；
 * - novel 小说：创意工坊里和你商量设定、写章节和番外；
 * - sprite 立绘：给没有立绘的角色用 NovelAI 画立绘（写外观 tags、各个表情和动作的 tags、出图参数）；
 * - social 社媒：朋友圈（她发朋友圈、回应你的朋友圈和评论）和社群（按关键字建社群、网友发帖和回应、加入社群的角色发帖和回应）；
 * - assistant 助手："我的 → 助手"检测、修改预设和世界书的格式，做角色卡、补全设定。
 * 前三类默认使用角色扮演的程序填充块，和 SillyTavern 的对话预设一样（角色卡、世界书、聊天记录……）；
 * 后几类是一次性的任务，程序填充块是这件任务的输入（要整理的聊天、要画的画面、她的世界……）。
 */
export type PresetCategory = 'chat' | 'feature' | 'proactive' | 'theater' | 'summary' | 'image' | 'rhythm' | 'health' | 'planner' | 'parallel' | 'device' | 'novel' | 'sprite' | 'social' | 'diary' | 'assistant';

export const PRESET_CATEGORIES: Record<PresetCategory, { label: string; desc: string; icon: string }> = {
  chat: { label: '对话', desc: '主对话：聊天气泡和剧场模式。每个角色选一个（角色设定 → 预设）', icon: 'i-lucide-message-circle-heart' },
  feature: { label: '功能', desc: '一起做事时的对话：一起吃饭、健身、陪伴学习、共同的家……每件事选一个', icon: 'i-lucide-utensils' },
  proactive: { label: '主动消息', desc: '角色先开口发来的那条消息', icon: 'i-lucide-bell-ring' },
  theater: { label: '小剧场', desc: '番外：你不在的时候，角色那边发生的一小段故事', icon: 'i-lucide-book-heart' },
  summary: { label: '总结', desc: '整理聊天：写过往摘要、记下以后用得上的事、更新关系', icon: 'i-lucide-notebook-pen' },
  image: { label: '生图', desc: '生图提示词：把要画的画面写成 NovelAI tags。聊天配图一个，一起做事的每件事也各选一个（可以跟随配图）', icon: 'i-lucide-wand-sparkles' },
  rhythm: { label: '节律', desc: 'Ta每天的作息、三餐和穿着：导入角色后"建世界"一次，之后每天"排今天"（每个角色在"我的 → 节律"里选固定还是每天变化）', icon: 'i-lucide-calendar-clock' },
  health: { label: '健康', desc: '你的健身计划和饮食计划：按人设里的身高体重、目标、能练的方式和时间、食材、做饭时间和厨具，排这周和今天的（"我的 → 健康计划"）', icon: 'i-lucide-heart-pulse' },
  planner: {
    label: '计划',
    desc: '你的日程计划（人设的日程系统）：每天到点看一遍新邮件、日程软件里这周的安排、家务和健康计划，排这周和今天的。AI 先决定调哪些 MCP 工具查什么，再写计划；查什么、怎么排、输出格式都在这里改（"我的 → 日程计划"）',
    icon: 'i-lucide-calendar-check',
  },
  parallel: {
    label: '平行时空',
    desc: '平行时空里Ta和你的今天一左一右排在一起：Ta看着两边的安排给你留言（云端每天在随机的时间留）、回你的留言；你请Ta改今天的日程时，Ta按自己的性格和安排决定答不答应、怎么改。留言写什么、多久留一次之外的规矩、改日程的分寸都在这里改',
    icon: 'i-lucide-orbit',
  },
  device: {
    label: '控制指令',
    desc: '心跳里玩具的控制指令：按Ta刚说的话、连着的玩具能做什么、你设的强度上限，写什么时候震动多强、怎么变速、伸缩多快（通过 Intiface Central 执行）',
    icon: 'i-lucide-activity',
  },
  novel: {
    label: '小说',
    desc: '一起游戏 · 创意工坊里写小说：和你商量设定、大纲和人物，写下一章、写番外（用"创作 · 小说"的 API）',
    icon: 'i-lucide-feather',
  },
  sprite: {
    label: '立绘',
    desc: '用 NovelAI 给没有立绘的角色画立绘：缺外观 tags 时先写 tags，画一张透明底的底图（平静），再照着它画别的表情和动作。有几个表情、每个表情的 tags、出图参数都在这里改（"角色 → 立绘 → AI 画立绘"）',
    icon: 'i-lucide-person-standing',
  },
  social: {
    label: '社媒',
    desc: '朋友圈和社群，各选一个预设。朋友圈：Ta按今天的节律和最近的聊天发朋友圈（正文、要配的图、缴费单 / 小票之类的一小页 HTML），给你的朋友圈点赞评论、回你的评论。社群：搜不到时按关键字建一个社群，网友每天发帖、回应你的帖子，加入社群的角色发帖、回应你（都用"社媒"的 API）',
    icon: 'i-lucide-aperture',
  },
  diary: {
    label: '日记',
    desc: 'Ta的日记：开了"主动写日记"的角色每晚 22:00 按今天的节律写一篇当天的日记（云端写，App 关着也写），回忆页里也能让Ta现在写。写的是Ta自己的一天，不全围着你转；可以配一张图（写画面，交给生图画）。写什么、多长、口吻、多久配一次图都在这里改（用"日记"的 API）',
    icon: 'i-lucide-notebook-tabs',
  },
  assistant: {
    label: '助手',
    desc: '"我的 → 助手"用：检测导入的预设、世界书、角色卡哪些和 App 的格式不合、改成适配的（尽量只改格式），批量编辑，做角色卡、补全设定。助手怎么说话、改东西的规矩、修改的写法都在这里改',
    icon: 'i-lucide-bot',
  },
};

export const PRESET_CATEGORY_ORDER: PresetCategory[] = ['chat', 'feature', 'proactive', 'social', 'diary', 'theater', 'summary', 'image', 'rhythm', 'health', 'planner', 'parallel', 'device', 'novel', 'sprite', 'assistant'];

/** 默认提供角色扮演编辑选项的分类（所有分类都可以互相复制）。 */
export const ROLEPLAY_CATEGORIES: PresetCategory[] = ['chat', 'feature', 'proactive'];

export function isRoleplayCategory(c: PresetCategory): boolean {
  return ROLEPLAY_CATEGORIES.includes(c);
}

export interface Preset extends SyncMeta {
  name: string;
  description: string;
  /** 分类；以前存的和从 SillyTavern 导入的都是对话预设 */
  category: PresetCategory;
  /** 是否使用角色绑定的世界书（所有插入位置）；旧预设未设置时沿用开启。角色卡字段和预设正文另行控制。 */
  worldInfoEnabled?: boolean;
  /** 顺序即拼装顺序 */
  blocks: PromptBlock[];
  sampler: SamplerParams;
  formats: PresetFormats;
  regex: RegexScript[];
  /** 从 SillyTavern 导入时：用的是哪套 prompt_order（100001 是 ST 实际生效的那套） */
  source?: { kind: 'sillytavern'; orderId: number | null; fileName?: string };
  /** 从 App 自带的哪个预设文件放进来的（可以"恢复成文件里的样子"） */
  seedFile?: string;
  /** 导入时其余没有对应字段的设置（reasoning_effort、bias、扩展……），导出时原样写回 */
  extra?: Record<string, unknown>;
}

/** 程序会填充的 marker 块（App 自己扩展了记忆、摘要、环境、场景四块） */
export const PROMPT_MARKERS = {
  worldInfoBefore: '世界书（角色前）',
  charDescription: '角色描述',
  charPersonality: '角色性格',
  scenario: '场景',
  worldInfoAfter: '世界书（角色后）',
  personaDescription: '用户人设',
  dialogueExamples: '示例对话',
  memory: '长期记忆 + 关系状态',
  summary: '过往摘要',
  environment: '当前环境',
  sceneRules: '当前场景规则 + 可用标签',
  chatHistory: '聊天历史',
  proactive: '主动消息：这一次要Ta做的事',
  sceneTask: '场景任务：这一次的输入',
  home: '家务和健康：你今天的情况',
} as const;

/** App 自己的程序填充块：ST 预设里没有，导入时补进去 */
export const APP_MARKERS = ['summary', 'memory', 'environment', 'home', 'sceneRules'] as const;

/**
 * 你人设里开着的系统（家务 housework、健康 health）：角色扮演预设里触发条件写了它们的块，只在开着时发送
 * （例如"家务：你怎么反应"那一块，没开家务系统时不发）。
 */
export const LIFE_FLAGS = { housework: '开了家务系统', health: '开了健康系统', planner: '开了日程系统' } as const;
export type LifeFlag = keyof typeof LIFE_FLAGS;

/**
 * 任务类预设（小剧场、总结、生图）的程序填充块：只放这件任务每次的输入（要整理的聊天、要画的画面……）。
 * 说明、规则、输出格式都是预设里的普通块，可以改。
 */
export const TASK_MARKERS: Record<'theater' | 'summary' | 'image' | 'rhythm' | 'health' | 'planner' | 'parallel' | 'device' | 'novel' | 'sprite' | 'social' | 'diary' | 'assistant', Record<string, string>> = {
  theater: {
    storyCharacter: '角色',
    storyWorld: 'Ta的世界（作息、手头的事、身边的人）',
    storyNow: '现在（时间、Ta在哪）',
    storyMemories: 'Ta记得的关于你的事',
    storyRecent: '最近的聊天',
    storyPrevious: '最近写过的番外（避免重复）',
  },
  summary: {
    summaryNow: '现在',
    summaryPrevious: '上一段摘要',
    summaryMemories: '已有记忆',
    summaryTranscript: '要整理的聊天',
  },
  image: {
    imageCharacters: '你可以入画：你的长相和两个人同框时的输出格式（场景里你可以入画、人设里填了外观 tags 时才填）',
    imageSubject: '角色和外观 tags',
    imageScene: '地点、服装、时间天气、表情',
    imageRecent: '最近的对话',
    imageCaption: '要画的画面',
  },
  rhythm: {
    rhythmCharacter: '角色（名字、描述、性格、场景）',
    rhythmSource: '建世界的材料（角色卡的世界观、世界书）',
    rhythmWorld: 'Ta的世界（地点、身边的人）',
    rhythmTemplate: '作息模板（固定的事不能挪）和三餐习惯',
    rhythmWardrobe: '衣柜',
    rhythmToday: '今天（日期、星期、节气、天气）',
    rhythmRecent: '最近几天的作息和穿着',
    rhythmPromises: '最近的约定和待跟进',
    rhythmAsk: '这次要排的',
  },
  health: {
    healthProfile: '你的身体、目标和身体情况',
    healthTime: '能练的方式和时间',
    healthKitchen: '食材、忌口、做饭时间和厨具',
    healthNearby: '附近能吃的和能买的（接了 Google 地图时）',
    healthToday: '今天（日期、星期、天气）',
    healthWeek: '这周的计划（排今天时）',
    healthRecent: '最近练了什么、家务里做了什么饭',
    healthAsk: '这次要排的',
  },
  planner: {
    plannerProfile: '你（人设）和你写的情况',
    plannerToday: '今天（日期、星期、时区、现在几点）',
    plannerLife: '家务和健康（开了这两套系统时）',
    plannerTools: '能用的 MCP 工具（AI 查的时候）',
    plannerGathered: '查到的邮件、日程',
    plannerWeek: '这周的计划（排今天时）',
    plannerRecent: '最近几天的计划和做完了哪些',
    plannerAsk: '这次要做的',
  },
  parallel: {
    parallelCharacter: '角色（名字、描述、性格、场景）',
    parallelNow: '现在（日期、星期、时间）',
    parallelHer: 'Ta今天的节律（作息、现在在做什么、三餐、穿着、手头的事）',
    parallelWorld: 'Ta世界里的地点（改日程时能去的地方）',
    parallelMine: '你今天的安排（日程计划、家务、健康、你自己记的，做完了哪些）',
    parallelSources: '你这一天几份计划里的事（日程计划、家务、健康计划，带编号；整理你的一天时）',
    parallelSchedule: '你这几天的安排（带编号、能不能挪，Google 日历里已有的；AI 记一件事时）',
    parallelInput: '你随口说的（AI 记一件事时）',
    parallelMemories: 'Ta记得的关于你的事',
    parallelRecent: '最近的聊天',
    parallelNotes: '平行时空里最近的留言',
    parallelThread: '这一条留言和下面的回复（回你时）',
    parallelAsk: '这一次要做的',
  },
  device: {
    deviceToys: '连着的玩具和能写的键',
    deviceLimits: '最快的速度',
    deviceNow: '玩具现在在做什么',
    deviceRecent: '最近的对话',
    deviceLine: 'Ta这一句（要配指令的话）',
  },
  novel: {
    novelInfo: '作品（书名、类型、设定、大纲、文风）',
    novelChapters: '已经写好的章节',
    novelChat: '你们最近的讨论',
    novelAsk: '这一次要做的',
  },
  sprite: {
    spriteCharacter: '角色（名字、描述、性格、场景）',
    spriteSource: '角色卡的材料（作者备注、世界书）',
    spriteLooks: '现在的长相（外观 tags、同人 tag、衣服）',
    spriteAsk: '这次要写的',
  },
  social: {
    socialCharacter: '角色（名字、描述、性格、场景）',
    socialLife: 'Ta今天的节律（作息、现在在做什么、三餐、穿着、手头的事）',
    socialNow: '现在（日期、星期、时间）',
    socialMemories: 'Ta记得的关于你的事',
    socialRecent: '最近的聊天',
    socialFeed: '最近的朋友圈（Ta发过的、你发的）',
    socialPost: '这条朋友圈和下面的评论（回应时）',
    socialAsk: '这一次要做的',
    communityInfo: '社群（名字、简介、风气、标签、成员数）',
    communityMembers: '社群里你认识的人（你、你邀请进来的角色）',
    communityFeed: '社群最近的帖子',
    communityPost: '这一帖和下面的回复（回应时）',
  },
  diary: {
    diaryCharacter: '角色（名字、描述、性格、场景）',
    diaryDay: 'Ta今天的节律（作息、三餐、穿着、手头的事、今天的小事）',
    diaryNow: '现在（日期、星期、时间、天气）',
    diaryUser: '今天和你（聊天里说过的、一起做过的事）',
    diaryMemories: 'Ta记得的关于你的事',
    diaryPrevious: '最近几篇日记（不要重复）',
    diaryAsk: '这一次要写的',
  },
  assistant: {
    assistantFormats: '特殊格式（App 认的写法、参照的自带预设，按要看的对象挑）',
    assistantTargets: '要看的对象（预设、世界书、角色卡，JSON）',
    assistantChecks: '程序检测到的问题',
    assistantChat: '最近的对话',
    assistantAsk: '这一次（你刚说的）',
  },
};

/**
 * 健康预设里的任务（块的触发条件写这几个名字）：
 * - plan-week 排这周：每周一次（每天练什么、多久，三餐的方向，要买的东西）；
 * - plan-day 排今天：照这周的计划排今天的动作（复杂的动作写清楚怎么做）和三顿饭（自己做的写菜谱）。
 */
export const HEALTH_TASKS = {
  'plan-week': '排这周',
  'plan-day': '排今天',
} as const;

export type HealthTask = keyof typeof HEALTH_TASKS;

/**
 * 计划预设里的任务（块的触发条件写这几个名字）：
 * - planner-gather 查：看能用的 MCP 工具，决定这一轮调哪些、查什么（最多几轮在日程系统的设置里）；
 * - planner-week 排这周；
 * - planner-day 排今天。
 */
export const PLANNER_TASKS = {
  'planner-gather': '查邮件和日程',
  'planner-week': '排这周',
  'planner-day': '排今天',
} as const;
export type PlannerTask = keyof typeof PLANNER_TASKS;

/**
 * 平行时空预设里的任务（块的触发条件写这几个名字）：
 * - parallel-post 她给你留言：云端每天在随机的时间（或者你让她现在留一条）；
 * - parallel-reply 回你的留言：你留了言、或者在留言下面回了她；
 * - parallel-request 你请她改日程：她决定答不答应，答应了写出改成什么样（只改今天的）；
 * - parallel-plan 整理你的一天：每天到点把日程计划、家务、健康计划整理成平行时空里你的一份计划（"平行时空 · 整理你的一天"预设）；
 * - parallel-capture AI 记一件事：你随口说一句，整理成要做的事，避开这几天已有的安排排进去（"平行时空 · AI 记一件事"预设）。
 */
export const PARALLEL_TASKS = {
  'parallel-post': 'Ta给你留言',
  'parallel-reply': '回你的留言',
  'parallel-request': '你请Ta改日程',
  'parallel-plan': '整理你的一天',
  'parallel-capture': 'AI 记一件事',
} as const;
export type ParallelTask = keyof typeof PARALLEL_TASKS;

/**
 * 节律预设里的任务（块的触发条件写这几个名字）：
 * - build-world 建世界：导入角色后做一次，生成她的地点、身边的人、作息模板、三餐习惯、衣柜；
 * - plan-day 排今天：每天一次；
 * - outfit-pick / outfit-new：排今天时穿着从衣柜里挑，还是每天新编（和 plan-day 一起发）；
 * - draw-town 画小镇：只按世界观重画像素小镇的样子（蓝图见 town.ts），地点和作息不动。
 */
export const RHYTHM_TASKS = {
  'build-world': '建世界',
  'plan-day': '排今天',
  'draw-town': '画小镇',
  'outfit-pick': '穿着从衣柜挑',
  'outfit-new': '穿着每天新编',
} as const;

export type RhythmTask = keyof typeof RHYTHM_TASKS;

/** 生图预设里按"画什么"发送的块：块的触发条件写这几个值 */
export const IMAGE_MODES = { scene: '画一个场景', portrait: '全身像', face: '脸部特写', background: '只画背景' } as const;

/** 画什么：scene 一个具体画面（默认）/ portrait 全身像 / face 脸部特写 / background 只画背景 */
export type ImageMode = keyof typeof IMAGE_MODES;

/** 程序填充块的名字（所有分类一起查） */
export function markerName(identifier: string): string | undefined {
  const own = (PROMPT_MARKERS as Record<string, string>)[identifier];
  if (own) return own;
  for (const m of Object.values(TASK_MARKERS)) if (m[identifier]) return m[identifier];
  return undefined;
}
