import { pokeLine, type Character, type Message } from '@app/shared';

/** 没有文字的消息在列表、聚焦首页里怎么写 */
const PART_LABEL: Record<string, string> = {
  voice: '[语音]',
  image: '[图片]',
  music: '[歌曲]',
  poke: '[拍一拍]',
  'call-log': '[语音通话]',
  workout: '[运动记录]',
  meal: '[饭照]',
  study: '[学习记录]',
  date: '[约会邀请]',
  gift: '[礼物]',
  invite: '[邀请]',
  toy: '[玩具]',
};

/** 一条消息的一行预览：有字写字，只有卡片时写是什么卡片；还没有消息时是她的开场白 */
export function messagePreview(m: Message | undefined, character: Character): string {
  if (!m) return character.card.firstMes;
  if (m.text) return m.text;
  const p = m.parts[0];
  if (p?.type === 'call-log' && p.video) return '[视频通话]';
  if (p?.type === 'poke') return pokeLine(p, '你', character.name);
  if (p?.type === 'scene') return `[${p.event === 'enter' ? '来到' : '离开'}] ${p.title.replace(/^和.+?来到|^离开/, '')}`;
  return p ? (PART_LABEL[p.type] ?? '') : '';
}

/** 台词里的动作（括号、星号里的）单独拿出来，显示时淡一点 */
export function splitActions(text: string): { text: string; action: boolean }[] {
  return text
    .split(/(（[^）]*）|\([^)]*\)|\*[^*]+\*)/)
    .filter(Boolean)
    .map((s) => ({ text: s, action: /^（|^\(|^\*/.test(s) }));
}
