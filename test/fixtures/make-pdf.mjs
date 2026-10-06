/**
 * 生成测试 / 演示用的 PDF（不依赖任何库，也不需要网络）。
 *
 * 手写一个最小的、合法的 PDF：未压缩的内容流 + Helvetica 字体。之所以自己生成而不是
 * 塞二进制进仓库，是为了让夹具可读、可改、可复查。
 *
 *   node test/fixtures/make-pdf.mjs [输出路径]
 *
 * 不传参数时写出 `lecture.pdf`（两页，供单测使用）。
 * @module
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** 两页的测试夹具内容。 */
export const FIXTURE_PAGES = [
  ['Gradient Descent', '3.1 Intuition', 'Follow the negative gradient.'],
  ['3.2 Learning Rate', 'Too large a learning rate oscillates.', '3.2.1 Decay', 'Step decay is common.']
];

/**
 * 把一个页面的若干行文本转成 PDF 内容流。
 * @param lines - 页面上的文本行。
 * @returns 内容流字符串。
 */
function streamFor(lines) {
  const commands = ['BT', '/F1 14 Tf', '72 720 Td', '18 TL'];
  lines.forEach((line, index) => {
    if (index > 0) commands.push('T*');
    commands.push(`(${line.replace(/([()\\])/g, '\\$1')}) Tj`);
  });
  commands.push('ET');
  return commands.join('\n');
}

/**
 * 组装一个合法的 PDF。
 *
 * 对象编号必须一次算清：目录(1) → 页树(2) → 每页(3..2+n) → 字体 → 每条内容流。
 * 早先的版本先 push 字体再 push 内容流，却按页数硬算内容流对象号，
 * 结果页面把字体对象当成了内容流，抽取出来是空的 —— 所以这里显式编号。
 * @param pages - 每页一个字符串数组。
 * @returns PDF 字节。
 */
export function buildPdf(pages) {
  const pageCount = pages.length;
  const firstPageObject = 3;
  const fontObject = firstPageObject + pageCount;
  const firstContentObject = fontObject + 1;

  const objects = [];
  objects.push('<< /Type /Catalog /Pages 2 0 R >>');
  objects.push(
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${firstPageObject + index} 0 R`).join(' ')}] /Count ${pageCount} >>`
  );
  pages.forEach((_, index) => {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontObject} 0 R >> >> /Contents ${firstContentObject + index} 0 R >>`
    );
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (const page of pages) {
    const stream = streamFor(page);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = body.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) xref += `${String(offset).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(body + xref + trailer, 'latin1');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const target = process.argv[2] ?? join(here, 'lecture.pdf');
  const bytes = buildPdf(FIXTURE_PAGES);
  writeFileSync(target, bytes);
  console.log(`wrote ${target} (${bytes.length} bytes, ${FIXTURE_PAGES.length} pages)`);
}
