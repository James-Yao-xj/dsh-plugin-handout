/**
 * lib/persona.js 的单测：路径解析、正文规范化、以及「在装配结果里换掉 persona 段」
 * 这一步（含各种不生效的情形）。
 *   node --test test/persona.test.js
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  PACKAGE_ROOT,
  PERSONA_SECTION,
  applyPersona,
  describeAssembly,
  formatPersonaStatus,
  normalizePrompt,
  resolvePromptPath
} from '../lib/persona.js';

const CATGIRL = '# 你是谁\n\n你的名字是 OpenCode，一只货真价实的小猫之神。';

/**
 * 一份仿造的系统提示装配结果。
 *
 * 这里刻意复刻 Web 会话的形状：agent preset 的 persona **已经**把部署级 persona
 * 遮蔽掉了（合并后只剩一份 `deployment:persona-prefix`，文本来自 preset）。
 * 这正是旧写法失效、而 waterfall 能救回来的场景。
 * @param persona - 合并后那一段 persona 的文本。
 * @returns 装配结果。
 */
function assembly(persona = 'You are a coding agent powered by the deepseek-flash model.') {
  return {
    sections: [
      { name: 'harness:identity', text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: PERSONA_SECTION, text: persona, interpolate: true },
      { name: 'deployment:persona-suffix', text: 'Your working directory is {{cwd}}.', interpolate: true }
    ],
    contexts: [],
    tools: [],
    variables: { cwd: '/workspace' }
  };
}

test('resolvePromptPath：空串关闭，相对路径按插件包根目录，支持 ~ 与绝对路径', () => {
  assert.equal(resolvePromptPath(''), undefined);
  assert.equal(resolvePromptPath('   '), undefined);
  assert.equal(resolvePromptPath(undefined), undefined);
  assert.equal(resolvePromptPath('prompts/catgirl.md'), join(PACKAGE_ROOT, 'prompts/catgirl.md'));
  assert.equal(resolvePromptPath('/etc/catgirl.md'), '/etc/catgirl.md');
  assert.equal(resolvePromptPath('~/notes/cat.md', { home: '/home/u' }), join('/home/u', 'notes/cat.md'));
  assert.equal(
    resolvePromptPath('prompts/c.md', { packageRoot: '/pkg' }),
    join('/pkg', 'prompts/c.md'),
    '相对路径不按会话 cwd 解析，而是相对包根目录'
  );
});

test('normalizePrompt：去 BOM、去 HTML 注释、trim；正文里的 {{...}} 原样保留', () => {
  assert.equal(normalizePrompt('\uFEFF# 你是谁\n'), '# 你是谁');
  assert.equal(normalizePrompt('<!-- 笔记 -->\n真正的正文'), '真正的正文');
  assert.equal(normalizePrompt('前\n<!--\n多行\n注释\n-->\n后'), '前\n\n后', '多行注释整块删掉');
  assert.equal(normalizePrompt('   \n  '), '');
  assert.equal(normalizePrompt('<!-- 只有注释 -->'), '', '通篇注释等于没有人格');
  assert.equal(normalizePrompt('讲 {{这个}} 时注意'), '讲 {{这个}} 时注意', '规范化不做模板替换');
});

test('applyPersona：替换 persona 段，其余段一个字节都不动', () => {
  const before = assembly();
  const { assembly: after, status } = applyPersona(before, { text: CATGIRL });

  assert.equal(status, 'replaced');
  assert.deepEqual(after.sections[1], { name: PERSONA_SECTION, text: CATGIRL, interpolate: false });
  assert.deepEqual(after.sections[0], before.sections[0], 'harness identity 不动');
  assert.deepEqual(after.sections[2], before.sections[2], 'persona suffix（工作目录那行）不动');
  assert.equal(after.sections.length, 3);
  assert.notEqual(after.sections, before.sections, '不要就地改调用方的数组');
  assert.equal(before.sections[1].text.includes('coding agent'), true, '原装配结果保持原样');
});

test('applyPersona：interpolate 可开，目标段可换', () => {
  const { assembly: after } = applyPersona(assembly(), {
    text: '你是 {{model}} 上的猫神',
    interpolate: true
  });
  assert.deepEqual(after.sections[1], { name: PERSONA_SECTION, text: '你是 {{model}} 上的猫神', interpolate: true });

  const custom = { sections: [{ name: 'custom:voice', text: '旧文本' }] };
  const replaced = applyPersona(custom, { text: '新文本', section: 'custom:voice' });
  assert.equal(replaced.status, 'replaced');
  assert.equal(replaced.assembly.sections[0].text, '新文本');
});

test('applyPersona：不生效的几种情形都返回原样的装配结果，且给出状态', () => {
  const before = assembly();

  const empty = applyPersona(before, { text: '' });
  assert.equal(empty.status, 'empty');
  assert.equal(empty.assembly, before, '没有正文就不该动装配结果');

  const missing = applyPersona(before, { text: CATGIRL, section: 'deployment:no-such-section' });
  assert.equal(missing.status, 'missing-section');
  assert.equal(missing.assembly, before, '找不到目标段时宁可什么都不做');

  const broken = applyPersona({ sections: '不是数组' }, { text: CATGIRL });
  assert.equal(broken.status, 'no-assembly');
  assert.deepEqual(broken.assembly, { sections: '不是数组' });
});

test('formatPersonaStatus：区分关闭 / 未加载 / 空文件 / 已加载 / 出错', () => {
  const base = {
    enabled: true,
    path: '/p/prompts/catgirl.md',
    text: CATGIRL,
    chars: CATGIRL.length,
    loaded: true,
    loadedAt: 0,
    error: undefined
  };
  assert.match(formatPersonaStatus(base), /已加载 \d+ 字符/);
  assert.match(formatPersonaStatus(base), /替换目标：系统提示的 deployment:persona-prefix 段/);
  assert.match(formatPersonaStatus(base), /按字面量注入/);
  assert.match(formatPersonaStatus(base, { interpolate: true }), /参与 \{\{变量\}\} 插值/);
  assert.match(formatPersonaStatus(base), /预览：/);
  assert.match(formatPersonaStatus({ ...base, text: '', chars: 0 }), /没有内容/);
  assert.match(formatPersonaStatus({ ...base, text: '', chars: 0, loaded: false }), /还没有成功读到/);
  assert.match(formatPersonaStatus({ ...base, error: '读不到' }), /⚠ 读不到/);
  assert.match(formatPersonaStatus({ ...base, error: '太大' }), /仍在使用上一次成功读到的版本/);
  assert.match(formatPersonaStatus({ ...base, enabled: false }), /已关闭/);
});

test('describeAssembly：把「加载了但没派上用场」也说清楚', () => {
  assert.match(describeAssembly(undefined), /还没组装过/);
  assert.match(describeAssembly({ status: 'replaced', at: 0 }), /已替换 deployment:persona-prefix/);
  assert.match(describeAssembly({ status: 'missing-section', at: 0 }), /⚠ 没找到/);
  assert.match(describeAssembly({ status: 'empty', at: 0 }), /跳过/);
  assert.match(describeAssembly({ status: 'no-assembly', at: 0 }), /⚠/);
  assert.match(describeAssembly({ status: '什么', at: 0 }), /未知状态/);
});
