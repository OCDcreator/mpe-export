/**
 * table-merge.js —— 管道表合并占位符的完整支持（在 crossnote 引擎之上补齐 `<`）
 *
 * canonical transcript 的表格用三种合并占位符：
 *   `<` 并入左邻（colspan）、`^` 并入上邻（rowspan）、`>` 并入右邻（colspan）。
 * crossnote 0.9.31 的扩展表格语法（enableExtendedTableSyntax）只认
 * `>`（向右合并）、`^`（向上合并）与"空单元格并入左邻"，`<` 完全不识别，
 * 会被当成普通文字印出来。本模块在 mpe-export 自己的管线里补齐：
 *
 * 1. normalizeLeftMergeInTables(markdown)
 *    Markdown 级：把表格行内"整格内容恰为 `<`"的格子归一成空格子
 *    （= crossnote 原生的"并入左邻"写法）。链式 `<` 归一成链式空格，
 *    crossnote 对链式空格按从右向左累计 colspan，实测正确（见
 *    test/merge-left.js）。保护措施：
 *      - 只在"表头行 + 分隔行"构成的表格块内触发（块判定与 normalize.js
 *        同源：当前行含 `|`、下一行是分隔行，且表头格数与分隔行格数一致——
 *        GFM 建表必要条件，缺格数校验会把 `标题 | a | < |` + `---` 这类
 *        setext 二级标题误判成表、静默吞掉整格 `<`）；
 *      - 只替换 trim 后恰为 `<` 的格子；`$a < b$`、`F < G`、`` `<` ``、
 *        `<img ...>`、`\<` 等一律不动；
 *      - 跳过围栏代码块与 $$ 公式块内部；
 *      - 格子切分按未转义的 `|` 进行（`\|` 不切、反引号 code span 内不切）。
 *
 * 2. flattenCrossGroupRowspanTables(html)
 *    HTML 级：crossnote 合并后，`^` 出现在表格第 2 行时 rowspan 落在
 *    <thead> 的 th 上；Chrome（含 Edge，CSS 无关）按 CSS 2.1 把 rowspan
 *    裁剪在行组内，thead 的跨组 rowspan 完全不生效（首列错位）。
 *    对"thead 单元格 rowspan 超出 thead 行数"的表，把全部行并进单个
 *    <tbody>（th/td 原样保留，表加 mpe-table-flat 类），rowspan 组内
 *    生效。表头样式损失由 FLAT_TABLE_COMPENSATION_CSS 补偿。
 *
 * 两个入口通过 crossnote 的 parserConfig 钩子接入（见 exporter.js）：
 * onWillParseMarkdown / onDidParseMarkdown，HTML / PDF（分页与非分页）/
 * PNG / JPEG 全部导出路径共用同一份处理。
 */

'use strict';

const cheerio = require('cheerio');

const RE_FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const RE_MATH = /^ {0,3}\$\$/;
const RE_TABLE_DELIM = /^ {0,3}\|?[\s:|-]*-[\s:|-]*\|? *$/;
const RE_QUOTE_PREFIX = /^\s*(?:>\s*)+/;

/**
 * 切分一行表格为格子数组。按未转义的 `|` 切；`\|` 视为字面竖线，
 * 反引号 code span 内的 `|` 不切（与 markdown-it 行内语法一致）。
 */
function splitTableRowCells(line) {
  const cells = [];
  let cur = '';
  let codeFence = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && i + 1 < line.length) {
      cur += ch + line[i + 1];
      i++;
      continue;
    }
    if (ch === '`') {
      let j = i;
      while (j < line.length && line[j] === '`') j++;
      const run = line.slice(i, j);
      if (!codeFence) {
        codeFence = run;
      } else if (run === codeFence) {
        codeFence = '';
      }
      cur += run;
      i = j - 1;
      continue;
    }
    if (ch === '|' && !codeFence) {
      cells.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** 单行表格替换：整格恰为 `<` → 空格。返回 { line, replaced } 或 null */
function transformLeftMergeRow(line) {
  const qm = line.match(RE_QUOTE_PREFIX);
  const prefix = qm ? qm[0] : '';
  const rest = line.slice(prefix.length);
  if (!rest.includes('|')) return null;
  const cells = splitTableRowCells(rest);
  let replaced = 0;
  const out = cells.map((c) => {
    if (c.trim() === '<') {
      replaced++;
      return c.replace('<', ''); // 保留对齐用的空格
    }
    return c;
  });
  if (!replaced) return null;
  return { line: prefix + out.join('|'), replaced };
}

/**
 * Markdown 级归一：表格行内整格 `<` → 空格（crossnote 原生"并入左邻"）。
 * @param {string} text 源文本（已含块间空行规范化更佳，但不强制）
 * @returns {{ text: string, replaced: number, tables: number }}
 */
function normalizeLeftMergeInTables(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const out = [];
  let replaced = 0;
  let tables = 0;
  let i = 0;

  const stripQuote = (s) => {
    const m = s.match(RE_QUOTE_PREFIX);
    return m ? s.slice(m[0].length) : s;
  };
  const isDelimRow = (s) => RE_TABLE_DELIM.test(stripQuote(s));
  // GFM 计格：行首/行尾的可选 `|` 不计格（`\|` 结尾除外），其余按未转义 `|`
  // 切分（:--- / ---: / :-: 等对齐冒号不影响格数，天然由分隔行字符集保证）
  const columnCount = (s) => {
    let t = stripQuote(s).trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
    return t === '' ? 0 : splitTableRowCells(t).length;
  };

  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块：整体穿过
    const fence = line.match(RE_FENCE_OPEN);
    if (fence) {
      const ch = fence[1][0];
      const reClose = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${fence[1].length},} *$`);
      let j = i + 1;
      while (j < lines.length && !reClose.test(lines[j])) j++;
      const end = j < lines.length ? j + 1 : lines.length;
      for (let k = i; k < end; k++) out.push(lines[k]);
      i = end;
      continue;
    }

    // $$ 公式块：整体穿过（单行 $$x$$ 不开启块）
    if (RE_MATH.test(line)) {
      if (line.trim().slice(2).includes('$$')) {
        out.push(line);
        i++;
        continue;
      }
      let j = i + 1;
      while (j < lines.length && !lines[j].includes('$$')) j++;
      const end = j < lines.length ? j + 1 : lines.length;
      for (let k = i; k < end; k++) out.push(lines[k]);
      i = end;
      continue;
    }

    // 表格块：当前行含 | 且下一行是分隔行，且表头格数与分隔行格数一致
    // （GFM 建表必要条件，markdown-it/crossnote 亦如此；引用前缀剥掉后再判）
    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      isDelimRow(lines[i + 1]) &&
      columnCount(line) === columnCount(lines[i + 1])
    ) {
      let j = i + 2;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) j++;
      let tableReplaced = 0;
      for (let k = i; k < j; k++) {
        const r = transformLeftMergeRow(lines[k]);
        if (r) {
          out.push(r.line);
          tableReplaced += r.replaced;
        } else {
          out.push(lines[k]);
        }
      }
      if (tableReplaced) tables++;
      replaced += tableReplaced;
      i = j;
      continue;
    }

    out.push(line);
    i++;
  }

  return { text: out.join(eol), replaced, tables };
}

/**
 * 判断一个 table 元素是否需要拍平：thead 内存在 rowspan 超出 thead
 * 行数的单元格（即跨组 rowspan，Chrome 会把 rowspan 裁剪在行组内）。
 */
function tableHasCrossGroupRowspan($, tableEl) {
  const $thead = $(tableEl).children('thead');
  if (!$thead.length) return false;
  const $rows = $thead.children('tr');
  const headRows = $rows.length;
  let overhang = false;
  $rows.each((rowIdx, tr) => {
    if (overhang) return;
    $(tr).children('th,td').each((_c, cell) => {
      const rs = parseInt($(cell).attr('rowspan') || '1', 10) || 1;
      if (rowIdx + rs > headRows) {
        overhang = true;
        return false;
      }
    });
  });
  return overhang;
}

/**
 * 把 table 的全部行（thead/tbody/tfoot/散行，按文档顺序）并进单个 tbody，
 * 表头格的 th 与全部 rowspan/colspan 属性原样保留，加 mpe-table-flat 类。
 */
function flattenTableRows($, tableEl) {
  const $t = $(tableEl);
  const rows = [];
  $t.children().each((_s, el) => {
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'tr') rows.push(el);
    else if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot') {
      $(el).children('tr').each((_r, tr) => rows.push(tr));
    }
  });
  if (rows.length < 2) return false;
  const $tbody = $('<tbody></tbody>');
  for (const tr of rows) $tbody.append(tr); // append 即从原节移入
  $t.children('thead, tbody, tfoot').remove();
  $t.append($tbody);
  const cls = $t.attr('class') || '';
  if (!/\bmpe-table-flat\b/.test(cls)) {
    $t.attr('class', cls ? `${cls} mpe-table-flat` : 'mpe-table-flat');
  }
  return true;
}

/**
 * HTML 级后处理：对"thead 单元格 rowspan 跨出 thead"的表强制整表进单个
 * tbody（Chrome 的 rowspan 裁剪在行组内，跨 thead/tbody 的 rowspan 不渲染）。
 * 只处理最外层表格（嵌套表在同一 DOM 遍历里一并处理）。
 * @param {string} html parseMD 产物（head+body 片段）
 * @returns {{ html: string, flattened: number }}
 */
function flattenCrossGroupRowspanTables(html) {
  if (!html || html.indexOf('<table') === -1) return { html, flattened: 0 };
  const OPEN_RE = /<table\b/gi;
  const CLOSE_RE = /<\/table\s*>/gi;

  const spans = [];
  let m;
  while ((m = OPEN_RE.exec(html))) {
    // 深度扫描找配对闭合（容忍嵌套表）
    let depth = 1;
    let pos = m.index + m[0].length;
    CLOSE_RE.lastIndex = pos;
    let cm;
    while ((cm = CLOSE_RE.exec(html))) {
      const between = html.slice(pos, cm.index);
      let inner;
      OPEN_RE.lastIndex = 0;
      while ((inner = OPEN_RE.exec(between))) depth++;
      pos = cm.index + cm[0].length;
      depth--;
      if (depth === 0) break;
    }
    if (depth !== 0) break; // 残缺 HTML：放弃，保持原样
    spans.push([m.index, pos]);
    OPEN_RE.lastIndex = pos;
  }

  let flattened = 0;
  let out = '';
  let pos = 0;
  for (const [start, end] of spans) {
    const frag = html.slice(start, end);
    const $ = cheerio.load(frag);
    let fragChanged = false;
    $('table').each((_i, el) => {
      if (tableHasCrossGroupRowspan($, el) && flattenTableRows($, el)) {
        fragChanged = true;
      }
    });
    if (fragChanged) {
      flattened++;
      out += html.slice(pos, start) + $.html();
      pos = end;
    }
  }
  if (pos > 0) out += html.slice(pos);
  return { html: out || html, flattened };
}

/**
 * 拍平表的表头行样式补偿：claude 系预设给 thead tr / table thead 画了下
 * 边框（var(--table-th-border)）；拍平后无 thead，用首行镜像同款。
 * 未定义该变量的主题回退 transparent（零视觉差异，不画多余线）。
 */
const FLAT_TABLE_COMPENSATION_CSS = `
/* mpe-export: thead 被拍平（.mpe-table-flat）后的表头行下边框补偿 */
.markdown-preview table.mpe-table-flat > tbody > tr:first-child {
  border-bottom: 0.5px solid var(--table-th-border, transparent);
}
`.trim();

module.exports = {
  normalizeLeftMergeInTables,
  flattenCrossGroupRowspanTables,
  FLAT_TABLE_COMPENSATION_CSS,
  splitTableRowCells,
};
