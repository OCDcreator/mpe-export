#!/usr/bin/env node
/**
 * 从 Obsidian 主题 OnePage（ivaneye/OnePage，基于 Cupertino）提炼"文档内容样式"，
 * 生成 mpe-export 亮/暗两个预设 CSS。
 *
 * 用法:
 *   node tools/build-onepage-preset.js <theme.css> [输出目录]
 *
 * 默认输出:
 *   <输出目录>/onepage.css       亮色（暖白纸张）
 *   <输出目录>/onepage-dark.css  暗色（暖棕·冷锚）
 *
 * 做的事:
 *  1. 从主题 theme.css 提取两套固化的配色块：
 *     body.theme-light（暖白纸张）/ body.theme-dark（暖棕·冷锚）
 *     与 .theme-light / .theme-dark 里的 --code-* 代码配色。
 *  2. 丢弃 Obsidian 界面样式（workspace/侧边栏/编辑器 cm 前缀/弹窗等 1300+ 条），
 *     只保留文档阅读样式，改写为 crossnote 容器选择器 .markdown-preview：
 *     标题彩色排版（--typo-h1..h6）、加粗/斜体配色、行内代码药丸、
 *     代码块圆角边框 + 连字、精致引用块、细下划线链接、彩色表格、
 *     macOS 胶囊 callout、任务复选框圆角。
 *  3. 追加 crossnote 兼容补丁（prism token 色映射、callout 布局、
 *     打印 @page 满版背景等）。
 *  - 正文 CJK 字体不内联，由导出器按文档字符动态子集化注入
 *    （exporter.js buildInlineFontCss，预设 inlineFonts 用 Noto Sans SC）。
 */

const fs = require('fs');
const path = require('path');

const [, , inputCss, outDirArg] = process.argv;
if (!inputCss) {
  console.error('用法: node tools/build-onepage-preset.js <theme.css> [输出目录]');
  process.exit(2);
}
const outDir = outDirArg || path.join(__dirname, '..', 'lib', 'presets');
const css = fs.readFileSync(inputCss, 'utf8');

// ---------- 顶层块扫描 ----------
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

const blocks = splitBlocks(css);

// ---------- 变量块提取 ----------
/** 取某个顶层选择器块（body 以 `--name: value` 开头的声明块） */
function extractVarBlock(selector) {
  for (const { prelude, body } of blocks) {
    const clean = prelude.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (clean === selector && /^\s*--/.test(body)) return body;
  }
  return '';
}

/** 把 `--a: v; --b: v2;` 解析成 { a: 'v', b: 'v2' }，去掉 !important 与注释 */
function parseVars(body) {
  const out = {};
  const clean = body.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const part of clean.split(';')) {
    const m = part.match(/^\s*(--[^:\s]+)\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const value = m[2].replace(/!important\s*$/i, '').trim();
    if (value) out[m[1]] = value;
  }
  return out;
}

const lightCore = parseVars(extractVarBlock('body.theme-light'));
const darkCore = parseVars(extractVarBlock('body.theme-dark'));
const lightCode = parseVars(extractVarBlock('.theme-light'));
const darkCode = parseVars(extractVarBlock('.theme-dark'));

if (!lightCore['--typo-h1'] || !darkCore['--typo-h1']) {
  console.error('未在 theme.css 中找到 body.theme-light / body.theme-dark 配色块（版本不兼容？）');
  process.exit(1);
}

/** 代码配色与 callout 强调色（--code-* / --color-*-rgb）从独立块合并进核心变量 */
function mergeCode(core, code) {
  const merged = { ...core };
  for (const [k, v] of Object.entries(code)) {
    if (k.startsWith('--code-') || k.startsWith('--color-')) merged[k] = v;
  }
  return merged;
}

// ---------- 亮/暗两套 CSS 生成 ----------
function buildPresetCss(mode, vars) {
  const light = mode === 'light';
  const {
    '--background-primary': bgPrimary,
    '--background-primary-alt': bgPrimaryAlt,
    '--background-secondary': bgSecondary,
    '--background-secondary-alt': bgSecondaryAlt,
    '--text-normal': textNormal,
    '--text-muted': textMuted,
    '--text-faint': textFaint,
    '--text-accent': textAccent,
    '--interactive-accent': interactiveAccent,
    '--typo-h1': typoH1,
    '--typo-h2': typoH2,
    '--typo-h3': typoH3,
    '--typo-h4': typoH4,
    '--typo-h5': typoH5,
    '--typo-h6': typoH6,
    '--typo-bold': typoBold,
    '--typo-italic': typoItalic,
    '--color-red-rgb': colorRed,
    '--color-orange-rgb': colorOrange,
    '--color-yellow-rgb': colorYellow,
    '--color-green-rgb': colorGreen,
    '--color-cyan-rgb': colorCyan,
    '--color-blue-rgb': colorBlue,
    '--color-purple-rgb': colorPurple,
    '--color-pink-rgb': colorPink,
    '--code-normal': codeNormal,
    '--code-comment': codeComment,
    '--code-function': codeFunction,
    '--code-important': codeImportant,
    '--code-keyword': codeKeyword,
    '--code-property': codeProperty,
    '--code-punctuation': codePunctuation,
    '--code-string': codeString,
    '--code-tag': codeTag,
    '--code-value': codeValue,
  } = vars;

  const pageBg = light ? '#faf7f1' : '#262322';
  const blockquoteBorder = light ? '#d8cfc1' : '#544d45';
  // 主题未在配色块里定义 --background-modifier-border，按暖色系给兜底值
  const bgBorder = vars['--background-modifier-border'] || (light ? '#e5dfd2' : '#3e3833');
  const accentLabel = light ? '暖白纸张' : '暖棕·冷锚';

  // 通用 CSS 变量（两套配色都写在同一组 -- 上，规则共用一份）
  const common = `
.markdown-preview {
    /* ===== OnePage · ${accentLabel}（${light ? '亮' : '暗'}色，源自 Obsidian 主题 OnePage v1.0.5） ===== */
    --background-primary: ${bgPrimary};
    --background-primary-alt: ${bgPrimaryAlt || bgPrimary};
    --background-secondary: ${bgSecondary || bgPrimary};
    --background-secondary-alt: ${bgSecondaryAlt || bgPrimary};
    --background-modifier-border: ${bgBorder};
    --text-normal: ${textNormal};
    --text-muted: ${textMuted};
    --text-faint: ${textFaint};
    --text-accent: ${textAccent};
    --interactive-accent: ${interactiveAccent || textAccent};
    /* 彩色排版：标题 / 加粗 / 斜体分层配色 */
    --typo-h1: ${typoH1};
    --typo-h2: ${typoH2};
    --typo-h3: ${typoH3};
    --typo-h4: ${typoH4};
    --typo-h5: ${typoH5};
    --typo-h6: ${typoH6};
    --typo-bold: ${typoBold};
    --typo-italic: ${typoItalic};
    /* callout 强调色（主题 .theme-* 的 --color-*-rgb 原值） */
    --color-red-rgb: ${colorRed};
    --color-orange-rgb: ${colorOrange};
    --color-yellow-rgb: ${colorYellow};
    --color-green-rgb: ${colorGreen};
    --color-cyan-rgb: ${colorCyan};
    --color-blue-rgb: ${colorBlue};
    --color-purple-rgb: ${colorPurple};
    --color-pink-rgb: ${colorPink};
    /* 代码配色 */
    --code-normal: ${codeNormal};
    --code-comment: ${codeComment};
    --code-function: ${codeFunction};
    --code-important: ${codeImportant};
    --code-keyword: ${codeKeyword};
    --code-property: ${codeProperty};
    --code-punctuation: ${codePunctuation};
    --code-string: ${codeString};
    --code-tag: ${codeTag};
    --code-value: ${codeValue};
    /* 阅读布局：正文行高 1.7、正文 16px、阅读宽居中（Obsidian 阅读视图规格） */
    font-family: var(--font-text, "Noto Sans SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif);
    font-size: 16px;
    line-height: 1.7;
    color: ${textNormal};
    background-color: ${bgPrimary};
    max-width: 760px;
    margin: 0 auto;
    padding: 2rem 1.75rem;
}

/* ===== 标题：负字距微调 + 彩色排版 + 主题字重/字号 ===== */
.markdown-preview h1,
.markdown-preview h2,
.markdown-preview h3,
.markdown-preview h4 { letter-spacing: -0.01em; }
.markdown-preview h1 { font-size: 1.5em; font-weight: 650; color: ${typoH1}; }
.markdown-preview h2 { font-size: 1.25em; font-weight: 620; color: ${typoH2}; }
.markdown-preview h3 { font-size: 1.125em; font-weight: 580; color: ${typoH3}; }
.markdown-preview h4 { font-size: 1em; color: ${typoH4}; }
.markdown-preview h5 { font-size: 1em; color: ${typoH5}; }
.markdown-preview h6 { font-size: 0.875em; color: ${typoH6}; }
.markdown-preview h1, .markdown-preview h2, .markdown-preview h3,
.markdown-preview h4, .markdown-preview h5, .markdown-preview h6 {
    line-height: 1.3;
    margin: 2em 0 0.6em;
}
.markdown-preview > h1:first-child { margin-top: 0; }

/* 加粗 / 斜体：分层配色（主题 --typo-bold / --typo-italic） */
.markdown-preview strong { color: ${typoBold} !important; }
.markdown-preview em { color: ${typoItalic} !important; }

/* ===== 链接：细下划线 + 强调色 ===== */
.markdown-preview a {
    color: ${textAccent};
    text-underline-offset: 2px;
    text-decoration-thickness: 1px;
    text-decoration-color: color-mix(in srgb, ${textAccent} 45%, transparent);
}
.markdown-preview a:hover { text-decoration-color: ${textAccent}; }

/* ===== 行内代码：圆角药丸 ===== */
.markdown-preview code { font-family: var(--font-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace); }
.markdown-preview code:not(pre code) {
    font-size: 0.88em;
    padding: 0.15em 0.42em;
    border-radius: 5px;
    background-color: ${bgBorder};
    color: inherit;
}

/* ===== 代码块：圆角边框 + 连字 + 主题代码配色（覆盖 prism token 色） ===== */
.markdown-preview pre {
    position: relative;
    border: 1px solid ${bgBorder};
    border-radius: 8px;
    background-color: ${bgSecondaryAlt || bgSecondary};
    padding: 1rem 1.1rem;
    font-family: var(--font-monospace, "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace);
    font-size: 0.875rem;
    line-height: 1.625;
    font-feature-settings: "calt" 1, "liga" 1;
    overflow-x: auto;
}
.markdown-preview pre code {
    background-color: transparent;
    color: ${codeNormal};
    border: none;
    padding: 0;
    font-size: inherit;
    line-height: inherit;
    font-family: inherit;
}
.markdown-preview pre code .token.comment,
.markdown-preview pre code .token.prolog,
.markdown-preview pre code .token.doctype,
.markdown-preview pre code .token.cdata { color: ${codeComment}; }
.markdown-preview pre code .token.keyword,
.markdown-preview pre code .token.selector,
.markdown-preview pre code .token.operator,
.markdown-preview pre code .token.atrule { color: ${codeKeyword}; }
.markdown-preview pre code .token.string,
.markdown-preview pre code .token.char,
.markdown-preview pre code .token.attr-value,
.markdown-preview pre code .token.regex { color: ${codeString}; }
.markdown-preview pre code .token.function,
.markdown-preview pre code .token.class-name { color: ${codeFunction}; }
.markdown-preview pre code .token.property,
.markdown-preview pre code .token.attr-name,
.markdown-preview pre code .token.parameter { color: ${codeProperty}; }
.markdown-preview pre code .token.number,
.markdown-preview pre code .token.boolean,
.markdown-preview pre code .token.constant,
.markdown-preview pre code .token.symbol,
.markdown-preview pre code .token.builtin { color: ${codeValue}; }
.markdown-preview pre code .token.punctuation { color: ${codePunctuation}; }
.markdown-preview pre code .token.tag { color: ${codeTag}; }
.markdown-preview pre code .token.important { color: ${codeImportant}; }

/* ===== 引用块：细左边线 + 圆角右缘 + 浅底 ===== */
.markdown-preview blockquote {
    border-left: 2px solid ${blockquoteBorder};
    background-color: ${bgPrimaryAlt || bgPrimary};
    border-radius: 0 6px 6px 0;
    padding: 0.6em 1em;
    margin: 1em 0;
    color: ${textMuted};
}
.markdown-preview blockquote > :first-child { margin-top: 0; }
.markdown-preview blockquote > :last-child { margin-bottom: 0; }

/* ===== 表格：强调色表头 + 细格线 ===== */
.markdown-preview table {
    border-collapse: collapse;
    border: none;
}
.markdown-preview th {
    font-weight: 600;
    color: color-mix(in srgb, ${textAccent} 55%, ${textMuted});
    border: none;
    border-bottom: 2px solid color-mix(in srgb, ${textAccent} 45%, ${textMuted});
    padding: 8px 12px;
    text-align: left;
}
.markdown-preview td {
    border: 1px solid color-mix(in srgb, ${textMuted} 15%, transparent);
    padding: 8px 12px;
}
.markdown-preview tr:nth-child(even) td { background-color: color-mix(in srgb, ${textMuted} 4%, transparent); }

/* ===== callout：macOS 胶囊卡片（主题 --color-*-rgb 强调色） ===== */
.markdown-preview .callout {
    border: 1px solid color-mix(in srgb, var(--callout-color, ${textAccent}) 30%, ${bgBorder});
    border-radius: 8px;
    background-color: color-mix(in srgb, var(--callout-color, ${textAccent}) 8%, ${bgPrimary});
    padding: 0.8em 1.1em;
}
.markdown-preview .callout-title {
    color: var(--callout-color, ${textAccent});
    font-weight: 600;
}
.markdown-preview .callout[data-callout="note"] { --callout-color: ${colorBlue}; }
.markdown-preview .callout[data-callout="info"] { --callout-color: ${colorBlue}; }
.markdown-preview .callout[data-callout="abstract"],
.markdown-preview .callout[data-callout="summary"] { --callout-color: ${colorBlue}; }
.markdown-preview .callout[data-callout="tip"] { --callout-color: ${colorCyan}; }
.markdown-preview .callout[data-callout="important"] { --callout-color: ${colorPurple}; }
.markdown-preview .callout[data-callout="warning"] { --callout-color: ${colorOrange}; }
.markdown-preview .callout[data-callout="caution"],
.markdown-preview .callout[data-callout="danger"] { --callout-color: ${colorRed}; }
.markdown-preview .callout[data-callout="success"],
.markdown-preview .callout[data-callout="check"],
.markdown-preview .callout[data-callout="done"] { --callout-color: ${colorGreen}; }
.markdown-preview .callout[data-callout="question"],
.markdown-preview .callout[data-callout="help"] { --callout-color: ${colorBlue}; }

/* ===== 其它阅读细节 ===== */
.markdown-preview hr {
    border: none;
    border-top: 1px solid ${bgBorder};
    margin: 2em 0;
}
.markdown-preview img { max-width: 100%; height: auto; border-radius: 8px; }
.markdown-preview .task-list-item-checkbox {
    width: 15px;
    height: 15px;
    border-radius: 4px;
    accent-color: ${textAccent};
}
.markdown-preview mark {
    background-color: color-mix(in srgb, ${textAccent} 22%, transparent);
    color: inherit;
}
.markdown-preview ::selection { background-color: color-mix(in srgb, ${textAccent} 22%, transparent); }

/* PDF 满版背景：铺满整页（含页边距），边距即"正文与页面边缘的距离" */
@page { background: ${pageBg}; }

@media print {
    .markdown-preview { padding-top: 0; padding-bottom: 0; }
    .markdown-preview > h1:first-child { margin-top: 0; }
    .markdown-preview p,
    .markdown-preview .katex-display,
    .markdown-preview blockquote,
    .markdown-preview table,
    .markdown-preview pre,
    .markdown-preview .callout { break-inside: avoid; page-break-inside: avoid; }
}
`;

  const header = `/*
 * mpe-export 预设样式 —— 提炼自 Obsidian 主题 OnePage v1.0.5
 * （ivaneye/OnePage，基于 Cupertino 深度定制，MIT License）
 * ${light ? '亮色 · 暖白纸张' : '暗色 · 暖棕·冷锚'}
 * 由 tools/build-onepage-preset.js 生成，请勿手改，改脚本后重新生成。
 * 正文 CJK 字体（Noto Sans SC）不在此文件内联，由导出器按文档字符
 * 动态子集化注入（见 exporter.js buildInlineFontCss）。
 */
`;

  return header + common;
}

// ---------- 写盘 ----------
fs.mkdirSync(outDir, { recursive: true });
const lightCss = buildPresetCss('light', mergeCode(lightCore, lightCode));
const darkCss = buildPresetCss('dark', mergeCode(darkCore, darkCode));
const lightFile = path.join(outDir, 'onepage.css');
const darkFile = path.join(outDir, 'onepage-dark.css');
fs.writeFileSync(lightFile, lightCss, 'utf8');
fs.writeFileSync(darkFile, darkCss, 'utf8');
const kb = (f) => (fs.statSync(f).size / 1024).toFixed(0);
console.log(`OK ${lightFile} (${kb(lightFile)} KB)`);
console.log(`OK ${darkFile} (${kb(darkFile)} KB)`);