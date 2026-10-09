/**
 * 拍平表（mpe-table-flat）× sheet 分页 组合回归（端到端）：
 *
 * README 原句（spec）：
 *   「分页 PDF（`--pagination` 系列）对合并单元格同样安全：跨页拆表时分组单元格
 *    会复制到续页并裁短 rowspan，续表不缺列、不错位（拍平表没有 thead，续页
 *    不重复表头，分组单元格照常续接）。」
 *
 * 覆盖点：
 *  1. 源文档含 `^` 链 + `<` 链的表（触发 thead 跨组 rowspan 拍平），行数多到
 *     必然跨页；前置大块把表推到页底附近 —— 覆盖「表从当前页剩余空间开始、
 *     按行流式续页」场景；
 *  2. 表格确实跨 ≥2 页（sheet 分页默认开启，一页 = 一个 .mpe-sheet）；
 *  3. 续页不重复表头：拍平表没有 thead，续页表格片无 thead、无 th，
 *     表头文本全文恰好出现一次；
 *  4. 内容零丢失：全部数据单元格文本在分页 DOM 中恰好出现一次；
 *     分组单元格（rowspan 组）按 README「复制到续页并裁短 rowspan」照常续接：
 *     每个表格片恰好一份、续片带 data-mpe-rowspan-continuation，各片 rowspan
 *     之和 = 原始总行数（裁短但总量守恒）；
 *  5. 续表不缺列、不错位：每个表格片逐行做栅格占用模拟，每行都恰好铺满 4 列；
 *  6. 分页无溢出（data-fit-state 不为 overflow），PDF 产物真实落盘。
 *
 * 量测方式：走 exportMarkdown 真实 PDF 管线（sheet 分页默认开启），借
 * MPE_KEEP_TMP_HTML 保留打印 HTML，再在 Chrome 里重放分页 DOM 量几何
 * （与现有分页测试 pagination-table.js 同款 sheet 结构断言）。
 * 用法: node test/pagination-merge-cells.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');
const { exportMarkdown, detectChrome } = require('../lib/exporter');

let pass = 0;
function expect(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
  pass += 1;
}

/**
 * 跑一次真实 PDF 导出，借 MPE_KEEP_TMP_HTML=1 + stderr 拦截拿到
 * exportPdfWithFooter 写出的打印 HTML（注入过分页 CSS/JS 的中间产物）。
 */
async function exportPdfAndCapturePrintHtml(opts) {
  const chunks = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk));
    return origWrite(chunk, ...rest);
  };
  process.env.MPE_KEEP_TMP_HTML = '1';
  try {
    const result = await exportMarkdown(opts);
    return { result, log: chunks.join('') };
  } finally {
    process.stderr.write = origWrite;
    delete process.env.MPE_KEEP_TMP_HTML;
  }
}

function printHtmlPathFromLog(log) {
  const m = log.match(/调试打印 HTML: (.+)/);
  if (!m) throw new Error(`日志里没有打印 HTML 路径: ${log.slice(-400)}`);
  return m[1].trim();
}

// A4 ≈ 793.7×1122.5px @96dpi；默认边距 1cm → 页体容量 ≈ 1047px
const ROWS_TOTAL = 40; // 数据行数（每行首格 ^，分组格 rowspan = 1 + 40 = 41）
const COLS_TOTAL = 4;

function buildMarkdown() {
  const lines = [];
  // 前置大块：760px（约页体 73%），把表推到页底附近 —— 表只能从当前页
  // 剩余空间开始落行，剩余 ~287px 放不下整表 → 按行流式续页
  lines.push('<div style="height:760px">前置占位内容（把表格推到页底附近）</div>');
  lines.push('');
  // 表头行 + 分隔行 + 数据行。首数据行 ^（跨 thead/tbody → 触发拍平），
  // 之后每行首格 ^ 链式并入 → 分组格 rowspan 覆盖全部 41 行；
  // 表头 甲列 后接链式 < → colspan=2（< 占位符与分页同场验证）
  lines.push('| 分组 | 甲列 | < | 乙列 |');
  lines.push('| :--- | :--- | :--- | :--- |');
  for (let i = 1; i <= ROWS_TOTAL; i += 1) {
    const nn = String(i).padStart(2, '0');
    lines.push(`| ^ | 格甲${nn} | 格中${nn} | 格乙${nn} |`);
  }
  return lines.join('\n');
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-page-merge-'));
  const md = path.join(tmp, 'pagination-merge-cells.md');
  fs.writeFileSync(md, buildMarkdown(), 'utf8');

  // ---------- 1. 真实 PDF 导出（sheet 分页默认开启） ----------
  const { result, log } = await exportPdfAndCapturePrintHtml({
    file: md,
    format: 'pdf',
    outDir: tmp,
  });
  const pdfFile = result.outputs.pdf;
  expect(!!pdfFile && fs.existsSync(pdfFile), 'PDF 产物应存在', result.outputs);
  expect(fs.statSync(pdfFile).size > 10 * 1024, 'PDF 不应是空壳', fs.statSync(pdfFile).size);

  // ---------- 2. Chrome 重放打印 HTML，量分页 DOM ----------
  const browser = await puppeteer.launch({ executablePath: detectChrome(), headless: true });
  let geo;
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });
    // 与导出同一媒体环境（导出流程 emulateMediaType('print')）
    await page.emulateMediaType('print');
    await page.goto(url.pathToFileURL(printHtmlPathFromLog(log)).href, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.documentElement.dataset.mpeFooter === 'true',
      { timeout: 60000 },
    );
    geo = await page.evaluate(({ rowsTotal, colsTotal }) => {
      const sheets = Array.from(document.querySelectorAll('.mpe-sheet'));
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      const countIn = (hay, needle) => hay.split(needle).length - 1;

      // 每片表格的独立量测：thead/th 有无、分组格、逐行栅格占用
      const pieces = [];
      document.querySelectorAll('.mpe-sheet-body table').forEach((t) => {
        const sheet = t.closest('.mpe-sheet');
        const body = t.closest('.mpe-sheet-body');
        // 栅格占用模拟：rowspan/colspan 展开后每行应恰好铺满总列数
        const rows = Array.from(t.querySelectorAll('tr'));
        const grid = rows.map(() => ({}));
        rows.forEach((row, ri) => {
          let col = 0;
          Array.from(row.cells).forEach((cell) => {
            while (grid[ri][col]) col += 1;
            const cs = Math.max(1, cell.colSpan || 1);
            const rs = Math.max(1, cell.rowSpan || 1);
            for (let dr = 0; dr < rs; dr += 1) {
              for (let dc = 0; dc < cs; dc += 1) {
                if (grid[ri + dr]) grid[ri + dr][col + dc] = true;
              }
            }
            col += cs;
          });
        });
        const rowColCounts = grid.map((g) => Object.keys(g).length);

        const group = Array.from(t.querySelectorAll('td,th'))
          .find((c) => norm(c.textContent) === '分组');
        // 逐个 th 记文本：拍平表首行是表头 th；续片的 th 只允许是
        // 分组格的续接克隆（th 原样保留），不允许再出现表头格
        const thTexts = Array.from(t.querySelectorAll('th')).map((c) => norm(c.textContent));
        pieces.push({
          sheetIndex: sheets.indexOf(sheet),
          hasThead: !!t.tHead,
          thTexts,
          rowCount: rows.length,
          rowColCounts,
          group: group ? {
            rowspan: group.getAttribute('rowspan') || '1',
            continuation: group.dataset.mpeRowspanContinuation === '1',
          } : null,
          text: norm(t.textContent),
          pieceTop: t.getBoundingClientRect().top,
          bodyTop: body.getBoundingClientRect().top,
          bodyHeight: body.getBoundingClientRect().height,
          overflow: sheet.dataset.fitState === 'overflow',
        });
      });

      const allText = Array.from(document.querySelectorAll('.mpe-sheet-body'))
        .map((b) => {
          // crossnote 打印模板偶发把注入脚本嵌进正文容器，分页器会把
          // 不可见的 <script> 当普通块搬进页体 —— 量文本时剥掉脚本/样式
          const clone = b.cloneNode(true);
          clone.querySelectorAll('script,style').forEach((x) => x.remove());
          return norm(clone.textContent);
        })
        .join(' ');

      const headerCells = ['甲列', '乙列'].map((label) => ({
        label,
        count: countIn(allText, label),
      }));
      const dataCells = [];
      for (let i = 1; i <= rowsTotal; i += 1) {
        const nn = String(i).padStart(2, '0');
        ['格甲', '格中', '格乙'].forEach((pre) => {
          const token = pre + nn;
          dataCells.push({ token, count: countIn(allText, token) });
        });
      }

      return {
        sheetCount: sheets.length,
        hasFrontBlock: countIn(allText, '前置占位内容') > 0,
        pieces,
        headerCells,
        dataCells,
        groupCount: countIn(allText, '分组'),
        overflowSheets: sheets.filter((s) => s.dataset.fitState === 'overflow').length,
        colsTotal,
      };
    }, { rowsTotal: ROWS_TOTAL, colsTotal: COLS_TOTAL });
  } finally {
    await browser.close();
  }

  const pieces = geo.pieces;
  const pieceSheets = new Set(pieces.map((p) => p.sheetIndex));

  // ---------- 3. 断言：跨页 + 从剩余空间开始 ----------
  expect(geo.sheetCount >= 2, '文档应至少 2 页', geo.sheetCount);
  expect(geo.hasFrontBlock, '前置内容不应丢失', geo.hasFrontBlock);
  expect(pieces.length >= 2, '拍平表应跨页拆成 ≥2 片（≥2 页）', pieces.length);
  expect(pieceSheets.size >= 2, '表格应落在 ≥2 个页框上', [...pieceSheets]);
  expect(
    pieces[0].sheetIndex === 0 && geo.hasFrontBlock,
    '表格应从前置内容所在页（第 1 页）开始',
    pieces[0].sheetIndex,
  );
  expect(
    pieces[0].pieceTop - pieces[0].bodyTop > pieces[0].bodyHeight * 0.5,
    '表应从当前页剩余空间（下半页）开始落行',
    { offset: pieces[0].pieceTop - pieces[0].bodyTop, bodyHeight: pieces[0].bodyHeight },
  );

  // ---------- 4. 断言：拍平 + 续页不重复表头（README 原句） ----------
  expect(
    pieces.every((p) => !p.hasThead),
    '拍平表所有片都不应有 thead',
    pieces.map((p) => p.hasThead),
  );
  expect(
    pieces[0].thTexts.join(',') === '分组,甲列,乙列',
    '首片首行应是表头 3 th（分组 rowspan / 甲列 colspan=2 / 乙列）',
    pieces[0].thTexts,
  );
  expect(
    pieces.slice(1).every((p) => p.thTexts.every((t) => t === '分组')),
    '续页不应重复表头（th 只允许分组格的续接克隆，无甲列/乙列）',
    pieces.slice(1).map((p) => p.thTexts),
  );
  expect(
    geo.headerCells.every((c) => c.count === 1),
    '表头文本（甲列/乙列）应全文恰好出现一次（不随续页重复）',
    geo.headerCells,
  );

  // ---------- 5. 断言：内容零丢失 + 分组单元格照常续接 ----------
  const lost = geo.dataCells.filter((c) => c.count !== 1);
  expect(lost.length === 0, '每个数据单元格应恰好出现一次', lost);
  expect(geo.groupCount === pieces.length, '分组格应每片恰好一份（复制到续页续接）', {
    groupCount: geo.groupCount,
    pieces: pieces.length,
  });
  expect(
    pieces[0].group && !pieces[0].group.continuation,
    '首片分组格不应带续接标记',
    pieces[0].group,
  );
  expect(
    pieces.slice(1).every((p) => p.group && p.group.continuation),
    '续片分组格应带 data-mpe-rowspan-continuation（照常续接）',
    pieces.slice(1).map((p) => p.group),
  );
  const rowspanSum = pieces.reduce((s, p) => s + parseInt(p.group.rowspan, 10), 0);
  expect(
    rowspanSum === ROWS_TOTAL + 1,
    '各片分组格 rowspan 之和应等于原表总行数（裁短但总量守恒）',
    { rowspanSum, total: ROWS_TOTAL + 1 },
  );
  expect(
    pieces[0].rowCount > 1 && pieces[0].rowCount < ROWS_TOTAL + 1,
    '首片应放下若干行而非整表（流式拆分）',
    pieces[0].rowCount,
  );

  // ---------- 6. 断言：续表不缺列、不错位 + 无溢出 ----------
  const badRows = [];
  pieces.forEach((p, pi) => {
    p.rowColCounts.forEach((n, ri) => {
      if (n !== geo.colsTotal) badRows.push({ piece: pi, row: ri, cols: n });
    });
  });
  expect(badRows.length === 0, '每个表格片每行都应铺满 4 列（不缺列、不错位）', badRows);
  expect(geo.overflowSheets === 0, '分页后不应有溢出页框', geo.overflowSheets);

  console.log(`pagination-merge-cells: 完成 ${pass} 项断言通过`
    + `（${pieces.length} 个表格片 / ${geo.sheetCount} 页，rowspan 和 = ${rowspanSum}）`);
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
