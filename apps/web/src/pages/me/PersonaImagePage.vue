<script setup lang="ts">
import { errorReport, errorText, type SpriteLooks } from '@app/ai';
import { showConfirmDialog, showToast } from 'vant';
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute } from 'vue-router';
import AssetImg from '@/components/common/AssetImg.vue';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { acceptPersonaBase, applyPersonaLooks, drawPersonaBase, spriteStatus, writePersonaLooks, type SpriteDraft } from '@/services/sprites';
import { usePersonaStore } from '@/stores/personas';

/**
 * 人设 → 生图：你入画时的长相。
 * - 外观 tags（{{user_appearance}}）：约会里两个人同框、陪伴学习画你那边时按它画；没填时约会只画Ta一个人；
 * - 和角色一样能让 AI 按人设写外观 tags（立绘预设的 sprite-tags 任务），再按立绘预设画一张立绘；
 * - 立绘的 Vibe Transfer：第一次入画时编码一次，之后一直带上，长相一直和立绘一样。
 */
const route = useRoute();
const store = usePersonaStore();
const persona = computed(() => store.byId(route.params.id as string) ?? store.defaultPersona);
const img = computed(() => store.image(persona.value));
const status = computed(() => spriteStatus());
const touch = () => store.touch(persona.value);

function fail(e: unknown): { reason: string; detail: string } {
  return { reason: errorText(e), detail: errorReport(e) };
}

// —— 外观 tags：AI 按人设写，先给你看 ——
const looks = ref<(SpriteLooks & { model: string }) | null>(null);
const looksBusy = ref(false);
const looksError = ref<{ reason: string; detail: string } | null>(null);
async function askLooks() {
  if (looksBusy.value) return;
  looksBusy.value = true;
  looksError.value = null;
  try {
    const r = await writePersonaLooks(persona.value);
    looks.value = { ...r.value, outfit: r.value.outfit ? { ...r.value.outfit } : null, model: r.model };
  } catch (e) {
    looksError.value = fail(e);
  } finally {
    looksBusy.value = false;
  }
}
function useLooks() {
  if (!looks.value) return;
  applyPersonaLooks(persona.value, looks.value);
  looks.value = null;
  showToast('外观 tags 存好了');
}

// —— 立绘：按立绘预设画一张，看过再用 ——
const draft = ref<SpriteDraft | null>(null);
const drawBusy = ref(false);
const drawError = ref<{ reason: string; detail: string } | null>(null);
async function draw() {
  if (drawBusy.value) return;
  drawBusy.value = true;
  drawError.value = null;
  try {
    const d = await drawPersonaBase(persona.value);
    dropDraft();
    draft.value = d;
  } catch (e) {
    drawError.value = fail(e);
  } finally {
    drawBusy.value = false;
  }
}
function dropDraft() {
  if (draft.value) URL.revokeObjectURL(draft.value.url);
  draft.value = null;
}
async function keepDraft() {
  const d = draft.value;
  if (!d) return;
  draft.value = null;
  await acceptPersonaBase(persona.value, d);
  showToast('立绘存好了：下次入画时编码 Vibe');
}
async function removePortrait() {
  const ok = await showConfirmDialog({ title: '不用这张立绘了？', message: '入画时不再带它的 Vibe，长相只按外观 tags。', confirmButtonText: '不用了' }).then(
    () => true,
    () => false,
  );
  if (!ok) return;
  delete img.value.portrait;
  touch();
}
onBeforeUnmount(dropDraft);

const vibeModels = computed(() => (img.value.portrait?.vibes ?? []).filter((v) => v.informationExtracted === img.value.vibe.informationExtracted).map((v) => v.model));
</script>

<template>
  <div class="page" data-page="persona-image">
    <PageHeader title="生图" :subtitle="`${persona.name} · 你入画时的长相`" fallback="/me/personas" />
    <div class="page-scroll pb-8">
      <p class="note">约会里两个人同框、陪伴学习画你那边时按这里画；外观 tags 没填时约会只画Ta一个人。</p>

      <div class="group-title">外观</div>
      <div class="box mx-4">
        <label class="field-label" for="pi-app">外观 tags（人数和性别放最前面，例如 1boy, short hair, black hair, glasses）</label>
        <textarea id="pi-app" v-model="img.appearanceTags" class="textarea mono" rows="3" spellcheck="false" data-testid="persona-appearance" @change="touch" />
        <label class="field-label" for="pi-neg">负面 tags</label>
        <textarea id="pi-neg" v-model="img.negativeTags" class="textarea mono" rows="2" spellcheck="false" @change="touch" />
        <label class="field-label" for="pi-outfit">常穿的一套（画立绘时穿；入画时衣服按画面写）</label>
        <textarea id="pi-outfit" v-model="img.outfitTags" class="textarea mono" rows="2" spellcheck="false" @change="touch" />

        <div v-if="!looks" class="flex items-center gap-2.5 mt-3">
          <van-button size="small" round :type="img.appearanceTags.trim() ? 'default' : 'primary'" :loading="looksBusy" loading-text="在写…" data-testid="persona-looks" @click="askLooks">
            {{ img.appearanceTags.trim() ? '让 AI 按人设重写' : '让 AI 按人设写' }}
          </van-button>
        </div>
        <p v-if="!status.promptLive && !looks" class="hint">
          写 tags 用「生图提示词」的 API（{{ status.promptReason }}）。<RouterLink to="/me/api?feature=imagePrompt" class="text-accent-ink">去设置</RouterLink>
        </p>
        <ErrorDetails v-if="looksError" :title="looksError.reason" :detail="looksError.detail" max-height="30vh" />
        <div v-if="looks" class="sub" data-testid="persona-looks-preview">
          <label class="field-label" for="pl-app">外观 tags</label>
          <textarea id="pl-app" v-model="looks.appearance" class="textarea mono" rows="3" spellcheck="false" />
          <label class="field-label" for="pl-neg">负面 tags</label>
          <textarea id="pl-neg" v-model="looks.negative" class="textarea mono" rows="2" spellcheck="false" />
          <template v-if="looks.outfit">
            <label class="field-label" for="pl-outfit">常穿的一套</label>
            <textarea id="pl-outfit" v-model="looks.outfit.tags" class="textarea mono" rows="2" spellcheck="false" />
          </template>
          <div class="text-[12px] text-ink-3 mt-1.5">{{ looks.model }} 按人设写的，用立绘预设「{{ status.preset?.name }}」</div>
          <div class="flex gap-2 mt-2.5">
            <van-button round block size="small" :loading="looksBusy" @click="askLooks">再写一次</van-button>
            <van-button round block size="small" type="primary" data-testid="persona-looks-use" @click="useLooks">就用这个</van-button>
          </div>
          <button type="button" class="skip" @click="looks = null">先不用</button>
        </div>
      </div>

      <div class="group-title">立绘</div>
      <div class="box mx-4">
        <div v-if="draft" class="art" data-testid="persona-draft">
          <img :src="draft.url" alt="新画的立绘" />
        </div>
        <div v-else-if="img.portrait" class="art">
          <AssetImg :asset-key="img.portrait.assetKey" :alt="`${persona.name}的立绘`" />
        </div>
        <p v-else class="hint mt-0">还没有立绘。和角色一样按外观 tags、常穿的那套和立绘预设画一张。</p>
        <div v-if="draft" class="flex gap-2 mt-3">
          <van-button round block size="small" :loading="drawBusy" @click="draw">再画一张</van-button>
          <van-button round block size="small" type="primary" data-testid="persona-draft-use" @click="keepDraft">用这张</van-button>
        </div>
        <div v-else class="flex items-center gap-2.5 mt-3">
          <van-button size="small" round type="primary" :loading="drawBusy" loading-text="在画…" :disabled="!img.appearanceTags.trim()" data-testid="persona-draw" @click="draw">
            {{ img.portrait ? '重画一张' : 'AI 画立绘' }}
          </van-button>
          <button v-if="img.portrait" type="button" class="text-[13px] text-ink-3" @click="removePortrait">不用这张了</button>
        </div>
        <button v-if="draft" type="button" class="skip" @click="dropDraft">不要这张</button>
        <p v-if="!status.imageLive" class="hint">
          画立绘用「生图」的 API（{{ status.imageReason }}）。<RouterLink to="/me/api?feature=image" class="text-accent-ink">去设置</RouterLink>
        </p>
        <p v-else-if="!status.preset" class="hint">没有立绘预设：去"我的 → 预设 → 立绘"导入或恢复一个。</p>
        <ErrorDetails v-if="drawError" :title="drawError.reason" :detail="drawError.detail" max-height="30vh" />
      </div>

      <div class="group-title">Vibe Transfer</div>
      <div class="box mx-4">
        <div class="flex items-center gap-3">
          <div class="flex-1 min-w-0">
            <div class="text-[14.5px] font-600">入画时带上立绘的 Vibe</div>
            <div class="text-[12px] text-ink-3 leading-relaxed">参考立绘的视觉特征，会影响整张图的画风、颜色和构图，双人图也一样，不能保证只还原你的脸。第一次编码扣 2 点，之后复用；只有 NovelAI V4、V4.5 能用。</div>
          </div>
          <van-switch v-model="img.vibe.enabled" size="22px" data-testid="persona-vibe" @change="touch" />
        </div>
        <template v-if="img.vibe.enabled">
          <div class="slider-row">
            <span class="slider-label">强度</span>
            <van-slider v-model="img.vibe.strength" class="flex-1" :min="0" :max="1" :step="0.05" bar-height="4px" button-size="16px" aria-label="Vibe 强度" @change="touch" />
            <span class="slider-val">{{ img.vibe.strength.toFixed(2) }}</span>
          </div>
          <div class="slider-row">
            <span class="slider-label">信息提取</span>
            <van-slider v-model="img.vibe.informationExtracted" class="flex-1" :min="0" :max="1" :step="0.05" bar-height="4px" button-size="16px" aria-label="Vibe 信息提取量" @change="touch" />
            <span class="slider-val">{{ img.vibe.informationExtracted.toFixed(2) }}</span>
          </div>
          <p class="hint">强度越高，参考图的影响越强，也可能压过文字。降低信息提取会先减少纹理细节，仍可能保留构图；改信息提取量要重新编码。带 Vibe 的新图可以打开大图，点「去掉 Vibe 对比」，保持原提示词和随机种子再画一张。</p>
          <p class="hint">{{ !img.portrait ? '先画一张立绘。' : vibeModels.length ? `已编码：${vibeModels.join('、')}` : '还没编码：下次入画时编码。' }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.box {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.box > .field-label:first-child {
  margin-top: 0;
}
.sub {
  margin-top: 10px;
  padding: 10px;
  border-radius: 14px;
  background: var(--panel);
}
.hint {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.skip {
  display: block;
  width: 100%;
  margin-top: 6px;
  font-size: 13px;
  color: var(--ink-3);
}
.art {
  display: flex;
  justify-content: center;
  border-radius: 14px;
  background: var(--panel);
  overflow: hidden;
}
.art :deep(img),
.art img {
  max-height: 46vh;
  width: auto;
  object-fit: contain;
}
.slider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.slider-label {
  width: 56px;
  font-size: 13px;
  color: var(--ink-2);
  flex-shrink: 0;
}
.slider-val {
  width: 36px;
  font-size: 12px;
  text-align: right;
  color: var(--ink-3);
  font-variant-numeric: tabular-nums;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
}
</style>
