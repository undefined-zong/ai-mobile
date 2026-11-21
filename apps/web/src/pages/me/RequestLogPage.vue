<script setup lang="ts">
import { AGENT_META, type AgentRole } from '@app/shared';
import { showToast } from 'vant';
import { computed, ref } from 'vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useRequestLogStore, type RequestLogEntry } from '@/stores/requestLog';

/**
 * 请求记录：发出去的每一个请求原样列出来（地址、请求头、请求体、返回内容；Key 打码，图片之类的 base64 只记长度），
 * 生图另外有一条"生图拼接"：预设每一块发没发、为什么没发，发给模型的消息，模型原样的输出，出图用了预设里哪几块、最后的提示词。
 */
const log = useRequestLogStore();
const filter = ref<'all' | 'image' | 'http'>('all');
const list = computed(() => [...log.entries].reverse().filter((e) => filter.value === 'all' || (filter.value === 'image' ? e.kind === 'image' || e.record?.role === 'image' || e.record?.role === 'imagePrompt' : e.kind === 'http')));

const open = ref<Set<string>>(new Set());
function toggle(id: string) {
  const s = new Set(open.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  open.value = s;
}

const pad = (n: number) => String(n).padStart(2, '0');
function time(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function roleLabel(role: string | undefined): string {
  if (!role) return '其他请求';
  return AGENT_META[role as AgentRole]?.label ?? role;
}
function where(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}
const ROLE: Record<string, string> = { system: '系统', user: '用户', assistant: '助手' };
const KIND: Record<string, string> = { scene: '场景', portrait: '全身像', face: '脸部特写', background: '只画背景', 'no-humans': 'image### 写了 no humans' };
const SIZE_FROM: Record<string, string> = { scene: '场景定的', model: '模型写的 size###', preset: '预设里 image-size 那块', default: '都没写，用竖图' };

type ImageEntry = Extract<RequestLogEntry, { kind: 'image' }>;
/** 数据宏：有值的在前 */
function macros(e: ImageEntry): [string, string][] {
  return Object.entries(e.trace.macros).sort((a, b) => Number(!a[1].trim()) - Number(!b[1].trim()));
}
function sentCount(e: ImageEntry): number {
  return e.trace.blocks.filter((b) => b.sent).length;
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('复制好了');
  } catch {
    showToast('复制不了，长按文字手动选');
  }
}
function asJson(e: RequestLogEntry): string {
  return JSON.stringify(e, null, 2);
}
async function clearAll() {
  await log.clear();
  showToast('清空了');
}
</script>

<template>
  <div class="page" data-page="request-log">
    <PageHeader title="请求记录" :subtitle="`最近 ${log.entries.length} 条 · 只存在这台设备上`" fallback="/me">
      <template #right>
        <button type="button" class="text-[14px] text-accent-ink px-2" :disabled="!log.entries.length" @click="clearAll">清空</button>
      </template>
    </PageHeader>
    <Segmented
      v-model="filter"
      sticky
      class="mt-2"
      :options="[
        { value: 'all', label: '全部' },
        { value: 'image', label: '生图' },
        { value: 'http', label: '只看请求' },
      ]"
    />
    <div class="page-scroll pb-8">
      <p class="text-[12px] text-ink-3 mx-4 mt-2 mb-2 leading-relaxed">
        每一个发给 API 的请求都按实际发出去的样子记在这里（Key 打码，图片、语音的 base64 只记大小）。生图另外有一条「生图拼接」：预设每一块发没发、发给模型的消息、模型原样的输出、出图用了预设里哪几块。最多留最近 80 条，不同步、不进备份。
      </p>
      <p v-if="!list.length" class="text-[13px] text-ink-3 text-center py-10 m-0">还没有记录：发一条消息或者画一张图就有了</p>
      <div class="px-4 grid gap-2">
        <div v-for="e in list" :key="e.id" class="block" :class="{ bad: e.kind === 'http' && (e.record.error || (e.record.status ?? 200) >= 400) }" :data-testid="`log-${e.kind}`">
          <button type="button" class="head" @click="toggle(e.id)">
            <span :class="e.kind === 'image' ? 'i-lucide-image' : 'i-lucide-arrow-up-right'" class="shrink-0 text-accent-ink" />
            <div class="flex-1 min-w-0 text-left">
              <template v-if="e.kind === 'image'">
                <div class="text-[14px] font-600 truncate">生图拼接 · {{ e.label }}</div>
                <div class="text-[11.5px] text-ink-3 truncate">
                  {{ time(e.at) }} · 预设「{{ e.trace.presetName ?? '没有预设' }}」 · 发了 {{ sentCount(e) }} / {{ e.trace.blocks.length }} 块 · {{ KIND[e.trace.compose.kind] ?? e.trace.compose.kind }}
                </div>
              </template>
              <template v-else>
                <div class="text-[14px] font-600 truncate">{{ roleLabel(e.record.role) }} · {{ e.record.provider }}</div>
                <div class="text-[11.5px] text-ink-3 truncate">
                  {{ time(e.at) }} · {{ e.record.method }} {{ where(e.record.url) }} ·
                  <template v-if="e.record.error">失败：{{ e.record.error }}</template>
                  <template v-else-if="e.record.status">{{ e.record.status }} · {{ e.record.ms }} ms</template>
                  <template v-else>等待中</template>
                </div>
              </template>
            </div>
            <span class="i-lucide-chevron-down text-ink-3 transition-transform shrink-0" :class="{ 'rotate-180': open.has(e.id) }" />
          </button>

          <div v-if="open.has(e.id)" class="body">
            <template v-if="e.kind === 'http'">
              <section>
                <h4>地址</h4>
                <pre>{{ e.record.method }} {{ e.record.url }}</pre>
              </section>
              <section>
                <h4>请求头</h4>
                <pre>{{ JSON.stringify(e.record.headers, null, 2) }}</pre>
              </section>
              <section>
                <h4>请求体 <button type="button" class="mini" @click="copy(e.record.body)">复制</button></h4>
                <pre>{{ e.record.body || '（没有）' }}</pre>
              </section>
              <section>
                <h4>返回<template v-if="e.record.contentType"> · {{ e.record.contentType }}</template> <button v-if="e.record.response" type="button" class="mini" @click="copy(e.record.response ?? '')">复制</button></h4>
                <pre>{{ e.record.error ? `失败：${e.record.error}` : (e.record.response ?? '（还在读）') }}</pre>
              </section>
            </template>

            <template v-else>
              <section>
                <h4>这一次的类型（块的触发条件按它挑）</h4>
                <div class="flex flex-wrap gap-1">
                  <span v-for="t in e.trace.types.filter((x) => !/^(has|no):/.test(x))" :key="t" class="chip">{{ t }}</span>
                </div>
                <details class="mt-1.5">
                  <summary>has: / no:（数据宏有没有值）</summary>
                  <div class="flex flex-wrap gap-1 mt-1">
                    <span v-for="t in e.trace.types.filter((x) => /^(has|no):/.test(x))" :key="t" class="chip" :class="{ dim: t.startsWith('no:') }">{{ t }}</span>
                  </div>
                </details>
              </section>
              <section>
                <h4>数据宏</h4>
                <div class="grid gap-1">
                  <div v-for="[k, v] in macros(e)" :key="k" class="macro" :class="{ dim: !v.trim() }">
                    <code>{{ `\{\{${k}\}\}` }}</code>
                    <span>{{ v.trim() ? v : '（空）' }}</span>
                  </div>
                </div>
              </section>
              <section>
                <h4>预设每一块</h4>
                <details v-for="(b, i) in e.trace.blocks" :key="`${b.identifier}-${i}`" class="blk" :class="{ off: !b.sent }">
                  <summary>
                    <span :class="b.sent ? 'i-lucide-circle-check text-accent-ink' : 'i-lucide-circle-minus text-ink-3'" class="shrink-0" />
                    <span class="flex-1 min-w-0 truncate">{{ b.name || b.identifier }}</span>
                    <span class="text-[11px] text-ink-3 shrink-0">{{ b.sent ? ROLE[b.role] : (b.note ?? '没发') }}</span>
                  </summary>
                  <pre>{{ b.content || '（空）' }}</pre>
                </details>
              </section>
              <section>
                <h4>发给模型的消息 <button type="button" class="mini" @click="copy(JSON.stringify(e.trace.messages, null, 2))">复制</button></h4>
                <div v-for="(m, i) in e.trace.messages" :key="i" class="msg">
                  <span class="chip">{{ ROLE[m.role] ?? m.role }}</span>
                  <pre>{{ m.content }}</pre>
                </div>
                <p v-if="!e.trace.messages.length" class="note">没有发给模型（没有生图预设或者没接通生图提示词）：image### 就是画面描述原文</p>
              </section>
              <section>
                <h4>模型原样的输出</h4>
                <pre>{{ e.trace.raw ?? '（没用模型）' }}</pre>
              </section>
              <section>
                <h4>读出来的</h4>
                <pre>image###{{ e.trace.parsed.tags }}###
negative###{{ e.trace.parsed.negative }}###<template v-if="e.trace.parsed.size">
size###{{ e.trace.parsed.size }}###</template><template v-for="(o, i) in e.trace.parsed.others ?? []" :key="i">
| 第 {{ i + 1 }} 个人：{{ o.tags }}<template v-if="o.negative">（负面：{{ o.negative }}）</template></template></pre>
              </section>
              <section>
                <h4>出图怎么拼的</h4>
                <div class="kv"><span>拼法</span><span>{{ KIND[e.trace.compose.kind] ?? e.trace.compose.kind }}（image-prompt:{{ e.trace.compose.kind }}）</span></div>
                <div class="kv"><span>正向用的块</span><span>{{ e.trace.compose.promptBlocks.join('、') || '没有 image-prompt 块：用 image### 原样' }}</span></div>
                <div class="kv"><span>负面用的块</span><span>{{ e.trace.compose.negativeBlocks.join('、') || '没有 image-negative 块：用 negative### 原样' }}</span></div>
                <div v-for="(names, i) in e.trace.compose.charBlocks ?? []" :key="`c${i}`" class="kv"><span>第 {{ i + 1 }} 个人</span><span>{{ names.join('、') || '没有 image-char 块：用模型写的原样' }}</span></div>
                <div class="kv"><span>画幅</span><span>{{ e.trace.request.size }}（{{ SIZE_FROM[e.trace.compose.sizeFrom] }}）</span></div>
                <div class="kv"><span>你立绘的 Vibe</span><span>{{ e.trace.request.vibes ? `带了 ${e.trace.request.vibes} 张` : '没带' }}</span></div>
              </section>
              <section>
                <h4>最终提示词 <button type="button" class="mini" @click="copy(e.trace.request.prompt)">复制</button></h4>
                <pre>{{ e.trace.request.prompt }}</pre>
              </section>
              <section>
                <h4>最终负面词</h4>
                <pre>{{ e.trace.request.negative || '（空）' }}</pre>
              </section>
              <section v-if="e.trace.request.characters?.length">
                <h4>分人物</h4>
                <pre v-for="(c, i) in e.trace.request.characters" :key="i">{{ i + 1 }}. {{ c.prompt }}<template v-if="c.negative">
   负面：{{ c.negative }}</template></pre>
              </section>
              <p class="note">这是出图前拼好的。API 设置 → 生图风格里的前缀、负面词出图时再加上；实际发出去的完整请求看紧挨着的那条「生图」请求。</p>
            </template>
            <button type="button" class="mini mt-1" @click="copy(asJson(e))">复制这一条（JSON）</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.block {
  border-radius: 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  overflow: hidden;
}
.block.bad {
  border-color: color-mix(in srgb, var(--bad) 45%, var(--border));
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
}
.body {
  border-top: 1px solid var(--border);
  padding: 10px 12px 12px;
  display: grid;
  gap: 12px;
  min-width: 0;
}
section {
  min-width: 0;
}
h4 {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-2);
}
pre {
  margin: 0;
  padding: 10px;
  border-radius: 10px;
  background: var(--panel);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-2);
  max-height: 360px;
  overflow: auto;
}
.mini {
  height: 24px;
  padding: 0 9px;
  border-radius: 99px;
  background: var(--panel);
  font-size: 11.5px;
  font-weight: 400;
  color: var(--accent-ink);
  justify-self: start;
}
.chip {
  display: inline-block;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 11.5px;
  line-height: 20px;
}
.chip.dim,
.macro.dim {
  opacity: 0.5;
}
.macro {
  display: flex;
  gap: 8px;
  font-size: 12px;
  line-height: 1.5;
  min-width: 0;
}
.macro code {
  flex-shrink: 0;
  color: var(--accent-ink);
}
.macro span {
  min-width: 0;
  word-break: break-word;
  color: var(--ink-2);
}
.blk {
  border-radius: 10px;
  margin-bottom: 4px;
}
.blk summary,
details summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 2px;
  font-size: 13px;
  cursor: pointer;
  list-style: none;
  min-width: 0;
}
.blk.off summary {
  opacity: 0.6;
}
.msg {
  display: grid;
  gap: 4px;
  margin-bottom: 8px;
  justify-items: start;
}
.msg pre {
  width: 100%;
}
.kv {
  display: flex;
  gap: 10px;
  font-size: 12.5px;
  line-height: 1.6;
  padding: 2px 0;
}
.kv span:first-child {
  flex-shrink: 0;
  width: 84px;
  color: var(--ink-3);
}
.kv span:last-child {
  min-width: 0;
  word-break: break-word;
  color: var(--ink-2);
}
.note {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
</style>
