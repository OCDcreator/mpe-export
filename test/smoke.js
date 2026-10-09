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

check('parseArgs 识别 --header（默认关闭）', () => {
  const { parseArgs } = require('../lib/args');
  const plain = parseArgs(['a.md']);
  if (plain.header !== false) throw new Error('默认 header 应为 false');
  const on = parseArgs(['a.md', '--header']);
  if (on.header !== true) throw new Error('--header 应置 header=true');
  const eq = parseArgs(['a.md', '--header=true']);
  if (eq.header !== true) throw new Error('--header=true 应等价于 --header');
});

check('parseArgs 识别 --no-pagination（默认关闭即启用 sheet 分页）', () => {
  const { parseArgs } = require('../lib/args');
  const plain = parseArgs(['a.md']);
  if (plain.noPagination !== false) {
    throw new Error('默认 noPagination 应为 false（sheet 分页默认开启）');
  }
  const opted = parseArgs(['a.md', '--no-pagination']);
  if (opted.noPagination !== true) throw new Error('--no-pagination 应置 noPagination=true');
});

check('parseArgs 识别 --number-figures（默认关）', () => {
  const { parseArgs } = require('../lib/args');
  const plain = parseArgs(['a.md']);
  if (plain.numberFigures !== false) throw new Error('默认 numberFigures 应为 false');
  const on = parseArgs(['a.md', '--number-figures']);
  if (on.numberFigures !== true) throw new Error('--number-figures 应置 numberFigures=true');
  const eq = parseArgs(['a.md', '--number-figures=true']);
  if (eq.numberFigures !== true) throw new Error('--number-figures=true 应等价');
  const off = parseArgs(['a.md', '--number-figures=false']);
  if (off.numberFigures !== false) throw new Error('--number-figures=false 应置回 false');
});

check('parseArgs 识别 --theme-vars（JSON 原样透传，导出侧再解析校验）', () => {
  const { parseArgs } = require('../lib/args');
  const raw = '{"--element-color":"#e74c3c","--code-keyword":"#c0392b"}';
  const a = parseArgs(['a.md', '--theme-vars', raw]);
  if (a.themeVars !== raw) throw new Error('themeVars 应原样保留 JSON 字符串');
  const b = parseArgs(['a.md', '--theme-vars={"--element-color":"#123456"}']);
  if (b.themeVars !== '{"--element-color":"#123456"}') {
    throw new Error('--theme-vars= 形式应等价，得到 ' + b.themeVars);
  }
});

check('buildThemeVarsOverride：CLI 优先、YAML 映射、非法键跳过、坏 JSON 报错', () => {
  const { buildThemeVarsOverride } = require('../lib/exporter');
  // CLI JSON
  const cli = buildThemeVarsOverride('{"--element-color":"#e74c3c"}', undefined);
  if (!cli || !cli.includes('--element-color: #e74c3c;')) {
    throw new Error('CLI JSON 应生成 :root 覆盖段');
  }
  // front-matter YAML 映射（对象）
  const fm = buildThemeVarsOverride(undefined, { '--code-keyword': '#c0392b' });
  if (!fm || !fm.includes('--code-keyword: #c0392b;')) {
    throw new Error('front-matter 映射应生成 :root 覆盖段');
  }
  // CLI 优先于 front-matter
  const both = buildThemeVarsOverride('{"--a":"1"}', { '--b': '2' });
  if (!both.includes('--a: 1;') || both.includes('--b: 2;')) {
    throw new Error('CLI theme-vars 应压过 front-matter');
  }
  // 非法键跳过
  const mixed = buildThemeVarsOverride('{"--ok":"1","bad-key":"2"}', undefined);
  if (!mixed.includes('--ok: 1;') || mixed.includes('bad-key')) {
    throw new Error('非法变量名应被跳过');
  }
  // 坏 JSON 报错
  let threw = false;
  try {
    buildThemeVarsOverride('{broken', undefined);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error('坏 JSON 应抛错');
});

check('buildThemeVarsOverride：值消毒——越界值整键跳过并经 stderr 告警，合法值放行', () => {
  const { buildThemeVarsOverride, themeVarsValueRejectReason } = require('../lib/exporter');
  // 拦截 stderr 告警（同时守卫 stdout 纯净铁律：提示必须走 stderr）
  const origWrite = process.stderr.write;
  let warned = '';
  process.stderr.write = (s) => {
    warned += String(s);
    return true;
  };
  let css;
  try {
    // 实测越界样例：值提前闭合 :root 声明并注入任意规则
    css = buildThemeVarsOverride(
      '{"--x":"red; } body { display:none","--safe":"#e74c3c"}',
      undefined,
    );
  } finally {
    process.stderr.write = origWrite;
  }
  if (!css || css.includes('--x')) throw new Error('越界值未被整键拒绝: ' + css);
  if (/body\s*\{|display\s*:\s*none/.test(css)) throw new Error('越界 CSS 混入: ' + css);
  if (!css.includes('--safe: #e74c3c;')) throw new Error('同批合法键应照常生效: ' + css);
  if (!warned.includes('--x')) throw new Error('拒绝时应有 stderr 告警: ' + warned);
  // 其余禁止模式（不区分大小写）：url( / expression( / @import / 边界字符
  for (const bad of ['URL(bg.png)', 'expression(alert(1))', '@import "x.css"', 'a<b', 'a>b']) {
    if (themeVarsValueRejectReason(bad) === null) throw new Error(`值 "${bad}" 应被拒绝`);
  }
  // 合法值放行：# 色值、长度、字体栈、counter() 编号串（phycat-autonum 形态）
  const ok = buildThemeVarsOverride(
    '{"--a":"#e74c3c","--b":"12px","--c":"LXGW WenKai, sans-serif","--autonum-h1":"counter(h1) \\". \\""}',
    undefined,
  );
  if (!ok || !ok.includes('--a: #e74c3c;') || !ok.includes('--b: 12px;')) {
    throw new Error('合法颜色/长度被误拒: ' + ok);
  }
  if (!ok.includes('--c: LXGW WenKai, sans-serif;')) throw new Error('字体栈被误拒: ' + ok);
  if (!ok.includes('--autonum-h1: counter(h1) ". ";')) throw new Error('counter() 串被误拒: ' + ok);
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

check('图片数值宽度 ![alt|400] 转 style 宽高，alt 其余文本保留', () => {
  const { rewriteImageSizeHtml } = require('../lib/exporter');
  const src =
    '<p><img src="a.png" alt="plain|400"></p>' +
    '<p><img src="b.png" alt="center|400x300"></p>' +
    '<img src="c.png" alt="无尺寸">' +
    '<img src="d.png" alt="尾部非尺寸|abc">';
  const r = rewriteImageSizeHtml(src);
  if (r.count !== 2) throw new Error('count=' + r.count);
  if (!r.text.includes('alt="plain" style="width:400px;"')) {
    throw new Error('单值宽度未转换: ' + r.text);
  }
  if (!r.text.includes('alt="center" style="width:400px;height:300px;"')) {
    throw new Error('WxH 双值未转换: ' + r.text);
  }
  // 对齐语法依赖 alt 子串匹配：center 必须保留
  if (!r.text.includes('alt="center"')) throw new Error('center 关键词被剥掉');
  // 无尺寸 token 的 img 不动
  if (!r.text.includes('alt="无尺寸"') || !r.text.includes('alt="尾部非尺寸|abc"')) {
    throw new Error('无尺寸 img 被误改');
  }
  // 幂等：转换结果再跑一遍 count=0
  const r2 = rewriteImageSizeHtml(r.text);
  if (r2.count !== 0) throw new Error('应幂等，第二次 count=' + r2.count);
  // 已有 style：尺寸声明须后置（同特异性 CSS 后声明胜出），尺寸 token 不被静默压过
  const r3 = rewriteImageSizeHtml(
    '<img src="e.png" alt="keep|400" style="width:50%">' +
      '<img src="f.png" alt="keep2|400x300" style="object-fit:cover;">' +
      '<img src="g.png" alt="keep3|200" style="">',
  );
  if (r3.count !== 3) throw new Error('已有 style 时 count=' + r3.count);
  if (!r3.text.includes('alt="keep" style="width:50%;width:400px;"')) {
    throw new Error('已有 style 时尺寸声明应后置胜出: ' + r3.text);
  }
  if (!r3.text.includes('style="object-fit:cover;width:400px;height:300px;"')) {
    throw new Error('已有 style（带尾分号）追加尺寸失败: ' + r3.text);
  }
  if (!r3.text.includes('alt="keep3" style="width:200px;"')) {
    throw new Error('空 style 应等价无 style 行为: ' + r3.text);
  }
  const r4 = rewriteImageSizeHtml(r3.text);
  if (r4.count !== 0) throw new Error('已有 style 转换应幂等，count=' + r4.count);
});

check('代码块行号：补 class + 行号列 DOM，图表块跳过、原生块不重复', () => {
  const { addLineNumbersToCodeBlocks } = require('../lib/exporter');
  const native =
    '<pre data-role="codeBlock" data-info="js {.line-numbers}" class="language-javascript js line-numbers"><code><span class="token keyword">const</span> a = 1;\nconst b = 2;\n</code></pre>';
  const plain =
    '<pre data-role="codeBlock" data-info="python" class="language-python python"><code>x = 1\ny = 2\nz = 3\n</code></pre>';
  const mermaid =
    '<pre data-role="codeBlock" data-info="mermaid" class="language-mermaid mermaid"><code>graph TD\n</code></pre>';
  const other = '<pre class="plain"><code>keep</code></pre>';
  const r = addLineNumbersToCodeBlocks(native + plain + mermaid + other);
  // 只有 plain 块被补行号（native 已有、mermaid 图表、other 非 codeBlock）
  if (r.count !== 1) throw new Error('count=' + r.count);
  if (!/python python line-numbers/.test(r.text)) throw new Error('plain 块未加 class');
  // 行号列 span 数 = 行数（3 行代码，\n(?!$) 计数）
  const block = r.text.match(/<pre[^>]*python[^>]*>[\s\S]*?<\/pre>/)[0];
  if (!block.includes('line-numbers-rows')) throw new Error('缺少行号列容器');
  const spans = (block.match(/<span><\/span>/g) || []).length;
  if (spans !== 3) throw new Error('行号 span 数=' + spans + '，应为 3');
  // native 块不被重复处理
  if ((r.text.match(/line-numbers-rows/g) || []).length !== 1) {
    throw new Error('native 块被重复加行号列');
  }
  if (/mermaid mermaid line-numbers/.test(r.text)) throw new Error('图表块被加行号');
});

check('图表编号：多图多表独立计数、规范替换、无题注不编号、假题注不动、幂等', () => {
  const { numberFigureCaptions } = require('../lib/exporter');
  // 形态与引擎 parseMD 产物一致（块间 \n 分隔）
  const src = [
    '<h1 id="x">X </h1>',
    '<p><img src="a.png" alt="a"></p>',
    '<p>图：alpha</p>',
    '<p><img src="b.png" alt="b|300" style="width:300px;"></p>',
    '<p>Figure 5: beta</p>',
    '<table>',
    '<thead>',
    '<tr><th>A</th></tr>',
    '</thead>',
    '<tbody>',
    '<tr><td>1</td></tr>',
    '</tbody>',
    '</table>',
    '<p>表：t-one</p>',
    '<p>正文隔断：下图没有题注。</p>',
    '<p><img src="c.png" alt="c"></p>',
    '<p>中间隔了正文段，上图无题注。</p>',
    '<p>图 9：不紧跟图片的假题注，不许动</p>',
    '<table>',
    '<thead>',
    '<tr><th>B</th></tr>',
    '</thead>',
    '<tbody>',
    '<tr><td>2</td></tr>',
    '</tbody>',
    '</table>',
    '<p>Table:t-two</p>',
    '<p><img src="d.png" alt="d"></p>',
    '<p>图1-2：老式编号要规范替换</p>',
    '<p><img src="e.png" alt="e"></p>',
    '<p><strong>图：段首行内标记不改写</strong></p>',
    '<table>',
    '<thead>',
    '<tr><th>C</th></tr>',
    '</thead>',
    '<tbody>',
    '<tr><td>3</td></tr>',
    '</tbody>',
    '</table>',
    '<p>图：类型不对应（表格后跟「图…」），不认</p>',
  ].join('\n');
  const r = numberFigureCaptions(src);
  // 图/Figure 共用图计数器、表/Table 共用表计数器，按文档顺序递增
  if (!r.text.includes('<p>图 1：alpha</p>')) throw new Error('图 1 未编号: ' + r.text.slice(0, 200));
  if (!r.text.includes('<p>Figure 2: beta</p>')) throw new Error('Figure 未接续编号/未规范替换');
  if (!r.text.includes('<p>表 1：t-one</p>')) throw new Error('表 1 未编号');
  if (!r.text.includes('<p>Table 2: t-two</p>')) throw new Error('Table 未接续编号/半角冒号未规范');
  if (!r.text.includes('<p>图 3：老式编号要规范替换</p>')) throw new Error('图1-2 老式编号未被规范替换');
  if (r.figures !== 3 || r.tables !== 2 || r.count !== 5) {
    throw new Error(`计数错误 figures=${r.figures} tables=${r.tables} count=${r.count}`);
  }
  // 无题注/假题注/类型不对应：原文一字不动、不占号
  if (!r.text.includes('<p>图 9：不紧跟图片的假题注，不许动</p>')) {
    throw new Error('不紧跟的假题注被误改');
  }
  if (!r.text.includes('<p>正文隔断：下图没有题注。</p>')) throw new Error('正文段被误改');
  if (!r.text.includes('<p><strong>图：段首行内标记不改写</strong></p>')) {
    throw new Error('行内标记题注被误改');
  }
  if (!r.text.includes('<p>图：类型不对应（表格后跟「图…」），不认</p>')) {
    throw new Error('类型不对应的题注被误改');
  }
  if (!r.text.includes('<p><img src="c.png" alt="c"></p>')) throw new Error('无题注图片段落被误改');
  // 幂等：改写结果再跑一遍逐字节一致（管线里 onDidParseMarkdown 会被多次调用）
  const r2 = numberFigureCaptions(r.text);
  if (r2.text !== r.text) throw new Error('不幂等:\n' + r2.text.slice(0, 400));
  if (r2.figures !== 3 || r2.tables !== 2) throw new Error('第二轮计数漂移');
});

check('--number-figures 导出生效、默认关零改动、front-matter 等价', () => {
  const md = path.join(tmp, 'figcap.md');
  fs.writeFileSync(
    md,
    '# T\n\n![a](x.png)\n\n图：结构\n\n| A |\n|---|\n| 1 |\n\n表：数据\n',
  );
  // 默认关：题注保持原文
  run([md, '--format', 'html', '--out', tmp, '--out-name', 'figcap-off']);
  const off = fs.readFileSync(path.join(tmp, 'figcap-off.html'), 'utf8');
  if (!off.includes('<p>图：结构</p>') || !off.includes('<p>表：数据</p>')) {
    throw new Error('默认关闭时题注被改写');
  }
  if (/图 1：|表 1：/.test(off)) throw new Error('默认关闭时出现编号');
  // --number-figures：图/表各自编号
  run([md, '--format', 'html', '--number-figures', '--out', tmp, '--out-name', 'figcap-on']);
  const on = fs.readFileSync(path.join(tmp, 'figcap-on.html'), 'utf8');
  if (!on.includes('<p>图 1：结构</p>')) throw new Error('--number-figures 图片题注未编号');
  if (!on.includes('<p>表 1：数据</p>')) throw new Error('--number-figures 表格题注未编号');
  // front-matter number-figures: true 等价
  const fmmd = path.join(tmp, 'figcap-fm.md');
  fs.writeFileSync(
    fmmd,
    '---\nnumber-figures: true\n---\n\n# T\n\n![a](x.png)\n\n图：结构\n\n| A |\n|---|\n| 1 |\n\n表：数据\n',
  );
  run([fmmd, '--format', 'html', '--out', tmp, '--out-name', 'figcap-fm']);
  const fm = fs.readFileSync(path.join(tmp, 'figcap-fm.html'), 'utf8');
  if (!fm.includes('<p>图 1：结构</p>') || !fm.includes('<p>表 1：数据</p>')) {
    throw new Error('front-matter number-figures: true 未生效');
  }
});

check('mermaid 全图型主题变量：亮/暗映射与变量残缺兜底链', () => {
  const {
    parseCssColor,
    mixCssColors,
    extractPaletteColors,
    buildMermaidThemeVariables,
  } = require('../lib/exporter');
  if (parseCssColor('var(--x)') !== null) throw new Error('var() 引用不应被当作颜色');
  if (mixCssColors('#3498db', '#ffffff', 0.88) !== '#e7f3fb') {
    throw new Error('混色计算错误: ' + mixCssColors('#3498db', '#ffffff', 0.88));
  }
  // 亮色变体：element-color 存在、无 bg/text（兜底白纸/深灰字）
  const light = extractPaletteColors(':root { --element-color: #3498db; --primary-color: #3498db; }');
  const tvL = buildMermaidThemeVariables(light, false);
  if (tvL.primaryBorderColor !== '#3498db') throw new Error('亮色边框应=强调色');
  if (tvL.background !== '#ffffff' || tvL.primaryTextColor !== '#333333') {
    throw new Error('亮色纸/字兜底错误: ' + tvL.background + '/' + tvL.primaryTextColor);
  }
  // 兜底链 element → primary（暗变体没有 element-color）
  const dark = extractPaletteColors(
    ':root { --primary-color: #ff5555; --secondary-color: #bd93f9; --bg-color: #282a36; --text-color: #f8f8f2; }',
  );
  const tvD = buildMermaidThemeVariables(dark, true);
  if (tvD.primaryBorderColor !== '#ff5555') throw new Error('暗色应走 primary-color 兜底');
  if (tvD.background !== '#282a36' || tvD.primaryTextColor !== '#f8f8f2') {
    throw new Error('暗色纸/字取自调色板失败');
  }
  // 暗色主题饼图扇区是硬编码盘，必须逐键覆盖（pie1..12）
  for (let i = 1; i <= 12; i++) {
    if (typeof tvD['pie' + i] !== 'string' || !/^#[0-9a-f]{6}$/.test(tvD['pie' + i])) {
      throw new Error('暗色 pie' + i + ' 缺失或非法');
    }
  }
  if (tvL.pie1 !== undefined) throw new Error('亮色不应逐键覆盖 pie1..12（原生派生已跟随主色）');
  // theme-vars 覆盖 :root 变量后（后者获胜），mermaid 应跟随
  const overridden = extractPaletteColors(
    ':root { --element-color: #3498db; }\n:root { --element-color: #e74c3c; }',
  );
  const tvO = buildMermaidThemeVariables(overridden, false);
  if (tvO.primaryBorderColor !== '#e74c3c') throw new Error('theme-vars 覆盖未传导到 mermaid');
});

check('css-color：统一颜色解析（短/长 hex、alpha、rgb()/rgba()、非法输入）', () => {
  const { parseCssColor, luminance, contrastRatio } = require('../lib/css-color');
  const eq = (got, want) => JSON.stringify(got) === JSON.stringify(want);
  // exporter 侧应直接复用同一实现（防再次漂移）
  if (require('../lib/exporter').parseCssColor !== parseCssColor) {
    throw new Error('exporter 未复用 lib/css-color 的 parseCssColor');
  }
  // 短 hex：通道倍增；#rgba 第 4 位为 alpha（/255 归一）
  if (!eq(parseCssColor('#3ab'), [51, 170, 187, 1])) throw new Error('#3ab 解析错误');
  if (!eq(parseCssColor('#3ab9'), [51, 170, 187, 153 / 255])) throw new Error('#3ab9 解析错误');
  // 长 hex：字节对；大小写不敏感；#rrggbbaa 带 alpha
  if (!eq(parseCssColor('#3498db'), [52, 152, 219, 1])) throw new Error('#3498db 解析错误');
  if (!eq(parseCssColor('#EBF5FA'), [0xeb, 0xf5, 0xfa, 1])) throw new Error('大写 hex 解析错误');
  if (!eq(parseCssColor('#3498db80'), [52, 152, 219, 128 / 255])) {
    throw new Error('#3498db80 解析错误');
  }
  // rgb()/rgba()：逗号或空格分隔均可，alpha 缺省 1
  if (!eq(parseCssColor('rgb(74, 13, 24)'), [74, 13, 24, 1])) throw new Error('rgb() 解析错误');
  if (!eq(parseCssColor('rgba(177, 108, 108, 0.02)'), [177, 108, 108, 0.02])) {
    throw new Error('rgba() 带透明度解析错误');
  }
  if (!eq(parseCssColor('rgba(238, 238, 238, .7)'), [238, 238, 238, 0.7])) {
    throw new Error('.7 形式 alpha 解析错误');
  }
  if (!eq(parseCssColor('rgb(1 2 3)'), [1, 2, 3, 1])) throw new Error('空格分隔 rgb() 解析错误');
  // 现代语法 `/ alpha`（可写百分比，claude 预设 --alert-* 在用）
  if (!eq(parseCssColor('rgb(216 134 120 / 10%)'), [216, 134, 120, 0.1])) {
    throw new Error('现代语法 /alpha 解析错误');
  }
  // 非法/引用形态：一律 null（var() 等交给调用方兜底链）
  for (const bad of [null, '', '   ', 'var(--x)', 'green', '#', '#12345', '#1234567', 'rgb(1,2)', 'rgb(1 2 3']) {
    if (parseCssColor(bad) !== null) throw new Error('非法输入应返回 null: ' + String(bad));
  }
  // 亮度与对比度（WCAG 基准值）
  if (luminance([0, 0, 0]) !== 0 || luminance([255, 255, 255]) !== 1) throw new Error('亮度端点错误');
  if (Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - 21) > 1e-12) {
    throw new Error('黑白对比度应为 21');
  }
});

check('phycat 预设导出注入 mermaidConfig.themeVariables；--no-image-size / --line-numbers 生效', () => {
  const md = path.join(tmp, 'feat-probe.md');
  fs.writeFileSync(
    md,
    '# T\n\n![center|300](x.png)\n\n```mermaid\nflowchart TD\n    A --> B\n```\n\n```js\nconst a = 1;\nconst b = 2;\n```\n',
  );
  // phycat-sky（默认：图片尺寸开、行号关）→ mermaidConfig 注入 + 图片转宽高 + 无行号
  run([md, '--format', 'html', '--preset', 'phycat-sky', '--out', tmp, '--out-name', 'feat-sky']);
  const sky = fs.readFileSync(path.join(tmp, 'feat-sky.html'), 'utf8');
  if (!sky.includes('"themeVariables"') || !sky.includes('"primaryBorderColor":"#3498db"')) {
    throw new Error('phycat 预设应注入 mermaidConfig.themeVariables（sky 调色板）');
  }
  if (!/alt="center" style="width:300px;"/.test(sky)) throw new Error('图片尺寸默认应开启');
  if (/class="line-numbers-rows"/.test(sky)) throw new Error('行号默认应关闭');
  // --no-image-size：不做尺寸转换
  run([md, '--format', 'html', '--preset', 'phycat-sky', '--no-image-size', '--out', tmp, '--out-name', 'feat-noimg']);
  const noimg = fs.readFileSync(path.join(tmp, 'feat-noimg.html'), 'utf8');
  if (/style="width:300px;"/.test(noimg) || !noimg.includes('alt="center|300"')) {
    throw new Error('--no-image-size 应保留原 alt 且不加宽度');
  }
  // --line-numbers：行号列 DOM 出现（onDidParse 在增强器之后，需自补 rows）
  run([md, '--format', 'html', '--preset', 'phycat-sky', '--line-numbers', '--out', tmp, '--out-name', 'feat-ln']);
  const ln = fs.readFileSync(path.join(tmp, 'feat-ln.html'), 'utf8');
  if ((ln.match(/line-numbers-rows/g) || []).length < 1) throw new Error('--line-numbers 未生成行号列');
  if (!/top:\s*42px/.test(ln)) throw new Error('phycat 行号列对齐补偿（top:42px）缺失');
  // claude-dark（非 phycat）不注入 mermaidConfig —— 行为不变
  const md2 = path.join(tmp, 'feat-claude.md');
  fs.writeFileSync(md2, '# C\n\n正文\n');
  run([md2, '--format', 'html', '--preset', 'claude-dark', '--out', tmp, '--out-name', 'feat-claude']);
  const claude = fs.readFileSync(path.join(tmp, 'feat-claude.html'), 'utf8');
  if (claude.includes('"themeVariables"')) {
    throw new Error('非 phycat 预设不应注入 mermaidConfig');
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

check('buildFooterAssets(--header) 注入页眉脚本；关闭时无页眉痕迹', () => {
  const { buildFooterAssets } = require('../lib/footer');
  const margin = { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' };
  const on = buildFooterAssets({ format: 'A4', margin, footer: true, header: true, docTitle: 'demo' });
  if (!on.css.includes('.mpe-sheet-header')) throw new Error('缺少页眉 CSS');
  if (!on.css.includes('top: max(18mm, 14mm)')) {
    throw new Error('页眉开启时页体 top 应让位 max(top, 14mm)');
  }
  if (!on.js.includes('var HEADER_ON = true')) throw new Error('HEADER_ON 未开启');
  if (!on.js.includes('updateSheetHeaders')) throw new Error('缺少 updateSheetHeaders');
  if (!on.js.includes("className = 'mpe-sheet-header'")) throw new Error('createSheet 未创建页眉');
  try {
    new Function(on.js);
  } catch (e) {
    throw new Error('页眉分页脚本语法错误: ' + e.message);
  }
  // 关闭时不注入任何页眉 CSS/JS（默认行为与历史版本逐字节一致）
  const off = buildFooterAssets({ format: 'A4', margin, footer: true, docTitle: 'demo' });
  if (off.css.includes('mpe-sheet-header') || off.js.includes('HEADER_ON')) {
    throw new Error('关闭 --header 时不应注入页眉');
  }
  if (off.js.includes('updateSheetHeaders')) {
    throw new Error('关闭 --header 时不应注入 updateSheetHeaders');
  }
});

check('分页器逐项拆分嵌套列表并防止孤儿标题', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'pagination-list.js')], {
    encoding: 'utf8',
    cwd: tmp,
    stdio: 'pipe',
  });
});

check('顶层表格按行流式跨页（续页重复表头）', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'pagination-table.js')], {
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

check('表格 < 合并占位符（链式/callout/thead 跨组 rowspan 拍平）', () => {
  execFileSync(process.execPath, [path.join(__dirname, 'merge-left.js')], {
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
  const out = run([EXAMPLE, b, '--format', 'html', '--out', tmp]);
  if (!out.includes('batch-b.html')) throw new Error(out);
});

check('默认输出目录按来源路由到库外 pdf-exports', () => {
  const fakeCustom = path.join(tmp, 'math', 'custom');
  fs.mkdirSync(fakeCustom, { recursive: true });
  const md = path.join(fakeCustom, 'route-demo.md');
  fs.writeFileSync(md, '# Route\n\nhello');
  const exportsRoot = path.join(tmp, 'pdf-exports');
  const out = execFileSync(
    process.execPath,
    [BIN, md, '--format', 'html', '--json'],
    { encoding: 'utf8', cwd: tmp, env: { ...process.env, MPE_EXPORT_OUT_ROOT: exportsRoot } },
  );
  const data = JSON.parse(out);
  if (!data.ok) throw new Error(JSON.stringify(data));
  const dest = data.files[0].outputs.html;
  const expect = path.join(exportsRoot, 'custom', 'route-demo.html');
  if (dest !== expect) throw new Error(`路由结果 ${dest} !== ${expect}`);
  if (!fs.existsSync(expect)) throw new Error('目标文件不存在: ' + expect);
  // 学科分夹路由: math\<学科>\custom → <学科>-custom
  const subjCustom = path.join(tmp, 'math', '初中数学', 'custom');
  fs.mkdirSync(subjCustom, { recursive: true });
  const md2 = path.join(subjCustom, 'route-demo2.md');
  fs.writeFileSync(md2, '# Route2\n\nhello');
  const out2 = execFileSync(
    process.execPath,
    [BIN, md2, '--format', 'html', '--json'],
    { encoding: 'utf8', cwd: tmp, env: { ...process.env, MPE_EXPORT_OUT_ROOT: exportsRoot } },
  );
  const dest2 = JSON.parse(out2).files[0].outputs.html;
  const expect2 = path.join(exportsRoot, '初中数学-custom', 'route-demo2.html');
  if (dest2 !== expect2) throw new Error(`学科分夹路由 ${dest2} !== ${expect2}`);
  if (!fs.existsSync(expect2)) throw new Error('目标文件不存在: ' + expect2);
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
