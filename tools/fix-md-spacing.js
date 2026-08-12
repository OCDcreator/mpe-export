#!/usr/bin/env node
/**
 * fix-md-spacing —— 在块级元素前后补空行（源文件就地修复）
 *
 * 背景：Typora 等编辑器要求块级元素与正文之间有空行，否则渲染失败或
 * 错乱（$$ 公式块贴正文会被并进段落：块内 = 行变 setext 标题、^ 被
 * 上标吃掉）。本工具把缺失的空行补回源文件；规则见 lib/normalize.js。
 *
 * 覆盖：$$ 公式块 / 围栏代码块 / 引用块·callout / HTML 块 / GFM 表格 /
 * 分割线 / ATX 标题 / 列表。跳过 front-matter 与代码块、公式块内部。
 *
 * 用法：
 *   node tools/fix-md-spacing.js <file.md> [file2.md ...]
 *   node tools/fix-md-spacing.js --check <file.md>   # 只报告，不修改
 *
 * 默认就地修改并保留 <file>.bak 备份；--no-bak 关闭备份。
 * 注意：mpe-export 导出时已默认在内存里做同样的规范化（不改源文件），
 * 本工具用于把修复落回源文件本身（等价于导出时加 --fix-md）。
 * 退出码：0 正常（含无需修改）；1 有文件读取/写入失败；2 参数错误。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeMarkdown, KIND_NAMES } = require('../lib/normalize');

function main() {
  const args = process.argv.slice(2);
  const checkOnly = args.includes('--check');
  const noBak = args.includes('--no-bak');
  const files = args.filter((a) => !a.startsWith('--'));

  if (!files.length) {
    console.error('用法: node tools/fix-md-spacing.js [--check] [--no-bak] <file.md> [...]');
    process.exit(2);
  }

  let failed = false;
  for (const file of files) {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch (e) {
      console.error(`✘ 读取失败: ${file} — ${e.message}`);
      failed = true;
      continue;
    }
    const { text, added, byKind } = normalizeMarkdown(src);
    if (added === 0) {
      console.log(`✓ 无需修改: ${file}`);
      continue;
    }
    const kinds = Object.entries(byKind)
      .map(([k, n]) => `${KIND_NAMES[k] || k}×${n}`)
      .join(' ');
    if (checkOnly) {
      console.log(`○ 缺 ${added} 个空行（${kinds}）: ${file}`);
      continue;
    }
    try {
      if (!noBak) fs.writeFileSync(file + '.bak', src);
      fs.writeFileSync(file, text);
      console.log(`✓ 补了 ${added} 个空行（${kinds}）: ${file}（备份: ${path.basename(file)}.bak）`);
    } catch (e) {
      console.error(`✘ 写入失败: ${file} — ${e.message}`);
      failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}

main();
