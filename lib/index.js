/**
 * 讲义共读插件（宿主半）。
 *
 * 解决的核心问题：模型看不见你在读什么，而把整份讲义塞进上下文既慢又贵。
 * 所以这里做四件事：
 *   1. 五个工具 —— 打开讲义、按节/按页取文、全文检索、标记位置、记批注；
 *   2. 一份会话级的共读状态（session projection），记录当前讲义与阅读位置；
 *   3. 一段动态系统提示，每次请求告诉模型「用户在读哪一节哪一页」；
 *   4. 一段静态系统提示，把部署方维护的**讲师提示词**（`lib/teacher.js`）接进去，
 *      让模型按「怎么讲」而不是只按「讲什么」来回答。
 *
 * 讲义正文**不进**会话日志：状态里只存大纲（每节一行），正文每次按需重读。
 * 支持两种来源：Markdown/纯文本按标题分节，PDF 按页寻址（`P12`）。
 * @module dsh-plugin-handout
 */

import z from '@deepseek-ai/schemastery';
import { z as zz } from 'zod';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { detectKind, outlineOf, searchText, sectionAt, sliceLines } from './handout.js';
import { createPdfCache, extractPdf } from './pdf.js';
import { DEFAULT_MAX_CHARS, DEFAULT_PROMPT_PATH, createTeacherPrompt, formatTeacherStatus } from './teacher.js';

/** Cordis 插件名，用于加载器诊断。 */
const name = 'handout';

/** 需要的服务：工具注册表、文件系统、系统提示、会话投影，以及斜杠命令。 */
const inject = ['tools', 'fs', 'systemPrompt', 'sessionProjections', 'commands'];

/** 本插件在会话投影注册表里的 key。 */
const STATE_KEY = 'handout';

/** 部署侧可调参数。 */
const Config = z.object({
  /** 单次 handout_read 最多返回多少字符。 */
  maxSectionChars: z.natural().default(12000),
  /** 大纲最多返回多少节（超长讲义只给出前面的目录，其余用检索定位）。 */
  maxOutlineEntries: z.natural().default(300),
  /** 单次 handout_search 的命中上限。 */
  maxSearchHits: z.natural().default(20),
  /** 每条命中附带的前后文行数。 */
  searchContextLines: z.natural().default(3),
  /** 允许读取的 PDF 字节上限；超过就报错，而不是把内存吃光。 */
  maxPdfBytes: z.natural().default(64 * 1024 * 1024),
  /** 最多抽取多少页 PDF；超出的页仍可用 from_line/to_line 读取。 */
  maxPdfPages: z.natural().default(600),
  /** 缓存几份已抽取的 PDF（按文件指纹失效）。 */
  pdfCacheEntries: z.natural().default(4),
  /**
   * 讲师提示词文件（Markdown）。相对路径按**插件包根目录**解析（不按会话 cwd：
   * 这是部署级配置），也接受绝对路径与 `~/`；空串表示关掉这个功能。
   */
  teacherPromptPath: z.string().default(DEFAULT_PROMPT_PATH),
  /** 讲师提示词的字符上限；超过就拒绝本次加载，免得一份失控的文件把上下文撑爆。 */
  teacherPromptMaxChars: z.natural().default(DEFAULT_MAX_CHARS),
  /** 讲师提示词在系统提示里的排序位置：0 是部署级 persona，100 落在它之后、计划/工具策略之前。 */
  teacherOrder: z.number().default(100),
  /** 没有打开讲义时也注入讲师提示词（默认只在共读进行中生效）。 */
  teacherAlways: z.boolean().default(false)
});

/** 大纲条目。 */
const sectionSchema = zz.object({
  id: zz.string(),
  level: zz.number(),
  title: zz.string(),
  line: zz.number(),
  endLine: zz.number()
});

/** 共读状态：当前讲义 + 大纲 + PDF 书签 + 用户锚点 + 批注。 */
const stateSchema = zz.union([
  zz.null(),
  zz.object({
    path: zz.string(),
    kind: zz.string(),
    chars: zz.number(),
    sections: zz.array(sectionSchema),
    bookmarks: zz.array(zz.object({ title: zz.string(), page: zz.number() })),
    anchor: zz.union([
      zz.null(),
      zz.object({ sectionId: zz.string(), quote: zz.string().optional() })
    ]),
    notes: zz.array(zz.object({ sectionId: zz.string(), text: zz.string(), at: zz.number() }))
  })
]);

/** 讲义路径展示用：统一分隔符。 */
function display(path) {
  return path.replace(/\\/g, '/');
}

/**
 * 把大纲渲染成给**模型**看的文本。
 *
 * 注意：`output.render()` 的返回值就是模型收到的工具结果（`dsh-tools` 的
 * `createSuccessResult` 里 `content = render(...)`），不是给人看的摘要。
 * 所以这里必须把模型真正需要的信息写全。
 * @param value - `handout_open` 的输出值。
 * @returns 文本。
 */
function formatOutline(value) {
  const head =
    value.kind === 'pdf'
      ? `讲义 ${value.path}：PDF，共 ${value.pageCount} 页，按页寻址（section_id 形如 "P12"，也可直接写页码 "12"）。`
      : `讲义 ${value.path}：${value.chars} 字符，${value.outline.length} 节按标题分节。`;
  const lines = value.outline.map(
    (section) => `  ${section.id}\t${'  '.repeat(Math.max(0, section.level - 1))}${section.title}\t(L${section.line}-${section.endLine})`
  );
  const truncated = value.outlineTruncated ? ['（大纲已截断，后面的部分请用 handout_search 定位）'] : [];
  const bookmarks =
    value.bookmarks.length === 0
      ? []
      : ['PDF 自带书签目录：', ...value.bookmarks.map((bookmark) => `  ${bookmark.title} → 第 ${bookmark.page} 页`)];
  return [head, '大纲：', ...lines, ...truncated, ...bookmarks].join('\n');
}

/**
 * 把检索结果渲染成给模型看的文本。
 * @param value - `handout_search` 的输出值。
 * @returns 文本。
 */
function formatHits(value) {
  if (value.total === 0) return `讲义里没有出现「${value.query}」。`;
  const blocks = value.hits.map(
    (hit) => `§${hit.sectionId} ${hit.heading}（第 ${hit.line} 行）\n${hit.context}`
  );
  return [`「${value.query}」命中 ${value.total} 处：`, ...blocks].join('\n\n');
}

/**
 * 解析并读取一份讲义。
 *
 * 文本类直接读字符串；PDF 读字节后抽取逐页文本，抽取结果按 `fs.stat` 的 `version`
 * （dev:ino:size:mtimeNs:ctimeNs）缓存，文件一改立刻失效。
 * @param ctx - 插件上下文（提供 `fs`）。
 * @param exec - 工具执行上下文（提供会话 cwd 与取消信号）。
 * @param requestedPath - 模型给出的路径，相对会话 cwd 或绝对路径。
 * @param deps - `{config, cache}`：配置与 PDF 缓存。
 * @returns `{kind, path, source, sections, bookmarks, chars, pageCount}`。
 */
async function loadSource(ctx, exec, requestedPath, deps) {
  const { config, cache } = deps;
  const cwd = exec.agent?.session.header.cwd;
  const options = cwd === undefined ? { signal: exec.signal } : { cwd, signal: exec.signal };
  const target = await ctx.fs.resolve(requestedPath, options);
  const info = await ctx.fs.stat(target, exec.signal);
  if (info === undefined) throw new Error(`找不到讲义：${target.displayPath}`);
  if (info.type === 'directory') throw new Error(`${target.displayPath} 是一个目录，不是讲义文件`);
  const path = display(target.displayPath);
  const kind = detectKind(path);

  if (kind !== 'pdf') {
    const source = await ctx.fs.readText(target, exec.signal);
    return { kind, path, source, sections: outlineOf(source, kind), bookmarks: [], chars: source.length, pageCount: 0, hasText: source.trim().length > 0 };
  }

  const key = `${target.targetKey}\u0000${info.version}`;
  const cached = cache.get(key);
  if (cached !== undefined) return { ...cached, path, kind };
  if (info.size > config.maxPdfBytes) {
    throw new Error(`这份 PDF 有 ${info.size} 字节，超过 maxPdfBytes（${config.maxPdfBytes}）。调高插件配置，或先把它拆小。`);
  }
  const bytes = await ctx.fs.readBytes(target, exec.signal, config.maxPdfBytes);
  const extracted = await extractPdf(bytes, { maxPages: config.maxPdfPages });
  const value = {
    kind,
    source: extracted.source,
    sections: extracted.sections,
    bookmarks: extracted.bookmarks,
    chars: extracted.source.length,
    pageCount: extracted.pageCount,
    hasText: extracted.hasText
  };
  cache.set(key, value);
  return { ...value, path };
}

/**
 * 读取当前会话的共读状态。
 * @param ctx - 插件上下文。
 * @param exec - 工具执行上下文。
 * @returns 状态对象，或 `null`。
 */
function stateOf(ctx, exec) {
  const session = exec.agent?.session;
  if (session === undefined) return null;
  return ctx.sessionProjections.stateOf(session, STATE_KEY) ?? null;
}

/**
 * 需要会话才能写入状态。
 * @param exec - 工具执行上下文。
 * @returns 会话对象。
 */
function requireSession(exec) {
  const session = exec.agent?.session;
  if (session === undefined) throw new Error('讲义共读需要一个所属会话');
  return session;
}

/**
 * 打开讲义：解析大纲、把讲义设为本次共读的讲义。
 * @param ctx - 插件上下文。
 * @param deps - `{config, cache}`。
 * @returns 工具定义。
 */
function openTool(ctx, deps) {
  const { config } = deps;
  return defineTool({
    name: 'handout_open',
    description:
      '打开一份讲义（Markdown / 纯文本 / PDF），返回它的目录大纲，并把它设为本次共读的讲义。' +
      '用户提到「讲义 / 课件 / 这份材料 / 第几节 / 第几页」而你还不知道正文时，先调用它，再用 handout_read 取具体章节。' +
      'PDF 按页寻址（section_id 形如 "P12"），Markdown 按标题分节（形如 "3.2"）。',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: '讲义路径，相对当前工作目录或绝对路径。'
      }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          chars: { type: 'integer', required: true },
          pageCount: { type: 'integer', required: true },
          outlineTruncated: { type: 'boolean', required: true },
          outline: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                level: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                line: { type: 'integer', required: true },
                endLine: { type: 'integer', required: true }
              }
            }
          },
          bookmarks: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                title: { type: 'string', required: true },
                page: { type: 'integer', required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: formatOutline(value) }]
    },
    async execute(args, exec) {
      await deps.syncTeacher(exec);
      const session = requireSession(exec);
      const loaded = await loadSource(ctx, exec, args.path, deps);
      // 抽不出文字就明确失败：扫描件的 PDF 会让整个共读功能变成空转，
      // 悄悄打开一份「空的讲义」比报错更糟。
      if (loaded.kind === 'pdf' && !loaded.hasText) {
        throw new Error(
          `${loaded.path} 有 ${loaded.pageCount} 页，但没有可抽取的文字层（很可能是扫描件或图片型 PDF）。` +
            `请先用 OCR 把它转成文本（例如 macOS 预览导出文本、或 ocrmypdf），再打开转好的文件。`
        );
      }
      const kept = loaded.sections.slice(0, config.maxOutlineEntries);
      session.append('handout/open', {
        state: {
          path: loaded.path,
          kind: loaded.kind,
          chars: loaded.chars,
          sections: kept,
          bookmarks: loaded.bookmarks,
          anchor: null,
          notes: []
        }
      });
      return {
        path: loaded.path,
        kind: loaded.kind,
        chars: loaded.chars,
        pageCount: loaded.pageCount,
        outlineTruncated: loaded.sections.length > kept.length,
        outline: kept,
        bookmarks: loaded.bookmarks
      };
    }
  });
}

/**
 * 把用户/模型给的编号归一到大纲里的 id。
 *
 * PDF 的页编号允许写 "12"、"p12"、"P12"；Markdown 的节编号原样匹配。
 * @param sections - 当前大纲。
 * @param raw - 调用方给出的编号。
 * @returns 命中的大纲条目，或 `undefined`。
 */
function findSection(sections, raw) {
  const text = String(raw).trim();
  const candidates = [text, text.toUpperCase(), `P${text.replace(/^p/i, '')}`];
  for (const candidate of candidates) {
    const hit = sections.find((section) => section.id === candidate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/**
 * 按节（或按行区间）取正文。
 * @param ctx - 插件上下文。
 * @param deps - `{config, cache}`。
 * @returns 工具定义。
 */
function readTool(ctx, deps) {
  const { config } = deps;
  return defineTool({
    name: 'handout_read',
    description:
      '读取当前共读讲义的一段正文。给 section_id 读一整节（Markdown 含子节；PDF 读一整页，形如 "P12"），' +
      '给 from_line/to_line 读任意行区间。讲义很长时不要试图一次读完：先看大纲，再按需取节。',
    parameters: {
      section_id: {
        type: 'string',
        description: '要读的节编号，例如 "3.2" 或 PDF 的 "P12"。省略时读用户当前所在的那一节。'
      },
      from_line: { type: 'integer', description: '起始行（1 起，含）。与 to_line 配对使用。' },
      to_line: { type: 'integer', description: '结束行（1 起，含）。' },
      max_chars: { type: 'integer', description: '本次返回的字符上限，默认取插件配置。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sectionId: { type: 'string', required: true },
          title: { type: 'string', required: true },
          fromLine: { type: 'integer', required: true },
          toLine: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
          text: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `§${value.sectionId} ${value.title}（第 ${value.fromLine}–${value.toLine} 行）\n\n${value.text}`
        }
      ]
    },
    async execute(args, exec) {
      await deps.syncTeacher(exec);
      const state = stateOf(ctx, exec);
      if (state === null) throw new Error('还没有打开的讲义：先调用 handout_open');
      // 用刚读出来的大纲而不是状态里的大纲：文件在这轮对话中被改过时，行号才是准的。
      const loaded = await loadSource(ctx, exec, state.path, deps);
      const sections = loaded.sections;
      const maxChars = args.max_chars ?? config.maxSectionChars;

      // 三种取法：显式行区间 > 显式节编号 > 用户当前所在的节。
      let section;
      if (args.from_line === undefined) {
        if (args.section_id === undefined) {
          section = state.anchor === null ? sections[0] : findSection(sections, state.anchor.sectionId) ?? sections[0];
        } else {
          section = findSection(sections, args.section_id);
          if (section === undefined) throw new Error(`讲义 ${state.path} 里没有编号为 ${args.section_id} 的节`);
        }
        if (section === undefined) throw new Error(`讲义 ${state.path} 解析不出任何节，请改用 from_line/to_line`);
      }

      const fromLine = section === undefined ? args.from_line : section.line;
      const toLine = section === undefined ? (args.to_line ?? args.from_line) : section.endLine;
      const slice = sliceLines(loaded.source, fromLine, toLine, maxChars);
      return {
        sectionId: section === undefined ? `L${slice.fromLine}` : section.id,
        title: section === undefined ? `第 ${slice.fromLine}–${slice.toLine} 行` : section.title,
        fromLine: slice.fromLine,
        toLine: slice.toLine,
        truncated: slice.truncated,
        text: slice.text
      };
    }
  });
}

/**
 * 在讲义里检索。
 * @param ctx - 插件上下文。
 * @param deps - `{config, cache}`。
 * @returns 工具定义。
 */
function searchTool(ctx, deps) {
  const { config } = deps;
  return defineTool({
    name: 'handout_search',
    description:
      '在当前共读讲义里做关键词检索，返回命中的行号与所在页/节。' +
      '当用户问的是某个术语、公式或人名，而你不知道它出现在哪里时，用它定位，再 handout_read 读上下文。' +
      'PDF 讲义尤其依赖这个工具：它比逐页翻要快得多。',
    parameters: {
      query: { type: 'string', required: true, description: '关键词，大小写不敏感，按字面匹配。' },
      limit: { type: 'integer', description: '命中上限，默认取插件配置。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true },
          total: { type: 'integer', required: true },
          hits: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                line: { type: 'integer', required: true },
                sectionId: { type: 'string', required: true },
                heading: { type: 'string', required: true },
                text: { type: 'string', required: true },
                context: { type: 'string', required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: formatHits(value) }]
    },
    async execute(args, exec) {
      await deps.syncTeacher(exec);
      const state = stateOf(ctx, exec);
      if (state === null) throw new Error('还没有打开的讲义：先调用 handout_open');
      const loaded = await loadSource(ctx, exec, state.path, deps);
      const hits = searchText(loaded.source, args.query, {
        limit: args.limit ?? config.maxSearchHits,
        contextLines: config.searchContextLines
      });
      return {
        query: args.query,
        total: hits.length,
        hits: hits.map((hit) => {
          const section = sectionAt(loaded.sections, hit.line);
          return {
            line: hit.line,
            sectionId: section?.id ?? '—',
            heading: section?.title ?? '',
            text: hit.text.trim().slice(0, 400),
            context: hit.context
          };
        })
      };
    }
  });
}

/**
 * 标记用户当前读到哪（或替用户跳转）。
 * @returns 工具定义。
 */
function gotoNoteTools(ctx, deps) {
  const goto = defineTool({
    name: 'handout_goto',
    description:
      '记录用户当前正在读讲义的位置。用户说「我在看 3.2 节」「现在看到第 12 页」「看到梯度下降这里」时调用它，' +
      '之后你的回答就会自动带上这个位置。用户没有明说时不要猜。',
    parameters: {
      section_id: { type: 'string', required: true, description: '节编号，例如 "3.2"，或 PDF 的页号 "12"。' },
      quote: { type: 'string', description: '用户指的那句话或那一段的原文摘录（可选）。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sectionId: { type: 'string', required: true },
          title: { type: 'string', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `用户现在在 §${value.sectionId} ${value.title}` }]
    },
    async execute(args, exec) {
      await deps.syncTeacher(exec);
      const session = requireSession(exec);
      const state = stateOf(ctx, exec);
      if (state === null) throw new Error('还没有打开的讲义：先调用 handout_open');
      const loaded = await loadSource(ctx, exec, state.path, deps);
      const section = findSection(loaded.sections, args.section_id);
      if (section === undefined) throw new Error(`讲义里没有编号为 ${args.section_id} 的节`);
      session.append('handout/anchor', {
        anchor: { sectionId: section.id, ...(args.quote === undefined ? {} : { quote: args.quote }) }
      });
      return { sectionId: section.id, title: section.title };
    }
  });

  const note = defineTool({
    name: 'handout_note',
    description:
      '把用户的一个疑问、批注或「回头要搞清楚的点」记在讲义的某一节/某一页上，方便之后复盘。' +
      '用户只是随口提问时不要记；用户说「记一下」「这个问题先放着」时才记。',
    parameters: {
      text: { type: 'string', required: true, description: '要记下的内容。' },
      section_id: { type: 'string', description: '挂在哪一节/哪一页上，省略时挂在用户当前位置。' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sectionId: { type: 'string', required: true },
          notes: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `已记在 §${value.sectionId}（共 ${value.notes} 条批注）` }]
    },
    async execute(args, exec) {
      await deps.syncTeacher(exec);
      const session = requireSession(exec);
      const state = stateOf(ctx, exec);
      if (state === null) throw new Error('还没有打开的讲义：先调用 handout_open');
      const sectionId = args.section_id ?? state.anchor?.sectionId ?? state.sections[0]?.id;
      if (sectionId === undefined) throw new Error('讲义里没有可用的节');
      session.append('handout/note', { note: { sectionId, text: args.text, at: Date.now() } });
      return { sectionId, notes: state.notes.length + 1 };
    }
  });

  return [goto, note];
}

/**
 * 插件主体。
 * @param ctx - 插件上下文。
 * @param config - 已解析的插件配置。
 */
function apply(ctx, config) {
  /** PDF 抽取缓存：抽一份几百页的 PDF 要几秒，而同一轮里模型会反复读同一份。 */
  const cache = createPdfCache(config.pdfCacheEntries);
  /** 讲师提示词：正文缓存在这里，系统提示组装时同步读取（组装本身是同步的）。 */
  const teacher = createTeacherPrompt({
    path: config.teacherPromptPath,
    maxChars: config.teacherPromptMaxChars,
    onError: (message) => ctx.logger?.error?.(`[handout] ${message}`)
  });

  /**
   * 顺手核对一次讲师提示词文件（版本没变就直接返回）。
   *
   * 挂在每个共读工具上，是为了让「改 Markdown → 下一轮就生效」成立，而不用重启
   * DSH 或重开讲义。失败只记状态，绝不抛错打断工具。
   * @param exec - 工具执行上下文（可能没有会话，例如插件加载时的预读）。
   * @returns 状态快照。
   */
  const syncTeacher = (exec) =>
    teacher.sync(ctx.fs, { cwd: exec.agent?.session.header.cwd, signal: exec.signal });

  const deps = { config, cache, syncTeacher };

  // 插件加载时先读一次：会话恢复（讲义已开着）时，第一条请求就能带上讲师提示词。
  // 故意不 await：一个文本文件不该拖慢插件加载；读不到也只是少一段提示词。
  void syncTeacher({});

  // ── 共读状态：会话投影，随会话日志重放，UI 也能订阅 ──────────────────────
  ctx.sessionProjections.register({
    key: STATE_KEY,
    stateSchema,
    init: () => null,
    apply: (state, event) => {
      switch (event.type) {
        case 'handout/open':
          return event.data.state;
        case 'handout/anchor':
          return state === null ? null : { ...state, anchor: event.data.anchor };
        case 'handout/note':
          return state === null ? null : { ...state, notes: [...state.notes, event.data.note] };
        case 'handout/close':
          return null;
        default:
          return state;
      }
    },
    wire: { viewSchema: stateSchema, view: (state) => state },
    stateVersion: 1
  });

  // ── 工具 ────────────────────────────────────────────────────────────────
  ctx.tools.register(openTool(ctx, deps));
  ctx.tools.register(readTool(ctx, deps));
  ctx.tools.register(searchTool(ctx, deps));
  for (const tool of gotoNoteTools(ctx, deps)) ctx.tools.register(tool);

  // ── 斜杠命令：/handout —— 不经过模型，直接改状态 ────────────────────────
  ctx.commands.register({
    name: 'handout',
    description: '共读讲义：查看当前位置、跳转、查看/重载讲师提示词',
    handler: async (invocation) => {
      const raw = invocation.rawInput.trim();
      const [verb = 'where', ...rest] = raw.split(/\s+/).filter((part) => part !== '');
      const session = invocation.agent.session;
      const state = ctx.sessionProjections.stateOf(session, STATE_KEY) ?? null;
      if (verb === 'where') {
        if (state === null) return { kind: 'success', text: '还没有打开的讲义。让模型打开一份：handout_open <路径>。' };
        const unit = state.kind === 'pdf' ? '页' : '节';
        const anchor = state.anchor;
        return {
          kind: 'success',
          text: [
            `当前讲义：${state.path}（${state.sections.length} ${unit}）`,
            `当前位置：${anchor === null ? '未标记' : `§${anchor.sectionId}`}`,
            state.bookmarks.length === 0 ? '' : `书签目录：${state.bookmarks.length} 条`,
            `批注：${state.notes.length} 条`
          ]
            .filter((line) => line !== '')
            .join('\n')
        };
      }
      if (verb === 'goto') {
        const target = rest[0];
        if (target === undefined || state === null) return { kind: 'error', text: '用法：/handout goto <节编号|页码>（需要先打开讲义）' };
        const section = findSection(state.sections, target);
        if (section === undefined) return { kind: 'error', text: `讲义里没有编号为 ${target} 的节/页` };
        session.append('handout/anchor', { anchor: { sectionId: section.id } });
        return { kind: 'success', text: `已跳到 §${section.id} ${section.title}` };
      }
      if (verb === 'teacher') {
        // `reload` 跳过版本检查强制重读：改了 Markdown 想立刻确认生效时用它。
        const force = rest[0] === 'reload' || rest[0] === 'refresh';
        const snapshot = await teacher.sync(ctx.fs, { cwd: session.header.cwd, signal: invocation.signal, force });
        return {
          kind: snapshot.error === undefined ? 'success' : 'error',
          text: formatTeacherStatus(snapshot, { always: config.teacherAlways, coReading: state !== null })
        };
      }
      return {
        kind: 'error',
        text: '用法：/handout where | /handout goto <节编号|页码> | /handout teacher [reload]；打开讲义请让模型调用 handout_open。'
      };
    }
  });

  // ── 动态系统提示：每次请求告诉模型用户读到哪了 ──────────────────────────
  // order 用字面量：CONTEXT_ORDERS 只登记了 sandbox/approval/subagent 三项，
  // 1500 落在它们之后、工具说明之前。
  ctx.systemPrompt.context({
    name: 'handout:co-reading',
    order: 1500,
    text: (context) => {
      const session = context.agent?.session;
      if (session === undefined) return '';
      const state = ctx.sessionProjections.stateOf(session, STATE_KEY) ?? null;
      if (state === null) return '';
      const isPdf = state.kind === 'pdf';
      const anchor = state.anchor;
      /** PDF 的 id 是 `P12`，但人要读的是「第 12 页」，所以展示时去掉前缀。 */
      const label = anchor === null ? '' : isPdf ? anchor.sectionId.replace(/^P/, '') : anchor.sectionId;
      const here =
        anchor === null
          ? 'The user has not pointed at a position yet.'
          : `The user is currently at ${isPdf ? 'page' : 'section'} ${label}${
              anchor.quote === undefined ? '' : `, looking at: "${anchor.quote}"`
            }.`;
      const notes =
        state.notes.length === 0
          ? ''
          : `The user's notes so far: ${state.notes.map((note) => `[${note.sectionId}] ${note.text}`).join(' | ')}.`;
      const toc =
        state.bookmarks.length === 0
          ? ''
          : `PDF bookmark outline (title → page): ${state.bookmarks
              .slice(0, 40)
              .map((bookmark) => `${bookmark.title} → p${bookmark.page}`)
              .join('; ')}.`;
      return [
        'You are co-reading a handout with the user.',
        isPdf
          ? `Handout: ${state.path} (PDF, ${state.sections.length} pages addressable, ids like "P12"). A page holds the text the user sees on that page.`
          : `Handout: ${state.path} (${state.kind}, ${state.chars} chars, ${state.sections.length} sections).`,
        here,
        notes,
        toc,
        'The handout text is NOT in your context: call handout_read (by section/page id) or handout_search before making claims about it, and cite the id (e.g. §3.2 or p12) so the user can follow along.',
        'You may also use your own knowledge, but say explicitly when you are going beyond the handout.'
      ]
        .filter((part) => part !== '')
        .join(' ');
    }
  });

  // ── 讲师提示词：把部署方维护的 Markdown 接进系统提示 ─────────────────────
  // 与上面的动态上下文分工：上面是「事实」（用户在读哪一页），这里是「教学法」
  // （怎么讲）。提示词是稳定文本，所以走 section 而不是动态 context——它不该
  // 因为翻页而改写 KV 缓存前缀。
  //
  // `interpolate: false` 是关键：默认插值会把文件里任何 `{{name}}` 当成变量引用，
  // 取不到就**让整个 system prompt 组装失败**。用户的 Markdown 不该有这个风险。
  ctx.systemPrompt.section({
    name: 'handout:teacher',
    order: config.teacherOrder,
    interpolate: false,
    text: (context) => {
      const prompt = teacher.text();
      if (prompt === '') return '';
      if (config.teacherAlways) return prompt;
      // 默认只在共读进行中生效：没有讲义打开时这个插件等于不存在（零开销）。
      const session = context.agent?.session;
      if (session === undefined) return '';
      const state = ctx.sessionProjections.stateOf(session, STATE_KEY) ?? null;
      return state === null ? '' : prompt;
    }
  });
}

export { apply, Config, inject, name };
