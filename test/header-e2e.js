/**
 * --header 运行页眉 真实 Chrome 渲染 e2e（PDF 管线端到端）：
 *
 * README 原句（spec）：
 *   「--header（或 front-matter `header: true`）：在分页之上叠加运行页眉
 *    （蕴含分页，页脚的镜像）：每页顶部左侧文档标题、右侧当前章节路径
 *    （当前节点橙色高亮，含公式），底部 1px 细分隔线、9px 灰字，与页脚
 *    同一字体家族。与 --footer 同开时正文区上下各预留 ≥14mm（预设边距
 *    更大时保持预设值），互不遮挡。封面页无页眉；目录页页眉右侧显示
 *    「目录」。」
 *   「页眉与之镜像（距纸顶 6mm，上边距不足 14mm 时正文区下移让位）」
 *
 * 覆盖点：
 *  1. 分页蕴含：PDF 导出走 sheet 分页（多页 .mpe-sheet），每页顶部有页眉；
 *  2. 几何：页眉距纸顶 6mm（±1.5px）、左右对齐页边距带、底线 1px、9px 灰字；
 *  3. 左侧 = 文档标题（front-matter title / 首个 h1）；
 *  4. 右侧 = 当前页所属章节路径：末段（当前章节）橙色高亮 strong
 *     （#FB8B05 → rgb(251,139,5)）；跨页无标题的续页章节路径照常延续；
 *  5. 页眉与正文无重叠（页眉盒底 < 正文盒顶）；header 单开时正文上缘让位
 *     14mm（max(预设 10mm, 14mm) 生效）、下缘保持预设 10mm；
 *  6. --footer 同开：两者都在、互不重叠，正文上下各让位 14mm，
 *     页脚距纸底 6mm，页码 第 N/M 页 正确；
 *  7. 封面页无页眉无页脚；目录页页眉右侧显示「目录」；
 *  8. front-matter `header: true` 与 CLI --header 两条开关路径都生效；
 *  9. 目录页不写进章节路径 carry-over：目录页后的无标题正文页，页眉右侧
 *     恢复为文档标题去头后的状态（不含「目录」），页脚面包屑恢复为文档标题。
 *
 * 量测方式：exportMarkdown 真实 PDF 导出 + MPE_KEEP_TMP_HTML 保留打印 HTML，
 * Chrome 重放分页 DOM 做几何量测（与现有分页测试同款 harness）。
 * 用法: node test/header-e2e.js
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

const MM = 96 / 25.4; // CSS 参考像素：1mm
const TOP_6MM = 6 * MM;       // 页眉距纸顶
const MARGIN_1CM = 10 * MM;   // 默认页边距
const RESERVE_14MM = 14 * MM; // 页眉/页脚让位下限
const ACCENT = 'rgb(251, 139, 5)'; // scan 风格高亮 #FB8B05
const TOL = 1.5; // px，几何断言容差
const DOC_TITLE = '页眉几何测试';
const SEC1 = '第一章 长章节';
const SEC2 = '第二章 短章节';

/** 跑一次真实 PDF 导出并截获打印 HTML 路径（MPE_KEEP_TMP_HTML + stderr 拦截） */
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
    const m = chunks.join('').match(/调试打印 HTML: (.+)/);
    if (!m) throw new Error(`日志里没有打印 HTML 路径: ${chunks.join('').slice(-400)}`);
    return { result, printHtml: m[1].trim() };
  } finally {
    process.stderr.write = origWrite;
    delete process.env.MPE_KEEP_TMP_HTML;
  }
}

/** 文档主体：h1 文档标题 + 两个 h2 章节；800px 占位块把章节摊到多页，
 *  保证第一章存在无标题的续页（章节路径延续场景） */
function bodyMarkdown() {
  return [
    `# ${DOC_TITLE}`,
    '',
    `## ${SEC1}`,
    '',
    '<div style="height:800px">第一章内容块一</div>',
    '',
    '<div style="height:800px">第一章内容块二</div>',
    '',
    '<div style="height:800px">第一章内容块三</div>',
    '',
    '<div style="height:800px">第一章内容块四</div>',
    '',
    '第一章收尾段落。',
    '',
    `## ${SEC2}`,
    '',
    '第二章正文段落。',
    '',
  ].join('\n');
}

/** Chrome 重放打印 HTML，逐页量几何与文本 */
async function measureSheets(browser, printHtml, timeoutMs) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 900 });
    // 分页量测与最终打印同一媒体环境（导出流程 emulateMediaType('print')）
    await page.emulateMediaType('print');
    await page.goto(url.pathToFileURL(printHtml).href, { waitUntil: 'load' });
    await page.waitForFunction(
      () => document.documentElement.dataset.mpeFooter === 'true',
      { timeout: timeoutMs },
    );
    return page.evaluate(() => {
      const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
      return Array.from(document.querySelectorAll('.mpe-sheet')).map((sheet) => {
        const s = sheet.getBoundingClientRect();
        const body = sheet.querySelector('.mpe-sheet-body');
        const b = body.getBoundingClientRect();
        const header = sheet.querySelector('.mpe-sheet-header');
        const footer = sheet.querySelector('.mpe-sheet-footer');
        const hd = header ? header.getBoundingClientRect() : null;
        const ft = footer ? footer.getBoundingClientRect() : null;
        const hSection = header && header.querySelector('.mpe-header-section');
        const strong = hSection && hSection.querySelector('strong');
        const label = footer && footer.querySelector('.mpe-page-label');
        return {
          cover: sheet.dataset.mpeCover === '1',
          toc: sheet.dataset.mpeToc === '1',
          overflow: sheet.dataset.fitState === 'overflow',
          headings: Array.from(sheet.querySelectorAll('h1, h2')).map((h) => norm(h.textContent)),
          body: {
            top: b.top - s.top,
            bottomGap: s.bottom - b.bottom,
            height: b.height,
            topGap: b.top - s.top,
          },
          header: header ? {
            topGap: hd.top - s.top,
            bottomGapInSheet: s.bottom - hd.bottom,
            leftGap: hd.left - s.left,
            bottom: hd.bottom - s.top,
            height: hd.height,
            title: norm(header.querySelector('.mpe-header-title').textContent),
            sectionText: norm(hSection.textContent),
            strongText: strong ? norm(strong.textContent) : null,
            strongColor: strong ? getComputedStyle(strong).color : null,
            strongIsLastChild: strong ? hSection.lastElementChild === strong : false,
            fontSize: getComputedStyle(header).fontSize,
            borderBottomWidth: getComputedStyle(header).borderBottomWidth,
          } : null,
          footer: footer ? {
            bottomGap: s.bottom - ft.bottom,
            top: ft.top - s.top,
            breadcrumb: norm(footer.querySelector('.mpe-breadcrumb').textContent),
            pageLabel: norm(label ? label.textContent : ''),
          } : null,
        };
      });
    });
  } finally {
    await page.close();
  }
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-header-e2e-'));
  fs.writeFileSync(path.join(tmp, 'cover.html'), [
    '<!doctype html><html><body style="margin:0">',
    '<div style="width:100vw;height:100vh;background:#223047;color:#fff;',
    'display:flex;align-items:center;justify-content:center;font-size:48px">封面</div>',
    '</body></html>',
  ].join(''), 'utf8');

  const mainMd = path.join(tmp, 'header-main.md');
  fs.writeFileSync(mainMd, [
    '---',
    `title: ${DOC_TITLE}`,
    '---',
    '',
    bodyMarkdown(),
  ].join('\n'), 'utf8');

  // front-matter 开关路径：header: true 写在 front-matter（CLI 只给 footer/toc/cover）
  const fmHeaderMd = path.join(tmp, 'header-fm.md');
  fs.writeFileSync(fmHeaderMd, [
    '---',
    `title: ${DOC_TITLE}`,
    'header: true',
    '---',
    '',
    bodyMarkdown(),
  ].join('\n'), 'utf8');

  // 目录 carry-over 变体：目录页之后先排两页无标题正文（800px 块），首个
  // 标题（文档 h1）出现在其后 —— 复现「目录残留」缺陷的页面序列
  const tocCarryMd = path.join(tmp, 'header-toc-carry.md');
  fs.writeFileSync(tocCarryMd, [
    '---',
    `title: ${DOC_TITLE}`,
    'header: true',
    '---',
    '',
    '<div style="height:800px">目录后无标题内容块一</div>',
    '',
    '<div style="height:800px">目录后无标题内容块二</div>',
    '',
    `# ${DOC_TITLE}`,
    '',
    `## ${SEC1}`,
    '',
    '<div style="height:800px">第一章内容块</div>',
    '',
    `## ${SEC2}`,
    '',
    '第二章正文段落。',
    '',
  ].join('\n'), 'utf8');

  const browser = await puppeteer.launch({ executablePath: detectChrome(), headless: true });
  try {
    // ============ 场景 1：仅 --header（CLI 路径），无页脚 ============
    {
      const { result, printHtml } = await exportPdfAndCapturePrintHtml({
        file: mainMd,
        format: 'pdf',
        outDir: tmp,
        header: true,
      });
      const pdfFile = result.outputs.pdf;
      expect(!!pdfFile && fs.existsSync(pdfFile), 'PDF 产物应存在', result.outputs);
      const sheets = await measureSheets(browser, printHtml, 60000);
      expect(sheets.length >= 3, '蕴含分页：应有多页 sheet', sheets.length);

      // 期望章节路径：第一章页起全部是 第一章；第二章标题页起全部是 第二章
      let seenSec2 = false;
      const expectedSection = sheets.map((sh) => {
        if (sh.headings.includes(SEC2)) seenSec2 = true;
        return seenSec2 ? SEC2 : SEC1;
      });
      expect(
        new Set(expectedSection).size === 2,
        '文档应同时覆盖两个章节的页面（长章节摊页设计）',
        { expectedSection, sheets: sheets.length },
      );
      const hasHeadingFreePage = sheets.some(
        (sh, i) => i > 0 && !sh.headings.includes(SEC1) && !sh.headings.includes(SEC2),
      );
      expect(hasHeadingFreePage, '应存在无标题续页（章节路径延续场景）', sheets.map((s) => s.headings));

      sheets.forEach((sh, i) => {
        expect(!sh.cover && !sh.toc, `第 ${i + 1} 页不应是封面/目录`, sh);
        expect(!!sh.header, `第 ${i + 1} 页应有页眉`, !!sh.header);
        expect(!sh.footer, `仅 --header 时第 ${i + 1} 页不应有页脚`, sh.footer && sh.footer.pageLabel);
        const h = sh.header;
        expect(
          Math.abs(h.topGap - TOP_6MM) <= TOL,
          `第 ${i + 1} 页页眉应距纸顶 6mm`,
          { topGap: h.topGap, want: TOP_6MM },
        );
        expect(
          Math.abs(h.leftGap - MARGIN_1CM) <= TOL,
          `第 ${i + 1} 页页眉应对齐左页边距带`,
          { leftGap: h.leftGap, want: MARGIN_1CM },
        );
        expect(h.fontSize === '9px', `第 ${i + 1} 页页眉应为 9px 灰字`, h.fontSize);
        expect(
          h.borderBottomWidth === '1px',
          `第 ${i + 1} 页页眉底部应为 1px 细分隔线`,
          h.borderBottomWidth,
        );
        expect(h.title === DOC_TITLE, `第 ${i + 1} 页页眉左侧应为文档标题`, h.title);
        expect(
          h.sectionText === expectedSection[i],
          `第 ${i + 1} 页页眉右侧应为当前章节路径`,
          { actual: h.sectionText, want: expectedSection[i] },
        );
        expect(
          h.strongText === expectedSection[i] && h.strongIsLastChild,
          `第 ${i + 1} 页末段（当前章节）应是最末的 strong 高亮`,
          { strongText: h.strongText, strongIsLastChild: h.strongIsLastChild },
        );
        expect(
          h.strongColor === ACCENT,
          `第 ${i + 1} 页当前章节应橙色高亮（#FB8B05）`,
          h.strongColor,
        );
        // 让位：正文上缘 = max(预设 10mm, 14mm) = 14mm；下缘保持预设 10mm
        expect(
          Math.abs(sh.body.top - RESERVE_14MM) <= TOL,
          `第 ${i + 1} 页正文上缘应让位 14mm`,
          { bodyTop: sh.body.top, want: RESERVE_14MM },
        );
        expect(
          Math.abs(sh.body.bottomGap - MARGIN_1CM) <= TOL,
          `第 ${i + 1} 页正文下缘应保持预设 10mm（页眉不挤占正文区）`,
          { bodyBottomGap: sh.body.bottomGap, want: MARGIN_1CM },
        );
        // 互不遮挡：页眉盒底 < 正文盒顶
        expect(
          h.bottom <= sh.body.top + 1,
          `第 ${i + 1} 页页眉与正文不应重叠`,
          { headerBottom: h.bottom, bodyTop: sh.body.top },
        );
        expect(!sh.overflow, `第 ${i + 1} 页不应溢出`, sh.overflow);
      });
    }

    // ============ 场景 2：--header --footer 同开 ============
    {
      const { printHtml } = await exportPdfAndCapturePrintHtml({
        file: mainMd,
        format: 'pdf',
        outDir: tmp,
        header: true,
        footer: true,
      });
      const sheets = await measureSheets(browser, printHtml, 60000);
      expect(sheets.length >= 3, '同开场景应有多页 sheet', sheets.length);
      const total = sheets.length;

      let seenSec2 = false;
      sheets.forEach((sh, i) => {
        const n = i + 1;
        if (sh.headings.includes(SEC2)) seenSec2 = true;
        const section = seenSec2 ? SEC2 : SEC1;
        expect(!!sh.header && !!sh.footer, `第 ${n} 页页眉页脚应都在`, {
          header: !!sh.header,
          footer: !!sh.footer,
        });
        // 正文上下各预留 ≥14mm（预设 10mm 不足 → max() 取 14mm）
        expect(
          Math.abs(sh.body.top - RESERVE_14MM) <= TOL,
          `第 ${n} 页正文上缘应让位 ≥14mm（max(10mm,14mm)=14mm 生效）`,
          { bodyTop: sh.body.top, want: RESERVE_14MM },
        );
        expect(
          Math.abs(sh.body.bottomGap - RESERVE_14MM) <= TOL,
          `第 ${n} 页正文下缘应让位 ≥14mm（页脚镜像让位）`,
          { bodyBottomGap: sh.body.bottomGap, want: RESERVE_14MM },
        );
        expect(
          sh.header.topGap <= sh.body.top - sh.header.height + TOL,
          `第 ${n} 页页眉盒应在正文上方且不重叠`,
          { headerTop: sh.header.topGap, headerHeight: sh.header.height, bodyTop: sh.body.top },
        );
        expect(
          sh.header.bottom <= sh.body.top + 1,
          `第 ${n} 页页眉与正文不应重叠`,
          { headerBottom: sh.header.bottom, bodyTop: sh.body.top },
        );
        expect(
          sh.body.top + sh.body.height <= sh.footer.top + 1,
          `第 ${n} 页正文与页脚不应重叠`,
          { bodyBottom: sh.body.top + sh.body.height, footerTop: sh.footer.top },
        );
        expect(
          Math.abs(sh.footer.bottomGap - TOP_6MM) <= TOL,
          `第 ${n} 页页脚应距纸底 6mm（与页眉镜像）`,
          { footerBottomGap: sh.footer.bottomGap, want: TOP_6MM },
        );
        expect(sh.header.title === DOC_TITLE, `第 ${n} 页页眉左侧应为文档标题`, sh.header.title);
        expect(
          sh.header.sectionText === section,
          `第 ${n} 页页眉右侧应为当前章节`,
          { actual: sh.header.sectionText, want: section },
        );
        expect(
          sh.header.strongColor === ACCENT,
          `第 ${n} 页页眉当前章节应橙色高亮`,
          sh.header.strongColor,
        );
        // 页脚：完整面包屑（含文档标题，不去头）+ 第 N/M 页
        expect(
          sh.footer.breadcrumb.includes(DOC_TITLE) && sh.footer.breadcrumb.includes(section),
          `第 ${n} 页页脚面包屑应为 文档标题 > 章节`,
          sh.footer.breadcrumb,
        );
        expect(
          sh.footer.pageLabel === `第 ${n}/${total} 页`,
          `第 ${n} 页页码应为 第 ${n}/${total} 页`,
          sh.footer.pageLabel,
        );
      });
    }

    // ============ 场景 3：front-matter header: true + 封面 + 目录 + 页脚 ============
    {
      const { printHtml } = await exportPdfAndCapturePrintHtml({
        file: fmHeaderMd,
        format: 'pdf',
        outDir: tmp,
        footer: true,
        toc: true,
        cover: 'cover.html',
      });
      const sheets = await measureSheets(browser, printHtml, 120000);
      expect(sheets.length >= 5, '封面 + 目录 + 多页正文', sheets.length);
      expect(sheets[0].cover, '第 1 页应是封面', sheets[0]);
      expect(sheets[1].toc, '第 2 页应是目录', sheets[1]);

      // 封面页：无页眉、无页脚
      expect(!sheets[0].header, '封面页应无页眉', sheets[0].header);
      expect(!sheets[0].footer, '封面页应无页脚', sheets[0].footer && sheets[0].footer.pageLabel);

      // 目录页：页眉右侧显示「目录」
      const tocHeader = sheets[1].header;
      expect(!!tocHeader, '目录页应有页眉', !!tocHeader);
      expect(tocHeader.title === DOC_TITLE, '目录页页眉左侧应为文档标题', tocHeader.title);
      expect(tocHeader.sectionText === '目录', '目录页页眉右侧应显示「目录」', tocHeader.sectionText);
      expect(
        tocHeader.strongText === '目录' && tocHeader.strongColor === ACCENT,
        '目录页「目录」应橙色高亮',
        { strongText: tocHeader.strongText, strongColor: tocHeader.strongColor },
      );
      expect(
        Math.abs(tocHeader.topGap - TOP_6MM) <= TOL,
        '目录页页眉应距纸顶 6mm',
        { topGap: tocHeader.topGap, want: TOP_6MM },
      );
      expect(
        Math.abs(sheets[1].footer.bottomGap - TOP_6MM) <= TOL,
        '目录页页脚应距纸底 6mm',
        sheets[1].footer && sheets[1].footer.bottomGap,
      );

      // 正文页：front-matter 开关真实生效，页眉几何与章节路径照常
      const bodySheets = sheets.slice(2);
      let seenSec2 = false;
      bodySheets.forEach((sh, i) => {
        const n = i + 3;
        if (sh.headings.includes(SEC2)) seenSec2 = true;
        const section = seenSec2 ? SEC2 : SEC1;
        expect(!!sh.header && !sh.cover, `正文第 ${n} 页应有页眉`, !!sh.header);
        expect(
          Math.abs(sh.header.topGap - TOP_6MM) <= TOL,
          `正文第 ${n} 页页眉应距纸顶 6mm`,
          sh.header.topGap,
        );
        expect(sh.header.title === DOC_TITLE, `正文第 ${n} 页页眉左侧应为文档标题`, sh.header.title);
        expect(
          sh.header.sectionText === section,
          `正文第 ${n} 页页眉右侧应为当前章节`,
          { actual: sh.header.sectionText, want: section },
        );
      });
      // 封面计入总页数（页码从封面数起）
      expect(
        sheets[sheets.length - 1].footer.pageLabel === `第 ${sheets.length}/${sheets.length} 页`,
        '末页页码应计入封面与目录页',
        sheets[sheets.length - 1].footer.pageLabel,
      );
    }

    // ============ 场景 4：目录页后的无标题正文页不残留「目录」 ============
    // 目录页不写进章节路径 carry-over：目录页页眉右侧/页脚面包屑照常显示
    // 「目录」，出目录即恢复进目录前的路径 —— 目录之后、首个标题之前的
    // 无标题正文页：页眉右侧 = 文档标题去头后的空串，页脚面包屑 = 文档标题。
    {
      const { printHtml } = await exportPdfAndCapturePrintHtml({
        file: tocCarryMd,
        format: 'pdf',
        outDir: tmp,
        header: true,
        footer: true,
        toc: true,
        cover: 'cover.html',
      });
      const sheets = await measureSheets(browser, printHtml, 120000);
      expect(sheets[0].cover, '第 1 页应是封面', sheets[0].cover);
      expect(sheets[1].toc, '第 2 页应是目录', sheets[1].toc);

      // 目录页自身照常显示「目录」：页眉右侧 + 页脚面包屑
      expect(!!sheets[1].header, '目录页应有页眉', !!sheets[1].header);
      expect(
        sheets[1].header.sectionText === '目录',
        '目录页页眉右侧应显示「目录」',
        sheets[1].header.sectionText,
      );
      expect(
        sheets[1].footer.breadcrumb.includes('目录'),
        '目录页页脚面包屑应显示「目录」',
        sheets[1].footer.breadcrumb,
      );

      // 目录之后、首个标题之前的无标题正文页（本变体前两页正文只有 800px 块）
      const bodySheets = sheets.slice(2);
      const headingFreeRun = [];
      for (const sh of bodySheets) {
        if (sh.headings.length > 0) break;
        headingFreeRun.push(sh);
      }
      expect(
        headingFreeRun.length >= 1,
        '变体应存在目录后的无标题正文页（页面序列设计）',
        bodySheets.map((s) => s.headings),
      );
      headingFreeRun.forEach((sh, i) => {
        expect(
          sh.header.sectionText === '',
          `无标题正文第 ${i + 1} 页页眉右侧应恢复为文档标题去头后的空串，不得残留「目录」`,
          sh.header.sectionText,
        );
        expect(
          sh.footer.breadcrumb === DOC_TITLE,
          `无标题正文第 ${i + 1} 页页脚面包屑应恢复为文档标题，不得残留「目录」`,
          sh.footer.breadcrumb,
        );
      });

      // 恢复后的标题页照常生效：页眉去文档标题头，页脚保留完整面包屑
      const firstHeadingSheet = bodySheets[headingFreeRun.length];
      expect(
        !!firstHeadingSheet && firstHeadingSheet.headings.includes(SEC1),
        '无标题段之后应有第一章标题页',
        bodySheets.map((s) => s.headings),
      );
      expect(
        firstHeadingSheet.header.sectionText === SEC1,
        '第一章标题页页眉右侧应为第一章（文档标题去头）',
        firstHeadingSheet.header.sectionText,
      );
      expect(
        firstHeadingSheet.footer.breadcrumb.includes(DOC_TITLE) &&
          firstHeadingSheet.footer.breadcrumb.includes(SEC1),
        '第一章标题页页脚面包屑应为 文档标题 > 第一章',
        firstHeadingSheet.footer.breadcrumb,
      );
    }
  } finally {
    await browser.close();
  }

  console.log(
    `header-e2e: 完成 ${pass} 项断言通过（--header / --header+--footer / 封面+目录 / 目录后无标题正文 四场景）`,
  );
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
