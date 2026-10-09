/**
 * 表格 `<`（向左合并）占位符回归：
 *  1. `| A | < |` / 链式 `| A | < | < |` → 左邻 colspan 正确，无裸 `<` 格；
 *  2. canonical 真实形态（表头链式 < + 第 2 行 ^ 跨 thead/tbody）→
 *     thead 被拍平进单个 tbody，Chrome 里 rowspan 真实生效（几何量测）；
 *  3. callout 内 `> | 甲 | < |` 同样生效；
 *  4. `$a < b$`、`F < G`、`` `<` ``、`\<`、`<img>` 等非整格 `<` 一律不动；
 *  5. --no-merge-cells 时 `<` 保持字面文本（与 > ^ 一致）；
 *  6. 围栏代码块 / $$ 公式块 / 普通正文里的 `<` 行不被归一。
 *  7. setext 二级标题（`标题 | a | < |` + `---`）与表头/分隔行格数不一致的
 *     伪表不是 GFM 表（格数不等不建表），`<` 原样保留；:---/---:/:-: 等
 *     对齐分隔写法计格正确，格数一致的真表照常归一。
 * 用法: node test/merge-left.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-core');
const { exportMarkdown, detectChrome } = require('../lib/exporter');
const { normalizeLeftMergeInTables, splitTableRowCells } = require('../lib/table-merge');

function expect(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function assertNoBareLt($, label) {
  let bare = 0;
  $('th,td').each((_i, c) => {
    if ($(c).text().trim() === '<') bare++;
  });
  expect(bare === 0, `${label} 不应出现裸 < 单元格`, bare);
}

(async () => {
  // ---------- 0. 模块级守卫（不经引擎） ----------
  {
    const BS = String.fromCharCode(92);
    const r = normalizeLeftMergeInTables(
      [
        '```',
        '| 代码块 | < | 不归一 |',
        '```',
        '',
        '$$',
        '| 公式块 | < | 不归一 |',
        '$$',
        '',
        '正文 | 竖线 < | 不是表格',
        '',
        '| 转义 ' + BS + '< | 数学 $a < b$ | 代码 `<` | 图片 <img src="x.png"> |',
        '|---|---|---|---|',
        '| 1 | 2 | 3 | 4 |',
        '',
        '> | callout | < |',
        '> |---|---|',
        '> | 1 | < |',
      ].join('\n'),
    );
    expect(r.replaced === 2, '只应替换 callout 表的 2 个 < 格', r.replaced);
    expect(r.text.includes('> | callout |  |'), 'callout 表 < 应归一为空格', r.text);
    expect(r.text.includes('| 转义 ' + BS + '< |'), '转义 \\< 不应被替换', r.text);
    expect(r.text.includes('| 代码块 | < | 不归一 |'), '代码块内不替换', r.text);
    expect(r.text.includes('| 公式块 | < | 不归一 |'), '公式块内不替换', r.text);
    expect(r.text.includes('正文 | 竖线 < | 不是表格'), '无分隔行的正文不替换', r.text);
    expect(
      splitTableRowCells('a ' + BS + BS + '| b|c`x|y`|d').length === 4,
      '\\| 与 code span 内的 | 不切格',
      splitTableRowCells('a ' + BS + BS + '| b|c`x|y`|d'),
    );

    // setext 二级标题不是 GFM 表（分隔行 1 格 ≠ 表头 4 格，不建表）：< 不得被静默吞掉
    const st = normalizeLeftMergeInTables(['标题 | a | < | 文本', '---', ''].join('\n'));
    expect(st.replaced === 0, 'setext 伪表不应归一 <', st.replaced);
    expect(st.tables === 0, 'setext 伪表不应计作表格', st.tables);
    expect(st.text.includes('标题 | a | < | 文本'), 'setext 伪表的 < 应原样保留', st.text);
    // 表头/分隔行格数不一致的伪表同样不建表
    const mm = normalizeLeftMergeInTables(['| a | < |', '|---|---|---|', ''].join('\n'));
    expect(mm.replaced === 0, '格数不一致的伪表不应归一 <', mm.replaced);
    // 对齐冒号写法（:--- / :---: / ---:）计格正确：格数一致的真表照常归一
    const al = normalizeLeftMergeInTables(
      ['| 甲 | < | 丙 |', '| :--- | :---: | ---: |'].join('\n'),
    );
    expect(al.replaced === 1 && al.tables === 1, '对齐分隔行应认表并归一 <', {
      replaced: al.replaced,
      tables: al.tables,
    });
  }

  // ---------- 1. 引擎级：HTML 结构 + Chrome 几何 ----------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-merge-left-'));
  const md = path.join(tmp, 'merge-left.md');
  fs.writeFileSync(
    md,
    [
      '| 力 | 相同点 | < | 不同点 | < | < |',
      '| :---: | :---: | :---: | :---: | :---: | :---: |',
      '| ^ | 大小 | 方向 | 作用对象 | 作用时间 | 力的性质 |',
      '| 平衡力 | 相等 | 相反 | 对象 | 时间 | 性质 |',
      '',
      '| A | < | < |',
      '|---|---|---|',
      '| 单行链式 | x | y |',
      '',
      '> [!question] 选项',
      '> | 甲 | < |',
      '> |---|---|',
      '> | 1 | 2 |',
      '',
      // 注：转义 \\< 会在 HTML 里合法渲染成字面 < 文本（模块级用例已单测），
      // 不放进本表，避免与"无裸 < 占位符"断言冲突。
      '| F < G | 代码 `<` | 保留 |',
      '|---|---|---|',
      '| 1 | 2 | 3 |',
      '',
    ].join('\n'),
    'utf8',
  );

  const result = await exportMarkdown({ file: md, format: 'html', outDir: tmp });
  const html = fs.readFileSync(result.outputs.html, 'utf8');
  const $ = cheerio.load(html);
  assertNoBareLt($, '合并开启');

  // 第 1 张表：表头链式 < + 第 2 行 ^ → 拍平进 tbody
  const t0 = $('table').eq(0);
  expect(t0.hasClass('mpe-table-flat'), '跨组 rowspan 表应有 mpe-table-flat 类', t0.attr('class'));
  expect(t0.children('thead').length === 0, '拍平后不应再有 thead', t0.children('thead').length);
  expect(t0.find('tbody').length === 1, '拍平后应只有单个 tbody', t0.find('tbody').length);
  const headRow = t0.find('tr').first();
  const h0 = headRow.children('th').first();
  expect(h0.text().trim() === '力' && h0.attr('rowspan') === '2', '力 应 rowspan=2', h0.attr('rowspan'));
  const headThs = headRow.children('th').toArray();
  expect(
    headThs.length === 3 &&
      !$(headThs[0]).attr('colspan') &&
      $(headThs[1]).attr('colspan') === '2' &&
      $(headThs[2]).attr('colspan') === '3',
    '表头应为 力 | 相同点c2 | 不同点c3',
    headThs.map((c) => $(c).attr('colspan')),
  );

  // 第 2 张表：链式 < → colspan 3（无跨组 rowspan，保留原生 thead）
  const t1 = $('table').eq(1);
  expect(!t1.hasClass('mpe-table-flat'), '无跨组 rowspan 的表不应拍平', t1.attr('class'));
  const t1head = t1.find('thead th').first();
  expect(t1head.text().trim() === 'A' && t1head.attr('colspan') === '3', '链式 < 应使 A colspan=3', {
    text: t1head.text().trim(),
    colspan: t1head.attr('colspan'),
  });

  // 第 3 张表：callout 内 < → colspan 2
  const t2 = $('table').eq(2);
  expect(t2.closest('.callout').length === 1, '第三张表应在 callout 内', '位置');
  const t2head = t2.find('thead th').first();
  expect(t2head.text().trim() === '甲' && t2head.attr('colspan') === '2', 'callout 内 甲 应 colspan=2', {
    text: t2head.text().trim(),
    colspan: t2head.attr('colspan'),
  });

  // 第 4 张表：`F < G`、`\<` 非整格 < 不合并，仍是 3 格
  const t3 = $('table').eq(3);
  const t3headCells = t3.find('thead th').toArray();
  expect(t3headCells.length === 3, '非整格 < 不应合并', t3headCells.length);
  expect(t3headCells[0].tagName === 'th' && $(t3headCells[0]).text().includes('F'), 'F < G 应保留', $(t3headCells[0]).text());
  expect(!/colspan|rowspan/.test(t3.html()), '第 4 张表不应有任何合并属性', '合并属性');

  // ---------- 2. Chrome 几何：拍平表 rowspan 真实跨行 ----------
  const browser = await puppeteer.launch({ executablePath: detectChrome(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 900, height: 800 });
    await page.goto(url.pathToFileURL(result.outputs.html).href, { waitUntil: 'load' });
    const geo = await page.evaluate(() => {
      const t = document.querySelector('table.mpe-table-flat');
      if (!t) return null;
      const rows = t.querySelectorAll('tr');
      const box = (el) => el.getBoundingClientRect();
      const r0c0 = rows[0].querySelector('th');
      const r1c0 = rows[1].querySelector('th,td');
      return {
        r1c0Text: r1c0.textContent.trim(),
        rowspanWorks: box(r1c0).left >= box(r0c0).left + box(r0c0).width - 1,
        rowspanCovers: box(r0c0).height >= box(rows[1]).height * 1.7,
      };
    });
    expect(geo, '应存在 mpe-table-flat 表', geo);
    expect(geo.r1c0Text === '大小', '第 2 行首格应为 大小', geo.r1c0Text);
    expect(geo.rowspanWorks, 'Chrome 中 力 的 rowspan 应把 大小 推到第 2 列', geo);
    expect(geo.rowspanCovers, '力 的格子高度应覆盖两行', geo);
  } finally {
    await browser.close();
  }

  // ---------- 3. --no-merge-cells：< 保持字面文本 ----------
  const offResult = await exportMarkdown({
    file: md,
    format: 'html',
    outDir: tmp,
    outName: 'merge-left-off',
    mergeCells: false,
  });
  const offHtml = fs.readFileSync(offResult.outputs.html, 'utf8');
  const $off = cheerio.load(offHtml);
  let offBare = 0;
  $off('th,td').each((_i, c) => {
    if ($off(c).text().trim() === '<') offBare++;
  });
  expect(offBare >= 5, '关闭合并后 < 应按普通文本渲染（字面保留）', offBare);
  expect(
    $off('table').first().find('thead th').length === 6,
    '关闭合并后表头不应合并（6 个独立 th）',
    $off('table').first().find('thead th').length,
  );
  expect(
    $off('table.mpe-table-flat').length === 0,
    '关闭合并后不应拍平任何表',
    $off('table.mpe-table-flat').length,
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('merge-left: 全部断言通过');
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
