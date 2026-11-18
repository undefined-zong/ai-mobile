<script setup lang="ts">
import { PRIORITY_LABEL, WEEKDAY_LABEL } from '@app/shared';
import { showToast } from 'vant';
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import ErrorDetails from '@/components/common/ErrorDetails.vue';
import Segmented from '@/components/common/Segmented.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { useAiStore } from '@/stores/ai';
import { useHubStore } from '@/stores/hub';
import { usePersonaStore } from '@/stores/personas';
import { usePlannerStore } from '@/stores/planner';
import { listTime } from '@/utils/time';

/**
 * 我的 → 日程计划（设计文档 §9.15）：默认人设的日程系统排的这周和今天的计划。
 * - 今天：一句话概览、时间线（能勾掉，勾掉的她也知道）、日程里的事、要紧的邮件、待办、一句提醒；查了什么、哪里没连上；
 * - 这周：重点、每天的主线和日程、截止的事、要完成的事。
 * 连了云端时每天到点 Worker 排好，这里拉回来；"立即生成"连了云端让 Worker 现在排，没连在本机排。
 */
const router = useRouter();
const personas = usePersonaStore();
const planner = usePlannerStore();
const hub = useHubStore();
const ai = useAiStore();
const persona = computed(() => personas.defaultPersona);
const settings = computed(() => persona.value.planner);
const enabled = computed(() => !!settings.value?.enabled);
const cloud = computed(() => hub.connected && hub.supportsPlanner);
const status = computed(() => ai.status('planner'));

const tab = ref<'today' | 'week'>('today');
const TABS = [
  { value: 'today' as const, label: '今天', icon: 'i-lucide-calendar-check' },
  { value: 'week' as const, label: '这周', icon: 'i-lucide-calendar-range' },
];

const today = computed(() => planner.today(persona.value));
const day = computed(() => planner.dayOf(persona.value.id, today.value));
const week = computed(() => planner.weekOf(persona.value.id, planner.weekStartFor(persona.value)));
const done = computed(() => planner.doneOf(persona.value.id, today.value));
const run = computed(() => planner.runOf(persona.value.id, today.value));
const busy = computed(() => planner.busy[persona.value.id]);
const error = computed(() => planner.errors[persona.value.id]);
const cloudError = computed(() => planner.cloudErrors.find((e) => e.personaId === persona.value.id && e.date === today.value));
const noServers = computed(() => !settings.value?.servers.some((s) => s.enabled && s.url));
const showSources = ref(false);

async function generate(want: { week: boolean; day: boolean }) {
  const r = await planner.run(persona.value.id, want);
  if (r.ok) showToast(want.week && !want.day ? '这周的计划排好了' : '排好了');
  else if (r.reason !== '正在排') showToast({ message: r.reason, duration: 3000 });
}

onMounted(() => {
  // 连了云端：打开时拉一次云端排好的
  if (hub.connected) void hub.syncNow();
});
</script>

<template>
  <div class="page" data-page="planner">
    <PageHeader title="日程计划" :subtitle="`${persona.name} · ${cloud ? `每天 ${settings?.runAt ?? '04:00'} 在云端排` : '日程系统排的'}`" fallback="/me">
      <template #right>
        <RouterLink :to="`/me/personas/${persona.id}/planner`" class="icon-btn" aria-label="日程系统设置"><span class="i-lucide-settings-2 text-[20px]" /></RouterLink>
      </template>
    </PageHeader>
    <div class="page-scroll pb-8">
      <div v-if="!enabled" class="mx-4 mt-4 card-box text-center">
        <span class="i-lucide-calendar-check text-[34px] text-accent-ink" />
        <div class="text-[15px] font-600 mt-2">日程系统还没打开</div>
        <p class="text-[13px] text-ink-3 leading-relaxed mt-1 mb-3">在人设里打开日程系统，接上 Gmail 和日程软件（MCP），每天凌晨云端看一遍新邮件和日程，排出这周和今天的计划。</p>
        <van-button type="primary" round size="small" data-testid="open-planner" @click="router.push(`/me/personas/${persona.id}/planner`)">去打开</van-button>
      </div>

      <template v-else>
        <div v-if="!cloud && !status.live" class="notice mx-4 mt-3">
          <span class="i-lucide-plug-zap shrink-0" />
          <span class="flex-1 min-w-0">「日程计划」还没接通：{{ status.reason }}</span>
          <RouterLink to="/me/api?feature=planner" class="text-accent-ink shrink-0">去设置</RouterLink>
        </div>
        <div v-if="noServers" class="notice mx-4 mt-3">
          <span class="i-lucide-mail shrink-0" />
          <span class="flex-1 min-w-0">还没接邮箱和日程：现在只按家务、健康和你写的情况排</span>
          <RouterLink :to="`/me/personas/${persona.id}/planner`" class="text-accent-ink shrink-0">去接</RouterLink>
        </div>
        <div v-if="busy" class="notice mx-4 mt-3" data-testid="planner-busy">
          <van-loading size="14px" />
          <span class="flex-1 min-w-0">{{ busy }}…</span>
        </div>
        <div v-if="error && !busy" class="mx-4 mt-3">
          <ErrorDetails :detail="error.detail || error.reason" :title="`没排出来：${error.reason}`" max-height="160px" />
        </div>
        <div v-else-if="cloudError && !day" class="notice mx-4 mt-3">
          <span class="i-lucide-cloud-alert shrink-0" />
          <span class="flex-1 min-w-0">{{ cloudError.reason }}</span>
        </div>
        <div class="px-4 pt-3"><Segmented v-model="tab" :options="TABS" /></div>

        <!-- 今天 -->
        <template v-if="tab === 'today'">
          <div v-if="!day" class="mx-4 mt-3 card-box text-center">
            <div class="text-[14.5px] font-600">今天（{{ today }}）的计划还没排</div>
            <p class="text-[12.5px] text-ink-3 mt-1 mb-3">{{ cloud ? `每天 ${settings?.runAt} 云端会自动排；现在也可以让它排` : '看新邮件和日程、排今天（要一点时间）' }}</p>
            <van-button type="primary" round size="small" :loading="!!busy" loading-text="在排…" data-testid="planner-generate" @click="generate({ day: true, week: !week })">立即生成</van-button>
          </div>
          <template v-else>
            <div class="mx-4 mt-3 card-box">
              <div class="text-[12.5px] text-ink-3 num">{{ day.date }} {{ WEEKDAY_LABEL[new Date(`${day.date}T12:00:00Z`).getUTCDay()] }} · 做完 {{ done.size }}/{{ day.items.length }}</div>
              <div class="text-[16px] font-700 mt-1 leading-snug">{{ day.summary || '今天的计划' }}</div>
              <p v-if="day.note" class="say"><span class="i-lucide-quote shrink-0 mt-0.5" />{{ day.note }}</p>
            </div>

            <div class="group-title">时间线</div>
            <div class="mx-4 card-box !py-1.5">
              <label v-for="(it, i) in day.items" :key="i" class="item" :class="{ done: done.has(i) }" :data-item="i">
                <input type="checkbox" :checked="done.has(i)" @change="planner.toggle(persona.id, day.date, i)" />
                <span class="time num">{{ it.time || '—' }}</span>
                <span class="flex-1 min-w-0">
                  <span class="title text-[14.5px]">{{ it.title }}</span>
                  <span v-if="it.fixed" class="i-lucide-lock text-[11px] text-ink-3 ml-1" aria-label="定死的" />
                  <span class="block text-[12px] text-ink-3">
                    <template v-if="it.minutes">{{ it.minutes }} 分钟</template>
                    <template v-if="it.tag"> · {{ it.tag }}</template>
                    <template v-if="it.source"> · 来自{{ it.source }}</template>
                  </span>
                  <span v-if="it.note" class="block text-[12.5px] text-ink-2 mt-0.5">{{ it.note }}</span>
                </span>
              </label>
            </div>

            <template v-if="day.events.length">
              <div class="group-title">日程</div>
              <div class="mx-4 card-box !py-1.5">
                <div v-for="(e, i) in day.events" :key="i" class="row">
                  <span class="time num">{{ e.time || '—' }}</span>
                  <span class="flex-1 min-w-0">
                    <span class="text-[14px]">{{ e.title }}</span>
                    <span v-if="e.where || e.note" class="block text-[12px] text-ink-3">{{ [e.where, e.note].filter(Boolean).join(' · ') }}</span>
                  </span>
                </div>
              </div>
            </template>

            <template v-if="day.mail.length">
              <div class="group-title">邮件</div>
              <div class="mx-4 grid gap-2">
                <div v-for="(m, i) in day.mail" :key="i" class="card-box !p-3">
                  <div class="flex items-center gap-1.5">
                    <span v-if="m.important" class="i-lucide-star text-[13px] text-accent-ink shrink-0" aria-label="要紧" />
                    <span class="text-[14px] font-600 flex-1 min-w-0 truncate">{{ m.subject || '（没有标题）' }}</span>
                    <span v-if="m.due" class="tag accent shrink-0">{{ m.due }}</span>
                  </div>
                  <div v-if="m.from" class="text-[12px] text-ink-3">{{ m.from }}</div>
                  <p class="text-[13px] text-ink-2 mt-1 mb-0 leading-relaxed">{{ m.gist }}</p>
                  <p v-if="m.action" class="text-[13px] mt-1 mb-0"><span class="text-accent-ink">要做：</span>{{ m.action }}</p>
                </div>
              </div>
            </template>

            <template v-if="day.todos.length">
              <div class="group-title">待办</div>
              <div class="mx-4 card-box !py-1.5">
                <div v-for="(t, i) in day.todos" :key="i" class="row">
                  <span class="prio" :class="t.priority">{{ PRIORITY_LABEL[t.priority] }}</span>
                  <span class="flex-1 min-w-0">
                    <span class="text-[14px]">{{ t.title }}</span>
                    <span v-if="t.due || t.source" class="block text-[12px] text-ink-3">{{ [t.due ? `${t.due} 前` : '', t.source ? `来自${t.source}` : ''].filter(Boolean).join(' · ') }}</span>
                  </span>
                </div>
              </div>
            </template>

            <div class="mx-4 mt-3 flex items-center gap-2">
              <span class="flex-1 text-[12px] text-ink-3">{{ day.via === 'hub' ? '云端' : '本机' }}排的 · {{ listTime(day.at) }}<template v-if="day.model"> · {{ day.model }}</template></span>
              <van-button size="small" round :loading="!!busy" loading-text="在排…" data-testid="planner-redo" @click="generate({ day: true, week: false })">重排今天</van-button>
            </div>
          </template>

          <div v-if="run" class="mx-4 mt-3">
            <button type="button" class="text-[12.5px] text-ink-3" @click="showSources = !showSources">
              查了 {{ run.sources.length }} 次{{ run.errors.length ? `，${run.errors.length} 处没成` : '' }} · {{ showSources ? '收起' : '看看' }}
            </button>
            <div v-if="showSources" class="card-box !p-3 mt-1.5">
              <p v-for="(e, i) in run.errors" :key="`e${i}`" class="text-[12.5px] text-bad my-1">{{ e }}</p>
              <div v-for="(src, i) in run.sources" :key="i" class="src">
                <span :class="src.ok ? 'i-lucide-check text-accent-ink' : 'i-lucide-x text-bad'" class="shrink-0 mt-0.5" />
                <span class="flex-1 min-w-0">
                  <span class="text-[12.5px]">「{{ src.server }}」{{ src.tool }}</span>
                  <span class="text-[11.5px] text-ink-3"> {{ src.round ? `第 ${src.round} 轮` : '每次都查' }}{{ src.ok ? ` · ${src.chars} 字` : '' }}</span>
                  <span class="block text-[11.5px] text-ink-3 break-all">{{ src.args }}</span>
                  <span v-if="src.error" class="block text-[11.5px] text-bad">{{ src.error }}</span>
                </span>
              </div>
            </div>
          </div>
        </template>

        <!-- 这周 -->
        <template v-else>
          <div v-if="!week" class="mx-4 mt-3 card-box text-center">
            <div class="text-[14.5px] font-600">这周的计划还没排</div>
            <p class="text-[12.5px] text-ink-3 mt-1 mb-3">按这周的日程、邮件里的截止时间和你写的情况排</p>
            <van-button type="primary" round size="small" :loading="!!busy" loading-text="在排…" @click="generate({ week: true, day: false })">排这周</van-button>
          </div>
          <template v-else>
            <div class="mx-4 mt-3 card-box">
              <div class="text-[12.5px] text-ink-3 num">{{ week.weekStart }} 开始</div>
              <div class="text-[16px] font-700 mt-1 leading-snug">{{ week.focus || '这周的计划' }}</div>
            </div>
            <div class="group-title">每天</div>
            <div class="mx-4 card-box !py-1.5">
              <div v-for="d in week.days" :key="d.date" class="row" :class="{ now: d.date === today }">
                <span class="time"><span class="block text-[13.5px] font-600">{{ WEEKDAY_LABEL[d.weekday] }}</span><span class="text-[11px] text-ink-3 num">{{ d.date.slice(5) }}</span></span>
                <span class="flex-1 min-w-0">
                  <span class="text-[14px]">{{ d.focus || '没有安排' }}</span>
                  <span v-if="d.events.length" class="block text-[12px] text-ink-3">日程：{{ d.events.join('；') }}</span>
                  <span v-if="d.todos.length" class="block text-[12px] text-ink-2">要做：{{ d.todos.join('；') }}</span>
                </span>
              </div>
            </div>
            <template v-if="week.deadlines.length">
              <div class="group-title">截止的事</div>
              <div class="mx-4 card-box !py-1.5">
                <div v-for="(d, i) in week.deadlines" :key="i" class="row">
                  <span class="time num text-[12.5px]">{{ d.date }}</span>
                  <span class="flex-1 min-w-0 text-[14px]">{{ d.title }}<span v-if="d.source" class="text-[12px] text-ink-3"> · 来自{{ d.source }}</span></span>
                </div>
              </div>
            </template>
            <template v-if="week.goals.length || week.tips.length">
              <div class="group-title">这周要完成</div>
              <div class="mx-4 card-box">
                <p v-for="(g, i) in week.goals" :key="`g${i}`" class="text-[14px] my-1">· {{ g }}</p>
                <p v-for="(t, i) in week.tips" :key="`t${i}`" class="text-[12.5px] text-ink-3 my-1">{{ t }}</p>
              </div>
            </template>
            <div class="mx-4 mt-3 flex items-center gap-2">
              <span class="flex-1 text-[12px] text-ink-3">{{ week.via === 'hub' ? '云端' : '本机' }}排的 · {{ listTime(week.at) }}</span>
              <van-button size="small" round :loading="!!busy" loading-text="在排…" @click="generate({ week: true, day: false })">重排这周</van-button>
            </div>
          </template>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.card-box {
  padding: 14px;
  border-radius: 18px;
  background: var(--surface);
  border: 1px solid var(--border);
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
}
.say {
  display: flex;
  gap: 6px;
  margin: 8px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-2);
}
.item,
.row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 0;
}
.item + .item,
.row + .row {
  border-top: 1px solid var(--border);
}
.item input {
  margin-top: 4px;
}
.item.done .title {
  color: var(--ink-3);
  text-decoration: line-through;
}
.row.now {
  background: var(--accent-soft);
  margin: 0 -8px;
  padding: 8px;
  border-radius: 10px;
}
.time {
  flex-shrink: 0;
  width: 52px;
  font-size: 13px;
  color: var(--ink-2);
}
.prio {
  flex-shrink: 0;
  margin-top: 1px;
  padding: 0 7px;
  border-radius: 6px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 11.5px;
  line-height: 20px;
}
.prio.high {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.src {
  display: flex;
  gap: 6px;
  padding: 5px 0;
}
.src + .src {
  border-top: 1px solid var(--border);
}
</style>
