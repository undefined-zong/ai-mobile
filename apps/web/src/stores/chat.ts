import { characterPronoun } from '@app/shared';
import {
  AGENT_META,
  allowedInviteGames,
  describeCommand,
  getLocation,
  getScene,
  isRealPlace,
  parseControlTags,
  parseDeviceBlock,
  substituteMacros,
  type Character,
  type Chat,
  type ChatImport,
  type ParsedChat,
  type ImageMode,
  type Message,
  type MessagePart,
  type MessageRole,
  type TogetherMode,
  type AgentRole,
  type ControlTagKind,
  type ParsedReply,
  type PresetUseId,
} from '@app/shared';
import { errorReport, errorText, fromOpenAIBody, isAbortError, SECONDARY_TAGS, type SecondaryReply } from '@app/ai';
import { defineStore } from 'pinia';
import { computed, reactive, ref } from 'vue';
import { useAiStore } from './ai';
import { useAppStore } from './app';
import { useCharacterStore } from './characters';
import { useRealWorldStore } from './realworld';
import { autoSave, chatMessageKeys, getAll, msgKey, recentMessages, splitMsgKey, write, writeTogether, type RemoteChange } from '@/db/idb';
import { applyList } from '@/services/sync/apply';
import { buildChats, buildMessages } from '@/mock/chats';
import { services } from '@/services';
import { putAsset } from '@/services/assets';
import { describePhoto } from '@/services/photos';
import { sessionSummary as musicSummary, stop as stopMusic } from '@/services/musicPlayer';
import { assembleForChat, boundLoreEntries, messageToText, personaOf, sceneTags, storeRegex, toLLMMessages, type ChatPrompt } from '@/services/prompt';
import { latestRecall, noteRecallUsed, prefetchRecall } from '@/services/recall';
import { backfillChat, pendingForSummary, summarizeChat, type BackfillProgress, type SummaryOutcome } from '@/services/summary';
import { useMemoryStore } from './memory';
import { useMessageSettingsStore } from './messageSettings';
import { useToyStore } from './toys';
import { ReplyTimeline, type TimedCommand } from '@/services/toyPlayer';
import { secondaryChat } from '@/services/secondaryChat';
import { uid } from '@/utils/id';

/** 聊天里她打来的电话响多久（过了没接就成了未接来电） */
export const RING_MS = 30_000;

/** generate 的选项：一起做事时用哪个功能、这一次的场景任务、在这件事里的位置 */
export interface GenerateOptions {
  agent?: AgentRole;
  task?: { name: string; input: string };
  cue?: string;
  /** 按哪个用途选预设（语音通话用 call）；不给时按场景 / 对话预设 */
  use?: PresetUseId;
  /** 只执行这些标签（通话里只换表情，不发图、不弹选项、不再"打电话"）；不给按场景 */
  allowedTags?: ControlTagKind[];
  /** 流式时每次给"到目前为止的正文"（已去掉标签）：通话、讲故事时边生成边分句合成语音 */
  onText?(visible: string): void;
  /** 这一次另外打开的预设触发条件（心跳连着玩具、她自己写指令时是 device-inline） */
  flags?: string[];
  /** 流式时每次、写完时（done）给解析好的正文和标签（标签的位置是在正文里的下标）：心跳按位置执行 <device> 指令 */
  onParsed?(parsed: ParsedReply, done: boolean): void;
  /** [cg:] 由场景自己画（用这个场景的生图预设和时刻，约会）：这里不往消息里放配图卡 */
  sceneArt?: boolean;
}

export interface SceneReplyOptions {
  /** 场景任务名：功能预设里触发条件写了它的块只在这时发送 */
  task: string;
  /** 程序写的这一次的输入（只放数据） */
  input: string;
  /** 你这一次说的话（纸条、提问……）：先存进聊天，再让她回 */
  userText?: string;
  /** 在这件事里的位置，存在两条消息上（"第 2 个番茄"） */
  cue?: string;
  /** 流式时每次给到目前为止的正文（讲故事时边生成边读） */
  onText?(visible: string): void;
  /** 只执行这些标签；不给按场景 */
  allowedTags?: ControlTagKind[];
  /** 按哪个用途选预设（一起游戏里玩真心话大冒险时是 game-truthdare）；不给时用这个场景的功能预设 */
  use?: PresetUseId;
  /** 这一次另外打开的预设触发条件（真心话大冒险选的尺度 td-level:名字） */
  flags?: string[];
  /** 流式时每次、写完时给解析好的正文和标签（约会按段落翻页、按位置换表情，读选项和 [cg:]） */
  onParsed?(parsed: ParsedReply, done: boolean): void;
  /** [cg:] 由场景自己画，不往消息里放配图卡 */
  sceneArt?: boolean;
}

export type SceneReplyResult = { ok: true; message: Message } | { ok: false; reason: string; notConnected?: boolean };

/** 正在生成的回复。只放内存，不进同步数据（math-reader 回滚提交的教训） */
interface StreamState {
  messageId: string;
  /** 还没有正文：请求刚发出、模型在思考、流式失败正改用普通请求 */
  thinking: boolean;
  /** 模型的思考内容（有的模型会返回） */
  reasoning: string;
  abort: AbortController;
}

/** 每个聊天在内存里至少放最近几条；没整理的那段也放进来，但最多这么多（更早的在本机库里，往上翻时再读） */
const WINDOW = 400;
const WINDOW_CAP = 3000;

export const useChatStore = defineStore('chat', () => {
  const messages = ref<Record<string, Message[]>>(buildMessages());
  const chats = ref<Chat[]>(buildChats(messages.value));
  const streams = reactive<Record<string, StreamState | undefined>>({});
  /** 每条聊天上一次实际发出去的提示词（"查看提示词"里看）。只放内存 */
  const lastPrompt = reactive<Record<string, { prompt: ChatPrompt; at: number } | undefined>>({});

  // 全部聊天持久化，含演示角色收到的真实云端消息。
  const chatSaver = autoSave(
    'chats',
    () => chats.value.map((c) => ({ key: c.id, value: c })),
    chats,
    // 别的设备改了聊天（同步）：放进来（正开着的场景、在哪这些同步时留的是本机的）
    { apply: (changes) => applyList(chats, changes, { normalize: (c) => { delete (c as Chat & { presetId?: unknown }).presetId; return c; } }) },
  );
  // 消息一条一行（chatMessages 表）：长聊天改一条只写一条，同步也只推这一条
  const messageSaver = autoSave(
    'chatMessages',
    () => chats.value.flatMap((c) => (messages.value[c.id] ?? []).map((m) => ({ key: msgKey(c.id, m.id), value: m }))),
    messages,
    {
      // 别的设备发的、改的、删的消息（同步按条合并好了）：同一条消息原地换内容，正在用它的地方看得到
      apply: (changes) => {
        const byChat = new Map<string, RemoteChange[]>();
        for (const c of changes) {
          const k = splitMsgKey(c.key);
          if (!k) continue;
          byChat.set(k[0], [...(byChat.get(k[0]) ?? []), c]);
        }
        for (const [chatId, list] of byChat) {
          const cur = messages.value[chatId] ?? [];
          const index = new Map(cur.map((m, i) => [m.id, i]));
          const gone = new Set<string>();
          let added = false;
          for (const c of list) {
            const id = splitMsgKey(c.key)![1];
            const i = index.get(id);
            if (c.deleted || !c.value) {
              if (i !== undefined) gone.add(id);
              continue;
            }
            const m = c.value as Message;
            if (i === undefined) {
              index.set(id, cur.length);
              cur.push(m);
              added = true;
            } else if (JSON.stringify(cur[i]) !== JSON.stringify(m)) {
              const old = cur[i]!;
              for (const k of Object.keys(old)) if (!(k in m)) delete (old as unknown as Record<string, unknown>)[k];
              Object.assign(old, m);
            }
          }
          let next = gone.size ? cur.filter((m) => !gone.has(m.id)) : cur;
          if (added) next = next.slice().sort((a, b) => a.createdAt - b.createdAt);
          messages.value[chatId] = next;
        }
      },
    },
  );

  async function hydrate() {
    const cs = await getAll<Chat>('chats');
    for (const c of cs.sort((a, b) => a.createdAt - b.createdAt)) {
      chats.value = chats.value.filter((x) => x.id !== c.id);
      delete (c as Chat & { presetId?: unknown }).presetId; // 旧数据里聊天上也存了一份预设，现在只看角色上的
      chats.value.push(c);
    }
    // 每个聊天只把最近的读进内存（至少 WINDOW 条，没整理的那段也读进来，最多 WINDOW_CAP 条）：几十万条的聊天打开也不占几百 MB
    const pages = await Promise.all(cs.map((c) => recentMessages<Message>(c.id, {
      n: WINDOW, cap: WINDOW_CAP, until: c.summaryUntilMessageId ? (m) => m.id === c.summaryUntilMessageId : undefined,
    })));
    const fixed: { key: string; value: unknown }[] = [];
    cs.forEach((c, i) => {
      const { items, more } = pages[i]!;
      for (const { key, value: m } of items) {
        // 上次画到一半 App 关了 / 刷新了：卡片别一直"生成中"
        let broken = false;
        for (const p of m.parts ?? []) {
          if (p.type === 'image' && !p.generated && !p.error) {
            p.error = '上次没画完（App 关了或刷新了）';
            p.errorDetail = '点开这张图，按"重新生成"再画一次。';
            broken = true;
          }
        }
        if (broken) fixed.push({ key, value: JSON.parse(JSON.stringify(m)) });
      }
      messages.value[c.id] = items.map((x) => x.value);
      if (more) earlierInDb[c.id] = true;
    });
    // 库里没有的聊天（第一次打开的演示聊天）：内存里的写进库
    const stored = new Set(cs.map((c) => c.id));
    for (const [chatId, list] of Object.entries(messages.value)) {
      if (stored.has(chatId)) continue;
      for (const m of list) fixed.push({ key: msgKey(chatId, m.id), value: JSON.parse(JSON.stringify(m)) });
    }
    // 只写回真的改了的（以前整份聊天写回一遍，长聊天打开就要写几百 MB）
    await Promise.all([
      write('chats', chats.value.map((c) => ({ key: c.id, value: JSON.parse(JSON.stringify(c)) }))),
      write('chatMessages', fixed),
    ]);
    chatSaver.start();
    messageSaver.start();
  }

  /** 本机库里还有更早的消息（没读进内存）的聊天 */
  const earlierInDb = reactive<Record<string, boolean>>({});

  /**
   * 从本机库往前再读一些进内存（聊天里往上翻）。返回读进来几条。
   * until：一直读到它为真的那条（n 之外，最多 cap 条）
   */
  async function loadEarlier(chatId: string, n = WINDOW, opts: { until?: (m: Message) => boolean; cap?: number } = {}): Promise<number> {
    const cur = messages.value[chatId] ?? [];
    const { items, more } = await recentMessages<Message>(chatId, {
      n, cap: opts.cap, until: opts.until, before: cur[0]?.createdAt ?? Infinity, skip: new Set(cur.map((m) => msgKey(chatId, m.id))),
    });
    if (more) earlierInDb[chatId] = true;
    else delete earlierInDb[chatId];
    const list = messages.value[chatId] ?? [];
    const have = new Set(list.map((m) => m.id));
    const add = items.map((x) => x.value).filter((m) => !have.has(m.id));
    if (!add.length) return 0;
    messages.value[chatId] = [...add, ...list].sort((a, b) => a.createdAt - b.createdAt);
    // 从库里读出来的就是库里的样子：不用写回去
    messageSaver.settle(add.map((m) => msgKey(chatId, m.id)));
    return add.length;
  }

  /** 整理要从上次整理到的地方接着来：那条之后的都读进内存（从没整理过就全读） */
  async function loadSinceSummary(chatId: string) {
    const p = chatById(chatId)?.summaryUntilMessageId;
    if (!earlierInDb[chatId] || (p && list(chatId).some((m) => m.id === p))) return;
    await loadEarlier(chatId, 0, { until: p ? (m) => m.id === p : () => false, cap: Infinity });
  }

  /** 离开聊天时：内存里只留最近 WINDOW 条（和还没整理的那段），更早的留在库里，用到时再读 */
  async function trimWindow(chatId: string) {
    const cur = messages.value[chatId];
    if (!cur || cur.length <= WINDOW || streams[chatId] || summarizing[chatId]) return;
    const p = chatById(chatId)?.summaryUntilMessageId;
    const at = p ? cur.findIndex((m) => m.id === p) : -1;
    const from = Math.min(cur.length - WINDOW, at >= 0 ? at : Infinity);
    if (from <= 0) return;
    // 没写完的先写掉，再从内存里拿掉（不当成删除）
    await messageSaver.flush();
    const now = messages.value[chatId];
    if (!now || streams[chatId] || summarizing[chatId]) return;
    const drop = now.slice(0, from);
    messageSaver.forget(drop.map((m) => msgKey(chatId, m.id)));
    messages.value[chatId] = now.slice(from);
    earlierInDb[chatId] = true;
  }

  /**
   * 给新角色开一条聊天：第一条是角色卡的开场白（宏替换后），备选开场白可以左右切换（同 ST）。
   * 已经有聊天就直接返回那条（消息按人分）。
   */
  function startChat(character: Character, opts: { greeting?: boolean } = {}): Chat {
    const existing = chatOfCharacter(character.id);
    if (existing) return existing;
    const now = Date.now();
    const chat: Chat = {
      id: uid('chat'),
      createdAt: now,
      updatedAt: now,
      characterId: character.id,
      personaId: null,
      title: character.name,
      mode: 'im',
      currentScene: null,
      togetherAt: null,
      togetherMode: null,
      summaryUntilMessageId: null,
      pinned: false,
      lastMessageAt: now,
      background: null,
      loreState: { sticky: {}, cooldown: {} },
      vars: {},
    };
    chats.value.push(chat);
    messages.value[chat.id] = [];
    const user = personaOf(chat).name;
    const greet = (t: string) => substituteMacros(t, { char: character.name, user, pronoun: characterPronoun(character) }).replace(/\r/g, '');
    const greetings = [character.card.firstMes, ...character.card.alternateGreetings].filter((t) => t.trim()).map(greet);
    if (greetings.length && opts.greeting !== false) {
      push(chat.id, 'assistant', [{ type: 'text', text: greetings[0] as string }], {
        read: false,
        swipes: greetings.map((text, i) => ({ text, createdAt: now + i })),
        swipeIndex: 0,
      });
    }
    return chatById(chat.id) as Chat;
  }

  /** 导入到角色已有的聊天，保留原有消息；正文先落库，完成页才显示成功。 */
  async function importHistory(character: Character, parsed: ParsedChat, fileName: string) {
    const chat = startChat(character, { greeting: false });
    const now = Date.now();
    const importId = uid('import');
    const added: Message[] = parsed.messages.map((m, i) => ({
      ...m, id: `${importId}_${String(i).padStart(10, '0')}`, chatId: chat.id,
    })).sort((a, b) => a.createdAt - b.createdAt);
    const record: ChatImport = {
      id: importId, fileName, importedAt: now, messageCount: added.length,
      firstMessageId: added[0]!.id, lastMessageId: added.at(-1)!.id,
    };
    await messageSaver.flush();
    await chatSaver.flush();
    const imported = {
      ...chat, imports: [...(chat.imports ?? []), record], updatedAt: now,
      lastMessageAt: Math.max(now, chat.lastMessageAt, added.at(-1)!.createdAt),
    };
    await writeTogether([
      ...added.map((m) => ({ store: 'chatMessages' as const, key: msgKey(chat.id, m.id), value: JSON.parse(JSON.stringify(m)) })),
      { store: 'chats', key: chat.id, value: JSON.parse(JSON.stringify(imported)) },
    ]);
    const current = list(chat.id);
    // 内存里的消息必须保持连续，避免把早期导入记录放进来后跳过中间尚未加载的消息。
    const from = earlierInDb[chat.id] ? (current[0]?.createdAt ?? Infinity) : -Infinity;
    const visible = added.filter((m) => m.createdAt >= from);
    messages.value[chat.id] = [...current, ...visible].sort((a, b) => a.createdAt - b.createdAt);
    messageSaver.settle(visible.map((m) => msgKey(chat.id, m.id)));
    if (visible.length < added.length) earlierInDb[chat.id] = true;
    Object.assign(chat, imported);
    chatSaver.settle([chat.id]);
    await trimWindow(chat.id);
    return { chat, record };
  }

  function removeChat(chatId: string) {
    stop(chatId);
    chats.value = chats.value.filter((c) => c.id !== chatId);
    delete messages.value[chatId];
    delete earlierInDb[chatId];
    // 没读进内存的更早的消息也删掉（经过发件箱，别的设备也删）
    void chatMessageKeys(chatId).then((keys) => write('chatMessages', [], keys));
  }

  const sortedChats = computed(() =>
    [...chats.value].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastMessageAt - a.lastMessageAt),
  );

  function chatById(id: string | undefined) {
    return chats.value.find((c) => c.id === id);
  }

  /** 消息按人分：一个角色只有一条聊天 */
  function chatOfCharacter(characterId: string) {
    return chats.value.find((c) => c.characterId === characterId);
  }

  function list(chatId: string): Message[] {
    return messages.value[chatId] ?? [];
  }

  function unread(chatId: string): number {
    return list(chatId).filter((m) => !m.read).length;
  }

  const totalUnread = computed(() => chats.value.reduce((n, c) => n + unread(c.id), 0));


  function markRead(chatId: string) {
    for (const m of list(chatId)) if (!m.read) m.read = true;
  }

  /** 追加一条消息，返回响应式版本（之后要改它，必须改这个返回值或按 id 重新取） */
  function push(chatId: string, role: MessageRole, parts: MessagePart[], extra: Partial<Message> = {}): Message {
    const now = Date.now();
    const text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const msg: Message = {
      id: uid('m'),
      chatId,
      role,
      createdAt: now,
      updatedAt: now,
      text,
      parts,
      expression: null,
      swipes: [],
      swipeIndex: 0,
      proactive: false,
      read: true,
      meta: {},
      ...extra,
    };
    if (!messages.value[chatId]) messages.value[chatId] = [];
    messages.value[chatId]?.push(msg);
    const chat = chatById(chatId);
    if (chat) {
      chat.lastMessageAt = now;
      chat.updatedAt = now;
    }
    return list(chatId).at(-1) as Message;
  }

  function find(chatId: string, id: string): Message | undefined {
    return list(chatId).find((m) => m.id === id);
  }

  /**
   * 让角色回一条：流式更新正文、实时切表情，结束后执行其他标签（歌曲卡、配图、选项、来电）。
   * target 不为空时是"重新生成"：结果作为新的 swipe 追加到这条消息上。
   * opts：一起做事时用「陪伴 · 快速」、带上这一次的场景任务，回复记下场景和位置。返回这条回复的 id
   */
  async function generate(chatId: string, target?: string, opts: GenerateOptions = {}): Promise<string | undefined> {
    if (streams[chatId]) return undefined;
    const chat = chatById(chatId);
    const chars = useCharacterStore();
    const character = chars.byId(chat?.characterId);
    if (!chat || !character) return undefined;
    const agent = opts.agent ?? 'main';

    const id = target ?? push(chatId, 'assistant', [{ type: 'text', text: '' }], opts.task || opts.cue ? { meta: { scene: chat.currentScene ?? undefined, cue: opts.cue } } : {}).id;
    const history = list(chatId).filter((m) => m.id !== id && (!target || m.createdAt < (find(chatId, id)?.createdAt ?? Infinity)));
    const abort = new AbortController();
    streams[chatId] = { messageId: id, thinking: true, reasoning: '', abort };
    const scene = getScene(chat.currentScene ?? 'free');
    const allowedTags = opts.allowedTags ?? sceneTags(scene, character);
    const ai = useAiStore();
    const withSecondary = agent === 'main' && ai.isLive('main') && ai.isLive('secondary');
    const delegatedTags = withSecondary
      ? allowedTags.filter((tag) => SECONDARY_TAGS.includes(tag) && !(tag === 'cg' && opts.sceneArt))
      : [];
    const mainTags = allowedTags.filter((tag) => !delegatedTags.includes(tag));
    const now = new Date();
    let raw = '';

    try {
      // 拼提示词（真实发送：推进世界书粘性 / 冷却，保存 {{setvar}} 改过的变量）。
      // 预设按用途选：语音通话用"语音通话"的预设，在场景页里一起做某件事时用那件事的功能预设，聊天里用这个角色的对话预设；一个都选不到时报错
      const turn = { now, type: target ? 'swipe' as const : 'normal' as const, task: opts.task, targetId: target, flags: opts.flags };
      const prompt = assembleForChat(chat, character, history, { ...turn, agent, use: opts.use, allowedTags: mainTags, delegatedTags });
      // 不 await：主、副请求一起开始，副对话提前完成时也只暂存结果，不执行任何卡片。
      const secondary = withSecondary ? secondaryChat(chat, character, history, { ...turn, allowedTags: delegatedTags }, abort.signal).catch((e) => {
        if (!isAbortError(e) && !abort.signal.aborted) ai.lastErrors.secondary = { at: Date.now(), summary: errorText(e), detail: errorReport(e) };
        return null;
      }) : null;
      // 记下这条回复用了哪些记忆（重新生成时沿用）；重新生成不重复记"想起过"
      noteRecallUsed(id, prompt.recall.lines, !prompt.recall.reused);
      chat.loreState = prompt.loreState;
      chat.vars = prompt.vars;
      lastPrompt[chatId] = { prompt, at: Date.now() };

      const result = await services.llm.chat(
        {
          agent,
          messages: toLLMMessages(prompt),
          body: prompt.request,
          characterId: character.id,
          names: { user: prompt.persona.name, char: character.name },
          signal: abort.signal,
        },
        {
          onState: (s) => {
            const st = streams[chatId];
            if (!st) return;
            if (s === 'streaming') st.thinking = false;
            else if (s === 'sent' || s === 'connected' || s === 'thinking' || s === 'fallback') st.thinking = !raw;
          },
          onThinking: (t) => {
            const st = streams[chatId];
            if (st) st.reasoning = t;
          },
          onText: (full) => {
            raw = full;
            const st = streams[chatId];
            if (st && full) st.thinking = false;
            const msg = find(chatId, id);
            if (!msg) return;
            const parsed = parseControlTags(full, mainTags);
            msg.text = parsed.visible.trimStart();
            msg.parts = [{ type: 'text', text: msg.text }];
            opts.onParsed?.(parsed, false);
            const expr = [...parsed.tags].reverse().find((t) => t.tag.kind === 'expr')?.tag;
            if (expr && 'value' in expr) {
              chars.setExpression(character.id, expr.value);
              msg.expression = chars.expression[character.id] ?? expr.value;
            }
            const pose = [...parsed.tags].reverse().find((t) => t.tag.kind === 'pose')?.tag;
            if (pose && 'value' in pose) chars.setPose(character.id, pose.value);
            opts.onText?.(msg.text);
          },
        },
      );

      abort.signal.throwIfAborted();
      let msg = find(chatId, id);
      if (!msg) return;
      // 写完了：预设里改存下来的消息的正则（同 ST：流式时只改显示，写完才改存下来的）
      raw = storeRegex(chat, character, result.text || raw, 'assistant', { preset: prompt.preset });
      let parsed = parseControlTags(raw, mainTags);
      msg.text = parsed.visible.trim();
      // 主回复先显示完整正文；较慢的副对话只影响末尾追加，不阻塞主回复流式显示。
      msg.parts = [{ type: 'text', text: msg.text }];
      msg.meta.error = undefined;
      msg.meta.errorDetail = undefined;
      msg.meta.interrupted = undefined;
      msg.meta.choices = undefined;
      msg.meta.secondary = undefined;
      if (!result.demo) {
        msg.meta.model = result.model;
        msg.meta.agent = agent;
        msg.meta.latencyMs = result.latencyMs;
        msg.meta.tokens = result.tokens;
        msg.meta.fellBack = result.fellBack || undefined;
      }
      const supplement = await secondary;
      msg = find(chatId, id);
      if (!msg) return;
      let image: SecondaryReply['image'] = null;
      if (supplement && !abort.signal.aborted) {
        image = delegatedTags.includes('cg') ? supplement.value.image : null;
        const extra = parseControlTags(
          storeRegex(chat, character, supplement.value.append, 'assistant', { preset: supplement.preset }),
          // 明确给了 image 对象时由它选择画法，不重复执行 append 中的 [cg:]。
          image ? delegatedTags.filter((tag) => tag !== 'cg') : delegatedTags,
        );
        const separator = extra.visible || extra.tags.length ? '\n\n' : '';
        const offset = parsed.visible.length + separator.length;
        parsed = {
          visible: parsed.visible + separator + extra.visible,
          tags: [...parsed.tags, ...extra.tags.map(({ tag, at }) => ({ tag, at: at + offset }))],
          pending: false,
        };
        const { result: r } = supplement;
        msg.meta.secondary = { model: r.model, tokens: r.usage ? (r.usage.inputTokens ?? 0) + (r.usage.outputTokens ?? 0) : undefined, latencyMs: r.latencyMs, fellBack: r.fellBack };
      }
      msg.text = parsed.visible.trim();
      msg.updatedAt = Date.now();
      opts.onParsed?.(parsed, true);
      opts.onText?.(msg.text);
      const parts: MessagePart[] = [{ type: 'text', text: msg.text }];
      const toySteps: TimedCommand[] = [];
      for (const { tag, at } of parsed.tags) {
        // 歌曲卡片：点"一起听"时按歌名 + 歌手去网易云搜（还没有 id）
        if (tag.kind === 'music') parts.push({ type: 'music', songId: '', title: tag.title, artist: tag.artist });
        if (tag.kind === 'cg' && !opts.sceneArt) parts.push({ type: 'image', assetKey: null, caption: tag.value, generated: false });
        if (tag.kind === 'choice') msg.meta.choices = tag.options;
        // 邀请卡片：点接受去对应的陪伴场景或平行时空
        if (tag.kind === 'study') parts.push({ type: 'invite', kind: 'study', task: tag.task, minutes: tag.minutes });
        if (tag.kind === 'watch') parts.push({ type: 'invite', kind: 'watch', title: tag.title, link: tag.link });
        if (tag.kind === 'game' && allowedInviteGames(boundLoreEntries(character)).includes(tag.game)) parts.push({ type: 'invite', kind: 'game', game: tag.game });
        if (tag.kind === 'sleep' || tag.kind === 'exercise' || tag.kind === 'parallel') parts.push({ type: 'invite', kind: tag.kind });
        // 聊天里的玩具指令（心跳里的由心跳自己按位置执行）：卡片 + 连着时读到那里自动执行
        if (tag.kind === 'device' && scene.id === 'free') {
          const command = parseDeviceBlock(tag.value);
          if (command) {
            parts.push({ type: 'toy', command, text: describeCommand(command) });
            toySteps.push({ pos: at, command });
          }
        }
        if (tag.kind === 'call') {
          // 聊天里先是一张来电卡，30 秒内能接；过了还没接就是能回拨的未接来电
          parts.push({ type: 'call-log', durationSec: 0, missed: true, ringUntil: Date.now() + RING_MS });
          setTimeout(() => {
            useAppStore().showBanner({
              characterId: character.id,
              title: `${character.name} 邀请你语音通话`,
              text: '点这里接听',
              to: `/call/${character.id}?incoming=1`,
              icon: 'i-lucide-phone-incoming',
            });
          }, 900);
        }
      }
      if (image) parts.push({ type: 'image', assetKey: null, caption: image.caption, mode: image.mode, use: image.use, moment: image.moment, requestedModel: image.model, generated: false });
      msg.parts = parts;
      const swipe = { text: msg.text, parts, expression: msg.expression, choices: msg.meta.choices, secondary: msg.meta.secondary, createdAt: Date.now() };
      if (target) {
        msg.swipes = [...(msg.swipes.length ? msg.swipes : []), swipe];
        msg.swipeIndex = msg.swipes.length - 1;
      } else {
        msg.swipes = [swipe];
      }
      // 配图：生图预设写 tags → 生图 API 出图；生图 API 没接通时卡片上写原因
      for (const part of parts) if (part.type === 'image') void drawPart(chatId, id, part.caption);
      const toys = useToyStore();
      if (toySteps.length && toys.live) {
        const timeline = new ReplyTimeline('read', 1000 / toys.settings.readCps, (cmd) => toys.apply(cmd));
        timeline.add(toySteps);
        timeline.setText(parsed.visible, true);
      }
      // 回复完成后在后台取下一轮要带的记忆（本轮你的话 + 她的回复）；攒够了就在后台整理一段（"总结"预设）
      setTimeout(() => {
        void refreshRecall(chatId, id);
        void maybeSummarize(chatId);
      }, 0);
    } catch (e) {
      const msg = find(chatId, id);
      if (msg) {
        if (isAbortError(e) || abort.signal.aborted) msg.meta.interrupted = true;
        else {
          msg.meta.error = errorText(e);
          msg.meta.errorDetail = errorReport(e);
        }
      }
    } finally {
      // 主请求失败、消息被删或用户停止时，连同仍在运行的副请求一起取消。
      abort.abort();
      delete streams[chatId];
    }
    return id;
  }

  /**
   * 一起做事时让她回一句（回纸条、休息时聊天、讲题……）：你说的话和她的回复都存进这条聊天，带上场景和位置。
   * 用「陪伴 · 快速」，提示词是这个场景的功能预设 + 这一次的场景任务。没接通时不出演示台词，告诉界面原因
   */
  async function sceneReply(chatId: string, opts: SceneReplyOptions): Promise<SceneReplyResult> {
    const chat = chatById(chatId);
    if (!chat) return { ok: false, reason: '找不到这条聊天' };
    const said = opts.userText?.trim();
    if (said) push(chatId, 'user', [{ type: 'text', text: said }], { meta: { scene: chat.currentScene ?? undefined, cue: opts.cue } });
    const status = useAiStore().status('companion');
    if (!status.live) return { ok: false, reason: `「陪伴 · 快速」还没接通：${status.reason}`, notConnected: true };
    if (streams[chatId]) return { ok: false, reason: `${characterPronoun(useCharacterStore().byId(chat.characterId))}还在回上一句` };
    const id = await generate(chatId, undefined, {
      agent: 'companion',
      task: { name: opts.task, input: opts.input },
      cue: opts.cue,
      onText: opts.onText,
      allowedTags: opts.allowedTags,
      use: opts.use,
      flags: opts.flags,
      onParsed: opts.onParsed,
      sceneArt: opts.sceneArt,
    });
    const msg = id ? find(chatId, id) : undefined;
    if (!msg) return { ok: false, reason: '没有生成回复' };
    if (msg.meta.error) return { ok: false, reason: msg.meta.error };
    return { ok: true, message: msg };
  }

  /**
   * 一起做事时要她按格式写一批东西（观影时接下来一段的弹幕、看书时接下来几页的批注……）：
   * 同样用这个场景的功能预设 + 场景任务，交给「陪伴 · 快速」，按 JSON 读回来。不推进世界书的粘性 / 冷却。
   * 写出来的东西由场景决定什么时候显示、显示时再存进聊天。
   * tune.use：按哪个用途选预设（真心话大冒险是 game-truthdare）；不给时用这个场景的功能预设。
   * tune.flags：这一次另外打开的预设触发条件（真心话大冒险选的尺度）
   */
  async function sceneJson<T>(
    chatId: string,
    task: { name: string; input: string },
    parse: (value: unknown) => T | null,
    signal?: AbortSignal,
    tune: { use?: PresetUseId; flags?: string[]; agent?: AgentRole } = {},
  ): Promise<{ ok: true; value: T } | { ok: false; reason: string; notConnected?: boolean }> {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (!chat || !character) return { ok: false, reason: '找不到这条聊天' };
    const ai = useAiStore();
    const agent = tune.agent ?? 'companion';
    const status = ai.status(agent);
    if (!status.live) return { ok: false, reason: `「${AGENT_META[agent].label}」还没接通：${status.reason}`, notConnected: true };
    try {
      const prompt = assembleForChat(chat, character, list(chatId), { agent, task, dryRun: true, use: tune.use, flags: tune.flags });
      lastPrompt[chatId] = { prompt, at: Date.now() };
      const req = fromOpenAIBody(prompt.request);
      req.names = { user: prompt.persona.name, char: character.name };
      const { value } = await ai.system.json(agent, req, parse, { signal });
      return { ok: true, value };
    } catch (e) {
      return { ok: false, reason: errorText(e) };
    }
  }

  // —— 取记忆：AI 回复完成后在后台搜，下一轮直接带上（services/recall.ts） ——

  /** 用 afterId 这条回复和它前面你的那条消息搜一次；afterId 不给时用这条聊天最后的一问一答 */
  async function refreshRecall(chatId: string, afterId?: string) {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (!chat || !character) return;
    const msgs = list(chatId);
    const at = afterId ? msgs.findIndex((m) => m.id === afterId) : msgs.length - 1;
    if (at < 0) return;
    const upTo = msgs.slice(0, at + 1).filter((m) => !m.meta.error);
    const reply = [...upTo].reverse().find((m) => m.role === 'assistant');
    const said = [...upTo].reverse().find((m) => m.role === 'user');
    const user = personaOf(chat).name;
    const text = [said, reply].filter((m): m is Message => !!m).map((m) => messageToText(m, character, user).slice(0, 300)).join('\n');
    try {
      await prefetchRecall(chat, character, text, msgs[at]?.id ?? null);
    } catch {
      // 取记忆失败不影响聊天：下一轮沿用上一份结果
    }
  }

  /** 打开聊天时：还没有搜过就在后台搜一次 */
  function ensureRecall(chatId: string) {
    if (!latestRecall(chatId)) void refreshRecall(chatId);
  }

  // —— 总结：攒够（消息设置里的）x 条定稿的消息就在后台整理一段（"总结 / 记忆"接通了 API 时） ——
  const summarizing = reactive<Record<string, boolean>>({});
  /** 自动整理失败后，这条聊天 10 分钟内不再自动试（完整报错在 API 设置 → 总结 / 记忆） */
  const summaryBackoff = new Map<string, number>();

  async function maybeSummarize(chatId: string) {
    const chat = chatById(chatId);
    // 一起做事的过程中不整理，结束（leaveScene）以后再整理
    if (!chat || chat.currentScene || summarizing[chatId] || streams[chatId] || !useAiStore().isLive('summary')) return;
    if ((summaryBackoff.get(chatId) ?? 0) > Date.now()) return;
    // 上次整理到的那条不在内存里（没整理的太多，或者从没整理过的长聊天）：自动整理会跳过中间那段，交给"补整理"
    const p = chat.summaryUntilMessageId;
    if (earlierInDb[chatId] && !(p && list(chatId).some((m) => m.id === p))) return;
    if (pendingForSummary(chat, list(chatId)).length < useMessageSettingsStore().summaryEvery()) return;
    summarizing[chatId] = true;
    try {
      await summarizeChat(chat, list(chatId));
      summaryBackoff.delete(chatId);
    } catch (e) {
      if (!isAbortError(e)) summaryBackoff.set(chatId, Date.now() + 10 * 60_000);
    } finally {
      delete summarizing[chatId];
    }
  }

  /** 手动整理（聊天 ⋯ → 整理这段聊天）：结果或报错交给界面显示 */
  async function summarizeNow(chatId: string): Promise<SummaryOutcome | null> {
    const chat = chatById(chatId);
    if (!chat) return null;
    if (summarizing[chatId]) return summarizeChat(chat, list(chatId));
    summarizing[chatId] = true;
    try {
      await loadSinceSummary(chatId);
      const r = await summarizeChat(chat, list(chatId));
      summaryBackoff.delete(chatId);
      return r;
    } finally {
      delete summarizing[chatId];
    }
  }

  /** 补整理（我的 → 补整理聊天）进行中的进度。只放内存；离开页面也接着整理 */
  const backfills = reactive<Record<string, BackfillProgress>>({});
  const backfillAborts = new Map<string, AbortController>();

  /**
   * 补整理一条长聊天：一批一批整理到剩下的不够一批。期间算作"正在整理"，自动整理不会同时整理同一批。
   * 暂停时返回 paused；下次从停下的地方接着来
   */
  async function backfill(chatId: string): Promise<(BackfillProgress & { paused: boolean }) | null> {
    const chat = chatById(chatId);
    if (!chat || summarizing[chatId]) return null;
    const abort = new AbortController();
    backfillAborts.set(chatId, abort);
    summarizing[chatId] = true;
    await loadSinceSummary(chatId).catch(() => undefined);
    backfills[chatId] = { done: 0, remaining: pendingForSummary(chat, list(chatId)).length };
    try {
      const r = await backfillChat(chat, () => list(chatId), (p) => Object.assign(backfills[chatId] ?? {}, p), abort.signal);
      summaryBackoff.delete(chatId);
      return { ...r, paused: abort.signal.aborted };
    } catch (e) {
      if (isAbortError(e) && backfills[chatId]) return { ...backfills[chatId], paused: true };
      throw e;
    } finally {
      backfillAborts.delete(chatId);
      delete backfills[chatId];
      delete summarizing[chatId];
    }
  }

  function pauseBackfill(chatId: string) {
    backfillAborts.get(chatId)?.abort();
  }

  /** 最近几句对话（给生图提示词智能体、番外智能体看） */
  function recentLines(chatId: string, n = 6): string[] {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    const user = personaOf(chat).name;
    return list(chatId)
      .filter((m) => m.text && (m.role === 'user' || m.role === 'assistant'))
      .slice(-n)
      .map((m) => `${m.role === 'user' ? user : (character?.name ?? 'Ta')}: ${m.text}`);
  }

  /**
   * 给一条消息里的配图出图：生图预设写 tags（生图提示词）→ 生图 API 出图 → 存进本机素材库。
   * 生图 API 没接通时卡片上直接写原因，不拿占位画冒充"画好了"。
   * await 之后按 id 重新取消息和卡片（设计文档 §3.1 的教训：生成期间对象可能被替换）
   */
  async function drawPart(chatId: string, messageId: string, caption: string) {
    const chat = chatById(chatId);
    const chars = useCharacterStore();
    const character = chars.byId(chat?.characterId);
    const swipeIndex = find(chatId, messageId)?.swipeIndex ?? 0;
    const findPart = () => {
      const msg = find(chatId, messageId);
      // 画图期间切换或重新生成回复：结果仍写回发起它的那个备选回复。
      const parts = msg?.swipes[swipeIndex]?.parts ?? (msg?.swipeIndex === swipeIndex ? msg.parts : undefined);
      const p = parts?.find((x) => x.type === 'image' && x.caption === caption);
      return p?.type === 'image' ? p : undefined;
    };
    const updatePart = (patch: Partial<Extract<MessagePart, { type: 'image' }>>) => {
      const part = findPart();
      if (part) Object.assign(part, patch);
      const msg = find(chatId, messageId);
      // 从本机库或同步恢复后，正文和 swipe 中的 parts 是两份对象，一起更新。
      if (msg?.swipeIndex === swipeIndex) {
        const visible = msg.parts.find((p) => p.type === 'image' && p.caption === caption);
        if (visible) Object.assign(visible, patch);
      }
    };
    if (!chat || !character) return;
    const before = findPart();
    if (!before) return;
    if (!services.image.live) {
      const s = useAiStore().status('image');
      updatePart({
        generated: false,
        error: '生图 API 还没接通',
        errorDetail: `${s.live ? '' : `${s.reason}\n\n`}在"我的 → API 设置 → 生图"里选渠道（NovelAI、硅基流动或自定义）、填地址和 Key，测试连接通过后，点这张图重新生成。`,
      });
      return;
    }
    // 重画时旧图先留着（画失败了也还在），画好了再换
    updatePart({ generated: false, error: undefined, errorDetail: undefined });
    try {
      const out = await services.image.illustrate({
        characterId: character.id,
        caption,
        mode: before.mode,
        use: before.use ?? 'image',
        moment: before.moment,
        model: before.requestedModel,
        // 一起做事时按这件事该穿的那套告诉模型（运动服、睡衣……），平时按日常的；画面要换装时模型自己写
        sceneId: chat.currentScene,
        place: getLocation(chat.togetherAt ?? character.locationId)?.name,
        expression: chars.expression[character.id],
        recent: recentLines(chatId),
      });
      updatePart({
        assetKey: out.assetKey ?? out.url ?? null,
        title: out.caption && out.caption !== caption ? out.caption : undefined,
        prompt: out.prompt,
        negative: out.negative,
        seed: out.seed ?? undefined,
        model: out.model,
        generated: true,
        error: undefined,
        errorDetail: undefined,
      });
    } catch (e) {
      updatePart({ error: errorText(e), errorDetail: errorReport(e) });
    }
  }

  /**
   * "生成配图"：不经过对话模型，直接按"生图"预设写 tags、调生图 API。
   * 画好的图作为她发来的一张图放进聊天（发给模型的聊天记录里是"[图片：标题]"）。
   * caption 不写时按这次画什么、她在哪、最近的聊天画。
   */
  function drawImage(chatId: string, req: { mode: ImageMode; caption: string }) {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (!chat || !character) return;
    const place = getLocation(chat.togetherAt ?? character.locationId)?.name;
    const auto: Record<ImageMode, string> = {
      scene: '按最近的聊天，画此刻的画面',
      portrait: `${character.name}此刻的全身像`,
      face: `${character.name}此刻的脸部特写`,
      background: place ? `${place}，${character.name}此刻所在的地方` : `${character.name}此刻所在的地方`,
    };
    const caption = req.caption.trim() || auto[req.mode];
    const msg = push(chatId, 'assistant', [{ type: 'image', assetKey: null, caption, mode: req.mode, generated: false }]);
    msg.meta.agent = 'image';
    void drawPart(chatId, msg.id, caption);
  }

  /** 重画一张配图（失败后、或者想换一张） */
  function redraw(chatId: string, part: MessagePart) {
    if (part.type !== 'image') return;
    const msg = list(chatId).find((m) => m.parts.includes(part));
    if (msg) void drawPart(chatId, msg.id, part.caption);
  }

  /** 你写的话先过预设里改存下来的消息的正则（作用在"你发的消息"上的） */
  function regexUserText(chatId: string, text: string): string {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    return chat && character ? storeRegex(chat, character, text, 'user').trim() : text;
  }

  async function send(chatId: string, text: string) {
    const t = text.trim();
    if (!t) return;
    const last = list(chatId).at(-1);
    if (last?.meta.choices) last.meta.choices = undefined;
    // 正则把整句都删了：不留空消息，她照常回
    const said = regexUserText(chatId, t);
    if (said) push(chatId, 'user', [{ type: 'text', text: said }]);
    await generate(chatId);
  }

  function stop(chatId: string) {
    streams[chatId]?.abort.abort();
  }

  // —— 发照片（＋ → 相册 / 拍照）——
  /** 每条聊天里识图正在看的照片张数；正在看的照片（按素材 key） */
  const looking = reactive<Record<string, number>>({});
  const lookingKeys = reactive(new Set<string>());

  /**
   * 识图看这条消息里还没看过的照片，写下看到了什么（提示词里用它代替照片）。
   * 识图没接通时照片照样留着，卡片上写原因；返回没接通的原因
   */
  async function lookAt(chatId: string, messageId: string, retry = false): Promise<{ notConnected?: string }> {
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    const pending = (find(chatId, messageId)?.parts ?? []).filter(
      (p): p is Extract<MessagePart, { type: 'image' }> => p.type === 'image' && !!p.photo && !!p.assetKey && !p.seen && (retry || !p.seenError),
    );
    if (!pending.length) return {};
    const st = useAiStore().status('vision');
    if (!st.live) {
      for (const p of pending) p.seenError = `识图还没接通：${st.reason}`;
      return { notConnected: st.reason };
    }
    looking[chatId] = (looking[chatId] ?? 0) + pending.length;
    const keys = pending.map((p) => p.assetKey as string);
    for (const k of keys) lookingKeys.add(k);
    await Promise.all(
      keys.map(async (key) => {
        // await 之后按 key 重新取卡片（这期间消息可能被换成了新对象）
        const part = () => find(chatId, messageId)?.parts.find((x): x is Extract<MessagePart, { type: 'image' }> => x.type === 'image' && x.assetKey === key);
        try {
          const r = await describePhoto(key, character);
          const p = part();
          if (p) Object.assign(p, { seen: r.text, seenModel: r.model, seenError: undefined });
        } catch (e) {
          const p = part();
          if (p) p.seenError = errorText(e);
        } finally {
          looking[chatId] = Math.max(0, (looking[chatId] ?? 1) - 1);
          lookingKeys.delete(key);
        }
      }),
    );
    return {};
  }

  /**
   * 发照片给她：压缩好的照片存进本机素材库 → 发一条你的消息（照片 + 你写的话）→ 识图看一遍 → 她回一条。
   * 识图没接通时也发，她知道你发了照片、但看不到内容（不编）
   */
  async function sendPhotos(chatId: string, photos: { bytes: Uint8Array<ArrayBuffer>; mime: string }[], text?: string): Promise<{ notConnected?: string }> {
    if (!photos.length) return {};
    const keys = await Promise.all(photos.map((p) => putAsset(p.bytes, p.mime)));
    const parts: MessagePart[] = keys.map((assetKey) => ({ type: 'image', assetKey, caption: '', generated: true, photo: true }));
    const said = text?.trim() ? regexUserText(chatId, text.trim()) : '';
    if (said) parts.push({ type: 'text', text: said });
    const last = list(chatId).at(-1);
    if (last?.meta.choices) last.meta.choices = undefined;
    const msg = push(chatId, 'user', parts);
    const r = await lookAt(chatId, msg.id);
    void generate(chatId);
    return r;
  }

  function swipe(chatId: string, messageId: string, dir: 1 | -1) {
    const msg = find(chatId, messageId);
    if (!msg || msg.swipes.length < 2) return;
    sourceChanged(chatId, [messageId]);
    msg.swipeIndex = (msg.swipeIndex + dir + msg.swipes.length) % msg.swipes.length;
    const s = msg.swipes[msg.swipeIndex];
    if (!s) return;
    msg.text = s.text;
    msg.updatedAt = Date.now();
    msg.parts = s.parts ?? [{ type: 'text', text: s.text }];
    msg.meta.choices = s.choices;
    msg.meta.secondary = s.secondary;
    if (s.expression) msg.expression = s.expression;
  }

  /**
   * 改一条消息的文字（你的、她的都能改），卡片（图片、歌曲……）不动。
   * 她的回复同时改当前这个备选回复：左右切换再回来还是改过的
   */
  function editMessage(chatId: string, id: string, text: string) {
    const msg = find(chatId, id);
    if (!msg) return;
    sourceChanged(chatId, [id]);
    let t = text.replace(/\r/g, '').trim();
    // 预设里勾了"改消息时也执行"的正则（同 ST 的 runOnEdit）
    const chat = chatById(chatId);
    const character = useCharacterStore().byId(chat?.characterId);
    if (chat && character && (msg.role === 'user' || msg.role === 'assistant')) t = storeRegex(chat, character, t, msg.role, { edit: true }).trim();
    const cards = msg.parts.filter((p) => p.type !== 'text');
    if (!t && !cards.length) return;
    const parts: MessagePart[] = t ? [{ type: 'text', text: t }, ...cards] : cards;
    Object.assign(msg, { text: t, parts, updatedAt: Date.now() });
    const current = msg.swipes[msg.swipeIndex];
    if (current) Object.assign(current, { text: t, parts });
    // 改过就是你认可的内容了，"被打断""回复失败"的提示不再显示
    Object.assign(msg.meta, { interrupted: undefined, error: undefined, errorDetail: undefined });
  }

  /**
   * 通话里你开口打断了她：她这条只留下已经说出口的部分（设计文档 §11.2"保留已说的部分"）。
   * 这是正常的对话，不算"回复被打断"；一句都没说出口就把这条删掉
   */
  function keepSpoken(chatId: string, id: string, spoken: string) {
    const msg = find(chatId, id);
    if (!msg) return;
    const t = spoken.trim();
    if (!t) {
      const msgs = messages.value[chatId];
      if (msgs) messages.value[chatId] = msgs.filter((m) => m.id !== id);
      return;
    }
    // 其实已经说完了（打断在最后一句上）：原样留着
    const plain = (s: string) => s.replace(/[\s\p{P}]/gu, '');
    if (plain(t) === plain(msg.text) && !msg.meta.interrupted) return;
    const text = /[。！？!?…~～]$/.test(t) ? `${t}——` : `${t}……`;
    const parts: MessagePart[] = [{ type: 'text', text }];
    Object.assign(msg, { text, parts, updatedAt: Date.now(), swipes: [{ text, parts, expression: msg.expression, createdAt: Date.now() }], swipeIndex: 0 });
    Object.assign(msg.meta, { interrupted: undefined, error: undefined, errorDetail: undefined });
  }

  /** 删一条消息；正在生成的那条不删 */
  function deleteMessage(chatId: string, id: string) {
    if (streams[chatId]?.messageId === id) return;
    const msgs = messages.value[chatId];
    if (!msgs) return;
    sourceChanged(chatId, [id]);
    // 删的正好是总结覆盖到的那条：往前挪一条，"已总结"的分界不丢
    const chat = chatById(chatId);
    if (chat?.summaryUntilMessageId === id) {
      const at = msgs.findIndex((m) => m.id === id);
      chat.summaryUntilMessageId = at > 0 ? (msgs[at - 1]?.id ?? null) : null;
    }
    messages.value[chatId] = msgs.filter((m) => m.id !== id);
  }

  /** 已经总结过的消息被改或删了：相关片段要重新生成，相关记忆标"来源改过"（记忆本里提示复核） */
  function sourceChanged(chatId: string, ids: string[]) {
    const chat = chatById(chatId);
    if (!chat?.summaryUntilMessageId) return;
    const msgs = list(chatId);
    const until = msgs.findIndex((m) => m.id === chat.summaryUntilMessageId);
    const covered = ids.filter((id) => {
      const i = msgs.findIndex((m) => m.id === id);
      return i >= 0 && i <= until;
    });
    if (covered.length) useMemoryStore().markSourceChanged(chatId, covered, msgs);
  }

  async function regenerate(chatId: string, messageId: string) {
    const msg = find(chatId, messageId);
    if (!msg) return;
    // 失败时这条可能是空的：空的不当成一个备选回复
    if (!msg.swipes.length && msg.text) msg.swipes = [{ text: msg.text, parts: msg.parts, expression: msg.expression, createdAt: msg.createdAt }];
    await generate(chatId, messageId);
  }

  /** 戳一戳：先在聊天里留一条"你拍了拍她的头"，需要时再让她回应 */
  async function poke(chatId: string, target: string, withReply = true) {
    push(chatId, 'user', [{ type: 'poke', actor: 'user', target }]);
    if (withReply) await generate(chatId);
  }

  /** 一起出门前她在哪、在做什么：去了又什么都没发生时还原。只放内存 */
  const beforeVisit = new Map<string, { locationId: string | null; status: string }>();
  /** 场景结束时那一段的总结怎么写（共同的家："做完 3 件家务"、健身："练了 30 分钟"）：场景开着时登记，离开时取一次 */
  const leaveNotes = new Map<string, () => string | undefined>();
  function setLeaveSummary(characterId: string, fn: (() => string | undefined) | null) {
    if (fn) leaveNotes.set(characterId, fn);
    else leaveNotes.delete(characterId);
  }

  /** 没指定怎么在一起时：约会、戳戳乐默认去她那儿，其余默认连线 */
  // 出逃：你们一起在那个很远的地方（"和她来到海边 · 出逃"），不是连线
  const DEFAULT_MODE: Record<string, TogetherMode> = { date: 'visit', poke: 'visit', escape: 'visit' };

  /** 你此刻在真实世界的哪儿（连线时记下来，成为"我们的足迹"） */
  function yourPlace() {
    const real = useRealWorldStore();
    return getLocation(real.hereId) ?? real.home;
  }
  /** 记进足迹的地点：在外面（不在家、也不在附近认得的地方）时不记 */
  function footprintId() {
    const id = yourPlace().id;
    return id === 'real:out' ? undefined : id;
  }

  function enterTitle(mode: TogetherMode, characterName: string, pronoun: string, locName: string, activity: string, locationId?: string) {
    if (mode === 'remote') return { title: `和${characterName}连线 · ${activity}`, summary: `你在${yourPlace().name}，${pronoun}在${locName}` };
    // 你的家（共同的家、在家吃饭……）：她"回家"，不是"带她去家"
    if (mode === 'bring' && locationId === 'real:home') return { title: `和${characterName}在家 · ${activity}` };
    if (mode === 'bring') return { title: `带${characterName}去${locName} · ${activity}` };
    return { title: `和${characterName}来到${locName} · ${activity}` };
  }

  /**
   * 和她一起做某件事：在聊天里插一条开始的分隔，记下她那边在哪、怎么在一起。
   * - 连线（默认）：你在你那儿，她去她世界里做这件事的地方，各做各的、一起做；
   * - 去她那：地点在她的世界，你"坐到她旁边"；
   * - 带她来：地点在你的真实世界，她暂时"来你这边"，离开后回到自己的世界。
   */
  function enterScene(characterId: string, locationId: string, sceneId: string, mode?: TogetherMode) {
    const chat = chatOfCharacter(characterId);
    const character = useCharacterStore().byId(characterId);
    if (!chat || !character) return;
    const loc = getLocation(locationId);
    const how: TogetherMode = isRealPlace(loc) ? 'bring' : (mode ?? DEFAULT_MODE[sceneId] ?? 'remote');
    if (chat.togetherAt === locationId && chat.currentScene === sceneId) {
      if (chat.togetherMode !== how) setTogetherMode(characterId, how);
      return;
    }
    if (chat.togetherAt) leaveScene(characterId);
    const activity = loc?.activities.find((a) => a.sceneId === sceneId)?.label ?? getScene(sceneId).name;
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    // 刚结束同一件事又回来（结束时没留下总结）：把"结束"撤掉，当作没断过
    if (last && lastPart?.type === 'scene' && lastPart.event === 'leave' && lastPart.locationId === locationId && !lastPart.summary && last.parts.length === 1) {
      messages.value[chat.id]?.pop();
    } else {
      const youAt = how === 'bring' ? locationId : how === 'remote' ? footprintId() : undefined;
      push(chat.id, 'narrator', [
        { type: 'scene', event: 'enter', sceneId, locationId, mode: how, youAt, ...enterTitle(how, character.name, character.pronoun, loc?.name ?? '', activity, locationId) },
      ]);
    }
    if (!beforeVisit.has(characterId)) beforeVisit.set(characterId, { locationId: character.locationId, status: character.status });
    chat.togetherAt = locationId;
    chat.togetherMode = how;
    chat.currentScene = sceneId;
    character.locationId = locationId;
    // 家里的活动带房间名（卧室 · 哄睡），状态只要后半截
    character.status = activity.split(' · ').at(-1) ?? activity;
  }

  /** 连线 ⇄ 去她那（同一件事里切换）：刚开始还没聊什么时，顺手改掉开始那条分隔 */
  function setTogetherMode(characterId: string, mode: TogetherMode) {
    const chat = chatOfCharacter(characterId);
    const character = useCharacterStore().byId(characterId);
    if (!chat?.togetherAt || !character || chat.togetherMode === 'bring' || mode === 'bring') return;
    chat.togetherMode = mode;
    const last = list(chat.id).at(-1);
    const part = last?.parts[0];
    if (last && part?.type === 'scene' && part.event === 'enter' && last.parts.length === 1) {
      const loc = getLocation(chat.togetherAt);
      const activity = loc?.activities.find((a) => a.sceneId === part.sceneId)?.label ?? getScene(part.sceneId).name;
      const { title, summary } = enterTitle(mode, character.name, character.pronoun, loc?.name ?? '', activity) as { title: string; summary?: string };
      Object.assign(part, { mode, title, summary, youAt: mode === 'remote' ? footprintId() : undefined });
    }
  }

  /**
   * 结束这件事（离开场景页时，或者场景自己做完时带上总结）。如果开始之后什么都没发生，就把开始那条也撤掉，她也回到原来的地方，不留痕迹。
   * 带她出门的，她总是回到自己的世界（回到出门前的地方）；连线的，她回到连线前的样子（有作息的之后照作息走）；去她那的，她留在原地。
   */
  function leaveScene(characterId: string, summary?: string) {
    const chat = chatOfCharacter(characterId);
    if (!chat?.togetherAt) return;
    // 不一起听了：歌停下，聊天里记一下听了哪几首
    if (chat.currentScene === 'music') {
      summary ??= musicSummary();
      stopMusic();
    }
    // 场景自己登记的总结（共同的家做完了几件家务、健身练了多久）
    const note = leaveNotes.get(characterId);
    leaveNotes.delete(characterId);
    if (note) summary ??= note();
    const character = useCharacterStore().byId(characterId);
    // 开始前她在哪、在做什么只记在内存里：上次没结束就关了 App 时不知道，当作哪儿都不在（有作息的会照作息放回去）
    const before = beforeVisit.get(characterId) ?? { locationId: null, status: '' };
    beforeVisit.delete(characterId);
    const how = chat.togetherMode ?? 'visit';
    const loc = getLocation(chat.togetherAt);
    const last = list(chat.id).at(-1);
    const lastPart = last?.parts[0];
    if (last && lastPart?.type === 'scene' && lastPart.event === 'enter' && last.parts.length === 1 && !summary) {
      messages.value[chat.id]?.pop();
      if (character) Object.assign(character, before);
    } else {
      const youAt = lastEnterYouAt(chat.id);
      push(chat.id, 'narrator', [
        {
          type: 'scene',
          event: 'leave',
          sceneId: chat.currentScene ?? 'free',
          locationId: chat.togetherAt,
          title: how === 'remote' ? '结束连线' : `离开${loc?.name ?? ''}`,
          summary,
          mode: how,
          youAt,
        },
      ]);
      // 出逃的去处不在她的世界里：回来以后回到原来的地方
      if (character && chat.currentScene === 'escape') Object.assign(character, { locationId: before.locationId, status: '刚和你从远方回来' });
      else if (character && how === 'bring') Object.assign(character, { locationId: before.locationId, status: '刚从你那边回来' });
      else if (character && how === 'visit') character.status = '刚和你分开';
      else if (character) Object.assign(character, before);
    }
    chat.togetherAt = null;
    chat.togetherMode = null;
    chat.currentScene = null;
    // 活动进行中攒下的消息，结束以后再整理
    setTimeout(() => void maybeSummarize(chat.id), 0);
  }

  /**
   * 打开 App 时：场景只在场景页开着时才有，还记着场景的，是上次在场景页里直接关掉了 App（没走到"离开"），那件事算结束了。
   * 角色也读出来以后再调，她才能回到原来的样子
   */
  function endLeftoverScenes() {
    for (const c of chats.value) if (c.togetherAt) leaveScene(c.characterId);
  }

  function lastEnterYouAt(chatId: string): string | undefined {
    for (const m of [...list(chatId)].reverse()) {
      const p = m.parts[0];
      if (p?.type === 'scene' && p.event === 'enter') return p.youAt;
    }
    return undefined;
  }

  /**
   * 我们的足迹：你在真实世界里和她们一起待过的地方（连线时你在哪、带她去过哪）。
   * 按地点汇总，最近的在前。
   */
  const footprints = computed(() => {
    const byPlace = new Map<string, { placeId: string; characterIds: string[]; last: number; titles: string[] }>();
    for (const c of chats.value) {
      for (const m of list(c.id)) {
        const p = m.parts[0];
        if (p?.type !== 'scene' || p.event !== 'enter' || !p.youAt) continue;
        const f = byPlace.get(p.youAt) ?? { placeId: p.youAt, characterIds: [], last: 0, titles: [] };
        if (!f.characterIds.includes(c.characterId)) f.characterIds.push(c.characterId);
        f.last = Math.max(f.last, m.createdAt);
        f.titles.push(p.title);
        byPlace.set(p.youAt, f);
      }
    }
    return [...byPlace.values()].sort((a, b) => b.last - a.last);
  });

  /** 场景结束时把记录卡片发进聊天（运动、饭照、学习、约会回忆……） */
  function postCard(chatId: string, role: MessageRole, part: MessagePart, text?: string) {
    const parts: MessagePart[] = text ? [{ type: 'text', text }, part] : [part];
    return push(chatId, role, parts);
  }

  /** 你接了她打来的电话（卡片、横幅）：还在响的来电卡记成已接，通话的结果由通话页另记一张 */
  function answerRinging(chatId: string) {
    const now = Date.now();
    for (const m of list(chatId)) for (const p of m.parts) if (p.type === 'call-log' && !p.answered && (p.ringUntil ?? 0) > now) p.answered = true;
  }

  return {
    chats,
    messages,
    earlierInDb,
    loadEarlier,
    trimWindow,
    streams,
    lastPrompt,
    hydrate,
    startChat,
    importHistory,
    removeChat,
    sortedChats,
    totalUnread,
    chatById,
    chatOfCharacter,
    list,
    unread,
    markRead,
    push,
    send,
    stop,
    generate,
    sceneReply,
    sceneJson,
    swipe,
    regenerate,
    editMessage,
    keepSpoken,
    deleteMessage,
    redraw,
    drawImage,
    recentLines,
    summarizing,
    summarizeNow,
    backfills,
    backfill,
    pauseBackfill,
    refreshRecall,
    ensureRecall,
    poke,
    postCard,
    answerRinging,
    enterScene,
    setLeaveSummary,
    leaveScene,
    endLeftoverScenes,
    looking,
    lookingKeys,
    lookAt,
    sendPhotos,
    setTogetherMode,
    footprints,
  };
});
