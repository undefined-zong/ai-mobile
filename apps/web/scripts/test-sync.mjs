// 多设备同步的合并规则测试：node apps/web/scripts/test-sync.mjs（Node 22.18+ 直接读 .ts）
import assert from 'node:assert/strict';
import { canonical, hashText, mergeValue } from '../src/services/sync/merge.ts';

let n = 0;
function test(name, fn) {
  fn();
  n++;
  console.log(`✓ ${name}`);
}

test('键的顺序不影响指纹', () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), canonical({ a: [1, { c: 3, d: 2 }], b: 1 }));
  assert.equal(hashText(canonical({ b: 1, a: 2 })), hashText(canonical({ a: 2, b: 1 })));
  assert.notEqual(hashText('a'), hashText('b'));
  assert.equal(canonical({ a: undefined, b: null }), '{"b":null}');
});

test('只有一边改了：用改了的那边', () => {
  const base = { name: '苏晚', mood: 1 };
  assert.deepEqual(mergeValue(base, { name: '苏晚', mood: 2 }, base, false), { name: '苏晚', mood: 2 });
  assert.deepEqual(mergeValue(base, base, { name: '晚晚', mood: 1 }, true), { name: '晚晚', mood: 1 });
});

test('两边改了不同的字段：都留下', () => {
  const base = { a: 1, b: 1, c: 1 };
  assert.deepEqual(mergeValue(base, { a: 2, b: 1, c: 1 }, { a: 1, b: 3, c: 1 }, false), { a: 2, b: 3, c: 1 });
});

test('同一个字段都改了：后改的赢', () => {
  const base = { a: 1 };
  assert.deepEqual(mergeValue(base, { a: 2 }, { a: 3 }, true), { a: 2 });
  assert.deepEqual(mergeValue(base, { a: 2 }, { a: 3 }, false), { a: 3 });
});

test('一边加了字段、一边删了字段', () => {
  const base = { a: 1, gone: true };
  assert.deepEqual(mergeValue(base, { a: 1, added: 'x', gone: true }, { a: 1 }, false), { a: 1, added: 'x' });
});

test('带 id 的列表：两边各加一条都留下，顺序跟着云端、本机新加的接在它前一条后面', () => {
  const base = [{ id: 'n1', text: '早' }];
  const local = [{ id: 'n1', text: '早' }, { id: 'mine', text: '本机的留言' }];
  const remote = [{ id: 'n1', text: '早' }, { id: 'theirs', text: '另一台的留言' }];
  assert.deepEqual(mergeValue(base, local, remote, false).map((x) => x.id), ['n1', 'mine', 'theirs']);
});

test('带 id 的列表：一边删了、一边没动 → 删；一边删了、一边改了 → 留改的', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const local = [{ id: 'b', v: 1 }];
  assert.deepEqual(mergeValue(base, local, [{ id: 'a', v: 1 }, { id: 'b', v: 2 }], false), [{ id: 'b', v: 2 }]);
  assert.deepEqual(mergeValue(base, local, [{ id: 'a', v: 9 }, { id: 'b', v: 1 }], false), [{ id: 'a', v: 9 }, { id: 'b', v: 1 }]);
});

test('带 id 的列表：同一条两边改了不同的地方，逐字段合并', () => {
  const base = [{ id: 'm', likes: [], comments: [] }];
  const local = [{ id: 'm', likes: ['me'], comments: [] }];
  const remote = [{ id: 'm', likes: [], comments: [{ id: 'c1', text: '好看' }] }];
  assert.deepEqual(mergeValue(base, local, remote, false), [{ id: 'm', likes: ['me'], comments: [{ id: 'c1', text: '好看' }] }]);
});

test('不重复的字符串列表按集合合并（删掉的 id、放进来过的文件）', () => {
  const base = ['a', 'b'];
  assert.deepEqual(mergeValue(base, ['a', 'b', 'c'], ['a', 'b', 'd'], false), ['a', 'b', 'd', 'c']);
  assert.deepEqual(mergeValue(base, ['b', 'c'], ['a', 'b', 'd'], false), ['b', 'd', 'c']);
});

test('长度不变的数字列表按位置合并（每天能练几分钟）', () => {
  const base = [30, 30, 0, 30, 30, 60, 60];
  const local = [45, 30, 0, 30, 30, 60, 60];
  const remote = [30, 30, 0, 30, 30, 60, 90];
  assert.deepEqual(mergeValue(base, local, remote, false), [45, 30, 0, 30, 30, 60, 90]);
});

test('没有底稿：两边都有的对象并起来，冲突按谁更晚', () => {
  assert.deepEqual(mergeValue(undefined, { a: 1, b: 2 }, { a: 3, c: 4 }, true), { a: 1, b: 2, c: 4 });
  assert.deepEqual(mergeValue(undefined, { a: 1, b: 2 }, { a: 3, c: 4 }, false), { a: 3, b: 2, c: 4 });
});

test('嵌套设置：朋友圈每个角色的开关，两边改不同的角色', () => {
  const base = { settings: { characters: { suwan: { enabled: true, perDay: 1 }, jiangyu: { enabled: false, perDay: 1 } } }, removed: ['x'], cursor: 10 };
  const local = { settings: { characters: { suwan: { enabled: false, perDay: 1 }, jiangyu: { enabled: false, perDay: 1 } } }, removed: ['x', 'y'], cursor: 12 };
  const remote = { settings: { characters: { suwan: { enabled: true, perDay: 1 }, jiangyu: { enabled: false, perDay: 3 } } }, removed: ['x', 'z'], cursor: 15 };
  assert.deepEqual(mergeValue(base, local, remote, false), {
    settings: { characters: { suwan: { enabled: false, perDay: 1 }, jiangyu: { enabled: false, perDay: 3 } } },
    removed: ['x', 'z', 'y'],
    cursor: 15,
  });
});

console.log(`\n${n} 个都过了`);
