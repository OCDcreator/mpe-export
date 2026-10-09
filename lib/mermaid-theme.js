/**
 * mermaid-theme.js —— mermaid 全图型主题变量（phycat-* 变体专属）
 *
 * crossnote 合并语义（index.cjs 渲染脚本，预览/导出两处一致）：
 *   var MERMAID_CONFIG = ({...notebook.config.mermaidConfig});   // 整体注入
 *   MERMAID_CONFIG.theme = "${notebook.config.mermaidTheme}";    // 无条件覆盖
 *   mermaid.initialize(MERMAID_CONFIG || {})
 * 即 mermaidConfig 是 initialize() 的完整 init 对象，但 theme 键必被
 * mermaidTheme 字符串覆盖 —— theme 不能写进 mermaidConfig，由 mermaidTheme 负责。
 *
 * mermaid v11 的 initialize() 对任何内置主题（default/dark/forest/neutral）
 * 都执行 该主题.getThemeVariables(用户 themeVariables)：用户键先盖到主题默认
 * 值上，updateColors() 派生各图型专用色（actor/note/cluster/cScale...）后再
 * 次回填用户键。因此 mermaidConfig.themeVariables 可叠加在任何 theme 上驱动
 * 全部图型，不必切 theme:'base'（亮 default / 暗 dark 原生底更稳）。
 *
 * 颜色解析复用 lib/css-color.js 的 parseCssColor（与 tools/build-phycat-preset.js
 * 共用，统一返回带 alpha 的 [r,g,b,a]）；mermaid 调色只消费前三通道，alpha 不参与。
 */

'use strict';

const { parseCssColor } = require('./css-color');

const cssByte = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** base 向 target 混合 amount（0=base，1=target），返回 #rrggbb；解析失败返回中灰。 */
function mixCssColors(base, target, amount) {
  const b = parseCssColor(base);
  const t = parseCssColor(target);
  if (!b || !t) return '#888888';
  // 只混 r/g/b 三通道（与抽取前一致）；带 alpha 的输入不在此做合成
  return '#' + [0, 1, 2].map((i) => cssByte(b[i] + (t[i] - b[i]) * amount)).join('');
}

/**
 * 从预设 CSS 文本提取调色板变量（同名变量后者获胜，与 CSS 级联一致——
 * theme-vars 的 :root 覆盖段排在最后，因此自动压过预设原值，改调色即改 mermaid）。
 * 只收可静态解析的颜色字面量；var()/url()/gradient() 引用跳过，交给兜底链。
 */
function extractPaletteColors(cssText) {
  const colors = {};
  const re = /(^|[;\s{])(--[A-Za-z0-9-]+)\s*:\s*([^;{}]+)[;}]/g;
  let m;
  while ((m = re.exec(String(cssText)))) {
    if (parseCssColor(m[3])) colors[m[2]] = m[3].trim();
  }
  return colors;
}

// ---------------------------------------------------------------------------
// themeVariables 生成规则表（数据表驱动，暗/亮各一列）
//
// 每行 [变量名, 亮色规则, 暗色规则]，键序与注入 JSON 一致；规则三种形态：
//   'paper'                  —— 基础色直引（paper/text/accent/accent2/white/black）
//   ['accent', 'paper', 0.9] —— mix(基色, 目标色, 比例)
//   () => '1'                —— 字面量（仅 pieOpacity 这类非颜色值）
//
// 变量残缺规律与 CSS 侧同款兜底链（见 buildMermaidThemeVariables）：
// primaryColor/mainBkg 预调成浅调（亮：强调色混白 ~88%；暗：混纸色 ~78%）。
// ---------------------------------------------------------------------------

const THEME_VARIABLE_RULES = [
  // 画布与全局文字：贴预设纸张底色，图表与页面无缝
  ['background', 'paper', 'paper'],
  ['textColor', 'text', 'text'],
  ['lineColor', 'accent', 'accent'],
  // 主/次/三级色：mermaid 从这组派生各图型专用色（用户键在 updateColors()
  // 后二次回填，显式键最终获胜）
  ['primaryColor', ['accent', 'white', 0.88], ['accent', 'paper', 0.78]],
  ['primaryTextColor', 'text', 'text'],
  ['primaryBorderColor', 'accent', 'accent'],
  ['secondaryColor', ['accent', 'white', 0.93], ['accent2', 'paper', 0.72]],
  ['secondaryTextColor', 'text', 'text'],
  ['secondaryBorderColor', 'accent2', 'accent2'],
  ['tertiaryColor', ['accent', 'white', 0.95], ['accent', 'paper', 0.9]],
  ['tertiaryTextColor', 'text', 'text'],
  ['tertiaryBorderColor', ['accent', 'white', 0.45], ['accent', 'paper', 0.5]],
  // 流程图：节点/子图底色（预设 CSS 的 !important 规则仍优先，这里兜非覆盖场景）
  ['mainBkg', ['accent', 'white', 0.88], ['accent', 'paper', 0.78]],
  ['clusterBkg', ['accent', 'white', 0.95], ['accent', 'paper', 0.9]],
  ['clusterBorder', ['accent', 'white', 0.45], ['accent', 'paper', 0.5]],
  ['edgeLabelBackground', 'paper', 'paper'],
  // 时序图
  ['actorBkg', ['accent', 'white', 0.8], ['accent', 'paper', 0.7]],
  ['actorBorder', 'accent', 'accent'],
  ['actorTextColor', 'text', 'text'],
  ['actorLineColor', ['accent', 'white', 0.5], ['text', 'paper', 0.6]],
  ['signalColor', 'text', 'text'],
  ['signalTextColor', 'text', 'text'],
  ['noteBkgColor', ['accent', 'white', 0.82], ['accent2', 'paper', 0.62]],
  ['noteBorderColor', 'accent2', 'accent2'],
  ['noteTextColor', 'text', 'text'],
  ['labelBoxBkgColor', ['accent', 'white', 0.8], ['accent', 'paper', 0.68]],
  ['labelBoxBorderColor', 'accent', 'accent'],
  ['labelTextColor', 'text', 'text'],
  ['loopTextColor', 'text', 'text'],
  ['activationBkgColor', ['accent', 'white', 0.62], ['accent', 'paper', 0.52]],
  ['activationBorderColor', 'accent', 'accent'],
  ['sequenceNumberColor', 'white', 'white'],
  // 饼图：亮色主题 pie1..12 派生自主色（跟随 primaryColor 覆盖，实测生效）；
  // 暗色主题的 cScale/pie 扇区盘是硬编码（cScale1="#0b0000" 等，不响应
  // primaryColor），必须逐键给变体扇区色（见 buildMermaidThemeVariables 尾部循环）
  ['pieOpacity', () => '0.7', () => '1'],
  ['pieStrokeColor', ['accent', 'black', 0.25], ['accent', 'paper', 0.4]],
  ['pieTitleTextColor', 'text', 'text'],
  ['pieSectionTextColor', 'text', 'text'],
  ['pieLegendTextColor', 'text', 'text'],
  // 甘特图
  ['sectionBkgColor', ['accent', 'white', 0.94], ['accent', 'paper', 0.9]],
  ['altSectionBkgColor', 'paper', 'paper'],
  ['sectionBkgColor2', ['accent', 'white', 0.88], ['accent', 'paper', 0.82]],
  ['taskBkgColor', ['accent', 'white', 0.72], ['accent', 'paper', 0.68]],
  ['taskBorderColor', 'accent', 'accent'],
  ['taskTextColor', 'text', 'text'],
  ['taskTextDarkColor', 'text', 'text'],
  ['taskTextOutsideColor', 'text', 'text'],
  ['taskTextLightColor', 'white', 'paper'],
  ['activeTaskBkgColor', ['accent', 'white', 0.35], ['accent', 'paper', 0.4]],
  ['activeTaskBorderColor', ['accent', 'black', 0.2], 'accent'],
  ['doneTaskBkgColor', ['accent', 'white', 0.92], ['accent', 'paper', 0.88]],
  ['doneTaskBorderColor', ['accent', 'white', 0.45], ['accent', 'paper', 0.55]],
  ['gridColor', ['accent', 'white', 0.6], ['text', 'paper', 0.75]],
  ['todayLineColor', 'accent', 'accent'],
];

/** 按三种形态解析一条规则：字面量函数 / 混色三元组 / 基础色直引。 */
function resolveRuleSpec(spec, base) {
  if (typeof spec === 'function') return spec(base);
  if (Array.isArray(spec)) return mixCssColors(base[spec[0]], base[spec[1]], spec[2]);
  return base[spec];
}

/**
 * 调色板变量 → mermaid themeVariables（暗/亮两套派生规则）。
 * 变量残缺规律与 CSS 侧同款兜底链：--element-color 只有亮色变体有
 * （暗色走 --primary-color）、--secondary-color 只有暗色有、
 * --bg-color/--text-color 暗色全有（亮色纸张即白底/深灰字）。
 * primaryColor 是 mermaid 直接拿去当节点填充的键，必须预调成浅调
 * （亮：强调色混白 ~88%；暗：混纸色 ~78%），文字色单独给正文色保对比。
 * @param {Record<string, string>} colors extractPaletteColors 的调色板变量
 * @param {boolean} dark 是否暗色变体
 * @returns {Record<string, string>} mermaid themeVariables（键序固定）
 */
function buildMermaidThemeVariables(colors, dark) {
  const paper = colors['--bg-color'] || (dark ? '#282a36' : '#ffffff');
  const text = colors['--text-color'] || (dark ? '#f8f8f2' : '#333333');
  const accent =
    colors['--element-color'] ||
    colors['--primary-color'] ||
    (dark ? '#ff5555' : '#3498db');
  const accent2 = colors['--secondary-color'] || mixCssColors(accent, paper, 0.55);
  const base = { paper, text, accent, accent2, white: '#ffffff', black: '#000000' };
  const tv = {};
  for (const [key, lightSpec, darkSpec] of THEME_VARIABLE_RULES) {
    tv[key] = resolveRuleSpec(dark ? darkSpec : lightSpec, base);
  }
  // 暗色主题的饼图扇区盘是硬编码，必须逐键给变体扇区色：
  // accent 系三色 × 四档深浅循环，保证暗底上扇区可辨、文字仍走 pieSectionTextColor
  if (dark) {
    const hues = [accent, accent2, colors['--accent-color'] || mixCssColors(accent, '#ffffff', 0.35)];
    const mixes = [0.55, 0.3, 0.42, 0.18];
    for (let i = 0; i < 12; i++) {
      tv['pie' + (i + 1)] = mixCssColors(hues[i % 3], paper, mixes[i % 4]);
    }
  }
  return tv;
}

module.exports = { mixCssColors, extractPaletteColors, buildMermaidThemeVariables };
