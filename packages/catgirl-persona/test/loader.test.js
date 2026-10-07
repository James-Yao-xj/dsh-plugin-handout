/**
 * lib/loader.js 的单测：版本化加载、失败退路、上限保护。
 *
 * 用假的只读 fs（与 `dsh-fs` 同形状：resolve / stat / readText），所以不需要启动
 * DSH，也不会碰真实文件。
 *   node --test test/loader.test.js
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPersonaLoader } from '../lib/loader.js';

/**
 * 一个可控的假文件系统。
 * @param files - `路径 → {text, version, type}` 表；省略 version 时按文本长度算。
 * @returns `{fs, reads, files}`。
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

const CATGIRL = '# 你是谁\n\n你的名字是 OpenCode，一只货真价实的小猫之神。';

test('加载后缓存正文；版本没变不重读，版本变了自动更新', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL } });
  const loader = createPersonaLoader({ path: '/c.md' });

  const first = await loader.sync(world.fs);
  assert.equal(first.error, undefined);
  assert.equal(loader.text(), CATGIRL);
  assert.equal(first.chars, CATGIRL.length);
  assert.equal(first.loaded, true);
  assert.equal(world.reads.text, 1);

  await loader.sync(world.fs);
  assert.equal(world.reads.text, 1, '同一版本不该重读');

  world.files['/c.md'].version = 'v2';
  world.files['/c.md'].text = '# 换只猫';
  await loader.sync(world.fs);
  assert.equal(world.reads.text, 2);
  assert.equal(loader.text(), '# 换只猫', '改了 Markdown，下一轮组装就是新人格');
});

test('BOM 与 HTML 注释在加载时就清掉', async () => {
  const world = fakeFs({ '/c.md': { text: '\uFEFF<!-- 给作者看的笔记 -->\n\n真正的正文' } });
  const loader = createPersonaLoader({ path: '/c.md' });
  await loader.sync(world.fs);
  assert.equal(loader.text(), '真正的正文');
});

test('force 跳过版本检查（/persona reload）', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL } });
  const loader = createPersonaLoader({ path: '/c.md' });
  await loader.sync(world.fs);
  await loader.sync(world.fs, { force: true });
  assert.equal(world.reads.text, 2);
});

test('文件不存在：清掉旧正文并记错误，文件回来以后自动恢复', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL } });
  const loader = createPersonaLoader({ path: '/c.md' });
  await loader.sync(world.fs);
  assert.equal(loader.text(), CATGIRL);

  delete world.files['/c.md'];
  const gone = await loader.sync(world.fs);
  assert.match(gone.error, /不存在/);
  assert.equal(loader.text(), '', '文件被删了就不能还在吃旧人格');

  world.files['/c.md'] = { text: '# 回来了' };
  await loader.sync(world.fs);
  assert.equal(loader.text(), '# 回来了');
  assert.equal(loader.state().error, undefined);
});

test('目录不是提示词：按「文件不在」处理', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL, type: 'directory' } });
  const loader = createPersonaLoader({ path: '/c.md' });
  const state = await loader.sync(world.fs);
  assert.match(state.error, /不存在/);
  assert.equal(loader.text(), '');
});

test('超过 maxChars：拒绝本次加载，并保留上一次成功的正文', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL } });
  const tiny = createPersonaLoader({ path: '/c.md', maxChars: 5 });
  const first = await tiny.sync(world.fs);
  assert.match(first.error, /超过 maxChars/);
  assert.equal(tiny.text(), '');

  const loader = createPersonaLoader({ path: '/c.md', maxChars: 4000 });
  await loader.sync(world.fs);
  world.files['/c.md'] = { text: 'x'.repeat(5000), version: 'v9' };
  await loader.sync(world.fs);
  assert.match(loader.state().error, /超过/);
  assert.equal(loader.text(), CATGIRL, '抽掉已生效的人格比报错更坏');
  assert.match(loader.state().error, /仍在使用上一次的 \d+ 字符版本/);

  const reads = world.reads.text;
  await loader.sync(world.fs);
  assert.equal(world.reads.text, reads, '同一份超限文件不必每轮都重读');
});

test('读取失败不抛错，也不把上一次的正文抹掉', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL } });
  const loader = createPersonaLoader({ path: '/c.md' });
  await loader.sync(world.fs);

  const broken = {
    resolve: world.fs.resolve,
    stat: world.fs.stat,
    readText: async () => {
      throw new Error('EACCES: 权限不足');
    }
  };
  world.files['/c.md'] = { text: CATGIRL, version: 'v2' };
  const state = await loader.sync(broken);
  assert.match(state.error, /EACCES/);
  assert.equal(loader.text(), CATGIRL);

  const reported = [];
  const logged = createPersonaLoader({ path: '/c.md', onError: (message) => reported.push(message) });
  await logged.sync(broken);
  assert.equal(reported.length, 1, '错误要能被运维看到（日志）');

  const retried = await loader.sync(world.fs);
  assert.equal(retried.error, undefined, '读失败不记版本，下一次组装会再试');
});

test('path 为空时彻底关闭：不碰文件系统，也不产生错误', async () => {
  const world = fakeFs({ '/c.md': { text: CATGIRL } });
  const loader = createPersonaLoader({ path: '' });
  const state = await loader.sync(world.fs);
  assert.equal(state.enabled, false);
  assert.equal(state.error, undefined);
  assert.equal(loader.text(), '');
  assert.equal(world.reads.text, 0);
});
