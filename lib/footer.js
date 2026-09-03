/**
 * sheet 分页模块 —— 与样式预设正交，任何预设/默认样式都可叠加。
 * 分页（--pagination / front-matter pagination: true）与页脚（--footer /
 * front-matter footer: true）独立开关；--footer 蕴含分页。
 *
 * 做法（移植自 scan-pdf-to-print-html 技能的 build_handout.py 分页器）：
 *  1. 在浏览器里把 .markdown-preview 的内容按块搬进固定 A4 尺寸的
 *     .mpe-sheet 页框（JS 自动分页，整页高度 = 纸张 − 页边距）——
 *     能放进一页的代码块/图片/引用块/callout/表格绝不从中间切断；
 *  2. 开页脚时：分页完成后扫描每个页框内的标题（h1–h4），维护当前章节
 *     路径，生成面包屑写进该页页脚 —— 页脚天然知道"当前页的章节位置"；
 *  3. --toc：分页完成后按各页真实标题生成目录页（标题 + 点线 + 页码），
 *     插在正文前；条目过多自动续页，页码计入目录页占用。
 *  4. --cover：首页封面（html iframe / 图片铺满），无页脚但计入总页数；
 *     顺序固定为 封面 → 目录页 → 正文。
 *  5. 页脚样式与 scan 项目一致：9px 灰字、顶部 1px 分隔线、
 *     左侧面包屑（当前节点橙色高亮）、右侧 第 N/M 页。
 *
 * page.pdf() 以 margin:0 打印，页边距由 .mpe-sheet 的 padding 承担，
 * 因此边距数值与预设定义完全一致，版式与无分页导出相同。
 *
 * 页脚定位：absolute 落在下页边距带内（距纸底 6mm），不占正文区高度，
 * 因此正文下缘到纸底的距离 = 预设 bottom 边距，与上边距视觉对称。
 */

const fs = require('fs');
const path = require('path');

/** 页脚美术字体：思源宋体可变字重（中文与数字同体） */
const FOOTER_FONT = {
  family: 'Noto Serif SC',
  file: 'NotoSerifSC-VariableFont_wght.ttf',
  weight: '200 900',
};

/** 页脚子集化基础字符集：ASCII + 页脚固定文案字符 + 常用 CJK 标点 */
const FOOTER_BASE_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  '第页共、。，；：？！（）《》〈〉【】「」『』—…·～>目录续';

/** Georgia 系统字体候选路径（Windows / macOS） */
const GEORGIA_PATHS = {
  regular: [
    'C:/Windows/Fonts/georgia.ttf',
    '/System/Library/Fonts/Supplemental/Georgia.ttf',
    '/Library/Fonts/Georgia.ttf',
  ],
  bold: [
    'C:/Windows/Fonts/georgiab.ttf',
    '/System/Library/Fonts/Supplemental/Georgia Bold.ttf',
    '/Library/Fonts/Georgia Bold.ttf',
  ],
};

/** Georgia 子集字符集：ASCII 可打印字符（页脚数字/西文够用） */
const GEORGIA_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~';

/** 纸张尺寸（mm），与 Chrome page.pdf() 的 format 对应 */
const PAGE_SIZES = {
  A4: [210, 297],
  A3: [297, 420],
  A5: [148, 210],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
};

/** scan 项目页脚配色（scripts/build_handout.py :root + updateSheetFooters） */
const FOOTER_COLOR = '#504e49'; // --muted
const FOOTER_LINE = '#e8e6dc'; // --line
const FOOTER_ACCENT = '#FB8B05'; // 面包屑当前节点 / 页码高亮

function escapeJsString(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * 生成注入打印页面的 CSS 与分页 JS。
 * @param {object} o
 * @param {string} [o.format='A4']   纸张（PAGE_SIZES 的 key，未知值回退 A4）
 * @param {boolean} [o.landscape=false]
 * @param {object} [o.margin]        {top,bottom,left,right}，CSS 长度字符串
 * @param {string} [o.docTitle]      无标题文档的面包屑兜底文本
 * @param {boolean} [o.footer=true]  是否生成页脚（false = 只分页不加页脚）
 * @param {string} [o.paginationLevel] 标题换页级别 'h1'|'h2'|null（父章节内
 *                                     第一个该级标题不换页，其余起新页）
 * @param {boolean} [o.toc=false]      插入目录页
 * @param {string} [o.tocLevel]        目录收录级别 'h1'|'h2'|'h3'（默认 h3）
 * @param {string} [o.tocTitle]        目录页标题（默认「目录」）
 * @param {string} [o.coverHref]       封面 file:// URL
 * @param {string} [o.coverKind]       'html' | 'image'
 * @param {string} [o.coverHtmlB64]    封面 HTML 的 base64（html 封面用 srcdoc）
 * @param {string} [o.coverBaseHref]   封面资源目录 file://（srcdoc 的 <base>）
 * @returns {{css: string, js: string}}
 */
function buildFooterAssets(o) {
  const footerOn = o.footer !== false;
  const tocOn = !!o.toc;
  const tocLevel = { h1: 1, h2: 2, h3: 3 }[o.tocLevel] || (tocOn ? 3 : 0);
  const tocTitle = (o.tocTitle && String(o.tocTitle).trim()) || '目录';
  const coverHref = o.coverHref || '';
  const coverKind = o.coverKind || '';
  const coverHtmlB64 = o.coverHtmlB64 || '';
  const coverBaseHref = o.coverBaseHref || '';
  const breakLevel = { h1: 1, h2: 2, h3: 3 }[o.paginationLevel] || 0;
  const size = PAGE_SIZES[o.format] || PAGE_SIZES.A4;
  let [w, h] = size;
  if (o.landscape) [w, h] = [h, w];
  const m = o.margin || {};
  const pad = `${m.top || '1cm'} ${m.right || '1cm'} ${m.bottom || '1cm'} ${m.left || '1cm'}`;

  const css = `
/* ============ sheet 分页 + 可选 scan 风格页脚（footer.js 注入） ============ */
@page { size: ${w}mm ${h}mm; margin: 0; }
body { margin: 0 !important; }
html[data-mpe-footer="loading"] #mpe-print-root { visibility: hidden; }
.mpe-sheet {
    display: block;
    position: relative;
    /* border-box：宽高含 padding，页框外尺寸严格等于纸张，
       否则 Chrome 打印会按内容溢出整体缩放，边距全部失真 */
    box-sizing: border-box;
    width: ${w}mm;
    height: ${h}mm;
    margin: 0 auto;
    padding: ${pad};
    overflow: hidden;
    page-break-after: always;
    break-after: page;
}
.mpe-sheet:last-child { page-break-after: auto; break-after: auto; }
.mpe-sheet[data-fit-state="overflow"] {
    outline: 1px dashed color-mix(in srgb, ${FOOTER_ACCENT} 45%, transparent);
}
/* 页体绝对铺在 padding 框内：高度由纸面决定，不随内容长高。
   否则 claude 等 flex 预设会让 clientHeight===scrollHeight，分页失效、整篇裁进一页。
   height:auto!important 是硬约束：crossnote 基础 CSS 的 .markdown-preview{height:100%}
   会给页体显式整页高，把 top+bottom 拉伸顶掉（过约束忽略 bottom）→ 页体下探盖住
   页脚带，分页容量也按整页误判，底部图片全部压到页脚上。 */
.mpe-sheet-body {
    position: absolute;
    top: ${m.top || '1cm'};
    right: ${m.right || '1cm'};
    bottom: ${footerOn ? `max(${m.bottom || '1cm'}, 14mm)` : m.bottom || '1cm'};
    left: ${m.left || '1cm'};
    height: auto !important;
    overflow: hidden;
}
.mpe-sheet-body > * { flex-shrink: 0; }
/* li 内拆分的续排片：序号透明占位 —— 宽度保留、文字与兄弟 li 对齐，
   且不重复显示被截断 li 的编号 */
.mpe-sheet-body li.mpe-li-cont::marker { color: transparent; }
/* sheet-body 复用 markdown-preview/crossnote 类以继承预设正文样式，
   但页面级几何（max-width/padding/margin）由 sheet 接管 */
.mpe-sheet-body.markdown-preview,
.mpe-sheet-body.crossnote {
    max-width: none !important;
    width: auto !important;
    padding: 0 !important;
    margin: 0 !important;
    display: block !important;
}
.mpe-sheet-footer {
    /* 绝对定位到下页边距带内（距纸底 6mm），不挤占正文区：
       正文下缘到纸底 = 预设 bottom 边距，与上边距对称 */
    position: absolute;
    left: ${m.left || '1cm'};
    right: ${m.right || '1cm'};
    bottom: 6mm;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 6mm;
    color: ${FOOTER_COLOR};
    /* 美术字体：数字/西文用 Georgia（与 scan 页脚在 Windows 上的实际渲染字体一致，
       老式风格数字），中文用思源宋体；均由导出器子集化内联，缺字回退系统宋体系 */
    font-family: "Georgia", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
    font-size: 9px;
    padding-top: 3mm;
    border-top: 1px solid ${FOOTER_LINE};
}
.mpe-sheet-footer .mpe-breadcrumb {
    flex: 1 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: left;
}
.mpe-breadcrumb:has(.wavy) {
    padding-bottom: 0.25em;
    margin-bottom: -0.25em;
}
.mpe-sheet-footer .mpe-page-label { flex: 0 0 auto; }
.mpe-sheet-footer strong { color: ${FOOTER_ACCENT}; font-weight: 700; }
/* 面包屑里的 KaTeX 公式随页脚字号同比缩小（KaTeX 默认 1.21em 会放大） */
.mpe-breadcrumb .katex { font-size: 1em; }
/* ---- 目录页（--toc；h1 进 PDF 书签，data-mpe-toc-title 防二次收录） ---- */
.mpe-toc-title {
    font-size: 22px;
    font-weight: 700;
    line-height: 1.2;
    margin: 0 0 1.5em;
}
.mpe-toc-title.mpe-toc-cont { font-size: 16px; font-weight: 600; }
.mpe-toc-item {
    display: flex;
    align-items: baseline;
    gap: 0.45em;
    margin: 0.3em 0;
    line-height: 1.65;
    font-size: 15px;
    break-inside: avoid;
    page-break-inside: avoid;
}
.mpe-toc-l1 { font-weight: 700; font-size: 16px; margin-top: 1.2em; }
.mpe-toc-title + .mpe-toc-item { margin-top: 0; }
.mpe-toc-l2 { padding-left: 1.2em; margin-top: 0.45em; }
.mpe-toc-l3 { padding-left: 2.4em; font-size: 14px; }
.mpe-toc-item-title {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
/* 标题中的波浪 SVG 绝对定位在行盒下方，不计入目录标题高度。
   扩展纵向裁切区，同时用负外边距保持目录行距和分页容量不变。 */
.mpe-toc-item-title:has(.wavy) {
    padding-bottom: 0.25em;
    margin-bottom: -0.25em;
}
.mpe-toc-item-title .katex { font-size: 1em; }
.mpe-toc-leader {
    flex: 1 1 auto;
    border-bottom: 1px dotted color-mix(in srgb, currentColor 55%, transparent);
    min-width: 1.2em;
    transform: translateY(-0.28em);
}
.mpe-toc-page {
    flex: 0 0 auto;
    font-family: "Georgia", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "SimSun", serif;
    font-variant-numeric: tabular-nums;
}
/* ---- 封面（--cover；无 padding / 无页脚，iframe 或 img 铺满纸面） ---- */
.mpe-sheet[data-mpe-cover] {
    padding: 0 !important;
}
.mpe-sheet[data-mpe-cover] .mpe-sheet-body {
    top: 0; right: 0; bottom: 0; left: 0;
    /* 覆盖全局 .mpe-sheet-body 的 height:auto!important（那是给正文页体防
       页脚重叠的）：封面页体必须恢复 inset 拉满整页，否则按内容高布局，
       封面图顶格、底部留空，上下不居中 */
    height: 100% !important;
    overflow: hidden;
    padding: 0 !important;
    margin: 0 !important;
}
/* 封面页体带 markdown-preview 类，预设主题的 .markdown-preview img 规则
   （inline-block + margin，特异性更高）会把封面图推离原位——这里用
   (0,3,1) 特异性 + !important 钉死铺满页体 */
.mpe-sheet[data-mpe-cover] .mpe-sheet-body .mpe-cover-frame,
.mpe-sheet[data-mpe-cover] .mpe-sheet-body .mpe-cover-image {
    display: block !important;
    width: 100% !important;
    height: 100% !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    border: 0 !important;
}
/* contain：等比缩放、水平垂直居中（object-position 默认 50% 50%），
   非 A4 比例图两侧/上下留对称窄边而不拉伸变形；A4 比例图视觉不变 */
.mpe-sheet[data-mpe-cover] .mpe-sheet-body .mpe-cover-image {
    object-fit: contain;
}
`;

  // 浏览器端分页脚本：与 scan 技能（postprocess_handout_for_contract.py）机制对齐：
  //   块级整页搬运（能放下的引用块/callout/图片/表格永不从中间打断）
  //   → 有序/无序列表按 li 跨页拆分（placeListBlock：<ol start> 续排编号，
  //     li 过高时再按 li 内子块拆分、续排片序号透明占位；缩进与样式不变）
  //   → 连接词与后续展示公式合并（mergeConnectorWithFollowingMath）
  //   → 超页高容器拆分兜底（splitOverlongQuestionCallout 的通用版）
  //   → 标题换页预标记（markHeadingBreaks：父章节内第一个该级标题不换页，
  //     其余强制起新页；标记只依赖文档顺序，重排后仍有效）
  //   → 尾部留白回填（rebalanceTrailingBlankSheets，强制换页边界不上提）
  //   → 孤儿标题清扫·剥离重排（sweepOrphanHeadings，重排保留换页标记）
  //   → 超高图片保护性缩小（mpe 兜底，防裁切）
  //   → 目录页注入（--toc：按分页后真实页码生成，插在正文前）
  //   → scan 风格面包屑页脚
  const js = `
(function () {
  var ACCENT = '${FOOTER_ACCENT}';
  var FALLBACK_TITLE = '${escapeJsString(o.docTitle || '')}';
  var FOOTER_ON = ${footerOn};
  var TOC_ON = ${tocOn};
  var TOC_LEVEL = ${tocLevel};
  var TOC_TITLE = '${escapeJsString(tocTitle)}';
  var COVER_HREF = '${escapeJsString(coverHref)}';
  var COVER_KIND = '${escapeJsString(coverKind)}';
  var COVER_HTML_B64 = '${coverHtmlB64}';
  var COVER_BASE = '${escapeJsString(coverBaseHref)}';
  // 标题换页级别（0=关闭）：父章节内第一个 ≤BREAK_LEVEL 级标题不换页，
  // 其余强制起新页；更高级标题出现时重置"第一个"资格（markHeadingBreaks）
  var BREAK_LEVEL = ${breakLevel};

  function waitAssets(root) {
    var images = Array.from(root.querySelectorAll('img'));
    var imgPromises = images.map(function (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    });
    var fonts = (document.fonts && document.fonts.ready) || Promise.resolve();
    return Promise.all(imgPromises.concat([fonts]));
  }

  function createSheet() {
    var sheet = document.createElement('article');
    sheet.className = 'mpe-sheet';
    sheet.dataset.fitState = 'ready';
    var body = document.createElement('section');
    body.className = 'mpe-sheet-body markdown-preview crossnote';
    sheet.appendChild(body);
    if (FOOTER_ON) {
      var footer = document.createElement('footer');
      footer.className = 'mpe-sheet-footer';
      var breadcrumb = document.createElement('span');
      breadcrumb.className = 'mpe-breadcrumb';
      var pageLabel = document.createElement('span');
      pageLabel.className = 'mpe-page-label';
      footer.append(breadcrumb, pageLabel);
      sheet.appendChild(footer);
    }
    return sheet;
  }

  function sheetOverflows(sheet) {
    var body = sheet.querySelector('.mpe-sheet-body');
    if (body.scrollHeight > body.clientHeight + 1) return true;
    var last = body.lastElementChild;
    if (!last) return false;
    return last.getBoundingClientRect().bottom > body.getBoundingClientRect().bottom + 1;
  }

  function setSheetState(sheet) {
    sheet.dataset.fitState = sheetOverflows(sheet) ? 'overflow' : 'ready';
  }

  function appendBlockToSheet(sheet, block) {
    var body = sheet.querySelector('.mpe-sheet-body');
    body.appendChild(block);
    var overflow = sheetOverflows(sheet);
    var blockCount = body.childNodes.length;
    if (overflow && blockCount > 1) {
      body.removeChild(block);
      setSheetState(sheet);
      return false;
    }
    setSheetState(sheet);
    return true;
  }

  // ---- 普通段落按真实渲染行跨页拆分 ----
  // 仅拆普通 <p>；图片、块级公式、代码等仍是原子块。Range.cloneContents()
  // 保留 mark/span/a 等行内结构，KaTeX、wavy、code 等作为一个不可拆行内单元。
  function isAtomicFlowBlock(block) {
    if (!block || block.nodeType !== 1) return false;
    if (/^(TABLE|FIGURE|BLOCKQUOTE|PRE|IMG|CANVAS)$/.test(block.tagName)) return true;
    if (block.classList.contains('callout')) return true;
    return !!block.querySelector('img, canvas, table, blockquote, .callout');
  }
  function isTextFlowBlock(block) {
    if (!block || block.nodeType !== 1 || block.tagName !== 'P') return false;
    if (isAtomicFlowBlock(block)) return false;
    return !block.querySelector(
      'img, canvas, table, pre, blockquote, .callout, .katex-display, ' +
      'math[display="block"], svg:not(.mpe-wavy-line)'
    );
  }
  function collectTextSplitUnits(root) {
    var units = [];
    var atomic = '.katex, .wavy, code, img, svg, canvas, math, br';
    function visit(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        for (var offset = 0; offset < node.data.length;) {
          var cp = node.data.codePointAt(offset);
          var next = offset + (cp > 0xFFFF ? 2 : 1);
          units.push({ node: node, start: offset, end: next });
          offset = next;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      if (node !== root && node.matches(atomic)) {
        units.push({ element: node });
        return;
      }
      Array.from(node.childNodes).forEach(visit);
    }
    visit(root);
    return units;
  }
  function rangeForSplitUnit(unit) {
    var range = document.createRange();
    if (unit.node) {
      range.setStart(unit.node, unit.start);
      range.setEnd(unit.node, unit.end);
    } else {
      range.selectNode(unit.element);
    }
    return range;
  }
  function boundaryAfterSplitUnit(unit) {
    if (unit.node) return { node: unit.node, offset: unit.end };
    var parent = unit.element.parentNode;
    return {
      node: parent,
      offset: Array.prototype.indexOf.call(parent.childNodes, unit.element) + 1,
    };
  }
  function splitTextBlockToFit(sheet, block) {
    var bodyBottom = sheet.querySelector('.mpe-sheet-body').getBoundingClientRect().bottom;
    var units = collectTextSplitUnits(block);
    var lastFit = -1;
    for (var i = 0; i < units.length; i++) {
      var rects = Array.from(rangeForSplitUnit(units[i]).getClientRects()).filter(function (r) {
        return r.width || r.height;
      });
      if (!rects.length) { lastFit = i; continue; }
      var bottom = Math.max.apply(null, rects.map(function (r) { return r.bottom; }));
      if (bottom <= bodyBottom + 0.5) lastFit = i;
      else break;
    }
    if (lastFit < 0 || lastFit >= units.length - 1) return null;

    var boundary = boundaryAfterSplitUnit(units[lastFit]);
    var headRange = document.createRange();
    headRange.selectNodeContents(block);
    headRange.setEnd(boundary.node, boundary.offset);
    var tailRange = document.createRange();
    tailRange.selectNodeContents(block);
    tailRange.setStart(boundary.node, boundary.offset);
    var head = block.cloneNode(false);
    var tail = block.cloneNode(false);
    head.appendChild(headRange.cloneContents());
    tail.appendChild(tailRange.cloneContents());
    tail.removeAttribute('id');
    if (!normText(head.textContent) || !normText(tail.textContent)) return null;

    block.replaceWith(head);
    if (sheetOverflows(sheet)) {
      head.replaceWith(block);
      return null;
    }
    return tail;
  }
  function placeTextBlock(sheet, block) {
    var body = sheet.querySelector('.mpe-sheet-body');
    var alone = body.children.length === 0;
    body.appendChild(block);
    if (!sheetOverflows(sheet)) { setSheetState(sheet); return 'full'; }
    var tail = splitTextBlockToFit(sheet, block);
    if (tail) { setSheetState(sheet); return { cont: tail }; }
    if (alone) { setSheetState(sheet); return { cont: null }; }
    body.removeChild(block);
    setSheetState(sheet);
    return null;
  }

  // ---- 列表按 li 递归跨页拆分（编号续排、缩进不变）----
  // 每一级 <ol>/<ul> 都逐个 li 试放；父 li 含“标题 + 子列表”时，标题至少
  // 带上第一条子项，否则父 li 整体移页。只有表格/图片/引用/callout 等原子块
  // 保持整块移动，普通列表不再因嵌套层级被当成一个大块。
  function isListBlock(b) {
    return !!(b && b.nodeType === 1 && (b.tagName === 'OL' || b.tagName === 'UL'));
  }

  function makeListContinuation(list, kids, placed, carryLi) {
    var rest = kids.slice(placed);
    var cont = null;
    if (carryLi || rest.length) {
      cont = list.cloneNode(false); // 外壳属性（class/style/type 等）全保留
      if (list.tagName === 'OL') {
        var s = parseInt(list.getAttribute('start') || '1', 10);
        if (isNaN(s)) s = 1;
        // 续块首 li 若是 li 内拆分的续排片（carryLi），其真实序号是被截断
        // li 的序号（s+placed-1）；否则首 li 是下一个完整 li（s+placed）。
        // 序号视觉上透明占位，此处取准是为了 PDF 文本层提取/搜索不出错号
        cont.setAttribute('start', String(s + placed - (carryLi ? 1 : 0)));
      }
      if (carryLi) cont.appendChild(carryLi);
      rest.forEach(function (k3) { cont.appendChild(k3); });
    }
    return cont;
  }

  // 已挂在当前页 DOM 中的 li 放不下时，按其子块继续拆分。遇到嵌套列表
  // 递归逐项试放；若父项标题之后连第一条子项都放不下，恢复整个 li 并返回
  // null，让调用方把父项标题与子列表一起移页（keep-with-next）。
  function splitListItemToFit(sheet, li) {
    var inner = Array.from(li.children);
    if (!inner.length) return null;
    inner.forEach(function (child) { li.removeChild(child); });
    var placed = 0;
    for (var i = 0; i < inner.length; i++) {
      var child = inner[i];
      li.appendChild(child);
      if (!sheetOverflows(sheet)) { placed += 1; continue; }

      if (isListBlock(child)) {
        var nested = splitAttachedListToFit(sheet, child);
        if (nested === 'full') { placed += 1; continue; }
        if (nested) {
          if (!nested.cont) { placed += 1; continue; }
          var nestedCarry = li.cloneNode(false);
          nestedCarry.classList.add('mpe-li-cont');
          nestedCarry.appendChild(nested.cont);
          inner.slice(i + 1).forEach(function (rest) { nestedCarry.appendChild(rest); });
          return { cont: nestedCarry };
        }
        // 标题可放、第一条子项不可放：不能把标题孤立在页末。
        while (li.firstChild) li.removeChild(li.firstChild);
        inner.forEach(function (original) { li.appendChild(original); });
        return null;
      }

      if (child.tagName === 'TABLE') {
        var tableSplit = splitAttachedTableToFit(sheet, child);
        if (tableSplit) {
          child.replaceWith(tableSplit.head);
          var tableCarry = li.cloneNode(false);
          tableCarry.classList.add('mpe-li-cont');
          tableCarry.appendChild(tableSplit.tail);
          inner.slice(i + 1).forEach(function (rest) { tableCarry.appendChild(rest); });
          return { cont: tableCarry };
        }
      }

      if (placed > 0 && inner[placed - 1].tagName === 'P' && isAtomicFlowBlock(child)) {
        // 紧邻表格/图片/引用/callout 的最后一个段落是说明标题。前面还有普通
        // 内容时只移动该标题；标题是 li 唯一前缀时则整个 li 一起移页。
        if (placed === 1) {
          while (li.firstChild) li.removeChild(li.firstChild);
          inner.forEach(function (original) { li.appendChild(original); });
          return null;
        }
        var atomicTitle = inner[placed - 1];
        li.removeChild(atomicTitle);
        var atomicCarry = li.cloneNode(false);
        atomicCarry.classList.add('mpe-li-cont');
        atomicCarry.appendChild(atomicTitle);
        atomicCarry.appendChild(child);
        inner.slice(i + 1).forEach(function (rest) { atomicCarry.appendChild(rest); });
        return { cont: atomicCarry };
      }

      if (isTextFlowBlock(child)) {
        var textTail = splitTextBlockToFit(sheet, child);
        if (textTail) {
          var textCarry = li.cloneNode(false);
          textCarry.classList.add('mpe-li-cont');
          textCarry.appendChild(textTail);
          inner.slice(i + 1).forEach(function (rest) { textCarry.appendChild(rest); });
          return { cont: textCarry };
        }
      }

      li.removeChild(child);
      if (placed > 0) {
        var carry = li.cloneNode(false);
        carry.classList.add('mpe-li-cont');
        carry.appendChild(child);
        inner.slice(i + 1).forEach(function (rest) { carry.appendChild(rest); });
        return { cont: carry };
      }
      inner.forEach(function (original) { li.appendChild(original); });
      return null;
    }
    return { cont: null };
  }

  // list 已经挂在当前页 DOM 中。返回 'full'（完整放下）、{cont}（本页放了
  // 前缀，cont 为续表）或 null（连第一条都放不下，DOM 已恢复原状）。
  function splitAttachedListToFit(sheet, list) {
    if (!sheetOverflows(sheet)) return 'full';
    if (list.getAttribute('reversed') !== null) return null;
    var kids = Array.from(list.children);
    kids.forEach(function (kid) { list.removeChild(kid); });
    var placed = 0;
    var carryLi = null;
    for (var i = 0; i < kids.length; i++) {
      var kid = kids[i];
      list.appendChild(kid);
      if (!sheetOverflows(sheet)) { placed += 1; continue; }
      if (kid.tagName === 'LI') {
        var split = splitListItemToFit(sheet, kid);
        if (split && !sheetOverflows(sheet)) {
          placed += 1;
          if (split.cont) {
            carryLi = split.cont;
            break;
          }
          continue;
        }
      }
      list.removeChild(kid);
      break;
    }
    if (placed === 0) {
      while (list.firstChild) list.removeChild(list.firstChild);
      kids.forEach(function (kid) { list.appendChild(kid); });
      return null;
    }
    return { cont: makeListContinuation(list, kids, placed, carryLi) };
  }

  // 返回值：'full' 整块放下；{cont: Element|null} 本页放了前缀；null 表示
  // 当前页放不下第一条，交调用方新开页。空页仍放不下时保留 overflow 兜底。
  function placeListBlock(sheet, list) {
    var body = sheet.querySelector('.mpe-sheet-body');
    var alone = body.children.length === 0;
    body.appendChild(list);
    if (!sheetOverflows(sheet)) { setSheetState(sheet); return 'full'; }
    var result = splitAttachedListToFit(sheet, list);
    if (result) {
      setSheetState(sheet);
      return result;
    }
    if (alone) { setSheetState(sheet); return { cont: null }; }
    body.removeChild(list);
    setSheetState(sheet);
    return null;
  }
  // 块落页统一入口：普通块保持原子搬移原语义；列表走 placeListBlock，
  // 续块插入 flow[i+1] 由外层循环继续分页。返回继续承接后续块的页框。
  function placeBlockAdv(root, sheet, block, flow, i) {
    if (isListBlock(block)) {
      var r = placeListBlock(sheet, block);
      if (r === 'full') return sheet;
      if (r) {
        if (r.cont && flow) flow.splice(i + 1, 0, r.cont);
        return sheet;
      }
      var pulled = pullTrailingHeadings(sheet);
      var fresh = startNewSheet(root, false);
      var fb = fresh.querySelector('.mpe-sheet-body');
      pulled.forEach(function (h) { fb.appendChild(h); });
      var r2 = placeListBlock(fresh, block);
      if (r2 === 'full') return fresh;
      if (r2) {
        if (r2.cont && flow) flow.splice(i + 1, 0, r2.cont);
        return fresh;
      }
      fb.appendChild(block); // 兜底（空页必非 null，仅 reversed 等边角可达）
      setSheetState(fresh);
      return fresh;
    }
    if (isTextFlowBlock(block)) {
      var textResult = placeTextBlock(sheet, block);
      if (textResult === 'full') return sheet;
      if (textResult) {
        if (textResult.cont && flow) flow.splice(i + 1, 0, textResult.cont);
        return sheet;
      }
      var textPulled = pullTrailingHeadings(sheet);
      var textSheet = startNewSheet(root, false);
      var textBody = textSheet.querySelector('.mpe-sheet-body');
      textPulled.forEach(function (h) { textBody.appendChild(h); });
      var nextText = placeTextBlock(textSheet, block);
      if (nextText && nextText.cont && flow) flow.splice(i + 1, 0, nextText.cont);
      return textSheet;
    }
    if (appendBlockToSheet(sheet, block)) return sheet;
    return startSheetWithPulled(root, sheet, block);
  }

  function normText(s) { return (s || '').replace(/\\s+/g, ' ').trim(); }

  // 标题内容提取：克隆已渲染节点（含 KaTeX 公式 DOM），剔除隐藏的
  // MathML 副本。页脚直接复用渲染结果，公式在面包屑里照常显示
  function headingContent(h) {
    var clone = h.cloneNode(true);
    Array.from(clone.querySelectorAll('.katex-mathml')).forEach(function (m) { m.remove(); });
    return { text: normText(clone.textContent), nodes: Array.from(clone.childNodes) };
  }
  function textContentOf(s) {
    return { text: s, nodes: [document.createTextNode(s)] };
  }

  // ---- 连接词 + 展示公式合并（scan: mergeConnectorWithFollowingMath）----
  // "解析/因此"这类单词段落若落在一页底部、公式被挤到下一页会很突兀，
  // 分页前把连接词块与紧随的块级公式并为一块
  function isConnectorOnlyBlock(block) {
    if (!block || block.nodeType !== 1 || block.tagName !== 'P') return false;
    return /^(因此|所以|从而|于是|则|故|可得|解析|证明)$/.test(normText(block.textContent));
  }
  function isDisplayMathOnlyBlock(block) {
    if (!block || block.nodeType !== 1) return false;
    if (block.querySelector('img, svg, canvas, table')) return false;
    return !!block.querySelector('.katex-display, math[display="block"]');
  }
  function mergeConnectorWithFollowingMath(blocks) {
    var merged = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var next = blocks[i + 1];
      if (isConnectorOnlyBlock(block) && next && isDisplayMathOnlyBlock(next)) {
        var wrapper = document.createElement('div');
        wrapper.appendChild(block);
        wrapper.appendChild(next);
        merged.push(wrapper);
        i += 1;
        continue;
      }
      merged.push(block);
    }
    return merged;
  }

  // ---- 超页高容器拆分兜底（scan: splitOverlongQuestionCallout 的通用版）----
  // 一整页都放不下的容器（引用块/callout/列表）按子节点切成多段，
  // 每段保留容器外壳样式；图片/公式/代码块等原子块不拆，标 overflow
  function isSplittableContainer(block) {
    if (!block || block.nodeType !== 1) return false;
    var tag = block.tagName;
    // UL/OL 不在此预拆：旧的一片一 li 不带 start，跨页后编号从 1 重排；
    // 列表改由落页时按 li 惰性拆分（placeListBlock），编号用 start 续排
    return tag === 'BLOCKQUOTE' || tag === 'TABLE' ||
      (tag === 'DIV' && block.classList.contains('callout'));
  }
  // ---- 表格按渲染行跨页拆分 ----
  // 每片保留 caption/colgroup/thead。rowspan 跨过切点时，在续页复制分组
  // 单元格并裁短 rowspan，避免续表缺列或错位；重复标签也让续页可独立阅读。
  function tableSplitModel(table) {
    var head = table.tHead;
    var rows = Array.from(table.rows).filter(function (row) {
      return !head || !head.contains(row);
    });
    if (rows.length < 2) return null;

    var entries = [];
    var occupiedUntil = [];
    var lastSection = null;
    rows.forEach(function (row, rowIndex) {
      if (row.parentElement !== lastSection) {
        occupiedUntil = [];
        lastSection = row.parentElement;
      }
      var col = 0;
      Array.from(row.cells).forEach(function (cell) {
        while ((occupiedUntil[col] || 0) > rowIndex) col += 1;
        var colspan = Math.max(1, cell.colSpan || 1);
        var rawRowspan = cell.getAttribute('rowspan');
        var endRow = rowIndex + Math.max(1, cell.rowSpan || 1);
        if (rawRowspan === '0') {
          endRow = rowIndex + 1;
          while (endRow < rows.length && rows[endRow].parentElement === row.parentElement) endRow += 1;
        }
        endRow = Math.min(rows.length, endRow);
        entries.push({
          cell: cell,
          row: rowIndex,
          col: col,
          colspan: colspan,
          endRow: endRow,
        });
        for (var c = col; c < col + colspan; c += 1) occupiedUntil[c] = endRow;
        col += colspan;
      });
    });
    return { table: table, head: head, rows: rows, entries: entries };
  }

  function cloneTableFrame(model) {
    var piece = model.table.cloneNode(false);
    Array.from(model.table.children).forEach(function (child) {
      if (child.tagName === 'CAPTION' || child.tagName === 'COLGROUP') {
        piece.appendChild(child.cloneNode(true));
      } else if (child.tagName === 'THEAD') {
        piece.appendChild(child.cloneNode(true));
      }
    });
    return piece;
  }

  function buildTablePiece(model, start, end) {
    var piece = cloneTableFrame(model);
    if (start > 0) piece.removeAttribute('id');
    var section = null;
    var sectionTag = '';
    for (var rowIndex = start; rowIndex < end; rowIndex += 1) {
      var sourceRow = model.rows[rowIndex];
      var sourceSection = sourceRow.parentElement;
      var wantedTag = /^(TBODY|TFOOT)$/.test(sourceSection.tagName)
        ? sourceSection.tagName
        : 'TBODY';
      if (!section || wantedTag !== sectionTag ||
          (rowIndex > start && model.rows[rowIndex - 1].parentElement !== sourceSection)) {
        section = /^(TBODY|TFOOT)$/.test(sourceSection.tagName)
          ? sourceSection.cloneNode(false)
          : document.createElement('tbody');
        piece.appendChild(section);
        sectionTag = wantedTag;
      }
      var row = sourceRow.cloneNode(false);
      var cells = model.entries.filter(function (entry) {
        return entry.row === rowIndex ||
          (rowIndex === start && entry.row < start && entry.endRow > start);
      }).sort(function (a, b) { return a.col - b.col; });
      cells.forEach(function (entry) {
        var cell = entry.cell.cloneNode(true);
        var span = Math.min(end, entry.endRow) - Math.max(start, entry.row);
        if (span > 1) cell.setAttribute('rowspan', String(span));
        else cell.removeAttribute('rowspan');
        if (entry.row < start) cell.dataset.mpeRowspanContinuation = '1';
        row.appendChild(cell);
      });
      section.appendChild(row);
    }
    return piece;
  }

  function splitAttachedTableToFit(sheet, table) {
    var model = tableSplitModel(table);
    if (!model) return null;
    var lastFit = 0;
    for (var end = 1; end <= model.rows.length; end += 1) {
      var candidate = buildTablePiece(model, 0, end);
      table.replaceWith(candidate);
      var fits = !sheetOverflows(sheet);
      candidate.replaceWith(table);
      if (!fits) break;
      lastFit = end;
    }
    if (lastFit <= 0 || lastFit >= model.rows.length) return null;
    return {
      head: buildTablePiece(model, 0, lastFit),
      tail: buildTablePiece(model, lastFit, model.rows.length),
    };
  }

  function measureTablePiece(probeBody, piece) {
    probeBody.appendChild(piece);
    var height = piece.getBoundingClientRect().height;
    probeBody.removeChild(piece);
    return height;
  }

  // 顶层超页表格预拆；嵌套列表中的表格会在真实落页宽度与剩余高度下惰性拆分。
  function splitTableByRows(table, probeBody, capacity, firstCapacity) {
    var model = tableSplitModel(table);
    if (!model) return [table];
    var pieces = [];
    var start = 0;
    var room = firstCapacity > 0 && firstCapacity < capacity ? firstCapacity : capacity;
    while (start < model.rows.length) {
      var lastFit = start;
      for (var end = start + 1; end <= model.rows.length; end += 1) {
        var candidate = buildTablePiece(model, start, end);
        if (room > 0 && measureTablePiece(probeBody, candidate) > room) break;
        lastFit = end;
      }
      if (lastFit === start && room < capacity) {
        room = capacity;
        continue;
      }
      if (lastFit === start) lastFit = start + 1;
      pieces.push(buildTablePiece(model, start, lastFit));
      start = lastFit;
      room = capacity;
    }
    return pieces.length > 1 ? pieces : [table];
  }
  function splitContainerBlock(block, probeBody, capacity, firstCapacity) {
    if (block.tagName === 'TABLE') return splitTableByRows(block, probeBody, capacity, firstCapacity);
    var kids = Array.from(block.children);
    if (kids.length < 2) return [block];
    var pieces = [];
    var start = 0;
    // callout 标题与第一段内容保持在同一片
    if (block.classList.contains('callout') && kids.length >= 3 &&
        kids[0].classList.contains('callout-title')) {
      var first = block.cloneNode(false);
      first.appendChild(kids[0]);
      first.appendChild(kids[1]);
      pieces.push(first);
      start = 2;
    }
    for (var i = 0; i < kids.length; i++) {
      if (i < start) continue;
      var c = block.cloneNode(false);
      c.appendChild(kids[i]);
      pieces.push(c);
    }
    return pieces.length > 1 ? pieces : [block];
  }
  // 分页前用隐藏探针页量出页体容量，把高于一页的可拆容器预拆分
  function expandOversizedBlocks(blocks) {
    var probe = createSheet();
    probe.style.position = 'absolute';
    probe.style.left = '-10000px';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    var body = probe.querySelector('.mpe-sheet-body');
    var capacity = body.clientHeight;
    var out = [];
    blocks.forEach(function (block, idx) {
      if (block.nodeType !== 1 || !isSplittableContainer(block)) {
        out.push(block);
        return;
      }
      body.appendChild(block);
      var h = block.getBoundingClientRect().height;
      body.removeChild(block);
      if (capacity > 0 && h > capacity) {
        // 前一块是标题时，第一片预留标题高度（标题要随表格第一片同页，防孤儿标题）
        var firstCap = capacity;
        var prev = blocks[idx - 1];
        if (prev && prev.nodeType === 1 && /^H[1-6]$/.test(prev.tagName)) {
          body.appendChild(prev);
          var ph = prev.getBoundingClientRect().height;
          body.removeChild(prev);
          var reserve = Math.ceil(ph) + 16;
          if (reserve < capacity * 0.4) firstCap = capacity - reserve;
        }
        splitContainerBlock(block, body, capacity, firstCap).forEach(function (p) { out.push(p); });
      } else {
        out.push(block);
      }
    });
    probe.remove();
    return out;
  }

  // ---- 尾部留白回填（scan: rebalanceTrailingBlankSheets）----
  // 页尾空白 >10% 时，尝试把下一页首个非保护块上提（溢出则回滚）。
  // 保护块（标题/引用块/callout）永不被移动，避免重新制造孤儿标题
  function meaningfulBlocks(sheet) {
    var body = sheet.querySelector('.mpe-sheet-body');
    return Array.from(body.children).filter(function (el) {
      return normText(el.textContent) || el.querySelector('img, svg, canvas, table, .katex, math');
    });
  }
  function trailingBlankRatio(sheet) {
    var body = sheet.querySelector('.mpe-sheet-body');
    var blocks = meaningfulBlocks(sheet);
    if (!blocks.length) return 0;
    var bodyRect = body.getBoundingClientRect();
    var lastRect = blocks[blocks.length - 1].getBoundingClientRect();
    return bodyRect.height ? Math.max(0, bodyRect.bottom - lastRect.bottom) / bodyRect.height : 0;
  }
  function isProtectedBlock(el) {
    return /^H[1-6]$/.test(el.tagName) || el.tagName === 'BLOCKQUOTE' ||
      el.classList.contains('callout');
  }
  function rebalanceTrailingBlankSheets(root) {
    var sheets = Array.from(root.querySelectorAll('.mpe-sheet'));
    for (var i = 0; i < sheets.length - 1; i++) {
      var prev = sheets[i];
      var next = sheets[i + 1];
      // 强制换页边界（标题换页）：不把右侧内容上提到前一页
      if (next.dataset.mpeForced) continue;
      var moved = true;
      while (moved) {
        moved = false;
        if (trailingBlankRatio(prev) <= 0.10) break;
        var nextBlocks = meaningfulBlocks(next);
        if (nextBlocks.length < 2) break;
        var candidate = nextBlocks[0];
        if (isProtectedBlock(candidate)) break;
        // 候选块后面紧跟标题时不上提（会把标题孤立在次页顶部语境之外）
        if (/^H[1-6]$/.test(nextBlocks[1].tagName)) break;
        var prevBody = prev.querySelector('.mpe-sheet-body');
        var nextBody = next.querySelector('.mpe-sheet-body');
        prevBody.appendChild(candidate);
        if (sheetOverflows(prev)) {
          nextBody.insertBefore(candidate, nextBody.firstChild);
          setSheetState(prev);
          setSheetState(next);
          break;
        }
        setSheetState(prev);
        setSheetState(next);
        moved = true;
      }
    }
  }

  // ---- 标题换页预标记（--pagination-level）----
  // 纯按文档顺序打标，与布局无关：每个父章节内第一个 ≤BREAK_LEVEL 级标题
  // 不换页，其余打 mpeBreakBefore 标记；更高级标题重置更深级别的"第一个"资格
  function markHeadingBreaks(blocks) {
    if (!BREAK_LEVEL) return;
    var seen = {};
    blocks.forEach(function (block) {
      if (block.nodeType !== 1 || !/^H[1-6]$/.test(block.tagName)) return;
      var lv = parseInt(block.tagName[1], 10);
      if (lv > BREAK_LEVEL) return;
      if (seen[lv]) block.dataset.mpeBreakBefore = '1';
      seen[lv] = true;
      for (var l = lv + 1; l <= BREAK_LEVEL; l++) seen[l] = false;
    });
  }
  function sheetHasContent(sheet) {
    return sheet.querySelector('.mpe-sheet-body').childNodes.length > 0;
  }
  // 防孤儿标题（scan 技能 pull-heading-forward 的移植）：块被拒到新页时，
  // 把上页尾部的连续标题一起带到新页，让标题始终与后续内容同页。
  // 不拉带 mpeBreakBefore 的标题（它们本来就是换页点），也绝不让上页被拉空。
  function pullTrailingHeadings(sheet) {
    var body = sheet.querySelector('.mpe-sheet-body');
    var out = [];
    while (
      body.children.length > 1 &&
      body.lastElementChild &&
      /^H[1-6]$/.test(body.lastElementChild.tagName) &&
      !body.lastElementChild.dataset.mpeBreakBefore
    ) {
      out.unshift(body.removeChild(body.lastElementChild));
    }
    if (out.length) setSheetState(sheet);
    return out;
  }
  // 把 pulled 标题 + block 落到新页；若标题+原子大块仍放不下，大块单独再起一页
  //（此时标题留守是不可避免代价，与 scan 的 unsplittable-tall 豁免一致）。
  function startSheetWithPulled(root, sheet, block) {
    var pulled = pullTrailingHeadings(sheet);
    var fresh = startNewSheet(root, false);
    var body = fresh.querySelector('.mpe-sheet-body');
    pulled.forEach(function (h) { body.appendChild(h); });
    if (appendBlockToSheet(fresh, block)) return fresh;
    var next = startNewSheet(root, false);
    appendBlockToSheet(next, block);
    return next;
  }
  function startNewSheet(root, forced) {
    var sheet = createSheet();
    if (forced) sheet.dataset.mpeForced = '1'; // 强制换页边界：回填不可跨越
    root.appendChild(sheet);
    return sheet;
  }

  // ---- 孤儿标题清扫（scan: sweepOrphanHeadings）----
  // 非末页的最后一个块若是标题 → 剥离该标题，从下一页起重排后续所有内容
  //（内容自然后移，而不是硬塞进本页）；每次清扫至少修一处，上限 200 轮
  function sweepOrphanHeadings(root) {
    var changed = true;
    var guard = 0;
    while (changed && guard < 200) {
      guard += 1;
      changed = false;
      var sheets = Array.from(root.querySelectorAll('.mpe-sheet'));
      for (var i = 0; i < sheets.length - 1; i++) {
        var prevBody = sheets[i].querySelector('.mpe-sheet-body');
        var kids = Array.from(prevBody.children);
        if (!kids.length) continue;
        var last = kids[kids.length - 1];
        if (!/^H[1-6]$/.test(last.tagName)) continue;
        // 已清扫过的标题不再重复清扫：否则"重排再造孤儿→再清扫"无限推进
        //（每轮净增一个被掏空的页框，200 轮后页数爆炸）。有 pullTrailingHeadings
        // 兜底后，真孤儿基本在落页时就已消除，这里只是最后防线。
        if (last.dataset.mpeSwept) continue;
        last.dataset.mpeSwept = '1';
        prevBody.removeChild(last);
        if (!prevBody.children.length) {
          // 标题是唯一内容：整页移除，不留空页框（空框会被后续扫描跳过并永久残留）
          sheets[i].remove();
        } else {
          setSheetState(sheets[i]);
        }
        var reflow = [last];
        for (var j = i + 1; j < sheets.length; j++) {
          var b = sheets[j].querySelector('.mpe-sheet-body');
          Array.from(b.children).forEach(function (c) { reflow.push(c); });
        }
        for (var j2 = sheets.length - 1; j2 > i; j2--) sheets[j2].remove();
        var cur = startNewSheet(root, false);
        for (var ri = 0; ri < reflow.length; ri++) {
          var blk = reflow[ri];
          // 重排保留标题换页标记（标记只依赖文档顺序，重排后仍有效）
          if (blk.dataset && blk.dataset.mpeBreakBefore && sheetHasContent(cur)) {
            cur = startNewSheet(root, true);
          }
          cur = placeBlockAdv(root, cur, blk, reflow, ri);
        }
        changed = true;
        break; // 页框列表已重建，从头再扫
      }
    }
  }

  // 分隔线或空续排列表若恰好被推到强制章节分页点前，不应单独占一页。
  // 图片/表格/公式即使无文本也属于实质内容，必须保留。
  function removeContentlessSheets(root) {
    Array.from(root.querySelectorAll('.mpe-sheet')).forEach(function (sheet) {
      if (sheet.dataset.mpeCover || sheet.dataset.mpeToc) return;
      var body = sheet.querySelector('.mpe-sheet-body');
      if (!body || normText(body.textContent)) return;
      if (body.querySelector('img, svg, canvas, table, .katex, math, iframe')) return;
      sheet.remove();
    });
  }

  // ---- 超高图片保护性缩小（mpe 兜底）----
  // scan 靠 fidelity 校验器报警；通用 CLI 工具没有人工复核环节，
  // 整图超过一页时等比缩小到页内，优于被 overflow:hidden 静默裁掉
  function shrinkOverflowImages(root) {
    Array.from(root.querySelectorAll('.mpe-sheet[data-fit-state="overflow"]')).forEach(function (sheet) {
      var body = sheet.querySelector('.mpe-sheet-body');
      var avail = body.clientHeight;
      if (!avail) return;
      Array.from(body.querySelectorAll('img')).forEach(function (img) {
        if (img.getBoundingClientRect().height > avail) {
          img.style.height = Math.floor(avail * 0.98) + 'px';
          img.style.width = 'auto';
          img.style.maxWidth = 'none';
        }
      });
      setSheetState(sheet);
    });
  }

  function headingLevel(h) {
    return parseInt(h.tagName[1], 10);
  }

  // ---- 目录页（--toc）----
  // 分页完成后扫描各正文页标题，用真实页码生成目录条目，再把目录
  // 页插到正文前。目录标题用 h1（进 PDF 书签），标 data-mpe-toc-title
  // 避免二次收录进目录。页码 = 目录页数 + 正文页序号。
  function collectTocEntries(root) {
    var sheets = Array.from(root.querySelectorAll('.mpe-sheet'));
    var entries = [];
    sheets.forEach(function (sheet, index) {
      if (sheet.dataset.mpeCover || sheet.dataset.mpeToc) return;
      Array.from(sheet.querySelectorAll('h1, h2, h3, h4, h5, h6')).forEach(function (h) {
        if (h.dataset.mpeTocTitle) return;
        var lv = headingLevel(h);
        if (lv > TOC_LEVEL) return;
        entries.push({ level: lv, content: headingContent(h), bodyIndex: index });
      });
    });
    return entries;
  }

  function makeTocTitle(cont) {
    var el = document.createElement('h1');
    el.className = 'mpe-toc-title' + (cont ? ' mpe-toc-cont' : '');
    el.dataset.mpeTocTitle = '1';
    el.textContent = cont ? TOC_TITLE + '（续）' : TOC_TITLE;
    return el;
  }

  function makeTocItem(entry, pageNumber) {
    var row = document.createElement('div');
    row.className = 'mpe-toc-item mpe-toc-l' + entry.level;
    var title = document.createElement('span');
    title.className = 'mpe-toc-item-title';
    entry.content.nodes.forEach(function (n) { title.appendChild(n.cloneNode(true)); });
    var leader = document.createElement('span');
    leader.className = 'mpe-toc-leader';
    var page = document.createElement('span');
    page.className = 'mpe-toc-page';
    page.textContent = String(pageNumber);
    row.append(title, leader, page);
    return row;
  }

  function waitCoverReady(sheet) {
    var img = sheet.querySelector('img.mpe-cover-image');
    if (img) {
      if (img.complete) return Promise.resolve();
      return new Promise(function (resolve) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      });
    }
    var frame = sheet.querySelector('iframe.mpe-cover-frame');
    if (!frame) return Promise.resolve();
    return new Promise(function (resolve) {
      var done = false;
      var settle = function () {
        if (done) return;
        done = true;
        resolve();
      };
      frame.addEventListener('load', function () {
        var n = 0;
        var lastH = -1;
        var stable = 0;
        var id = setInterval(function () {
          n += 1;
          try {
            var d = frame.contentDocument;
            if (d && d.documentElement && d.documentElement.dataset.handoutReady === 'true') {
              clearInterval(id);
              settle();
              return;
            }
            var h = (d && d.body && d.body.scrollHeight) || 0;
            if (h && h === lastH) stable += 1;
            else stable = 0;
            lastH = h;
            if (stable >= 6) { clearInterval(id); settle(); return; }
          } catch (e) { /* 跨源：等固定时长 */ }
          if (n >= 50) { clearInterval(id); settle(); }
        }, 80);
      }, { once: true });
      setTimeout(settle, 6000);
    });
  }

  function injectCoverSheet(root) {
    if (!COVER_HREF) return 0;
    var sheet = createSheet();
    sheet.dataset.mpeCover = '1';
    sheet.dataset.sheetRole = 'cover';
    var foot = sheet.querySelector('.mpe-sheet-footer');
    if (foot) foot.remove();
    var body = sheet.querySelector('.mpe-sheet-body');
    if (COVER_KIND === 'html') {
      var frame = document.createElement('iframe');
      frame.className = 'mpe-cover-frame';
      frame.setAttribute('scrolling', 'no');
      var html = COVER_HTML_B64 ? (function (b64) {
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
      })(COVER_HTML_B64) : '';
      if (COVER_BASE && html) {
        html = html.replace(/<head([^>]*)>/i, '<head$1><base href="' + COVER_BASE + '">');
      }
      if (html) frame.srcdoc = html;
      else frame.src = COVER_HREF;
      body.appendChild(frame);
    } else {
      var img = document.createElement('img');
      img.className = 'mpe-cover-image';
      img.src = COVER_HREF;
      img.alt = '封面';
      body.appendChild(img);
    }
    root.insertBefore(sheet, root.firstChild);
    return 1;
  }

  function injectTocPages(root, coverCount) {
    if (!TOC_ON) return;
    var entries = collectTocEntries(root);
    if (!entries.length) return;
    coverCount = coverCount || 0;

    // 先按「1 页目录」估页码，装不下再加页并重算（目录页数影响正文页码）
    var tocCount = 1;
    var tocSheets;
    var guard = 0;
    var probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-10000px;visibility:hidden;';
    document.body.appendChild(probe);
    while (guard < 8) {
      guard += 1;
      probe.innerHTML = '';
      tocSheets = [];
      var sheet = createSheet();
      sheet.dataset.mpeToc = '1';
      probe.appendChild(sheet);
      var body = sheet.querySelector('.mpe-sheet-body');
      body.appendChild(makeTocTitle(false));
      tocSheets.push(sheet);
      for (var i = 0; i < entries.length; i++) {
        var item = makeTocItem(entries[i], coverCount + tocCount + entries[i].bodyIndex + 1);
        body.appendChild(item);
        if (sheetOverflows(sheet) && body.childNodes.length > 2) {
          body.removeChild(item);
          setSheetState(sheet);
          sheet = createSheet();
          sheet.dataset.mpeToc = '1';
          probe.appendChild(sheet);
          body = sheet.querySelector('.mpe-sheet-body');
          body.appendChild(makeTocTitle(true));
          body.appendChild(item);
          tocSheets.push(sheet);
        }
        setSheetState(sheet);
      }
      if (tocSheets.length === tocCount) break;
      tocCount = tocSheets.length;
      tocSheets.forEach(function (s) { s.remove(); });
    }
    probe.remove();

    var first = root.firstChild;
    tocSheets.forEach(function (s) { root.insertBefore(s, first); });
  }

  function updateSheetFooters(root) {
    if (!FOOTER_ON) return;
    var sheets = Array.from(root.querySelectorAll('.mpe-sheet'));
    var total = sheets.length;
    // 每级标题存 {text, nodes}：text 用于判空，nodes 是含渲染公式的克隆节点
    var currentPath = { 1: null, 2: null, 3: null, 4: null };
    var lastParts = [textContentOf(FALLBACK_TITLE)];

    sheets.forEach(function (sheet, index) {
      if (sheet.dataset.mpeCover) return;
      var footer = sheet.querySelector('.mpe-sheet-footer');
      if (!footer) return;
      if (sheet.dataset.mpeToc) {
        lastParts = [textContentOf(TOC_TITLE)];
      } else {
        var headings = Array.from(sheet.querySelectorAll('h1, h2, h3, h4'));
        if (headings.length > 0) {
          headings.forEach(function (h) {
            var level = parseInt(h.tagName[1], 10);
            currentPath[level] = headingContent(h);
            for (var l = level + 1; l <= 4; l += 1) currentPath[l] = null;
          });
          var primaryLevel = parseInt(headings[headings.length - 1].tagName[1], 10);
          var parts = [];
          for (var l2 = 1; l2 <= primaryLevel; l2 += 1) {
            if (currentPath[l2] && currentPath[l2].text) parts.push(currentPath[l2]);
          }
          if (parts.length) lastParts = parts;
        }
      }

      var pageNumber = index + 1;
      var label = footer.querySelector('.mpe-page-label');
      var breadcrumb = footer.querySelector('.mpe-breadcrumb');
      label.innerHTML = '第 <strong>' + pageNumber + '</strong>/' + total + ' 页';
      breadcrumb.innerHTML = '';
      lastParts.forEach(function (part, idx) {
        if (idx > 0) breadcrumb.append(' > ');
        // 末段（当前章节）橙色高亮；节点克隆保留 KaTeX 渲染结果
        var wrap = idx === lastParts.length - 1 ? document.createElement('strong') : breadcrumb;
        part.nodes.forEach(function (n) { wrap.appendChild(n.cloneNode(true)); });
        if (wrap !== breadcrumb) breadcrumb.appendChild(wrap);
      });
    });
  }

  async function paginate() {
    document.documentElement.dataset.mpeFooter = 'loading';
    var source = document.querySelector('.markdown-preview');
    if (!source) {
      console.warn('[mpe-export] 未找到 .markdown-preview 容器，跳过页脚分页');
      document.documentElement.dataset.mpeFooter = 'true';
      return;
    }
    await waitAssets(source);

    var blocks = Array.from(source.childNodes).filter(function (node) {
      return node.nodeType !== Node.TEXT_NODE || node.textContent.trim();
    });
    // 分页前的块流整理（与 scan 同序）：连接词合并公式 → 超页高容器拆分
    blocks = expandOversizedBlocks(mergeConnectorWithFollowingMath(blocks));
    // 标题换页预标记（--pagination-level；只依赖文档顺序）
    markHeadingBreaks(blocks);
    var root = document.createElement('div');
    root.id = 'mpe-print-root';
    document.body.appendChild(root);

    var sheet = startNewSheet(root, false);
    for (var i = 0; i < blocks.length; i++) {
      var blk = blocks[i];
      if (blk.dataset && blk.dataset.mpeBreakBefore && sheetHasContent(sheet)) {
        sheet = startNewSheet(root, true);
      }
      sheet = placeBlockAdv(root, sheet, blk, blocks, i);
    }

    // 分页后清理（与 scan 同序）：尾部留白回填 → 孤儿标题清扫
    rebalanceTrailingBlankSheets(root);
    sweepOrphanHeadings(root);
    removeContentlessSheets(root);
    // mpe 兜底：仍超页的图片等比缩小，避免被裁切
    shrinkOverflowImages(root);
    // 目录 → 再封面插到最前：最终顺序 封面 → 目录 → 正文
    injectTocPages(root, COVER_HREF ? 1 : 0);
    if (COVER_HREF) {
      injectCoverSheet(root);
      var coverSheet = root.querySelector('.mpe-sheet[data-mpe-cover]');
      if (coverSheet) await waitCoverReady(coverSheet);
    }
    updateSheetFooters(root);
    source.remove();
    // 清掉 body 里页框以外的所有节点（crossnote 模板的残余 div、
    // 空白文本节点等），它们会在最后一页后面撑出一张空白页
    Array.from(document.body.childNodes).forEach(function (node) {
      if (node === root) return;
      if (node.nodeType === Node.ELEMENT_NODE) {
        var tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'LINK') return;
      }
      node.remove();
    });
    document.documentElement.dataset.mpeFooter = 'true';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { void paginate(); }, { once: true });
  } else {
    void paginate();
  }
})();
`;

  return { css, js };
}

module.exports = { buildFooterAssets, buildFooterFontCss, PAGE_SIZES };

/**
 * 页脚美术字体子集化内联：
 *  - Georgia（常规+粗体，系统字体，只子集 ASCII）：页码/西文，老式风格数字
 *  - Noto Serif SC 可变字重（项目内字体）：中文
 * 失败静默降级为系统字体（Chrome 打印 PDF 时仍会嵌入系统字体，仅 HTML 可移植性略降）。
 * @param {string} docText 文档全文（用于确定中文字符集）
 * @returns {Promise<string>} <style> 片段或空串
 */
async function buildFooterFontCss(docText) {
  let subsetFont;
  try {
    subsetFont = require('subset-font');
  } catch {
    return '';
  }
  const faces = [];

  // Georgia：数字与西文（ASCII 子集，粗体供 strong 页码/当前章节高亮）
  const georgia = [
    { weight: '400', paths: GEORGIA_PATHS.regular },
    { weight: '700', paths: GEORGIA_PATHS.bold },
  ];
  for (const g of georgia) {
    const fontPath = g.paths.find((p) => fs.existsSync(p));
    if (!fontPath) continue;
    try {
      const subset = await subsetFont(fs.readFileSync(fontPath), GEORGIA_CHARS, {
        targetFormat: 'woff2',
      });
      faces.push(
        `@font-face { font-family: "Georgia"; ` +
          `src: url("data:font/woff2;base64,${Buffer.from(subset).toString('base64')}") format("woff2"); ` +
          `font-weight: ${g.weight}; font-style: normal; font-display: swap; }`,
      );
    } catch (e) {
      process.stderr.write(`[mpe-export] 页脚 Georgia 子集化跳过: ${e.message}\n`);
    }
  }

  // Noto Serif SC：中文（项目内字体，按文档字符子集化）
  try {
    const buf = fs.readFileSync(path.join(__dirname, 'presets', 'fonts', FOOTER_FONT.file));
    const subset = await subsetFont(buf, FOOTER_BASE_CHARS + docText, {
      targetFormat: 'woff2',
    });
    faces.push(
      `@font-face { font-family: "${FOOTER_FONT.family}"; ` +
        `src: url("data:font/woff2;base64,${Buffer.from(subset).toString('base64')}") format("woff2"); ` +
        `font-weight: ${FOOTER_FONT.weight}; font-style: normal; font-display: swap; }`,
    );
  } catch (e) {
    process.stderr.write(`[mpe-export] 页脚字体子集化跳过: ${e.message}\n`);
  }

  return faces.length ? `<style>${faces.join('\n')}</style>` : '';
}
