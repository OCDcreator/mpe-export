/**
 * 冒烟测试：node test/smoke.js
 * 验证 --help / --version / 导出 HTML+PDF / --json 输出 / 错误场景
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BIN = path.join(__dirname, '..', 'bin', 'mpe-export.js');
const EXAMPLE = path.join(__dirname, '..', 'examples', 'example.md');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-test-'));

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
  });
}

let pass = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (e) {
    console.error(`  \u2716 ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('== mpe-export 冒烟测试 ==');

check('--help 输出帮助', () => {
  const out = run(['--help']);
  if (!out.includes('mpe-export')) throw new Error('帮助文本缺少工具名');
  if (!out.includes('--json')) throw new Error('帮助文本缺少 --json 说明');
  if (!out.includes('--toc')) throw new Error('帮助文本缺少 --toc 说明');
});

check('parseArgs 识别 --toc / --toc-level / --toc-title / --cover', () => {
  const { parseArgs } = require('../lib/args');
  const a = parseArgs([
    'a.md', '--toc', '--toc-level', 'h2', '--toc-title', 'Contents',
    '--cover', 'concept-map.html',
  ]);
  if (!a.toc) throw new Error('toc 应为 true');
  if (a.tocLevel !== 'h2') throw new Error('tocLevel=' + a.tocLevel);
  if (a.tocTitle !== 'Contents') throw new Error('tocTitle=' + a.tocTitle);
  if (a.cover !== 'concept-map.html') throw new Error('cover=' + a.cover);
});

check('buildFooterAssets(--toc) 注入目录分页脚本', () => {
  const { buildFooterAssets } = require('../lib/footer');
  const { css, js } = buildFooterAssets({
    format: 'A4',
    margin: { top: '14mm', bottom: '15mm', left: '13mm', right: '13mm' },
    footer: false,
    toc: true,
    tocLevel: 'h2',
    tocTitle: '目录',
    docTitle: 'demo',
  });
  if (!css.includes('.mpe-toc-item')) throw new Error('缺少目录 CSS');
  if (!js.includes('var TOC_ON = true')) throw new Error('TOC_ON 未开启');
  if (!js.includes('injectTocPages')) throw new Error('缺少 injectTocPages');
  if (!js.includes('var TOC_LEVEL = 2')) throw new Error('TOC_LEVEL 应为 2');
});

check('buildFooterAssets(--cover) 注入封面脚本', () => {
  const { buildFooterAssets } = require('../lib/footer');
  const { css, js } = buildFooterAssets({
    format: 'A4',
    margin: { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' },
    footer: true,
    toc: true,
    coverHref: 'file:///C:/tmp/concept-map.html',
    coverKind: 'html',
    docTitle: 'demo',
  });
  if (!css.includes('.mpe-cover-frame')) throw new Error('缺少封面 CSS');
  if (!js.includes('injectCoverSheet')) throw new Error('缺少 injectCoverSheet');
  if (!js.includes("var COVER_KIND = 'html'")) throw new Error('COVER_KIND 未注入');
  try {
    new Function(js);
  } catch (e) {
    throw new Error('封面分页脚本语法错误: ' + e.message);
  }
  try {
    new Function(js);
  } catch (e) {
    throw new Error('目录分页脚本语法错误: ' + e.message);
  }
});

check('--toc PDF 导出', () => {
  const md = path.join(tmp, 'toc-demo.md');
  fs.writeFileSync(
    md,
    '# 文档标题\n\n导语。\n\n## 第一章\n\n内容一。\n\n## 第二章\n\n内容二。\n\n### 小节\n\n内容三。\n',
  );
  run([md, '--format', 'pdf', '--toc', '--out', tmp, '--out-name', 'toc_demo']);
  const pdf = path.join(tmp, 'toc_demo.pdf');
  if (!fs.existsSync(pdf)) throw new Error('缺少 toc_demo.pdf');
  if (fs.statSync(pdf).size < 1000) throw new Error('toc_demo.pdf 过小');
});

check('--version 输出版本', () => {
  const out = run(['--version']).trim();
  if (!/^\d+\.\d+\.\d+$/.test(out)) throw new Error('版本格式错误: ' + out);
});

check('导出 HTML + PDF (both)', () => {
  const out = run([EXAMPLE, '--format', 'both', '--out', tmp]);
  if (!out.includes('[HTML]') || !out.includes('[PDF]')) throw new Error(out);
  if (!fs.existsSync(path.join(tmp, 'example.html'))) throw new Error('缺少 example.html');
  if (!fs.existsSync(path.join(tmp, 'example.pdf'))) throw new Error('缺少 example.pdf');
});

check('--json 输出可解析', () => {
  const out = run([EXAMPLE, '--format', 'pdf', '--out', tmp, '--json']);
  const data = JSON.parse(out);
  if (!data.ok) throw new Error(JSON.stringify(data));
  if (!data.files[0].outputs.pdf) throw new Error('缺少 outputs.pdf');
  if (typeof data.durationMs !== 'number') throw new Error('缺少 durationMs');
});

check('--offline HTML 导出', () => {
  const out = run([EXAMPLE, '--format', 'html', '--offline', '--out', tmp, '--out-name', 'offline_demo']);
  const html = fs.readFileSync(path.join(tmp, 'offline_demo.html'), 'utf8');
  if (!html.includes('</html>')) throw new Error('HTML 不完整');
});

check('--pdf-json 参数注入', () => {
  const out = run([
    EXAMPLE,
    '--format', 'pdf',
    '--pdf-json', '{"format":"Letter","displayHeaderFooter":true}',
    '--out', tmp,
    '--out-name', 'letter_demo',
  ]);
  const src = fs.readFileSync(EXAMPLE, 'utf8'); // 源文件不应被修改
  if (!src.includes('format: A4')) throw new Error('源文件被修改了!');
  if (!fs.existsSync(path.join(tmp, 'letter_demo.pdf'))) throw new Error('缺少 letter_demo.pdf');
});

check('批量多文件导出', () => {
  const b = path.join(tmp, 'batch-b.md');
  fs.writeFileSync(b, '# Batch B\n\nhello');
  const out = run([EXAMPLE, b, '--format', 'html']);
  if (!out.includes('batch-b.html')) throw new Error(out);
});

check('文件不存在 → 非零退出码', () => {
  try {
    run(['nope.md']);
    throw new Error('应失败却没有失败');
  } catch (e) {
    if (e.status === 0) throw new Error('退出码应为非零');
  }
});

console.log(`\n完成: ${pass} 项通过`);
