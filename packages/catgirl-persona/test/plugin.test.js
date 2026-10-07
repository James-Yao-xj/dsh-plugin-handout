/**
 * 插件主体的集成测试：用假的 `ctx` 把 `apply()` 跑起来，验证它到底往系统提示里
 * 塞了什么、以及人格不生效时会不会把会话带崩。
 *
 * 这里刻意**不**依赖 cordis 运行时，也**不**需要启动 DSH：插件与宿主之间只有
 * `ctx.xxx` 这一个接缝。`schemastery` 用的是真包，所以配置默认值走的是和线上
 * 完全一样的代码路径。
 *   node --test test/plugin.test.js
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Config, apply, inject, name } from '../lib/index.js';
import { PERSONA_SECTION } from '../lib/persona.js';

const CATGIRL = '# 你是谁\n\n你的名字是 OpenCode，一只货真价实的小猫之神。';

/** 最小的假文件系统，接口对齐 `dsh-fs`：resolve / stat / readText。 */
function fakeFs(files) {
  const calls = { readText: 0 };
  const version = (key) => `v:${files[key].length}`;
  return {
    calls,
    /** 测试里改文件用：内容长度变了，`version` 也就变了（和真 fs 的指纹语义一致）。 */
    write(key, value) {
      files[key] = String(value);
    },
    async resolve(path) {
      if (files[path] === undefined) throw new Error(`ENOENT ${path}`);
      return { targetKey: path, displayPath: path };
    },
    async stat(target) {
      const data = files[target.targetKey];
      if (data === undefined) return undefined;
      return { version: version(target.targetKey), type: 'file', size: data.length };
    },
    async readText(target) {
      calls.readText += 1;
      return files[target.targetKey];
    }
  };
}

/**
 * 把插件挂起来，拿到它的装配 waterfall 与 `/persona`。
 * @param files - 假文件系统的文件表（路径 → 文本）。
 * @param config - 传给插件的配置覆盖。
 * @param fs - 换掉假文件系统（用来模拟读盘故障）。
 * @returns 环境句柄。
 */
function harness(files, config = {}, fs) {
  const listeners = [];
  const commands = [];
  const logs = { warn: [], error: [] };
  const ctx = {
    fs: fs ?? fakeFs(files),
    logger: {
      warn: (message) => logs.warn.push(message),
      error: (message) => logs.error.push(message)
    },
    on: (event, listener, options) => {
      listeners.push({ event, listener, options });
      return () => {};
    },
    commands: { register: (command) => commands.push(command) }
  };
  apply(ctx, Config(config));

  /**
   * 跑一次系统提示装配。
   *
   * `next()` 返回「已经合并、已经遮蔽过」的装配结果——也就是 Web 会话里
   * preset 顶掉部署级 persona 之后的样子。
   * @param sections - 装配结果里的 sections。
   * @returns 装配结果。
   */
  const assemble = async (sections) => {
    const entry = listeners.filter((item) => item.event === 'system-prompt/assemble').at(-1);
    const assembly = { sections, contexts: [], tools: [], variables: { cwd: '/workspace' } };
    return entry.listener(assembly, {}, async () => assembly);
  };
  const command = (rawInput) => commands[0].handler({ rawInput, signal: undefined });

  return { listeners, commands, logs, fs: ctx.fs, assemble, command };
}

/** 仿造 Web 会话的装配结果：persona 段已经是 preset 那一份。 */
const presetShadowed = () => [
  { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
  { name: PERSONA_SECTION, text: 'You are a coding agent powered by the deepseek-flash model.', interpolate: true },
  { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.', interpolate: true }
];

const PROMPT_PATH = '/prompts/catgirl.md';

test('插件身份与默认配置', () => {
  assert.equal(name, 'catgirl-persona');
  assert.deepEqual(inject, ['systemPrompt', 'fs', 'commands']);

  const defaults = Config({});
  assert.equal(defaults.promptPath, 'prompts/catgirl.md');
  assert.equal(defaults.maxChars, 12000);
  assert.equal(defaults.section, PERSONA_SECTION);
  assert.equal(defaults.interpolate, false, '默认按字面量注入：未知变量会让整个系统提示组装失败');
});

test('装配 waterfall：把 preset 遮蔽后的 persona 段换成猫娘，其余段不动', async () => {
  const h = harness({ [PROMPT_PATH]: CATGIRL }, { promptPath: PROMPT_PATH });
  const before = presetShadowed();
  const after = await h.assemble(before);

  assert.equal(after.sections[1].text, CATGIRL, 'preset 遮蔽过的那一段被换掉了');
  assert.equal(after.sections[1].interpolate, false);
  assert.deepEqual(after.sections[0], before[0]);
  assert.deepEqual(after.sections[2], before[2], '工作目录那一段原样保留');
  assert.equal(h.listeners[0].options.global, true, '每个 agent scope 的组装都要走到这里');
});

test('改 Markdown：下一轮组装就是新人格（不用重启）', async () => {
  const h = harness({ [PROMPT_PATH]: CATGIRL }, { promptPath: PROMPT_PATH });
  assert.equal((await h.assemble(presetShadowed())).sections[1].text, CATGIRL);

  h.fs.write(PROMPT_PATH, '# 换只猫\n\n现在是一只会写代码的猫。');
  const after = await h.assemble(presetShadowed());
  assert.equal(after.sections[1].text, '# 换只猫\n\n现在是一只会写代码的猫。');
  assert.equal(h.fs.calls.readText, 2);
});

test('人格文件读不到：装配结果原样返回，会话照常（并留下日志）', async () => {
  const h = harness({}, { promptPath: PROMPT_PATH });
  await h.command(''); // 让加载器先跑一次，错误才会落到状态里
  const before = presetShadowed();
  const after = await h.assemble(before);
  assert.deepEqual(after.sections, before, '没有人格就什么都不改，而不是塞一段空文本');
  assert.equal(h.logs.error.length >= 1, true, '读不到要能被运维看到');
});

test('装配结果里没有目标段：原样返回 + 告警一次，/persona 说得清楚', async () => {
  const h = harness({ [PROMPT_PATH]: CATGIRL }, { promptPath: PROMPT_PATH });
  const odd = [{ name: 'harness:identity', text: 'identity' }];
  assert.deepEqual((await h.assemble(odd)).sections, odd);
  assert.deepEqual((await h.assemble(odd)).sections, odd);
  assert.equal(h.logs.warn.length, 1, '同一件事只报一次，别每轮刷日志');

  const status = await h.command('');
  assert.match(status.text, /⚠ 没找到 deployment:persona-prefix/);
});

test('装配路径上出任何意外：吞掉、记日志、保持原样', async () => {
  const h = harness(
    { [PROMPT_PATH]: CATGIRL },
    { promptPath: PROMPT_PATH },
    {
      async resolve() {
        return { targetKey: 'x', displayPath: 'x' };
      },
      async stat() {
        throw new Error('后端炸了');
      },
      async readText() {
        throw new Error('不该走到这里');
      }
    }
  );
  const before = presetShadowed();
  const after = await h.assemble(before);
  assert.deepEqual(after.sections, before);
  assert.equal(h.logs.error.length >= 1, true);
});

test('/persona：报告加载状态、生效范围与最近一次组装', async () => {
  const h = harness({ [PROMPT_PATH]: CATGIRL }, { promptPath: PROMPT_PATH });
  const early = await h.command('');
  assert.match(early.text, /最近一次组装：还没组装过/);

  await h.assemble(presetShadowed());
  const loaded = await h.command('');
  assert.equal(loaded.kind, 'success');
  assert.match(loaded.text, /已加载 \d+ 字符/);
  assert.match(loaded.text, /已替换 deployment:persona-prefix/);
  assert.match(loaded.text, /预览：/);
});

test('/persona reload：跳过版本检查强制重读', async () => {
  const h = harness({ [PROMPT_PATH]: CATGIRL }, { promptPath: PROMPT_PATH });
  await h.command('');
  const before = h.fs.calls.readText;
  h.fs.write(PROMPT_PATH, CATGIRL);
  await h.command('reload');
  assert.equal(h.fs.calls.readText, before + 1);
});

test('promptPath 为空：完全不碰文件系统，装配结果原样返回', async () => {
  const h = harness({ [PROMPT_PATH]: CATGIRL }, { promptPath: '' });
  const before = presetShadowed();
  assert.deepEqual((await h.assemble(before)).sections, before);
  assert.equal((await h.command('')).text.includes('已关闭'), true);
});

test('interpolate: true 时把开关透传给 harness（人格里可以用 {{model}}）', async () => {
  const h = harness(
    { [PROMPT_PATH]: '你是跑在 {{model}} 上的猫神' },
    { promptPath: PROMPT_PATH, interpolate: true }
  );
  const after = await h.assemble(presetShadowed());
  assert.deepEqual(after.sections[1], {
    name: PERSONA_SECTION,
    text: '你是跑在 {{model}} 上的猫神',
    interpolate: true
  });
});
