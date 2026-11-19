<script setup lang="ts">
import { DEFAULT_TEXT_OBFUSCATION, obfuscateText, TEXT_OBFUSCATION_MODES, TEXT_OBFUSCATION_RANGES } from '@app/ai';
import { computed, ref, watch } from 'vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useAiStore } from '@/stores/ai';

const s = useAiStore().textObfuscation;
const ranges = TEXT_OBFUSCATION_RANGES;
const mode = computed(() => TEXT_OBFUSCATION_MODES.find((item) => item.value === s.mode));
const usesHomophones = computed(() => s.mode === 'homophone' || s.mode === 'homophone-scatter');
const usesCarrier = computed(() => s.mode !== 'homophone');
const usesFragments = computed(() => s.mode === 'scatter' || s.mode === 'homophone-scatter');
const source = ref('');
const preview = ref('');
watch([s, source], () => { preview.value = ''; });

function regenerate() {
  preview.value = obfuscateText(source.value, s);
}

function reset() {
  Object.assign(s, DEFAULT_TEXT_OBFUSCATION, { enabled: s.enabled });
}
</script>

<template>
  <div class="page" data-page="obfuscation">
    <PageHeader title="混淆设置" fallback="/me" />
    <div class="page-scroll pb-10">
      <div class="group-title">发送给文本 AI</div>
      <van-cell-group inset>
        <van-cell title="开启混淆" :label="s.enabled ? '已开启 · 下次文字请求生效' : '已关闭 · 发送原文'" center>
          <template #right-icon><van-switch v-model="s.enabled" size="22px" class="shrink-0" aria-label="开启全局文本混淆" /></template>
        </van-cell>
      </van-cell-group>
      <p class="note">聊天、助手、总结、主动消息、生图提示词等所有文本 AI 请求都会先处理，包括系统提示词和历史消息。聊天记录仍显示原文。</p>
      <p class="note">语音合成、语音识别、实际绘图和向量化保持原样。设置自动保存；云端任务在同步后使用同一套设置。</p>

      <div class="group-title">混淆方式</div>
      <van-cell-group inset>
        <van-cell title="方式" center>
          <template #value>
            <select v-model="s.mode" class="mode-select" aria-label="混淆方式">
              <option v-for="item in TEXT_OBFUSCATION_MODES" :key="item.value" :value="item.value">{{ item.label }}</option>
            </select>
          </template>
        </van-cell>
        <van-cell v-if="usesFragments" title="每段字数" center>
          <template #right-icon><van-stepper v-model="s.chunkSize" v-bind="ranges.chunkSize" integer input-width="44px" aria-label="每段字数" /></template>
        </van-cell>
        <van-cell v-if="usesHomophones" title="同音替换比例" :label="`${s.homophoneRate}%`" center>
          <template #right-icon><van-stepper v-model="s.homophoneRate" v-bind="ranges.homophoneRate" integer input-width="44px" aria-label="同音替换比例" /></template>
        </van-cell>
        <van-cell v-if="usesCarrier" title="载体行数" center>
          <template #right-icon><van-stepper v-model="s.carrierLines" v-bind="ranges.carrierLines" integer input-width="44px" aria-label="载体行数" /></template>
        </van-cell>
      </van-cell-group>
      <p class="note">{{ mode?.description }}<template v-if="usesFragments"> 每段越短，发送的片段和 token 用量越多。</template><template v-if="usesHomophones"> 替换比例作用于词库覆盖到的中文；多音单字、代码和结构标记保留。</template></p>

      <div class="group-title">试一试</div>
      <van-cell-group inset>
        <van-field v-model="source" type="textarea" rows="3" autosize label="原文" label-align="top" placeholder="写一句话，预览发送时的文字" aria-label="预览原文" />
      </van-cell-group>
      <div class="px-4 mt-3">
        <van-button round block :disabled="!source.trim()" @click="regenerate">{{ preview ? '换一组结果' : '预览混淆结果' }}</van-button>
      </div>
      <p class="note">预览只在本机运行，不调用 AI；关闭开关也可以试用。</p>
      <div v-if="preview" class="preview" aria-live="polite">
        <div class="preview-heading"><span>混淆结果</span><span>{{ source.length }} → {{ preview.length }} 字符</span></div>
        <pre>{{ preview }}</pre>
      </div>

      <details class="advanced">
        <summary>自定义词库与载体</summary>
        <van-cell-group inset>
          <van-field v-if="usesHomophones" v-model="s.customWords" type="textarea" rows="3" autosize label="自定义同音词" label-align="top" placeholder="每行 原词=替换词；同名词条覆盖自带词库" aria-label="自定义同音词" />
          <van-field v-if="usesCarrier" v-model="s.carrier" type="textarea" rows="3" autosize label="载体模板" label-align="top" aria-label="载体模板" />
          <van-field v-if="usesCarrier" v-model="s.instruction" type="textarea" rows="3" autosize label="还原说明" label-align="top" aria-label="还原说明" />
          <van-field v-if="usesHomophones" v-model="s.homophoneInstruction" type="textarea" rows="3" autosize label="同音说明" label-align="top" aria-label="同音说明" />
        </van-cell-group>
        <p v-if="usesCarrier" class="note"><span v-pre>每次随机选取载体行；{noise} 换成随机内容，{index} 换成行号。还原说明中的 {marker} 对应本次片段标记。</span></p>
        <div class="px-4 mt-3"><van-button round block @click="reset">恢复默认参数</van-button></div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.note {
  color: var(--ink-2);
}
.mode-select {
  max-width: 100%;
  color: var(--ink);
  background: var(--surface);
  border: 0;
  font: inherit;
  cursor: pointer;
}
.mode-select:focus-visible,
.advanced summary:focus-visible {
  outline: 2px solid var(--accent-ink);
  outline-offset: 3px;
}
.preview {
  margin: 16px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}
.preview-heading {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  color: var(--ink-2);
  font-size: 13px;
}
.preview pre {
  margin: 12px 0 0;
  max-height: 320px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  font-size: 13px;
  line-height: 1.7;
}
.advanced {
  margin-top: 24px;
}
.advanced summary {
  margin: 0 16px 12px;
  padding: 12px;
  color: var(--ink-2);
  font-size: 14px;
  cursor: pointer;
}
</style>
