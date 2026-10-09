/**
 * css-color.js —— CSS 颜色字面量解析与对比度计算（纯函数小模块）
 *
 * 无重依赖（不引 crossnote），lib/ 与 tools/ 共用，消除历史上两份同名
 * parseCssColor 的实现漂移：
 *   - lib/exporter.js 旧版：支持 #rgb/#rgba/#rrggbb/#rrggbbaa（大小写不敏感）
 *     与 rgb()/rgba()，但丢弃 alpha、只返回 [r,g,b]；
 *   - tools/build-phycat-preset.js 旧版：只认 #rrggbb，却保留 rgb()/rgba()
 *     的 alpha（第 4 个分量）。
 * 本模块取两者语义并集，统一返回 [r,g,b,a]：
 *   - alpha 缺省 1；#rgba/#rrggbbaa 的 alpha 字节按 /255 归一（tools 侧把
 *     alpha 当"合成到白底"的系数用，必须落在 [0,1]）；
 *   - rgb()/rgba() 逗号或空格分隔均可，支持现代语法的 `/ alpha`（可写百分比，
 *     claude 预设的 --alert-* 在用）；
 *   - 通道值不做钳制/取整，语义由调用方决定（混色按字节舍入，对比度直接线性化）；
 *   - 解析失败一律返回 null（var()/url()/gradient() 等引用交给调用方兜底链）；
 *   - 与旧 exporter 版的唯一收紧：rgb()/rgba() 须形态完整（以 `)` 收尾、通道为
 *     非负整数）——旧版按前缀匹配，`rgb(1,2,3` 这类残缺值也会被误收（合法 CSS
 *     与现有全部预设中不存在该形态）。
 */

'use strict';

/** 解析 CSS 颜色字面量为 [r,g,b,a]；支持 #rgb/#rgba/#rrggbb/#rrggbbaa 与 rgb()/rgba()。 */
function parseCssColor(text) {
  const s = String(text || '').trim().toLowerCase();
  let m;
  if ((m = s.match(/^#([0-9a-f]{3,8})$/))) {
    const hex = m[1];
    if (hex.length === 3 || hex.length === 4) {
      // 短 hex：通道倍增；#rgba 的第 4 位是 alpha
      const [r, g, b, a] = [0, 1, 2, 3].map((i) => parseInt(hex[i] + hex[i], 16));
      return [r, g, b, hex.length === 4 ? a / 255 : 1];
    }
    if (hex.length === 6 || hex.length === 8) {
      // 长 hex：字节对；#rrggbbaa 的第 4 字节是 alpha
      const [r, g, b, a] = [0, 2, 4, 6].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return [r, g, b, hex.length === 8 ? a / 255 : 1];
    }
    return null; // 5/7 位 hex 不是合法形态
  }
  if (
    (m = s.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:\s*[/,]\s*([0-9.]+%?))?\s*\)$/))
  ) {
    // 逗号或空格分隔均可；alpha 取 rgba() 的第 4 分量或现代语法的 `/ alpha`
    // （缺省 1，`10%` 形按 /100 归一——claude 预设的 --alert-* 在用）。通道只收
    // 非负整数；负数/百分比通道与残缺值不认（旧 exporter 版按前缀误收的形态）。
    const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), a];
  }
  return null;
}

/** 相对亮度（WCAG）。入参 [r,g,b]（多出的分量忽略），返回 0（黑）~ 1（白）。 */
function luminance(rgb) {
  const lin = rgb.map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

/** 对比度（WCAG）。入参两色的 [r,g,b]，返回 ≥1 的比值（纯黑对纯白 = 21）。 */
function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

module.exports = { parseCssColor, luminance, contrastRatio };
