/**
 * theme-vars.js —— 文档级调色（--theme-vars / front-matter theme-vars）
 *
 * 把 CLI（JSON 字符串）/ front-matter（YAML 映射）的 CSS 变量覆盖解析成
 * ":root {...}" 注入段，供 exporter 拼在预设 CSS 之后（同特异性靠文档顺序
 * 获胜，改调色板变量即改全文配色，mermaid 跟随——见 lib/mermaid-theme.js）。
 * 纯字符串/CSS 构建模块：不碰文件系统、不依赖 exporter，键校验与值消毒
 * 都在这一个入口完成。
 */

'use strict';

/**
 * theme-vars 值消毒（拒绝式）：值要原样拼进 :root{} 声明，含声明/规则边界
 * 字符的值会越界改写样式（实测 `red; } body { display:none` 可注入任意规则）。
 * 拒绝式校验：含 `;` `{` `}` `<` `>`，或（不区分大小写）`url(` / `expression(`
 * / `@import` 的值一律拒绝。合法用例（颜色/长度/字体栈/`counter(h1) ". "`
 * 编号串）都不含上述模式，不受影响。
 * @returns {string|null} 拒绝原因；null=放行
 */
function themeVarsValueRejectReason(value) {
  const s = String(value);
  const badChar = s.match(/[;{}<>]/);
  if (badChar) return `含禁止字符 "${badChar[0]}"`;
  const badFn = s.match(/url\(|expression\(|@import/i);
  if (badFn) return `含禁止构造 "${badFn[0]}"`;
  return null;
}

/**
 * 文档级调色（theme-vars）：把 CLI --theme-vars / front-matter theme-vars 的
 * CSS 变量覆盖解析成 :root{} 注入段。优先级与全局约定一致：CLI > front-matter。
 * CLI 传 JSON 字符串；front-matter 是 YAML 映射（注意：值含 # 的颜色必须加引号，
 * 否则 YAML 当注释吞掉，如 "--element-color": "#e74c3c"）。
 * 键必须是 --xxx 形式的 CSS 变量名，值须过 themeVarsValueRejectReason 消毒，
 * 不合格的键整条跳过并经 stderr 告警（其余键照常生效）；无有效条目返回 null。
 * 只在预设样式（preset.cssFile）下生效——变量覆盖要落在调色板变量上才有意义。
 * @returns {string|null} ":root {...}" 文本或 null
 */
function buildThemeVarsOverride(cliRaw, fmValue) {
  let source = null;
  if (cliRaw !== undefined && cliRaw !== null && String(cliRaw).trim() !== '') {
    try {
      source = typeof cliRaw === 'string' ? JSON.parse(cliRaw) : cliRaw;
    } catch {
      throw new Error(`--theme-vars 不是合法 JSON: ${String(cliRaw).slice(0, 120)}`);
    }
  } else if (fmValue && typeof fmValue === 'object') {
    source = fmValue;
  } else if (typeof fmValue === 'string' && fmValue.trim()) {
    try {
      source = JSON.parse(fmValue);
    } catch {
      throw new Error(`front-matter theme-vars 不是合法 JSON/YAML 映射: ${fmValue.slice(0, 120)}`);
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null;
  const lines = [];
  for (const [k, v] of Object.entries(source)) {
    if (!/^--[A-Za-z0-9-]+$/.test(k)) {
      process.stderr.write(`提示: theme-vars 跳过非法变量名 "${k}"（须为 --xxx 形式）\n`);
      continue;
    }
    const reason = themeVarsValueRejectReason(v);
    if (reason) {
      process.stderr.write(
        `提示: theme-vars 跳过 "${k}"（值${reason}；仅支持颜色/长度/字体栈等纯声明值）\n`,
      );
      continue;
    }
    lines.push(`    ${k}: ${String(v)};`);
  }
  return lines.length ? `:root {\n${lines.join('\n')}\n}` : null;
}

module.exports = { themeVarsValueRejectReason, buildThemeVarsOverride };
