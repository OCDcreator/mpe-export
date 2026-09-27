/* 巨型列表条目跨页回填回归：
 * 1) li 内单段文字远高于整页时，开头必须回填当前页剩余空间（不能整条移页留空白页）；
 * 2) 带尾随下边距的段落（Chrome 把末元素尾随 margin 计入 scrollHeight）不得造成
 *    "幻影溢出"回滚拆分——sheetOverflows 已改为按子块矩形盒底判定；
 * 3) 任务列表（checkbox 在 P 内）与多子块 li 同样回填。 */
const puppeteer = require('puppeteer-core');
const { buildFooterAssets } = require('../lib/footer');
const { detectChrome } = require('../lib/exporter');

const assets = buildFooterAssets({
  format: 'A4',
  margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  footer: false,
  toc: false,
  paginationLevel: 'h2',
  docTitle: 'giant li test',
});

const BASE_CSS = `
html, body { margin: 0; padding: 0; }
.markdown-preview { font: 16px/24px Arial, sans-serif; }
.markdown-preview > *, .markdown-preview p, .markdown-preview h3 { margin: 0; }
.markdown-preview ol, .markdown-preview ul { margin: 0; padding-left: 28px; }
/* 段落与列表壳带下边距：复现"尾随 margin 计入 scrollHeight 造成幻影溢出"
   的场景（phycat/claude 预设的真实形态——margin 会从 li 内的 p 折叠穿透到
   ul 壳外，末元素自身 margin-bottom:0 也拦不住） */
.mpe-sheet-body p, .markdown-preview p { margin-bottom: 10px; }
.mpe-sheet-body ul, .markdown-preview ul { margin-bottom: 10px; }
`;

async function paginate(page, markup) {
  await page.setContent(
    `<style>${BASE_CSS}${assets.css}</style>` +
      `<div class="markdown-preview">${markup}</div>` +
      `<script>${assets.js}</script>`,
    { waitUntil: 'load' },
  );
  await page.waitForFunction(
    () => document.documentElement.dataset.mpeFooter === 'true',
    { timeout: 15000 },
  );
  return page.$$eval('.mpe-sheet-body', (bodies) => bodies.map((body) => ({
    text: body.textContent.replace(/\s+/g, ' ').trim(),
    // 与引擎 sheetOverflows 同语义：按子块矩形盒底判溢出（尾随 margin 是
    // Chrome scrollHeight 的幻影，不构成可见溢出）
    overflow: Array.from(body.children).some(
      (k) => k.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 1,
    ),
  })));
}

function expect(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: detectChrome(), headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    // 巨型条目文本：约 2 倍页高。段与段连成一段（单 P 场景），每段足够长
    // 保证折行后总高 >2 页（120 段 × ~38 字 ≈ 90 行 × 24px ≈ 2160px）
    const giant = Array.from({ length: 120 }, (_, i) =>
      `第${i + 1}段这是用于把条目撑到超过整页高度的填充文字，每段都足够长以避免被合并成少数几行`).join('') +
      '结尾标记';

    const cases = [
      ['普通巨型单段 li', `<ol><li><p>${giant}</p></li></ol>`],
      ['任务列表巨型单段 li（checkbox 在 P 内）',
        `<ul><li class="task-list-item"><p><input type="checkbox" class="task-list-item-checkbox"> ${giant}</p></li></ul>`],
      ['巨型多子块 li',
        `<ol><li>${Array.from({ length: 80 }, (_, i) => `<p>第${i + 1}块内容</p>`).join('')}<p>结尾标记</p></li></ol>`],
    ];

    for (const [label, markup] of cases) {
      const sheets = await paginate(page, `<h1>前置标题</h1>${markup}`);
      expect(sheets.length >= 2, `${label} 应跨页`, sheets);
      expect(
        sheets[0].text.includes('第1') || sheets[0].text.includes('第 1'),
        `${label} 开头应回填第 1 页（前置标题之后），不得整条移页留空白`,
        sheets[0].text.slice(0, 40),
      );
      expect(
        sheets[0].text.includes('前置标题'),
        `${label} 前置标题应在第 1 页`,
        sheets[0].text.slice(0, 20),
      );
      expect(sheets.every((s) => !s.overflow), `${label} 所有页不应溢出`, sheets);
      const joined = sheets.map((s) => s.text).join('');
      expect(joined.includes('结尾标记'), `${label} 结尾标记不得丢失`, joined.slice(-40));
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
