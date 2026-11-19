import { fromOpenAIBody, parseSecondaryOutput } from '@app/ai';
import { IMAGE_MOMENTS, IMAGE_MODES, PRESET_USES, type Character, type Chat, type Message } from '@app/shared';
import { assembleForChat, type ChatAssembleOptions } from './prompt';
import { useAiStore } from '@/stores/ai';
import { useLibraryStore } from '@/stores/library';

/** 和主回复使用同一份历史及时间，只读世界书状态；不再次推进冷却、变量或记忆使用次数。 */
export async function secondaryChat(chat: Chat, character: Character, history: Message[], opts: ChatAssembleOptions, signal: AbortSignal) {
  const ai = useAiStore();
  const lib = useLibraryStore();
  const api = ai.effectiveRoute('image').api;
  const imageUses = PRESET_USES.filter((u) => u.category === 'image').map((u) => ({
    use: u.id,
    name: u.label,
    preset: lib.presetForUse(u.id, character)?.name,
    moments: u.id.startsWith('image:') ? IMAGE_MOMENTS[u.id.slice(6) as keyof typeof IMAGE_MOMENTS] : undefined,
  }));
  const prompt = assembleForChat(chat, character, history, {
    ...opts,
    agent: 'secondary',
    use: 'secondary',
    dryRun: true,
    task: {
      name: 'secondary',
      input: JSON.stringify({
        scene: chat.currentScene ?? 'free',
        mainTask: opts.task,
        allowedTags: opts.allowedTags,
        image: {
          available: ai.isLive('image'),
          defaultModel: api?.model,
          models: [...new Set([api?.model, ...(api?.models ?? [])].filter(Boolean))],
          modes: IMAGE_MODES,
          uses: imageUses,
        },
      }, null, 2),
    },
  });
  const request = fromOpenAIBody(prompt.request);
  request.names = { user: prompt.persona.name, char: character.name };
  const result = await ai.system.chat('secondary', request, { signal });
  return { value: parseSecondaryOutput(result.text), result, preset: prompt.preset };
}
