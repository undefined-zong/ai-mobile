<script setup lang="ts">
import { MOMENT_USER, type Moment, type MomentComment } from '@app/shared';
import { computed } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import PersonaAvatar from '@/components/common/PersonaAvatar.vue';
import PostMedia from '@/components/social/PostMedia.vue';
import { audienceOf, drawMomentImage, reactToMoment, socialPersona, userLike } from '@/services/social';
import { useCharacterStore } from '@/stores/characters';
import { useSocialStore } from '@/stores/social';
import { dividerTime } from '@/utils/time';

/**
 * 朋友圈的一条：头像、名字、正文、图和单据（PostMedia）、位置和时间、点赞和评论。点评论里她说的话就是回复她。
 */
const props = defineProps<{ moment: Moment }>();
const emit = defineEmits<{ (e: 'comment', replyTo?: string): void; (e: 'more'): void }>();

const chars = useCharacterStore();
const social = useSocialStore();

const author = computed(() => (props.moment.authorId === MOMENT_USER ? null : chars.byId(props.moment.authorId)));
const me = computed(() => socialPersona());
const mine = computed(() => props.moment.authorId === MOMENT_USER);
const name = (id: string) => (id === MOMENT_USER ? me.value.name : (chars.byId(id)?.name ?? '已删除的角色'));
const liked = computed(() => props.moment.likes.includes(MOMENT_USER));
/** 正在画的那几张图 */
const drawing = computed(() => props.moment.images.map((_, i) => i).filter((i) => social.busy[`image:${props.moment.id}:${i}`]));

/** 谁看得到（你发的、只给一部分角色看时写出来） */
const audience = computed(() => {
  if (!mine.value || props.moment.visibleTo === null) return '';
  const ids = audienceOf(props.moment);
  return ids.length ? `仅 ${ids.map(name).join('、')} 可见` : '仅自己可见';
});

/** 正在回应的角色（"苏晚正在看…"） */
const reacting = computed(() => chars.list.filter((c) => social.busy[`react:${props.moment.id}:${c.id}`]));
/** 没回应成的角色和原因 */
const failed = computed(() => chars.list.map((c) => ({ c, reason: social.failures[`react:${props.moment.id}:${c.id}`] })).filter((x) => x.reason));

/** 重试：你最后说的话在她最后一句之后，就是让她回你；否则是让她看这条朋友圈 */
function retry(characterId: string) {
  const who = props.moment.comments.map((c) => c.authorId);
  void reactToMoment(props.moment.id, characterId, who.lastIndexOf(MOMENT_USER) > who.lastIndexOf(characterId) ? 'reply' : 'new');
}

function reply(c: MomentComment) {
  // 点她的评论 = 回复她；点自己的评论不做什么
  if (c.authorId !== MOMENT_USER) emit('comment', c.authorId);
}
</script>

<template>
  <article class="moment" :data-moment="moment.id">
    <div class="shrink-0">
      <Avatar v-if="author" :character="author" :size="42" />
      <PersonaAvatar v-else-if="mine" :persona="me" :size="42" />
      <span v-else class="gone"><span class="i-lucide-user-round-x" /></span>
    </div>
    <div class="flex-1 min-w-0">
      <div class="name">{{ name(moment.authorId) }}</div>
      <p v-if="moment.text" class="text">{{ moment.text }}</p>

      <PostMedia :images="moment.images" :html="moment.html" :drawing="drawing" :album="moment.authorId === MOMENT_USER ? undefined : { characterId: moment.authorId, scene: 'moments', at: moment.createdAt, place: moment.location, text: moment.text }" :redraw="moment.authorId === MOMENT_USER ? undefined : (i: number) => drawMomentImage(moment.id, i, 'user', { redo: true })" @draw="(i) => drawMomentImage(moment.id, i, 'user')" />

      <div v-if="moment.location" class="location"><span class="i-lucide-map-pin text-[12px]" />{{ moment.location }}</div>

      <div class="meta">
        <span class="truncate">{{ dividerTime(moment.createdAt) }}<template v-if="audience"> · <span class="i-lucide-users-round text-[11px]" /> {{ audience }}</template></span>
        <span class="flex-1" />
        <button type="button" class="act press" :class="{ on: liked }" :aria-pressed="liked" aria-label="点赞" @click="userLike(moment.id)">
          <span :class="liked ? 'i-lucide-heart text-bad' : 'i-lucide-heart'" />
        </button>
        <button type="button" class="act press" aria-label="评论" @click="emit('comment')"><span class="i-lucide-message-circle" /></button>
        <button type="button" class="act press" aria-label="更多" @click="emit('more')"><span class="i-lucide-ellipsis" /></button>
      </div>

      <div v-if="moment.likes.length || moment.comments.length || reacting.length || failed.length" class="social">
        <div v-if="moment.likes.length" class="likes"><span class="i-lucide-heart text-[12px] shrink-0 mt-[3px]" /><span>{{ moment.likes.map(name).join('、') }}</span></div>
        <div v-if="moment.comments.length" class="comments" :class="{ lined: moment.likes.length }">
          <button v-for="c in moment.comments" :key="c.id" type="button" class="comment" @click="reply(c)">
            <b>{{ name(c.authorId) }}</b><template v-if="c.replyTo"> 回复 <b>{{ name(c.replyTo) }}</b></template>：{{ c.text }}
          </button>
        </div>
        <div v-for="c in reacting" :key="c.id" class="typing"><van-loading size="12" />{{ c.name }}正在看…</div>
        <div v-for="f in failed" :key="f.c.id" class="typing warn">
          <span class="line-clamp-2 flex-1 min-w-0">{{ f.c.name }}没回应：{{ f.reason }}</span>
          <button type="button" class="text-accent-ink shrink-0" @click="retry(f.c.id)">重试</button>
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.moment {
  display: flex;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.gone {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  background: var(--panel);
  color: var(--ink-3);
}
.name {
  font-size: 15px;
  font-weight: 600;
  color: var(--accent-ink);
  line-height: 1.3;
}
.text {
  margin: 4px 0 0;
  font-size: 15px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.location {
  display: flex;
  align-items: center;
  gap: 3px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--accent-ink);
}
.meta {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 6px;
  min-width: 0;
  font-size: 12px;
  color: var(--ink-3);
}
.act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 30px;
  border-radius: 8px;
  font-size: 17px;
  color: var(--ink-2);
}
.social {
  margin-top: 6px;
  padding: 7px 10px;
  border-radius: 10px;
  background: var(--panel);
  font-size: 13.5px;
  line-height: 1.55;
}
.likes {
  display: flex;
  gap: 5px;
  color: var(--accent-ink);
}
.comments {
  display: grid;
}
.comments.lined {
  margin-top: 5px;
  padding-top: 5px;
  border-top: 1px solid var(--border);
}
.comment {
  display: block;
  padding: 1px 0;
  text-align: left;
  word-break: break-word;
}
.comment b {
  font-weight: 600;
  color: var(--accent-ink);
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
