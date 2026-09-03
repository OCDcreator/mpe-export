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

check('rewriteWavyUnderlines 生成固定波长的行内 SVG 波浪', () => {
  const { rewriteWavyUnderlines, WAVY_UNDERLINE_CSS } = require('../lib/exporter');
  if (!WAVY_UNDERLINE_CSS.includes('.wavy')) throw new Error('缺少 .wavy CSS');
  if (!WAVY_UNDERLINE_CSS.includes('.mpe-wavy-line')) throw new Error('缺少行内 SVG CSS');
  if (WAVY_UNDERLINE_CSS.includes('background-image: url')) {
    throw new Error('不应再用 background 平铺（易糊）');
  }
  const src =
    'a <span style="text-decoration:underline wavy">元素周期表</span> ' +
    'b <span style="text-decoration:underline wavy; text-decoration-color:red;">金属</span> ' +
    'c <em class="x" style="text-decoration: wavy underline">价层</em> ' +
    'd <span class="wavy">仅 class</span> ' +
    'e <strong style="text-decoration: underline wavy #0a84ff">简写颜色</strong>';
  const r = rewriteWavyUnderlines(src);
  if (!r.changed || r.count !== 5) throw new Error('count=' + r.count);
  if (/text-decoration\s*:\s*[^;"']*wavy/i.test(r.text)) {
    throw new Error('仍残留原生 wavy: ' + r.text);
  }
  if ((r.text.match(/<svg class="mpe-wavy-line"/g) || []).length !== 5) {
    throw new Error('应插入 5 个行内 SVG');
  }
  if (/preserveAspectRatio="none"/i.test(r.text)) {
    throw new Error('固定波长 SVG 不应按文本宽度非等比拉伸');
  }
  if (!/overflow:\s*hidden/.test(WAVY_UNDERLINE_CSS)) {
    throw new Error('固定坐标长 path 应由 SVG 视口裁切');
  }
  if (!/\.wavy\s*\{[^}]*position:\s*relative/s.test(WAVY_UNDERLINE_CSS)) {
    throw new Error('.wavy 应建立行内 SVG 的定位上下文');
  }
  if (!/\.wavy\s*>\s*\.mpe-wavy-line\s*\{[^}]*position:\s*absolute/s.test(WAVY_UNDERLINE_CSS)) {
    throw new Error('SVG 应脱离固有宽度计算，只覆盖文字宽度');
  }
  if (!/margin-top:\s*-0\.30em/.test(WAVY_UNDERLINE_CSS)) {
    throw new Error('波浪线应小幅上移并靠近文字');
  }
  const svgM = r.text.match(
    /<svg\b[^>]*\bviewBox="0 0 (\d+) 12"[^>]*\bpreserveAspectRatio="xMinYMid slice"/i,
  );
  if (!svgM || Number(svgM[1]) < 1200) {
    throw new Error('缺少按高度等比缩放的长 SVG 视口');
  }
  const pathM = r.text.match(/<path\b[^>]*\bd="([^"]+)"/i);
  if (!pathM) throw new Error('缺少波浪 path');
  if (!pathM[1].startsWith('M0 6.5 Q3 1 6 6.5')) {
    throw new Error('首个半波宽度应为 6 个 SVG 单位');
  }
  const endpoints = [6, ...Array.from(pathM[1].matchAll(/\bT(\d+(?:\.\d+)?)\s+6\.5/g), (m) => Number(m[1]))];
  if (endpoints.at(-1) !== Number(svgM[1])) {
    throw new Error('固定坐标 path 未铺满 viewBox: ' + endpoints.at(-1));
  }
  if (endpoints.some((x, i) => i > 0 && x - endpoints[i - 1] !== 6)) {
    throw new Error('半波端点间距不是固定 6 个 SVG 单位: ' + endpoints.slice(0, 8));
  }
  if (!r.text.includes('stroke="red"')) throw new Error('红色波浪未保留颜色');
  if (!r.text.includes('stroke="#0a84ff"')) throw new Error('简写颜色未保留');
  if (!/<span[^>]*>元素周期表<svg class="mpe-wavy-line"/.test(r.text)) {
    throw new Error('SVG 应接在文字后: ' + r.text.slice(0, 280));
  }
});

check('phycat 原生打印禁止正文与显示公式跨页', () => {
  const md = path.join(tmp, 'phycat-native-page-break.md');
  fs.writeFileSync(
    md,
    '# Native page break\n\n正文。\n\n$$\\dfrac{a}{b}$$\n',
  );
  run([md, '--format', 'html', '--preset', 'phycat', '--out', tmp]);
  const html = fs.readFileSync(path.join(tmp, 'phycat-native-page-break.html'), 'utf8');
  const rule = /@media print\s*\{[\s\S]*?\.markdown-preview > p,[\s\S]*?\.markdown-preview > \.katex-display,[\s\S]*?break-inside:\s*avoid;[\s\S]*?page-break-inside:\s*avoid;/;
  if (!rule.test(html)) {
    throw new Error('phycat 原生打印缺少正文/显示公式的不可跨页规则');
  }
});

check('表格单元格合并默认开启且 --no-merge-cells 可关', () => {
  const md = path.join(tmp, 'merge-cells.md');
  fs.writeFileSync(
    md,
    '| A | B | C |\n|---|---|---|\n| 1 | > | 3 |\n| ^ | x | 6 |\n',
  );
  // 默认：^ 向上合并 rowspan、> 向右合并 colspan
  run([md, '--format', 'html', '--out', tmp]);
  const html = fs.readFileSync(path.join(tmp, 'merge-cells.html'), 'utf8');
  if (!/rowspan="2"/.test(html)) throw new Error('默认应生成 rowspan="2"（^ 向上合并）');
  if (!/colspan="2"/.test(html)) throw new Error('默认应生成 colspan="2"（> 向右合并）');
  // --no-merge-cells：> / ^ 按普通文本渲染
  run([md, '--format', 'html', '--no-merge-cells', '--out', tmp, '--out-name', 'merge-cells-off']);
  const off = fs.readFileSync(path.join(tmp, 'merge-cells-off.html'), 'utf8');
  if (/rowspan|colspan/.test(off)) throw new Error('--no-merge-cells 后不应出现合并属性');
  if (!off.includes('<td>&gt;</td>') || !off.includes('<td>^</td>')) {
    throw new Error('关闭后 > / ^ 应按普通文本渲染');
  }
  // front-matter merge-cells: false 等价关闭
  const fmmd = path.join(tmp, 'merge-cells-fm.md');
  fs.writeFileSync(
    fmmd,
    '---\nmerge-cells: false\n---\n\n| A | B | C |\n|---|---|---|\n| 1 | > | 3 |\n| ^ | x | 6 |\n',
  );
  run([fmmd, '--format', 'html', '--out', tmp]);
  const fmHtml = fs.readFileSync(path.join(tmp, 'merge-cells-fm.html'), 'utf8');
  if (/rowspan|colspan/.test(fmHtml)) {
    throw new Error('front-matter merge-cells: false 后不应出现合并属性');
  }
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
  if (!/\.mpe-toc-item-title:has\(\.wavy\)\s*\{[^}]*padding-bottom:\s*0\.25em;[^}]*margin-bottom:\s*-0\.25em;/s.test(css)) {
    throw new Error('含波浪标题的目录项应保留 SVG 底部裁切空间');
  }
  if (!/\.mpe-breadcrumb:has\(\.wavy\)\s*\{[^}]*padding-bottom:\s*0\.25em;[^}]*margin-bottom:\s*-0\.25em;/s.test(css)) {
    throw new Error('含波浪标题的页脚面包屑应保留 SVG 底部裁切空间');
  }
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

check('分页器逐项拆分嵌套列表并防止孤儿标题', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'pagination-list.js')], {
    encoding: 'utf8',
    cwd: tmp,
    stdio: 'pipe',
  });
});

check('callout 选项表的表头与内容样式一致', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'callout-table.js')], {
    encoding: 'utf8',
    cwd: tmp,
    stdio: 'pipe',
  });
});

check('--footer/--toc HTML + PDF 固定波长波浪导出', () => {
  const md = path.join(tmp, 'toc-demo.md');
  fs.writeFileSync(
    md,
    '# 文档标题\n\n' +
      '导语 <span style="text-decoration:underline wavy">元素周期表</span>。\n\n' +
      '## 第一章\n\n' +
      '<span style="text-decoration:underline wavy; text-decoration-color:red">' +
      '元素化学性质及原子价层电子排布的特点</span>。\n\n' +
      '## 第二章\n\n内容二。\n\n### 小节\n\n内容三。\n',
  );
  run([
    md, '--format', 'both', '--footer', '--pagination-level', 'h2', '--toc',
    '--out', tmp, '--out-name', 'toc_demo',
  ]);
  const html = fs.readFileSync(path.join(tmp, 'toc_demo.html'), 'utf8');
  if ((html.match(/<svg class="mpe-wavy-line"/g) || []).length !== 2) {
    throw new Error('最终 HTML 应包含 2 个波浪 SVG');
  }
  if (!html.includes('preserveAspectRatio="xMinYMid slice"')) {
    throw new Error('最终 HTML 未保留固定波长 SVG');
  }
  if (!html.includes('stroke="red"')) throw new Error('最终 HTML 未保留红色波浪');
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
