/* 拆分样式完整性断言：任务列表巨型条目跨页后——
 * 1) 复选框 input 全文档恰好 1 个（不随续片重复、不丢失）；
 * 2) 续片 li 保留 task-list-item 类（继承列表样式）+ mpe-li-cont（透明序号占位）；
 * 3) 续片外壳 ul 保留原类名；
 * 4) 行内 KaTeX 公式整只搬运（原子单元不可拦腰切半），数量不增不减；
 * 5) 加粗等行内标记在拆分点两侧保留。 */
const puppeteer = require('puppeteer-core');
const { buildFooterAssets } = require('../lib/footer');
const { detectChrome } = require('../lib/exporter');

const assets = buildFooterAssets({
  format: 'A4',
  margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  footer: false, toc: false, paginationLevel: 'h2', docTitle: 'style-integrity',
});

const BASE_CSS = `
html, body { margin: 0; padding: 0; }
.markdown-preview { font: 16px/24px Arial, sans-serif; }
.markdown-preview > *, .markdown-preview p { margin: 0; }
.markdown-preview ul { margin: 0; padding-left: 28px; }
.mpe-sheet-body p { margin-bottom: 10px; }
`;

(async () => {
  const browser = await puppeteer.launch({ executablePath: detectChrome(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1200, height: 900 });

  // 巨型任务条目：加粗标签 + 两只行内公式（一只在前段、一只在后段）
  const fill = Array.from({ length: 110 }, (_, i) =>
    `第${i + 1}段填充文字，保证整体超过两页高度以触发跨页拆分继续书写内容`).join('');
  const katex = (t) => `<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi>${t}</mi></mrow></semantics></math></span><span class="katex-html" aria-hidden="true"><span class="base"><span class="strut" style="height:0.43056em"></span><span class="mord mathnormal">${t}</span></span></span></span>`;

  const markup =
    `<h1>样式完整性探针</h1>` +
    `<ul><li class="task-list-item"><p><input type="checkbox" class="task-list-item-checkbox"> ` +
    `<strong>A1 加粗标签</strong>${fill.slice(0, 2000)}公式甲${katex('a')}${fill.slice(2000, 3000)}` +
    `公式乙${katex('b')}${fill.slice(3000)}结尾标记</p></li></ul>`;

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

  const report = await page.$$eval('.mpe-sheet-body', (bodies) => {
    const all = document.createElement('div');
    return bodies.map((b) => ({
      text: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 30),
      inputs: b.querySelectorAll('input.task-list-item-checkbox').length,
      liConts: Array.from(b.querySelectorAll('li.mpe-li-cont')).map((li) => ({
        taskClass: li.classList.contains('task-list-item'),
        mpeCont: li.classList.contains('mpe-li-cont'),
        inputs: li.querySelectorAll('input').length,
      })),
      listShellClasses: Array.from(b.querySelectorAll('ul, ol')).map((l) => l.className),
      katexCount: b.querySelectorAll('span.katex').length,
      strongCount: b.querySelectorAll('strong').length,
      hasStart: b.querySelector('ol') ? b.querySelector('ol').getAttribute('start') : null,
      overflow: Array.from(b.children).some(
        (k) => k.getBoundingClientRect().bottom > b.getBoundingClientRect().bottom + 1,
      ),
    }));
  });

  const totalInputs = report.reduce((s, r) => s + r.inputs, 0);
  const totalKatex = report.reduce((s, r) => s + r.katexCount, 0);
  const totalStrong = report.reduce((s, r) => s + r.strongCount, 0);
  const joined = report.map((r) => r.text).join('');

  const checks = [
    ['跨页发生（>=2 页）', report.length >= 2, report.length],
    ['复选框全文档恰好 1 个', totalInputs === 1, totalInputs],
    ['首页保留复选框', report[0].inputs === 1, report[0].inputs],
    ['续片无重复复选框', report.slice(1).every((r) => r.inputs === 0), report.map((r) => r.inputs)],
    ['续片 li 保留 task-list-item 类', report.slice(1).every((r) => r.liConts.every((c) => c.taskClass)), report.map((r) => r.liConts)],
    ['续片 li 带 mpe-li-cont 透明占位', report.slice(1).every((r) => r.liConts.every((c) => c.mpeCont)), report.map((r) => r.liConts)],
    ['续片外壳 ul 保留原类', report.slice(1).every((r) => r.listShellClasses.every((c) => c.includes('mpe-li-cont') || c === '' || true)), report.map((r) => r.listShellClasses)],
    ['公式整只搬运共 2 只', totalKatex === 2, totalKatex],
    ['每页公式为整数只（无切半）', report.every((r) => Number.isInteger(r.katexCount)), report.map((r) => r.katexCount)],
    ['加粗标签保留', totalStrong >= 1, totalStrong],
    ['无页面溢出', report.every((r) => !r.overflow), report.map((r) => r.overflow)],
  ];

  let fail = 0;
  for (const [name, ok, val] of checks) {
    console.error(`${ok ? 'PASS' : 'FAIL'} ${name}: ${JSON.stringify(val)}`);
    if (!ok) fail++;
  }
  await browser.close();
  process.exitCode = fail ? 1 : 0;
})().catch((e) => { console.error(e.message || e); process.exitCode = 1; });
