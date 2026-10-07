/**
 * 讲师提示词（教育提示词）的加载层。
 *
 * 目标：共读讲义时，让模型"像一个好老师那样讲"。做法不是把讲解风格写死在代码里，
 * 而是让部署方维护一份 Markdown，插件只负责把它读进来、接进系统提示。这样调
 * 「教学法」就是改一个文本文件，不用改代码、不用重启。
 *
 * 三条设计约束：
 *   1. **文件是热更新的**：用 `ctx.fs.stat` 的 `version`（`dev:ino:size:mtimeNs:ctimeNs`）
 *      判断有没有变过，每次共读工具调用顺手检查一次；改完 Markdown 下一轮就生效。
 *   2. **加载失败绝不反过来打断共读**：读不到就退回「没有讲师提示词」，错误留在
 *      状态里，由 `/handout teacher` 与日志暴露给用户。工具照常工作。
 *   3. **正文原样进系统提示**：不做 `{{变量}}` 插值（注册 section 时 `interpolate: false`），
 *      所以文件里出现 `{{...}}` 也不会让整个 system prompt 组装失败。
 *
 * 这里刻意只依赖一个 `dsh-fs` 形状的只读接口（`resolve` / `stat` / `readText`），
 * 不碰 cordis，所以能像 `handout.js` / `pdf.js` 一样直接单测。
 * @module dsh-plugin-handout/teacher
 */

import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 插件包根目录（`lib/` 的上一级）。相对路径的提示词按这里解析。 */
export const PACKAGE_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** 默认的讲师提示词文件，随包发布，部署方直接改这一份。 */
export const DEFAULT_PROMPT_PATH = 'prompts/teacher.md';

/** 单次加载的默认字符上限：提示词是要每轮都进上下文的，失控的文件必须被挡住。 */
export const DEFAULT_MAX_CHARS = 24000;

/**
 * 把配置里的路径解析成绝对路径。
 *
 * 相对路径**不**按会话 cwd 解析：提示词是部署级配置，跟着会话飘会让人莫名其妙。
 * 按插件包根目录解析，另外支持 `~/`（把提示词放在自己的笔记目录里）。
 * @param configured - `teacherPromptPath` 配置值。
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
 * 「这里是给谁看的」「改的时候注意什么」，而不必担心这些字进模型上下文。
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
 * 状态 → `/handout teacher` 的人读文本。
 * @param state - {@link createTeacherPrompt} 的 `state()`。
 * @param options - `{always, coReading}`：讲师提示词当前是否真的会生效。
 * @returns 多行文本。
 */
export function formatTeacherStatus(state, { always = false, coReading = false } = {}) {
  if (!state.enabled) return '讲师提示词：已关闭（teacherPromptPath 为空）。';
  const lines = [`讲师提示词：${state.path}`];
  if (state.error !== undefined) lines.push(`状态：⚠ ${state.error}`);
  if (state.text === '') {
    if (state.error === undefined) {
      lines.push(state.loaded ? '状态：文件去掉注释后没有内容，不注入任何提示词。' : '状态：还没有成功读到内容。');
    }
    return lines.join('\n');
  }
  const stale = state.error === undefined ? '' : '（仍在使用上一次成功读到的版本）';
  lines.push(`状态：已加载 ${state.chars} 字符${stale}，读入于 ${clock(state.loadedAt)}`);
  lines.push(`生效范围：${always ? '始终生效' : coReading ? '共读进行中，正在生效' : '还没有打开讲义，暂不生效'}`);
  lines.push(`预览：${preview(state.text)}`);
  return lines.join('\n');
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
 * 提示词开头一小段，用来确认「到底加载进来的是不是我以为的那份」。
 * @param text - 提示词正文。
 * @param limit - 字符上限。
 * @returns 单行预览。
 */
function preview(text, limit = 160) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`;
}

/** 一个「文件不在」的错误，要能和「读到了但读坏了」分开处理。 */
function isMissing(caught) {
  return caught?.code === 'FS_NOT_FOUND' || /ENOENT/i.test(String(caught?.message ?? ''));
}

/**
 * 创建一个讲师提示词加载器。
 *
 * 返回的对象是**可变状态 + 两个方法**：`sync()` 去磁盘上核对一次（异步，允许从工具
 * 执行里调用），`text()` 给系统提示组装用（同步，只能读缓存）。系统提示的组装是
 * 同步的，这是必须在别处先把文件读进来的根本原因。
 * @param options - `{path, maxChars, packageRoot, home, onError}`。
 * @returns `{sync, text, state}`。
 */
export function createTeacherPrompt({
  path,
  maxChars = DEFAULT_MAX_CHARS,
  packageRoot = PACKAGE_ROOT,
  home,
  onError
} = {}) {
  const file = resolvePromptPath(path, home === undefined ? { packageRoot } : { packageRoot, home });

  /** 当前生效的正文（读不到时为空串）。 */
  let text = '';
  /** 上一次**成功**处理的文件版本；用来跳过无谓的重读。 */
  let lastSeen;
  /** 是否成功看过一份文件（哪怕是空的）——空文件和「读不到」要分得清。 */
  let loaded = false;
  let loadedAt = 0;
  let error;

  /** 快照一份状态：调用方拿到的是值，不是活引用。 */
  const state = () => ({
    enabled: file !== undefined,
    path: file,
    text,
    chars: text.length,
    loaded,
    loadedAt,
    error
  });

  /** 记错误：日志是给运维的，`/handout teacher` 是给用户的，两边都要有。 */
  const fail = (message) => {
    error = message;
    if (onError !== undefined) onError(message);
  };

  /**
   * 文件不在了：清掉正文。
   * 用户删了文件却还在吃旧提示词，比报错更坏——所以这里不保留 `text`。
   */
  const markMissing = () => {
    text = '';
    loaded = false;
    loadedAt = 0;
    lastSeen = undefined;
    fail(`讲师提示词文件不存在：${file}（teacherPromptPath 指向的路径上没有文件）`);
    return state();
  };

  /**
   * 去磁盘核对一次提示词文件。
   *
   * - 版本没变 → 直接返回（不重读；每次工具调用都会走到这里，必须便宜）；
   * - 文件不在 → 清掉旧正文（用户删了文件却还在吃旧提示词，比报错更坏）；
   * - 超过 `maxChars` → 拒绝本次加载，但保留上一次的正文，避免中途抽掉提示词；
   * - 读失败 → 保留上一次的正文，且不记版本，下一次调用会再试。
   * @param fs - `ctx.fs`（或同形状的假对象）。
   * @param options - `{cwd, signal, force}`；`force` 跳过版本检查（`/handout teacher reload`）。
   * @returns 状态快照。
   */
  async function sync(fs, { cwd, signal, force = false } = {}) {
    if (file === undefined) return state();
    try {
      const target = await fs.resolve(file, { cwd, signal });
      const info = await fs.stat(target, signal);
      if (info === undefined || info.type === 'directory') return markMissing();
      if (!force && lastSeen !== undefined && info.version === lastSeen) return state();

      const raw = await fs.readText(target, signal);
      const normalized = normalizePrompt(raw);
      if (normalized.length > maxChars) {
        // 记下版本：同一份超限文件不必每次调用都重读一遍。
        lastSeen = info.version;
        const kept = text === '' ? '当前没有提示词生效' : `仍在使用上一次的 ${text.length} 字符版本`;
        fail(`讲师提示词有 ${normalized.length} 字符，超过 teacherPromptMaxChars（${maxChars}）：${kept}。`);
        return state();
      }
      text = normalized;
      loaded = true;
      loadedAt = Date.now();
      lastSeen = info.version;
      error = undefined;
      return state();
    } catch (caught) {
      // 文件不在（后端在 resolve 阶段就报错的情况）与「读到了但读坏了」分开：
      // 后者保留上一次的正文——一次读取抖动不该把已经生效的提示词抽走。
      if (isMissing(caught)) return markMissing();
      fail(`讲师提示词读取失败：${caught?.message ?? String(caught)}`);
      return state();
    }
  }

  return { sync, text: () => text, state };
}
