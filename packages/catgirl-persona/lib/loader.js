/**
 * 人格提示词的加载层：把一份 Markdown 读进来、缓存、按文件版本失效。
 *
 * 与 `lib/persona.js` 的分工：那边是纯函数（怎么改装配结果），这边是有状态的文件
 * 加载。三条约束直接沿用共读插件的讲师提示词（`dsh-plugin-handout/lib/teacher.js`），
 * 因为要解决的问题是同一个：
 *
 *   1. **热更新**：用 `ctx.fs.stat` 的 `version`（`dev:ino:size:mtimeNs:ctimeNs`）
 *      判断文件变没变。改完 Markdown，下一轮组装就是新人格，不用重启 DSH。
 *   2. **失败绝不反过来打断会话**：读不到就退回「不覆盖人格」，系统提示照常组装，
 *      错误留在状态里，由日志与 `/persona` 暴露给用户。一个改人格的插件没有资格
 *      把一次读盘失败升级成整个会话不可用。
 *   3. **超限保留上一版**：文件被改坏（整段贴错、贴了别的东西）时，宁可用上一版
 *      人格继续说，也不要中途把人格抽走。
 *
 * 与讲师提示词唯一不同的地方：这里的 `sync()` 可以直接在系统提示的组装路径上
 * `await`（`system-prompt/assemble` 是个 waterfall，允许异步），所以不必像讲师提示词
 * 那样靠工具调用顺手刷新。代价是每轮请求多一次 `stat`——本地小文件，可以接受。
 * @module dsh-persona-catgirl/loader
 */

import { normalizePrompt, resolvePromptPath } from './persona.js';

/** 一个「文件不在」的错误，要能和「读到了但读坏了」分开处理。 */
function isMissing(caught) {
  return caught?.code === 'FS_NOT_FOUND' || /ENOENT/i.test(String(caught?.message ?? ''));
}

/**
 * 创建一个人格提示词加载器。
 *
 * 返回的对象是**可变状态 + 两个方法**：`sync()` 去磁盘上核对一次（异步），
 * `text()` 取当前生效的正文（同步，给组装用）。
 * @param options - `{path, maxChars, packageRoot, home, onError}`。
 * @returns `{sync, text, state}`。
 */
export function createPersonaLoader({
  path,
  maxChars,
  packageRoot,
  home,
  onError
} = {}) {
  const file = resolvePromptPath(
    path,
    home === undefined ? { packageRoot } : { packageRoot, home }
  );

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

  /** 记错误：日志是给运维的，`/persona` 是给用户的，两边都要有。 */
  const fail = (message) => {
    error = message;
    if (onError !== undefined) onError(message);
  };

  /**
   * 文件不在了：清掉正文。
   * 用户删了文件却还在吃旧人格，比报错更坏——所以这里不保留 `text`。
   * @returns 状态快照。
   */
  const markMissing = () => {
    text = '';
    loaded = false;
    loadedAt = 0;
    lastSeen = undefined;
    fail(`人格提示词文件不存在：${file}（promptPath 指向的路径上没有文件）`);
    return state();
  };

  /**
   * 去磁盘核对一次人格提示词文件。
   *
   * - 版本没变 → 直接返回（每轮组装都会走到这里，必须便宜）；
   * - 文件不在 → 清掉旧正文；
   * - 超过 `maxChars` → 拒绝本次加载，但保留上一次的正文；
   * - 读失败 → 保留上一次的正文，且不记版本，下一次组装会再试。
   * @param fs - `ctx.fs`（或同形状的假对象）。
   * @param options - `{signal, force}`；`force` 跳过版本检查（`/persona reload`）。
   * @returns 状态快照。
   */
  async function sync(fs, { signal, force = false } = {}) {
    if (file === undefined) return state();
    try {
      const target = await fs.resolve(file, { signal });
      const info = await fs.stat(target, signal);
      if (info === undefined || info.type === 'directory') return markMissing();
      if (!force && lastSeen !== undefined && info.version === lastSeen) return state();

      const normalized = normalizePrompt(await fs.readText(target, signal));
      if (normalized.length > maxChars) {
        // 记下版本：同一份超限文件不必每轮都重读一遍。
        lastSeen = info.version;
        const kept = text === '' ? '当前不覆盖人格' : `仍在使用上一次的 ${text.length} 字符版本`;
        fail(`人格提示词有 ${normalized.length} 字符，超过 maxChars（${maxChars}）：${kept}。`);
        return state();
      }
      text = normalized;
      loaded = true;
      loadedAt = Date.now();
      lastSeen = info.version;
      error = undefined;
      return state();
    } catch (caught) {
      // 文件不在（后端在 resolve 阶段就报错）与「读到了但读坏了」分开：
      // 后者保留上一次的正文——一次读取抖动不该把已经生效的人格抽走。
      if (isMissing(caught)) return markMissing();
      fail(`人格提示词读取失败：${caught?.message ?? String(caught)}`);
      return state();
    }
  }

  return { sync, text: () => text, state };
}
