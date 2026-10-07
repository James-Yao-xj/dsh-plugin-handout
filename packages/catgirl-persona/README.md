---
description: "猫娘人格：把部署级 persona 换成一份可编辑的 Markdown（猫神 OpenCode）"
kind: "package-bundle"
---

# dsh-persona-catgirl

把系统提示里的**部署级 persona** 换成一份随包发布的 Markdown：DSH 会用「猫神 OpenCode」的语气说话——轻松、治愈、爱用「喵」「w」「～」，而写 README / 设计说明 / 提交信息时自动切回轻快正式的笔调。

人格管的是**怎么说**；讲义与讲师提示词管的是**讲什么**（后者见同仓库的 [dsh-plugin-handout](../../README.md)）。

## Summary

一份 Markdown，加一个宿主侧插件：

| 组成 | 作用 |
| --- | --- |
| `prompts/catgirl.md` | 人格正文。改这一份就够了，**改完下一轮对话生效**，不用重启 |
| `lib/persona.js` | 纯逻辑：路径解析、正文规范化、在系统提示的装配结果里替换 persona 段 |
| `lib/loader.js` | 按文件版本缓存的加载层：版本没变不重读；读不到 / 超限时保留上一版 |
| `lib/index.js` | Cordis 插件：挂 `system-prompt/assemble` waterfall，注册 `/persona` |
| `cordis.patch.yml` | 往 profile 里插入一行插件（`catgirl-persona`） |

## 为什么不是一份 `cordis.patch.yml` 就够了

这个包最初**只有**一份 patch，去覆盖 `system-prompt` 行的 `personaPrefix`。那份配置在 TUI / 没有 agent preset 的 surface 上是有效的，但在 Web 里一个字都进不去模型：

- persona 前缀在 harness 里是一个**命名 section**（`deployment:persona-prefix`）；
- agent preset 挂的 `@deepseek-ai/dsh-persona` 会用**同名 section 遮蔽**部署级的那一份——「preset 拥有会话的人格」是 harness 写在源码注释里的设计；
- patch 只能改配置，改不动「这个 section 归谁」。

现在的做法是在 `SystemPrompt.assemble()` 的 **waterfall**（`system-prompt/assemble`）里改写**已经合并、已经遮蔽过**的 sections。harness 以 waterfall 的返回值为准，所以这一步在所有 surface 上都算数。

这样做的两个好处：

1. **不需要为 Web 复制一份 preset 的插件清单。** 也能修，但那份清单会冻结：以后 preset 新增的工具，猫娘会话里不会有。
2. **一处生效，处处生效。** Web 的 preset 会话、TUI、子代理走的是同一个组装路径。

原理、取舍与边界见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)：其中包括**这一步与官方 practice 的关系**——`cordis-plugin-development` skill 里写着「不要监听 `system-prompt/assemble` 来增删文本」，而这个插件用的正是它；为什么还是得这么做、代价是什么，那一节写了。

## Use this package

### 安装

需要 DeepSeek Harness（本插件在 `0.2.0-rc.2` 上开发验证）。

```bash
# ① 从本地源码目录（开发期推荐：pnpm 建软链，改人格立刻生效）
cd ~/.dsh/profiles/desktop
pnpm add /绝对路径/dsh-plugin-handout/packages/catgirl-persona

# ② 界面：Web 侧栏 → Plugins → 用绝对路径或 git 地址安装 → 启用
```

装完后把包名加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`（走界面安装时插件管理器会自动做这一步），然后重启或刷新。

### 改人格

直接改 `prompts/catgirl.md`，存盘即可——下一次组装系统提示时读的就是新版本，当前会话不用重开、DSH 不用重启。文件里的 HTML 注释不会进模型上下文，可以留给作者写笔记。

想确认它到底生效了没有：

```
/persona            # 用的是哪一份、多少字符、最近一次组装替换成功没有
/persona reload     # 跳过版本检查强制重读
```

### 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（patch 是**整块替换** `config`，所以要写全）：

```yaml
- id: catgirl-persona
  config:
    promptPath: ~/notes/my-persona.md   # 相对路径按插件包根目录；也接受 ~/ 与绝对路径；空串关闭
    maxChars: 12000                     # 超过就拒绝加载，并保留上一版
    section: 'deployment:persona-prefix'  # 要替换的段，一般不用改
    interpolate: false                  # 正文里的 {{变量}} 是否参与插值
```

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `promptPath` | `prompts/catgirl.md` | 人格文件。相对路径按插件包根目录解析（不按会话 cwd） |
| `maxChars` | `12000` | 字符上限。超过就拒绝本次加载，**保留上一版**而不是把人格抽走 |
| `section` | `deployment:persona-prefix` | 要替换的系统提示段 |
| `interpolate` | `false` | 是否让正文里的 `{{名字}}` 参与插值 |

### 界面上的标题与图标

插件卡片、bundle 详情和「内置插件」清单里的标题与描述，读的是 `locale/<语言>.json` 里 **`meta` 下面**的字段：

```json
{ "meta": { "title": "猫娘人格", "description": "把系统提示里的部署级 persona 换成……" } }
```

写成顶层 `title` / `description` 不会报错，只会被**静默忽略**，卡片退回显示包名 `dsh-persona-catgirl`。图标是 `package.json` 顶层的 `icon`（SVG / PNG / JPEG / WebP，不超过 256 KiB）。`test/locale.test.js` 把这两条契约挡住了。

`interpolate` 默认关闭是有意的：harness 遇到**未知**的 `{{变量}}` 会直接让整个系统提示组装失败。人格文件是要反复手改的文本，不该因为随手写了 `{{...}}` 就把会话弄坏。需要 `{{model}}` 这类变量时再打开它，并确保文件里每个 `{{...}}` 都是 DSH 已注册的变量。

## Model Experience

模型侧只看到一件事：系统提示里 persona 那一段换成了 `prompts/catgirl.md` 的正文。`harness:identity`（“You are an AI agent powered by DeepSeek Harness.”）与 persona 后缀（工作目录那一行）原样保留。

人格文件里可以写任何话术，但**不要**在里面重复工具说明、目录约定、讲义讲解规则——那些各有归属（工具 schema、`agent-instructions`、讲师提示词）。人格只负责语气与笔调。

## Known Limitations and Deferred Work

- **只替换 persona 前缀这一段。** 不接管 harness identity，也不接管 persona 后缀。
- **preset 若把 persona 标成 `complete: true`**，harness 会在 waterfall 之后用那一段整体覆盖提示词，本插件的替换会被丢掉（当前官方 preset 没有这么用）。
- **目标段名是字面量**（`deployment:persona-prefix`）。`@deepseek-ai/dsh-system-prompt` 在 npm 上确实有、也导出这个常量，但插件装在 profile 里会解析到自己那份 `node_modules`，引它只会带来版本偏移，所以仍然写死。harness 改名会让插件失效——但不会静默：日志告警一次，`/persona` 里能看到「⚠ 没找到」。
- **每轮组装一次 `stat`。** 本地小文件，代价可以接受；换来的是「改完 Markdown，下一轮就生效」。
- **一个 profile 一份人格。** 没有按会话 / 按 preset 切换人格的能力——那正是 agent preset 的活儿（在 Web 的 General 设置里选 preset）。
- 人格文件走 `ctx.fs` 读取。若你的沙箱策略把插件包目录挡在可读范围之外，把 `promptPath` 指向一个可读位置即可。

## Dev Note

`lib/persona.js`（纯函数）与 `lib/loader.js`（文件加载）零宿主依赖，可以直接测；`lib/index.js` 才是 Cordis 插件。`test/plugin.test.js` 用假 `ctx` 把 `apply()` 真跑起来，覆盖「preset 遮蔽后再替换」「文件读不到」「目标段不存在」「装配路径抛错」这些真正会出问题的路径，不需要启动 DSH。`test/locale.test.js` 不测代码，测**清单与 harness 读取方之间的契约**：`meta` 包装、`icon` 规则、读取方要解析的两个 `exports`。

```bash
node --test test/*.test.js      # 31 个测试（纯逻辑 7 + 加载层 8 + 插件集成 10 + 清单与显示元数据 6）
```

## License

[MIT](../../LICENSE)
