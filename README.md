---
description: "共读讲义：Markdown / 文本 / PDF 讲义接进会话，按节按页取文、随时提问，并按讲师提示词讲解"
kind: "package-bundle"
---

# dsh-plugin-handout

把一份讲义接进 DSH 会话，让模型和你**一起读**：按节 / 按页取原文、全文检索、同步阅读位置、记批注，并按你写的**讲师提示词**讲解。

核心不是「渲染文档」——右侧栏的内置预览已经能显示 Markdown 和 PDF。这个插件补的是另外三件事：

1. **模型看不见你在读哪里。** 你滚到 3.2 节时，模型的上下文里没有任何一行提到这件事。
2. **一份讲义塞不进上下文。** 讲义动辄几万字，整份读进来既贵又会被压缩掉细节。
3. **「讲什么」有了，「怎么讲」还没有。** 讲义决定内容，但讲解方式（先直觉还是先定义、一次讲多少、不确定时怎么说）默认由模型的通用风格决定。所以这里留了一份可维护的**讲师提示词**。

所以它的设计重心是 **「共享阅读位置」+「按需取文」+「可调的教学法」**：状态里只存大纲（每节一行），正文永远按需读取，讲解风格由一份 Markdown 决定。设计取舍与实现细节见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)。

## Summary

注册五个模型工具、一条会话投影、一段动态系统提示、一段静态系统提示（讲师提示词）和一条斜杠命令：

| 工具 | 作用 |
| --- | --- |
| `handout_open` | 打开讲义，返回目录大纲，并把它设为本次共读的讲义 |
| `handout_read` | 读一节（Markdown，含子节）或一页（PDF），也支持任意行区间 |
| `handout_search` | 全文检索，返回命中位置与上下文 |
| `handout_goto` | 记录用户当前读到哪一节 / 哪一页 |
| `handout_note` | 把疑问或批注挂在某一节 / 某一页上 |

支持三种来源：

- **Markdown** —— 按标题分节；编号优先采用讲义**自己**的数字（`3.2`、「第三讲」→`3`），取不到才回退层级编号；
- **纯文本** —— 没有标题时按 60 行一块兜底；
- **PDF** —— 按页寻址（`P12`，也接受 `12` / `p12`），逐页抽取文字层，并读出自带的书签目录作辅助；页眉、页码、纯符号行会被自动跳过，小标题取每页第一行**真内容**。

讲义正文不进会话日志；PDF 抽取结果按文件指纹（`dev:ino:size:mtimeNs:ctimeNs`）缓存，文件一改立刻失效。没有文字层的扫描件会明确报错并提示 OCR，而不是悄悄打开一份空讲义。

## Use this package

### 安装

需要 DeepSeek Harness（本插件在 `0.2.0-rc.2` 上开发验证）。三种装法：

```bash
# ① 从本地源码目录（开发期推荐：pnpm 会建软链，改代码立刻生效）
cd ~/.dsh/profiles/desktop
pnpm add /绝对路径/dsh-plugin-handout

# ② 从 git 仓库
cd ~/.dsh/profiles/desktop
pnpm add github:James-Yao-xj/dsh-plugin-handout

# ③ 界面：Web 侧栏 → Plugins → 用绝对路径或 git 地址安装 → 启用
```

装完后把包名加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`（走界面安装时插件管理器会自动做这一步），然后重启或刷新。

> 源码改动默认**不会**热重载：base 层给 `hmr` 的默认配置是 `root: []`，只监听配置。要打开源码热重载，在 profile 的 `cordis.patch.yml` 里覆盖这一行（详见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md) §5）：
>
> ```yaml
> - id: hmr
>   config:
>     base: /绝对路径              # 插件源码的父目录
>     root: ["dsh-plugin-handout"]
> ```

### 使用

1. 把讲义放进工作区（或任意可读路径）；
2. 让模型打开它：「打开 `handouts/xxx.pdf`」；
3. 然后自然语言提问、说位置、记批注：

| 你说 | 插件做什么 |
| --- | --- |
| 「读一下 3.2 节」/「翻到第 2 页」 | `handout_read` 取那一节 / 页的原文 |
| 「我在看第 2 页」 | `handout_goto` 记住位置，之后每轮请求都自动带上它 |
| 「讲义里哪提到 oscillate」 | `handout_search` 定位，返回命中页与上下文 |
| 「记一下：这里没懂」 | `handout_note` 记批注，后续每轮提示都带着 |

斜杠命令（不经过模型，直接改状态）：

```
/handout where            查看当前讲义和位置
/handout goto 3.2         跳到某一节（PDF 用页码，如 /handout goto 2）
/handout teacher          查看讲师提示词的加载状态、生效范围与预览
/handout teacher reload   改了提示词文件后强制重读一次
```

### 讲师提示词：让模型讲得更像老师

讲义决定「讲什么」，**讲师提示词**决定「怎么讲」——先给直觉还是先给定义、一次讲多少、拿不准时怎么说、要不要留自测题。它不是代码里的硬编码，而是一份 Markdown，你可以一直改：

```
prompts/teacher.md          # 随包发布，直接改这一份
```

随包发布的那份是**可用默认值**：面向本科在读学生，语言简朴、简洁，**禁止比喻句与类比**，讲义原文要标坐标，不确定就说不确定。它不绑定任何学科，按你自己的课改就是了。

内容会**原样**作为一段系统提示注入（位置在部署级 persona 之后、计划 / 工具策略之前），默认**只在打开讲义后生效**（`teacherAlways: true` 可以对所有对话生效）。三条约定值得先知道：

- **HTML 注释不会进提示词**（`<!-- ... -->`），可以在文件里放心留写作笔记；
- **不做模板变量替换**，所以正文里写 `{{...}}` 也是安全的；
- **改完存盘，下一轮对话就是新内容**：每次调用共读工具都会顺手核对文件的版本，不用重启 DSH，也不用重开讲义。想立刻确认就 `/handout teacher`。

路径怎么解析：相对路径按**插件包根目录**（不是会话 cwd——这是部署级配置），也接受绝对路径与 `~/`；写成空串就关掉这个功能。超过 `teacherPromptMaxChars` 会拒绝加载并在 `/handout teacher` 里报错——提示词每轮都进上下文，失控的文件必须有闸门。

<!-- 想换一份提示词：把 teacherPromptPath 指到自己的文件即可，例如 ~/notes/teacher.md。 -->

### 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖（整块 `config` 替换）：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxSectionChars` | `12000` | 单次 `handout_read` 返回的字符上限 |
| `maxOutlineEntries` | `300` | 大纲最多返回多少节 / 页 |
| `maxSearchHits` | `20` | 单次检索的命中上限 |
| `searchContextLines` | `3` | 每条命中附带的前后文行数 |
| `maxPdfBytes` | `67108864` | 允许读取的 PDF 字节上限 |
| `maxPdfPages` | `600` | 最多抽取多少页 |
| `pdfCacheEntries` | `4` | 缓存几份已抽取的 PDF |
| `teacherPromptPath` | `prompts/teacher.md` | 讲师提示词文件；相对包根目录，支持绝对路径与 `~/`，空串关闭 |
| `teacherPromptMaxChars` | `24000` | 讲师提示词字符上限，超过则拒绝本次加载 |
| `teacherOrder` | `100` | 讲师提示词在系统提示里的排序位置 |
| `teacherAlways` | `false` | 没有打开讲义时也注入讲师提示词 |

## Model Experience

模型侧新增五个工具、一段动态上下文与一段静态提示（讲师提示词）。动态上下文只在有讲义打开时出现，内容是讲义路径、节数 / 页数、用户当前所在位置与已记批注，以及 PDF 的书签目录（最多 40 条）；**正文永远需要显式调用 `handout_read` 才会进入上下文**。提示里还写了四条行为约束：先取原文再断言、引用要标坐标（`§3.2` / `p12`）、可以补充自己的知识但要明确区分讲义内容与补充。

讲师提示词是**静态**文本（走 `systemPrompt.section`，`interpolate: false`），默认只在共读进行中出现，内容完全由部署方的 Markdown 决定；去掉 HTML 注释后为空就等于不注入。

#### KV Cache effect

讲义路径、当前位置、批注数量在会话中变化时，动态上下文前缀会改变，可能使该轮之后的 KV 缓存失效；没有打开讲义时该插件不产生任何提示文本（零开销）。讲师提示词只在文件真的改动（文件版本变化）时才换文本，平时是稳定的前缀，不额外破坏缓存。

## Known Limitations and Deferred Work

- **没有图形界面。** 右侧栏「共读」面板（阶段 4）尚未实现，因此阅读位置目前靠用户口述，而不是滚动自动同步。
- **PDF 只支持有文字层的文档**，扫描件需要先 OCR；DOCX / PPTX / 图片讲义不支持。
- 阅读状态存在会话日志里，**跨会话不共享**。
- 检索是大小写不敏感的字面匹配，没有分词、模糊匹配或语义检索。
- 一次抽取整份 PDF，超大文档靠 `maxPdfPages` 截断。
- 讲师提示词是**每份提示词一份文件、全 profile 共用一个**：没有按讲义 / 按会话切换提示词的能力，也没有「A/B 两份提示词比效果」的机制。

## Dev Note

`lib/handout.js`（文本解析）、`lib/pdf.js`（PDF 抽取）与 `lib/teacher.js`（讲师提示词加载）是零宿主依赖的纯函数，可以直接测；`lib/index.js` 才是 Cordis 插件。`test/plugin.test.js` 用假 `ctx` 把 `apply()` 真跑起来，覆盖工具注册、执行、投影、动态提示、讲师提示词与命令，不需要启动 DSH。

```bash
pnpm install
node --test test/*.test.js      # 65 个测试（文本 11 + PDF 16 + 插件集成 29 + 讲师提示词 9）
node test/fixtures/make-pdf.mjs /tmp/sample.pdf   # 生成一份样例 PDF
```

测试夹具 PDF 是用 30 行代码**手写生成**的（`test/fixtures/make-pdf.mjs`），不是二进制入库——夹具因此可读、可改、可复查。

## License

[MIT](LICENSE)
