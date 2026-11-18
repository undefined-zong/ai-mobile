<script setup lang="ts">
import type { Character, Community } from '@app/shared';
import { showToast } from 'vant';
import { computed } from 'vue';
import Avatar from '@/components/common/Avatar.vue';
import { communityStatus, inviteMember, memberPost, removeMember } from '@/services/community';
import { useCharacterStore } from '@/stores/characters';
import { useCommunityStore } from '@/stores/community';

/**
 * 邀请角色加入这个社群：进来以后她和你互关，会自己发帖（每天最多几帖在"我的 → 社媒"里改）、回应你的帖子，
 * 这件事和她在社群里的帖子都写进她的记忆。也能把她请出去、让她现在发一帖。
 */
const props = defineProps<{ community: Community }>();

const chars = useCharacterStore();
const store = useCommunityStore();
const status = computed(() => communityStatus());

const isMember = (c: Character) => props.community.members.includes(c.id);
const key = (c: Character) => `member:${props.community.id}:${c.id}`;

async function post(c: Character) {
  const r = await memberPost(props.community.id, c.id);
  if (!r.ok) showToast({ message: r.reason.slice(0, 140), duration: 3000 });
}
</script>

<template>
  <div class="sheet" data-sheet="community-members">
    <div class="sheet-title">邀请角色加入「{{ community.name }}」</div>
    <p class="note">进来以后Ta在这个社群里和你互相关注：会自己发帖{{ store.settings.memberPerDay ? `（每天最多 ${store.settings.memberPerDay} 帖）` : '（现在设的是不自己发，只在你点的时候发）' }}、回应你发的帖。邀请这件事、Ta发的帖、你发的帖都会写进Ta的记忆，聊天时Ta知道你们一起在这个社群里。</p>
    <RouterLink v-if="!status.ok" to="/me/api?feature=social" class="warn-line">{{ status.reason }} →</RouterLink>

    <div class="grid gap-2 mt-3">
      <div v-for="c in chars.list" :key="c.id" class="row">
        <Avatar :character="c" :size="38" />
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-1.5 min-w-0">
            <span class="text-[14.5px] font-600 truncate">{{ c.name }}</span>
            <span v-if="isMember(c)" class="mutual">互关</span>
          </div>
          <div class="text-[12px] line-clamp-2" :class="store.failures[key(c)] ? 'text-warn' : 'text-ink-3'">
            {{ store.failures[key(c)] ?? (isMember(c) ? '在社群里' : '还没邀请') }}
          </div>
        </div>
        <template v-if="isMember(c)">
          <van-button size="small" round :loading="!!store.busy[key(c)]" :disabled="!status.ok" @click="post(c)">发一帖</van-button>
          <van-button size="small" round @click="removeMember(community.id, c.id)">请出</van-button>
        </template>
        <van-button v-else size="small" round type="primary" :data-testid="`invite-${c.id}`" @click="inviteMember(community.id, c.id)">邀请</van-button>
      </div>
      <p v-if="!chars.list.length" class="note">还没有角色。去"我的 → 角色卡"导入一个。</p>
    </div>
  </div>
</template>

<style scoped>
.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 16px;
  background: var(--panel);
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
.note {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--ink-3);
}
.warn-line {
  display: block;
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--warn);
  text-decoration: none;
}
</style>
