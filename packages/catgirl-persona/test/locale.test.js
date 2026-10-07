/**
 * 清单（package.json）与显示元数据（locale/*.json）的回归测试。
 *
 * 这些断言不是我们自己定的约定，而是照 harness 0.2.0-rc.2 的**读取方实现**抄的
 * （`@deepseek-ai/dsh-app-boot` 的 `readPluginMeta()` / `dictionariesOf()` /
 * `iconOf()`），并且与随 harness 发布的 `cordis-plugin-development` skill
 * 里 `references/host-plugin.md` 那节「Display metadata and icon」一致。
 *
 * 为什么值得单独测：这几处写错**都不会报错**，只会安静地退回默认值——
 * 插件卡片显示包名，而不是这里写的标题。
 *
 *   - 显示文本必须在 `meta` 下面（`meta.title` / `meta.description`）。
 *     写成顶层 `title` / `description` 会被静默忽略。
 *   - 这两个字段要么不写，要么是**非空字符串**：写成空串会让读取方抛错，
 *     结果是整个卡片的中英文本一起丢掉，还留一条诊断。
 *   - `locale/en.json` 是主文件：别的语言文件必须和它同目录，文件名必须是语言 id。
 *   - `./package.json` 与 `./locale/*.json` 必须写进 `exports`：读取方是通过
 *     ESM 解析器拿这两个资源的，没导出就等于没有。
 *   - 图标是清单顶层的 `icon`，按**路径**解析（不走 exports），必须是
 *     SVG / PNG / JPEG / WebP，且不超过 256 KiB。
 *
 *   node --test test/locale.test.js
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
const LOCALE_DIR = join(PACKAGE_ROOT, 'locale');

/** harness 认定语言 id 的正则（`dsh-app-boot` 里的 `LANGUAGE_ID`）。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u;

/** 图标体积上限，与 harness 的 `MAX_ICON_BYTES` 一致。 */
const MAX_ICON_BYTES = 256 * 1024;

/** harness 接受的图标扩展名（`ICON_MEDIA_TYPES` 的键）。 */
const ICON_EXTENSIONS = ['.svg', '.png', '.jpg', '.jpeg', '.webp'];

const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'));

/** 读一份 locale 文件。 @param name - 文件名。 @returns 解析后的对象。 */
function readLocale(name) {
  return JSON.parse(readFileSync(join(LOCALE_DIR, name), 'utf8'));
}

test('locale/ 里每个文件都以语言 id 命名，且解析为对象', () => {
  const names = readdirSync(LOCALE_DIR).filter((name) => name.endsWith('.json'));
  assert.ok(names.includes('en.json'), 'locale/en.json 是读取方的主文件，必须有');
  for (const name of names) {
    const language = name.slice(0, -'.json'.length);
    assert.match(language, LANGUAGE_ID, `${name} 的文件名必须是语言 id`);
    const parsed = readLocale(name);
    assert.equal(typeof parsed, 'object', `${name} 必须是 JSON 对象`);
    assert.ok(parsed !== null && !Array.isArray(parsed), `${name} 必须是 JSON 对象`);
  }
});

test('每个 locale 都把显示文本放在 meta 下面，且非空', () => {
  for (const name of readdirSync(LOCALE_DIR).filter((entry) => entry.endsWith('.json'))) {
    const parsed = readLocale(name);
    const meta = parsed.meta;
    assert.equal(typeof meta, 'object', `${name}: 缺少 meta（顶层 title/description 会被忽略）`);
    for (const field of ['title', 'description']) {
      const value = meta[field];
      assert.equal(typeof value, 'string', `${name}: meta.${field} 必须是字符串`);
      assert.notEqual(value.trim(), '', `${name}: meta.${field} 不能是空串（空串会让整份元数据被丢掉）`);
    }
  }
});

test('中英两份 locale 都提供了同名的两个字段', () => {
  const zh = readLocale('zh.json').meta;
  const en = readLocale('en.json').meta;
  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort(), '两种语言应覆盖同样的字段');
  assert.notEqual(zh.title, en.title, '翻译没生效：中英标题不该一模一样');
});

test('exports 暴露了读取方要解析的两个资源', () => {
  const exports = manifest.exports;
  assert.ok('./package.json' in exports, '读取方要解析 ./package.json 拿 name/description/icon');
  assert.ok('./locale/*.json' in exports, '读取方要解析 ./locale/en.json 拿显示文本');
});

test('icon 是包内的、受支持格式的小图', () => {
  const icon = manifest.icon;
  assert.equal(typeof icon, 'string', 'manifest.icon 必须是相对路径字符串');
  assert.ok(!icon.startsWith('/') && !/^[A-Za-z][A-Za-z\d+.-]*:/u.test(icon), 'icon 不能是绝对路径或 URL');
  assert.ok(ICON_EXTENSIONS.includes(icon.slice(icon.lastIndexOf('.')).toLowerCase()), `icon 必须是 ${ICON_EXTENSIONS.join(' / ')}`);
  const size = statSync(join(PACKAGE_ROOT, icon)).size;
  assert.ok(size <= MAX_ICON_BYTES, `icon 不能超过 256 KiB（当前 ${size} 字节）`);
});

test('cordis.patch.yml 存在，且默认人格文件非空', () => {
  const patch = manifest.dsh?.bundle?.patch;
  assert.equal(typeof patch, 'string', 'dsh.bundle.patch 必须是路径');
  assert.ok(statSync(join(PACKAGE_ROOT, patch)).size > 0, `${patch} 不能是空文件`);
  const prompt = statSync(join(PACKAGE_ROOT, 'prompts/catgirl.md')).size;
  assert.ok(prompt > 0, 'prompts/catgirl.md 是默认 promptPath 指向的文件，不能为空');
});
