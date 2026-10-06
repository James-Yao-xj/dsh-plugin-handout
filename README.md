---
description: "共读讲义：Markdown / 文本 / PDF 讲义接进会话，按节按页取文、随时提问"
kind: "package-bundle"
---

# dsh-plugin-handout

把一份讲义接进 DSH 会话，让模型和你**一起读**：按节 / 按页取原文、全文检索、同步阅读位置、记批注。

核心不是「渲染文档」——右侧栏的内置预览已经能显示 Markdown 和 PDF。这个插件补的是另外两件事：

1. **模型看不见你在读哪里。** 你滚到 3.2 节时，模型的上下文里没有任何一行提到这件事。
2. **一份讲义塞不进上下文。** 讲义动辄几万字，整份读进来既贵又会被压缩掉细节。

所以它的设计重心是 **「共享阅读位置」+「按需取文」**：状态里只存大纲（每节一行），正文永远按需读取。设计取舍与实现细节见 [docs/DESIGN.zh.md](docs/DESIGN.zh.md)。

## Summary

注册五个模型工具、一条会话投影、一段动态系统提示和一条斜杠命令：

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
/handout where          查看当前讲义和位置
/handout goto 3.2       跳到某一节（PDF 用页码，如 /handout goto 2）
```

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

## Model Experience

模型侧新增五个工具与一段动态上下文。上下文只在有讲义打开时出现，内容是讲义路径、节数 / 页数、用户当前所在位置与已记批注，以及 PDF 的书签目录（最多 40 条）；**正文永远需要显式调用 `handout_read` 才会进入上下文**。提示里还写了四条行为约束：先取原文再断言、引用要标坐标（`§3.2` / `p12`）、可以补充自己的知识但要明确区分讲义内容与补充。

#### KV Cache effect

讲义路径、当前位置、批注数量在会话中变化时，动态上下文前缀会改变，可能使该轮之后的 KV 缓存失效；没有打开讲义时该插件不产生任何提示文本（零开销）。

## Known Limitations and Deferred Work

- **没有图形界面。** 右侧栏「共读」面板（阶段 3）尚未实现，因此阅读位置目前靠用户口述，而不是滚动自动同步。
- **PDF 只支持有文字层的文档**，扫描件需要先 OCR；DOCX / PPTX / 图片讲义不支持。
- 阅读状态存在会话日志里，**跨会话不共享**。
- 检索是大小写不敏感的字面匹配，没有分词、模糊匹配或语义检索。
- 一次抽取整份 PDF，超大文档靠 `maxPdfPages` 截断。

## Dev Note

`lib/handout.js`（文本解析）与 `lib/pdf.js`（PDF 抽取）是零宿主依赖的纯函数，可以直接测；`lib/index.js` 才是 Cordis 插件。`test/plugin.test.js` 用假 `ctx` 把 `apply()` 真跑起来，覆盖工具注册、执行、投影、动态提示与命令，不需要启动 DSH。

```bash
pnpm install
node --test test/*.test.js      # 48 个测试
node test/fixtures/make-pdf.mjs /tmp/sample.pdf   # 生成一份样例 PDF
```

测试夹具 PDF 是用 30 行代码**手写生成**的（`test/fixtures/make-pdf.mjs`），不是二进制入库——夹具因此可读、可改、可复查。

## License

[MIT](LICENSE)
