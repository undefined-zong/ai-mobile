import type { Memory, MemoryType } from '@app/shared';
import { at } from '@/utils/time';

function mem(
  id: string,
  type: MemoryType,
  content: string,
  importance: number,
  when: number,
  extra: Partial<Memory> = {},
): Memory {
  return {
    id,
    characterId: 'suwan',
    type,
    content,
    importance,
    pinned: false,
    status: 'active',
    dueAt: null,
    sourceMessageIds: [],
    happenedAt: when,
    vector: { model: 'BAAI/bge-m3', dims: 1024, data: '' },
    lastRecalledAt: null,
    recallCount: 0,
    createdAt: when,
    updatedAt: when,
    ...extra,
  };
}

export const memories: Memory[] = [
  mem('mem1', 'preference', '他不吃香菜，点菜时要提醒老板', 9, at(-28, '19:30'), { pinned: true, recallCount: 7 }),
  mem('mem2', 'fact', '在读研一，计算机专业，最近在赶一篇论文', 8, at(-29, '21:00'), { pinned: true, recallCount: 12 }),
  mem('mem3', 'followup', '周三下午两点有一场实习面试，结束后要问他结果', 8, at(-2, '22:30'), { dueAt: at(2, '16:30') }),
  mem('mem4', 'promise', '约好周六下午一起去水族馆', 7, at(-1, '20:05')),
  mem('mem5', 'event', '在电影院一起看了《海边的旧书店》，他说最喜欢两人在屋檐下躲雨那一幕', 6, at(-3, '22:10')),
  mem('mem6', 'emotion', '最近因为论文进度有点焦虑，晚上容易失眠', 7, at(-3, '01:10'), { recallCount: 3 }),
  mem('mem7', 'preference', '下雨天喜欢听慢歌，最近单曲循环《雨停之前》', 5, at(-1, '17:06')),
  mem('mem8', 'relationship', '第一次叫我"晚晚"，那天我脸红了一整晚', 9, at(-12, '22:10'), { pinned: true }),
  mem('mem9', 'fact', '每天早上会去操场跑步，配速 6 分左右', 4, at(-1, '08:41')),
  mem('mem10', 'followup', '他说这周要把论文初稿交给导师，周五问问进度', 6, at(-4, '23:00'), { dueAt: at(4, '20:00') }),
  mem('mem11', 'preference', '早饭常吃豆浆油条，午饭十有八九是拉面', 4, at(-6, '12:40')),
  // 江屿：话少，记的也是短句
  ...(
    [
      ['jm1', 'fact', '研一，计算机专业。体测八百米差点没过', 6, at(-9, '18:30'), {}],
      ['jm2', 'promise', '每天早上六点操场见，迟到一分钟加一圈', 8, at(-2, '18:13'), { pinned: true, recallCount: 2 }],
      ['jm3', 'event', '第一次一起晨跑，他比我早到两分钟', 7, at(-6, '06:00'), { recallCount: 1 }],
      ['jm4', 'event', '下雨天跑了 3.1 公里，配速 6 分 30，比第一天快了一分钟', 5, at(-1, '06:50'), {}],
      ['jm5', 'preference', '跑步不戴耳机，说要听自己的呼吸', 4, at(-5, '06:40'), {}],
      ['jm6', 'emotion', '第三天想放弃，被我盯着跑完了，最后说了句谢谢', 6, at(-4, '06:45'), {}],
      ['jm7', 'followup', '他说周日想试试游泳，到时候问他来不来游泳馆', 6, at(-1, '07:00'), { dueAt: at(4, '09:00') }],
      ['jm8', 'relationship', '他开始叫我"江队"了', 7, at(-3, '06:50'), { pinned: true }],
      ['jm9', 'fact', '经常熬夜改论文，第二天跑步明显没精神', 5, at(-2, '06:30'), {}],
    ] as const
  ).map(([id, type, content, importance, when, extra]) => mem(id, type, content, importance, when, { characterId: 'jiangyu', ...extra })),
];

export const MEMORY_TYPE_META: Record<MemoryType, { label: string; color: string; icon: string }> = {
  fact: { label: '事实', color: '#8db8ff', icon: 'i-lucide-info' },
  preference: { label: '偏好', color: '#f2c66d', icon: 'i-lucide-heart' },
  event: { label: '事件', color: '#7fd6a4', icon: 'i-lucide-calendar-days' },
  promise: { label: '约定', color: '#f39cc0', icon: 'i-lucide-handshake' },
  followup: { label: '待跟进', color: '#ff9f86', icon: 'i-lucide-alarm-clock' },
  emotion: { label: '情绪', color: '#b7a6f5', icon: 'i-lucide-cloud-sun' },
  relationship: { label: '关系', color: '#f5b8a6', icon: 'i-lucide-sparkles' },
};
