<script setup lang="ts">
import { COMMUNITY_SORTS, isNetizen, MOMENT_USER, type CommunityPost } from '@app/shared';
import { showConfirmDialog, showToast } from 'vant';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Avatar from '@/components/common/Avatar.vue';
import CommunityComposer from '@/components/community/CommunityComposer.vue';
import CommunityEdit from '@/components/community/CommunityEdit.vue';
import CommunityIcon from '@/components/community/CommunityIcon.vue';
import CommunityMembers from '@/components/community/CommunityMembers.vue';
import CommunityPostCard from '@/components/community/CommunityPostCard.vue';
import PageHeader from '@/layouts/PageHeader.vue';
import { communityNames, communityStatus, membersOf, refreshCommunity, userReply } from '@/services/community';
import { useCommunityStore } from '@/stores/community';
import { useHubStore } from '@/stores/hub';
import { countText } from '@/utils/count';

/**
 * 一个社群：顶上是它的介绍、加入 / 邀请角色，下面是帖子（网友的、你邀请进来的角色的、你的）。
 * - 右上角：看看新帖（让网友现在发一批）、⋯（改介绍、邀请角色、退出、删除）；
 * - 加入以后：云端每天在随机的时间替网友发帖，你能发帖（右下角）、邀请角色；
 * - 帖子按"最近顶起 / 最新发布"排（顶帖把帖子顶上来）。
 */
const route = useRoute();
const router = useRouter();
const store = useCommunityStore();
const hub = useHubStore();

const id = computed(() => String(route.params.id ?? ''));
const community = computed(() => store.byId(id.value));
const posts = computed(() => store.postsOf(id.value));
const members = computed(() => (community.value ? membersOf(community.value) : []));
const status = computed(() => communityStatus());
const refreshing = computed(() => !!store.busy[`feed:${id.value}`]);
const refreshFailure = computed(() => store.failures[`feed:${id.value}`]);

const composing = ref(false);
const inviting = ref(false);
const editing = ref(false);
const moreOpen = ref(false);

// 看过了：进来、离开、停在这页时来了新的，都算看过
const seen = () => store.markRead(id.value);
onMounted(seen);
onBeforeUnmount(seen);
watch(() => store.unreadOf(id.value), (n) => n && seen());

async function refresh() {
  const r = await refreshCommunity(id.value);
  if (!r.ok) showToast({ message: r.reason.slice(0, 140), duration: 3000 });
}
// 刚建好、还一帖都没有的社群：进来先让网友发第一批
onMounted(() => {
  if (community.value && !posts.value.length && status.value.ok) void refreshCommunity(id.value);
});

const cloudNote = computed(() => {
  if (!community.value?.joined) return '加入以后，云端每天在随机的时间替网友发帖；你能发帖、邀请角色进来。没加入也能点右上角"看看新帖"。';
  if (!hub.connected) return '云端还没接通：App 开着时按排好的随机时间更新，关着时不更新。在"我的 → 云端与同步"接通自己的 Worker 后，App 关着也会更新。';
  if (!hub.supportsCommunity) return '云端的 Worker 是旧版，还不会更新社群：部署最新的 Worker 和数据库迁移后，App 关着也会更新。';
  const failed = hub.communityErrors.find((e) => e.communityId === id.value);
  if (failed) return `云端有一批没发出来：${failed.reason}`;
  return '云端已接通：App 关着网友也会每天在随机的时间发帖（每天几次、每次几帖在"我的 → 社媒"里改）。';
});

function join() {
  store.setJoined(id.value, true);
  showToast('加入了：云端会每天替网友发帖');
}

// —— 回帖 ——
const commenting = ref<{ post: CommunityPost; replyTo?: string } | null>(null);
const draft = ref('');
const input = ref<HTMLInputElement | null>(null);
const commentHint = computed(() => {
  const c = commenting.value;
  if (!c) return '';
  const target = c.replyTo ?? (c.post.authorId === MOMENT_USER ? undefined : c.post.authorId);
  return target ? `回复 ${communityNames()(target)}` : '回帖';
});
function openComment(post: CommunityPost, replyTo?: string) {
  commenting.value = { post, replyTo };
  draft.value = '';
  void nextTick(() => input.value?.focus());
}
function sendComment() {
  const c = commenting.value;
  if (!c || !draft.value.trim()) return;
  userReply(c.post.id, draft.value, c.replyTo);
  commenting.value = null;
}

// —— 删帖 ——
async function removePost(p: CommunityPost) {
  const known = !isNetizen(p.authorId);
  try {
    await showConfirmDialog({ title: '删掉这一帖？', message: `连同下面的赞、顶和回复一起删掉。${known ? 'Ta们已经记住的不会跟着忘，要忘掉去"回忆 → 记忆本"里删。' : ''}`, confirmButtonText: '删掉' });
  } catch {
    return;
  }
  store.removePost(p.id);
}

// —— 右上角 ⋯ ——
const actions = computed(() => [
  { name: '改社群的介绍', subname: '名字、图标、简介、风气、标签', key: 'edit' },
  ...(community.value?.joined ? [{ name: '邀请角色', subname: '进来以后和你互关，会自己发帖、回应你', key: 'invite' }, { name: '退出社群', subname: '不再每天更新；帖子都还在', key: 'leave' }] : [{ name: '加入社群', key: 'join' }]),
  { name: '删除社群', color: 'var(--bad)', key: 'delete' },
]);
async function onAction(a: { key: string }) {
  const c = community.value;
  if (!c) return;
  if (a.key === 'edit') editing.value = true;
  else if (a.key === 'invite') inviting.value = true;
  else if (a.key === 'join') join();
  else if (a.key === 'leave') store.setJoined(c.id, false);
  else if (a.key === 'delete') {
    try {
      await showConfirmDialog({ title: `删除「${c.name}」？`, message: `连同里面的 ${posts.value.length} 帖一起删掉。${c.seedFile ? '这是自带的社群，删了不会自己回来。' : ''}Ta们已经记住的不会跟着忘。`, confirmButtonText: '删除', confirmButtonColor: 'var(--bad)' });
    } catch {
      return;
    }
    store.removeCommunity(c.id);
    void router.replace('/social/communities');
  }
}
</script>

<template>
  <div v-if="community" class="page" data-page="community">
    <PageHeader :title="community.name" :subtitle="`${countText(community.memberCount)} 成员${community.joined ? ' · 已加入' : ''}`" fallback="/social/communities">
      <template #right>
        <button class="icon-btn" aria-label="看看新帖" data-testid="community-refresh" :disabled="refreshing" @click="refresh">
          <van-loading v-if="refreshing" size="18" />
          <span v-else class="i-lucide-refresh-cw text-[19px]" />
        </button>
        <button class="icon-btn" aria-label="更多" @click="moreOpen = true"><span class="i-lucide-ellipsis text-[20px]" /></button>
      </template>
    </PageHeader>

    <div class="page-scroll pb-24">
      <section class="hero" :style="{ '--c': community.color }">
        <div class="flex items-center gap-3">
          <CommunityIcon :community="community" :size="58" />
          <div class="flex-1 min-w-0">
            <h1 class="h-name">{{ community.name }}</h1>
            <div class="h-meta num">{{ countText(community.memberCount) }} 成员 · {{ posts.length }} 帖</div>
          </div>
          <van-button v-if="!community.joined" round size="small" type="primary" data-testid="community-join" @click="join">加入</van-button>
          <span v-else class="joined"><span class="i-lucide-check text-[13px]" />已加入</span>
        </div>
        <p class="h-desc">{{ community.description }}</p>
        <div v-if="community.tags.length" class="h-tags">
          <span v-for="t in community.tags" :key="t" class="h-tag">#{{ t }}</span>
        </div>

        <div v-if="community.joined" class="members">
          <span v-for="m in members" :key="m.id" class="member">
            <Avatar :character="m" :size="24" />
            <span class="truncate">{{ m.name }}</span>
            <span class="mutual">互关</span>
          </span>
          <button type="button" class="invite press" data-testid="community-invite" @click="inviting = true">
            <span class="i-lucide-user-round-plus text-[14px]" />{{ members.length ? '邀请' : '邀请角色加入' }}
          </button>
        </div>
      </section>

      <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="hint">
        <span class="i-lucide-plug-zap shrink-0" />
        <span class="flex-1 min-w-0">{{ status.reason }}。接通后网友才会发帖、回应你。</span>
        <span class="i-lucide-chevron-right shrink-0" />
      </RouterLink>

      <div class="sortbar">
        <div class="sorts" role="group" aria-label="帖子怎么排">
          <button v-for="(label, key) in COMMUNITY_SORTS" :key="key" type="button" class="sort" :class="{ on: store.settings.sort === key }" :aria-pressed="store.settings.sort === key" @click="store.settings.sort = key">{{ label }}</button>
        </div>
        <span class="flex-1" />
        <span v-if="refreshing" class="flex items-center gap-1.5 text-[12px] text-ink-3"><van-loading size="12" />网友正在发帖…</span>
      </div>

      <CommunityPostCard v-for="p in posts" :key="p.id" :post="p" @comment="(replyTo) => openComment(p, replyTo)" @more="removePost(p)" />

      <div v-if="!posts.length" class="empty">
        <span class="i-lucide-messages-square text-[40px] text-ink-3" />
        <div class="text-[15px] font-600 mt-3">{{ refreshing ? '网友正在发第一批帖子…' : '这里还没有帖子' }}</div>
        <p class="text-[13px] text-ink-3 leading-relaxed mt-1 mb-0">{{ refreshFailure ? `没发出来：${refreshFailure}` : '点右上角的"看看新帖"，让网友发几帖。' }}</p>
        <van-button v-if="!refreshing" round size="small" type="primary" class="mt-4" :disabled="!status.ok" @click="refresh">看看新帖</van-button>
      </div>
      <p v-else-if="refreshFailure" class="foot text-warn">没刷出新帖：{{ refreshFailure }}</p>
      <p class="foot">{{ cloudNote }}</p>
    </div>

    <button v-if="community.joined" type="button" class="fab press" aria-label="发帖" data-testid="community-compose" @click="composing = true">
      <span class="i-lucide-pen-line text-[20px]" />
    </button>

    <van-action-sheet v-model:show="moreOpen" :actions="actions" cancel-text="取消" close-on-click-action @select="onAction" />

    <!-- 发帖 -->
    <van-popup v-model:show="composing" position="bottom" round teleport="body" :style="{ maxHeight: '92%' }">
      <CommunityComposer v-if="composing" :community="community" @close="composing = false" @sent="composing = false" />
    </van-popup>

    <!-- 邀请角色 -->
    <van-popup v-model:show="inviting" position="bottom" round teleport="body" :style="{ maxHeight: '86%' }">
      <CommunityMembers v-if="inviting" :community="community" />
    </van-popup>

    <!-- 改介绍 -->
    <van-popup v-model:show="editing" position="bottom" round teleport="body" :style="{ maxHeight: '92%' }">
      <CommunityEdit v-if="editing" :community="community" @close="editing = false" />
    </van-popup>

    <!-- 回帖 -->
    <van-popup :show="!!commenting" position="bottom" round teleport="body" @update:show="(v: boolean) => !v && (commenting = null)">
      <form class="comment-bar" @submit.prevent="sendComment">
        <input ref="input" v-model="draft" class="input flex-1" autocomplete="off" enterkeyhint="send" :placeholder="commentHint" :aria-label="commentHint" data-testid="community-comment-input" />
        <van-button round type="primary" size="small" native-type="submit" :disabled="!draft.trim()">发送</van-button>
      </form>
    </van-popup>
  </div>

  <div v-else class="page" data-page="community-missing">
    <PageHeader title="社群" fallback="/social/communities" />
    <div class="empty">
      <span class="i-lucide-search-x text-[40px] text-ink-3" />
      <div class="text-[15px] font-600 mt-3">找不到这个社群</div>
      <p class="text-[13px] text-ink-3 leading-relaxed mt-1 mb-0">可能已经被删掉了。</p>
      <van-button round size="small" class="mt-4" to="/social/communities" replace>回到社群</van-button>
    </div>
  </div>
</template>

<style scoped>
.hero {
  margin: 12px 12px 0;
  padding: 16px;
  border-radius: var(--radius-lg);
  background: var(--surface);
  border: 1px solid var(--border);
}
@supports (background: color-mix(in srgb, red 10%, transparent)) {
  .hero {
    background: linear-gradient(165deg, color-mix(in srgb, var(--c) 16%, var(--surface)), var(--surface) 62%);
    border-color: color-mix(in srgb, var(--c) 26%, var(--border));
  }
}
.h-name {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  line-height: 1.3;
  word-break: break-word;
}
.h-meta {
  margin-top: 2px;
  font-size: 12.5px;
  color: var(--ink-3);
}
.joined {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 28px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  white-space: nowrap;
}
.h-desc {
  margin: 12px 0 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: var(--ink-2);
}
.h-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  margin-top: 8px;
}
.h-tag {
  font-size: 12px;
  color: var(--ink-3);
}
.members {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.member,
.invite {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 100%;
  height: 32px;
  border-radius: 99px;
  font-size: 13px;
}
.member {
  padding: 0 6px 0 4px;
  background: var(--panel);
}
.invite {
  padding: 0 12px;
  color: var(--accent-ink);
  border: 1px dashed var(--accent-line);
}
.mutual {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  height: 17px;
  padding: 0 6px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent-ink);
  font-size: 10.5px;
  font-weight: 600;
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.hint {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 12px 0;
  padding: 9px 12px;
  border-radius: 12px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 12.5px;
  line-height: 1.5;
  text-decoration: none;
}
.sortbar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 14px 16px 0;
}
.sorts {
  display: inline-flex;
  gap: 4px;
}
.sort {
  height: 28px;
  padding: 0 11px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-3);
  font-size: 12.5px;
}
.sort.on {
  background: var(--accent-soft);
  color: var(--ink);
  font-weight: 600;
  box-shadow: inset 0 0 0 1.5px var(--accent-line);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 56px 32px 12px;
  text-align: center;
}
.foot {
  margin: 0;
  padding: 16px 24px 0;
  text-align: center;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.fab {
  position: absolute;
  right: 18px;
  bottom: calc(var(--safe-bottom) + 22px);
  z-index: 10;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: var(--accent);
  color: var(--on-accent);
  box-shadow: var(--shadow);
}
.comment-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 14px calc(var(--safe-bottom) + 12px);
}
</style>
