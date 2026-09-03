const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const puppeteer = require('puppeteer-core');
const { exportMarkdown, detectChrome } = require('../lib/exporter');

const PRESETS = ['phycat', 'phycat-forest', 'phycat-vampire', 'claude', 'claude-dark'];
const PROPERTIES = [
  'backgroundColor',
  'color',
  'fontWeight',
  'whiteSpace',
  'textAlign',
];

function expect(condition, message, value) {
  if (!condition) throw new Error(`${message}: ${JSON.stringify(value)}`);
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-callout-table-'));
  const md = path.join(tmp, 'options.md');
  fs.writeFileSync(
    md,
    `# 选项表样式

> [!question] 例题
> 请选择正确选项。
>
> | A. 甲 | B. 乙 |
> |---|---|
> | C. 丙 | D. 丁 |

| 普通表头甲 | 普通表头乙 |
|---|---|
| 普通内容甲 | 普通内容乙 |
`,
  );

  const browser = await puppeteer.launch({
    executablePath: detectChrome(),
    headless: true,
  });
  try {
    for (const preset of PRESETS) {
      const result = await exportMarkdown({
        file: md,
        format: 'html',
        preset,
        outDir: tmp,
        outName: preset,
      });
      const page = await browser.newPage();
      await page.goto(url.pathToFileURL(result.outputs.html).href, { waitUntil: 'load' });
      const styles = await page.evaluate((properties) => {
        const read = (selector) => {
          const node = document.querySelector(selector);
          if (!node) return null;
          const computed = getComputedStyle(node);
          return Object.fromEntries(properties.map((property) => [property, computed[property]]));
        };
        return {
          calloutHead: read('.callout table th'),
          calloutCell: read('.callout table td'),
          ordinaryHead: read('.markdown-preview > table th'),
          ordinaryCell: read('.markdown-preview > table td'),
        };
      }, PROPERTIES);
      if (
        process.env.MPE_CALLOUT_TABLE_SCREENSHOTS &&
        (preset === 'phycat-forest' || preset === 'phycat-vampire')
      ) {
        await page.setViewport({ width: 1100, height: 760, deviceScaleFactor: 1 });
        const callout = await page.$('.callout');
        if (callout) await callout.screenshot({ path: path.join(tmp, `${preset}.png`) });
      }
      await page.close();

      expect(styles.calloutHead && styles.calloutCell, `${preset} 应渲染 callout 选项表`, styles);
      expect(
        PROPERTIES.every((property) => styles.calloutHead[property] === styles.calloutCell[property]),
        `${preset} 的 callout 表头应与普通单元格一致`,
        styles,
      );
      expect(
        styles.ordinaryHead.backgroundColor !== styles.ordinaryCell.backgroundColor ||
          styles.ordinaryHead.color !== styles.ordinaryCell.color ||
          styles.ordinaryHead.fontWeight !== styles.ordinaryCell.fontWeight,
        `${preset} 的普通表格仍应保留主题表头强调`,
        styles,
      );
    }
  } finally {
    await browser.close();
    if (process.env.MPE_CALLOUT_TABLE_SCREENSHOTS) console.log(tmp);
    else fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
