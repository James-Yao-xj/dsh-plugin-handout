/**
 * 讲义解析：把一份文本讲义切成可寻址的「节」，支持按节取文与全文检索。
 *
 * 纯函数、零依赖 —— 方便单测，也方便以后替换成 PDF/HTML 解析器。
 * 这里刻意不通读整份讲义：模型只应该拿到它提问所需的那一小段。
 * @module
 */

/** Markdown 代码围栏的开头（``` 或 ~~~）。 */
const FENCE = /^\s*(`{3,}|~{3,})/;

/** Markdown ATX 标题行。 */
const ATX = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** 纯文本兜底分块的行数。 */
const PLAIN_CHUNK_LINES = 60;

/** 标题里的阿拉伯编号：`3.2`、`3.2.1`、`4 学习率`、`5. 小结`。 */
const ASCII_NUMBER = /^(\d+(?:[.．]\d+)*)(?:[、.)．]|\s|$)/;

/** 标题里的中文编号：`第三讲`、`第 2 章`、`第4节`。 */
const CN_SECTION = /^第\s*([一二三四五六七八九十]+|\d+)\s*[讲章节篇课部回]\s*/;

/** 中文数字最大支持的位数（够用到九十九）。 */
const CN_DIGITS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/**
 * 解析一个「一~九十九」的中文数字。
 * @param text - 例如 `三`、`十`、`十二`、`二十`、`二十一`。
 * @returns 数值，或 `undefined`。
 */
function chineseNumber(text) {
  if (text === '十') return 10;
  const [tens, ones] = text.split('十');
  if (ones === undefined) return CN_DIGITS[text];
  const high = tens === '' ? 1 : CN_DIGITS[tens];
  const low = ones === '' ? 0 : CN_DIGITS[ones];
  return high === undefined || low === undefined ? undefined : high * 10 + low;
}

/**
 * 从标题里取出讲义**自己**用的编号。
 *
 * 这一步比看起来重要：讲义正文里写着「3.2 学习率」，用户就会说「我在看 3.2 节」，
 * 所以编号必须优先采用讲义自己的数字，而不是我们按标题层级另生成一套（那会得到
 * `1.2`，跟用户说的对不上）。取不到时才回退到层级编号。
 * @param title - 标题原文。
 * @returns 编号字符串，或 `undefined`。
 */
export function numberingOf(title) {
  const text = title.trim();
  const ascii = ASCII_NUMBER.exec(text);
  if (ascii !== null) return ascii[1].replace(/．/g, '.');
  const cn = CN_SECTION.exec(text);
  if (cn === null) return undefined;
  const value = /^\d+$/.test(cn[1]) ? Number(cn[1]) : chineseNumber(cn[1]);
  return value === undefined ? undefined : String(value);
}

/**
 * 判定讲义类型。PDF 走另一条抽取路径（见 `pdf.js`），因此要单独区分出来。
 * @param path - 讲义路径（只用来判断扩展名）。
 * @returns `'markdown'`、`'pdf'` 或 `'text'`。
 */
export function detectKind(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.mdx')) return 'markdown';
  return 'text';
}

/**
 * 没有标题（或不是 Markdown）时的兜底大纲：按固定行数切块。
 * 块标题取该块第一行非空文本，
 * @param source - 讲义全文。
 * @returns 大纲条目数组。
 */
function plainOutline(source) {
  const lines = source.split(/\r?\n/);
  const sections = [];
  for (let start = 0; start < lines.length; start += PLAIN_CHUNK_LINES) {
    const end = Math.min(start + PLAIN_CHUNK_LINES, lines.length);
    const firstText = lines.slice(start, end).find((line) => line.trim() !== '') ?? '';
    sections.push({
      id: `L${start + 1}`,
      level: 1,
      title: firstText.trim().slice(0, 60) || `第 ${start + 1}–${end} 行`,
      line: start + 1,
      endLine: end
    });
  }
  return sections;
}

/**
 * 抽取大纲。
 *
 * 编号优先用讲义自己写的（`3.2`、`第三讲`→`3`），取不到才按标题层级生成（`1`、`1.1`）；
 * 编号撞车时退回层级编号，保证每个 id 唯一。一节的范围是「本标题行 → 下一个同级或更高级
 * 标题之前」，所以读第 3 章会连它的子节一起读到。代码围栏里的 `#` 不算标题。
 * @param source - 讲义全文。
 * @param kind - {@link detectKind} 的结果。
 * @returns `{id, level, title, line, endLine}[]`，`line`/`endLine` 是 1 起的闭区间。
 */
export function outlineOf(source, kind) {
  const lines = source.split(/\r?\n/);
  const heads = [];
  if (kind === 'markdown') {
    let fence = null;
    for (let i = 0; i < lines.length; i += 1) {
      const fenceMatch = FENCE.exec(lines[i]);
      if (fenceMatch !== null) {
        const marker = fenceMatch[1][0];
        if (fence === null) fence = marker;
        else if (marker === fence) fence = null;
        continue;
      }
      if (fence !== null) continue;
      const match = ATX.exec(lines[i]);
      if (match !== null) heads.push({ level: match[1].length, title: match[2].trim(), line: i + 1 });
    }
  }
  if (heads.length === 0) return plainOutline(source);

  const counters = [];
  const used = new Set();
  // 层级编号按「相对深度」算：讲义直接从 `##` 开始时，第一个标题是 1 而不是 0.1。
  let shallowest = Number.POSITIVE_INFINITY;
  const sections = heads.map((head) => {
    shallowest = Math.min(shallowest, head.level);
    const depth = head.level - shallowest + 1;
    counters.length = depth;
    for (let i = 0; i < depth; i += 1) if (counters[i] === undefined) counters[i] = 0;
    counters[depth - 1] += 1;
    const outline = counters.join('.');
    const own = numberingOf(head.title);
    const id = own !== undefined && !used.has(own) ? own : outline;
    used.add(id);
    used.add(outline);
    return { id, level: head.level, title: head.title, line: head.line, endLine: lines.length };
  });
  for (let i = 0; i < sections.length; i += 1) {
    let end = lines.length;
    for (let j = i + 1; j < sections.length; j += 1) {
      if (sections[j].level <= sections[i].level) {
        end = sections[j].line - 1;
        break;
      }
    }
    sections[i].endLine = Math.max(end, sections[i].line);
  }
  return sections;
}

/**
 * 找出某一节所属的大纲条目。
 * @param sections - {@link outlineOf} 的结果。
 * @param line - 1 起的行号。
 * @returns 覆盖该行的条目，或 `undefined`。
 */
export function sectionAt(sections, line) {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    if (sections[i].line <= line && line <= sections[i].endLine) return sections[i];
  }
  return undefined;
}

/**
 * 取一节的正文。
 * @param source - 讲义全文。
 * @param fromLine - 起始行（1 起，含）。
 * @param toLine - 结束行（1 起，含）。
 * @param maxChars - 截断上限。
 * @returns `{text, fromLine, toLine, truncated, totalLines}`。
 */
export function sliceLines(source, fromLine, toLine, maxChars) {
  const lines = source.split(/\r?\n/);
  const from = Math.max(1, Math.min(fromLine, lines.length));
  const to = Math.max(from, Math.min(toLine, lines.length));
  const body = lines.slice(from - 1, to).join('\n');
  const truncated = body.length > maxChars;
  return {
    text: truncated ? `${body.slice(0, maxChars)}\n\n…（本节还有 ${body.length - maxChars} 个字符，用 handout_read 的 from_line/to_line 继续读）` : body,
    fromLine: from,
    toLine: to,
    truncated,
    totalLines: lines.length
  };
}

/**
 * 全文检索。
 * @param source - 讲义全文。
 * @param query - 关键词（大小写不敏感，按字面匹配）。
 * @param options - `limit` 命中上限，`contextLines` 每条命中附带的上下文行数。
 * @returns `{line, text, context}[]`。
 */
export function searchText(source, query, options) {
  const { limit, contextLines } = options;
  const lines = source.split(/\r?\n/);
  const needle = query.toLowerCase();
  const hits = [];
  for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
    if (!lines[i].toLowerCase().includes(needle)) continue;
    const from = Math.max(0, i - contextLines);
    const to = Math.min(lines.length, i + contextLines + 1);
    const context = lines
      .slice(from, to)
      .map((line, offset) => `${String(from + offset + 1).padStart(5, ' ')}| ${line}`)
      .join('\n');
    hits.push({ line: i + 1, text: lines[i], context });
  }
  return hits;
}
