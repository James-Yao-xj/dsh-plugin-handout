/**
 * 猫娘人格插件（`dsh-persona-catgirl`，宿主半）。
 *
 * 一句话：把系统提示里的**部署级 persona** 换成一份随包发布的 Markdown，
 * 让 DSH 用「猫神 OpenCode」的语气说话，写文档时自动切回轻快正式。
 *
 * ## 为什么不是「纯配置 bundle」
 *
 * 这个包最初只是一份 `cordis.patch.yml`，去覆盖 `system-prompt` 行的
 * `personaPrefix`。那样写在 **TUI / 无 preset 的 surface 上有效**，但在 Web 里
 * 一个字都进不去：agent preset 挂的 `@deepseek-ai/dsh-persona` 会用同名 section
 * 遮蔽部署级 persona（harness 的设计如此，见 `lib/persona.js` 的模块注释）。
 *
 * 现在改成在 `system-prompt/assemble` 这个 waterfall 里改写**已经合并、已经遮蔽
 * 过**的 sections：
 *
 *   - 所有 surface 一致生效，不需要为 Web 复制一份 preset 的插件清单；
 *   - preset 以后新增工具，这里不用跟着改（旧写法会冻结住那份清单）；
 *   - 人格文本放在 `prompts/catgirl.md`，改完下一轮生效，不用重启。
 *
 * ## 接缝
 *
 * - `systemPrompt`：拿 `system-prompt/assemble` 这个 waterfall（`{global: true}`，
 *   因为要覆盖每一个 agent scope 的组装，包括 preset 会话与子代理）；
 * - `fs`：用 `ctx.fs` 读人格文件（拿 `stat.version` 做失效判断，和讲师提示词一致）；
 * - `commands`：`/persona` 查看与重载，专门用来回答「人格到底生效了没有」。
 *
 * 组装路径上的任何异常都被吞掉并记日志：人格插件坏掉只该退化成「没有人格覆盖」，
 * 不该让整个会话无法请求模型。
 * @module dsh-persona-catgirl
 */

import z from '@deepseek-ai/schemastery';
import { createPersonaLoader } from './loader.js';
import {
  DEFAULT_MAX_CHARS,
  DEFAULT_PROMPT_PATH,
  PERSONA_SECTION,
  applyPersona,
  formatPersonaStatus
} from './persona.js';

/** Cordis 插件名，用于加载器诊断。 */
const name = 'catgirl-persona';

/** 需要的服务：系统提示装配、文件系统、斜杠命令。 */
const inject = ['systemPrompt', 'fs', 'commands'];

/** 部署侧可调参数。 */
const Config = z.object({
  /**
   * 人格提示词文件（Markdown）。相对路径按**插件包根目录**解析（不按会话 cwd：
   * 这是部署级配置），也接受绝对路径与 `~/`；空串表示不要这个插件管人格。
   */
  promptPath: z.string().default(DEFAULT_PROMPT_PATH),
  /** 人格正文的字符上限；超过就拒绝本次加载，保留上一版。 */
  maxChars: z.natural().default(DEFAULT_MAX_CHARS),
  /** 要被替换的系统提示段。默认是部署级 persona 前缀，一般不用改。 */
  section: z.string().default(PERSONA_SECTION),
  /**
   * 正文里的 `{{变量}}` 是否参与插值。默认 false：按字面量注入，文件里随手写的
   * `{{...}}` 不会让整个系统提示组装失败（未知变量在 harness 里是**硬错误**）。
   */
  interpolate: z.boolean().default(false)
});

/**
 * 插件主体。
 * @param ctx - 插件上下文。
 * @param config - 已解析的插件配置。
 */
function apply(ctx, config) {
  const loader = createPersonaLoader({
    path: config.promptPath,
    maxChars: config.maxChars,
    onError: (message) => ctx.logger?.error?.(`[catgirl-persona] ${message}`)
  });

  /** 最近一次组装的结果，只给 `/persona` 看：回答「加载了但有没有派上用场」。 */
  let lastAssembly;
  /** 「目标段不存在」只报一次，免得每轮请求都刷一行日志。 */
  let reportedMissing = false;

  // 加载时先读一次：这样第一条请求就已经是猫娘，而不是「先普通地回一句再说」。
  // 故意不 await：一个文本文件不该拖慢插件加载，读不到也只是少一层人格。
  void loader.sync(ctx.fs);

  // ── 系统提示装配：把合并后的 persona 段换掉 ─────────────────────────────
  ctx.on(
    'system-prompt/assemble',
    async (assembly, context, next) => {
      const result = await next();
      try {
        // 每轮组装都要核对一次文件版本；没变过就只是一次 stat。
        await loader.sync(ctx.fs, { signal: context?.signal });
        const outcome = applyPersona(result, {
          text: loader.text(),
          section: config.section,
          interpolate: config.interpolate
        });
        lastAssembly = { status: outcome.status, at: Date.now() };
        if (outcome.status === 'missing-section' && !reportedMissing) {
          reportedMissing = true;
          ctx.logger?.warn?.(
            `[catgirl-persona] 系统提示里没有 ${config.section} 段，人格没有生效：` +
              '这一版 harness 可能改了 section 名，用 /persona 可以看到最近一次组装结果。'
          );
        } else if (outcome.status === 'replaced') {
          reportedMissing = false;
        }
        return outcome.assembly;
      } catch (caught) {
        // 组装路径上的异常绝不上抛：宁可这一轮没有人格，也不能让会话请求模型失败。
        ctx.logger?.error?.(`[catgirl-persona] 替换人格失败，本轮保持原样：${caught?.message ?? String(caught)}`);
        return result;
      }
    },
    // 每个 agent scope 的组装都要走到这里，包括 preset 会话与子代理。
    { global: true }
  );

  // ── 斜杠命令：/persona —— 回答「人格到底生效了没有」 ─────────────────────
  ctx.commands.register({
    name: 'persona',
    description: '查看/重载部署级人格提示词（猫娘人格）',
    handler: async (invocation) => {
      // `reload` 跳过版本检查强制重读：改了 Markdown 想立刻确认时用它。
      const force = /^(reload|refresh|重载)$/i.test(invocation.rawInput.trim());
      const snapshot = await loader.sync(ctx.fs, { signal: invocation.signal, force });
      return {
        kind: snapshot.error === undefined ? 'success' : 'error',
        text: formatPersonaStatus(snapshot, {
          section: config.section,
          interpolate: config.interpolate,
          lastAssembly
        })
      };
    }
  });
}

export { apply, Config, inject, name };
