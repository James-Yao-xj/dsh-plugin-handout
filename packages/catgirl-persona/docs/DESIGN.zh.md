# dsh-persona-catgirl —— 设计与实现说明

> 目的：把系统提示里的**部署级 persona** 换成一份随包发布的 Markdown，让 DSH 用「猫神 OpenCode」的语气说话，写文档时自动切回轻快正式。
>
> 本文记录这个插件的设计取舍、模块职责、踩过的坑，以及**官方规范不推荐的那一步为什么还是做了**。文中关于 harness 机制的结论，都来自把本机 `DeepSeek Harness.app` 里的 `app.asar` 拆开读源码（版本 `0.2.0-rc.2`，cordis `~4.0.4`）；没亲自验证的部分明确标「未验证」。

## 当前状态（真机验证）

| 能力 | 状态 |
| --- | --- |
| 插件装进 profile 并被加载 | ✅ `~/.dsh/profiles/desktop/package.json` 里是 `link:` 依赖，bundle 列表含 `dsh-persona-catgirl` |
| waterfall 真的换掉了 persona 段 | ✅ 当前这个 Web 会话的系统提示里，persona 段就是 `prompts/catgirl.md` 的正文 |
| preset 用同名 section 遮蔽部署级 persona | ✅ 读源码确认（`@deepseek-ai/dsh-persona`） |
| 改 Markdown 下一轮生效；文件读不到不影响会话 | ✅ 单测覆盖（`test/plugin.test.js`） |
| 显示元数据（`locale` 的 `meta` + 图标） | ⬜ 已按读取方契约实现并有回归测试；界面上的肉眼确认没做 |
| 浏览器半 | ➖ 不需要。人格是宿主侧的事，没有界面 |

---

## 0. 先说一个反直觉的结论

「换掉人格」这件事，**改配置是不够的**。

这个包最初只有一份 `cordis.patch.yml`，去覆盖 `system-prompt` 那一行的 `personaPrefix`。那份配置在 TUI 或没有 agent preset 的 surface 上有效，但在 Web 会话里**一个字都进不去模型**——因为那个前缀在 harness 里是一个**命名 section**，而 agent preset 挂的 `@deepseek-ai/dsh-persona` 会用**同名 section 覆盖它**。

patch 能改配置，改不动「这个 section 归谁」。所以现在的做法是：在系统提示装配的**最后一步**（一个 waterfall）里，改写**已经合并、已经遮蔽过**的 sections。

---

## 1. persona 在 harness 里是什么

`@deepseek-ai/dsh-system-prompt` 把 persona 注册成两个普通 section（`lib/index.js:220-229`）：

```js
this.section({ name: PERSONA_PREFIX_SECTION, order: this.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: config.personaPrefix ?? '' });
this.section({ name: PERSONA_SUFFIX_SECTION, order: this.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX'), text: config.personaSuffix ?? '' });
```

`PERSONA_PREFIX_SECTION` 就是字面量 `"deployment:persona-prefix"`（`lib/index.js:55`）。装配时按作用域合并，**作用域内的同名 section 遮蔽全局的同名 section**。

`@deepseek-ai/dsh-persona` 这个 row 就是专门来遮蔽的（它的源码注释说得很直白：「mounted inside an agent preset it shadows the deployment persona for that one session」）：

```js
ctx.effect(() => ctx.systemPrompt.section({ name: PERSONA_PREFIX_SECTION, order: ..., text: config.prefix, ...config.complete ? { complete: true } : {} }), 'persona.section()');
```

于是 Web 会话里发生的事是：全局那份 `personaPrefix` 被 preset 的同名 section 盖住，最终合并结果里**只剩一行** `deployment:persona-prefix`，文本来自 preset。谁在全局改配置都没用。

---

## 2. 我们的接缝：`system-prompt/assemble` waterfall

`SystemPrompt.assemble()` 的最后一步（`dsh-system-prompt/lib/index.js:355`）：

```js
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), 'system-prompt/assemble', assembly, context, () => Promise.resolve(assembly));
```

三件事值得写下来，因为整个插件都押在它们上面：

1. **waterfall 的返回值是权威的**（`lib/index.js:356`：没有 complete section 时直接 `return transformed`）。所以在这里返回一份改过的装配结果，就真的生效。
2. **传进来的装配结果形状很简单**：`sections` 的每一项只有 `{ name, text, interpolate? }`（`lib/index.js:338-347`）。我们替换时写回 `{ name, text, interpolate }`，丢不掉别的东西——**这一点是读过源码才敢确定的**，否则「只替换一项、其余原样」就是碰运气。写回时 `interpolate` 一定**显式**给出：渲染那一步是 `section.interpolate === false ? section.text : interpolate(...)`（`lib/index.js:114`），字段缺省不是「不插值」，而是「按变量插值」——正文里出现 `{{...}}` 就会走到那条会抛错的路径。
3. **有一个例外：`complete: true` 的 section。** 如果某个作用域里有 section 被标成 complete，harness 会在 waterfall **之后**把它还原成唯一的 prompt section：

   ```js
   if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
   return { ...transformed, sections: completeSection === void 0 ? transformed.sections : [completeSection], ... };
   ```

   也就是说：**preset 把 persona 标成 `complete: true` 时，本插件的替换会被丢掉**（当前官方 preset 没有这么用）。这是已知边界，`README` 的 Known Limitations 里也写了。

我们的监听器（`lib/index.js:89-120`）做的事很小：先 `await next()` 拿到下游结果，再把里面 name 等于 `config.section` 的那一项换成人格正文，然后返回。它**不新造 section、不删 section、不动 `contexts` 与 `tools`**——按官方 practice 的说法，「机制越强，你要替别人保住的东西越多」，所以这里只碰自己那一段。

`{ global: true }` 是必须的：harness 用 `scopeTarget(this, scope)` 派发，要覆盖每一个 agent 作用域（preset 会话、子代理）就得挂在根上下文上。

---

## 3. 与官方规范的关系（这一步是「明知不推荐」）

随 harness 发布的 `cordis-plugin-development` skill 里，`references/practices.md` 写着：

> Add prompt text with `ctx.systemPrompt.section()`. … Do not listen to `system-prompt/assemble` to add or remove tools or text.

**本插件做的正是它说不该做的那件事。** 之所以还是做，理由是一个具体的冲突，不是偏好：

- 规范推荐的 `ctx.systemPrompt.section()` 注册在**部署级作用域**，而 preset 的同名 section 会遮蔽它——这正是 §0 里那个失效路径。
- 规范里 persona 的「正经」改法是在 **agent preset** 里配 `dsh-persona` 这个 row（它存在的理由就是这个）。那要求改 preset 定义，而且只对使用这个 preset 的会话生效；用户换 preset，人格就没了。
- 另一条可能的干净路子是监听 `agent/created`，在 `agent.ctx` 上注册同名 section，让自己的作用域比 preset 更深。**未验证**：harness 对**同一层里的重复 section 是抛错的**（`layers.sections.insert`），能不能稳定地落在更深一层、而不是和 preset 撞在同一层，需要真机试。

所以这是一个**知情的选择**：用最强的那个接缝，换取「一处生效、处处生效」，代价是必须自己保住别人的贡献（见 §2 第 3 条），并且要接受 `complete: true` 那个已知边界。如果哪天 harness 提供了「部署级 persona 覆盖」这类正规开关，这个插件应该换过去。

---

## 4. 目录结构与模块职责

```
packages/catgirl-persona/
├── package.json          ← 清单：bundle patch、icon、exports（含 ./package.json 与 ./locale/*.json）
├── cordis.patch.yml      ← 往 profile 插一行 `catgirl-persona`
├── prompts/catgirl.md    ← 人格正文。改这一份就够了，改完下一轮生效
├── lib/
│   ├── persona.js        ← 纯逻辑：路径解析、正文规范化、在装配结果里替换目标段
│   ├── loader.js         ← 加载层：按文件版本缓存、失败策略
│   └── index.js          ← Cordis 插件：waterfall + /persona
├── locale/{zh,en}.json   ← 插件卡片/清单页的显示文本（在 meta 下）
└── test/                 ← 31 个测试，不需要启动 DSH
```

`lib/persona.js` 刻意不碰 cordis：会出错的就是「路径怎么解析」「注释要不要进上下文」「替换时有没有动到别的段」这三步，所以它们能直接单测。`lib/index.js` 只负责接线，`lib/loader.js` 夹在两者之间管状态。

`applyPersona()` 返回**状态**而不是抛错（`empty` / `missing-section` / `no-assembly` / `replaced`），因为这些状态要同时喂给日志和 `/persona`：插件可以「加载成功但没派上用场」，那必须能被看见。

---

## 5. 失败策略

组装路径跑在**每一轮请求**上，所以这里的每一步都不能把会话搞坏。四条路径，各不相同：

| 情况 | 行为 | 为什么 |
| --- | --- | --- |
| 目标段不存在 | 原样返回 + 告警一次 | 多半是 harness 改名了。静默失效最坏，所以日志报一次（不刷屏）并由 `/persona` 说明 |
| 人格文件不在 | **清掉**正文（不再替换） | 用户删了文件却还在吃旧人格，比报错更坏 |
| 文件超限 / 读失败 | **保留上一版**正文 | 一次读取抖动或一次手滑存盘，不该把已经生效的人格抽走 |
| 装配路径上任何异常 | 吞掉、记日志、返回原装配结果 | 人格插件坏掉只该退化成「没有人格覆盖」，不该让整个会话无法请求模型 |

这套策略与同仓库的讲义共读插件（`dsh-plugin-handout/lib/teacher.js`）**完全一致**——两者要解决的问题是同一个，没有必要发明第二套。

---

## 6. 配置与 `/persona`

配置都在 `cordis.patch.yml`（profile 层覆盖时注意 patch 是**整块替换** `config`）：

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `promptPath` | `prompts/catgirl.md` | 相对路径按**插件包根目录**解析（不按会话 cwd），也接受 `~/` 与绝对路径；空串关闭 |
| `maxChars` | `12000` | 超限拒绝加载并保留上一版 |
| `section` | `deployment:persona-prefix` | 要替换的段名 |
| `interpolate` | `false` | 是否让正文里的 `{{名字}}` 参与插值 |

`interpolate` 默认关掉是有意的：harness 遇到**未知**的 `{{变量}}` 会让整个系统提示组装失败（`lib/index.js` 里那句 `malformed prompt variable reference`），而人格文件是要反复手改的文本，不该因为随手写了 `{{...}}` 就把会话弄坏。

`/persona` 回答的是「到底生效了没有」，这是插件最容易被误解的地方：

```
/persona            # 用的是哪一份、多少字符、替换目标、最近一次组装的结果
/persona reload     # 跳过版本检查强制重读
```

「最近一次组装」那一行是专门加的：加载成功 ≠ 生效。没发过消息、目标段不存在、正文为空，都会在这里显形。

---

## 7. 显示元数据与图标

插件卡片、bundle 详情与「内置插件」清单，都由 harness 在**不激活插件**的前提下读清单与 locale 文件（`dsh-app-boot/lib/index.js` 的 `readPluginMeta()`）。契约有三条，都对上了才算「界面好看」：

1. **显示文本在 `locale/<语言>.json` 的 `meta` 下面**：

   ```json
   { "meta": { "title": "猫娘人格", "description": "……" } }
   ```

   读取方只看 `parsed.meta.title` / `parsed.meta.description`。写成顶层 `title` / `description` **不会报错**，只会被静默忽略，卡片退回显示 `package.json` 的 `name`——也就是包名 `dsh-persona-catgirl`。**这是本包真的犯过的错**，已修，并由 `test/locale.test.js` 守住。

2. **字段要么不写，要么非空字符串。** 空串会让 `textOf()` 抛错，而那个异常会被上层捕获成「整份元数据不可用」——中英文本一起丢，只剩一条诊断。

3. **`./package.json` 与 `./locale/*.json` 必须出现在 `exports` 里**：读取方是通过 ESM 解析器拿这两个资源的，没导出等于没有。图标是例外——它按**路径**解析，不需要 export，规则是：顶层 `icon`、相对路径、SVG / PNG / JPEG / WebP、不超过 256 KiB、realpath 之后仍在包目录内。

---

## 8. 验证方式

```bash
cd packages/catgirl-persona
node --test test/*.test.js     # 31 passed：纯逻辑 7 + 加载层 8 + 插件集成 10 + 清单与显示元数据 6
node --check lib/index.js      # 语法检查
```

`test/plugin.test.js` 是这里最有价值的一层：它用假 `ctx` 把 `apply()` 真跑起来，覆盖「preset 遮蔽后再替换」「文件读不到」「目标段不存在」「装配路径抛错」这些真正会出问题的路径，几毫秒跑完，不需要启动 DSH。

### 怎么读 harness 自己的源码

上面所有「harness 里是怎么写的」结论，都不是猜的。Desktop 版把 JS 都放在 `app.asar` 里，**不能**把它当目录用（`cat app.asar/node_modules/...` 会失败），但直接读整个文件是可以的：asar 就是「8 字节 pickle + 4 字节 JSON 长度 + JSON + 数据区」。

```js
const buf = readFileSync('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar');
const headerSize = buf.readUInt32LE(4);      // 头 pickle 总长度
const jsonLength = buf.readUInt32LE(12);     // 其中 JSON 的字节数
const header = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8'));
const base = 8 + headerSize;                  // 数据区起点：文件真实偏移 = base + entry.offset
```

拿到 `header.files` 就能定位任意包里的任意文件并按 `offset` / `size` 切出来。本文引用的行号都是这么读出来的（`0.2.0-rc.2`）。

---

## 9. 坑清单

1. **patch 改不动 section 的归属**——这是整个包存在的理由，也是最初那份纯配置版本一直没生效的原因（§0）。
2. **`system-prompt/assemble` 是最强的接缝**：官方 practice 不推荐用它增删文本。既然用了，就必须只碰自己那一段，并保住下游结果（§2、§3）。
3. **`complete: true` 会在 waterfall 之后把 sections 换成单独一项**，本插件的替换会被丢掉（§2 第 3 条）。
4. **locale 的显示文本必须在 `meta` 下**，写成顶层字段是静默失效（§7 第 1 条）。
5. **`interpolate` 忘了关会让一份手写 Markdown 变成系统提示的故障源**：未知 `{{变量}}` 是硬错误（§6）。
6. **每轮组装一次 `stat`**：本地小文件，代价可以接受，换来「改完 Markdown 下一轮就生效」。这条是有意的取舍，不是漏掉缓存。
7. **`PERSONA_PREFIX_SECTION` 我们按字面量写死**，尽管 `@deepseek-ai/dsh-system-prompt` 在 npm 上有：插件装在 profile 里会解析到自己那份 `node_modules`，多一份 harness 内部包的副本只会带来版本偏移。代价（改名即失效）由日志与 `/persona` 兜住（见 `lib/persona.js` 的注释）。

---

## 10. 安装与卸载

安装见 [README](README.md) 的 Use this package。卸载：

```bash
cd ~/.dsh/profiles/desktop
node "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/pnpm/bin/pnpm.cjs" remove dsh-persona-catgirl
# 再把 package.json 的 dsh.profile.bundles 里的 "dsh-persona-catgirl" 删掉
```

删掉这一行之后，`deployment:persona-prefix` 就回到 preset 或部署配置提供的文本，本插件不留下任何状态。

## License

[MIT](../../LICENSE)
