<script setup lang="ts">
import type { Community } from '@app/shared';
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import CommunityIcon from '@/components/community/CommunityIcon.vue';
import { communityStatus, createCommunity, membersOf } from '@/services/community';
import { useCommunityStore } from '@/stores/community';
import { countText } from '@/utils/count';

/**
 * 社媒 → 社群：你加入的社群和还没加入的。
 * 顶上搜关键字：边打边筛；回车（或点"搜索"）时一个对应的都没有，就让模型按这个关键字建一个（"社媒 · 社群"预设）。
 */
const store = useCommunityStore();
const router = useRouter();

const query = ref('');
const word = computed(() => query.value.trim());
const status = computed(() => communityStatus());
const results = computed(() => store.search(word.value));
const mine = computed(() => results.value.filter((c) => c.joined));
const others = computed(() => results.value.filter((c) => !c.joined));
const creating = computed(() => !!store.busy.create);
/** 正在建的、上一次没建成的是哪个关键字（换了关键字就不再显示上一次的报错） */
const asked = ref('');
const failure = computed(() => (asked.value === word.value ? store.failures.create : undefined));

const open = (c: Community) => router.push(`/community/${encodeURIComponent(c.id)}`);

async function create() {
  if (!word.value || creating.value) return;
  asked.value = word.value;
  const r = await createCommunity(word.value);
  if (!r.ok) return;
  query.value = '';
  void open(r.community);
}

/** 回车 / 点搜索：有对应的就看结果；一个都没有就按这个关键字建一个 */
function submit() {
  if (word.value && !results.value.length) void create();
}
</script>

<template>
  <Teleport defer to="#social-actions">
    <RouterLink class="icon-btn" to="/me?open=social" aria-label="社媒设置"><span class="i-lucide-settings-2 text-[20px]" /></RouterLink>
  </Teleport>

  <div class="page-scroll" data-page="communities">
    <form class="search" role="search" @submit.prevent="submit">
      <span class="i-lucide-search text-[16px] text-ink-3 shrink-0" />
      <input v-model="query" class="search-input" type="search" autocomplete="off" enterkeyhint="search" placeholder="搜社群：美食、养猫、深夜电台…" aria-label="搜社群" data-testid="community-search" />
      <button v-if="query" type="button" class="clear press" aria-label="清空" @click="query = ''"><span class="i-lucide-x" /></button>
      <van-button round size="small" type="primary" native-type="submit" :disabled="!word" :loading="creating">搜索</van-button>
    </form>

    <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="hint">
      <span class="i-lucide-plug-zap shrink-0" />
      <span class="flex-1 min-w-0">{{ status.reason }}。接通后才能按关键字建新的社群、让网友发帖和回应你。</span>
      <span class="i-lucide-chevron-right shrink-0" />
    </RouterLink>

    <!-- 搜不到：按这个关键字建一个 -->
    <section v-if="word && !results.length" class="none" data-testid="community-none">
      <template v-if="creating">
        <van-loading size="22" />
        <div class="text-[15px] font-600 mt-3">正在建「{{ asked }}」的社群…</div>
        <p class="sub">模型在写它的名字、简介和风气，建好就带你进去。</p>
      </template>
      <template v-else>
        <span class="i-lucide-search-x text-[36px] text-ink-3" />
        <div class="text-[15px] font-600 mt-3">还没有「{{ word }}」的社群</div>
        <p v-if="failure" class="sub text-warn">没建成：{{ failure }}</p>
        <p v-else class="sub">按回车或点下面的按钮，让模型按这个关键字建一个：名字、简介、风气都由它写，建好以后能改。</p>
        <van-button round size="small" type="primary" class="mt-4" :disabled="!status.ok" data-testid="community-create" @click="create">{{ failure ? '再试一次' : `建一个「${word}」社群` }}</van-button>
      </template>
    </section>

    <template v-for="group in [{ title: '我加入的', list: mine }, { title: word ? '还没加入的' : '发现', list: others }]" :key="group.title">
      <template v-if="group.list.length">
        <div class="group-title">{{ group.title }}</div>
        <button v-for="c in group.list" :key="c.id" type="button" class="c-row press" :data-community="c.id" @click="open(c)">
          <CommunityIcon :community="c" :size="50" />
          <span class="flex-1 min-w-0">
            <span class="flex items-center gap-1.5 min-w-0">
              <span class="c-name truncate">{{ c.name }}</span>
              <span v-if="store.unreadOf(c.id) && c.joined" class="badge num">{{ store.unreadOf(c.id) > 99 ? '99+' : store.unreadOf(c.id) }}</span>
            </span>
            <span class="c-desc line-clamp-2">{{ c.description }}</span>
            <span class="c-meta">
              <span>{{ countText(c.memberCount) }} 成员 · {{ store.timelineOf(c.id).length }} 帖</span>
              <span v-if="membersOf(c).length" class="c-friends">
                <Avatar v-for="m in membersOf(c)" :key="m.id" :character="m" :size="18" />
                <span>互关</span>
              </span>
            </span>
          </span>
          <span class="i-lucide-chevron-right text-ink-3 shrink-0" />
        </button>
      </template>
    </template>

    <!-- 搜到了，但不是想要的那个 -->
    <p v-if="word && results.length" class="foot">
      没有想要的？
      <button type="button" class="text-accent-ink" :disabled="creating || !status.ok" @click="create">{{ creating ? '正在建…' : `按「${word}」新建一个` }}</button>
      <span v-if="failure" class="block text-warn mt-1">没建成：{{ failure }}</span>
    </p>
    <p v-else-if="!word && !store.communities.length" class="foot">还没有社群。在上面搜一个关键字，没有对应的就会建一个。</p>
    <p v-else-if="!word" class="foot">搜一个关键字：没有对应的社群，就按它建一个。</p>
  </div>
</template>

<style scoped>
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 6px 16px 4px;
  padding: 5px 6px 5px 12px;
  border-radius: 99px;
  background: var(--panel);
  border: 1px solid var(--border);
}
.search-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  outline: none;
  font-size: 14.5px;
  appearance: none;
  -webkit-appearance: none;
}
.search-input::-webkit-search-cancel-button {
  display: none;
}
.clear {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  color: var(--ink-3);
}
.hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 16px 4px;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.5;
  text-decoration: none;
}
.none {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 44px 32px 20px;
  text-align: center;
}
.sub {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-3);
}
.group-title {
  padding: 16px 20px 6px;
}
.c-row {
  display: flex;
  align-items: center;
  gap: 12px;
  width: calc(100% - 24px);
  margin: 0 12px 8px;
  padding: 12px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
  text-align: left;
}
.c-name {
  font-size: 15.5px;
  font-weight: 600;
}
.c-desc {
  margin-top: 2px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-2);
}
.c-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--ink-3);
}
.c-friends {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 1px 7px 1px 2px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.badge {
  flex-shrink: 0;
  min-width: 17px;
  height: 17px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--bad);
  color: #fff;
  font-size: 10.5px;
  line-height: 17px;
  text-align: center;
}
.foot {
  margin: 0;
  padding: 14px 24px 28px;
  text-align: center;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-3);
}
</style>
