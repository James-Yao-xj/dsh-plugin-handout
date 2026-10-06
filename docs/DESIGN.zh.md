# dsh-plugin-handout —— 设计与实现说明

> 目的：让模型和你一起读一份讲义。你随时提问，模型基于**讲义原文 + 它自己的知识**回答与讲解。
>
> 本文记录这个插件的设计取舍、模块职责，以及踩过的坑。文中关于 DSH 插件机制的结论，都来自把安装好的 `DeepSeek Harness.app` 里的 `app.asar` 拆开读源码（版本 `0.2.0-rc.2`，cordis `~4.0.4`），并且**宿主半已经在真机上跑通**；没亲自验证的部分都明确标了「未做」或「未验证」。

## 当前状态（真机验证）

| 能力 | 状态 |
| --- | --- |
| 插件装进 profile 并被加载 | ✅ 已装进 `~/.dsh/profiles/desktop`，`handout_*` 工具已在会话中生效 |
| Markdown 讲义：分节、按节取文、检索 | ✅ 真机跑通 |
| PDF 讲义：逐页抽取、按页寻址、检索 | ✅ 真机跑通（4 页样例） |
| 动态系统提示带出「用户读到哪」 | ✅ 真机可见 |
| 源码热重载（HMR） | ✅ 已配置并验证（见 §5） |
| 扫描件（无文字层）PDF | ✅ 明确报错并提示 OCR |
| 单测 / 集成测试 | ✅ 42 个测试全绿（`node --test test/*.test.js`） |
| 浏览器半（右侧栏共读面板） | ⬜ 未做，见 §6 阶段 3 |

---

## 0. 先说一个反直觉的结论

「把讲义显示出来」这件事 **DSH 已经内置了**：右侧栏内置了文档预览（`dsh-client-ui-sidebar-documentpreview`，支持文本/Markdown/PDF/Excel/Office）。所以不需要为「看讲义」写任何代码。

真正缺的是两件事：

1. **模型看不见你在看什么。** 用户打开 `lecture-03.md` 滚到 3.2 节时，模型的上下文里没有任何一行提到这件事。所以「随时提问」必须靠用户每次把位置说清楚，或者靠插件把位置同步过去。
2. **一份讲义塞不进上下文。** 讲义动辄几万字，整份读进来既贵又会被压缩掉细节。所以需要**按节取文 + 检索**，让模型精确地拿到它正在回答的那一小段。

所以这个插件的设计重心是 **「共享阅读位置」+「按需取文」**，而不是「渲染文档」。

---

## 1. 插件体系：三个必须分清的层次

DSH 的插件系统是 **Cordis 插件 + profile 层叠补丁**。三层概念：

| 层 | 是什么 | 长什么样 |
| --- | --- | --- |
| **插件包（plugin）** | 一个 ESM 包，导出 `apply(ctx, config)` | `@deepseek-ai/dsh-tool-todo` |
| **行（row / entry）** | 插件的一次实例化：`{id, name, config, disabled}` | `cordis.patch.yml` 里的一个数组项 |
| **束（bundle）** | 一个包，带 `dsh.bundle.patch` 指向若干 `cordis.patch.yml`，作用是「一次插入多行」 | `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app` |

profile 的层叠顺序（从下往上，上面的覆盖下面的）：

```
空 profile 根（~/.dsh/profiles/desktop/cordis.yml，永远是 []）
  + dsh-base 的 patch            （核心行）
  + dsh-web-app 的 patch         （网页界面、浏览器侧插件名单）
  + 各已启用 bundle 的 patch      （比如你新写的插件）
  + ~/.dsh/profiles/desktop/cordis.patch.yml   ← 你自己的覆盖层
  + --patch 命令行覆盖层
```

**覆盖是按 id 整块替换 `config` 的**，所以想让插件参数可调，就在 bundle 的 patch 里给默认值，你自己在 profile 的 `cordis.patch.yml` 里用同一个 id 覆盖。

### 一个包可以同时有「宿主半」和「浏览器半」

这是本插件后续做图形界面的关键：

```jsonc
{
  "main": "lib/index.js",              // 宿主半：Node 侧，定义工具、服务、系统提示
  "exports": {
    ".":        { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" }   // 浏览器半
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },       // 作为束被安装
    "client": { "platform": "web", "inject": ["sidebarRightTabs", "slots", "locale"] }
  }
}
```

`dsh.client` 是**浏览器侧名单的声明**：宿主启动时会扫描每一行的包清单，把这个字段读进 `window.__DSH_BOOT__`，浏览器端再去 `/plugins/<包名>/client.js` 取代码。

---

## 2. 推荐架构：三个面

```
┌─ 讲义文件：.md / .txt / .pdf ───────────────────────────────┐
│  lecture-03.md          deck.pdf                            │
└─────────────────────────────────────────────────────────────┘
        ▲ 只读：文本直接读；PDF 抽成逐页文本（按指纹缓存）
┌─ 宿主半（lib/index.js）─────────────────────────────────────┐
│  工具：handout_open / handout_read / handout_search          │
│        handout_goto / handout_note                          │
│  状态：会话投影 handout = { path, kind, sections,            │
│                            bookmarks, anchor, notes }        │
│  提示：动态系统提示「用户正在读 §3.2 / 第 12 页」             │
│  命令：/handout where | goto <节编号|页码>                    │
└─────────────────────────────────────────────────────────────┘
              ▲ 状态订阅 / ▼ 位置回写
┌─ 浏览器半（lib/client.js）—— 阶段 3（未做） ────────────────┐
│  右侧栏新增「共读」标签页：大纲树 + 正文 + 当前位置高亮        │
│  滚动/选中 → 回写 anchor；选中文字 → 「就这段提问」           │
└─────────────────────────────────────────────────────────────┘
```

关键设计决定，以及为什么：

- **讲义正文不进会话日志。** 状态里只存大纲（每节一行：`{id, level, title, line, endLine}`）。读正文时按路径重新读一遍文件。好处：会话日志小、讲义改了你立刻看到新内容、`/export` 出来的记录里不会夹着一整本书。PDF 也一样——状态里存的是页区间，不是页面文字。
- **PDF 的寻址单位是「页」，不是标题。** PDF 里没有可靠的标题层级（书签常常缺失或不可信），而「我在第 12 页」是人和模型都不会搞错的坐标。书签目录只作为辅助信息呈现，不用来寻址。
- **Markdown 的编号优先用讲义自己的数字。** 讲义正文写着「3.2 学习率」，用户就会说「我在看 3.2 节」；如果插件按标题层级另生成一套编号，就会得到 `1.2`，跟用户说的对不上。所以 `numberingOf()` 先认 `3.2`/`5.`/`4 `，再认「第三讲」→`3`，取不到才回退层级编号（撞车时也回退，保证 id 唯一）。这一条是写完第一版真机试出来的。
- **状态用 session projection，不用内存 Map。** 投影随会话日志重放，会话恢复后位置还在；浏览器半也能直接订阅它，不用另发明一套 RPC。
- **位置同步走动态系统提示（`systemPrompt.context`），不走静态提示。** 静态提示会把「第 3.2 节」写死在 KV 缓存前缀里；动态上下文每轮重算，才不会因为位置变化而破坏缓存命中（而且没有讲义打开时它返回空字符串，等于零开销）。

---

## 3. 目录结构

仓库根就是插件包本身，这样 `pnpm add <git-url>` 能直接装：

```
dsh-plugin-handout/                ← 仓库根 = 插件包
├── package.json                   ← 包清单：exports / dsh.bundle / 依赖策略
├── cordis.patch.yml               ← 这个束往 profile 里插入哪些「行」
├── icon.svg                       ← 插件管理页的图标
├── README.md                      ← 插件管理页的详情文案（带 front-matter）
├── LICENSE
├── docs/
│   └── DESIGN.zh.md               ← 本文
├── lib/
│   ├── index.js                   ← 宿主半：工具 + 状态 + 系统提示 + 命令
│   ├── handout.js                 ← 文本讲义：大纲 / 取节 / 检索（零依赖纯函数）
│   ├── pdf.js                     ← PDF 讲义：逐页抽文 + 书签 + 指纹缓存
│   └── client.js                  ← 浏览器半：右侧栏共读面板（阶段 3 再加）
├── test/
│   ├── handout.test.js            ← 文本解析单测
│   ├── pdf.test.js                ← PDF 抽取单测
│   ├── plugin.test.js             ← 用假 ctx 跑 apply() 的集成测试
│   └── fixtures/
│       ├── make-pdf.mjs           ← 零依赖的 PDF 生成器（夹具可读可改）
│       └── lecture.pdf            ← 2 页夹具
└── locale/
    ├── zh.json                    ← 浏览器半的文案（阶段 3）
    └── en.json
```

插件源码刻意**不放在** `~/.dsh/profiles/desktop/`：那是运行配置目录，插件装进去后由 pnpm 管理，不适合当源码目录。源码放普通目录（能进 git），安装时 pnpm 用 `link:` 链进 profile——所以在源码目录改代码，profile 里立刻可见。

---

## 4. 每个文件在干什么

### `lib/handout.js` —— 文本讲义的解析层

零依赖纯函数，刻意不碰宿主 API，所以能单独测：

- `outlineOf(source, kind)`：Markdown 按 `#`~`######` 抽大纲，**跳过代码围栏里的 `#`**；编号见 §2；一节的范围是「本标题 → 下一个同级或更高级标题之前」，所以「读第 3 章」会连子节一起读到。没有标题的纯文本退化成 60 行一块。
- `numberingOf(title)`：从标题里取出讲义自己的编号（`3.2` / `第三讲`→`3` / `第 12 章`→`12`，支持中文数字到九十九）。
- `sectionAt(sections, line)`：某一行属于哪一节。
- `sliceLines(source, from, to, maxChars)`：按行取文，超长截断并附一句「还有 N 字符，用 from_line/to_line 继续读」。
- `searchText(source, query, {limit, contextLines})`：大小写不敏感的字面检索，返回行号 + 带行号的上下文窗口。

### `lib/pdf.js` —— PDF 抽取层

用 `unpdf`（零依赖，内置 PDF.js 的服务端构建）抽文字。为什么不自己解析：PDF 正文是压缩过的绘制指令，还牵涉字体编码与 ToUnicode 映射，手写必错。

- `pagesToSource(pages)` → 拼成一份可切片的源文本 + 每页的行区间。行号是后续所有读取与检索的坐标系，所以拼接方式必须和 `sliceLines` 的按行切片严格一致（页间最多一个空行，且该空行不计入任何一页的区间）。
- `pdfSections(index)` → 页大纲，id `P1`、`P2`……标题取该页第一行非空文本。
- `extractPdf(bytes, {maxPages})` → `{source, sections, bookmarks, pageCount, extractedPages, hasText}`。
- `createPdfCache(limit)` → 按 `ctx.fs.stat` 的 `version`（`dev:ino:size:mtimeNs:ctimeNs`）失效的小 LRU。


```

### `lib/index.js` —— 宿主半

```js
const name = 'handout';
const inject = ['tools', 'fs', 'systemPrompt', 'sessionProjections', 'commands'];
const Config = z.object({ maxSectionChars: z.natural().default(12000), /* … */ });

function apply(ctx, config) {
  ctx.sessionProjections.register({ key: 'handout', stateSchema, init, apply, wire, stateVersion });
  ctx.tools.register(defineTool({ name: 'handout_open', description, parameters, output, execute }));
  ctx.commands.register({ name: 'handout', description, handler });
  ctx.systemPrompt.context({ name: 'handout:co-reading', order: 1500, text: (context) => '…' });
}
export { apply, Config, inject, name };
```

这几个 API 都是从源码里读出来的确切写法：

| 用途 | API | 出处 |
| --- | --- | --- |
| 定义工具 | `defineTool({name, description, parameters, output:{schema, render}, execute(args, exec)})` | `dsh-tools/lib/index.js:838` |
| 注册工具 | `ctx.tools.register(tool)` | `dsh-tool-todo/lib/index.js:95` |
| 参数表 | 不是 JSON Schema 而是 `{字段: {type, required, description, items…}}` | `dsh-tool-todo` |
| 拿会话 | `exec.agent.session` | `dsh-tool-todo/lib/index.js:174` |
| 解析路径 | `ctx.fs.resolve(path, {cwd, signal})`，cwd 取 `exec.agent.session.header.cwd` | `dsh-tool-fs/lib/index.js:173,203` |
| 读文件 | `ctx.fs.stat(target, signal)` / `ctx.fs.readText(target, signal)` | `dsh-tool-fs/lib/index.js:204,348` |
| 写会话事件 | `session.append(type, data)`（类型自由，data 必须是可 JSON 序列化的） | `dsh-session/lib/index.js:1441` |
| 读投影 | `ctx.sessionProjections.stateOf(session, key)` | `dsh-sandbox-policy/lib/index.js:155` |
| 动态提示 | `ctx.systemPrompt.context({name, order, text: (context) => string})`，`context.agent?.session` | `dsh-sandbox-policy/lib/index.js:122` |
| 静态提示 | `ctx.systemPrompt.section({name, order, text})`，order 用 `ctx.systemPrompt.getSectionOrder('TOOL_READ')` 这类具名常量 | `dsh-tool-fs/lib/index.js:256` |
| 注册命令 | `ctx.commands.register({name, description, handler})`，`handler({agent, rawInput, signal})` 返回 `{kind:'success'\|'error', text}` | `dsh-commands/lib/index.js:266,379` |

> 注意 `systemPrompt.context` 的 `order`：内置只登记了 `SANDBOX_POLICY(110)`、`APPROVAL_POLICY(115)`、`SUBAGENT_DELEGATION(120)` 三个具名位置，其余传字面量即可（骨架用 1500，落在它们之后、工具说明之前）。

### `cordis.patch.yml` —— 这一层插什么行

```yaml
- insert:
    - id: handout
      name: 'dsh-plugin-handout'
      config:
        maxSectionChars: 12000
        maxOutlineEntries: 300
```

`!!js` 表达式在这个文件里是可用的（比如 `dataRoot: !!js dshHomePath('speech-to-text')`），需要动态路径时可以用。

### `package.json` 的依赖策略（这一条很容易踩坑）

插件里的 `import` 是 Node 原生解析的：**从插件文件自身所在目录往上找 `node_modules`**，找不到就报错。DSH 自带的插件能 `import '@deepseek-ai/dsh-tools'`，是因为它们就住在 app 的 `node_modules` 里；你的插件不在那儿。

好消息是这些包**都发布在公共 npm 上**，我确认过 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`@deepseek-ai/cordis` 的 registry 都返回 200，且 `0.2.0-rc.2` 正是本机版本。所以：

- `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`zod` 写进 **`dependencies`**，交给 pnpm 装；
- `@deepseek-ai/cordis` 只写 **`peerDependencies`**，绝不自己装第二份（符号化的服务 key 必须和宿主同一份实例）。

---

## 5. 怎么装进去、怎么迭代

### 路线 A：零安装试跑（最快，但要求插件零裸导入）

profile 里的一行，`name` 走的是 Node 的模块说明符语义，**可以是相对路径**（cordis-loader 的 README 示例就是 `name: './plugins/example'`，相对 profile 目录解析）。

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 末尾加：

```yaml
- insert:
    - id: handout
      name: '/绝对路径/dsh-plugin-handout/lib/index.js'
```

改完**重启 DeepSeek Harness**。缺点是插件一旦 `import` 了 `@deepseek-ai/*` 就会因找不到 `node_modules` 而加载失败——所以这条路只适合「零依赖版」插件（把 `defineTool` 换成手写工具对象、去掉 zod 投影即可）。

### 路线 B：正规安装（推荐；**本插件的实际状态**）

`dsh-plugin-manager` 支持从 **npm 名 / git 仓库 / tarball URL / 绝对本地路径** 安装。装完之后它会扫包的 `dsh.bundle.patch`，自动把包名追加进 `~/.dsh/profiles/desktop/package.json` 的 `dsh.profile.bundles`。不带 `dsh.bundle` 的包只会收到一句警告：「installed as a plain dependency, not a profile layer」。

我实际执行的（两条等效）：

```bash
# ① 命令行（profile 目录就是 dsh 的插件工作区，pnpm 用 app 自带的那份）
cd ~/.dsh/profiles/desktop
node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs" \
  add /绝对路径/dsh-plugin-handout

# ② 然后把包名加进 profile package.json 的 dsh.profile.bundles
#    （走界面安装时，插件管理器的 reconcile() 会自动做这一步）
```

**已验证的结果**：

- pnpm 在 profile 下建了 `node_modules/`，并把它记成 `"dsh-plugin-handout": "link:…/plugins/dsh-plugin-handout"` —— 是**软链**，不是拷贝。所以你在工作区改代码，profile 里立刻就是新代码。
- 从 profile 目录解析、并真正 `import` 插件，全部成功：导出 `Config, apply, inject, name`，`Config({})` 返回完整默认值。插件的裸导入（`@deepseek-ai/dsh-tools`、`schemastery`、`zod`、`unpdf`）通过软链真实路径下的 `node_modules` 解析成功。
- 把包名加进 `bundles` 后，**不需要重启**：`handout_*` 五个工具立刻出现在会话里。原因是 base 层的 `hmr` 行默认开着**配置监听**（`root: []`），profile 的 manifset 与 patch 变化会触发重新组合。
- 之前标为「待验证」的解析优先级问题：**没有出现**，因为走的是 `link:` + 插件自带 `node_modules`，与宿主 app 内的 bundle 解析互不干扰。

### 重启与热重载（已验证）

| 改什么 | 怎么生效 |
| --- | --- |
| `~/.dsh/profiles/desktop/package.json` 的 `bundles` | **立刻**（配置监听） |
| `~/.dsh/profiles/desktop/cordis.patch.yml` | **立刻**（配置监听；patch 变化会触发 profile 重新组合） |
| 插件**源码**（`lib/*.js`） | 默认**不会**热重载——见下 |
| 浏览器半（`lib/client.js`） | 宿主在 `/plugins/<包名>/client.js` 直接读磁盘、按 mtime/size 判 rev（`dsh-client-modules/lib/index.js:613`），改完**刷新页面**即可 |

base 层给 `hmr` 的默认配置是 `root: []`，**只监听配置、不监听模块源码**。要打开源码热重载，在 profile 的 `cordis.patch.yml` 里覆盖这一行：

```yaml
- id: hmr
  config:
    base: /绝对路径/dsh-plugin-handout
    root: ["dsh-plugin-handout"]
```

`base` 指向插件源码的父目录（因为插件是 `link:` 进来的，真实路径在工作区里），`root` 收窄到插件包本身——这样改 README、测试、样例都不会触发重载（`**/node_modules` 本来就在默认 `ignored` 里）。我已经写进本机 profile 并**验证有效**：`touch lib/index.js` 之后几秒，会话里重新调用工具就已经跑在新代码上。

> 注意：`hmr` 的覆盖是整块 `config` 替换，所以要把 `base` 和 `root` 一起写全（base 行原本只有 `root: []`）。改完 `cordis.patch.yml` 本身也需要它自己的配置监听生效——这一步是立刻的。

---

## 6. 建议的推进节奏

| 阶段 | 做什么 | 状态 |
| --- | --- | --- |
| **0** | 一行业务代码都不写：讲义丢进工作区，用内置右侧栏预览 + 内置 `read`/`grep` | 建议你仍然先试一下，感受「缺什么」 |
| **1** | 宿主半：5 个工具 + 会话投影 + 动态提示 + `/handout` 命令（Markdown/文本） | ✅ 已完成并真机跑通 |
| **2** | PDF 讲义（逐页抽取 + 书签目录 + 指纹缓存 + 扫描件报错） | ✅ 已完成并真机跑通 |
| **3** | 浏览器半：右侧栏「共读」面板，大纲树 + 正文 + 位置高亮 + 选中提问 | ⬜ 未做（见下） |
| **4** | DOCX/PPTX 讲义、批注导出成复习卡、多讲义并行 | ⬜ 按需 |

### 阶段 3 的技术底细（我已验证的部分）

浏览器半**不需要打包器**也能写，因为加载协议很简单：文件就是一个调用注册函数的脚本，宿主任意路径原样伺服。

```js
// lib/client.js —— 注意：这是脚本，不是 ESM，没有 import
window.__ModuleLoader__.load({
  id: 'dsh-plugin-handout',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    const react = require('react');
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    const inject = ['slots', 'sidebarRightTabs', 'locale', 'remote'];

    function apply(ctx) {
      // 注册一个右侧栏标签页类型
      ctx.effect(() => ctx.sidebarRightTabs.register({
        /* …类型定义… */
      }), 'handout: right tab');
      // 往具名插槽挂组件
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key: 'handout', locale: 'handout' },
        Panel
      )), 'handout: panel');
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

`require()` 只认这些**平台种子模块**（写死在 web 前端里，`dsh-web-frontend/dist/assets/index-*.js`）：

```
react  react/jsx-runtime  react-dom  react-dom/client
@deepseek-ai/cordis
@deepseek-ai/dsh-client-store
@deepseek-ai/dsh-client-ui-slots
@deepseek-ai/dsh-client-ui-primitives
@deepseek-ai/dsh-client-ui-dockkit
```

其它东西一律拿不到（除非在 `dsh.client.inject` 里声明依赖让宿主先加载它）。读工作区文件走宿主 Remote：`ctx.remote.workspaceFiles.read/readBytes/stat`（`dsh-client-ui-sidebar-documentpreview/lib/client.js` 就是这么干的）。

**未验证**：`sidebarRightTabs.register` 的「类型定义」结构比上面示意复杂得多（内置文档预览传了 `children`、`inject`、`store`、`face` 等一堆字段，见 `dsh-client-ui-sidebar-documentpreview/lib/client.js:6810`）。这一段必须边跑边试，直接照抄内置插件的写法最稳。

---

## 7. 坑清单

三条是**真机上踩出来的**，不是推测：

1. **`output.render()` 的返回值就是模型看到的工具结果**，不是给人看的摘要。`dsh-tools` 的 `createSuccessResult` 里写着 `content = tool.output.render(args, value)`，原始 `value` 只留给界面。我第一版把 `render` 写成「已打开讲义 xxx」这种一行摘要，结果**模型永远拿不到讲义正文，整个共读功能等于空转**——而且单测全绿，因为它们只断言 `execute` 的返回值。教训：写工具时要测 `render`，并且把模型需要的全部内容（正文、大纲、命中上下文）都放进 `render`。对照参考：内置 `read` 工具的 `render` 用 `formatReadOutput` 输出带行号的文件内容。
2. **`ctx.fs.readBytes` 返回 `Buffer`，而 PDF.js 明确拒绝 `Buffer`**（抛 "Please provide binary data as `Uint8Array`, rather than `Buffer`"）。必须在传给 `getDocumentProxy` 之前转成 `Uint8Array`。这个 bug 单测发现不了——因为假的 fs 按直觉返回了 `Uint8Array`——是集成测试用真 `Buffer` 才炸出来的。
3. **抽不出文字的 PDF 必须报错，不能静默成功**。扫描件（图片型 PDF）没有文字层，抽取结果是空字符串；如果照常「打开成功」，用户和模型都会以为讲义是空的。现在会明确说「有 N 页但没有可抽取的文字层，请先 OCR」。

其余通用陷阱：

4. **别把讲义正文写进会话事件**，否则 `/export`、会话投影、上下文统计全都会被一本书拖垮。PDF 尤其要注意：状态里只存页区间。
5. **`import` 解析靠插件自己的 `node_modules`**，见 §4 最后一段；这是新手最容易卡住的地方。
6. **`inject` 里的服务名写错会静默不启动**：cordis 会等一个永远不来的服务。写错时表现是「插件什么都没发生」，不是报错。对着 `dsh-tool-fs` 的 `inject = ['tools','fs','systemPrompt']` 这类现成清单抄。
7. **`name = 'handout'` 要全局唯一**，加载器用它做诊断；插件行 id 和包名也最好统一。
8. **`session.append` 的 data 必须严格可 JSON 序列化**（不能有 `undefined`、`Date`、`Map`、类实例）。所以我用 `at: Date.now()` 而不是 `new Date()`。
9. **浏览器半的 `inject` 字段是编译期声明**，运行时再少一个服务就会直接不加载。
10. **从源码热重载默认是关的**（`hmr` 的 `root: []`），改了 `lib/*.js` 不生效不是你的错觉，见 §5。

---

## 8. 验证方式

```bash
cd /绝对路径/dsh-plugin-handout

node --test test/*.test.js     # 42 passed：文本解析 11 + PDF 12 + 插件集成 19
node --check lib/index.js      # 语法检查
```

`test/plugin.test.js` 是这里最有价值的一层：它用假 `ctx` 把 `apply()` 真跑起来（`defineTool`/`schemastery`/`zod` 都是真包），覆盖工具注册、参数校验、PDF 抽取缓存、会话投影、动态系统提示文本、斜杠命令，以及 **`render` 必须包含正文** 这条回归。它不需要启动 DSH，几毫秒跑完。

真机验证做过的（样例可用仓库内的 `test/fixtures/make-pdf.mjs` 自行生成，`node test/fixtures/make-pdf.mjs <输出路径>`）：

```
handout_open  <4 页讲义>.pdf          → 4 页大纲（含每页首行小标题）
handout_read  P3                      → 第 15–21 行正文
handout_read  （省略 section_id）      → 读用户当前位置
handout_goto  3                       → 系统提示变成「currently at page 3, looking at …」
handout_search oscillate              → 命中 1 处，带 P2 与上下文
handout_open  <Markdown 讲义>          → 大纲编号沿用讲义自己的 3 / 3.1 / 3.2 / 3.2.1
handout_open  <无文字层 PDF>           → 明确报错并要求 OCR
```

另外在一份真实的 51 页课程幻灯片上验证过：页眉/页码/纯符号行的三层过滤把它从「51 行一模一样」修成了可用的目录。

接着可以做的话，按性价比排序：

1. **阶段 3 的右侧栏面板**（大纲树 + 正文 + 位置高亮 + 选中即问）——需要边跑边试 `sidebarRightTabs.register` 的类型定义；
2. **DOCX/PPTX 讲义**（`unpdf` 只吃 PDF；Office 可以走 docx 解析器，或复用 app 自带的 LibreOffice 转 PDF 再抽）；
3. **批注导出成复习卡**。

### 卸载

```bash
cd ~/.dsh/profiles/desktop
pnpm remove dsh-plugin-handout
# 再把 package.json 的 dsh.profile.bundles 里的 "dsh-plugin-handout" 删掉
# cordis.patch.yml 里那段 - id: hmr 如果不需要源码热重载也可以删掉
```

（pnpm 用 DSH 自带的即可：`node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs"`）
