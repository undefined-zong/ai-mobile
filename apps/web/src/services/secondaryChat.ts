import { fromOpenAIBody, imageUseMoments, parseSecondaryReply } from '@app/ai';
import { allowedInviteGames, cardFlags, getScene, IMAGE_MODES, PRESET_USES, type Character, type Chat, type Message } from '@app/shared';
import { assembleForChat, boundLoreEntries, type ChatAssembleOptions } from './prompt';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';

/**
 * 和主回复使用同一份历史及时间，只读世界书状态；不再次推进冷却、变量或记忆使用次数。
 * 输出是要追加的正文和隐藏标签（不是 JSON）：主动卡片的写法在副对话预设自己的块里，
 * 这一轮能用的模块按她绑定的世界书开关打开对应的块（cardFlags），预设不用开世界书。
 */
export async function secondaryChat(chat: Chat, character: Character, history: Message[], opts: ChatAssembleOptions, signal: AbortSignal) {
  const ai = useAiStore();
  const lib = useLibraryStore();
  const tags = opts.allowedTags ?? [];
  const api = ai.effectiveRoute('image').api;
  const imageLive = ai.isLive('image');
  const models = [...new Set([api?.model, ...(api?.models ?? [])].filter((m): m is string => !!m))];
  const lines = [`场景：${getScene(chat.currentScene ?? 'free').name}`];
  if (opts.task) lines.push(`主对话这一轮在做的事：${opts.task.name}\n${opts.task.input}`);
  lines.push(`本轮可用标签：${tags.join('、') || '没有'}`);
  if (tags.includes('cg')) {
    if (!imageLive) lines.push('生图：没接通，这一轮不写 [cg:]');
    else {
      const uses = PRESET_USES.filter((u) => u.category === 'image').map((u) => {
        const preset = lib.presetForUse(u.id, character)?.name;
        const moments = imageUseMoments(u.id);
        return `- ${u.id}（${u.label}${preset ? `，预设「${preset}」` : ''}）${moments ? `；moment 可选：${Object.entries(moments).map(([id, label]) => `${id}（${label}）`).join('、')}` : ''}`;
      });
      lines.push(
        '生图：已接通',
        `mode 可选：${Object.entries(IMAGE_MODES).map(([id, label]) => `${id}（${label}）`).join('、')}`,
        `use 可选：\n${uses.join('\n')}`,
        models.length ? `model 可选：${models.join('、')}${api?.model ? `；不写用 ${api.model}` : ''}` : '',
      );
    }
  }
  const prompt = assembleForChat(chat, character, history, {
    ...opts,
    agent: 'secondary',
    use: 'secondary',
    dryRun: true,
    flags: [...(opts.flags ?? []), ...cardFlags(tags, allowedInviteGames(boundLoreEntries(character)))],
    task: { name: 'secondary', input: lines.filter(Boolean).join('\n') },
  });
  const request = fromOpenAIBody(prompt.request);
  request.names = { user: prompt.persona.name, char: character.name };
  // 这一轮不追加时模型什么都不写：空回复是正常结果，不算失败
  const result = await ai.system.chat('secondary', request, { signal, allowEmpty: true });
  return { value: parseSecondaryReply(result.text, imageLive ? models : []), result, preset: prompt.preset };
}
