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
 *  3. 页脚样式与 scan 项目一致：9px 灰字、顶部 1px 分隔线、
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
  '第页共、。，；：？！（）《》〈〉【】「」『』—…·～>';

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
 * @returns {{css: string, js: string}}
 */
function buildFooterAssets(o) {
  const footerOn = o.footer !== false;
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
    display: grid;
    grid-template-rows: minmax(0, 1fr);
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
.mpe-sheet-body { min-height: 0; overflow: hidden; }
/* 防护：预设若把 .markdown-preview 设为 flex 列布局（如 claude 主题），
   子元素默认 flex-shrink:1，容器装满后会被定高压缩——offsetHeight 测出
   塌陷高度、scrollHeight 也不再反映溢出，分页器会把放不下的块硬塞进
   已满的页，打印时被 overflow:hidden 拦腰裁断。禁止收缩后高度恒为
   自然高度，溢出可正常检测。 */
.mpe-sheet-body > * { flex-shrink: 0; }
/* sheet-body 复用 markdown-preview/crossnote 类以继承预设正文样式，
   但页面级几何（max-width/padding/margin）由 sheet 接管 */
.mpe-sheet-body.markdown-preview,
.mpe-sheet-body.crossnote {
    max-width: none !important;
    width: 100% !important;
    padding: 0 !important;
    margin: 0 !important;
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
.mpe-sheet-footer .mpe-page-label { flex: 0 0 auto; }
.mpe-sheet-footer strong { color: ${FOOTER_ACCENT}; font-weight: 700; }
/* 面包屑里的 KaTeX 公式随页脚字号同比缩小（KaTeX 默认 1.21em 会放大） */
.mpe-breadcrumb .katex { font-size: 1em; }
`;

  // 浏览器端分页脚本：与 scan 技能（postprocess_handout_for_contract.py）机制对齐：
  //   块级整页搬运（能放下的引用块/callout/图片/表格永不从中间打断）
  //   → 连接词与后续展示公式合并（mergeConnectorWithFollowingMath）
  //   → 超页高容器拆分兜底（splitOverlongQuestionCallout 的通用版）
  //   → 标题换页预标记（markHeadingBreaks：父章节内第一个该级标题不换页，
  //     其余强制起新页；标记只依赖文档顺序，重排后仍有效）
  //   → 尾部留白回填（rebalanceTrailingBlankSheets，强制换页边界不上提）
  //   → 孤儿标题清扫·剥离重排（sweepOrphanHeadings，重排保留换页标记）
  //   → 超高图片保护性缩小（mpe 兜底，防裁切）→ scan 风格面包屑页脚
  const js = `
(function () {
  var ACCENT = '${FOOTER_ACCENT}';
  var FALLBACK_TITLE = '${escapeJsString(o.docTitle || '')}';
  var FOOTER_ON = ${footerOn};
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
    return body.scrollHeight > body.clientHeight + 1;
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
    return tag === 'BLOCKQUOTE' || tag === 'UL' || tag === 'OL' ||
      (tag === 'DIV' && block.classList.contains('callout'));
  }
  function splitContainerBlock(block) {
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
    blocks.forEach(function (block) {
      if (block.nodeType !== 1 || !isSplittableContainer(block)) {
        out.push(block);
        return;
      }
      body.appendChild(block);
      var h = block.getBoundingClientRect().height;
      body.removeChild(block);
      if (capacity > 0 && h > capacity) {
        splitContainerBlock(block).forEach(function (p) { out.push(p); });
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
        prevBody.removeChild(last);
        setSheetState(sheets[i]);
        var reflow = [last];
        for (var j = i + 1; j < sheets.length; j++) {
          var b = sheets[j].querySelector('.mpe-sheet-body');
          Array.from(b.children).forEach(function (c) { reflow.push(c); });
        }
        for (var j2 = sheets.length - 1; j2 > i; j2--) sheets[j2].remove();
        var cur = startNewSheet(root, false);
        reflow.forEach(function (blk) {
          // 重排保留标题换页标记（标记只依赖文档顺序，重排后仍有效）
          if (blk.dataset && blk.dataset.mpeBreakBefore && sheetHasContent(cur)) {
            cur = startNewSheet(root, true);
          }
          if (appendBlockToSheet(cur, blk)) return;
          cur = startNewSheet(root, false);
          appendBlockToSheet(cur, blk);
        });
        changed = true;
        break; // 页框列表已重建，从头再扫
      }
    }
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

  function updateSheetFooters(root) {
    if (!FOOTER_ON) return;
    var sheets = Array.from(root.querySelectorAll('.mpe-sheet'));
    var total = sheets.length;
    // 每级标题存 {text, nodes}：text 用于判空，nodes 是含渲染公式的克隆节点
    var currentPath = { 1: null, 2: null, 3: null, 4: null };
    var lastParts = [textContentOf(FALLBACK_TITLE)];

    sheets.forEach(function (sheet, index) {
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

      var pageNumber = index + 1;
      var footer = sheet.querySelector('.mpe-sheet-footer');
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
      if (appendBlockToSheet(sheet, blk)) continue;
      sheet = startNewSheet(root, false);
      appendBlockToSheet(sheet, blk);
    }

    // 分页后清理（与 scan 同序）：尾部留白回填 → 孤儿标题清扫
    rebalanceTrailingBlankSheets(root);
    sweepOrphanHeadings(root);
    // mpe 兜底：仍超页的图片等比缩小，避免被裁切
    shrinkOverflowImages(root);
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
