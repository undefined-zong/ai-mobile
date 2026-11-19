# 特殊格式

App 认的各种写法集中在这一页：模型回复里夹带的隐藏标签、预设里的程序填充块和触发条件、各用途的输出格式、App 自己加的宏、文件格式，以及导入的东西里常见、App 不认的写法。

- 代码里的登记表是 `packages/shared/src/formats.ts`（标签的说明在 `tags.ts`，程序填充块在 `types/preset.ts`）。**输出格式以 App 自带的预设文件为准**（`apps/web/src/presets/`），登记表不另抄一份：检测时拿同一用途的自带预设当参照，从里面读字段名、任务、程序填充块。
- "我的 → 助手"按这一页检测导入的预设、世界书、角色卡哪些不适配，也把相关的部分写进助手的提示词（见文末"助手"）。

## 一、模型回复里的隐藏标签

角色扮演的回复里夹带，对方看不到，程序边流式边剥离、执行（`tags.ts`）。兼容全角写法 `【expr：smile】`；不认识的方括号（例如"[笑]"）原样留在正文里。每个场景能用哪些由程序填在"当前场景规则 + 可用标签"那一块里（只列这个场景能用的，表情只列她有图的），所以导入的 SillyTavern 预设也知道怎么用，预设、世界书里不用自己列。

| 写法 | 做什么 |
| --- | --- |
| `[expr:表情]` | 换立绘表情（只能用她有图的表情） |
| `[pose:动作]` | 换立绘动作（聊天、戳戳乐里，她有两个以上的动作时） |
| `[outfit:服装]` | 换一身衣服 |
| `[bg:地点]` | 换背景 |
| `[cg:画面描述]` | 发一张图：冒号后面用中文写画面，程序交给"生图提示词"写 tags 再调生图 API；一次回复最多一个 |
| `[music:歌名-歌手]` | 分享一首歌（歌曲卡片，"一起听"按歌名 + 歌手去网易云搜） |
| `[call]` | 想打电话（弹出来电；聊天里是一张响 30 秒的来电卡，没接就成了能回拨的未接来电） |
| `[choice:选项A\|选项B]` | 可以点的选项（约会：四个选项带"顺着 / 逆着 / 皮一下 / 暧昧"前缀） |
| `[poke:部位]` | 回戳 |
| `[study:要做的事\|分钟]` | 约你一起学习（邀请卡片 → 陪伴学习，带上这件事；写了分钟用倒计时，两项都可以不写） |
| `[watch:片名\|链接]` | 约你一起看（邀请卡片 → 一起观影；没给链接时搜 B 站的真实视频挑一个：连着 Hub 时真的搜（`GET /v1/video/search`），没连就在每小时更新的 B 站片单里找，见 `services/bilibili.ts`） |
| `[game:游戏名]` | 约你玩某一个游戏（邀请卡片 → 直接开那个游戏：王国模拟、大乱斗、海龟汤、真心话大冒险、飞行棋、装修小屋、创意工坊） |
| `<device>"VIBRATE": 40</device>` | 玩具的控制指令（尖括号、成对、可以跨行；键沿用 SillyTavern 的 Intiface 插件：VIBRATE / OSCILLATE / ROTATE / LINEAR / STOP）。心跳里由心跳执行；聊天里是一张卡片，连着玩具时读到那里自动执行 |

**聊天里的主动卡片由世界书开关**（`chatModules.ts`）：自带的世界书"聊天 · 主动卡片"每个功能一条、每个游戏一条，绑到角色卡上后，开着哪条她就能用哪个，关掉的那个功能提示词里不再教、回复里写了也不出卡片（玩具指令默认关着）。规则是"有开着的条目教了这个写法就开、只有关着的就关、都没提就按默认（歌曲、打电话照旧能用）"，所以自己写的世界书只要内容里写了这些写法也一样能开关。

其余和回复有关的写法：

- **思考**：`<think>…</think>` 默认从回复里去掉（"API 设置 → 输出修剪"里还能加规则）；写成 `<thinking>` 等别的标签不会去掉。
- **动作**：`（动作）` 和 `*动作*` 在气泡里显示得淡一点，朗读时默认不读。
- **HTML**：气泡是纯文字；"我的 → 消息设置"开了 HTML 渲染时，排版标签（`<details>` `<b>` `<span style>` `<table>` `<img>`……）按白名单显示，不认识的标签去掉标签、留下字，`<style>` `<script>` 去掉；整页 HTML（带 `<html>` `<head>` `<body>`）放在 ` ```html ` 代码块里才在沙盒小窗里运行（同酒馆助手）。
- **创意工坊 · 小说**：商量时一行 `【记进设定】……` 是助手建议记进设定的一条；写章节、番外时第一行 `# 标题`，空一行，然后是正文。

## 二、预设里的程序填充块

块的 `marker` 为 true、内容为空，程序每次填（`PROMPT_MARKERS`、`TASK_MARKERS`）。

- **角色扮演类**（对话、功能、主动消息）：和 SillyTavern 一样的 `worldInfoBefore` `charDescription` `charPersonality` `scenario` `worldInfoAfter` `personaDescription` `dialogueExamples` `chatHistory`，加上 App 自己的 `summary`（过往摘要）、`memory`（长期记忆 + 关系状态）、`environment`（当前环境）、`home`（家务和健康：你今天的情况）、`sceneRules`（当前场景规则 + 可用标签）；功能预设还有 `sceneTask`（这一步要她做什么），主动消息有 `proactive`。导入 SillyTavern 预设时 App 自己的那几块自动补进去（`st/preset.ts` 的 `appBlocks`）。
  - 缺了 `chatHistory`、`charDescription`、功能预设缺 `sceneTask`、主动消息缺 `proactive`：不适配；缺 `sceneRules`：标签和场景规则不会发，表情不会换、不会配图。
- **任务类**：每类自己的一套（小剧场 `story*`、总结 `summary*`、记忆整理 `consolidate*`、生图 `image*`、节律 `rhythm*`、健康 `health*`、计划 `planner*`、平行时空 `parallel*`、控制指令 `device*`、小说 `novel*`、立绘 `sprite*`、社媒 `social*` `community*`、助手 `assistant*`），名字在预设编辑页里看得到。缺了这次任务的输入（例如生图缺 `imageCaption`、总结缺 `summaryTranscript`）就做不成。

## 三、触发条件

块的 `triggers` 写了值时，只在程序做这些事时发送；没写的每次都发。

| 写法 | 意思 |
| --- | --- |
| `housework` / `health` | 角色扮演预设：你人设里开了家务 / 健康系统时才发 |
| `td-level:名字` / `soup-level:名字` / `poke-level:名字` | 真心话大冒险 / 海龟汤 / 戳戳乐的尺度：一块一个尺度，名字是冒号后面的字 |
| `scene` / `portrait` / `face` / `background` | 生图预设：画什么（一个场景、全身像、脸部特写、只画背景） |
| `seat` `peek` `reward` `mine`、`table` `side` `cheers`、`arrive` `highlight` `keepsake`、`mic` `now`、`open` `now` | 一起做事时自动画图的时刻（陪伴学习、一起吃饭、约会、哄睡、心跳） |
| `sprite-frame:名字` / `sprite-expr:名字` / `sprite-pose:名字` | 立绘预设：构图、表情、动作，一块一个 |
| 其余 | 各功能的任务名，见下表 |

各用途的任务（以自带预设为准；生图的时刻、尺度、立绘的表情动作见上表）：

| 自带预设 | 用途 | 任务 |
| --- | --- | --- |
| chat-daily.json / chat-stage.json | 对话 | `photo-look`（识图看你发的照片；没有这块用自带的） |
| feature-date.json | scene:date | `date-start` `date-turn` `date-end` |
| feature-exercise.json | scene:exercise | `fit-start` `fit-move` `fit-cheer` `fit-chat` `fit-call` `fit-end` |
| feature-home.json | scene:home | `chore-start` `chore-done` `chore-later` `chore-chat` `chore-call` |
| feature-meal.json | scene:meal | `meal-start` `meal-prep` `meal-ready` `meal-food` `meal-cheers` `meal-chat` `meal-call` `meal-watch` `meal-end` `meal-look` |
| feature-study.json | scene:study | `study-start` `study-break` `study-chat` `study-stuck` `study-end` |
| feature-sleep.json | scene:sleep | `sleep-call` `sleep-whisper` `sleep-story` `sleep-end` |
| feature-sleep-scene.json | sleep-scene | `sleep-scene-start` `sleep-scene-turn` `sleep-scene-end` |
| feature-music.json | scene:music | `music-batch` `music-chat` |
| feature-watch.json | scene:watch | `watch-batch` `watch-chat` `watch-pause` `watch-end` `watch-link` |
| feature-read.json | scene:read | `read-batch` `read-note` `read-chapter-end` `read-chat` `read-ocr` |
| feature-heart.json / feature-heart-voice.json | scene:heart / heart-voice | `heart-open` `heart-chat` / `heart-call` `heart-murmur`，都有 `device-inline` |
| feature-poke.json | scene:poke | `poke-hand` `poke-mouth` `poke-rub` |
| feature-game.json | scene:game（海龟汤） | `soup-judge` `soup-judge-coop` `soup-teammate` `soup-guess` `soup-hint` `soup-hint-coop` `soup-final` `soup-reveal` `soup-make` `soup-check` |
| feature-game-truthdare.json | game-truthdare | `td-ask-truth` `td-ask-dare` `td-react` `td-pick` `td-suggest` `td-answer` `td-dare` `td-chat` `td-end` |
| feature-game-flight*.json | game-flight | `fly-make` `fly-do` `fly-react` `fly-chat` `fly-end` |
| feature-game-brawl.json | game-brawl | `brawl-make`（配招）`brawl-open`（开场）`brawl-end`（结算） |
| feature-game-decor.json | game-decor | `decor-look` `decor-plan` `decor-avatar` `decor-chat` `decor-end` |
| feature-game-workshop.json | game-workshop | `ws-novel` `ws-image` `ws-cheer` `ws-roast` `ws-chat` |
| image-workshop.json / image-community.json | game-workshop-image / community-image | `ws-her` `ws-free` / `community-netizen` `community-member` |
| parallel.json | parallel（平行时空） | `parallel-post`（她给你留言）`parallel-reply`（回你的留言）`parallel-request`（你请她改日程）；留言里说的是哪一项写编号：她的 `C1`…、你的 `U1`… |
| social.json | social | `post` `react` |
| social-community.json | community | `community-create` `community-feed` `community-react` `community-member-post` `community-member-react` |
| rhythm.json | rhythm | `build-world` `draw-town` `plan-day` `outfit-pick` `outfit-new` |
| health.json | health | `plan-week` `plan-day` |
| consolidate.json | consolidate | `merge` `rollup` `tense` `profile` |
| novel.json | novel | `novel-chat` `novel-chapter` `novel-extra` `novel-rewrite` |
| sprite.json | sprite | `sprite-tags` `sprite-label` `sprite-draw` `sprite-negative` |
| assistant.json | assistant | `check`（一键检测）`card`（做角色卡 / 补全设定） |

游戏的预设靠任务名的前缀认（`td-` `soup-` `fly-` `brawl-` `decor-` `ws-` `poke-` `community-`，`presetUses.ts`）：换成别的功能预设时出题、布置这些格式会不对。

## 四、输出格式（JSON 字段名别改）

程序按字段名读，字段名一个字都不能改；说明文字、规则可以改。下表是自带预设里写着 JSON 示例的块和它的字段（只列前十几个）：

| 自带预设 | 用途 | 块 | 发送时机 | 字段 |
| --- | --- | --- | --- | --- |
| image*.json（11 个） | image、image:*、community-image、game-workshop-image | 输出格式 | 每次 | 不是 JSON：`image###tags###`，可选 `negative###…###`、`size###…###`；画面里有你时多 `char###…###`、`user###…###`（位置 `char left###…###`，只针对一人的负面 `char negative###…###`）。标题、画幅、长相由程序拼 |
| summary.json | summary | 输出格式 | 每次 | summary、slices（title、text、from、to、mood、special、important）、memories（type、content、importance、dueAt、supersedes、lines、entities）、relationship（affectionDelta、mood、nicknames） |
| theater.json | theater | 输出格式 | 每次 | title、story、time、place、mood、people、hook、cg |
| consolidate.json | consolidate | 合并重复的记忆 / 合并时间线 / 过期的待跟进改时态 / 修改画像卡 | merge / rollup / tense / profile | merges（ids、content、type、importance）/ text / updates（id、content、type、dueAt）/ ops（op、section、text、id） |
| social.json | social | 发朋友圈 / 回应 | post / react | text、image、html、htmlTitle、location / like、comment |
| social-community.json | community | 建社群 / 发帖 / 网友回应 / 角色回应 | community-create / community-feed、community-member-post / community-react / community-member-react | name、description、vibe、tags、icon、color、memberCount / posts（author、title、text、image、html、htmlTitle、likes、bumps、comments、replyTo）/ likes、bumps、comments / like、bump、comment |
| rhythm.json | rhythm | 建世界、小镇外观 / 画小镇 / 排今天 | build-world / draw-town / plan-day | fixed、name、blurb、areas、home、locations、people、schedule、meals、wardrobe……/ look、ground、path、water、buildings……/ schedule、meals、outfits、events…… |
| health.json | health | 排这周 / 排今天 | plan-week / plan-day | focus、days（weekday、workout、minutes、rest、meals）、shopping（name、amount、where、search）、tips / warmup、items（name、sets、reps、seconds、how、easier）、cooldown、meals（breakfast、lunch、dinner……） |
| device-heart.json | device | 输出格式 | 每次 | 不是 JSON：把Ta那一句照抄一遍、在要变的地方插 `<device>`，里面的 VIBRATE、pattern、interval、loop、start_position、end_position、duration、STOP…… |
| feature-heart*.json | scene:heart、heart-voice | 玩具：你自己写指令 | device-inline | `<device>` 里的 VIBRATE、LINEAR、STOP…… |
| feature-game-brawl.json | game-brawl | 生成战斗档案 / 开场 / 结算 | brawl-make / brawl-open / brawl-end | title、style、hp、mp、attack、speed、color、look、passive、skills / line / line |
| feature-game-decor.json | game-decor | 她动手布置 / 她捏小人 | decor-plan / decor-avatar | line、expr、actions（do、item、x、z、turn、color……）/ line、expr、avatar（skin、hair、bangs、eyes、suit……） |
| feature-game-flight*.json | game-flight | 棋盘设计 | fly-make | cells（n、task、move、again、skip） |
| feature-game-truthdare.json | game-truthdare | 出真心话 / 出大冒险 / 她选 / 帮你想题 | td-ask-truth / td-ask-dare / td-pick / td-suggest | card、line、expr / pick、line、expr / options |
| feature-game.json | scene:game | 判定 / 提示 / 判答案 / 现编一道 / 自检 | soup-judge(-coop) / soup-hint-coop / soup-final / soup-make / soup-check | answer、hits、close、line、expr / hint / verdict、missing、line / title、surface、truth、keys、difficulty / ok、reason |
| feature-music.json、feature-watch.json、feature-read.json | scene:music、scene:watch、scene:read | 批量弹幕、批注 | music-batch / watch-batch / read-batch | reactions（line、text、cue、expr）、notes（para、quote、note、expr）、summary |
| feature-meal.json | scene:meal | 识图看饭照 | meal-look | food、desc |
| sprite.json | sprite | 写外观 tags / 给新表情、动作写 tags | sprite-tags / sprite-label | appearance、negative、outfit（name、tags）/ tags、hint、emotion |
| novel.json | novel | 写章节、番外、重写 | novel-chapter 等 | 不是 JSON：第一行 `# 标题`，空一行，正文 |
| assistant.json | assistant | 修改的写法 | 每次 | `<edits>` 里的 JSON 数组，见文末 |

## 五、宏

SillyTavern 常用的宏都认（`{{char}}` `{{user}}` `{{time}}` `{{date}}` `{{random::a::b}}` `{{setvar}}` `{{getvar}}`……，`st/macros.ts`），App 另外加了：

| 宏 | 在哪用 | 换成 |
| --- | --- | --- |
| `{{weather}}` | 都能用 | 天气一句话 |
| `{{char_appearance}}` | 生图预设 | 她的长相（原创是外观 tags；同人是角色 tag + 作品 tag） |
| `{{char_outfit}}` | 生图预设 | 节律里她今天这个场景穿的那套 |
| `{{user_appearance}}` | 生图预设 | 你的长相 |
| `{{framing}}` `{{expression}}` `{{pose}}` | 立绘预设的画法块 | 这次画的构图、表情、动作 |
| `{{community}}` | 社群预设 | 这个社群的名字 |

## 六、文件格式

- **App 的预设文件**（`.json`，`format: "ai-mobile-preset"`，`version: 1`）：`id`、`name`、`description`、`category`、`defaultFor`（第一次放进预设库时给哪些用途用）、`blocks`、`sampler`、`formats`、`regex`。自带预设就是这种文件，预设编辑页能把任何预设导出成它（`presetFile.ts`）。
- **SillyTavern**：角色卡 PNG（`chara` / `ccv3` 块）/ JSON（V1–V3，内嵌世界书拆出来绑定）、世界书（扁平格式和 `character_book`）、Chat Completion 预设（用 `prompt_order` 100001 那套，补上 App 自己的块）、正则脚本（预设、角色卡里的 `regex_scripts`）。没有对应字段的设置原样存进 `extra`，导出时写回。
- **注意**：App 只执行**预设里**的正则；角色卡自带的正则要在对话预设的"正则"页里从角色卡导入（或者让助手搬进预设）。

## 七、别的写法 → App 的写法

导入的预设、世界书、角色卡里常见这些写法（`FOREIGN_FORMATS`，只看角色扮演类的预设、世界书和角色卡）：

| 别的写法 | 例子 | App 的写法 / 会怎样 |
| --- | --- | --- |
| 另一套生图写法 | `<pic prompt="…">`、`<img src="…pollinations…">`、`![](https://…)`、`[image:…]`、`<生图>`、`/sd` | `[cg:画面描述]`；别的写法 App 不会拿去画（开了 HTML 渲染时 `<img>` 外链会直接显示别人的图） |
| 另一套表情写法 | `[表情:开心]`、`<expression>` | `[expr:表情]` |
| 另一套分享歌曲 | `<music>`、`[歌曲:…]` | `[music:歌名-歌手]` |
| 另一套选项 | `<options>`、`【选项】` | `[choice:选项A\|选项B]`（约会里） |
| 另一套打电话 | `[电话]`、`[来电]` | `[call]` |
| 思考标签 | `<thinking>`、`<思考>` | `<think>…</think>`（默认去掉） |
| 状态栏 / 面板 | `<status>`、`<StatusBlock>`、`<状态栏>` | 不认识的标签去掉标签、留下字；不想要就加一条"仅格式显示"的正则 |
| 正文包装标签 | `<content>`、`<正文>` | 标签去掉、字留着；想让存下来的消息干净就加正则去掉 |
| 样式表 | `<style>` | 只在 ` ```html ` 代码块里的整页 HTML 里生效 |

另外会检查：预设缺了哪些程序填充块、程序不认识的程序填充块、缺了哪件事的任务块、输出格式里少了哪些字段；世界书里没有关键词也不是常驻（永远不会触发）的条目、没绑给角色的世界书；角色卡缺的设定（描述、性格、场景、开场白、示例对话、外观 tags、称呼）、卡里带的正则。

## 八、助手

"我的 → 助手"：选要看的预设、世界书、角色卡或大乱斗战斗档案（可以选好几个），和助手说要怎么改；"一键检测"把上次检测之后导入的（没有就全部导入的）按上面几节查一遍，不用 API，有问题的一键交给助手修。助手只改格式、不动原来写的字，除非你要它改；也能做角色卡、补全设定。提示词在"助手"预设里（`apps/web/src/presets/assistant.json`），API 是"助手"这个功能（默认跟随主对话）。

助手的修改写在回复最后的 `<edits>…</edits>` 里（JSON 数组，一项一个修改，`assistantEdits.ts`）。程序先给你看改之前 / 改之后（动了原文的标"改了文字"），点"应用"才写进去，能撤销（最近 5 次）：

| 对象 | op | 字段 |
| --- | --- | --- |
| `"preset": id` | `replace` | `block`、`find`（原文里的一句）、`with` |
|  | `set` | `block`，加 `enabled` `role` `triggers` `name` `content` `position` `depth` `order` |
|  | `add` / `move` / `remove` | `after`（块的 identifier，null 是最前）、`block`（新块：`identifier` `name` `role` `content` `triggers` `marker`） |
|  | `add-regex` / `set-regex` / `remove-regex` | `regex`（`name` `find` `replace` `placement` `markdownOnly` `promptOnly`，改、删时写正则的 id） |
|  | `meta` | `name`、`description` |
|  | `copy` / `copy-regex` | `from`（别的预设 id），`blocks`（块的 identifier，原样复制；不写 `after` 时按原来的邻居找位置）/ `regex`（正则 id，全部写 `all`） |
| `"preset": "new"` | `create` | `from`（照哪个预设复制）、`name`、`description`、`category`（所有分类都能互换，只用于整理；助手融合时由所选功能来源的分类决定）；之后 `"preset": "new"` 改的是这个新预设（预设融合） |
| `"lorebook": id` | `replace` / `set` / `add` / `remove` / `meta` | `entry`（条目的 uid）、`find` `with`、`keys` `constant` `enabled` `position` `depth` `order` `comment` `content` |
| `"lorebook": "new"` | `create` | `name`、`description`、`entries`、`bindTo`（角色 id，或 `new`：这次新建的角色） |
| `"character": id` | `replace` / `set` | `field` `find` `with`；`description` `personality` `scenario` `firstMes` `alternateGreetings` `mesExample` `systemPrompt` `postHistoryInstructions` `creatorNotes` `tags` `appearanceTags` `negativeTags` `pronoun` `name` |
| `"character": "new"` | `create` | 同上 |
| `"fighter": id` | `set` | `title`、`style`、`hp`、`mp`、`attack`、`speed`、`color`、`look`（hair、hairColor、outfit、skin）、`passive`（name、kind、description） |
| `"fighter": id` | `skill` | `slot`（1 / 2 / 3，3 为奥义），加 `name`、`description`、`kind`、`damage`、`mana`、`cooldown`、`range`、`windup`、`recovery`、`knockback`、`launch` |

大乱斗的 `fighter` id 取自助手上下文，形如 `character-角色id` 或 `persona-人设id`，不改角色卡原文或档案归属。风格 `balanced / rush / ranged / guard`；招式 `strike / projectile / dash / burst / shield`；被动 `flow / guard / recovery / laststand`。具体数值和招式含义以「一起游戏 · 大乱斗」预设为准；`damage` 对护盾招式表示吸收量。修改只在点击应用后保存，下一局使用，可用助手原有撤销恢复。
