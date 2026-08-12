#!/usr/bin/env node
/**
 * 从 Typora 主题 typora-theme-phycat 提炼"文档内容样式"，一次生成全部 11 个
 * 配色变体的 mpe-export 预设 CSS（lib/presets/phycat-*.css）。
 *
 * 用法:
 *   node tools/build-phycat-preset.js [主题源目录]
 *   默认主题源目录: C:/GhostDownload/Archives/typora-theme-phycat
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

const SRC_DIR =
  process.argv[2] || 'C:/GhostDownload/Archives/typora-theme-phycat';
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
  // 变量未定义时 content: var(--autonum-hN) 失效，::before 不生成编号盒）
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
      ${dark ? 'color-mix(in srgb, var(--secondary-color), transparent 95%)' : '#f8f8f8'};
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

// ---------- 主流程 ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const name of VARIANTS) {
  const variant = readVariant(name);
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
    COMPAT_EXTRA;
  const outFile = path.join(OUT_DIR, `${name}.css`);
  fs.writeFileSync(outFile, out, 'utf8');
  const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
  console.log(`OK ${name}.css (${variant.mode}, ${kb} KB)`);
}
