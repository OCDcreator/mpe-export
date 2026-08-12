/**
 * normalize.js —— Markdown 块间空行规范化（机械修复，只加空行，不改内容）
 *
 * 背景：以下块级元素紧贴正文（前后无空行）时，不同解析器会出各种故障——
 *   - $$ 公式块并进段落：块内单独一行的 = 触发 setext 标题、^ 被上标扩展吃掉，
 *     整块渲染为裸露 LaTeX 文本；Typora 直接渲染失败
 *   - 引用块/callout 紧贴正文：Typora 要求空行分隔，否则归入同一段落
 *   - HTML 块（<div>/<table>/<img>...）：Typora 等要求空行，否则不解析
 *   - 表格、分割线（--- 贴正文会变 setext 二级标题）、ATX 标题、列表：
 *     严格解析器（含有序列表非 1. 开头）不能中断段落，必须有前置空行
 *
 * 规则统一为：块前一行非空 → 补一个空行；块后一行非空 → 补一个空行。
 * 跳过 YAML front-matter、围栏代码块与 $$ 公式块的内部。
 *
 * 注意（有意为之的语义选择）：
 *   - 引用块/列表的"懒惰延续"行会被空行切出块外（Typora 语义）；
 *   - 紧贴正文的 --- 按分割线处理（不再当 setext 二级标题——本项目文档
 *     一律用 ATX 标题，setext 几乎只会是公式块事故里的误识别）。
 */

'use strict';

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const RE_MATH = /^ {0,3}\$\$/;
const RE_QUOTE = /^ {0,3}>/;
const RE_HEADING = /^ {0,3}#{1,6}(?:\s|$)/;
const RE_HR = /^ {0,3}(?:\* *){3,}$|^ {0,3}(?:- *){3,}$|^ {0,3}(?:_ *){3,}$/;
const RE_LIST = /^ {0,3}(?:[-*+]|\d{1,9}[.)]) +/;
const RE_LIST_CONT = /^ +\S/; // 列表的缩进延续行
const RE_HTML_COMMENT = /^ {0,3}<!--/;
const RE_HTML_CLOSE = /^ {0,3}<\/[a-zA-Z]/;
const RE_HTML_OPEN = /^ {0,3}<([a-zA-Z][a-zA-Z0-9-]*)/;
const RE_TABLE_DELIM = /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|? *$/;

/** CommonMark 块级标签 + Typora 习惯按块处理的媒体/空元素标签 */
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center',
  'colgroup', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
  'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'header', 'hr', 'html', 'iframe', 'legend', 'li', 'main', 'menu', 'nav',
  'ol', 'optgroup', 'option', 'p', 'pre', 'script', 'section', 'style',
  'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  // 非 CommonMark 块级但 Typora/编辑器习惯独立成块
  'img', 'video', 'audio', 'embed', 'br', 'input', 'link', 'meta', 'source',
]);
/** 无闭合标签，单行即成块 */
const HTML_VOID_TAGS = new Set([
  'img', 'br', 'hr', 'input', 'link', 'meta', 'source', 'track', 'wbr',
  'embed', 'col', 'base', 'area', 'param',
]);

const KIND_NAMES = {
  math: '公式块',
  code: '代码块',
  quote: '引用块/callout',
  html: 'HTML块',
  table: '表格',
  hr: '分割线',
  heading: '标题',
  list: '列表',
};

/**
 * 规范化 markdown 文本。
 * @param {string} text 源文本
 * @returns {{ text: string, added: number, byKind: object<string, number> }}
 *   added 为补入的空行总数；byKind 记录每类块补了几处（键为英文 kind，
 *   展示层可用 KIND_NAMES 翻译成中文）
 */
function normalizeMarkdown(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  const byKind = {};
  let added = 0;
  let i = 0;

  const isBlank = (s) => s === undefined || s.trim() === '';
  const blankBefore = (kind) => {
    if (out.length && !isBlank(out[out.length - 1])) {
      out.push('');
      added++;
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
  };
  const blankAfter = (kind, end) => {
    if (end < lines.length && !isBlank(lines[end])) {
      out.push('');
      added++;
      byKind[kind] = (byKind[kind] || 0) + 1;
    }
  };
  /** 整块输出 [start, end)，前后按需补空行 */
  const emitBlock = (kind, start, end) => {
    blankBefore(kind);
    for (let k = start; k < end; k++) out.push(lines[k]);
    blankAfter(kind, end);
    i = end;
  };

  // YAML front-matter：首行为 --- 时原样穿过（本身不参与规范化）
  if (lines.length && lines[0].trim() === '---') {
    out.push(lines[0]);
    i = 1;
    while (i < lines.length) {
      out.push(lines[i]);
      if (i > 0 && lines[i].trim() === '---') {
        i++;
        break;
      }
      i++;
    }
  }

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(RE_FENCE_OPEN);
    if (fence) {
      const ch = fence[1][0];
      const reClose = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${fence[1].length},} *$`);
      let j = i + 1;
      while (j < lines.length && !reClose.test(lines[j])) j++;
      emitBlock('code', i, j < lines.length ? j + 1 : lines.length);
      continue;
    }

    // $$ 公式块（单行 $$x$$ 或多行）
    if (RE_MATH.test(line)) {
      let end = i + 1;
      if (!line.trim().slice(2).includes('$$')) {
        let j = i + 1;
        while (j < lines.length && !lines[j].includes('$$')) j++;
        if (j < lines.length) end = j + 1; // 找不到闭合：按单行处理，不扩散
      }
      emitBlock('math', i, end);
      continue;
    }

    // 引用块 / callout（> 开头的连续行）
    if (RE_QUOTE.test(line)) {
      let j = i;
      while (j < lines.length && RE_QUOTE.test(lines[j])) j++;
      emitBlock('quote', i, j);
      continue;
    }

    // ATX 标题（单行块）
    if (RE_HEADING.test(line)) {
      emitBlock('heading', i, i + 1);
      continue;
    }

    // 分割线（单行块；--- 贴正文原本是 setext 二级标题，见文件头说明）
    if (RE_HR.test(line)) {
      emitBlock('hr', i, i + 1);
      continue;
    }

    // HTML 注释块
    if (RE_HTML_COMMENT.test(line)) {
      let j = i;
      while (j < lines.length && !lines[j].includes('-->')) j++;
      emitBlock('html', i, j < lines.length ? j + 1 : lines.length);
      continue;
    }

    // HTML 闭合标签行（单行块）
    if (RE_HTML_CLOSE.test(line)) {
      emitBlock('html', i, i + 1);
      continue;
    }

    // HTML 开放标签块
    const htmlOpen = line.match(RE_HTML_OPEN);
    if (htmlOpen && HTML_BLOCK_TAGS.has(htmlOpen[1].toLowerCase())) {
      const tag = htmlOpen[1].toLowerCase();
      let end = i + 1;
      if (!HTML_VOID_TAGS.has(tag) && !new RegExp(`</${tag}\\s*>`, 'i').test(line)) {
        const reClose = new RegExp(`</${tag}\\s*>`, 'i');
        let j = i + 1;
        // 到闭合标签为止；遇空行提前终止（作者没写闭合或闭合缺失）
        while (j < lines.length && !isBlank(lines[j]) && !reClose.test(lines[j])) j++;
        if (j < lines.length && !isBlank(lines[j])) end = j + 1;
        else end = j;
      }
      emitBlock('html', i, end);
      continue;
    }

    // GFM 表格：当前行含 | 且下一行是分隔行
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      RE_TABLE_DELIM.test(lines[i + 1])
    ) {
      let j = i + 2;
      while (j < lines.length && !isBlank(lines[j]) && lines[j].includes('|')) j++;
      emitBlock('table', i, j);
      continue;
    }

    // 列表块（含缩进延续行；懒惰延续行按 Typora 语义切出）
    if (RE_LIST.test(line)) {
      let j = i;
      while (
        j < lines.length &&
        (RE_LIST.test(lines[j]) || (!isBlank(lines[j]) && RE_LIST_CONT.test(lines[j])))
      ) {
        j++;
      }
      emitBlock('list', i, j);
      continue;
    }

    out.push(line);
    i++;
  }

  return { text: out.join(eol), added, byKind };
}

module.exports = { normalizeMarkdown, KIND_NAMES };
