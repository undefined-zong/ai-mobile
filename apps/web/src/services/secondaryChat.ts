import { fromOpenAIBody, imageUseMoments, parseSecondaryReply } from '@app/ai';
import { allowedInviteGames, cardFlags, getScene, IMAGE_MODES, PRESET_USES, type Character, type Chat, type Message } from '@app/shared';
import { assembleForChat, boundLoreEntries, sceneText, type ChatAssembleOptions } from './prompt';
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
  // 这一轮的输入怎么写在副对话预设的程序文字里（secondary.*）
  const t = sceneText('secondary', character);
  const pair = (id: string, label: string) => t('secondary.option', { id, label });
  const lines = [t('secondary.scene', { scene: getScene(chat.currentScene ?? 'free').name, task: opts.task?.name, input: opts.task?.input, tags })];
  if (tags.includes('cg')) {
    if (!imageLive) lines.push(t('secondary.image.off'));
    else {
      const uses = PRESET_USES.filter((u) => u.category === 'image').map((u) => {
        const moments = imageUseMoments(u.id);
        return t('secondary.image.use', {
          id: u.id, label: u.label, preset: lib.presetForUse(u.id, character)?.name,
          moments: moments ? Object.entries(moments).map(([id, label]) => pair(id, label)) : null,
        });
      });
      lines.push(t('secondary.image.on', {
        modes: Object.entries(IMAGE_MODES).map(([id, label]) => pair(id, label)),
        uses,
        models, defaultModel: api?.model,
      }));
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
