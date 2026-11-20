import { AgentSystem, fromOpenAIBody } from '@app/ai';
import {
  anniversaryLine, applyRegexScripts, assemblePrompt, buildChatRequest, estimateTokens, formatEnvironmentBlock, FREE_SCENE, textFn,
  parseControlTags, proactiveMessageText, substituteMacros,
  type Message, type MessagePart, type ProactiveContext, type ProactiveCredentials, type Touchpoint,
} from '@app/shared';

export function proactivePrompt(context: ProactiveContext, t: Touchpoint, now: number, model: string) {
  const { character: c, chat, persona, preset, history } = context;
  if (!preset) throw new Error('没有主动消息预设，请在 App 的预设页选择后同步');
  const date = new Date(now);
  const timeZone = context.environment.timezone;
  const macros = { char: c.name, pronoun: c.pronoun, user: persona.name, now: date, timeZone };
  const hint = substituteMacros(t.hint, macros);
  const time = substituteMacros('{{isodate}} {{time}}', macros);
  // 说明文字都在预设的程序文字里（手机上传时合好了自带预设文件里的）
  const tx = textFn(preset.texts);
  const quiet = tx('proactive.quiet', { time, timeZone, user: persona.name, char: c.name, hint });
  // 预设里"只改发给 AI 的"正则按深度改（0 = 最后一条），同 App 里发消息时
  const live = history.filter((m) => !m.deleted).map((m) => ({ m, text: proactiveMessageText(m, tx) })).filter((x) => x.text);
  const result = assemblePrompt({
    character: c, preset, user: persona, lorebooks: context.lorebooks,
    history: live.map(({ m, text }, i) => {
      const placement = m.role === 'user' ? 'user_input' : m.role === 'assistant' ? 'ai_output' : null;
      return {
        role: m.role === 'user' || m.role === 'assistant' ? m.role : 'system',
        name: m.role === 'user' ? persona.name : m.role === 'assistant' ? c.name : '',
        content: placement ? applyRegexScripts(preset.regex, text, { target: 'prompt', placement, depth: live.length - 1 - i, char: c.name, user: persona.name }) : text,
      };
    }),
    app: {
      // 手机拼好的两块（画像卡 + 时间线；每次都带的 + 最重要的 30 条）；旧版 App 上传的没有这两块时退回原来的写法
      summary: context.memoryBlocks
        ? { content: context.memoryBlocks.summary, source: '画像卡和时间线' }
        : { content: (chat.summaries ?? []).slice(-6).map((s) => s.text).join('\n'), source: '聊天摘要' },
      memory: context.memoryBlocks
        ? { content: context.memoryBlocks.memory, source: '记忆和关系' }
        : { content: tx('hub.memoryFallback', { memories: context.memories.map((m) => tx('memory.line', { content: m.content, due: null })), relationship: JSON.stringify(c.relationship) }), source: '记忆和关系' },
      environment: { content: formatEnvironmentBlock({ now: date, timeZone, anniversaries: anniversaryLine(c.relationship.anniversaries, now, timeZone, tx) }, tx), source: `云端当前时间（${timeZone}）/ 纪念日` },
      proactive: { content: quiet, source: '本次主动消息' },
      // 你开了家务、健康系统时，手机上传那一刻今天的情况
      ...(context.memoryBlocks?.home ? { home: { content: context.memoryBlocks.home, source: '家务和健康（手机同步）' } } : {}),
    },
    // 调度器会合入手机上次同步以后产生的云端消息；它们也计入世界书计时。
    chatLength: context.chatLength === undefined ? undefined
      : context.chatLength + live.filter(({ m }) => m.createdAt > chat.lastMessageAt).length,
    type: 'quiet', now: date, timeZone, vars: chat.vars, loreState: chat.loreState, dryRun: true, model, flags: context.flags,
  });
  return fromOpenAIBody(buildChatRequest(result, preset, model));
}

export async function generateMessage(context: ProactiveContext, credentials: ProactiveCredentials, t: Touchpoint, now: number): Promise<Message> {
  const { character: c, chat } = context;
  let text = `${c.name}邀请你语音通话`;
  let parts: MessagePart[] = [{ type: 'call-log', durationSec: 0, missed: true }];
  let expression: string | null = null;
  let meta: Message['meta'] = { agent: 'proactive' };
  if (t.action !== 'call') {
    // The scheduler reserves the shared daily budget atomically in D1 before calling this.
    const system = new AgentSystem({ config: {
      routes: () => credentials.routes.map((r) => ({ ...r, dailyTokenBudget: 0 })),
      keyOf: (id) => credentials.keys[id] || null, textObfuscation: () => credentials.textObfuscation,
    }, outputFilters: credentials.outputFilters });
    const attempt = system.router.attempts('proactive')[0]!;
    const request = proactivePrompt(context, t, now, attempt.endpoint.model);
    request.names = { user: context.persona.name, char: c.name };
    const r = await system.chat('proactive', request, { stream: false, signal: AbortSignal.timeout(120_000) });
    // 预设里改存下来的消息的正则（作用在"她的回复"上的），同 App 里的回复
    const reply = applyRegexScripts(context.preset?.regex, r.text, { target: 'store', placement: 'ai_output', char: c.name, user: context.persona.name });
    const parsed = parseControlTags(reply, FREE_SCENE.allowedTags.filter((k) => ['expr', 'music'].includes(k)));
    text = parsed.visible.trim();
    parts = text ? [{ type: 'text', text }] : [];
    for (const { tag } of parsed.tags) {
      if (tag.kind === 'expr') expression = tag.value;
      if (tag.kind === 'music') parts.push({ type: 'music', songId: '', title: tag.title, artist: tag.artist });
    }
    if (!parts.length) throw new Error('主动消息模型返回了空内容');
    meta = { agent: 'proactive', model: r.model, latencyMs: r.latencyMs, fellBack: r.fellBack,
      tokens: (r.usage?.inputTokens ?? estimateTokens(JSON.stringify(request.messages))) + (r.usage?.outputTokens ?? estimateTokens(r.text)) };
  }
  return { id: `proactive:${t.id}`, chatId: chat.id, role: 'assistant', createdAt: now, updatedAt: now,
    text, parts, expression, swipes: [], swipeIndex: 0, proactive: true, read: false, meta };
}
