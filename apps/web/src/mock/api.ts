import { newFeatureApi } from '@app/ai';
import type { AgentRoute } from '@app/shared';

/**
 * 第一次打开时各功能的设置。API 设置按功能分：每个功能自己选渠道、填地址、Key、模型。
 * - 主对话还没设置：选渠道、填 Key 之后真的调用；
 * - 「陪伴 · 快速」先跟随主对话，想用便宜快的模型就单独设置；
 * - 生图提示词、节律、控制指令、约会跟随「陪伴 · 快速」；番外、创作 · 小说、总结、健康计划、主动消息、社媒（朋友圈和社群）、日记、平行时空、助手、识图跟随主对话；
 * - 向量化、语音合成、语音识别先选好硅基流动，生图先选好 NovelAI，只差 Key。
 * 没填 Key 的功能继续用演示模型，所以不填也能逛。
 */
export function defaultRoutes(): AgentRoute[] {
  return [
    { role: 'main', api: null, backup: null, runsOn: 'device', params: { temperature: 0.9 } },
    { role: 'secondary', follow: 'companion', api: null, backup: null, runsOn: 'device' },
    { role: 'companion', follow: 'main', api: null, backup: null, runsOn: 'device' },
    { role: 'decor', follow: 'companion', api: null, backup: null, runsOn: 'device' },
    // 约会：单独的一项设置，没单独设置前先跟随「陪伴 · 快速」（想用文笔更好的模型就在 API 设置里改成单独设置）
    { role: 'date', follow: 'companion', api: null, backup: null, runsOn: 'device' },
    { role: 'sidestory', follow: 'main', api: null, backup: null, runsOn: 'auto', params: { temperature: 1 }, dailyTokenBudget: 60_000 },
    // 创意工坊写小说：要写长文，默认跟随主对话（想用文笔更好、上下文更长的模型就单独设置）
    { role: 'novel', follow: 'main', api: null, backup: null, runsOn: 'device', params: { temperature: 1 } },
    { role: 'summary', follow: 'main', api: null, backup: null, runsOn: 'auto' },
    { role: 'consolidate', follow: 'main', api: null, backup: null, runsOn: 'hub' },
    { role: 'embedding', api: newFeatureApi('siliconflow', 'embedding'), backup: null, runsOn: 'auto', dims: 1024 },
    { role: 'imagePrompt', follow: 'companion', api: null, backup: null, runsOn: 'auto' },
    { role: 'image', api: newFeatureApi('novelai', 'image'), backup: null, runsOn: 'hub' },
    { role: 'rhythm', follow: 'companion', api: null, backup: null, runsOn: 'auto' },
    // 健康计划要写清楚动作怎么做、菜怎么做：默认跟随主对话（比「陪伴 · 快速」写得细）
    { role: 'health', follow: 'main', api: null, backup: null, runsOn: 'device' },
    // 日程计划：要按工具说明调 MCP、读长邮件，默认跟随主对话；每天到点在云端跑（没连云端时在 App 里"立即生成"）
    { role: 'planner', follow: 'main', api: null, backup: null, runsOn: 'hub' },
    // 心跳的控制指令：要快，默认跟随「陪伴 · 快速」
    { role: 'device', follow: 'companion', api: null, backup: null, runsOn: 'device' },
    // 主动消息不设每日 token 上限：设了的话消息一多就被拦住，看起来像她不来找你了（要省钱可以在 API 设置里自己填）
    { role: 'proactive', follow: 'main', api: null, backup: null, runsOn: 'hub' },
    // 社媒（朋友圈、社群）：朋友圈要像她本人写的，默认跟随主对话（每日上限不设，想省钱在 API 设置里填）
    { role: 'social', follow: 'main', api: null, backup: null, runsOn: 'auto', params: { temperature: 1 } },
    // 日记：要像她本人写的，默认跟随主对话；每晚 22:00 在云端写（没连云端时 App 开着照样写）
    { role: 'diary', follow: 'main', api: null, backup: null, runsOn: 'auto', params: { temperature: 1 } },
    // 平行时空：留言要像她本人写的、改日程要拿主意，默认跟随主对话；她自己留言在云端跑（没连云端时 App 开着照样留）
    { role: 'parallel', follow: 'main', api: null, backup: null, runsOn: 'auto' },
    // 助手：要读整份预设、照规矩改格式，默认跟随主对话（想用上下文更长、更听话的模型就单独设置）
    { role: 'assistant', follow: 'main', api: null, backup: null, runsOn: 'device' },
    { role: 'vision', follow: 'main', api: null, backup: null, runsOn: 'device' },
    { role: 'tts', api: newFeatureApi('siliconflow', 'tts'), backup: null, runsOn: 'device' },
    { role: 'stt', api: newFeatureApi('siliconflow', 'stt'), backup: null, runsOn: 'device' },
  ];
}
