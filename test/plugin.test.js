/**
 * 插件主体的集成测试：用假的 `ctx` 把 `apply()` 跑起来，验证注册结果、工具执行、
 * 会话投影、动态系统提示与斜杠命令。
 *
 * 这里刻意**不**依赖 cordis 运行时，也**不**需要启动 DSH：插件与宿主之间只有
 * `ctx.xxx` 这一个接缝，把它换成一个记录用的假对象，就能在几毫秒内验证真实逻辑。
 * `defineTool` / `schemastery` / `zod` 用的是真包，所以工具 schema 与配置默认值
 * 走的是和线上完全一样的代码路径。
 *   node --test test/plugin.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { apply, Config } from '../lib/index.js';
import { createPdfCache } from '../lib/pdf.js';
import { buildPdf } from './fixtures/make-pdf.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** 一个最小的假文件系统，接口对齐 `dsh-fs`：resolve / stat / readText / readBytes。 */
function fakeFs(files) {
  const calls = { readText: 0, readBytes: 0 };
  const version = (key) => `v:${files[key].length}`;
  return {
    calls,
    /** 测试里改文件用：内容长度变了，`version` 也就变了（和真 fs 的指纹语义一致）。 */
    write(key, value) {
      files[key] = Buffer.from(value);
    },
    async resolve(path) {
      const key = path.replace(/^\.\//, '');
      if (files[key] === undefined) throw new Error(`ENOENT ${key}`);
      return { targetKey: key, displayPath: key };
    },
    async stat(target) {
      const data = files[target.targetKey];
      if (data === undefined) return undefined;
      return { version: version(target.targetKey), type: 'file', size: data.length };
    },
    async readText(target) {
      calls.readText += 1;
      return files[target.targetKey].toString('utf8');
    },
    async readBytes(target) {
      calls.readBytes += 1;
      return files[target.targetKey];
    }
  };
}

/** 最小的会话投影注册表：只实现本插件用到的那部分契约。 */
function fakeProjections() {
  let definition;
  const states = new Map();
  return {
    definition: () => definition,
    register(def) {
      definition = def;
      return () => {
        definition = undefined;
      };
    },
    stateOf(session, key) {
      assert.equal(key, definition.key, '插件必须用自己注册的 key 查询');
      return states.get(session);
    },
    /** 模拟 `session.append` 触发投影推进。 */
    drive(session, event) {
      const next = definition.apply(states.get(session) ?? definition.init(), event);
      states.set(session, next);
      return next;
    }
  };
}

/**
 * 组装一个可用的插件环境。
 * @param files - 假文件系统的文件表（路径 → Buffer/字符串）。
 * @param config - 传给插件的配置覆盖。
 * @returns 环境句柄。
 */
function harness(files, config = {}) {
  const tools = new Map();
  const contexts = [];
  const sections = [];
  const commands = [];
  const fs = fakeFs(
    Object.fromEntries(Object.entries(files).map(([key, value]) => [key, Buffer.from(value)]))
  );
  const projections = fakeProjections();
  const ctx = {
    fs,
    tools: { register: (tool) => tools.set(tool.name, tool) },
    systemPrompt: {
      context: (contribution) => {
        contexts.push(contribution);
        return () => {};
      },
      section: (section) => {
        sections.push(section);
        return () => {};
      }
    },
    sessionProjections: projections,
    commands: { register: (command) => commands.push(command) }
  };
  apply(ctx, Config(config));

  const session = {
    header: { cwd: '/workspace' },
    append(type, data) {
      projections.drive(session, { type, data });
    }
  };
  const exec = { agent: { session }, signal: undefined };
  const call = (name, args) => tools.get(name).execute(args, exec);
  /** 模型收到的工具结果就是 output.render() 的返回值（见 dsh-tools createSuccessResult）。 */
  const render = (name, args, value) =>
    tools
      .get(name)
      .output.render(args, value)
      .map((part) => part.text)
      .join('\n');
  const prompt = () => contexts.map((contribution) => contribution.text({ agent: { session } })).join('\n');
  /** 静态 section 渲染出的提示文本（讲师提示词走这条路）。 */
  const section = () =>
    sections
      .map((entry) => (typeof entry.text === 'function' ? entry.text({ agent: { session } }) : entry.text))
      .join('\n');
  const command = (rawInput) => commands[0].handler({ rawInput, agent: { session }, signal: undefined });

  return { tools, contexts, sections, commands, fs, session, call, render, prompt, section, command, projections };
}

const LECTURE = ['# 第三讲 梯度下降', '', '## 3.1 直觉', '沿反方向走。', '', '## 3.2 学习率', '太大会震荡。'].join('\n');
const PDF_BYTES = readFileSync(join(here, 'fixtures', 'lecture.pdf'));
const TEACHER = '# 你是谁\n\n你是一位擅长把公式讲成直觉的老师。';
/** 讲师提示词的假路径：用绝对路径，免得依赖插件包根目录。 */
const TEACHER_PATH = '/prompts/teacher.md';

test('注册五个工具、一条提示上下文、一段讲师提示词 section、一条命令', () => {
  const h = harness({ 'lecture.md': LECTURE });
  assert.deepEqual([...h.tools.keys()].sort(), [
    'handout_goto',
    'handout_note',
    'handout_open',
    'handout_read',
    'handout_search'
  ]);
  assert.equal(h.contexts.length, 1);
  assert.equal(h.contexts[0].name, 'handout:co-reading');
  assert.equal(h.contexts[0].order, 1500);
  assert.deepEqual(
    h.sections.map((entry) => entry.name),
    ['handout:teacher']
  );
  assert.deepEqual(h.commands.map((command) => command.name), ['handout']);
});

test('Config 默认值齐备（schemastery 真的应用了 default）', () => {
  const h = harness({ 'lecture.md': LECTURE });
  assert.equal(h.projections.definition().key, 'handout');
  // 没有讲义时提示为空串，说明投影初始值是 null 而不是抛错。
  assert.equal(h.prompt(), '');
});

test('Markdown：open → read → 提示带上位置', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  const opened = await h.call('handout_open', { path: 'lecture.md' });
  assert.equal(opened.kind, 'markdown');
  assert.deepEqual(opened.outline.map((section) => section.id), ['3', '3.1', '3.2']);
  assert.equal(opened.outlineTruncated, false);

  const read = await h.call('handout_read', { section_id: '3.2' });
  assert.equal(read.sectionId, '3.2', '用户说的「3.2」必须能直接读到');
  assert.match(read.text, /太大会震荡/);

  await h.call('handout_goto', { section_id: '3.2', quote: '太大会震荡。' });
  const prompt = h.prompt();
  assert.match(prompt, /co-reading a handout/);
  assert.match(prompt, /currently at section 3\.2/);
  assert.match(prompt, /太大会震荡。/);
  assert.match(prompt, /NOT in your context/);
});

test('Markdown：省略 section_id 时读用户当前位置', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await h.call('handout_open', { path: 'lecture.md' });
  await h.call('handout_goto', { section_id: '3.1' });
  const read = await h.call('handout_read', {});
  assert.equal(read.sectionId, '3.1');
  assert.match(read.text, /沿反方向走/);
});

test('search 返回命中所在的节', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await h.call('handout_open', { path: 'lecture.md' });
  const found = await h.call('handout_search', { query: '震荡' });
  assert.equal(found.total, 1);
  assert.equal(found.hits[0].sectionId, '3.2');
  assert.equal(found.hits[0].heading, '3.2 学习率');
});

test('PDF：按页寻址，页码可以写成 12 / p12 / P12', async () => {
  const h = harness({ 'deck.pdf': PDF_BYTES });
  const opened = await h.call('handout_open', { path: 'deck.pdf' });
  assert.equal(opened.kind, 'pdf');
  assert.equal(opened.pageCount, 2);
  assert.deepEqual(opened.outline.map((section) => section.id), ['P1', 'P2']);
  assert.deepEqual(opened.bookmarks, []);

  for (const id of ['P2', 'p2', '2']) {
    const read = await h.call('handout_read', { section_id: id });
    assert.equal(read.sectionId, 'P2', `"${id}" 应归一成 P2`);
    assert.match(read.text, /Step decay is common/);
  }
});

test('PDF：抽文结果被缓存，同一文件不重复读字节', async () => {
  const h = harness({ 'deck.pdf': PDF_BYTES });
  await h.call('handout_open', { path: 'deck.pdf' });
  await h.call('handout_read', { section_id: 'P1' });
  await h.call('handout_search', { query: 'gradient' });
  assert.equal(h.fs.calls.readBytes, 1, '三次调用只应读一次 PDF 字节');
});

test('PDF：提示里给出页码与书签目录位置', async () => {
  const h = harness({ 'deck.pdf': PDF_BYTES });
  await h.call('handout_open', { path: 'deck.pdf' });
  await h.call('handout_goto', { section_id: '12' }).catch(() => {});
  await h.call('handout_goto', { section_id: '2' });
  const prompt = h.prompt();
  assert.match(prompt, /PDF/);
  assert.match(prompt, /currently at page 2/, 'PDF 展示成「第 2 页」，不是 P2');
  assert.match(prompt, /ids like "P12"/);
});

test('批注累积进状态与提示', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await h.call('handout_open', { path: 'lecture.md' });
  await h.call('handout_goto', { section_id: '3.2' });
  await h.call('handout_note', { text: '为什么太大会震荡？' });
  const second = await h.call('handout_note', { text: '衰减策略要复习', section_id: '3.1' });
  assert.equal(second.notes, 2);
  const prompt = h.prompt();
  assert.match(prompt, /为什么太大会震荡？/);
  assert.match(prompt, /\[3\.1\] 衰减策略要复习/);
});

test('没有打开讲义时，工具给出可操作的报错', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await assert.rejects(() => h.call('handout_read', { section_id: '1' }), /先调用 handout_open/);
  await assert.rejects(() => h.call('handout_search', { query: 'x' }), /先调用 handout_open/);
});

test('不存在的节与不存在的文件都报错', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await h.call('handout_open', { path: 'lecture.md' });
  await assert.rejects(() => h.call('handout_read', { section_id: '9.9' }), /没有编号为 9\.9/);
  await assert.rejects(() => h.call('handout_open', { path: 'nope.md' }), /ENOENT/);
});

test('目录会被拒绝，不是被当成讲义读', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  h.fs.stat = async () => ({ version: 'v', type: 'directory', size: 0 });
  await assert.rejects(() => h.call('handout_open', { path: 'lecture.md' }), /是一个目录/);
});

test('/handout where 与 goto 直接改状态', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  // handler 是 async（teacher 子命令要读文件），所以这里一律 await。
  assert.match((await h.command('where')).text, /还没有打开的讲义/);

  await h.call('handout_open', { path: 'lecture.md' });
  assert.match((await h.command('')).text, /lecture\.md/);

  const jumped = await h.command('goto 3.2');
  assert.equal(jumped.kind, 'success');
  assert.match(jumped.text, /3\.2/);
  assert.match((await h.command('where')).text, /§3\.2/);

  assert.equal((await h.command('goto 9.9')).kind, 'error');
  assert.equal((await h.command('bogus')).kind, 'error');
});

// ── 讲师提示词：一份 Markdown，决定模型「怎么讲」 ────────────────────────────

test('讲师提示词注册为静态 section：不插值、位置在部署 persona 之后', () => {
  const h = harness({ 'lecture.md': LECTURE }, { teacherPromptPath: TEACHER_PATH, teacherOrder: 42 });
  const [section] = h.sections;
  assert.equal(section.name, 'handout:teacher');
  assert.equal(section.order, 42);
  assert.equal(section.interpolate, false, '用户正文里的 {{...}} 不该让 system prompt 组装失败');
});

test('讲师提示词默认只在共读进行中生效', async () => {
  const h = harness({ 'lecture.md': LECTURE, [TEACHER_PATH]: TEACHER }, { teacherPromptPath: TEACHER_PATH });
  assert.equal(h.section(), '', '没有打开讲义时零开销');
  await h.call('handout_open', { path: 'lecture.md' });
  assert.match(h.section(), /讲成直觉的老师/);
});

test('teacherAlways 时没有讲义也注入', async () => {
  const h = harness({ [TEACHER_PATH]: TEACHER }, { teacherPromptPath: TEACHER_PATH, teacherAlways: true });
  await h.command('teacher reload');
  assert.match(h.section(), /讲成直觉的老师/);
});

test('改完 Markdown，下一次共读工具调用就生效（不需要重启）', async () => {
  const h = harness({ 'lecture.md': LECTURE, [TEACHER_PATH]: TEACHER }, { teacherPromptPath: TEACHER_PATH });
  await h.call('handout_open', { path: 'lecture.md' });
  assert.match(h.section(), /讲成直觉的老师/);

  h.fs.write(TEACHER_PATH, '# 换个说法\n\n先问一句「你觉得呢」。');
  await h.call('handout_goto', { section_id: '3.1' });
  assert.match(h.section(), /先问一句/);
  assert.doesNotMatch(h.section(), /讲成直觉的老师/);
});

test('提示词文件不存在：共读工具照常工作，只是少一段提示词', async () => {
  const h = harness({ 'lecture.md': LECTURE }, { teacherPromptPath: '/prompts/nope.md' });
  const opened = await h.call('handout_open', { path: 'lecture.md' });
  assert.equal(opened.kind, 'markdown');
  assert.equal(h.section(), '');
  const read = await h.call('handout_read', { section_id: '3.1' });
  assert.match(read.text, /沿反方向走/);
});

test('/handout teacher 报告加载状态、生效范围与预览', async () => {
  const h = harness({ 'lecture.md': LECTURE, [TEACHER_PATH]: TEACHER }, { teacherPromptPath: TEACHER_PATH });
  const before = await h.command('teacher reload');
  assert.equal(before.kind, 'success');
  assert.match(before.text, /已加载 \d+ 字符/);
  assert.match(before.text, /还没有打开讲义，暂不生效/);
  assert.doesNotMatch(before.text, /共读进行中/);

  await h.call('handout_open', { path: 'lecture.md' });
  const after = await h.command('teacher');
  assert.match(after.text, /共读进行中，正在生效/);
  assert.match(after.text, /预览：/);
});

test('/handout teacher 读不到文件时以 error 暴露', async () => {
  const h = harness({ 'lecture.md': LECTURE }, { teacherPromptPath: '/prompts/nope.md' });
  const result = await h.command('teacher');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /不存在/);
});

test('teacherPromptPath 为空 = 关掉讲师提示词', async () => {
  const h = harness({ 'lecture.md': LECTURE, [TEACHER_PATH]: TEACHER }, { teacherPromptPath: '' });
  await h.call('handout_open', { path: 'lecture.md' });
  assert.equal(h.section(), '');
  assert.match((await h.command('teacher')).text, /已关闭/);
});

test('maxOutlineEntries 截断大纲并如实标记', async () => {
  const h = harness({ 'lecture.md': LECTURE }, { maxOutlineEntries: 2 });
  const opened = await h.call('handout_open', { path: 'lecture.md' });
  assert.equal(opened.outline.length, 2);
  assert.equal(opened.outlineTruncated, true);
});

test('createPdfCache 由配置控制容量', () => {
  const cache = createPdfCache(1);
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), 2);
});

test('PDF 没有文字层时明确报错，而不是打开一份空讲义', async () => {
  const h = harness({ 'scan.pdf': buildPdf([[], []]) });
  await assert.rejects(() => h.call('handout_open', { path: 'scan.pdf' }), /OCR/);
  assert.equal(h.prompt(), '', '失败时不应留下半截状态');
});

// ── 回归：output.render() 的返回值就是模型看到的工具结果 ──────────────────────
// 早先这里只返回一行摘要，模型因此永远拿不到讲义正文，整个共读功能等于空转。

test('模型看到的是正文，不是摘要：handout_read', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await h.call('handout_open', { path: 'lecture.md' });
  const value = await h.call('handout_read', { section_id: '3.2' });
  const text = h.render('handout_read', { section_id: '3.2' }, value);
  assert.match(text, /太大会震荡/, '正文必须在 render 里');
  assert.match(text, /§3\.2/, '同时要给出坐标，便于引用');
});

test('模型看到的是大纲，不是摘要：handout_open', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  const value = await h.call('handout_open', { path: 'lecture.md' });
  const text = h.render('handout_open', { path: 'lecture.md' }, value);
  assert.match(text, /3\.2\s+3\.2 学习率/, '大纲要带上 id 与标题');
  assert.match(text, /L\d+-\d+/, '要带上行号区间');
});

test('模型看到的是命中上下文，不是摘要：handout_search', async () => {
  const h = harness({ 'lecture.md': LECTURE });
  await h.call('handout_open', { path: 'lecture.md' });
  const value = await h.call('handout_search', { query: '震荡' });
  const text = h.render('handout_search', { query: '震荡' }, value);
  assert.match(text, /太大会震荡/, '命中行要带上上下文');
  assert.match(text, /§3\.2/);
});

test('PDF 的 handout_read 让模型看到那一页的文字与页码', async () => {
  const h = harness({ 'deck.pdf': PDF_BYTES });
  await h.call('handout_open', { path: 'deck.pdf' });
  const value = await h.call('handout_read', { section_id: '2' });
  const text = h.render('handout_read', { section_id: '2' }, value);
  assert.match(text, /Step decay is common/);
  assert.match(text, /§P2/);
});

test('PDF 的 handout_open 渲染出页码大纲', async () => {
  const h = harness({ 'deck.pdf': PDF_BYTES });
  const value = await h.call('handout_open', { path: 'deck.pdf' });
  const text = h.render('handout_open', { path: 'deck.pdf' }, value);
  assert.match(text, /P1/);
  assert.match(text, /P2/);
  assert.match(text, /PDF/);
});
