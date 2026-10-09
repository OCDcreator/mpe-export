/**
 * html-transforms.js —— 渲染后 HTML 的 DOM 级变换（onDidParseMarkdown 链上的纯函数族）
 *
 * exporter.js 的 onDidParseMarkdown 钩子按开关顺序调用本模块（全部返回
 * { text, count } 式结果供调用方统计上报，count=0 表示零改动、原样返回）：
 *   1. rewriteImageSizeHtml      图片数值宽度 ![alt|400] / ![alt|400x300]（默认开）
 *   2. addLineNumbersToCodeBlocks 代码块行号列（--line-numbers，默认关）
 *   3. numberFigureCaptions      图表题注顺序编号（--number-figures，默认关）
 *   以及 lineNumbersAlignCss：行号列 top 对齐补偿 CSS（includeInHeader 注入用）。
 */

'use strict';

// ============================================================================
// 图片数值宽度语法：![alt|400](src) / ![alt|400x300](src)
//
// 实证：crossnote v1.x 不支持 MPE 图片尺寸语法——`![alt|400](src)` 渲染出的
// img 仅 alt="alt|400"，无任何宽高标记（markdown-it 默认 image 规则）。
// 这里在 onDidParseMarkdown 的 HTML 上补齐：把 alt 末尾的 |W / |WxH 挪成
// style width/height，其余 alt 文本原样保留——图片对齐语法是 alt 子串匹配
// （p>img[alt*="center"]），只剥尺寸 token 即可两边同时命中。
// 与 exporter 的 IMG_FIT_OVERRIDE_CSS 协作：W 单值时高度交给样式表
// height:auto 等比缩放、超宽被 max-width:100% 钳制；WxH 双值按 MPE 语义
// 锁定两维（行内 style 压过 height:auto；钳制时高度固定，极端比例图会变形，
// 属显式要求的取舍）。
// ============================================================================
function rewriteImageSizeHtml(html) {
  let count = 0;
  const out = String(html).replace(/<img\b([^>]*)>/gi, (full, attrs) => {
    const altM = attrs.match(/\balt\s*=\s*(["'])([\s\S]*?)\1/i);
    if (!altM) return full;
    // 只认 alt 末尾的尺寸 token（MPE 语义），如 "center|400"、"图|400x300"
    const sizeM = altM[2].match(/^(.*\S)?\s*\|\s*(\d+(?:\.\d+)?)(?:x(\d+(?:\.\d+)?))?\s*$/);
    if (!sizeM) return full;
    const altText = (sizeM[1] || '').trim();
    const style = `width:${sizeM[2]}px;` + (sizeM[3] ? `height:${sizeM[3]}px;` : '');
    let newAttrs = attrs.replace(
      /\s*\balt\s*=\s*(["'])([\s\S]*?)\1/i,
      (m0, q) => ` alt=${q}${altText}${q}`,
    );
    const styleM = newAttrs.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
    if (styleM) {
      // 已有 style：尺寸声明后置（同特异性下 CSS 后声明胜出）。若前置拼接，
      // `alt="keep|400" style="width:50%"` 会得到 width:400px;width:50%，
      // 尺寸 token 被既有声明静默压过，与「转成显式宽高」语义矛盾。
      newAttrs = newAttrs.replace(
        /\sstyle\s*=\s*(["'])([\s\S]*?)\1/i,
        (m0, q, s0) => {
          const sep = s0.trim() === '' || /;\s*$/.test(s0) ? '' : ';';
          return ` style=${q}${s0}${sep}${style}${q}`;
        },
      );
    } else {
      newAttrs += ` style="${style}"`;
    }
    count++;
    return `<img${newAttrs}>`;
  });
  return { text: out, count };
}

// ============================================================================
// 代码块行号（可选，默认关）
//
// 实证：crossnote 原生支持 MPE 的 ```lang {.line-numbers} 围栏属性——
// parseMD 内的 cheerio 增强器（JA）给 pre.line-numbers 追加 .line-numbers-rows
// 空行号列（Prism Line Numbers 插件 DOM），结构 CSS 常驻 style-template.css
// （pre 相对定位 + padding-left 3.8em + counter 自增）。行号列是独立绝对
// 定位层、按行盒计数，与 Prism 令牌是否跨行无关，分页器把 pre 当原子块
// 整块搬运时行号列随行 —— 自研逐行包裹方案的两个已知坑（令牌跨行、HTML
// 实体）都不存在。
//
// 接线：总开关（--line-numbers / front-matter line-numbers: true）走
// onDidParseMarkdown DOM 变换。注意 parseMD 管线里 onDidParseMarkdown 在
// 增强器 JA 之后执行，此刻只补 class 来不及（JA 已经跑完），所以这里按
// uG 同款逻辑直接补行号列 DOM；原生围栏属性块（JA 已加过 rows）自动跳过，
// 单块手工 ```lang {.line-numbers} 在总开关关闭时也照常生效。
// 已知取舍：pre 为软换行（pre-wrap）时，折行后的行号会逐行上移错位——
// 行号列按行盒计数，无法感知折行；长行代码建议控制行宽。
// ============================================================================
const MPE_DIAGRAM_LANGS = new Set([
  'mermaid', 'puml', 'plantuml', 'wavedrom', 'bitfield', 'bit-field',
  'graphviz', 'viz', 'dot', 'vega', 'vega-lite', 'wsd', 'd2', 'tikz',
]);

function addLineNumbersToCodeBlocks(html) {
  let count = 0;
  const out = String(html).replace(/<pre\b([^>]*)>([\s\S]*?)<\/pre>/gi, (full, attrs, inner) => {
    if (!/data-role\s*=\s*["']codeBlock["']/.test(attrs)) return full;
    if (/\bline-numbers\b/.test(attrs) || /line-numbers-rows/.test(inner)) return full;
    const infoM = attrs.match(/\bdata-info\s*=\s*["']([^"']*)["']/i);
    const lang = infoM ? infoM[1].trim().split(/\s+/)[0].toLowerCase() : '';
    if (MPE_DIAGRAM_LANGS.has(lang)) return full; // 图表块渲染成 SVG，行号无意义
    // 行数按代码文本行盒数计（与 crossnote uG 同款：\n(?!$) 计数 +1）
    const codeText = inner.replace(/<[^>]*>/g, '');
    if (!codeText.trim()) return full;
    const lines = codeText.match(/\n(?!$)/g);
    const total = lines ? lines.length + 1 : 1;
    const rows =
      '<span aria-hidden="true" class="line-numbers-rows">' +
      '<span></span>'.repeat(total) +
      '</span>';
    let newAttrs = attrs;
    const classM = newAttrs.match(/\sclass\s*=\s*["']([^"']*)["']/i);
    if (classM) {
      newAttrs = newAttrs.replace(
        /\sclass\s*=\s*["']([^"']*)["']/i,
        (m0, c) => ` class="${c} line-numbers"`,
      );
    } else {
      newAttrs += ' class="line-numbers"';
    }
    count++;
    return `<pre${newAttrs}>${inner}${rows}</pre>`;
  });
  return { text: out, count };
}

/** 行号列 top 对齐补偿：crossnote 模板默认 top:1em（配 prism 主题 1em 顶边距），
 *  预设改了 pre 顶内边距/加了语言头栏时按 preset.lineNumbersTop 矫正。 */
function lineNumbersAlignCss(top) {
  return (
    `\n/* mpe-export: 行号列与 pre 顶内边距/头栏对齐补偿 */\n` +
    `.markdown-preview pre.line-numbers .line-numbers-rows { top: ${top}; }`
  );
}

// ============================================================================
// 图表编号（可选，默认关）--number-figures / front-matter number-figures: true
//
// 约定（保持简单，不做 alt="caption" 之类的另一套形态）：
//   块级图片（段落内只有一张 img）或表格的**紧跟段落**（中间只允许空白），
//   其文本以 图|Figure（图）或 表|Table（表）开头（后接可选空格 + 可选序号
//   + 可选冒号/：）时视为该图/表的题注，开头被改写为「图 N：原文剩余」/
//   「表 N：…」/「Figure N: …」（N 按图/表两类独立递增；原文已有的编号
//   数字被规范替换）。题注词与对象类型须对应（图/Figure 配图片、表/Table
//   配表格）：表格后跟「图…」段落不认、图片后跟「表…」段落也不认。
//   匹配不到题注的图/表不编号、不占号——编号始终连续。
//
// 为什么是分页前 DOM 预编号而不是 CSS counter：自研分页器把跨页大表拆片
// 时会克隆表格内部节点（buildTablePiece），counter 在克隆上重复自增会跳号。
// 这里直接把编号写进题注文本（onDidParseMarkdown 钩子，早于分页），分页器
// 克隆的任何片段天然带着最终编号——clone-safe by construction。
//
// 幂等：导出管线里 onDidParseMarkdown 会被调用多次（引擎对同一源文档不止
// parseMD 一次），改写后的「图 1：…」再次进入本函数时旧编号 1 被新计数器
// 的 1 原样替换，多轮变换结果逐字节一致。
//
// 已知边界（启发式约定的固有取舍，宁可不编也不发明结构）：
//   - 题注必须以纯文本开头（<p>图…）；「**图 1：…**」这类段首带行内标记的
//     不改写（强改会在标记边界上撕裂格式），对应图/表按无题注处理不编号；
//   - 隔了空行以外的任何元素（正文段、其他图/表）不算紧跟，不编号；
//   - 段首「图表…」「表格…」这类以 图/表 打头的普通词，若恰好紧跟图/表
//     会被当作题注（约定的最小实现，不做分词）。
// ============================================================================
const FIGCAP_CAPTION_RE = /^\s*(图|表|Figure|Table)(\s*)(\d+(?:[.\u2012-\u2015-]\d+)*)?(\s*)([：:])?([\s\S]*)$/i;
const FIGCAP_IMG_PARA_RE = /<p\b[^>]*>\s*<img\b[^>]*>\s*<\/p>|<table\b[^>]*>[\s\S]*?<\/table>/gi;

/**
 * 给题注段落写入顺序编号（详见上方约定）。
 * @param {string} html parseMD 产物（onDidParseMarkdown 链上，表格拍平之后）
 * @returns {{ text: string, figures: number, tables: number, count: number }}
 *          figures/tables 为本次实际编号的图/表数，count 为改写段落数
 */
function numberFigureCaptions(html) {
  const src = String(html);
  let figNo = 0;
  let tabNo = 0;
  let out = '';
  let pos = 0;
  FIGCAP_IMG_PARA_RE.lastIndex = 0;
  let m;
  while ((m = FIGCAP_IMG_PARA_RE.exec(src))) {
    out += src.slice(pos, m.index) + m[0];
    pos = m.index + m[0].length;
    const isImage = !/^<table\b/i.test(m[0]);
    // 紧跟的第一个段落：块间只允许空白；不匹配则该图/表保持无题注
    const pm = src.slice(pos).match(/^(\s*)(<p\b[^>]*>)([\s\S]*?)<\/p>/i);
    if (!pm) continue;
    const cm = pm[3].match(FIGCAP_CAPTION_RE);
    if (!cm) continue;
    const isFigWord = /^(图|Figure)$/i.test(cm[1]);
    if (isImage !== isFigWord) continue; // 题注词与对象类型不对应
    const n = isFigWord ? ++figNo : ++tabNo;
    // 冒号风格跟语言走：中文词全角「：」，西文词半角「: 」
    const isCjkWord = /^(图|表)$/.test(cm[1]);
    const prefix = isCjkWord ? `${cm[1]} ${n}：` : `${cm[1]} ${n}: `;
    out += pm[1] + pm[2] + prefix + cm[6].replace(/^\s+/, '') + '</p>';
    pos += pm[0].length;
  }
  out += src.slice(pos);
  return { text: out, figures: figNo, tables: tabNo, count: figNo + tabNo };
}

module.exports = {
  rewriteImageSizeHtml,
  addLineNumbersToCodeBlocks,
  lineNumbersAlignCss,
  numberFigureCaptions,
};
