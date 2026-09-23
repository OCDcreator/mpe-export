const puppeteer = require('puppeteer-core');
const { buildFooterAssets } = require('../lib/footer');
const { detectChrome } = require('../lib/exporter');

const assets = buildFooterAssets({
  format: 'A4',
  margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  footer: false,
  toc: false,
  paginationLevel: null,
  docTitle: 'table pagination test',
});

// A4 ≈ 1122px，上下各 10mm ≈ 37.8px → 页体容量 ≈ 1047px
const BASE_CSS = `
html, body { margin: 0; padding: 0; }
.markdown-preview { font: 16px/24px Arial, sans-serif; }
.markdown-preview > *, .markdown-preview p, .markdown-preview h3 { margin: 0; }
.markdown-preview table { border-collapse: collapse; }
.markdown-preview td, .markdown-preview th { padding: 0; }
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
    { timeout: 10000 },
  );
  return page.$$eval('.mpe-sheet-body', (bodies) => bodies.map((body) => ({
    text: body.textContent.replace(/\s+/g, ' ').trim(),
    overflow: body.scrollHeight > body.clientHeight + 1,
    tables: body.querySelectorAll('table').length,
  })));
}

function expect(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

function rows(n, height, prefix) {
  return Array.from({ length: n }, (_, i) =>
    `<tr style="height:${height}px"><td>${prefix} ${i + 1} 行</td></tr>`,
  ).join('');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: detectChrome(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    // 核心场景：半页空白时表格应像文字一样流式填充，而不是整体跳到新页。
    // 600px 前置 + 840px 表格（ thead 40 + 20×40 ）：整表能放进一页（不触发
    // 超页预拆），但放不进剩余 ~447px → 应在本页放满前几行，余下流到下页。
    const flow = await paginate(page,
      '<div style="height:600px">前置内容</div>' +
      '<table><thead><tr style="height:40px"><th>表头列</th></tr></thead><tbody>' +
      rows(20, 40, '数据') +
      '</tbody></table>',
    );
    expect(flow.length >= 2, '表格应跨页拆分', flow);
    expect(flow[0].text.includes('前置内容'), '前页应保留原有内容', flow);
    expect(flow[0].text.includes('表头列'), '前页应含表格开头（表头）', flow);
    expect(flow[0].text.includes('数据 1 行'), '前页应填入表格前几行', flow);
    expect(!flow[0].text.includes('数据 20 行'), '放不下的行不应挤在前页', flow);
    expect(flow[1].text.includes('表头列'), '续页应重复表头，可独立阅读', flow);
    expect(flow[1].text.includes('数据 20 行'), '续页应接续剩余行', flow);
    expect(flow.every((s) => !s.overflow), '拆分后不应溢出页体', flow);
    const flowText = flow.map((s) => s.text).join(' ');
    for (let i = 1; i <= 20; i += 1) {
      expect(flowText.includes(`数据 ${i} 行`), `不应丢失第 ${i} 行`, flow);
    }

    // 整表能放进剩余空间时保持完整（不拆）
    const fitsWhole = await paginate(page,
      '<div style="height:600px">前置内容</div>' +
      '<table><thead><tr style="height:40px"><th>表头列</th></tr></thead><tbody>' +
      rows(5, 40, '小表') +
      '</tbody></table>',
    );
    expect(fitsWhole.length === 1, '剩余空间够时表格应整表留在本页', fitsWhole);
    expect(fitsWhole[0].text.includes('小表 5 行'), '整表应完整在本页', fitsWhole);

    // 剩余空间连一行都放不下时才整体移页（保持旧语义）
    const moveWhole = await paginate(page,
      '<div style="height:1010px">前置内容</div>' +
      '<table><thead><tr style="height:40px"><th>移页表头</th></tr></thead><tbody>' +
      rows(5, 40, '移页') +
      '</tbody></table>',
    );
    expect(!moveWhole[0].text.includes('移页表头'), '一行都放不下时表格应整体移页', moveWhole);
    expect(
      moveWhole[1].text.includes('移页表头') && moveWhole[1].text.includes('移页 5 行'),
      '整表应完整出现在下一页',
      moveWhole,
    );

    // rowspan 跨切点：续页复制分组单元格并裁短 rowspan，避免续表缺列。
    // 500px 前置 + 760px 表格（thead 40 + 3×240，rowspan=3）：整表不触发预拆，
    // 剩余 ~547px 放 thead+第一行（280px），第二行起流下页。
    const rowspan = await paginate(page,
      '<div style="height:500px">前置内容</div>' +
      '<table><thead><tr style="height:40px"><th>甲</th><th>乙</th></tr></thead><tbody>' +
      '<tr style="height:240px"><td rowspan="3">跨页分组</td><td>跨行数据 1</td></tr>' +
      '<tr style="height:240px"><td>跨行数据 2</td></tr>' +
      '<tr style="height:240px"><td>跨行数据 3</td></tr>' +
      '</tbody></table>',
    );
    expect(rowspan.length >= 2, '带 rowspan 的表格应跨页拆分', rowspan);
    expect(rowspan.every((s) => !s.overflow), 'rowspan 拆分后不应溢出页体', rowspan);
    const rowspanText = rowspan.map((s) => s.text).join(' ');
    for (let i = 1; i <= 3; i += 1) {
      expect(rowspanText.includes(`跨行数据 ${i}`), `不应丢失跨行数据 ${i}`, rowspan);
    }
    expect(
      rowspan.length >= 2 && rowspan[1].text.includes('跨页分组'),
      'rowspan 跨切点时续表应重复分组标签',
      rowspan,
    );

    // 标题 + 表格：表格拆分时标题应留在前页与首行同页，不被孤立或拖走
    const withHeading = await paginate(page,
      '<div style="height:500px">前置内容</div>' +
      '<h3>表格章节</h3>' +
      '<table><thead><tr style="height:40px"><th>表头列</th></tr></thead><tbody>' +
      rows(15, 40, '章节表') +
      '</tbody></table>',
    );
    expect(withHeading[0].text.includes('表格章节'), '表格拆分时标题应留在前页', withHeading);
    expect(withHeading[0].text.includes('章节表 1 行'), '标题应与表格首行同页', withHeading);
    expect(withHeading[1].text.includes('章节表 15 行'), '表格余行应流到下页', withHeading);
    expect(withHeading.every((s) => !s.overflow), '标题场景不应溢出页体', withHeading);

    // 回归：超页高表格逐页惰性拆分，全部行不丢、不溢出、续页重复表头。
    // 关键：每个页框内只允许一个表格片（表头只在页首重复，页中不留残片表头）
    const oversized = await paginate(page,
      '<table><thead><tr style="height:40px"><th>长表表头</th></tr></thead><tbody>' +
      rows(30, 80, '长表') +
      '</tbody></table>',
    );
    expect(oversized.length >= 3, '超页表格应拆到多页', oversized);
    expect(oversized.every((s) => !s.overflow), '超页表格所有分页都不应被裁切', oversized);
    expect(
      oversized.every((s) => s.text.includes('长表表头')),
      '超页表格每页续表都应重复表头',
      oversized,
    );
    expect(
      oversized.every((s) => s.tables === 1),
      '每个页框内应只有一个表格片（表头只在页首重复）',
      oversized,
    );
    const oversizedText = oversized.map((s) => s.text).join(' ');
    for (let i = 1; i <= 30; i += 1) {
      expect(oversizedText.includes(`长表 ${i} 行`), `超页表格不应丢失第 ${i} 行`, oversized);
    }
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
