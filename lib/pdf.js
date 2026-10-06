/**
 * PDF 讲义抽取：逐页文本、可选的 PDF 书签目录，以及按文件指纹失效的缓存。
 *
 * 为什么不自己解析 PDF：PDF 正文的文本是被压缩过、按绘制指令排列的，还涉及字体
 * 编码与 ToUnicode 映射 —— 手写解析器在这三件事上必错。这里用 `unpdf`（零依赖，
 * 内置 PDF.js 的服务端构建）做抽取，本模块只负责「把抽取结果变成讲义可用的形状」。
 *
 * 寻址单位是**页**：id 形如 `P12`。理由是 PDF 没有可靠的标题层级（书签常常缺失
 * 或不可信），而「我在第 12 页」是人和模型都不会搞错的坐标。书签目录只作为
 * 辅助信息呈现，不用来寻址。
 * @module dsh-plugin-handout/pdf
 */

import { extractText, getDocumentProxy } from 'unpdf';

/** 页面之间保留的空行数（把连续空行压成一行，避免切片全是空白）。 */
const BLANK = '';

/**
 * 把一页的抽取文本规范化成行数组。
 * @param text - 单页文本。
 * @returns 去掉首尾空行、折叠连续空行的行数组。
 */
function normalizePage(text) {
  const raw = String(text)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''));
  const out = [];
  for (const line of raw) {
    if (line === BLANK && out.length > 0 && out[out.length - 1] === BLANK) continue;
    out.push(line);
  }
  while (out.length > 0 && out[0] === BLANK) out.shift();
  while (out.length > 0 && out[out.length - 1] === BLANK) out.pop();
  return out;
}

/**
 * 把逐页文本拼成一份可切片的「源文本」，同时记下每页的行区间。
 *
 * 行号是后续所有读取与检索的坐标系，所以拼接方式必须与 {@link import('./handout.js').sliceLines}
 * 的按行切片完全一致：页与页之间最多一个空行，且该空行不计入任何一页的区间。
 * @param pages - 逐页文本。
 * @returns `{source, index}`，`index[i]` 是第 `i+1` 页的 `{page, line, endLine, heading}`。
 */
export function pagesToSource(pages) {
  const bodies = pages.map(normalizePage);
  const skip = boilerplateKeys(bodies);

  const lines = [];
  const index = [];
  bodies.forEach((body, position) => {
    if (position > 0 && lines.length > 0 && lines[lines.length - 1] !== BLANK) lines.push(BLANK);
    const line = lines.length + 1;
    lines.push(...body);
    const heading =
      body.find(
        (text) =>
          text.trim() !== '' && !skip.has(lineKey(text)) && !isPageNumber(text) && !isBulletOnly(text)
      ) ?? '';
    index.push({
      page: position + 1,
      line,
      endLine: Math.max(lines.length, line),
      heading: heading.trim().slice(0, 80)
    });
  });
  return { source: lines.join('\n'), index };
}

/**
 * 把一行文本归一成跨页可比较的键：折叠空白、转小写。
 * @param line - 原始行。
 * @returns 比较键。
 */
function lineKey(line) {
  return line.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** 页码行：`12`、`12 / 51`、`Page 12`、`p.12`、`第 12 页`。 */
const PAGE_NUMBER = /^(?:\d{1,4}|\d{1,4}\s*[/·]\s*\d{1,4}|(?:page|p\.?)\s*\d{1,4}|第\s*\d{1,4}\s*页)$/i;

/**
 * 这一行是不是页码/页脚计数。
 *
 * 页码和页眉不同：它**每页都不一样**，所以按「重复出现」检测抓不到，必须单独识别。
 * @param line - 待判定的一行。
 * @returns 是否像页码。
 */
function isPageNumber(line) {
  return PAGE_NUMBER.test(line.trim());
}

/**
 * 这一行是否只剩项目符号/分隔符（`• • •`、`---`、`***`）。
 *
 * 版式图里常有这类纯符号行，把它们当小标题毫无信息量。
 * @param line - 待判定的一行。
 * @returns 是否只有符号。
 */
function isBulletOnly(line) {
  return line.replace(/[•·‣▪◦–—\-*+=_>|.\s]/g, '') === '';
}

/**
 * 找出跨页反复出现的行——幻灯片页眉/页脚、课程名、水印。
 *
 * 这一步是给「取本页第一行当小标题」兜底的：讲义 PPT 几乎每页都在顶部印同一行
 * 课程名，如果照直取第一行，51 页大纲会变成 51 行一模一样的东西，等于没有大纲。
 * @param bodies - 已经规范化的逐页行数组。
 * @returns 需要忽略的行键集合。
 */
function boilerplateKeys(bodies) {
  const counts = new Map();
  for (const body of bodies) {
    for (const key of new Set(body.map(lineKey))) {
      if (key === '') continue;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  // 至少出现在 3 页、且覆盖三成以上的页，才算页眉页脚（短文档因此不受影响）。
  const threshold = Math.max(3, Math.ceil(bodies.length * 0.3));
  return new Set(
    [...counts.entries()].filter(([, count]) => count >= threshold).map(([key]) => key)
  );
}

/**
 * 把页索引转成讲义大纲条目。
 * @param index - {@link pagesToSource} 的 `index`。
 * @returns 大纲条目数组，id 形如 `P12`。
 */
export function pdfSections(index) {
  return index.map(({ page, line, endLine, heading }) => ({
    id: `P${page}`,
    level: 1,
    title: heading === '' ? `第 ${page} 页` : `第 ${page} 页 · ${heading}`,
    line,
    endLine
  }));
}

/**
 * 解析一个书签目标指向第几页。
 * @param pdf - PDF.js 文档代理。
 * @param dest - 书签的 `dest` 字段：命名目标的字符串，或显式的目标数组。
 * @returns 1 起的页码，或 `undefined`。
 */
async function pageOfDest(pdf, dest) {
  try {
    const resolved = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(resolved) || resolved.length === 0) return undefined;
    const index = await pdf.getPageIndex(resolved[0]);
    return typeof index === 'number' ? index + 1 : undefined;
  } catch {
    // 书签目标可以是任意对象引用，损坏或跨文档引用都只是「这个书签不可用」。
    return undefined;
  }
}

/**
 * 读取 PDF 自带的书签目录（扁平化）。
 * @param pdf - PDF.js 文档代理。
 * @returns `{title, page, depth}[]`；没有书签时为空数组。
 */
async function readBookmarks(pdf) {
  let outline;
  try {
    outline = await pdf.getOutline();
  } catch {
    return [];
  }
  if (!Array.isArray(outline)) return [];
  const flat = [];
  const walk = async (items, depth) => {
    for (const item of items) {
      const page = await pageOfDest(pdf, item?.dest);
      const title = String(item?.title ?? '').trim();
      if (page !== undefined && title !== '') flat.push({ title: title.slice(0, 120), page, depth });
      if (Array.isArray(item?.items) && item.items.length > 0) await walk(item.items, depth + 1);
    }
  };
  await walk(outline, 1);
  return flat;
}

/**
 * 把各种字节容器归一成 PDF.js 认的 `Uint8Array`。
 *
 * 这一步不能省：`ctx.fs.readBytes` 在 Node 后端返回的是 `Buffer`，而 PDF.js 明确拒绝
 * `Buffer` 并抛 "Please provide binary data as `Uint8Array`, rather than `Buffer`"。
 * 传 `Buffer` 的 `byteOffset`/`byteLength` 是为了不复制内存，也避免 `Buffer` 池化
 * 时把相邻数据一起交出去。
 * @param bytes - `Uint8Array`、`Buffer`，或任何 ArrayBuffer 视图。
 * @returns 只覆盖这段数据的 `Uint8Array`。
 */
function toUint8Array(bytes) {
  if (bytes instanceof Uint8Array && !(typeof Buffer !== 'undefined' && Buffer.isBuffer(bytes))) return bytes;
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return new Uint8Array(bytes);
}

/**
 * 抽取一份 PDF。
 * @param bytes - PDF 字节（`Uint8Array` 或 `Buffer`）。
 * @param options - `maxPages` 限制抽多少页（防止超大文档耗尽内存）。
 * @returns `{source, sections, bookmarks, pageCount, extractedPages, hasText}`；
 *   `hasText` 为 false 表示这份 PDF 没有文字层（扫描件），调用方应当明确告知用户。
 * @throws 当字节不是可解析的 PDF 时抛出带可读原因的错误。
 */
export async function extractPdf(bytes, options) {
  const { maxPages } = options;
  let pdf;
  try {
    pdf = await getDocumentProxy(toUint8Array(bytes));
  } catch (error) {
    throw new Error(`这份 PDF 无法解析（可能已加密、损坏，或其实不是 PDF）：${error instanceof Error ? error.message : String(error)}`);
  }
  const pageCount = pdf.numPages;
  const wanted = Math.min(pageCount, maxPages);
  let text;
  try {
    ({ text } = await extractText(pdf, { mergePages: false }));
  } catch (error) {
    throw new Error(`这份 PDF 的文本层无法抽取（可能是纯扫描件，需要 OCR）：${error instanceof Error ? error.message : String(error)}`);
  }
  const pages = (Array.isArray(text) ? text : [text]).slice(0, wanted);
  const { source, index } = pagesToSource(pages);
  const bookmarks = await readBookmarks(pdf);
  return {
    source,
    sections: pdfSections(index),
    bookmarks,
    pageCount,
    extractedPages: pages.length,
    hasText: source.trim().length > 0
  };
}

/**
 * 一个按文件指纹失效的小 LRU 缓存。
 *
 * 抽一份几百页的 PDF 要几秒，而同一轮对话里模型会反复读同一份讲义，所以必须缓存；
 * 键里带 `ctx.fs.stat` 的 `version`（dev:ino:size:mtimeNs:ctimeNs），文件一改立刻失效。
 * @param limit - 最多缓存几份讲义。
 * @returns `{get, set}`。
 */
export function createPdfCache(limit = 4) {
  const entries = new Map();
  return {
    /**
     * @param key - 缓存键。
     * @returns 缓存值，或 `undefined`。
     */
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    /**
     * @param key - 缓存键。
     * @param value - 抽取结果。
     */
    set(key, value) {
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    }
  };
}
