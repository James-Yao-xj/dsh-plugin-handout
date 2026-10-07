/**
 * 猫娘人格插件（`dsh-persona-catgirl`）的纯逻辑层。
 *
 * 这一层不碰 cordis，只做三件事：把配置里的路径解析成绝对路径、规范化 Markdown
 * 正文、以及在**系统提示的装配结果**里把 persona 那一段换掉。分出来的理由和
 * `dsh-plugin-handout` 的 `handout.js` 一样：会出错的就是这几步，值得直接单测。
 *
 * ## 为什么是「改装配结果」而不是「改配置」
 *
 * persona 前缀在 harness 里是一个**命名 section**（`deployment:persona-prefix`）。
 * agent preset 里的 `@deepseek-ai/dsh-persona` 会用**同名 section 遮蔽**部署级的
 * 那一份——这是它写在源码注释里的设计意图（preset 拥有会话的人格）。所以只改
 * `system-prompt` 那一行的 `personaPrefix` 配置，在 Web 会话里会被 preset 整段挡住，
 * 一个字都进不去模型。旧的猫娘 bundle 就是这么写的，因此一直没有生效。
 *
 * 而 `SystemPrompt.assemble()` 的最后一步是一个 waterfall：
 *
 * ```js
 * const transformed = await this.ctx.waterfall(target, 'system-prompt/assemble', assembly, context, next)
 * ```
 *
 * 并且**以 waterfall 的返回值为准**。在这个 waterfall 里改写已经合并、已经遮蔽过
 * 的 sections，就能在所有 surface（Web 的 preset 会话、TUI、子代理）上一致生效，
 * 而且不需要复制一遍 preset 的插件清单——preset 以后加了什么工具，这里不用跟着改。
 *
 * @module dsh-persona-catgirl/persona
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（`lib/` 的上一级）。相对路径的人格提示词按这里解析。 */
export const PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认的人格提示词文件，随包发布，直接改这一份。 */
export const DEFAULT_PROMPT_PATH = 'prompts/catgirl.md';

/** 单次加载的默认字符上限：这段文本每轮都进上下文，失控的文件必须被挡住。 */
export const DEFAULT_MAX_CHARS = 12000;

/**
 * 要被顶掉的 section 名。
 *
 * 取值来自 `@deepseek-ai/dsh-system-prompt` 导出的 `PERSONA_PREFIX_SECTION`。那个包
 * 属于 harness 本体、没有随 npm 发布，所以这里按字面量写死。代价是：万一 harness
 * 改了这个名字，插件会「找不到目标段」。因此 {@link applyPersona} 把这种情况当成
 * 一个**要上报的状态**（而不是静默返回），由日志与 `/persona` 暴露出来。
 */
export const PERSONA_SECTION = 'deployment:persona-prefix';

/**
 * 把配置里的路径解析成绝对路径。
 *
 * 相对路径**不**按会话 cwd 解析：人格是部署级配置，跟着会话飘会让人莫名其妙。
 * 按插件包根目录解析，另外支持 `~/`（把人格放在自己的笔记目录里）。
 * @param configured - `promptPath` 配置值。
 * @param options - `{packageRoot, home}`，测试用注入点。
 * @returns 绝对路径；配置为空（关掉这个功能）时返回 `undefined`。
 */
export function resolvePromptPath(configured, { packageRoot = PACKAGE_ROOT, home = homedir() } = {}) {
  const raw = String(configured ?? '').trim();
  if (raw === '') return undefined;
  if (raw === '~') return home;
  if (raw.startsWith(`~${sep}`) || raw.startsWith('~/')) return join(home, raw.slice(2));
  return isAbsolute(raw) ? raw : resolvePath(packageRoot, raw);
}

/**
 * 规范化提示词正文：去 BOM、去 HTML 注释、trim。
 *
 * 注释不上屏是刻意的：这份文件是要给人反复读改的，允许作者在里面留笔记、写
 * 「这段为什么这么写」，而不必担心这些字进模型上下文。
 * @param markdown - 文件原始内容。
 * @returns 真正要进系统提示的正文。
 */
export function normalizePrompt(markdown) {
  return String(markdown ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
}

/**
 * 把装配结果里的目标 section 换成人格文本。
 *
 * 只动匹配到的那一个 section，其余原样保留（顺序、`interpolate` 标记都不碰别的段）。
 * 返回状态而不是抛错，是因为这里跑在每一轮请求的组装路径上：它坏了不该让会话坏掉。
 * @param assembly - `system-prompt/assemble` waterfall 收到的装配结果。
 * @param options - `{text, section, interpolate}`。
 * @returns `{assembly, status}`，`status` 为：
 *   - `replaced` —— 已替换；
 *   - `empty` —— 人格正文为空（文件没读到 / 被关掉），原样返回；
 *   - `missing-section` —— 装配结果里没有目标段（多半是 harness 改了 section 名）；
 *   - `no-assembly` —— 收到的不是预期的装配结构。
 */
export function applyPersona(assembly, { text, section = PERSONA_SECTION, interpolate = false } = {}) {
  if (typeof text !== 'string' || text === '') return { assembly, status: 'empty' };
  const sections = assembly?.sections;
  if (!Array.isArray(sections)) return { assembly, status: 'no-assembly' };
  const index = sections.findIndex((entry) => entry?.name === section);
  if (index === -1) return { assembly, status: 'missing-section' };
  const next = sections.slice();
  next[index] = { name: section, text, interpolate };
  return { assembly: { ...assembly, sections: next }, status: 'replaced' };
}

/**
 * 时间戳 → `HH:MM:SS`。不用 `toLocaleTimeString`，免得输出随机器语言变。
 * @param at - 毫秒时间戳。
 * @returns 文本。
 */
function clock(at) {
  const date = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * 正文开头一小段，用来确认「加载进来的到底是不是我以为的那份」。
 * @param text - 人格正文。
 * @param limit - 字符上限。
 * @returns 单行预览。
 */
function preview(text, limit = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/**
 * 状态 → `/persona` 的人读文本。
 * @param state - {@link createPersonaLoader} 的 `state()`。
 * @param options - `{section, interpolate, lastAssembly}`：目标段、是否插值、最近一次组装的结果。
 * @returns 多行文本。
 */
export function formatPersonaStatus(state, { section = PERSONA_SECTION, interpolate = false, lastAssembly } = {}) {
  if (!state.enabled) return '人格提示词：已关闭（promptPath 为空），系统提示里的 persona 保持原样。';
  const lines = [`人格提示词：${state.path}`, `替换目标：系统提示的 ${section} 段（${interpolate ? '参与 {{变量}} 插值' : '按字面量注入'}）`];
  if (state.error !== undefined) lines.push(`状态：⚠ ${state.error}`);
  if (state.text === '') {
    if (state.error === undefined) {
      lines.push(state.loaded ? '状态：文件去掉注释后没有内容，不覆盖任何人格。' : '状态：还没有成功读到内容。');
    }
  } else {
    const stale = state.error === undefined ? '' : '（仍在使用上一次成功读到的版本）';
    lines.push(`状态：已加载 ${state.chars} 字符${stale}，读入于 ${clock(state.loadedAt)}`);
    lines.push(`预览：${preview(state.text)}`);
  }
  lines.push(`最近一次组装：${describeAssembly(lastAssembly, section)}`);
  return lines.join('\n');
}

/**
 * 最近一次组装结果的人读描述。
 *
 * 这一段是专门为「人格到底有没有生效」准备的：插件可以「加载成功但没派上用场」，
 * 比如目标段不存在，或者用户根本没发过请求。
 * @param lastAssembly - `{status, at}`，或 `undefined`。
 * @param section - 目标段名。
 * @returns 单行文本。
 */
export function describeAssembly(lastAssembly, section = PERSONA_SECTION) {
  if (lastAssembly === undefined) return '还没组装过系统提示（发一条消息再看）。';
  switch (lastAssembly.status) {
    case 'replaced':
      return `已替换 ${section}（${clock(lastAssembly.at)}）。`;
    case 'missing-section':
      return `⚠ 没找到 ${section}：这一版 harness 里人格段可能改名了，人格没有生效。`;
    case 'empty':
      return `人格正文为空，跳过（${clock(lastAssembly.at)}）。`;
    case 'no-assembly':
      return `⚠ 收到的装配结构不认识，无法替换（${clock(lastAssembly.at)}）。`;
    default:
      return `未知状态：${String(lastAssembly.status)}`;
  }
}
