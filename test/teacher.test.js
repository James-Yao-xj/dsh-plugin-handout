/**
 * lib/teacher.js 的单测：路径解析、正文规范化、版本化加载与失败退路。
 *
 * 这里用假的只读 fs（与 `dsh-fs` 同形状：resolve / stat / readText），所以不需要
 * 启动 DSH，也不会碰真实文件：
 *   node --test test/teacher.test.js
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PACKAGE_ROOT,
  createTeacherPrompt,
  formatTeacherStatus,
  normalizePrompt,
  resolvePromptPath
} from '../lib/teacher.js';

/**
 * 一个可控的假文件系统。
 * @param files - `路径 → {text, version, type}` 表；省略 version 时按文本长度算。
 * @returns `{fs, reads, set}`。
 */
function fakeFs(files) {
  const reads = { text: 0 };
  const fs = {
    async resolve(path) {
      if (files[path] === undefined) throw new Error(`ENOENT: ${path}`);
      return { targetKey: path, displayPath: path };
    },
    async stat(target) {
      const entry = files[target.targetKey];
      if (entry === undefined) return undefined;
      return {
        version: entry.version ?? `v:${entry.text.length}`,
        type: entry.type ?? 'file',
        size: entry.text.length
      };
    },
    async readText(target) {
      reads.text += 1;
      return files[target.targetKey].text;
    }
  };
  return { fs, reads, files };
}

const PROMPT = '# 你是谁\n\n你是一位擅长把公式讲成直觉的老师。';

test('resolvePromptPath：空串关闭，相对路径按插件包根目录，支持 ~ 与绝对路径', () => {
  assert.equal(resolvePromptPath(''), undefined);
  assert.equal(resolvePromptPath('   '), undefined);
  assert.equal(resolvePromptPath(undefined), undefined);
  assert.equal(resolvePromptPath('prompts/teacher.md'), join(PACKAGE_ROOT, 'prompts/teacher.md'));
  assert.equal(resolvePromptPath('/etc/handout/teacher.md'), '/etc/handout/teacher.md');
  assert.equal(resolvePromptPath('~/notes/teacher.md', { home: '/home/u' }), join('/home/u', 'notes/teacher.md'));
  assert.equal(
    resolvePromptPath('prompts/t.md', { packageRoot: '/pkg' }),
    join('/pkg', 'prompts/t.md'),
    '相对路径不按会话 cwd 解析，而是相对包根目录'
  );
});

test('normalizePrompt：去 BOM、去 HTML 注释、trim；正文里的 {{...}} 原样保留', () => {
  assert.equal(normalizePrompt('\uFEFF# 标题\n'), '# 标题');
  assert.equal(normalizePrompt('<!-- 笔记 -->\n真正的提示词'), '真正的提示词');
  assert.equal(normalizePrompt('前\n<!--\n多行\n注释\n-->\n后'), '前\n\n后', '多行注释整块删掉');
  assert.equal(normalizePrompt('   \n  '), '');
  assert.equal(normalizePrompt('<!-- 只有注释 -->'), '', '通篇注释等于没有提示词');
  assert.equal(normalizePrompt('讲 {{这个}} 时注意'), '讲 {{这个}} 时注意', '不做模板替换');
});

test('加载后缓存正文；版本没变不重读，版本变了自动更新', async () => {
  const world = fakeFs({ '/t.md': { text: PROMPT } });
  const teacher = createTeacherPrompt({ path: '/t.md' });

  const first = await teacher.sync(world.fs);
  assert.equal(first.error, undefined);
  assert.equal(teacher.text(), PROMPT);
  assert.equal(first.chars, PROMPT.length);
  assert.equal(first.loaded, true);
  assert.equal(world.reads.text, 1);

  await teacher.sync(world.fs);
  assert.equal(world.reads.text, 1, '同一版本不该重读');

  world.files['/t.md'].version = 'v2';
  world.files['/t.md'].text = '# 换个说法';
  await teacher.sync(world.fs);
  assert.equal(world.reads.text, 2);
  assert.equal(teacher.text(), '# 换个说法', '文件改了，下一轮就是新提示词');
});

test('force 跳过版本检查（/handout teacher reload）', async () => {
  const world = fakeFs({ '/t.md': { text: PROMPT } });
  const teacher = createTeacherPrompt({ path: '/t.md' });
  await teacher.sync(world.fs);
  await teacher.sync(world.fs, { force: true });
  assert.equal(world.reads.text, 2);
});

test('文件不存在：清掉旧正文并记错误，文件出现后自动恢复', async () => {
  const world = fakeFs({ '/t.md': { text: PROMPT } });
  const teacher = createTeacherPrompt({ path: '/t.md' });
  await teacher.sync(world.fs);
  assert.equal(teacher.text(), PROMPT);

  delete world.files['/t.md'];
  const gone = await teacher.sync(world.fs);
  assert.match(gone.error, /不存在/);
  assert.equal(teacher.text(), '', '文件被删了就不能还在吃旧提示词');

  world.files['/t.md'] = { text: '# 回来了' };
  await teacher.sync(world.fs);
  assert.equal(teacher.text(), '# 回来了');
  assert.equal(teacher.state().error, undefined);
});

test('超过 maxChars：拒绝本次加载，并保留上一次成功的正文', async () => {
  const world = fakeFs({ '/t.md': { text: PROMPT } });
  const teacher = createTeacherPrompt({ path: '/t.md', maxChars: 20 });
  const first = await teacher.sync(world.fs);
  assert.match(first.error, /超过 teacherPromptMaxChars/);
  assert.equal(teacher.text(), '');

  const small = createTeacherPrompt({ path: '/t.md', maxChars: 4000 });
  await small.sync(world.fs);
  world.files['/t.md'] = { text: 'x'.repeat(5000), version: 'v9' };
  await small.sync(world.fs);
  assert.match(small.state().error, /超过/);
  assert.equal(small.text(), PROMPT, '抽掉已生效的提示词比报错更坏');
  assert.match(small.state().error, /仍在使用上一次的 \d+ 字符版本/);
});

test('读取失败不抛错，也不把上一次的正文抹掉', async () => {
  const world = fakeFs({ '/t.md': { text: PROMPT } });
  const teacher = createTeacherPrompt({ path: '/t.md' });
  await teacher.sync(world.fs);

  const broken = { ...world.fs, readText: async () => { throw new Error('EACCES: 权限不足'); }, stat: world.fs.stat, resolve: world.fs.resolve };
  world.files['/t.md'] = { text: PROMPT, version: 'v2' };
  const state = await teacher.sync(broken);
  assert.match(state.error, /EACCES/);
  assert.equal(teacher.text(), PROMPT);

  const kept = [];
  const logged = createTeacherPrompt({ path: '/t.md', onError: (message) => kept.push(message) });
  await logged.sync(broken);
  assert.equal(kept.length, 1, '错误要能被运维看到（日志）');
});

test('path 为空时彻底关闭：不碰文件系统，也不产生错误', async () => {
  const world = fakeFs({ '/t.md': { text: PROMPT } });
  const teacher = createTeacherPrompt({ path: '' });
  const state = await teacher.sync(world.fs);
  assert.equal(state.enabled, false);
  assert.equal(state.error, undefined);
  assert.equal(teacher.text(), '');
  assert.equal(world.reads.text, 0);
});

test('formatTeacherStatus：区分未加载 / 空文件 / 已加载 / 出错', () => {
  const base = { enabled: true, path: '/t.md', text: PROMPT, chars: PROMPT.length, loaded: true, loadedAt: 0, error: undefined };
  assert.match(formatTeacherStatus(base), /已加载 \d+ 字符/);
  assert.match(formatTeacherStatus(base, { coReading: true }), /共读进行中/);
  assert.match(formatTeacherStatus(base, { always: true }), /始终生效/);
  assert.match(formatTeacherStatus(base), /预览：/);
  assert.match(formatTeacherStatus({ ...base, text: '', chars: 0 }), /没有内容/);
  assert.match(formatTeacherStatus({ ...base, text: '', chars: 0, loaded: false }), /还没有成功读到/);
  assert.match(formatTeacherStatus({ ...base, error: '读不到' }), /⚠ 读不到/);
  assert.match(formatTeacherStatus({ ...base, enabled: false }), /已关闭/);
  assert.match(formatTeacherStatus({ ...base, error: '太大' }), /仍在使用上一次成功读到的版本/);
});
