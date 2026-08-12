#!/usr/bin/env node
/**
 * 从 Typora claude-theme 提炼"文档内容样式"，生成 mpe-export 预设 CSS。
 *
 * 用法:
 *   node tools/build-claude-preset.js <主题目录> <claude.css|claude-dark.css> <输出.css>
 *
 * 做的事:
 *  1. 只保留内容样式（#write / 纯标签规则 / :root 变量 / @media print / @font-face），
 *     丢弃 Typora 界面样式（侧边栏、菜单、编辑器 CodeMirror 等）。
 *  2. 选择器改写：#write/.write/.typora-export → .markdown-preview（crossnote 容器），
 *     .md-fences → pre，.md-task-list-item → .task-list-item。
 *  3. Anthropic 三个西文字体（Serif/Sans/Mono，共约 220KB）base64 内联为 data URI，
 *     导出产物零外部依赖；CJK 字体（单个 17-25MB）不内联，走系统回退。
 *  4. 追加 crossnote 兼容补丁（代码块 padding、pre code 复位等）。
 */

const fs = require('fs');
const path = require('path');

const [, , srcDir, inputName, outFile] = process.argv;
if (!srcDir || !inputName || !outFile) {
  console.error('用法: node build-claude-preset.js <主题目录> <输入.css> <输出.css>');
  process.exit(2);
}

let css = fs.readFileSync(path.join(srcDir, inputName), 'utf8');

// 去注释（主题注释无花括号，安全）
css = css.replace(/\/\*[\s\S]*?\*\//g, '');

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
  return sel
    .replace(/#write\b/g, '.markdown-preview')
    .replace(/\.typora-export\b/g, '.markdown-preview')
    .replace(/\.write\b/g, '.markdown-preview')
    // Typora callout → crossnote callout（.md-alert-note → .callout[data-callout="note"]）
    .replace(/\.md-alert-(note|tip|important|warning|caution)\b/g, '.callout[data-callout="$1"]')
    .replace(/\.md-alert-text\b/g, '.callout-title')
    .replace(/\.md-alert\b/g, '.callout')
    .replace(/\.md-fences(?![\w-])/g, 'pre')
    .replace(/\.md-task-list-item\b/g, '.task-list-item');
}

// 编辑器/界面专用规则，即使含 #write 也丢弃
const DROP_RE =
  /md-focus|md-expand|md-meta|md-pair|md-grid|md-diagram|md-notification|code-tooltip|CodeMirror|\.cm-|ty-input|md-hover|md-tooltip|\[lang|md-toc|megamenu|sidebar|outline-|typora-source|md-image\b|md-rawblock/;

/** 保留判定：改写后的选择器是"文档内容"或"页面基础" */
function keepSelector(sel) {
  if (DROP_RE.test(sel)) return false;
  return sel.split(',').every((raw) => {
    const part = raw.trim();
    if (!part) return false;
    if (part.includes('.markdown-preview')) return true;
    // 页面基础选择器（:root / html / body / * / :host，可带 ::selection 等伪元素）
    if (/^(:root|:host|html|body|\*)(::?(before|after|selection))?$/.test(part)) return true;
    // 纯标签/属性/伪类选择器（code, tt, kbd, input[type=checkbox] 等）
    return !/[.#]/.test(part);
  });
}

// ---------- @font-face：Anthropic 字体 base64 内联，CJK 丢弃 ----------
function processFontFace(body) {
  const fam = (body.match(/font-family:\s*"([^"]+)"/) || [])[1] || '';
  if (!fam.includes('Anthropic')) return null; // Noto/思源 太大不内联
  const m = body.match(/url\(["']?\.?\/?claude-fonts\/([^"')]+)["']?\)/);
  if (!m) return null;
  const fontPath = path.join(srcDir, 'claude-fonts', m[1]);
  if (!fs.existsSync(fontPath)) throw new Error(`字体缺失: ${fontPath}`);
  const b64 = fs.readFileSync(fontPath).toString('base64');
  const newBody = body.replace(
    /src:[^;]+;/,
    `src: url("data:font/ttf;base64,${b64}") format("truetype");`,
  );
  return `@font-face {${newBody}}`;
}

// ---------- 普通规则处理 ----------
function processRule(prelude, body) {
  const sel = rewriteSelectors(prelude);
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
      out.push(`${prelude} {${body}}`); // 内容 hover 动画引用
    } else if (/^@supports/.test(prelude)) {
      const inner = processLevel(body);
      if (inner) out.push(`${prelude} {\n${inner}\n}`);
    } else if (/^@/.test(prelude)) {
      continue; // @page 等丢弃
    } else {
      const r = processRule(prelude, body);
      if (r) out.push(r);
    }
  }
  return out.join('\n\n');
}

const distilled = processLevel(css);

// ---------- crossnote 兼容补丁 ----------
// 从蒸馏结果中提取 5 种 callout 的主题强调色，转成 crossnote 折叠图标/标题图标
// 使用的 --callout-color（r,g,b 三元组），让图标颜色与卡片强调色一致
function calloutColorOverrides(cssText) {
  const rules = [];
  const re =
    /\.callout\[data-callout="(note|tip|important|warning|caution)"\]\s*\{[^}]*?--alert-accent:\s*#([0-9a-fA-F]{6})/g;
  let m;
  while ((m = re.exec(cssText))) {
    const hex = m[2];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    rules.push(
      `.markdown-preview .callout[data-callout="${m[1]}"] { --callout-color: ${r},${g},${b}; }`,
    );
  }
  return rules.join('\n');
}

// 提取主题背景色，生成 @page 满版背景规则：
// Chrome 打印时 html/body 的画布背景只画到内容区（页边距留白），
// 只有 @page background 才能铺满整张 A4（含边距）
function pageBackgroundRule(cssText) {
  const m = cssText.match(/--bg-color:\s*(#[0-9a-fA-F]{3,8})\b/);
  if (!m) return '';
  return `/* PDF 满版背景：铺满整页（含页边距），边距即"正文与页面边缘的距离" */\n@page { background: ${m[1]}; }`;
}

// 字号体系与打印排版修正：
// 1. 主题根字号 13px 偏小，提到 14px（rem 间距等比跟随，比例不变）；
// 2. 原主题 h5/h6（0.9rem）比正文还小，重排标题阶梯为 px 固定值，
//    不随根字号漂移：24/21/18/16/15/14，h6 与正文同号、靠字重区分；
// 3. .markdown-preview 的 padding 2.25rem/4.375rem 是给 Typora 编辑器留的，
//    打印时纸面留白由 @page 页边距负责，否则首页顶部会空出一大块
const TYPOGRAPHY_FIX = `
/* ============ 字号体系与打印排版修正（生成脚本追加） ============ */

/* 根字号 13px → 14px：正文 14px，主题 rem 间距等比跟随 */
html { font-size: 14px; }

/* 标题阶梯（px 固定）：h1 24 / h2 21 / h3 18 / h4 16 / h5 15 / h6 14 */
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

const COMPAT_EXTRA = `
/* callout 标题布局：抵消 crossnote 默认样式的负边距/图标留白，套用主题排版 */
.markdown-preview .callout > .callout-title {
    margin: 0 0 0.35rem 0;
    padding: 0 0 0 1.9rem;
}
.markdown-preview .callout .callout-title::before {
    left: 1rem;
    font-size: 1rem;
}
`;

const COMPAT = `
/* ============ crossnote 兼容补丁（生成脚本追加） ============ */

/* crossnote 预览容器：居中（原 #write 规则已带 max-width: 752px） */
.markdown-preview { margin: 0 auto; }

/* 代码块：原 .md-fences 顶部 2.8rem 是给 Typora 语言标签留的，导出无此标签 */
.markdown-preview pre {
    position: relative;
    padding: 1rem 0.875rem !important;
    font-family: var(--font-mono);
    font-size: 0.875rem;
    line-height: 1.625;
    overflow-x: auto;
}

/* 行内 code 规则会波及 pre code，复位块内代码 */
.markdown-preview pre code,
.markdown-preview pre tt {
    background-color: transparent;
    color: inherit;
    border: none;
    padding: 0;
    font-size: inherit;
    line-height: inherit;
}
`;

const header = `/*
 * mpe-export 预设样式 —— 提炼自 Typora claude-theme v19.7（${inputName}）
 * 由 tools/build-claude-preset.js 生成，请勿手改，改脚本后重新生成。
 * CJK 字体（Noto Serif SC / Noto Sans SC / 思源黑体）不在此文件内联，
 * 由导出器按文档字符动态子集化注入（见 exporter.js buildInlineFontCss）。
 */
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  header +
    distilled +
    COMPAT +
    calloutColorOverrides(distilled) +
    '\n' +
    pageBackgroundRule(distilled) +
    '\n' +
    TYPOGRAPHY_FIX +
    '\n' +
    COMPAT_EXTRA,
  'utf8',
);

const kb = (fs.statSync(outFile).size / 1024).toFixed(0);
console.log(`OK ${outFile} (${kb} KB)`);
