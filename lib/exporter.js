/**
 * 核心导出器 —— 基于 crossnote（Markdown Preview Enhanced 引擎）
 *
 * 同时面向两种调用方式：
 *  1. CLI:  bin/mpe-export.js
 *  2. 库:   const { exportMarkdown } = require('mpe-export');
 *
 * 特点：
 *  - 完全无头：不需要打开 VS Code 预览
 *  - 非交互式：不弹窗、不提问，适合 agent/LLM 调用
 *  - 参数三层控制：CLI/调用参数 > 文件 front-matter > .crossnote/ 目录配置
 *  - 不修改源文件：CLI 注入的 pdf/html 参数通过同目录临时副本实现
 */

const { Notebook } = require('crossnote');
const fs = require('fs');
const os = require('os');
const path = require('path');
const url = require('url');
const YAML = require('yaml');
const { buildFooterAssets, buildFooterFontCss } = require('./footer');
const { normalizeMarkdown, KIND_NAMES } = require('./normalize');

/** 预设目录（build-claude-preset.js 生成的提炼 CSS 等静态资源） */
const PRESET_DIR = path.join(__dirname, 'presets');

/** 上次使用的预设持久化位置（用户目录，与 npm 包目录隔离） */
const STATE_FILE = path.join(os.homedir(), '.mpe-export', 'state.json');

/** 读取上次成功导出使用的预设名（无记录返回 null） */
function getLastPreset() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')).lastPreset || null;
  } catch {
    return null;
  }
}

/** 记录本次成功导出使用的预设名（供 --preset last 沿用） */
function saveLastPreset(name) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      JSON.stringify({ lastPreset: name, at: new Date().toISOString() }, null, 2),
      'utf8',
    );
  } catch {
    /* 状态写不入不影响导出 */
  }
}

/** Windows 常见浏览器路径探测（含 Edge 兜底） */
function detectChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return '';
}

/**
 * 内置排版预设（Presets）
 *
 * phycat —— 源自用户项目 scan-pdf-to-print-html 技能（my-skills/custom/scan-pdf-to-print-html）
 * 的 A4 讲义/试题排版规格：
 *   - A4 页面，内边距上14mm/下15mm/左右13mm（技能 .sheet padding）
 *   - 正文 12px / 行高 1.56；标题分级 24/22/18/15/13px（技能 builder CSS）
 *   - 页脚 9px 页码（技能 .sheet-footer 规格）
 *   - KaTeX 数学渲染（技能硬性契约）
 *   - 例题 blockquote 样式；图片按原图尺寸显示（仅防超宽溢出）
 *   - 标题分页：读取源文件 front-matter 的 pagination-level（h1|h2|h3），
 *     通过 CSS break-before: page 近似实现（技能 postprocess 的 JS 分页的轻量版）
 */
const PRESETS = {
  phycat: {
    description: '讲义/试题 A4 排版（源自 scan-pdf-to-print-html 技能）',
    usage: 'mpe-export 讲义.md --format pdf --preset phycat',
    pagination: true, // 读取 front-matter pagination-level 做标题分页
    config: {
      mathRenderingOption: 'KaTeX',
      includeInHeader: `<style>
.markdown-preview, .crossnote { font-size: 12px; line-height: 1.56; color: #1a1a1a; }
.markdown-preview h1 { font-size: 24px; line-height: 1.15; }
.markdown-preview h2 { font-size: 22px; }
.markdown-preview h3 { font-size: 18px; }
.markdown-preview h4 { font-size: 15px; }
.markdown-preview h5 { font-size: 13px; }
.markdown-preview p { margin: 0.5em 0; }
/* 原生 Chrome PDF 不经过 sheet 分页器。正文段落或显示公式落在页尾时，
   不允许留下上页残片、下页续行；整块放不下就从下一页开始。 */
@media print {
  .markdown-preview > p,
  .markdown-preview > .katex-display,
  .crossnote > p,
  .crossnote > .katex-display {
    break-inside: avoid;
    page-break-inside: avoid;
  }
}
.markdown-preview blockquote {
  border-left: 3px solid #c0392b; background: #fdf6f0;
  padding: 2.4mm 2.6mm; margin: 0.6em 0; border-radius: 2px;
}
/* 图片按原图尺寸显示（1 图像素 = 1 CSS px），不做宽度缩放；
   max-width:100% 仅防超宽图溢出页体被裁 */
.markdown-preview img { max-width: 100%; height: auto; }
.markdown-preview table { font-size: 11.4px; }
</style>`,
    },
    pdf: {
      format: 'A4',
      margin: { top: '14mm', bottom: '15mm', left: '13mm', right: '13mm' },
      displayHeaderFooter: true,
      headerTemplate:
        '<div style="font-size:9px;width:100%;text-align:right;color:#999;padding:0 13mm;"></div>',
      // {{docTitle}} 占位符 → 导出时替换为 front-matter title / 首个标题 / 文件名
      footerTemplate:
        '<div style="font-size:9px;width:100%;display:flex;justify-content:space-between;padding:0 13mm;color:#888;"><span>{{docTitle}}</span><span>第 <span class="pageNumber"></span> 页 / 共 <span class="totalPages"></span> 页</span></div>',
    },
  },
  /**
   * claude / claude-dark —— 提炼自 Typora claude-theme v19.7 的文档内容样式
   * （cssFile 由 tools/build-claude-preset.js 从 claude.css / claude-dark.css 生成）：
   *   - Anthropic Serif/Sans/Mono 西文字体 base64 内联，CJK 走系统回退
   *   - previewTheme 置 none.css，避免引擎默认主题干扰
   *   - PDF 仅给 A4 + 页边距，页眉页脚留 Chrome 默认（无）
   */
  claude: {
    description: 'Claude 主题风格（亮色，源自 Typora claude-theme v19.7）',
    usage: 'mpe-export 笔记.md --format both --preset claude',
    cssFile: path.join(PRESET_DIR, 'claude.css'),
    config: { previewTheme: 'none.css' },
    // CJK 字体：导出时按文档实际字符子集化 + base64 内联（见 buildInlineFontCss），
    // 未安装这些字体的机器上打开产物也能正确显示
    inlineFonts: [
      { family: 'Noto Serif SC', file: 'NotoSerifSC-VariableFont_wght.ttf', weight: '200 900' },
      { family: 'Noto Sans SC', file: 'NotoSansSC-VariableFont_wght.ttf', weight: '100 900' },
      { family: 'Source Han Sans SC', file: 'SourceHanSansSC-Regular.otf', weight: '400' },
      { family: 'Source Han Sans SC', file: 'SourceHanSansSC-Bold.otf', weight: '700' },
    ],
    pdf: {
      format: 'A4',
      margin: { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: false, // 屏蔽 Chrome 默认页眉页脚（file:// 路径）
    },
  },
  'claude-dark': {
    description: 'Claude 主题风格（暗色，源自 Typora claude-theme v19.7）',
    usage: 'mpe-export 笔记.md --format html --preset claude-dark',
    cssFile: path.join(PRESET_DIR, 'claude-dark.css'),
    // 暗色页面配亮色 prism 主题会出现白底代码块，默认换 monokai；
    // mermaid 默认主题线条/箭头是深灰色，暗色背景上不可见，换 dark 主题
    config: {
      previewTheme: 'none.css',
      codeBlockTheme: 'monokai.css',
      mermaidTheme: 'dark',
    },
    inlineFonts: [
      { family: 'Noto Serif SC', file: 'NotoSerifSC-VariableFont_wght.ttf', weight: '200 900' },
      { family: 'Noto Sans SC', file: 'NotoSansSC-VariableFont_wght.ttf', weight: '100 900' },
      { family: 'Source Han Sans SC', file: 'SourceHanSansSC-Regular.otf', weight: '400' },
      { family: 'Source Han Sans SC', file: 'SourceHanSansSC-Bold.otf', weight: '700' },
    ],
    pdf: {
      format: 'A4',
      margin: { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: false,
    },
  },
  /**
   * onepage / onepage-dark —— 提炼自 Obsidian 主题 OnePage v1.0.5
   * （ivaneye/OnePage，基于 Cupertino 深度定制，MIT License）。
   * cssFile 由 tools/build-onepage-preset.js 从主题 theme.css 的
   * body.theme-light（暖白纸张）/ body.theme-dark（暖棕·冷锚）配色块蒸馏生成：
   *   - 亮色暖白纸张底 / 暗色暖棕·冷锚底，深青（亮）/冷青绿（暗）强调色
   *   - 标题彩色排版（--typo-h1..h6 分层配色）、加粗橙/斜体绿
   *   - 行内代码圆角药丸、代码块圆角边框 + JetBrains Mono 连字 + 主题代码配色
   *   - 细下划线链接、精致引用块、强调色表头表格、macOS 胶囊 callout
   *   - 正文 16px / 行高 1.7 / 阅读宽居中；正文 CJK 走 Noto Sans SC 子集化内联
   */
  onepage: {
    description: 'OnePage 主题 · 暖白纸张（亮色，源自 Obsidian 主题 OnePage v1.0.5）',
    usage: 'mpe-export 笔记.md --format both --preset onepage',
    cssFile: path.join(PRESET_DIR, 'onepage.css'),
    config: { previewTheme: 'none.css' },
    inlineFonts: [
      { family: 'Noto Sans SC', file: 'NotoSansSC-VariableFont_wght.ttf', weight: '100 900' },
    ],
    pdf: {
      format: 'A4',
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: false, // 屏蔽 Chrome 默认页眉页脚（file:// 路径）
    },
  },
  'onepage-dark': {
    description: 'OnePage 主题 · 暖棕·冷锚（暗色，源自 Obsidian 主题 OnePage v1.0.5）',
    usage: 'mpe-export 笔记.md --format html --preset onepage-dark',
    cssFile: path.join(PRESET_DIR, 'onepage-dark.css'),
    // 暗色页面配亮色 prism 主题会出现白底代码块，默认换 monokai；
    // mermaid 默认主题线条/箭头是深灰色，暗色背景上不可见，换 dark 主题
    config: {
      previewTheme: 'none.css',
      codeBlockTheme: 'monokai.css',
      mermaidTheme: 'dark',
    },
    inlineFonts: [
      { family: 'Noto Sans SC', file: 'NotoSansSC-VariableFont_wght.ttf', weight: '100 900' },
    ],
    pdf: {
      format: 'A4',
      margin: { top: '18mm', bottom: '18mm', left: '14mm', right: '14mm' },
      displayHeaderFooter: false,
    },
  },
};

/**
 * phycat-* —— 提炼自 Typora 主题 typora-theme-phycat 的 11 个配色变体
 * （cssFile 由 tools/build-phycat-preset.js 从 phycat.light.css / phycat.dark.css
 * 基底 + 各变体 :root 覆盖蒸馏生成）：
 *   - 正文 LXGW WenKai（霞鹜文楷，25MB）走 inlineFonts 按文档字符子集化内联；
 *     等宽 Cascadia Code 已 base64 内联在预设 CSS 里
 *   - 正文 14px，标题阶梯 px 固定 24/21/18/16/15/14
 *   - PDF 经 @page background 满版铺背景（含页边距），亮变体白底/图案平铺、
 *     暗变体铺 --bg-color + 圆点纹理
 *   - 暗色变体默认 monokai 代码高亮 + mermaid dark 主题
 */
const PHYCAT_VARIANTS = [
  { name: 'phycat-cherry', zh: '樱桃红', dark: false },
  { name: 'phycat-caramel', zh: '焦糖橙', dark: false },
  { name: 'phycat-forest', zh: '森绿', dark: false },
  { name: 'phycat-mint', zh: '薄荷青', dark: false },
  { name: 'phycat-sky', zh: '天蓝', dark: false },
  { name: 'phycat-prussian', zh: '普鲁士蓝', dark: false },
  { name: 'phycat-sakura', zh: '樱花粉', dark: false },
  { name: 'phycat-mauve', zh: '淡紫', dark: false },
  { name: 'phycat-vampire', zh: '吸血鬼', dark: true },
  { name: 'phycat-radiation', zh: '辐射', dark: true },
  { name: 'phycat-abyss', zh: '深渊', dark: true },
];
for (const v of PHYCAT_VARIANTS) {
  PRESETS[v.name] = {
    description: `Phycat 主题 · ${v.zh}（${v.dark ? '暗' : '亮'}）`,
    usage: `mpe-export 笔记.md --format both --preset ${v.name}`,
    cssFile: path.join(PRESET_DIR, `${v.name}.css`),
    config: v.dark
      ? { previewTheme: 'none.css', codeBlockTheme: 'monokai.css', mermaidTheme: 'dark' }
      : { previewTheme: 'none.css' },
    inlineFonts: [
      { family: 'LXGW WenKai', file: 'LXGWWenKai-Regular.ttf', weight: '400' },
    ],
    pdf: {
      format: 'A4',
      margin: { top: '18mm', bottom: '18mm', left: '12mm', right: '12mm' },
      displayHeaderFooter: false,
    },
  };
}

/** 封面 HTML 原样拷到临时目录，并补齐 vendor/katex（源目录常缺） */
function materializeCoverHtml(coverPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-cover-'));
  const html = fs.readFileSync(coverPath, 'utf8');
  const dest = path.join(dir, path.basename(coverPath));
  fs.writeFileSync(dest, html, 'utf8');
  const localKatex = path.join(path.dirname(coverPath), 'vendor', 'katex', 'dist');
  const bundled = path.join(__dirname, '..', 'node_modules', 'katex', 'dist');
  const katexDist = fs.existsSync(path.join(localKatex, 'katex.min.js')) ? localKatex : bundled;
  if (fs.existsSync(path.join(katexDist, 'katex.min.js'))) {
    fs.mkdirSync(path.join(dir, 'vendor', 'katex'), { recursive: true });
    fs.cpSync(katexDist, path.join(dir, 'vendor', 'katex', 'dist'), { recursive: true });
  } else {
    process.stderr.write('[mpe-export] 封面 KaTeX 未找到，公式可能显示为源码\n');
  }
  return {
    path: dest,
    dir,
    htmlB64: Buffer.from(html, 'utf8').toString('base64'),
    baseHref: url.pathToFileURL(dir).href.replace(/\/?$/, '/'),
  };
}

/** HTML 转义（面包屑文本注入 footerTemplate 用） */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Chromium 打印 PDF 时 text-decoration: underline wavy / CSS background 平铺会糊。
 * 使用固定周期的长 SVG path，按高度等比缩放并由文字宽度裁切，保持矢量清晰度。
 */
function wavyStrokeColor(color) {
  const c = String(color || 'currentColor').trim().replace(/["<>]/g, '');
  return c || 'currentColor';
}

const WAVY_VIEWBOX_WIDTH = 2400;
const WAVY_HALF_PERIOD = 6;
const WAVY_PATH_D =
  'M0 6.5 Q3 1 6 6.5' +
  Array.from(
    { length: WAVY_VIEWBOX_WIDTH / WAVY_HALF_PERIOD - 1 },
    (_, i) => ` T${(i + 2) * WAVY_HALF_PERIOD} 6.5`,
  ).join('');

/** 行内 SVG：一个完整周期 12 单位，约为正文汉字宽度的一半。 */
function wavySvgMarkup(color) {
  const stroke = wavyStrokeColor(color);
  return (
    `<svg class="mpe-wavy-line" xmlns="http://www.w3.org/2000/svg" ` +
    `width="100%" height="8" viewBox="0 0 ${WAVY_VIEWBOX_WIDTH} 12" ` +
    `preserveAspectRatio="xMinYMid slice" aria-hidden="true">` +
    `<path fill="none" stroke="${stroke}" stroke-width="1.35" stroke-linecap="round" ` +
    `shape-rendering="geometricPrecision" d="${WAVY_PATH_D}"/></svg>`
  );
}

function extractWavyColor(style) {
  let color = null;
  const colorM = style.match(/text-decoration-color\s*:\s*([^;]+)/i);
  if (colorM) color = colorM[1].trim();
  const decoM = style.match(/text-decoration\s*:\s*([^;]+)/i);
  if (decoM && !color) {
    const skip = new Set([
      'underline', 'wavy', 'solid', 'double', 'dotted', 'dashed', 'none',
      'overline', 'line-through', 'blink', 'from-font', 'auto', 'inherit',
      'initial', 'unset',
    ]);
    for (const part of decoM[1].trim().split(/\s+/)) {
      if (!skip.has(part.toLowerCase()) && !/^\d/.test(part)) {
        color = part;
        break;
      }
    }
  }
  return color;
}

function stripWavyDecoration(style) {
  return style
    .replace(/text-decoration-style\s*:\s*wavy\s*;?/gi, '')
    .replace(/text-decoration-line\s*:\s*underline\s*;?/gi, '')
    .replace(/text-decoration-color\s*:\s*[^;]+;?/gi, '')
    .replace(/text-decoration\s*:\s*[^;]*;?/gi, '')
    .replace(/background-image\s*:\s*url\([^)]*\)\s*;?/gi, '')
    .replace(/background-repeat\s*:\s*[^;]+;?/gi, '')
    .replace(/background-position\s*:\s*[^;]+;?/gi, '')
    .replace(/background-size\s*:\s*[^;]+;?/gi, '')
    .replace(/padding-bottom\s*:\s*[^;]+;?/gi, '')
    .replace(/;\s*;+/g, ';')
    .replace(/^\s*;\s*|\s*;\s*$/g, '')
    .trim();
}

const WAVY_UNDERLINE_CSS = `
/* mpe-export: vector wavy underline via a fixed-period inline SVG path */
.wavy {
  text-decoration: none !important;
  background-image: none !important;
  display: inline-block;
  position: relative;
  vertical-align: baseline;
  line-height: inherit;
}
.wavy > .mpe-wavy-line {
  display: block;
  position: absolute;
  left: 0;
  top: 100%;
  width: 100%;
  height: 0.55em;
  margin-top: -0.30em;
  overflow: hidden;
  pointer-events: none;
}
`.trim();

const CALLOUT_TABLE_OVERRIDE_CSS = `
/* mpe-export: callout 里的选项表不使用数据表表头强调，th 与普通选项格同款。 */
.markdown-preview .callout table :is(th, td) {
  background-color: transparent;
  color: inherit;
  font-weight: inherit !important;
  white-space: normal;
}
.markdown-preview .callout table th {
  text-align: inherit;
}
.markdown-preview .callout table tbody tr:hover :is(th, td),
.markdown-preview .callout table tbody :is(th, td):hover {
  background-color: transparent;
  color: inherit;
  box-shadow: none;
}
`.trim();

/**
 * 把内联 style 的 underline wavy / class="wavy" 改成 .wavy + 行内 SVG（仅导出生效）。
 * @returns {{ text: string, changed: boolean, count: number }}
 */
function rewriteWavyUnderlines(text) {
  let count = 0;
  const out = String(text).replace(
    /<(span|em|strong|a|mark|u|i|b)(\s[^>]*?)>([\s\S]*?)<\/\1>/gi,
    (full, name, attrs, inner) => {
      if (/class\s*=\s*["'][^"']*\bmpe-wavy-line\b/i.test(full)) return full;
      if (/<svg\b[^>]*\bmpe-wavy-line\b/i.test(inner)) return full;

      const styleM = attrs.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
      const classM = attrs.match(/\sclass\s*=\s*(["'])([\s\S]*?)\1/i);
      const style = styleM ? styleM[2] : '';
      const hasNativeWavy =
        style &&
        /wavy/i.test(style) &&
        /underline/i.test(style) &&
        /(?:text-decoration(?:-line|-style)?\s*:|underline\s+wavy|wavy\s+underline)/i.test(style);
      const hasWavyClass = !!(classM && /\bwavy\b/.test(classM[2]));
      if (!hasNativeWavy && !hasWavyClass) return full;

      const color = hasNativeWavy ? extractWavyColor(style) : null;
      let newAttrs = attrs;

      if (styleM) {
        let newStyle = stripWavyDecoration(style);
        if (hasNativeWavy) {
          newStyle = newStyle
            ? `${newStyle}; text-decoration: none`
            : 'text-decoration: none';
        }
        if (newStyle) {
          newAttrs = newAttrs.replace(
            /\sstyle\s*=\s*(["'])[\s\S]*?\1/i,
            ` style=${styleM[1]}${newStyle}${styleM[1]}`,
          );
        } else {
          newAttrs = newAttrs.replace(/\sstyle\s*=\s*(["'])[\s\S]*?\1/i, '');
        }
      }

      if (classM) {
        if (!/\bwavy\b/.test(classM[2])) {
          newAttrs = newAttrs.replace(
            /\sclass\s*=\s*(["'])([\s\S]*?)\1/i,
            (m, q, cls) => ` class=${q}${cls} wavy${q}`,
          );
        }
      } else {
        newAttrs += ' class="wavy"';
      }

      count++;
      return `<${name}${newAttrs}>${inner}${wavySvgMarkup(color || 'currentColor')}</${name}>`;
    },
  );
  return { text: out, changed: count > 0, count };
}

/**
 * 提取文档标题作为页脚面包屑：
 * 优先级: front-matter title > 第一个 # 标题（任意级） > 文件名
 */
function extractDocTitle(file) {
  const fm = parseFrontMatter(file);
  if (fm.title) return String(fm.title).trim();
  const raw = fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  const m = raw.match(/^#{1,6}\s+(.+)$/m);
  if (m) return m[1].trim();
  return path.basename(file, path.extname(file));
}

/** 列出全部预设（含用法示例，供 agent 自主选择） */
function listPresets() {
  return Object.entries(PRESETS).map(([name, p]) => ({
    name,
    description: p.description,
    usage: p.usage || null,
  }));
}

/**
 * 子集化注入的基础字符集：ASCII 可打印字符 + 常用 CJK 标点/符号
 * （文档正文未覆盖但这些位置可能出现的字符）
 */
const INLINE_FONT_BASE_CHARS =
  ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~' +
  '、。，；：？！（）《》〈〉【】「」『』—…·～％℃°×÷±≈≠≤≥→←↑↓★☆●○■□▲△※§￥' +
  '“”‘’'; // 全角引号用独立拼接，避免与字符串定界符混淆

/**
 * 预设内联字体子集化（CJK 字体用）：
 * 按"文档实际字符 + 基础字符集"对 lib/presets/fonts/ 下的完整字体做子集化，
 * 转 woff2 后 base64 内联为 @font-face。未装字体的机器打开产物也能正确显示。
 * 失败（字体缺失/subset-font 不可用）时静默降级为系统字体回退。
 */
async function buildInlineFontCss(preset, docText) {
  if (!preset.inlineFonts || !preset.inlineFonts.length) return '';
  let subsetFont;
  try {
    subsetFont = require('subset-font');
  } catch {
    return '';
  }
  const charset = INLINE_FONT_BASE_CHARS + docText;
  const faces = [];
  for (const f of preset.inlineFonts) {
    try {
      const buf = fs.readFileSync(path.join(PRESET_DIR, 'fonts', f.file));
      const subset = await subsetFont(buf, charset, { targetFormat: 'woff2' });
      faces.push(
        `@font-face { font-family: "${f.family}"; ` +
          `src: url("data:font/woff2;base64,${Buffer.from(subset).toString('base64')}") format("woff2"); ` +
          `font-weight: ${f.weight || '400'}; font-style: normal; font-display: swap; }`,
      );
    } catch (e) {
      process.stderr.write(`[mpe-export] 字体子集化跳过（${f.family}）: ${e.message}\n`);
    }
  }
  return faces.length ? `<style>${faces.join('\n')}</style>` : '';
}

/** 解析源文件 front-matter（轻量版，供 pagination-level 使用） */
function parseFrontMatter(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return {};
    return YAML.parse(m[1]) || {};
  } catch {
    return {};
  }
}

/**
 * 读源目录 .crossnote/config.js 的配置对象（crossnote 的目录级配置，
 * Notebook.init 合并顺序: 引擎默认 < 目录配置 < 调用方 config）。
 * 文件格式为 JS 表达式 `({...})`，引擎自己也是 eval 加载；失败返回 {}。
 */
function readCrossnoteDirConfig(srcDir) {
  try {
    const p = path.join(srcDir, '.crossnote', 'config.js');
    if (!fs.existsSync(p)) return {};
    const obj = eval(fs.readFileSync(p, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** 校验导出格式 */
function normalizeFormat(format) {
  const f = String(format || 'both').toLowerCase();
  if (['pdf', 'html', 'png', 'jpeg', 'both'].includes(f)) return f;
  throw new Error(`不支持的格式: ${format}（可选: pdf | html | png | jpeg | both）`);
}

/**
 * 将 CLI 参数注入 front-matter，写入同目录临时副本（不改源文件）。
 * 放在同目录是为了保证 markdown 中相对路径的图片/资源引用不失效。
 * srcText 不为 undefined 时以其替代磁盘上的源文件内容（规范化后的文本）。
 */
function injectFrontMatter(file, overrides, srcText) {
  const raw = srcText !== undefined ? srcText : fs.readFileSync(file, 'utf8');
  let fm = {};
  let body = raw;
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m) {
    try {
      fm = YAML.parse(m[1]) || {};
    } catch {
      fm = {};
    }
    body = raw.slice(m[0].length);
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const prev =
      fm[key] && typeof fm[key] === 'object' && !Array.isArray(fm[key])
        ? fm[key]
        : {};
    fm[key] = { ...prev, ...value }; // 合并：保留原有 key，新值覆盖冲突 key
  }
  const tmp = path.join(
    path.dirname(file),
    `.mpe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(file)}`,
  );
  fs.writeFileSync(tmp, `---\n${YAML.stringify(fm).trimEnd()}\n---\n\n${body}`, 'utf8');
  return tmp;
}

/** 写入同目录临时副本（规范化后的内容；同目录保证相对路径资源引用不失效） */
function writeTempPeer(file, content) {
  const tmp = path.join(
    path.dirname(file),
    `.mpe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(file)}`,
  );
  fs.writeFileSync(tmp, content, 'utf8');
  return tmp;
}

/** 把产物移动到目标位置（同盘 rename，跨盘 copy+unlink） */
function moveFile(src, destDir, destName) {
  const target = path.join(destDir, destName);
  fs.mkdirSync(destDir, { recursive: true });
  try {
    fs.renameSync(src, target);
  } catch {
    fs.copyFileSync(src, target);
    fs.unlinkSync(src);
  }
  return target;
}

/**
 * 导出单个 markdown 文件
 * @param {object} opts
 * @param {string} opts.file           源 markdown 文件路径（绝对或相对当前目录）
 * @param {string} [opts.format='both'] pdf | html | png | jpeg | both
 * @param {boolean} [opts.offline=false] HTML 离线单文件
 * @param {string}  [opts.outDir]       输出目录（默认源文件目录）
 * @param {string}  [opts.outName]      输出文件名（不含扩展名）
 * @param {object}  [opts.config]       NotebookConfig 覆盖（最高优先）
 * @param {object}  [opts.pdfJson]      透传 Chrome page.pdf() 的参数
 * @param {object}  [opts.htmlJson]     HTML 导出参数
 * @param {boolean} [opts.runCodeChunks=true] 是否执行代码块
 * @param {boolean} [opts.printBackground]    PDF 是否打印背景
 * @param {boolean} [opts.footer]        PDF 启用独立页脚（sheet 分页 + 章节面包屑，仅 PDF）
  * @param {string}  [opts.paginationLevel] 标题换页级别 h1|h2|h3（蕴含 sheet 分页）
  * @param {boolean} [opts.toc]           PDF/HTML 插入目录页（PDF 蕴含 sheet 分页）
  * @param {string}  [opts.tocLevel]      目录收录级别 h1|h2|h3（默认 h3）
  * @param {string}  [opts.tocTitle]      目录页标题（默认「目录」）
  * @param {string}  [opts.cover]        封面文件 html/png/jpg/svg（仅 PDF，蕴含分页）
 * @param {boolean} [opts.bgPattern]   保留预设背景图案层（默认剥离，打印更干净）
 * @param {boolean} [opts.mdNormalize=true] 导出前内存规范化块间空行（公式块/代码块/
 *                     引用块/HTML块/表格/分割线/标题/列表；不改源文件）
 * @param {boolean} [opts.fixMd]       规范化并写回源文件（留 .bak 备份）
 * @param {boolean} [opts.bookmarks=true] PDF 按 h1-h6 生成书签大纲（仅 PDF）
 * @param {boolean} [opts.mergeCells=true] 表格单元格合并语法（单元格只含 ^ 向上
 *                     合并 rowspan、只含 > 向右合并 colspan、空单元格向左合并；
 *                     false 关闭，等价 CLI --no-merge-cells / front-matter
 *                     merge-cells: false）
 * @param {string}  [opts.chromePath]   Chrome 可执行文件路径
 * @returns {Promise<{input: string, outputs: object, normalized: number, sourceFixed: boolean}>}
 */
async function exportMarkdown(opts) {
  const format = normalizeFormat(opts.format);
  const file = path.resolve(opts.file);
  if (!fs.existsSync(file)) {
    throw new Error(
      `文件不存在: ${file}（路径按调用时的工作目录解析；建议传绝对路径，或用 ls 确认文件位置）`,
    );
  }

  // ---------- 预设展开（preset < CLI 显式参数） ----------
  // 'last' 为伪预设：沿用上次 CLI 成功导出时使用的预设
  let presetName = opts.preset || null;
  if (presetName === 'last') {
    presetName = getLastPreset();
    if (!presetName) {
      throw new Error('没有历史预设记录：--preset last 需要先成功用过一次 --preset <name>');
    }
  }
  const preset = presetName ? PRESETS[presetName] : null;
  if (presetName && !preset) {
    throw new Error(
      `未知预设: ${presetName}。可用: ${Object.keys(PRESETS).join(', ')}, last（沿用上次）（--preset list 查看详情）`,
    );
  }

  // ---------- sheet 分页 / 独立页脚开关 ----------
  // --pagination / front-matter pagination: true：只分页（代码块/图片/引用块
  // 等整块不断页）；--footer / front-matter footer: true：分页 + scan 风格页脚。
  // --pagination-level / front-matter pagination-level: h1|h2|h3：标题换页
  // （父章节内第一个该级标题不换页，其余起新页），蕴含分页。
  // --toc / --toc-level / front-matter toc: true：正文前插入目录页，蕴含分页。
  // --cover / front-matter cover: <path>：首页封面（封面→目录→正文），蕴含分页。
  // 与样式预设正交；页脚/目录/封面均蕴含分页（lib/footer.js）
  const fm = parseFrontMatter(file);
  const footerOn =
    !!opts.footer || fm.footer === true || String(fm.footer).toLowerCase() === 'true';
  let paginationLevel = String(
    opts.paginationLevel || fm['pagination-level'] || '',
  ).toLowerCase();
  if (paginationLevel && !['h1', 'h2', 'h3'].includes(paginationLevel)) {
    process.stderr.write(
      `[mpe-export] 忽略非法 pagination-level: ${paginationLevel}（可选 h1|h2|h3，详见 mpe-export --help pagination）\n`,
    );
    paginationLevel = '';
  }
  let tocLevel = String(opts.tocLevel || fm['toc-level'] || '').toLowerCase();
  if (tocLevel && !['h1', 'h2', 'h3'].includes(tocLevel)) {
    process.stderr.write(
      `[mpe-export] 忽略非法 toc-level: ${tocLevel}（可选 h1|h2|h3，默认 h3）\n`,
    );
    tocLevel = '';
  }
  const tocOn =
    !!opts.toc ||
    fm.toc === true ||
    String(fm.toc).toLowerCase() === 'true' ||
    !!tocLevel;
  if (tocOn && !tocLevel) tocLevel = 'h3';
  const tocTitle = opts.tocTitle || fm['toc-title'] || '';
  if (tocOn && format !== 'pdf' && format !== 'both') {
    process.stderr.write(`[mpe-export] --toc 仅 PDF 生效（当前 format=${format}）\n`);
  }
  const coverRaw = opts.cover || fm.cover || '';
  let coverPath = '';
  let coverKind = '';
  if (coverRaw && String(coverRaw).toLowerCase() !== 'false' && String(coverRaw) !== 'true') {
    coverPath = path.resolve(path.dirname(file), String(coverRaw));
    if (!fs.existsSync(coverPath)) {
      throw new Error(`封面文件不存在: ${coverPath}（--cover / front-matter cover）`);
    }
    const ext = path.extname(coverPath).toLowerCase();
    if (ext === '.html' || ext === '.htm') coverKind = 'html';
    else if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].includes(ext)) coverKind = 'image';
    else {
      throw new Error(`不支持的封面格式: ${ext}（可选 html / png / jpg / svg）`);
    }
    if (format !== 'pdf' && format !== 'both') {
      process.stderr.write(`[mpe-export] --cover 仅 PDF 生效（当前 format=${format}）\n`);
    }
  }
  const paginationOn =
    footerOn ||
    tocOn ||
    !!coverPath ||
    !!opts.pagination ||
    fm.pagination === true ||
    String(fm.pagination).toLowerCase() === 'true' ||
    !!paginationLevel;

  // ---------- PDF 书签大纲（默认开：按 h1-h6 层级生成，Chrome outline） ----------
  // --no-bookmarks / front-matter bookmarks: false 关闭。
  // 实现：puppeteer page.pdf({ outline: true }) → CDP generateDocumentOutline，
  // 分页/非分页两条 PDF 路径都走 page.pdf，一处参数两处生效
  const bookmarksOn =
    opts.bookmarks !== false &&
    fm.bookmarks !== false &&
    String(fm.bookmarks).toLowerCase() !== 'false';

  let presetPdf = null;
  let presetConfig = null;
  if (preset) {
    // 页脚面包屑：CLI --footer-label > front-matter title > 首个标题 > 文件名
    const docTitle = opts.footerLabel || extractDocTitle(file);
    presetPdf = {
      ...(preset.pdf || {}),
      footerTemplate: ((preset.pdf && preset.pdf.footerTemplate) || '').replace(
        '{{docTitle}}',
        escapeHtml(docTitle),
      ),
    };
    // 头部注入：内联字体子集 > cssFile 提炼样式 > 预设内联 includeInHeader
    let header = (preset.config && preset.config.includeInHeader) || '';
    if (preset.cssFile) {
      let presetCss = fs.readFileSync(preset.cssFile, 'utf8');
      // 背景图案层（网格/圆点）默认剥离：打印不友好。--bg-pattern /
      // front-matter bg-pattern: true 保留；底色层始终保留（暗变体靠它铺底）
      const bgPattern =
        !!opts.bgPattern ||
        fm['bg-pattern'] === true ||
        String(fm['bg-pattern']).toLowerCase() === 'true';
      if (!bgPattern) {
        presetCss = presetCss.replace(
          /\/\* MPE-BG-PATTERN-BEGIN \*\/[\s\S]*?\/\* MPE-BG-PATTERN-END \*\//g,
          '',
        );
      }
      header = `<style>${presetCss}</style>` + header;
    }
    // 字符集需覆盖目录页标题（默认「目录」），否则标题字符不在子集内会回退系统字体
    header = (await buildInlineFontCss(preset, fs.readFileSync(file, 'utf8') + (tocTitle || '目录'))) + header;
    presetConfig = { ...(preset.config || {}), includeInHeader: header };
  }

  const srcDir = path.dirname(file);
  const srcBase = path.basename(file, path.extname(file));

  // ---------- 组装 NotebookConfig ----------
  // 表格单元格合并（MPE 扩展表格语法）默认开启：只含 ^ 的单元格向上合并
  // （rowspan）、只含 > 的向右合并（colspan）、空单元格向左合并。crossnote
  // 引擎默认关闭，这里改为默认开。优先级与全局约定一致：--config（最高，
  // Object.assign 在后覆盖）> --no-merge-cells / front-matter merge-cells:
  // false（显式传 false 压过目录配置）> .crossnote/config.js 显式设置
  // （此时本键不传，交给引擎合并目录配置）> 脚本默认 true。
  const mergeCellsOff =
    opts.mergeCells === false ||
    fm['merge-cells'] === false ||
    String(fm['merge-cells']).toLowerCase() === 'false';
  const dirConfig = readCrossnoteDirConfig(srcDir);
  const dirHasMergeKey = Object.prototype.hasOwnProperty.call(
    dirConfig,
    'enableExtendedTableSyntax',
  );
  const mergeCellsEntry = mergeCellsOff
    ? { enableExtendedTableSyntax: false }
    : dirHasMergeKey
      ? {}
      : { enableExtendedTableSyntax: true };
  const wavyHeader = `<style>${WAVY_UNDERLINE_CSS}</style>`;
  const notebookConfig = {
    previewTheme: opts.theme || 'github-light.css',
    codeBlockTheme: opts.codeTheme || 'github.css',
    mathRenderingOption: (opts.math || 'KaTeX')
      .toLowerCase()
      .replace(/^katex$/, 'KaTeX')
      .replace(/^mathjax$/, 'MathJax')
      .replace(/^none$/, 'None'),
    printBackground: opts.printBackground ?? true,
    enableScriptExecution: true,
    ...mergeCellsEntry,
    chromePath: opts.chromePath || detectChrome(),
    puppeteerArgs: [],
  };
  if (opts.config && typeof opts.config === 'object') {
    Object.assign(notebookConfig, opts.config); // agent 传入的 config 覆盖一切
  } else if (presetConfig) {
    Object.assign(notebookConfig, presetConfig); // 预设提供默认（CLI 显式 config 优先）
  }
  // 清晰波浪线始终注入。callout 表格兼容层放在所有主题/自定义 header
  // 之后，以一处公共覆盖统一所有预设，不修改各主题生成文件。
  const commonOverrideHeader =
    `<style data-mpe-export-overrides>${CALLOUT_TABLE_OVERRIDE_CSS}</style>`;
  notebookConfig.includeInHeader =
    wavyHeader + (notebookConfig.includeInHeader || '') + commonOverrideHeader;

  // ---------- 注入 front-matter 参数（如需） ----------
  // sheet 分页模式下 PDF 走自有 Chrome 流程（exportPdfWithFooter），
  // pdf 参数由它直接消费，不再注入 front-matter chrome 节
  const overrides = {};
  if (opts.offline) overrides.html = { ...(opts.htmlJson || {}), offline: true };
  else if (opts.htmlJson) overrides.html = opts.htmlJson;
  if (!paginationOn) {
    // outline 默认开（书签大纲）；preset < CLI 显式参数可覆盖
    overrides.chrome = { outline: bookmarksOn, ...(presetPdf || {}), ...(opts.pdfJson || {}) };
  }

  // ---------- 源文档块间空行规范化（默认开，仅内存，不动源文件） ----------
  // $$ 公式块 / 围栏代码块 / 引用块·callout / HTML 块 / 表格 / 分割线 /
  // ATX 标题 / 列表紧贴正文时，markdown 会把它们并进段落（公式里的 = 行
  // 触发 setext 标题、^ 被上标扩展吃掉，整块变裸露 LaTeX 文本），Typora
  // 也无法渲染。导出前在内存中补齐块间空行（规则见 lib/normalize.js）；
  // --fix-md / front-matter fix-md: true 时把规范化结果写回源文件（留 .bak）
  const mdNormalizeOn =
    opts.mdNormalize !== false &&
    fm['md-normalize'] !== false &&
    String(fm['md-normalize']).toLowerCase() !== 'false';
  const fixMdOn =
    !!opts.fixMd || fm['fix-md'] === true || String(fm['fix-md']).toLowerCase() === 'true';
  let normalizedSrc = null;
  let normalizedAdded = 0;
  let sourceFixed = false;
  let workingText = fs.readFileSync(file, 'utf8');
  if (mdNormalizeOn) {
    const r = normalizeMarkdown(workingText);
    if (r.added > 0) {
      workingText = r.text;
      normalizedSrc = r.text;
      normalizedAdded = r.added;
      const kinds = Object.entries(r.byKind)
        .map(([k, n]) => `${KIND_NAMES[k] || k}×${n}`)
        .join(' ');
      if (fixMdOn) {
        try {
          fs.writeFileSync(file + '.bak', fs.readFileSync(file, 'utf8'));
          fs.writeFileSync(file, normalizedSrc);
          sourceFixed = true;
        } catch (e) {
          process.stderr.write(`[mpe-export] --fix-md 写回源文件失败: ${e.message}\n`);
        }
      }
      process.stderr.write(
        `[mpe-export] 源文档缺块间空行，已规范化 ${r.added} 处（${kinds}）` +
          (sourceFixed
            ? '，已写回源文件（留 .bak 备份）\n'
            : '（仅本次导出生效，源文件未改动；--fix-md 可写回）\n'),
      );
    }
  }

  // 原生 underline wavy → SVG 底纹（仅本次导出；不写回源文件）
  const wavyRewrite = rewriteWavyUnderlines(workingText);
  let exportText = workingText;
  if (wavyRewrite.changed) {
    exportText = wavyRewrite.text;
    process.stderr.write(
      `[mpe-export] 已将 ${wavyRewrite.count} 处原生波浪下划线改为清晰 SVG（仅本次导出）\n`,
    );
  }

  let targetFile = file;
  let cleanup = null;
  // 规范化写回源文件后，波浪改写仍只走临时副本
  const needTemp =
    exportText !== fs.readFileSync(file, 'utf8') ||
    (normalizedSrc !== null && !sourceFixed);
  if (Object.keys(overrides).length) {
    targetFile = injectFrontMatter(
      file,
      overrides,
      needTemp || wavyRewrite.changed ? exportText : undefined,
    );
    cleanup = () => {
      try {
        fs.unlinkSync(targetFile);
      } catch {
        /* ignore */
      }
    };
  } else if (needTemp) {
    targetFile = writeTempPeer(file, exportText);
    cleanup = () => {
      try {
        fs.unlinkSync(targetFile);
      } catch {
        /* ignore */
      }
    };
  }

  try {
    // notebookPath 用源文件目录，引擎用相对文件名
    const notebook = await Notebook.init({
      notebookPath: srcDir,
      config: notebookConfig,
    });
    const engine = notebook.getNoteMarkdownEngine(path.basename(targetFile));

    const outputs = {};

    // ---------- HTML ----------
    if (format === 'html' || format === 'both') {
      const dest = await engine.htmlExport({
        offline: !!opts.offline,
        runAllCodeChunks: opts.runCodeChunks !== false,
      });
      outputs.html = moveFile(
        dest,
        path.resolve(opts.outDir || srcDir),
        (opts.outName || srcBase) + '.html',
      );
    }

    // ---------- PDF / PNG / JPEG (Chrome) ----------
    if (format === 'pdf' || format === 'png' || format === 'jpeg' || format === 'both') {
      const fileType = format === 'both' ? 'pdf' : format;
      let dest;
      if (paginationOn && fileType === 'pdf') {
        // sheet 分页模式：自有 Chrome 流程（分页器 + 可选页脚），
        // 等分页就绪标志后再打印；png/jpeg 不支持，走引擎默认
        const effectivePdf = { ...(presetPdf || {}), ...(opts.pdfJson || {}) }; // preset < CLI
        dest = await exportPdfWithFooter(engine, targetFile, {
          format: effectivePdf.format || 'A4',
          landscape: !!effectivePdf.landscape,
          margin: effectivePdf.margin ||
            (preset && preset.pdf && preset.pdf.margin) || {
              top: '1cm',
              bottom: '1cm',
              left: '1cm',
              right: '1cm',
            },
          docTitle: opts.footerLabel || extractDocTitle(file),
          footer: footerOn,
          paginationLevel: paginationLevel || null,
          toc: tocOn,
          tocLevel: tocLevel || null,
          tocTitle: tocTitle || null,
          coverPath: coverPath || null,
          coverKind: coverKind || null,
          bookmarks: bookmarksOn,
          printBackground: notebookConfig.printBackground,
          chromePath: notebookConfig.chromePath,
          puppeteerArgs: notebookConfig.puppeteerArgs,
          runCodeChunks: opts.runCodeChunks !== false,
        });
      } else {
        dest = await engine.chromeExport({
          fileType,
          runAllCodeChunks: opts.runCodeChunks !== false,
          openFileAfterGeneration: !!opts.open,
        });
      }
      outputs[fileType === 'jpeg' ? 'jpeg' : fileType] = moveFile(
        dest,
        path.resolve(opts.outDir || srcDir),
        (opts.outName || srcBase) + '.' + fileType,
      );
    }

    return {
      input: file,
      outputs,
      preset: preset ? presetName : null,
      // 块间空行规范化信息（0 = 源文档无需修复；详见 lib/normalize.js）
      normalized: normalizedAdded,
      sourceFixed,
    };
  } finally {
    if (cleanup) cleanup();
  }
}

/**
 * sheet 分页模式的 PDF 导出：自有 Chrome 流程（分页器 + 可选页脚）。
 * 复用引擎的 parseMD/generateHTMLTemplateForExport 生成打印 HTML，
 * 注入 sheet 分页脚本（lib/footer.js），等分页完成标志后再打印 —
 * 这是"自动分页后识别每页章节位置"的钩子，引擎 chromeExport 只有
 * 固定 timeout，无法等待分页结果。
 */
async function exportPdfWithFooter(engine, targetFile, o) {
  const raw = fs.readFileSync(targetFile, 'utf8');
  const parsed = await engine.parseMD(raw, {
    useRelativeFilePath: false,
    hideFrontMatter: true,
    isForPreview: false,
    runAllCodeChunks: o.runCodeChunks,
  });
  let full = await engine.generateHTMLTemplateForExport(parsed.html, parsed.yamlConfig, {
    isForPrint: true,
    isForPrince: false,
    embedLocalImages: false,
    offline: true,
  });
  // crossnote 偶发竞态：正文被包成 <html><head></head><body><div>…</div></body></html>
  // （jsdom 序列化整篇文档）。浏览器剥掉非法嵌套的 html/head/body 后留下裸 <div>，
  // 全部正文并成一个超高块，分页器整页裁切（图片全丢、只剩首屏文字）。剥壳恢复平级块流。
  full = full.replace(
    /<html><head><\/head><body><div>([\s\S]*?)<\/div><\/body><\/html>/g,
    '$1',
  );

  let coverHref = '';
  let coverTmpDir = '';
  let coverHtmlB64 = '';
  let coverBaseHref = '';
  if (o.coverPath) {
    if (o.coverKind === 'html') {
      const staged = materializeCoverHtml(o.coverPath);
      coverHref = url.pathToFileURL(staged.path).href;
      coverTmpDir = staged.dir;
      coverHtmlB64 = staged.htmlB64;
      coverBaseHref = staged.baseHref;
    } else {
      coverHref = url.pathToFileURL(o.coverPath).href;
    }
  }
  const assets = buildFooterAssets({
    format: o.format,
    landscape: o.landscape,
    margin: o.margin,
    docTitle: o.docTitle,
    footer: o.footer,
    paginationLevel: o.paginationLevel,
    toc: o.toc,
    tocLevel: o.tocLevel,
    tocTitle: o.tocTitle,
    coverHref,
    coverKind: o.coverKind || '',
    coverHtmlB64,
    coverBaseHref,
  });
  // 页脚美术字体（思源宋体）按文档字符子集化内联，中文与数字同体；仅页脚开启时需要
  const footerFontCss =
    o.footer === false && !o.toc
      ? ''
      : await buildFooterFontCss(raw + (o.tocTitle || '目录'));
  full = full
    .replace('</head>', `<style>${assets.css}</style>${footerFontCss}</head>`)
    .replace('</body>', `<script>${assets.js}</script></body>`);

  const tmpHtml = path.join(
    os.tmpdir(),
    `mpe-footer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`,
  );
  fs.writeFileSync(tmpHtml, full, 'utf8');
  const out = targetFile.replace(new RegExp(path.extname(targetFile) + '$'), '.pdf');

  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: o.chromePath,
    headless: true,
    args: [
      ...(o.puppeteerArgs || []),
      ...(o.coverPath ? ['--allow-file-access-from-files'] : []),
    ],
  });
  try {
    const page = await browser.newPage();
    // 分页测量必须与最终打印同一媒体环境：预设的 @media print 规则
    // （字号/间距等）会改变块高度，screen 下量出的分页点在 print 下会留白
    await page.emulateMediaType('print');
    await page.goto(url.pathToFileURL(tmpHtml).href);
    try {
      await page.waitForFunction(
        "document.documentElement.getAttribute('data-mpe-footer') === 'true'",
        { timeout: o.coverPath ? 120000 : 60000 },
      );
    } catch {
      throw new Error('页脚分页超时（60s）：文档渲染未完成（可能是图片/公式未加载）');
    }
    await page.pdf({
      path: out,
      format: o.format,
      landscape: o.landscape,
      margin: { top: 0, bottom: 0, left: 0, right: 0 }, // 边距由 sheet padding 承担
      printBackground: o.printBackground !== false,
      outline: o.bookmarks !== false, // PDF 书签大纲（按 h1-h6 层级，默认开）
    });
    return out;
  } finally {
    await browser.close();
    // MPE_KEEP_TMP_HTML=1 时保留打印 HTML 供调试分页 DOM
    if (process.env.MPE_KEEP_TMP_HTML) {
      process.stderr.write(`[mpe-export] 调试打印 HTML: ${tmpHtml}\n`);
    } else {
      try {
        fs.unlinkSync(tmpHtml);
      } catch {
        /* ignore */
      }
    }
    if (coverTmpDir && !process.env.MPE_KEEP_TMP_HTML) {
      try {
        fs.rmSync(coverTmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = {
  exportMarkdown,
  detectChrome,
  listPresets,
  getLastPreset,
  saveLastPreset,
  rewriteWavyUnderlines,
  WAVY_UNDERLINE_CSS,
  CALLOUT_TABLE_OVERRIDE_CSS,
};
