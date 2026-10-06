/**
 * lib/pdf.js 的单测。用 test/fixtures/lecture.pdf（由 make-pdf.mjs 生成的手写 PDF）。
 *   node test/fixtures/make-pdf.mjs && node --test test/pdf.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPdfCache, extractPdf, pagesToSource, pdfSections } from '../lib/pdf.js';
import { buildPdf } from './fixtures/make-pdf.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, 'fixtures', 'lecture.pdf');

test('pagesToSource：页区间不含页间分隔空行', () => {
  const { source, index } = pagesToSource(['a\nb', 'c']);
  assert.equal(source, 'a\nb\n\nc');
  assert.deepEqual(index, [
    { page: 1, line: 1, endLine: 2, heading: 'a' },
    { page: 2, line: 4, endLine: 4, heading: 'c' }
  ]);
});

test('pagesToSource：折叠连续空行并去掉页首尾空行', () => {
  const { source, index } = pagesToSource(['\n\nx\n\n\n\ny\n\n', 'z']);
  assert.equal(source, 'x\n\ny\n\nz');
  assert.equal(index[0].line, 1);
  assert.equal(index[0].endLine, 3);
  assert.equal(index[1].line, 5);
});

test('pagesToSource：空白页仍然占一个页码，区间退化为单行', () => {
  const { index } = pagesToSource(['a', '   \n  ', 'b']);
  assert.equal(index[1].page, 2);
  assert.equal(index[1].heading, '');
  assert.ok(index[1].endLine >= index[1].line);
});

test('pdfSections：页码 id 与大标题', () => {
  const sections = pdfSections(pagesToSource(['Gradient Descent\nbody', '   ']).index);
  assert.deepEqual(sections.map((section) => section.id), ['P1', 'P2']);
  assert.equal(sections[0].title, '第 1 页 · Gradient Descent');
  assert.equal(sections[1].title, '第 2 页');
});

test('extractPdf：把夹具 PDF 抽成逐页可寻址的讲义', async () => {
  const bytes = new Uint8Array(readFileSync(fixture));
  const result = await extractPdf(bytes, { maxPages: 100 });
  assert.equal(result.pageCount, 2);
  assert.equal(result.extractedPages, 2);
  assert.deepEqual(result.bookmarks, [], '夹具没有书签');
  assert.deepEqual(
    result.sections.map((section) => [section.id, section.line, section.endLine]),
    [['P1', 1, 3], ['P2', 5, 8]],
    '第二页的第一行是 5，中间那行是页间分隔符'
  );
  assert.match(result.source, /Follow the negative gradient\./);
  assert.match(result.source, /Step decay is common\./);
});

test('extractPdf：maxPages 截断但保留真实页数', async () => {
  const bytes = new Uint8Array(readFileSync(fixture));
  const result = await extractPdf(bytes, { maxPages: 1 });
  assert.equal(result.pageCount, 2, 'pageCount 报告文档真实页数');
  assert.equal(result.extractedPages, 1);
  assert.deepEqual(result.sections.map((section) => section.id), ['P1']);
});

test('extractPdf：不是 PDF 时报可读的错误', async () => {
  await assert.rejects(
    () => extractPdf(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]), { maxPages: 10 }),
    /无法解析/
  );
});

test('createPdfCache：重复读命中，超限淘汰最久未用', () => {
  const cache = createPdfCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1, 'get 也算一次使用');
  cache.set('c', 3);
  assert.equal(cache.get('b'), undefined, 'b 是最久未用的');
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);
});

test('extractPdf：没有文字层的 PDF 会被如实标记（扫描件场景）', async () => {
  const result = await extractPdf(buildPdf([[], []]), { maxPages: 10 });
  assert.equal(result.pageCount, 2, '页数照常报告');
  assert.equal(result.hasText, false, 'hasText 必须为 false，调用方才不会假装打开成功');
  assert.equal(result.source.trim(), '');
});

test('buildPdf：多页对象编号正确（回归：内容流曾被字体对象顶掉）', async () => {
  // 生成器只做单字节 WinAnsi 编码，所以夹具文本用 ASCII。
  const result = await extractPdf(buildPdf([['Page one'], ['Page two'], ['Page three']]), { maxPages: 10 });
  assert.equal(result.pageCount, 3);
  assert.equal(result.hasText, true);
  assert.deepEqual(result.sections.map((section) => section.id), ['P1', 'P2', 'P3']);
  assert.match(result.source, /Page one/);
  assert.match(result.source, /Page three/);
});

test('pagesToSource：跳过节眉页脚，取本页第一行「真内容」当小标题', () => {
  const header = 'Introduction to Computer Systems, Peking University';
  const pages = [
    [header, 'Machine-Level Data', 'arrays and structs'],
    [header, 'Arrays', 'one-dimensional'],
    [header, 'Structs', 'field offsets'],
    [header, 'Unions', 'overlapping storage']
  ].map((lines) => lines.join('\n'));
  const { index } = pagesToSource(pages);
  assert.deepEqual(index.map((entry) => entry.heading), [
    'Machine-Level Data',
    'Arrays',
    'Structs',
    'Unions'
  ], '页眉不该被当成小标题');
});

test('pagesToSource：短文档不把重复行误判成页眉页脚', () => {
  const { index } = pagesToSource(['Same title\na', 'Same title\nb']);
  assert.equal(index[0].heading, 'Same title', '两页还不足以判定为页眉');
});

test('pagesToSource：整页都是页眉页脚时小标题留空', () => {
  const pages = [
    ['Course name', 'content one'],
    ['Course name', 'content two'],
    ['Course name', 'content three'],
    ['Course name']
  ].map((lines) => lines.join('\n'));
  const { index } = pagesToSource(pages);
  assert.equal(index[3].heading, '');
});

test('pagesToSource：页码行也要跳过（页码每页不同，重复检测抓不到）', () => {
  // 真实讲义 PPT 的典型结构：页眉 / 页码 / 真标题 / 正文
  const header = 'Introduction to Computer Systems, Peking University';
  const pages = [
    [header, '1', 'Machine-Level Programming IV:', 'Data'],
    [header, '2', 'Today', 'Arrays'],
    [header, '3', 'Array Access', 'Basic Principle'],
    [header, '4', 'Structures', 'Allocation']
  ].map((lines) => lines.join('\n'));
  const { index } = pagesToSource(pages);
  assert.deepEqual(index.map((entry) => entry.heading), [
    'Machine-Level Programming IV:',
    'Today',
    'Array Access',
    'Structures'
  ]);
});

test('isPageNumber 的各种写法（经由小标题行为间接验证）', () => {
  const pages = ['12 / 51', 'Page 12', 'p.12', '第 12 页', 'Plain title'].map((line) => `${line}\nbody`);
  const { index } = pagesToSource(pages);
  assert.deepEqual(
    index.map((entry) => entry.heading),
    ['', '', '', '', 'Plain title'],
    '四种页码写法都不该当标题；最后一条正文才是'
  );
});

test('pagesToSource：纯符号行不当标题，往后找真标题', () => {
  const header = 'Introduction to Computer Systems, Peking University';
  const pages = [
    [header, '1', '• • •', 'Real Title A'],
    [header, '2', '---', 'Real Title B'],
    [header, '3', 'Real Title C']
  ].map((lines) => lines.join('\n'));
  const { index } = pagesToSource(pages);
  assert.deepEqual(index.map((entry) => entry.heading), ['Real Title A', 'Real Title B', 'Real Title C']);
});
