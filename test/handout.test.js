/**
 * lib/handout.js 的单测。纯函数，不需要启动 DSH：
 *   cd plugins/dsh-plugin-handout && node --test test/
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectKind, numberingOf, outlineOf, searchText, sectionAt, sliceLines } from '../lib/handout.js';

const LECTURE = [
  '# 第三讲 梯度下降',
  '',
  '本节介绍梯度下降。',
  '',
  '## 3.1 直觉',
  '',
  '沿着梯度的反方向走。',
  '',
  '```python',
  '# 这不是标题',
  'w = w - lr * g',
  '```',
  '',
  '## 3.2 学习率',
  '',
  '学习率太大就会震荡。',
  '',
  '### 3.2.1 衰减策略',
  '',
  '常见的有 step decay。',
  '',
  '## 3.3 收敛性',
  '',
  '凸函数上有保证。'
].join('\n');

test('detectKind 只看扩展名', () => {
  assert.equal(detectKind('a/b/lecture.md'), 'markdown');
  assert.equal(detectKind('notes.MARKDOWN'), 'markdown');
  assert.equal(detectKind('lecture.pdf'), 'pdf');
  assert.equal(detectKind('Deck.PDF'), 'pdf');
});

test('大纲编号优先用讲义自己的数字（含中文「第三讲」），并跳过代码围栏里的 #', () => {
  const outline = outlineOf(LECTURE, 'markdown');
  assert.deepEqual(
    outline.map((section) => [section.id, section.level, section.title]),
    [
      ['3', 1, '第三讲 梯度下降'],
      ['3.1', 2, '3.1 直觉'],
      ['3.2', 2, '3.2 学习率'],
      ['3.2.1', 3, '3.2.1 衰减策略'],
      ['3.3', 2, '3.3 收敛性']
    ],
    'id 必须是用户会说出口的「3.2」，而不是层级生成的「1.2」'
  );
});

test('numberingOf 认阿拉伯与中文编号，认不出就返回 undefined', () => {
  assert.equal(numberingOf('3.2 学习率'), '3.2');
  assert.equal(numberingOf('5. 小结'), '5');
  assert.equal(numberingOf('4 学习率'), '4');
  assert.equal(numberingOf('第三讲 梯度下降'), '3');
  assert.equal(numberingOf('第 12 章 概率'), '12');
  assert.equal(numberingOf('第二十一节 附录'), '21');
  assert.equal(numberingOf('梯度下降'), undefined);
  assert.equal(numberingOf('Gradient Descent'), undefined);
});

test('编号撞车时退回层级编号，保证 id 唯一', () => {
  const outline = outlineOf(['## 2.1 甲', '', '## 2.1 乙'].join('\n'), 'markdown');
  const ids = outline.map((section) => section.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  assert.equal(ids[0], '2.1');
  assert.equal(ids[1], '2', '第二个 2.1 撞车，改用相对深度编号');
});

test('讲义直接从 ## 开始时，层级编号从 1 起而不是 0.1', () => {
  const outline = outlineOf(['## 甲', '', '## 乙'].join('\n'), 'markdown');
  assert.deepEqual(outline.map((section) => section.id), ['1', '2']);
});

test('一节的范围包含它的子节，而不是在子标题处截断', () => {
  const outline = outlineOf(LECTURE, 'markdown');
  const gd = outline.find((section) => section.id === '3.2');
  const decay = outline.find((section) => section.id === '3.2.1');
  assert.equal(gd.line, 14);
  assert.equal(gd.endLine, decay.endLine, '3.2 应该一直覆盖到 3.2.1 结束');
  assert.ok(gd.endLine < outline.find((s) => s.id === '3.3').line);
});

test('没有标题的纯文本退化成定长分块', () => {
  const source = Array.from({ length: 130 }, (_, i) => `第 ${i + 1} 行`).join('\n');
  const outline = outlineOf(source, 'text');
  assert.equal(outline.length, 3);
  assert.equal(outline[0].line, 1);
  assert.equal(outline[0].endLine, 60);
  assert.equal(outline[1].line, 61);
  assert.equal(outline[2].endLine, 130);
});

test('sectionAt 找到覆盖某一行的节', () => {
  const outline = outlineOf(LECTURE, 'markdown');
  assert.equal(sectionAt(outline, 16).id, '3.2', '3.2 的正文行属于 3.2');
  assert.equal(sectionAt(outline, 19).id, '3.2.1', '子节标题之后的行属于子节');
  assert.equal(sectionAt(outline, 23).id, '3.3');
});

test('sliceLines 按行区间取文并标注截断', () => {
  const slice = sliceLines(LECTURE, 14, 17, 1000);
  assert.equal(slice.fromLine, 14);
  assert.equal(slice.toLine, 17);
  assert.equal(slice.truncated, false);
  assert.match(slice.text, /3\.2 学习率/);

  const cut = sliceLines(LECTURE, 14, 17, 10);
  assert.equal(cut.truncated, true);
  assert.match(cut.text, /继续读/);
});

test('searchText 返回命中行号与上下文窗口', () => {
  const hits = searchText(LECTURE, '学习率', { limit: 10, contextLines: 1 });
  assert.deepEqual(hits.map((hit) => hit.line), [14, 16], '标题行和正文行都算命中');
  assert.match(hits[0].context, /14\| ## 3\.2 学习率/);
  assert.match(hits[0].context, /13\|/);
});

test('searchText 遵守 limit', () => {
  const source = 'x\nx\nx\nx';
  assert.equal(searchText(source, 'x', { limit: 2, contextLines: 0 }).length, 2);
});
