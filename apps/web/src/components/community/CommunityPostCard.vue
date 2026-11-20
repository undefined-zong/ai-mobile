<script setup lang="ts">
import { isNetizen, MOMENT_USER, type CommunityComment, type CommunityPost } from '@app/shared';
import { computed, ref } from 'vue';
import AuthorAvatar from '@/components/community/AuthorAvatar.vue';
import PostMedia from '@/components/social/PostMedia.vue';
import { communityNames, drawPostImage, memberReact, netizensReact, userBumpPost, userLikePost } from '@/services/community';
import { useCharacterStore } from '@/stores/characters';
import { useCommunityStore } from '@/stores/community';
import { dividerTime } from '@/utils/time';

/**
 * 社群里的一帖：发帖人（你邀请进来的角色名字后面有"互关"）、标题、正文、图和卡片（PostMedia）、
 * 赞 / 顶 / 回复，下面是回复。点别人的回复就是回复那个人。
 */
const props = defineProps<{ post: CommunityPost }>();
const emit = defineEmits<{ (e: 'comment', replyTo?: string): void; (e: 'more'): void }>();

const chars = useCharacterStore();
const store = useCommunityStore();

/** 回复多的时候先收起来，只显示最后这几条 */
const COLLAPSED = 4;
const expanded = ref(false);

const community = computed(() => store.byId(props.post.communityId));
const name = computed(() => communityNames());
/** 和你互关：你邀请进这个社群的角色 */
const mutual = (id: string) => !!community.value?.members.includes(id) && !!chars.byId(id);
const liked = computed(() => props.post.liked.includes(MOMENT_USER));
const bumped = computed(() => props.post.bumped.includes(MOMENT_USER));
const likes = computed(() => props.post.likes + props.post.liked.length);
const bumps = computed(() => props.post.bumps + props.post.bumped.length);
const drawing = computed(() => props.post.images.map((_, i) => i).filter((i) => store.busy[`image:${props.post.id}:${i}`]));
const shown = computed(() => (expanded.value ? props.post.comments : props.post.comments.slice(-COLLAPSED)));
const hiddenCount = computed(() => props.post.comments.length - shown.value.length);

/** 认识的人里谁点了赞、顶了帖（"苏晚 赞了、顶了"） */
const friends = computed(() =>
  [...new Set([...props.post.liked, ...props.post.bumped])]
    .filter((id) => id !== MOMENT_USER && chars.byId(id))
    .map((id) => `${name.value(id)} ${[props.post.liked.includes(id) ? '赞了' : '', props.post.bumped.includes(id) ? '顶了' : ''].filter(Boolean).join('、')}`),
);

/** 正在回应的：网友、你邀请进来的角色 */
const reacting = computed(() => [
  ...(store.busy[`react:${props.post.id}`] ? ['网友'] : []),
  ...chars.list.filter((c) => store.busy[`react:${props.post.id}:${c.id}`]).map((c) => c.name),
]);
/** 没回应成的和原因 */
const failed = computed(() => [
  ...(store.failures[`react:${props.post.id}`] ? [{ who: '网友', id: null as string | null, reason: store.failures[`react:${props.post.id}`] as string }] : []),
  ...chars.list.flatMap((c) => {
    const reason = store.failures[`react:${props.post.id}:${c.id}`];
    return reason ? [{ who: c.name, id: c.id as string | null, reason }] : [];
  }),
]);

/** 重试：你回过话就是让对方回你；没回过（你刚发的帖）是让他们看这一帖 */
function retry(characterId: string | null) {
  const mine = [...props.post.comments].reverse().find((c) => c.authorId === MOMENT_USER);
  if (characterId) {
    const who = props.post.comments.map((c) => c.authorId);
    void memberReact(props.post.id, characterId, who.lastIndexOf(MOMENT_USER) > who.lastIndexOf(characterId) ? 'reply' : 'new');
  } else if (mine) void netizensReact(props.post.id, 'reply', mine.replyTo && isNetizen(mine.replyTo) ? mine.replyTo : undefined);
  else void netizensReact(props.post.id, 'new');
}

function reply(c: CommunityComment) {
  // 点别人的回复 = 回复那个人；点自己的不做什么
  if (c.authorId !== MOMENT_USER) emit('comment', c.authorId);
}
</script>

<template>
  <article class="post" :data-post="post.id">
    <header class="head">
      <AuthorAvatar :author-id="post.authorId" :size="38" />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-1.5 min-w-0">
          <span class="name truncate" :class="{ netizen: isNetizen(post.authorId) }">{{ name(post.authorId) }}</span>
          <span v-if="mutual(post.authorId)" class="mutual">互关</span>
          <span v-else-if="post.authorId === MOMENT_USER" class="mutual me">我</span>
        </div>
        <div class="text-[11.5px] text-ink-3 leading-tight mt-0.5">{{ dividerTime(post.createdAt) }}</div>
      </div>
      <button type="button" class="act press" aria-label="更多" @click="emit('more')"><span class="i-lucide-ellipsis" /></button>
    </header>

    <h3 v-if="post.title" class="title">{{ post.title }}</h3>
    <p v-if="post.text" class="text">{{ post.text }}</p>
    <PostMedia :images="post.images" :html="post.html" :drawing="drawing" :album="{ characterId: chars.byId(post.authorId) ? post.authorId : null, scene: 'community', at: post.createdAt, text: post.title || post.text }" :redraw="(i: number) => drawPostImage(post.id, i, 'user', { redo: true })" @draw="(i) => drawPostImage(post.id, i, 'user')" />

    <div class="bar">
      <button type="button" class="stat press" :class="{ on: liked }" :aria-pressed="liked" :aria-label="`点赞，现在 ${likes} 个`" @click="userLikePost(post.id)">
        <span :class="liked ? 'i-lucide-heart text-bad' : 'i-lucide-heart'" /><span class="num">{{ likes }}</span>
      </button>
      <button type="button" class="stat press" :class="{ on: bumped }" :aria-pressed="bumped" :aria-label="`顶帖，现在 ${bumps} 次`" @click="userBumpPost(post.id)">
        <span class="i-lucide-arrow-big-up" /><span>顶</span><span class="num">{{ bumps }}</span>
      </button>
      <button type="button" class="stat press" :aria-label="`回复，现在 ${post.comments.length} 条`" @click="emit('comment')">
        <span class="i-lucide-message-circle" /><span class="num">{{ post.comments.length }}</span>
      </button>
    </div>

    <div v-if="friends.length || post.comments.length || reacting.length || failed.length" class="thread">
      <div v-if="friends.length" class="friends"><span class="i-lucide-heart-handshake text-[13px] shrink-0 mt-[3px]" /><span>{{ friends.join('；') }}</span></div>
      <button v-if="hiddenCount > 0" type="button" class="more-comments" @click="expanded = true">展开更早的 {{ hiddenCount }} 条回复</button>
      <button v-for="c in shown" :key="c.id" type="button" class="comment" @click="reply(c)">
        <b :class="{ netizen: isNetizen(c.authorId) }">{{ name(c.authorId) }}</b><span v-if="mutual(c.authorId)" class="mutual small">互关</span><template v-if="c.replyTo"> 回复 <b :class="{ netizen: isNetizen(c.replyTo) }">{{ name(c.replyTo) }}</b></template>：{{ c.text }}
      </button>
      <div v-for="who in reacting" :key="who" class="typing"><van-loading size="12" />{{ who }}正在看…</div>
      <div v-for="f in failed" :key="f.who" class="typing warn">
        <span class="line-clamp-2 flex-1 min-w-0">{{ f.who }}没回应：{{ f.reason }}</span>
        <button type="button" class="text-accent-ink shrink-0" @click="retry(f.id)">重试</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.post {
  margin: 10px 12px 0;
  padding: 14px 14px 10px;
  border-radius: var(--radius);
  background: var(--surface);
  border: 1px solid var(--border);
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.name {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--accent-ink);
  line-height: 1.3;
}
.name.netizen {
  color: var(--ink-2);
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
  line-height: 1;
  box-shadow: inset 0 0 0 1px var(--accent-line);
}
.mutual.me {
  background: var(--panel);
  color: var(--ink-3);
  box-shadow: none;
}
.mutual.small {
  height: 15px;
  margin-left: 4px;
  padding: 0 5px;
  font-size: 10px;
  vertical-align: 1px;
}
.title {
  margin: 10px 0 0;
  font-size: 16px;
  font-weight: 700;
  line-height: 1.4;
  word-break: break-word;
}
.text {
  margin: 6px 0 0;
  font-size: 14.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.bar {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
}
.stat {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 32px;
  padding: 0 10px;
  border-radius: 99px;
  background: var(--panel);
  color: var(--ink-2);
  font-size: 13px;
}
.stat [class^='i-'] {
  font-size: 16px;
}
.stat.on {
  background: var(--accent-soft);
  color: var(--accent-ink);
}
.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 30px;
  border-radius: 8px;
  font-size: 17px;
  color: var(--ink-3);
}
.thread {
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--panel);
  font-size: 13.5px;
  line-height: 1.55;
}
.friends {
  display: flex;
  gap: 5px;
  padding-bottom: 5px;
  margin-bottom: 5px;
  border-bottom: 1px solid var(--border);
  color: var(--accent-ink);
}
.friends:last-child {
  padding-bottom: 0;
  margin-bottom: 0;
  border-bottom: 0;
}
.more-comments {
  display: block;
  padding: 1px 0 4px;
  font-size: 12.5px;
  color: var(--accent-ink);
}
.comment {
  display: block;
  width: 100%;
  padding: 2px 0;
  text-align: left;
  word-break: break-word;
}
.comment b {
  font-weight: 600;
  color: var(--accent-ink);
}
.comment b.netizen {
  color: var(--ink-2);
}
.typing {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--ink-3);
}
.typing.warn {
  color: var(--warn);
}
</style>
