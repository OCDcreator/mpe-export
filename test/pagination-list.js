const puppeteer = require('puppeteer-core');
const { buildFooterAssets } = require('../lib/footer');
const { detectChrome } = require('../lib/exporter');

const assets = buildFooterAssets({
  format: 'A4',
  margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' },
  footer: false,
  toc: false,
  paginationLevel: 'h2',
  docTitle: 'pagination test',
});

const BASE_CSS = `
html, body { margin: 0; padding: 0; }
.markdown-preview { font: 16px/24px Arial, sans-serif; }
.markdown-preview > *, .markdown-preview p, .markdown-preview h3 { margin: 0; }
.markdown-preview ol { margin: 0; padding-left: 28px; }
.nested > li { box-sizing: border-box; height: 36px; }
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
  })));
}

function expect(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: detectChrome(),
    headless: true,
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 900 });

    const split = await paginate(page,
      '<div style="height:900px">前置内容</div>' +
      '<ol><li><p>父级标题</p><ol class="nested">' +
      '<li>子项一</li><li>子项二</li><li>子项三</li>' +
      '<li>子项四</li><li>子项五</li><li>子项六</li>' +
      '</ol></li></ol>',
    );
    expect(split.length >= 2, '嵌套列表场景应跨页', split);
    expect(split[0].text.includes('父级标题'), '父级标题应留在有空间的前页', split);
    expect(split[0].text.includes('子项一'), '前页有空间时应继续填入第一条子项', split);
    expect(split.every((sheet) => !sheet.overflow), '列表拆分后不应溢出页体', split);

    const keepWithNext = await paginate(page,
      '<div style="height:1010px">前置内容</div>' +
      '<ol><li><p>页末父级标题</p><ol class="nested">' +
      '<li>第一页子项</li><li>第二页子项</li>' +
      '</ol></li></ol>',
    );
    expect(!keepWithNext[0].text.includes('页末父级标题'), '带不下首条子项时父级标题应一起移页', keepWithNext);
    expect(
      keepWithNext[1].text.includes('页末父级标题') && keepWithNext[1].text.includes('第一页子项'),
      '父级标题应与第一条子项同页',
      keepWithNext,
    );

    const paragraphText =
      '段落开头 ' + '普通文本逐行连续排版 '.repeat(14) + '段落结尾';
    const paragraphSplit = await paginate(page,
      '<div style="height:990px">前置内容</div>' +
      `<p>${paragraphText}</p>`,
    );
    expect(paragraphSplit.length >= 2, '多行段落场景应跨页', paragraphSplit);
    expect(paragraphSplit[0].text.includes('段落开头'), '前页应保留能容纳的段落开头行', paragraphSplit);
    expect(paragraphSplit[1].text.includes('段落结尾'), '后页应接续段落结尾', paragraphSplit);
    expect(paragraphSplit.every((sheet) => !sheet.overflow), '段落逐行拆分后不应溢出', paragraphSplit);

    const listLineText =
      '长列表项开头 ' + '列表文本逐行连续排版 '.repeat(14) + '长列表项结尾';
    const listLineSplit = await paginate(page,
      '<div style="height:990px">前置内容</div>' +
      `<ol><li><p>${listLineText}</p></li></ol>`,
    );
    expect(listLineSplit[0].text.includes('长列表项开头'), '列表项开头应填入前页剩余行', listLineSplit);
    expect(listLineSplit[1].text.includes('长列表项结尾'), '长列表项应在后页接续', listLineSplit);

    const atomic = await paginate(page,
      '<div style="height:900px">前置内容</div>' +
      '<blockquote style="height:180px">不可拆引用块</blockquote>',
    );
    expect(!atomic[0].text.includes('不可拆引用块'), '剩余空间不足时引用块应整体移页', atomic);
    expect(atomic[1].text.includes('不可拆引用块'), '引用块应完整出现在下一页', atomic);

    const atomicTitle = await paginate(page,
      '<div style="height:900px">前置内容</div>' +
      '<ol><li><p>表格标题</p>' +
      '<table style="height:180px"><tbody><tr><td>表格内容</td></tr></tbody></table>' +
      '</li></ol>',
    );
    expect(!atomicTitle[0].text.includes('表格标题'), '列表标题不能孤立在原子块前一页', atomicTitle);
    expect(
      atomicTitle[1].text.includes('表格标题') && atomicTitle[1].text.includes('表格内容'),
      '列表标题应与紧随的表格同页',
      atomicTitle,
    );

    const oversizedNestedTable = await paginate(page,
      '<ol><li><p>超长表格标题</p>' +
      '<table><tbody>' +
      Array.from({ length: 8 }, (_, i) =>
        `<tr style="height:180px"><td>跨页表格第 ${i + 1} 行</td></tr>`,
      ).join('') +
      '</tbody></table></li></ol>',
    );
    expect(oversizedNestedTable.length >= 2, '列表内超页表格应拆到多页', oversizedNestedTable);
    expect(
      oversizedNestedTable.every((sheet) => !sheet.overflow),
      '列表内超页表格的所有分页都不应被裁切',
      oversizedNestedTable,
    );
    const oversizedNestedTableText = oversizedNestedTable.map((sheet) => sheet.text).join(' ');
    for (let i = 1; i <= 8; i += 1) {
      expect(
        oversizedNestedTableText.includes(`跨页表格第 ${i} 行`),
        `列表内超页表格不应丢失第 ${i} 行`,
        oversizedNestedTable,
      );
    }

    const rowspanNestedTable = await paginate(page,
      '<ol><li><p>跨行长表格标题</p><table><tbody>' +
      '<tr style="height:80px"><td>表头甲</td><td>表头乙</td></tr>' +
      '<tr style="height:360px"><td rowspan="3">跨页分组</td><td>跨行数据 1</td></tr>' +
      '<tr style="height:360px"><td>跨行数据 2</td></tr>' +
      '<tr style="height:360px"><td>跨行数据 3</td></tr>' +
      '</tbody></table></li></ol>',
    );
    expect(rowspanNestedTable.length >= 2, '带 rowspan 的列表内长表格应拆到多页', rowspanNestedTable);
    expect(
      rowspanNestedTable.every((sheet) => !sheet.overflow),
      '带 rowspan 的续表不应溢出页体',
      rowspanNestedTable,
    );
    const rowspanText = rowspanNestedTable.map((sheet) => sheet.text).join(' ');
    for (let i = 1; i <= 3; i += 1) {
      expect(rowspanText.includes(`跨行数据 ${i}`), `rowspan 续表不应丢失数据 ${i}`, rowspanNestedTable);
    }
    expect(
      (rowspanText.match(/跨页分组/g) || []).length >= 2,
      '跨页 rowspan 分组标签应在续表重复，避免续页缺列',
      rowspanNestedTable,
    );

    const nestedAtomicTitle = await paginate(page,
      '<div style="height:860px">前置内容</div>' +
      '<ol><li><p>普通父级行</p><p>紧邻表格标题</p>' +
      '<table style="height:180px"><tbody><tr><td>嵌套表格内容</td></tr></tbody></table>' +
      '</li></ol>',
    );
    expect(nestedAtomicTitle[0].text.includes('普通父级行'), '普通父级行应继续留在前页', nestedAtomicTitle);
    expect(!nestedAtomicTitle[0].text.includes('紧邻表格标题'), '紧邻原子块的标题不应孤立在前页', nestedAtomicTitle);
    expect(
      nestedAtomicTitle[1].text.includes('紧邻表格标题') && nestedAtomicTitle[1].text.includes('嵌套表格内容'),
      '紧邻标题应与原子块一起移页',
      nestedAtomicTitle,
    );

    const orphanHeading = await paginate(page,
      '<div style="height:1000px">前置内容</div>' +
      '<h3>孤儿标题</h3><p style="height:48px">标题后的内容</p>',
    );
    expect(!orphanHeading[0].text.includes('孤儿标题'), '页末孤儿标题应移到下一页', orphanHeading);
    expect(
      orphanHeading[1].text.includes('孤儿标题') && orphanHeading[1].text.includes('标题后的内容'),
      '标题应与后续内容同页',
      orphanHeading,
    );

    const ordinaryLine = await paginate(page,
      '<div style="height:1000px">前置内容</div>' +
      '<p>普通末行</p><div style="height:48px">下一块</div>',
    );
    expect(ordinaryLine[0].text.includes('普通末行'), '普通末行不应被标题规则移页', ordinaryLine);

    const dividerBoundary = await paginate(page,
      '<h2>第一节</h2><div style="height:1010px">章节内容</div>' +
      '<ol><li><hr></li></ol>' +
      '<h2>第二节</h2><p>新章节内容</p>',
    );
    expect(
      dividerBoundary.every((sheet) => sheet.text),
      '章节分隔线与强制标题之间不应生成空正文页',
      dividerBoundary,
    );
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
