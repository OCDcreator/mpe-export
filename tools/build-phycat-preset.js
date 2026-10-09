#!/usr/bin/env node
/**
 * 从 Typora 主题 typora-theme-phycat 提炼"文档内容样式"，一次生成全部 11 个
 * 配色变体的 mpe-export 预设 CSS（lib/presets/phycat-*.css）。
 *
 * 用法:
 *   node tools/build-phycat-preset.js [主题源目录]
 *   默认主题源目录: C:/Users/lt/Desktop/Write/open-source-project/typora-theme-phycat
 *
 * 上游同步说明（2026-10-09）：Typora 源仓库（sumruler/typora-theme-phycat）自 2026-03-01
 * (b49f1fc) 起停更；作者的新特性在 Obsidian 版仓库 sumruler/obsidian-theme-phycat
 * 持续迭代（0.2.6 → 0.3.5）。本脚本现把 Obsidian 版中对 PDF 导出有意义的内容样式
 * 手工移植进追加段（见 IMAGE_ALIGN_RULES / MERMAID_RULES 及各段注释），其余差异经
 * 评估不搬运，理由附在对应段注释里：
 *  - 标题逐级间距缩放 / H2 双柱 em 化：预设沿用 Typora 线的
 *    固定排版（TYPOGRAPHY_FIX 既定政策）与胶囊 H2，Style Settings 钩子在导出中不存在；
 *  - 标题颜色自定义（Style Settings 钩子）改为导出端等价物：HEADING_COLOR_VARS 段给
 *    每级标题挂 --h1-color..--h6-color（默认值=改动前计算值，观感不变），用户经
 *    --theme-vars / front-matter theme-vars 覆盖；
 *  - 任务对勾调色盘色（0.3.5 恢复白色默认）：预设对勾已硬编码白色，无差异；
 *  - callout 50px 药丸 + 水印层：预设 callout 走 COMPAT_EXTRA 胶囊减重方案，设计线分歧；
 *  - 彩虹文件树 / 文件图标 / 卡片布局：Obsidian 外壳层，与导出无关。
 *
 * 0.3.x 调色盘系统（0.3.3 亮暗独立调色盘 + 逐元素颜色设置 / 0.3.4 离线配色生成器）
 * 的"能力"侧已同步（Style Settings 调控 UI 不搬）：
 *  - 代码高亮配色（0.3.3 对比度提升的真正落地）：CODE_PALETTES 表收录 11 变体
 *    完整 --code-* 调色板（8 亮色 + 3 暗色，自 obsidian-theme-phycat 0.3.5
 *    presets/*.json 提取；caramel 为 Typora 线独有、0.3.5 未调，借用暖色系
 *    golden 盘），CODE_TOKEN_RULES 把 Prism 令牌映射到这些变量——此前 Typora 源
 *    的高亮规则挂在 CodeMirror 类上、蒸馏时被丢弃，变量一直是死变量（暗色变体
 *    有整套 Dracula 盘却渲染 monokai），代码块实际吃 crossnote 通用主题；现在
 *    代码块底色/令牌色全部走变体调色板。构建时对 --code-comment 做 ≥4.5:1
 *    对比度断言（对合成后的 --code-block-bg），上游 0.3.3 的可读性工作由断言守住。
 *  - 文档级调色入口：front-matter `theme-vars:` / CLI `--theme-vars`（JSON）注入
 *    :root 变量覆盖（exporter.js 侧实现），对应主题"自定义任何地方颜色"的能力。
 *  - 章节自动编号（--autonum-h1..h6）：主题的编号定义在变体 :root 里、构建时被剥离
 *    （默认关，机制见 readVariant 注释）；剥离下来的定义经 11 变体一致性比对后写入
 *    lib/presets/phycat-autonum.json（全变体同值，故只此一份），启用 = 用户经
 *    --theme-vars / front-matter theme-vars 注入该 JSON（见 README「phycat-*」节）；
 *    crossnote 标题无 Typora 的 span 子元素，h3-h6 编号选择器由 AUTONUM_COMPAT 段
 *    按"同一开关"重建（默认关时逐像素等价）。
 *  - 脚注选择器重映射（FOOTNOTE_REMAP 段）：Typora 的脚注 DOM 类（.footnote-word /
 *    sup.md-footnote / .footnote-item em）在 crossnote 导出 DOM 里大多不存在，
 *    按实证的 crossnote 类名把主题视觉意图重新挂接（见该段注释）。
 *
 * 主题结构（源目录）:
 *   phycat/phycat.light.css   亮色基底（内容样式 + 编辑器界面样式混在一起）
 *   phycat/phycat.dark.css    暗色基底
 *   phycat-*.css              11 个变体，首行 @import 基底，其余只有一个
 *                             :root 变量块（强调色 / 标题图标 / 背景图案等）
 *
 * 每个变体的预设 CSS = 基底蒸馏结果 + 该变体 :root 覆盖 + @page 满版背景
 * + 字号修正 + crossnote 兼容补丁。具体做的事:
 *  1. 只保留内容样式（#write / 纯标签规则 / :root 变量 / @media print），
 *     丢弃 Typora 界面样式（侧边栏、大纲、CodeMirror、md-grid 等）。
 *  2. 选择器改写：#write/.write/.typora-export → .markdown-preview，
 *     .md-heading 类剥除（crossnote 标题无此类，否则 h3-h6 图标规则全废），
 *     .md-fences → pre，.md-alert-* → .callout[data-callout=*]，
 *     .md-alert-text-container/.md-alert-text-* → .callout-title 系列，
 *     .typora-export body → body（暗基底的页面背景色规则）。
 *  3. @font-face：Cascadia Code（436KB 等宽）base64 内联；
 *     LXGW WenKai（25MB CJK）不内联，由导出器按文档字符子集化注入
 *     （exporter.js buildInlineFontCss，字体文件在 lib/presets/fonts/）。
 *  4. @page 满版背景：Chrome 打印只有 @page background 能铺满含边距的整页。
 *     按变体机制生成——纯色（--bg-shape-none / 亮变体白底）、
 *     重着色 SVG 图案平铺（--bg-shape-cross 等，黑色笔画换成变体强调色 + 低透明度，
 *     模拟主题 mask + element-color + opacity .12 的屏幕效果）、
 *     暗变体 radial-gradient 圆点（--texture-mask-color + --texture-opacity）。
 *  5. 字号修正：主题 html 16px → 14px；标题阶梯改 px 固定值
 *     24/21/18/16/15/14（h6 与正文同号靠字重区分），不随根字号漂移。
 *  6. crossnote 兼容补丁：代码块字体/内边距、pre code 复位、callout 标题布局、
 *     按变体解析出的 callout 强调色（--callout-color，驱动 crossnote 标题图标色）。
 */

const fs = require('fs');
const path = require('path');
const { parseCssColor, luminance, contrastRatio } = require('../lib/css-color');

const SRC_DIR =
  process.argv[2] || 'C:/Users/lt/Desktop/Write/open-source-project/typora-theme-phycat';
const OUT_DIR = path.join(__dirname, '..', 'lib', 'presets');

/** 11 个变体（亮/暗归属由脚本读各文件 @import 行自动判定，此处只做清单与排序） */
const VARIANTS = [
  'phycat-cherry',
  'phycat-caramel',
  'phycat-forest',
  'phycat-mint',
  'phycat-sky',
  'phycat-prussian',
  'phycat-sakura',
  'phycat-mauve',
  'phycat-vampire',
  'phycat-radiation',
  'phycat-abyss',
];

// ---------- 顶层块扫描（@media 等嵌套块整体处理） ----------
function splitBlocks(text) {
  const blocks = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    const start = i;
    let brace = text.indexOf('{', i);
    if (brace === -1) break;
    const prelude = text.slice(start, brace).trim();
    let depth = 1;
    let j = brace + 1;
    while (j < n && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    blocks.push({ prelude, body: text.slice(brace + 1, j - 1) });
    i = j;
  }
  return blocks;
}

// ---------- 选择器改写 ----------
function rewriteSelectors(sel) {
  return (
    sel
      // 暗基底 .typora-export body 是页面背景规则，先于此保下来
      .replace(/\.typora-export\s+body/g, 'body')
      .replace(/body\.typora-export\b/g, 'body')
      .replace(/#write\b/g, '.markdown-preview')
      .replace(/\.typora-export\b/g, '.markdown-preview')
      .replace(/\.write\b/g, '.markdown-preview')
      // crossnote 标题没有 .md-heading 类，剥除否则 h3-h6 图标规则失效
      .replace(/\.md-heading\b/g, '')
      // Typora callout → crossnote callout（先长后短，避免前缀误配）
      .replace(/\.md-alert-text-container\b/g, '.callout-title')
      .replace(
        /\.md-alert-text-(note|tip|important|warning|caution)\b/g,
        '.callout[data-callout="$1"] .callout-title',
      )
      .replace(/\.md-alert-(note|tip|important|warning|caution)\b/g, '.callout[data-callout="$1"]')
      .replace(/\.md-alert-text\b/g, '.callout-title')
      .replace(/\.md-alert\b/g, '.callout')
      .replace(/\.md-fences(?![\w-])/g, 'pre')
      .replace(/\.md-task-list-item\b/g, '.task-list-item')
      // .md-alert.md-alert-note 双重改写后的冗余
      .replace(/\.callout\.callout\b/g, '.callout')
  );
}

// 编辑器/界面专用规则，即使含 #write 也丢弃
const DROP_RE =
  /md-focus|md-expand|md-meta|md-pair|md-grid|md-diagram|md-notification|code-tooltip|CodeMirror|\.cm-|ty-input|md-hover|md-tooltip|\[lang|md-toc|megamenu|sidebar|outline-|typora-source|md-image\b|md-rawblock/;

/** 保留判定：改写后的选择器是"文档内容"或"页面基础" */
function keepSelector(sel) {
  if (DROP_RE.test(sel)) return false;
  // .typora-export #write 等双重容器改写出的死规则
  if (sel.includes('.markdown-preview .markdown-preview')) return false;
  return sel.split(',').every((raw) => {
    const part = raw.trim();
    if (!part) return false;
    if (part.includes('.markdown-preview')) return true;
    // 页面基础选择器（:root / html / body / * / :host，可带伪元素/伪类）
    if (/^(:root|:host|html|body|\*)(::?[\w-]+(\([^)]*\))?)*$/.test(part)) return true;
    // 纯标签/属性/伪类选择器（code, kbd, h1, input[type=checkbox] 等）
    return !/[.#]/.test(part);
  });
}

// ---------- @font-face：Cascadia Code base64 内联，LXGW WenKai 走子集化 ----------
function processFontFace(body) {
  const fam = (body.match(/font-family:\s*("([^"]+)"|([^;]+))/) || [])[2] || (body.match(/font-family:\s*([^;]+);/) || [])[1] || '';
  if (!/CascadiaCode/i.test(fam)) return null; // LXGW WenKai 25MB 不内联
  const fontPath = path.join(SRC_DIR, 'phycat', 'Cascadia-Code-Regular.ttf');
  if (!fs.existsSync(fontPath)) throw new Error(`字体缺失: ${fontPath}`);
  const b64 = fs.readFileSync(fontPath).toString('base64');
  // 源 CSS 的 src 行没有结尾分号，不能用 [^;]+; 匹配
  const newBody = body.replace(
    /src:\s*url\([^)]*\)\s*;?/,
    `src: url("data:font/ttf;base64,${b64}") format("truetype");`,
  );
  return `@font-face {${newBody}}`;
}

// ---------- 普通规则处理 ----------
function processRule(prelude, body) {
  let sel = rewriteSelectors(prelude);
  // phycat 的 .md-alert* 规则不带 #write 前缀，改写后是裸 .callout，
  // 补 .markdown-preview 前缀（既是 crossnote 实际嵌套结构，也通过保留判定）
  sel = sel
    .split(',')
    .map((s) => {
      const t = s.trim();
      return t.startsWith('.callout') ? `.markdown-preview ${t}` : t;
    })
    .join(', ');
  if (!keepSelector(sel)) return null;
  return `${sel} {${body}}`;
}

function processLevel(text) {
  const out = [];
  for (const { prelude, body } of splitBlocks(text)) {
    if (/^@font-face/.test(prelude)) {
      const r = processFontFace(body);
      if (r) out.push(r);
    } else if (/^@media\s+print/.test(prelude)) {
      const inner = processLevel(body);
      if (inner) out.push(`@media print {\n${inner}\n}`);
    } else if (/^@media/.test(prelude)) {
      continue; // 屏幕响应式规则，导出不需要
    } else if (/^@keyframes/.test(prelude)) {
      out.push(`${prelude} {${body}}`); // 内容动画引用（task 勾选、em 缝线等）
    } else if (/^@supports/.test(prelude)) {
      const inner = processLevel(body);
      if (inner) out.push(`${prelude} {\n${inner}\n}`);
    } else if (/^@/.test(prelude)) {
      continue; // @page / @import 等丢弃（@page 由脚本按变体重新生成）
    } else {
      const r = processRule(prelude, body);
      if (r) out.push(r);
    }
  }
  return out.join('\n\n');
}

/** 蒸馏基底 css（light/dark 各一次，缓存） */
const distillCache = {};
function distillBase(mode) {
  if (distillCache[mode]) return distillCache[mode];
  const file = path.join(SRC_DIR, 'phycat', `phycat.${mode}.css`);
  let css = fs.readFileSync(file, 'utf8');
  css = css.replace(/\/\*[\s\S]*?\*\//g, ''); // 去注释
  css = css.replace(/@import\s+[^;]+;/g, ''); // 去 @import
  distillCache[mode] = processLevel(css);
  return distillCache[mode];
}

// ---------- 变体 :root 解析 ----------
/** 读变体文件：判定亮/暗，提取 :root 原文与变量表 */
function readVariant(name) {
  const file = path.join(SRC_DIR, `${name}.css`);
  let css = fs.readFileSync(file, 'utf8');
  const im = css.match(/@import\s+url\([^)]*phycat\.(light|dark)\.css[^)]*\)/);
  if (!im) throw new Error(`${name}: 未找到基底 @import 行`);
  const mode = im[1];
  css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import\s+[^;]+;/g, '');
  const blocks = splitBlocks(css);
  const rootBlock = blocks.find((b) => b.prelude === ':root');
  if (!rootBlock) throw new Error(`${name}: 缺少 :root 变量块`);
  // 变量表：按 "--name:" 出现位置切分（值里的 data URI 含分号，不能 split(';')）
  const vars = {};
  const re = /(--[\w-]+)\s*:/g;
  const matches = [];
  let m;
  while ((m = re.exec(rootBlock.body))) matches.push(m);
  for (let k = 0; k < matches.length; k++) {
    const valStart = matches[k].index + matches[k][0].length;
    const valEnd = k + 1 < matches.length ? matches[k + 1].index : rootBlock.body.length;
    vars[matches[k][1]] = rootBlock.body
      .slice(valStart, valEnd)
      .replace(/;\s*$/, '')
      .trim();
  }
  // 自动编号默认关闭：剥离 --autonum-* 变量（主题自身的开关机制——
  // 变量未定义时 content: var(--autonum-hN) 失效，::before 不生成编号盒）。
  // 剥离的定义不丢弃：主流程收集全部变体的 --autonum-h1..h6（活跃定义）做一致性
  // 比对后写入 lib/presets/phycat-autonum.json，用户经 --theme-vars 注入即开启编号。
  const rootBody = rootBlock.body.replace(/^\s*--autonum-[\w-]+\s*:[^;]*;?\s*$/gm, '');
  // 变体里 :root 之外的规则（理论上没有，兜底也蒸馏进去）
  const extra = blocks
    .filter((b) => b.prelude !== ':root' && !/^@/.test(b.prelude))
    .map((b) => processRule(b.prelude, b.body))
    .filter(Boolean)
    .join('\n\n');
  return { mode, rootCss: `:root {${rootBody}}`, vars, extra };
}

/** 解析变量引用（最多 3 层），取不到返回 null */
function resolveVar(vars, name, depth = 0) {
  if (depth > 3) return null;
  const v = vars[name];
  if (!v) return null;
  const ref = v.match(/^var\((--[\w-]+)\)$/);
  if (ref) return resolveVar(vars, ref[1], depth + 1);
  return v;
}

function hexToRgb(hex) {
  const m = hex.replace('%23', '#').match(/#([0-9a-fA-F]{6})/);
  if (!m) return null;
  return [
    parseInt(m[1].slice(0, 2), 16),
    parseInt(m[1].slice(2, 4), 16),
    parseInt(m[1].slice(4, 6), 16),
  ];
}

// ---------- @page 满版背景 ----------
// Chrome 打印只有 @page background 能铺满整张 A4（含边距）；边距即正文与页面边缘的距离。
// 变体机制：--bg-style 是 mask 图案（配 --element-color/.12 透明度）或暗色 radial-gradient
// 圆点（--texture-mask-color/--texture-opacity）。@page 不支持 mask，图案改为把 SVG 笔画
// 重着色为强调色 + 低透明度后直接平铺，视觉等价。
function pageBackgroundRule({ mode, vars }) {
  const bg = mode === 'dark' ? resolveVar(vars, '--bg-color') || '#000' : '#ffffff';
  const style = resolveVar(vars, '--bg-style');
  const parts = [`background-color: ${bg};`];
  if (style && !/bg-shape-none/.test(vars['--bg-style'] || '')) {
    if (style.startsWith('url(')) {
      // SVG 图案：黑色笔画 → 变体强调色，透明度模拟主题 mask 的 opacity .12
      const colorName = mode === 'dark' ? '--texture-mask-color' : '--element-color';
      const rgb = hexToRgb(resolveVar(vars, colorName) || '');
      if (rgb) {
        const hex = `%23${rgb.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
        const opacity = mode === 'dark' ? vars['--texture-opacity'] || '0.05' : '0.12';
        const img = style
          .replace(/stroke='black'/g, `stroke='${hex}' stroke-opacity='${opacity}'`)
          .replace(/fill='black'/g, `fill='${hex}' fill-opacity='${opacity}'`);
        parts.push(`background-image: ${img};`, `background-size: 20px 20px;`);
      }
    } else if (style.startsWith('radial-gradient')) {
      // 暗色变体圆点：白点换成纹理色并内联透明度
      const rgb = hexToRgb(resolveVar(vars, '--texture-mask-color') || '');
      const opacity = vars['--texture-opacity'] || '0.05';
      if (rgb) {
        parts.push(
          `background-image: radial-gradient(rgba(${rgb.join(',')},${opacity}) 1px, transparent 1px);`,
          `background-size: 20px 20px;`,
        );
      }
    }
  }
  // 底色层（必须保留：暗色变体靠它铺深色底）与图案层分离——图案层包在
  // MPE-BG-PATTERN 标记里，导出时默认剥离（网格/圆点打印不友好），
  // 用 --bg-pattern / front-matter bg-pattern: true 手动保留
  const base = `/* PDF 满版背景：铺满整页（含页边距）。图案层默认剥离，--bg-pattern 开启 */\n@page {\n    background-color: ${bg};\n}`;
  if (parts.length === 1) return base;
  return (
    base +
    `\n/* MPE-BG-PATTERN-BEGIN */\n@page {\n    ${parts.slice(1).join('\n    ')}\n}\n/* MPE-BG-PATTERN-END */`
  );
}

// ---------- callout 强调色（--callout-color，驱动 crossnote 标题图标/文字色） ----------
function calloutColorOverrides(cssText, vars) {
  const rules = [];
  const re =
    /\.callout\[data-callout="(note|tip|important|warning|caution)"\][^{}]*\.callout-title\s*\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(cssText))) {
    const color = (m[2].match(/color:\s*([^;}]+)/) || [])[1];
    if (!color) continue;
    let value = color.trim();
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    if (ref) value = resolveVar(vars, ref[1]) || '';
    const rgb = hexToRgb(value);
    if (!rgb) continue;
    rules.push(
      `.markdown-preview .callout[data-callout="${m[1]}"] { --callout-color: ${rgb.join(',')}; }`,
    );
  }
  return rules.join('\n');
}

// ---------- 字号体系与打印排版修正（用户既定政策） ----------
const TYPOGRAPHY_FIX = `
/* ============ 字号体系与打印排版修正（生成脚本追加） ============ */

/* 根字号 16px → 14px：正文 14px，主题 rem 间距等比跟随 */
html { font-size: 14px; }

/* 标题阶梯（px 固定）：h1 24 / h2 21 / h3 18 / h4 16 / h5 15 / h6 14
   （h6 与正文同号，靠字重区分；不随根字号漂移） */
.markdown-preview h1 { font-size: 24px; }
.markdown-preview h2 { font-size: 21px; }
.markdown-preview h3 { font-size: 18px; }
.markdown-preview h4 { font-size: 16px; }
.markdown-preview h5 { font-size: 15px; }
.markdown-preview h6 { font-size: 14px; }

@media print {
    .markdown-preview { padding-top: 0; padding-bottom: 0; }
    .markdown-preview > h1:first-child { margin-top: 0; }
}
`;

const COMPAT = `
/* ============ crossnote 兼容补丁（生成脚本追加） ============ */

/* crossnote 预览容器：居中（原 #write 规则已带 max-width: var(--max-width)） */
.markdown-preview { margin: 0 auto; }

/* 列表项竖线装饰依赖 Typora 的 li 相对定位，导出环境 li 静态定位会错位成
   贯穿整页的线条，直接去掉（主题 @media print 里也是这么处理的） */
.markdown-preview li:before { content: none; }

/* Chrome 原生打印分页（不加 --footer 时）会把 li 从内部切成两页
   （fragmentainer 切片），且跨页 li 的 ::marker 在续页重复绘制、
   续页首行缩进丢失——含行内公式的长条目看起来像被搬到条末（串行 bug）。
   实测：同样含 dfrac 的长任务条目，加 --footer（JS 分页器整 li 搬运）
   正常、不加 --footer（Chrome 原生分页）必串行；且与 - [ ] / - 无关。
   修法：li 禁止从内部切断（整条目要么整块留本页、要么整体移下页，
   与 callout/图片同一待遇）。JS 分页器（footer.js）本来就按 li 整块
   搬运，不受本规则影响。超长单 li 仍可溢出（兜底），但不再静默切碎。
   注意：HAS 布局下 break-inside:avoid 会连带其块级祖先 li 一起避免
   中断。主题的 @media print 已有 li{break-inside:avoid}，这里把选择器
   提到顶层使两条 PDF 路径（原生 + JS 分页）都生效。 */
.markdown-preview li { break-inside: avoid; page-break-inside: avoid; }

/* 代码块：主题里代码样式挂在 CodeMirror 上（已丢弃），这里补给导出用 pre */
.markdown-preview pre {
    font-family: CascadiaCode, "Lucida Console", Consolas, Courier, monospace;
    font-size: 0.9rem;
    line-height: 1.6;
    padding: 12px 16px;
    border-radius: 8px;
    overflow-x: auto;
}

/* 行内 code 规则会波及 pre code，复位块内代码。
   主题行内 code 规则带 :not(.md-fencescode)，特异度 (0,2,1) 高于普通 pre code 复位，
   这里逐个属性 !important 压过 */
.markdown-preview pre code,
.markdown-preview pre tt {
    background: none !important;
    background-color: transparent !important;
    color: inherit !important;
    border: none !important;
    padding: 0 !important;
    margin: 0 !important;
    border-radius: 0 !important;
    vertical-align: baseline !important;
    letter-spacing: normal !important;
    font-size: inherit;
    line-height: inherit;
}
`;

/** 代码块头部栏（红绿灯 + 语言标签），按基底亮/暗给两套配色。
 * 复刻主题 .md-fences:not([lang=mermaid])::before——该规则因含 [lang 属性选择器
 * 被 DROP_RE 误丢，且 crossnote 的 pre 用 data-info 存语言名而非 lang，故单独重建。
 * 行号是 Typora 编辑器 gutter 特性，crossnote 静态导出没有对应结构，不复刻。 */
const FENCE_TRAFFIC_SVG =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZlcnNpb249IjEuMSIgeD0iMHB4IiB5PSIwcHgiIHdpZHRoPSI0NTBweCIgaGVpZ2h0PSIxMzBweCI+CiAgPGVsbGlwc2UgY3g9IjY1IiBjeT0iNjUiIHJ4PSI1MCIgcnk9IjUyIiBzdHJva2U9InJnYigyMjAsNjAsNTQpIiBzdHJva2Utd2lkdGg9IjIiIGZpbGw9InJnYigyMzcsMTA4LDk2KSIvPgogIDxlbGxpcHNlIGN4PSIyMjUiIGN5PSI2NSIgcng9IjUwIiByeT0iNTIiICBzdHJva2U9InJnYigyMTgsMTUxLDMzKSIgc3Ryb2tlLXdpZHRoPSIyIiBmaWxsPSJyZ2IoMjQ3LDE5Myw4MSkiLz4KICA8ZWxsaXBzZSBjeD0iMzg1IiBjeT0iNjUiIHJ4PSI1MCIgcnk9IjUyIiAgc3Ryb2tlPSJyZ2IoMjcsMTYxLDM3KSIgc3Ryb2tlLXdpZHRoPSIyIiBmaWxsPSJyZ2IoMTAwLDIwMCw4NikiLz4KPC9zdmc+';

function codeBlockHeaderRule(mode) {
  const dark = mode === 'dark';
  return `
/* 代码块头部栏：红绿灯 + 右上角语言标签（主题的标志性卡片头） */
.markdown-preview pre[data-role="codeBlock"]:not([data-info="mermaid"]) {
    padding-top: 0;
}
.markdown-preview pre[data-role="codeBlock"]:not([data-info="mermaid"])::before {
    content: attr(data-info);
    display: block;
    margin: 0 -16px 10px; /* 抵消 pre 的 16px 左右内边距，头部栏通宽 */
    padding: 0 15px;
    height: 32px;
    line-height: 32px;
    text-align: right;
    font-size: 12px;
    color: ${dark ? '#6272a4' : '#7e7e7e'};
    background: url("${FENCE_TRAFFIC_SVG}") no-repeat 8px 11px / 40px,
      ${dark ? 'color-mix(in srgb, var(--secondary-color), transparent 95%)' : 'var(--code-block-bg, #f8f8f8)'};
    ${dark ? 'border-bottom: 1px solid color-mix(in srgb, var(--secondary-color), transparent 90%);' : ''}
    border-radius: 8px 8px 0 0;
}
`;
}

const COMPAT_EXTRA = `
/* callout 标题布局：抵消 crossnote 默认样式的负边距/图标留白，套用主题胶囊排版。
   胶囊减重（小一号字号/紧凑 padding/去掉下外边距），避免"头重脚轻" */
.markdown-preview .callout > .callout-title {
    margin: 0;
    padding: 2px 9px 2px 1.7rem;
    font-size: 12.5px;
}
.markdown-preview .callout .callout-title::before {
    left: 0.6rem;
    font-size: 0.9rem;
}
/* 胶囊下方不再叠 crossnote 默认的 1rem 段距：消除标题与正文间的突兀空白 */
.markdown-preview .callout > .callout-title + p {
    margin-block-start: 0.35rem;
}
.markdown-preview .callout > p:last-child {
    margin-block-end: 0.35rem;
}
`;

// ---------- 图片对齐语法（同步自 obsidian-theme-phycat 0.3.x，9b41707 2026-03-05） ----------
// 主题机制：alt 文本含 right/+R/left/+L/center/+C/banner 时图片对齐 + 圆角阴影，
// banner 额外通栏裁切。Obsidian 版规则挂在 .image-embed 包裹层上用 flex 对齐；
// crossnote 导出的图片是裸 <img>（段落内 <p><img></p>，无包裹层），这里改用
// 块级 + margin 自对齐实现同等排版，不依赖 :has()/flex，分页器按图片块整搬不受影响。
// 特异度要点：crossnote 自带 .markdown-preview p>img:only-child { display:block;
// margin:20px auto }（独立图片默认居中，特异度 (0,2,2)）会压过普通属性写法，
// 故对齐相关的 margin/width 一律 !important。无关键词的图片保持 crossnote
// 默认居中行为不动（既有文档依赖它）。阴影用主题 0.2.9 的固定 rgba
// （Obsidian 0.3.5 换成的 --phycat-interface-box-shadow 变量在预设里不存在）。
const IMAGE_ALIGN_RULES = `
/* ============ 图片对齐语法（同步自 obsidian-theme-phycat 0.3.x） ============ */
/* 用法：![center](img.png) / ![right](img.png) / ![banner](img.png)，
   缩写 +C / +R / +L 同义；alt 含关键词即触发（与主题一致，子串匹配）。
   不带关键词的图片维持 crossnote 独立图片默认居中，不受影响 */
.markdown-preview p>img[alt*="right" i],
.markdown-preview p>img[alt*="+R" i],
.markdown-preview p>img[alt*="left" i],
.markdown-preview p>img[alt*="+L" i],
.markdown-preview p>img[alt*="center" i],
.markdown-preview p>img[alt*="+C" i],
.markdown-preview p>img[alt*="banner" i] {
    display: block;
    margin-top: 0.5rem !important;
    margin-bottom: 0.5rem !important;
    border-radius: 8px;
    box-shadow: 0 4px 15px rgba(0, 0, 0, 0.05);
}
.markdown-preview p>img[alt*="right" i],
.markdown-preview p>img[alt*="+R" i] {
    margin-left: auto !important;
    margin-right: 0 !important;
}
.markdown-preview p>img[alt*="left" i],
.markdown-preview p>img[alt*="+L" i] {
    margin-left: 0 !important;
    margin-right: auto !important;
}
.markdown-preview p>img[alt*="center" i],
.markdown-preview p>img[alt*="+C" i] {
    margin-left: auto !important;
    margin-right: auto !important;
}
.markdown-preview p>img[alt*="banner" i] {
    width: 100% !important;
    max-height: 250px;
    object-fit: cover;
    border-radius: 12px;
    margin-left: auto !important;
    margin-right: auto !important;
}
`;

// ---------- mermaid 图表主题色（同步自 obsidian-theme-phycat，源自其 0.2.x 引入的
// "mermaid 只保留颜色定义"方案，0.3.3 收敛选择器后定型） ----------
// 预设此前完全没有 mermaid 规则（Typora 源也没有）：图表靠 crossnote 的
// mermaidTheme（暗色变体 dark、亮色 default）兜底。这里按主题的规则给流程图
// 节点/子图/连线标签上变体主题色；时序图等其余图型主题自己也交给 mermaid
// 原生主题（actor 着色挂在随机 ID 选择器上，0.3.x 未收敛），故不搬运。
// 变量映射注意：主题 --phycat-primary-color → 预设 --element-color；但 Typora 源里
// --element-color 只有亮色变体定义，三个暗色变体只有 --primary-color（缺变量会让
// color-mix 整条非法、节点回落 mermaid 注入的灰色，实测暗色变体翻车）——所有引用
// 一律写成 var(--element-color, var(--primary-color)) 双兜底。--secondary-color 同理
// 只有暗色变体定义，链尾再兜 --element-color；亮色变体菱形节点曾因缺它回落到
// mermaid 注入的 #mermaid-xxx{fill:#333} 继承链变黑块。连线标签是浅色胶囊底，
// 补主题没写的深色文字，暗色变体下才可读。
const MERMAID_RULES = `
/* ============ mermaid 图表主题色（同步自 obsidian-theme-phycat） ============ */
.markdown-preview .mermaid {
    display: block;
    width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
    margin: 1em 0;
    padding-bottom: 8px;
    text-align: center;
    background-color: transparent !important;
}
.markdown-preview .mermaid .node rect,
.markdown-preview .mermaid .node circle,
.markdown-preview .mermaid .node ellipse,
.markdown-preview .mermaid .node path {
    fill: color-mix(in srgb, var(--element-color, var(--primary-color)), transparent 90%) !important;
    stroke: var(--element-color, var(--primary-color)) !important;
    stroke-width: 1.5px !important;
    opacity: 1 !important;
}
.markdown-preview .mermaid .node polygon {
    fill: color-mix(in srgb, var(--secondary-color, var(--element-color, var(--primary-color))), transparent 85%) !important;
    stroke: var(--secondary-color, var(--element-color, var(--primary-color))) !important;
    stroke-width: 1.5px !important;
}
.markdown-preview .mermaid .label,
.markdown-preview .mermaid foreignObject,
.markdown-preview .mermaid foreignObject div,
.markdown-preview .mermaid foreignObject span,
.markdown-preview .mermaid foreignObject p,
.markdown-preview .mermaid span.nodeLabel {
    font-size: 12px !important;
}
.markdown-preview .edgeLabel p,
.markdown-preview .edgeLabel span,
.markdown-preview .edgeLabel foreignObject {
    background-color: color-mix(in srgb, var(--element-color, var(--primary-color)), white 90%) !important;
    color: #1c1719 !important;
}
.markdown-preview .edgeLabel p {
    border: 1px solid var(--element-color, var(--primary-color)) !important;
    border-radius: 4px !important;
    letter-spacing: 0 !important;
    padding: 0 3px;
}
.markdown-preview .cluster rect {
    fill: color-mix(in srgb, var(--secondary-color, var(--element-color, var(--primary-color))), transparent 90%) !important;
    stroke: var(--secondary-color, var(--element-color, var(--primary-color))) !important;
    stroke-width: 1px !important;
    stroke-linejoin: round;
}
.markdown-preview .statediagram-cluster rect {
    fill: color-mix(in srgb, var(--element-color, var(--primary-color)), white 90%) !important;
    stroke: var(--element-color, var(--primary-color)) !important;
}
.markdown-preview .mermaid * {
    letter-spacing: 0;
}
.markdown-preview .mermaid foreignObject {
    overflow: visible !important;
}
.markdown-preview .mermaid .node .label,
.markdown-preview .mermaid .label {
    stroke: none !important;
}
`;

// ---------- 代码高亮调色板（0.3.3 对比度工作的落地，自 obsidian-theme-phycat
// 0.3.5 presets/light|dark/*.json 提取，键 phycat-colors@@code-*@@light|dark） ----------
// 此前 Typora 源的高亮规则挂在 CodeMirror 类上、蒸馏时被丢弃：亮色变体完全没有
// --code-* 变量，暗色变体有整套 Dracula 盘却是死变量，代码块实际渲染 crossnote
// 通用主题（亮 github.css / 暗 monokai.css）。这里给全部 11 个变体收录完整
// --code-* 调色板（暗色覆盖蒸馏进来的 Typora 旧值），CODE_TOKEN_RULES 把 Prism
// 令牌消费到这些变量。caramel 是 Typora 线独有变体、0.3.5 未调，借用暖色系
// golden 盘（两变体同属橙棕家族）。
const CODE_PALETTES = {
  'cherry': { 'code-block-bg': 'rgba(177, 108, 108, 0.02)', 'code-normal': 'rgb(74, 13, 24)', 'code-keyword': 'rgb(194, 24, 91)', 'code-function': 'rgb(211, 47, 47)', 'code-string': 'rgb(46, 125, 50)', 'code-comment': '#81655b', 'code-property': 'rgb(0, 191, 188)', 'code-value': 'rgb(230, 81, 0)', 'code-punctuation': 'rgb(135, 14, 14)', 'code-tag': 'rgb(194, 24, 91)', 'code-operator': 'rgb(211, 47, 47)', 'code-important': 'rgb(194, 24, 91)' },
  'caramel': { 'code-block-bg': '#fff7ed', 'code-normal': 'rgb(93, 64, 55)', 'code-keyword': 'rgb(216, 67, 21)', 'code-function': 'rgb(245, 127, 23)', 'code-string': 'rgb(104, 159, 56)', 'code-comment': '#7d6963', 'code-property': 'rgb(0, 191, 188)', 'code-value': 'rgb(230, 81, 0)', 'code-punctuation': 'rgb(141, 110, 99)', 'code-tag': 'rgb(216, 67, 21)', 'code-operator': 'rgb(245, 127, 23)', 'code-important': 'rgb(216, 67, 21)' },
  'forest': { 'code-block-bg': '#f9fffb', 'code-normal': 'rgb(56, 58, 66)', 'code-keyword': 'rgb(166, 38, 164)', 'code-function': 'rgb(64, 120, 242)', 'code-string': 'rgb(80, 161, 79)', 'code-comment': '#696b6e', 'code-property': 'rgb(64, 120, 242)', 'code-value': 'rgb(152, 104, 1)', 'code-punctuation': 'rgb(56, 58, 66)', 'code-tag': 'rgb(228, 86, 73)', 'code-operator': 'rgb(1, 132, 188)', 'code-important': 'rgb(166, 38, 164)' },
  'mint': { 'code-block-bg': '#f0fcff', 'code-normal': 'rgb(55, 71, 79)', 'code-keyword': 'rgb(0, 151, 167)', 'code-function': 'rgb(2, 119, 189)', 'code-string': 'rgb(0, 105, 92)', 'code-comment': '#626f77', 'code-property': 'rgb(0, 105, 92)', 'code-value': 'rgb(245, 127, 23)', 'code-punctuation': 'rgb(84, 110, 122)', 'code-tag': 'rgb(0, 151, 167)', 'code-operator': 'rgb(2, 119, 189)', 'code-important': 'rgb(0, 151, 167)' },
  'sky': { 'code-block-bg': '#ebf5fb', 'code-normal': 'rgb(36, 41, 46)', 'code-keyword': 'rgb(215, 58, 73)', 'code-function': 'rgb(111, 66, 193)', 'code-string': 'rgb(3, 47, 98)', 'code-comment': '#646c76', 'code-property': 'rgb(0, 92, 197)', 'code-value': 'rgb(0, 92, 197)', 'code-punctuation': 'rgb(36, 41, 46)', 'code-tag': 'rgb(34, 134, 58)', 'code-operator': 'rgb(215, 58, 73)', 'code-important': 'rgb(215, 58, 73)' },
  'prussian': { 'code-block-bg': '#EBF5FA', 'code-normal': 'rgb(55, 71, 79)', 'code-keyword': 'rgb(2, 119, 189)', 'code-function': 'rgb(0, 96, 100)', 'code-string': 'rgb(46, 125, 50)', 'code-comment': '#5d6a71', 'code-property': 'rgb(0, 191, 188)', 'code-value': 'rgb(230, 81, 0)', 'code-punctuation': 'rgb(69, 90, 100)', 'code-tag': 'rgb(2, 119, 189)', 'code-operator': 'rgb(0, 96, 100)', 'code-important': 'rgb(2, 119, 189)' },
  'sakura': { 'code-block-bg': '#fff4f8', 'code-normal': 'rgb(84, 110, 122)', 'code-keyword': 'rgb(216, 27, 96)', 'code-function': 'rgb(142, 36, 170)', 'code-string': 'rgb(46, 125, 50)', 'code-comment': '#666d71', 'code-property': 'rgb(0, 137, 123)', 'code-value': 'rgb(245, 124, 0)', 'code-punctuation': 'rgb(120, 144, 156)', 'code-tag': 'rgb(216, 27, 96)', 'code-operator': 'rgb(142, 36, 170)', 'code-important': 'rgb(216, 27, 96)' },
  'mauve': { 'code-block-bg': '#F2EFF9', 'code-normal': 'rgb(74, 20, 140)', 'code-keyword': 'rgb(186, 104, 200)', 'code-function': 'rgb(123, 31, 162)', 'code-string': 'rgb(46, 125, 50)', 'code-comment': '#626887', 'code-property': 'rgb(0, 191, 188)', 'code-value': 'rgb(245, 124, 0)', 'code-punctuation': 'rgb(106, 27, 154)', 'code-tag': 'rgb(186, 104, 200)', 'code-operator': 'rgb(123, 31, 162)', 'code-important': 'rgb(186, 104, 200)' },
  'vampire': { 'code-block-bg': '#282a36', 'code-normal': 'rgb(248, 248, 242)', 'code-keyword': 'rgb(255, 121, 198)', 'code-function': 'rgb(80, 250, 123)', 'code-string': 'rgb(241, 250, 140)', 'code-comment': '#919dbf', 'code-property': 'rgb(102, 217, 239)', 'code-value': 'rgb(189, 147, 249)', 'code-punctuation': 'rgb(248, 248, 242)', 'code-tag': 'rgb(255, 121, 198)', 'code-operator': 'rgb(255, 121, 198)', 'code-important': 'rgb(255, 121, 198)' },
  'abyss': { 'code-block-bg': '#0f111a', 'code-normal': 'rgb(214, 222, 235)', 'code-keyword': 'rgb(199, 146, 234)', 'code-function': 'rgb(130, 170, 255)', 'code-string': 'rgb(236, 196, 141)', 'code-comment': '#788989', 'code-property': 'rgb(128, 203, 196)', 'code-value': 'rgb(247, 140, 108)', 'code-punctuation': 'rgb(214, 222, 235)', 'code-tag': 'rgb(255, 83, 112)', 'code-operator': 'rgb(137, 221, 255)', 'code-important': 'rgb(199, 146, 234)' },
  'radiation': { 'code-block-bg': '#1b1d1b', 'code-normal': 'rgb(230, 230, 230)', 'code-keyword': 'rgb(255, 203, 107)', 'code-function': 'rgb(76, 217, 100)', 'code-string': 'rgb(195, 232, 141)', 'code-comment': '#7e929b', 'code-property': 'rgb(76, 217, 100)', 'code-value': 'rgb(247, 140, 108)', 'code-punctuation': 'rgb(230, 230, 230)', 'code-tag': 'rgb(255, 83, 112)', 'code-operator': 'rgb(137, 221, 255)', 'code-important': 'rgb(255, 203, 107)' },
};

function codePaletteRootCss(name) {
  // VARIANTS 清单里是 phycat-xxx 全名，表键用裸色名
  const row = CODE_PALETTES[name.replace(/^phycat-/, '')];
  if (!row) throw new Error(`CODE_PALETTES 缺少变体: ${name}`);
  const lines = Object.entries(row)
    .map(([k, v]) => `    --${k}: ${v};`)
    .join('\n');
  return `/* ============ 代码高亮调色板（obsidian-theme-phycat 0.3.5，${name}） ============ */\n:root {\n${lines}\n}`;
}

// Prism 令牌 → 调色板变量（分组沿用 build-onepage-preset.js 的模板；
// 特异度 .markdown-preview pre code .token.x 压过 codeBlockTheme 的 token 规则，
// 预设 CSS 后于 codeBlockTheme 注入，同特异性时靠文档顺序获胜）
const CODE_TOKEN_RULES = `
/* ============ 代码高亮令牌映射（消费上方 --code-* 调色板） ============ */
.markdown-preview pre {
    background-color: var(--code-block-bg);
}
.markdown-preview pre code {
    /* !important 压过 COMPAT 段 pre code 复位的 color: inherit !important */
    color: var(--code-normal) !important;
}
.markdown-preview pre code .token.comment,
.markdown-preview pre code .token.prolog,
.markdown-preview pre code .token.doctype,
.markdown-preview pre code .token.cdata { color: var(--code-comment); }
.markdown-preview pre code .token.keyword,
.markdown-preview pre code .token.selector,
.markdown-preview pre code .token.atrule { color: var(--code-keyword); }
.markdown-preview pre code .token.string,
.markdown-preview pre code .token.char,
.markdown-preview pre code .token.attr-value,
.markdown-preview pre code .token.regex { color: var(--code-string); }
.markdown-preview pre code .token.function,
.markdown-preview pre code .token.class-name { color: var(--code-function); }
.markdown-preview pre code .token.property,
.markdown-preview pre code .token.attr-name,
.markdown-preview pre code .token.parameter { color: var(--code-property); }
.markdown-preview pre code .token.number,
.markdown-preview pre code .token.boolean,
.markdown-preview pre code .token.constant,
.markdown-preview pre code .token.symbol,
.markdown-preview pre code .token.builtin { color: var(--code-value); }
.markdown-preview pre code .token.operator { color: var(--code-operator); }
.markdown-preview pre code .token.punctuation { color: var(--code-punctuation); }
.markdown-preview pre code .token.tag { color: var(--code-tag); }
.markdown-preview pre code .token.important { color: var(--code-important); }
`;

// ---------- 标题颜色变量化（给 theme-vars 提供可覆盖入口，不改默认观感） ----------
// 每级标题消费 --h1-color..--h6-color；fallback = 追加前该标题的实际计算色：
//   亮色基底 h1 硬编码 #222、h2 走 --head-title-h2-color（变体 :root 定义）、h3-h6
//   无静态 color（继承正文）→ fallback inherit；
//   暗色基底给 h1..h6 分组规则 color: var(--text-color) → fallback var(--text-color)。
// 追加段位于文档后部、与蒸馏规则同特异度，靠文档顺序生效；默认渲染不变。
function headingColorVarsRules(mode) {
  const dark = mode === 'dark';
  const fb = {
    1: dark ? 'var(--h1-color, var(--text-color))' : 'var(--h1-color, #222)',
    2: dark ? 'var(--h2-color, var(--text-color))' : 'var(--h2-color, var(--head-title-h2-color))',
    3: dark ? 'var(--h3-color, var(--text-color))' : 'var(--h3-color, inherit)',
    4: dark ? 'var(--h4-color, var(--text-color))' : 'var(--h4-color, inherit)',
    5: dark ? 'var(--h5-color, var(--text-color))' : 'var(--h5-color, inherit)',
    6: dark ? 'var(--h6-color, var(--text-color))' : 'var(--h6-color, inherit)',
  };
  return `
/* ============ 标题颜色变量化（生成脚本追加，供 --theme-vars 覆盖） ============ */
/* fallback 与追加前的计算值一致（亮: h1 #222 / h2 --head-title-h2-color / h3-h6 继承；
   暗: 全部 --text-color）。覆盖入口见 README「phycat-*」节。 */
.markdown-preview h1 { color: ${fb[1]}; }
.markdown-preview h2 { color: ${fb[2]}; }
.markdown-preview h3 { color: ${fb[3]}; }
.markdown-preview h4 { color: ${fb[4]}; }
.markdown-preview h5 { color: ${fb[5]}; }
.markdown-preview h6 { color: ${fb[6]}; }
`;
}

// ---------- 章节自动编号兼容（crossnote DOM 适配，默认关、注入 autonum JSON 即开） ----------
// 基底蒸馏的 h3-h6 编号规则挂在 Typora 的 hN>span:first-of-type 上，而 crossnote 导出
// 的标题是纯 <hN>文本</hN>（探针实证，无 span 子元素），那批选择器全部落空。这里在
// hN::before 上用主题同一开关机制重建编号：--autonum-hN 未定义时各 var() 取 fallback
// （与蒸馏装饰规则逐像素一致）；定义时 var() 替换出非法值、属性回落初始值，装饰条/
// 圆点/短横退位成普通行内编号。counter-increment 需要 ::before 盒存在：关闭态 content
// 为 ''/占位字符、盒仍生成，计数器静默自增无显示；开启态 content 为编号文本。
// 编号颜色：Typora 里 h3-h6 编号用 --element-color 强调色，但导出端 ::before 只有一个，
// 颜色无法与内容开关解耦（激活时整条 var() 失效回落），编号继承标题本色。
// h1/h2 编号由蒸馏规则直接承载（其 ::before 空闲），不在此段。
function autonumCompatRules(mode) {
  const light = mode === 'light';
  const h4Border = light
    ? '\n    border: var(--autonum-h4, 1px solid var(--head-title-color));'
    : '';
  return `
/* ============ 章节自动编号兼容（生成脚本追加，注入 phycat-autonum.json 即开启） ============ */
/* counter 作用域与自增位置（Chrome 实证三轮翻车后的最终形态）：
   1) 作用域必须由 counter-reset 建立——无 reset 时每个 ::before 各自隐式建 0 起步的
      计数器（编号恒为 1）。蒸馏的 .markdown-preview { counter-reset: h1 } 把作用域
      锚在预览容器上，而分页器每页的 .mpe-sheet-body 都带 markdown-preview 类
      （footer.js createSheet），每页重建作用域，第 2 页起编号错成 0.x。
   2) 自增必须挂在标题元素上——挂在 ::before 上时自增值不出标题子树，跨页后计数
      不连续（实测第 2 页 h2 全部重置为 1）。元素级自增 + ::before 只读显示是
      CSS 规范的标准编号形态，分页器整块搬移 DOM 不影响。
   3) 重置必须用 counter-set 而不是 counter-reset——作用域全部锚在 body 后，元素上的
      counter-reset 会被 Chrome 忽略（正文读到的是 body 级同名计数器，实测 h1 上的
      h2 reset 失效、2.x 持续累加）；counter-set 直接改写 body 级计数器的值，
      重置与跨页接续同时成立（矩阵实测：reset 于同页失效，set 正确给出 2.1/2.2/2.3）。
      六级作用域都锚 body：分页边界只延续 body 级作用域。蒸馏的各元素 counter-reset
      统一撤成 none（既已无效也无害，撤掉防将来 Chrome 行为变化）。编号关闭时
      计数器无显示，以上规则均无观感影响。 */
body { counter-reset: h1 h2 h3 h4 h5 h6; }
.markdown-preview { counter-reset: none; }
.markdown-preview h1, .markdown-preview h2, .markdown-preview h3,
.markdown-preview h4, .markdown-preview h5, .markdown-preview h6 { counter-reset: none; }
.markdown-preview h1 { counter-increment: h1; counter-set: h2 0 h3 0 h4 0 h5 0 h6 0; }
.markdown-preview h2 { counter-increment: h2; counter-set: h3 0 h4 0 h5 0 h6 0; }
.markdown-preview h3 { counter-increment: h3; counter-set: h4 0 h5 0 h6 0; }
.markdown-preview h4 { counter-increment: h4; counter-set: h5 0 h6 0; }
.markdown-preview h5 { counter-increment: h5; counter-set: h6 0; }
.markdown-preview h6 { counter-increment: h6; }
/* 蒸馏规则把 h1/h2 自增挂在 ::before 上——编号开启时 ::before 盒生成、会与元素级
   自增叠加成 1/3/5，这里关掉（::before 只保留显示职责）。编号关闭时 ::before 盒
   不生成、自增本就不生效，关掉无影响。 */
.markdown-preview h1:before,
.markdown-preview h2:before { counter-increment: none; }
.markdown-preview h3::before {
    content: var(--autonum-h3, '');
    position: var(--autonum-h3, absolute);
    left: var(--autonum-h3, ${light ? '-6px' : '0'});
    top: var(--autonum-h3, 50%);
    transform: var(--autonum-h3, translateY(-50%));
    width: var(--autonum-h3, ${light ? '5px' : '4px'});
    height: var(--autonum-h3, ${light ? '61%' : '16px'});
    border-radius: var(--autonum-h3, ${light ? '4px' : '2px'});
    background-color: var(--autonum-h3, ${light ? 'var(--head-title-color)' : 'var(--primary-color)'});
    opacity: var(--autonum-h3, ${light ? '1' : '.8'});
}
.markdown-preview h4::before {
    content: var(--autonum-h4, '');
    width: var(--autonum-h4, ${light ? '10px' : '8px'});
    height: var(--autonum-h4, ${light ? '10px' : '8px'});
    border-radius: var(--autonum-h4, ${light ? '100%' : '50%'});
    background-color: var(--autonum-h4, ${light ? 'var(--head-title-color)' : 'var(--primary-color)'});${h4Border}
}
.markdown-preview h5::before {
    content: var(--autonum-h5, '');
    width: var(--autonum-h5, ${light ? '10px' : '8px'});
    height: var(--autonum-h5, ${light ? '10px' : '8px'});
    border-radius: var(--autonum-h5, ${light ? '100%' : '50%'});
    background-color: var(--autonum-h5, ${light ? '#fff' : 'transparent'});
    border: var(--autonum-h5, ${light ? '2px solid var(--head-title-color)' : '1.5px solid var(--primary-color)'});
}
.markdown-preview h6::before {
    content: var(--autonum-h6, '-');
    color: var(--autonum-h6, ${light ? 'var(--head-title-color)' : 'var(--primary-color)'});
}
`;
}

// ---------- 脚注选择器重映射（Typora 类 → crossnote 实际 DOM） ----------
// 实证（tmp 探针导出 HTML + crossnote remarkable 渲染器源码），crossnote 脚注 DOM：
//   上标引用  <sup class="footnote-ref"><a href="#fn1" id="fnref1">[1]</a></sup>
//   尾注区    <hr class="footnotes-sep"> <section class="footnotes"> <ol class="footnotes-list">
//   条目      <li id="fn1" class="footnote-item"><p>… <a class="footnote-backref">↩︎</a></p></li>
// 蒸馏自 Typora 的脚注规则大多落空：.footnote-word 无对应节点；sup.md-footnote 徽章
// 无 .md-footnote 类（仅亮色基底有）；.footnote-item em 只在条目恰含强调时才命中；
// .footnote-ref 同名存活，但可见文字挂在内层 <a> 上，被 .markdown-preview a 链接样式
// 压过。以下把主题视觉意图挂到实际节点。尾注分隔线 hr.footnotes-sep 命中主题通用
// hr 规则（虚线装饰线），无需重映射；回链 a.footnote-backref 主题无专属规则，不动。
function footnoteRemapRules(mode) {
  const light = mode === 'light';
  const badge = light
    ? `
/* 上标引用徽章（原 sup.md-footnote；top/left 为 Typora 定位残留，对静态 sup 无效不搬） */
.markdown-preview sup.footnote-ref {
    font-size: 9px;
    padding: 1px 5px;
    background-color: rgba(238, 238, 238, .7);
    color: #555;
    border-radius: 50%;
}
`
    : '';
  const refText = light
    ? `.markdown-preview .footnote-ref a {
    font-weight: 400;
    color: #595959;
}`
    : `.markdown-preview .footnote-ref a {
    font-weight: 700;
    color: var(--accent-color);
    margin-left: 2px;
}`;
  const entry = light
    ? `.markdown-preview .footnote-item p {
    font-size: 14px;
    color: #595959;
}`
    : `.markdown-preview .footnote-item p {
    font-size: 14px;
    color: #888;
    font-style: italic;
}`;
  return `
/* ============ 脚注选择器重映射（生成脚本追加，Typora 类 → crossnote 实际类） ============ */
${badge}/* 上标引用文字（原 .footnote-word/.footnote-ref 的意图；压过 .markdown-preview a 链接色） */
${refText}

/* 尾注条目文字（原 .footnote-item em → crossnote 条目正文是 li.footnote-item > p） */
${entry}
`;
}

// ---------- 构建期对比度断言：--code-comment 对 --code-block-bg ≥ 4.5:1 ----------
//（守住上游 0.3.3 "注释对比度提升至至少 4.5:1" 的可读性工作；rgba 底色先合成到
// 白底再算。低于阈值只 WARN 不中断——调色板值由上游调过，出现 WARN 说明新值
// 未过表或被手改。颜色解析/亮度/对比度共用 lib/css-color.js，统一返回 [r,g,b,a]。）
function assertCommentContrast(name) {
  const row = CODE_PALETTES[name.replace(/^phycat-/, '')];
  const fg = parseCssColor(row['code-comment']);
  let bg = parseCssColor(row['code-block-bg']);
  if (!fg || !bg) {
    console.log(`WARN ${name}: 代码配色无法解析，跳过对比度断言`);
    return;
  }
  if (bg[3] < 1) {
    const a = bg[3];
    bg = bg.slice(0, 3).map((c) => Math.round(c * a + 255 * (1 - a))).concat([1]);
  }
  const ratio = contrastRatio(fg, bg.slice(0, 3));
  if (ratio < 4.5) {
    console.log(
      `WARN ${name}: 代码注释对比度 ${ratio.toFixed(2)}:1 < 4.5:1（--code-comment ${row['code-comment']} 对 --code-block-bg ${row['code-block-bg']}）`,
    );
  }
}

// ---------- 主流程 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
// 各变体里处于活跃状态（未被注释）的 --autonum-h1..h6 定义，用于一致性比对与 JSON 落盘
const autonumByVariant = {};
for (const name of VARIANTS) {
  const variant = readVariant(name);
  autonumByVariant[name] = Object.fromEntries(
    Object.entries(variant.vars)
      .filter(([k]) => /^--autonum-h[1-6]$/.test(k))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const distilled = distillBase(variant.mode);
  const merged = `${distilled}\n\n/* ============ 变体 :root 覆盖（${name}） ============ */\n\n${variant.rootCss}${variant.extra ? '\n\n' + variant.extra : ''}`;
  const out =
    `/*\n` +
    ` * mpe-export 预设样式 —— 提炼自 Typora typora-theme-phycat（${name}，${variant.mode} 基底）\n` +
    ` * 由 tools/build-phycat-preset.js 生成，请勿手改，改脚本后重新生成。\n` +
    ` * 正文 CJK 字体（LXGW WenKai）不在此文件内联，由导出器按文档字符动态子集化注入\n` +
    ` * （见 exporter.js buildInlineFontCss；等宽 Cascadia Code 已 base64 内联在本文件）。\n` +
    ` */\n\n` +
    merged +
    '\n' +
    COMPAT +
    codeBlockHeaderRule(variant.mode) +
    '\n' +
    calloutColorOverrides(merged, variant.vars) +
    '\n' +
    pageBackgroundRule(variant) +
    '\n' +
    TYPOGRAPHY_FIX +
    '\n' +
    headingColorVarsRules(variant.mode) +
    '\n' +
    COMPAT_EXTRA +
    '\n' +
    IMAGE_ALIGN_RULES +
    '\n' +
    MERMAID_RULES +
    '\n' +
    codePaletteRootCss(name) +
    '\n' +
    CODE_TOKEN_RULES +
    '\n' +
    autonumCompatRules(variant.mode) +
    '\n' +
    footnoteRemapRules(variant.mode);
  assertCommentContrast(name);
  const outFile = path.join(OUT_DIR, `${name}.css`);
  fs.writeFileSync(outFile, out, 'utf8');
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`OK ${name}.css (${variant.mode}, ${kb} KB)`);
}

// ---------- 章节自动编号定义落盘（lib/presets/phycat-autonum.json） ----------
// 11 个变体的 --autonum-h1..h6 定义逐键比对：同键不同值视为上游分歧、构建失败；
// 一致则取并集（部分变体把定义注释掉了，活跃子集互相补齐）按 h1..h6 顺序写一份。
// --autonum-hNtoc 只作用于 Typora 的 TOC DOM，导出不存在对应结构，不收录。
const AUTONUM_ORDER = ['--autonum-h1', '--autonum-h2', '--autonum-h3', '--autonum-h4', '--autonum-h5', '--autonum-h6'];
const autonumUnion = {};
for (const [name, defs] of Object.entries(autonumByVariant)) {
  for (const [k, v] of Object.entries(defs)) {
    if (autonumUnion[k] !== undefined && autonumUnion[k] !== v) {
      throw new Error(
        `--autonum 定义不一致: ${k} 在 ${name} 为 "${v}"，其他变体为 "${autonumUnion[k]}"——请拆分 light/dark 两份 JSON`,
      );
    }
    autonumUnion[k] = v;
  }
}
const missingAutonum = AUTONUM_ORDER.filter((k) => autonumUnion[k] === undefined);
if (missingAutonum.length) {
  console.log(`WARN phycat-autonum.json 缺少 ${missingAutonum.join(', ')}（全部变体中无活跃定义）`);
}
const autonumJson = {};
for (const k of AUTONUM_ORDER) {
  if (autonumUnion[k] !== undefined) autonumJson[k] = autonumUnion[k];
}
const autonumFile = path.join(OUT_DIR, 'phycat-autonum.json');
fs.writeFileSync(autonumFile, JSON.stringify(autonumJson, null, 2) + '\n', 'utf8');
console.log(
  `OK phycat-autonum.json（11 变体定义逐键一致，收录 ${Object.keys(autonumJson).length}/6 键；` +
    `启用: --theme-vars "$(cat lib/presets/phycat-autonum.json)"）`,
);
