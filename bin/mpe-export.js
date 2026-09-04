#!/usr/bin/env node
/**
 * mpe-export CLI 入口
 * 面向 agent/LLM 友好：--json 输出机器可读、stdout 纯净、退出码明确、非交互式
 */

// 抑制 crossnote 老依赖在 Node 22+ 产生的 punycode 弃用警告（stderr 噪音）
process.on('warning', (w) => {
  if (w.name === 'DeprecationWarning' && /punycode/i.test(w.message || '')) return;
});

const { parseArgs, helpText } = require('../lib/args');
const { exportMarkdown, listPresets, getLastPreset, saveLastPreset } = require('../lib/exporter');
const { runScanPdfPipeline } = require('../lib/pipeline');

const VERSION = require('../package.json').version;

function fail(message, code = 1, helpTopic = null) {
  const helpCmd = helpTopic ? `mpe-export --help ${helpTopic}` : 'mpe-export --help';
  if (process.stdout.isTTY) {
    console.error(`\u2716 ${message}`);
  } else {
    process.stdout.write(
      JSON.stringify({ ok: false, tool: 'mpe-export', error: message, help: helpCmd }) + '\n');
  }
  if (process.stdout.isTTY) console.error('  ↳ 说明书: ' + helpCmd);
  process.exit(code);
}

async function main() {
  const rawArgv = process.argv.slice(2);
  // 裸命令（agent 最常见的第一次探测）：直接弹出完整使用说明书
  if (rawArgv.length === 0) {
    console.log(helpText());
    process.exit(0);
  }
  const args = parseArgs(rawArgv);

  if (args.help) {
    console.log(helpText(args.helpTopic));
    process.exit(0);
  }
  if (args.version) {
    console.log(VERSION);
    process.exit(0);
  }
  if (args.preset === 'list') {
    console.log(
      JSON.stringify(
        {
          presets: listPresets(),
          lastUsed: getLastPreset(),
          note: 'lastUsed 为上次成功导出使用的预设；用 --preset last 可直接沿用',
          manual: '使用说明书: mpe-export --help presets（选择指引）/ --help pagination（分页/页脚/目录页）/ --help agent（完整 agent 手册）',
          pagination: {
            note: '以下开关仅 PDF 生效，与预设正交可叠加，front-matter 同名键等价',
            '--pagination': '块级不断页：代码块/图片/引用块/callout 整块搬运不切断',
            '--pagination-level': '标题换页 h1|h2|h3：父章节内第一个该级标题不换页，其余起新页（蕴含 --pagination）',
            '--footer': '页脚：每页章节面包屑 + 页码（蕴含 --pagination）',
            '--toc': '目录页：正文前插入带真实页码的目录（蕴含 --pagination）',
            '--cover': '封面：html/png 插在最前（封面→目录→正文；蕴含 --pagination）',
          },
        },
        null,
        2,
      ),
    );
    process.exit(0);
  }
  if (args.errors.length) {
    for (const e of args.errors) console.error(`\u2716 ${e}`);
    fail(args.errors.join('; '), 2, 'options');
  }
  if (!args.files.length) {
    fail('缺少 markdown 文件参数。用法: mpe-export <file.md> [选项]，详情见 mpe-export --help', 2);
  }

  // 解析 JSON 参数（--config / --pdf-json / --html-json），逐个解析以便指名出错的参数
  let config = null;
  let pdfJson = null;
  let htmlJson = null;
  for (const [flag, raw] of [
    ['--config', args.config],
    ['--pdf-json', args.pdfJson],
    ['--html-json', args.htmlJson],
  ]) {
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (flag === '--config') config = parsed;
      else if (flag === '--pdf-json') pdfJson = parsed;
      else htmlJson = parsed;
    } catch (e) {
      fail(`JSON 参数解析失败（${flag}）: ${e.message}。收到: ${raw.slice(0, 120)}`, 2, 'options');
    }
  }

  const start = Date.now();
  const results = [];

  // ---------- pipeline 模式：调度技能完整流水线 ----------
  if (args.pipeline) {
    for (const file of args.files) {
      if (!args.json && !args.quiet) {
        console.error(`\u21aa \u6b63\u5728\u8c03\u5ea6\u6280\u80fd\u6d41\u6c34\u7ebf: ${file}`);
      }
      try {
        const r = await runScanPdfPipeline({
          file,
          format: args.format === 'both' ? 'pdf' : args.format,
          outDir: args.outDir,
          outName: args.outName,
          check: args.check,
          screenshot: args.screenshot,
          keepJob: args.keepJob,
          jobDir: args.jobDir,
          pythonCmd: args.pythonCmd,
          skillScripts: args.skillScripts,
          normalize: args.normalize !== false,
          katexLocal: args.katexLocal !== false,
        });
        results.push({ ...r, ok: true, engine: 'scan-pdf-pipeline' });
      } catch (e) {
        results.push({ input: file, ok: false, error: e.message, engine: 'scan-pdf-pipeline' });
        if (args.files.length === 1) {
          fail(e.message, 1);
        }
      }
    }
    const anyFailed = results.some((r) => !r.ok);
    const durationMs = Date.now() - start;
    if (args.json) {
      process.stdout.write(
        JSON.stringify({ ok: !anyFailed, tool: 'mpe-export', version: VERSION, engine: 'scan-pdf-pipeline', durationMs, files: results }, null, 2) + '\n',
      );
    } else {
      for (const r of results) {
        if (!r.ok) {
          console.error(`\u2716 ${r.input}: ${r.error}`);
          continue;
        }
        for (const [fmt, dest] of Object.entries(r.outputs || {})) {
          console.log(`\u2714 [${fmt.toUpperCase()}] ${dest}`);
        }
        if (r.checks) {
          for (const [k, v] of Object.entries(r.checks)) {
            if (k.endsWith('_hint')) continue;
            console.log(`    \u2696 ${k}: ${v}`);
          }
        }
      }
    }
    process.exit(anyFailed ? 1 : 0);
  }

  // ---------- 常规模式：crossnote 引擎 ----------

  // 人读模式下的完成后提示（stderr，不污染 --json 的 stdout）
  const hintAfterSuccess = () => {
    if (args.json || args.quiet) return;
    if (!args.preset) {
      console.error(
        '💡 提示: 本次使用默认简洁样式。排版预设可选: claude（亮色主题风）/ claude-dark（暗色）/ onepage（Obsidian OnePage 暖白纸张）/ onepage-dark（暖棕·冷锚）/ phycat（讲义 A4）/ phycat-cherry 等 11 个 Phycat 主题配色变体（8 亮 3 暗），详情: mpe-export --preset list',
      );
    }
    const usedPagination =
      args.pagination ||
      args.footer ||
      args.paginationLevel ||
      args.toc ||
      args.tocLevel ||
      args.cover;
    if ((args.format === 'pdf' || args.format === 'both') && !usedPagination) {
      console.error(
        '💡 提示: 本次 PDF 为原生分页（代码块/引用块可能被切断）。可选: --pagination 整块不断页 / --pagination-level h2|h3 章节换页 / --footer 页脚+页码 / --toc 目录页',
      );
    }
  };

  for (const file of args.files) {
    if (!args.json && !args.quiet) {
      console.error(`\u21aa \u6b63\u5728\u5bfc\u51fa: ${file}`);
    }
    try {
      const r = await exportMarkdown({
        file,
        format: args.format,
        offline: args.offline,
        outDir: args.outDir,
        outName: args.outName,
        config,
        pdfJson,
        htmlJson,
        runCodeChunks: args.runCodeChunks,
        printBackground: args.printBackground,
        chromePath: args.chromePath,
        preset: args.preset,
        footerLabel: args.footerLabel,
        footer: args.footer,
        pagination: args.pagination,
        paginationLevel: args.paginationLevel,
        toc: args.toc,
        tocLevel: args.tocLevel,
        tocTitle: args.tocTitle,
        cover: args.cover,
        bgPattern: args.bgPattern,
        fixMd: args.fixMd,
        mdNormalize: args.mdNormalize,
        bookmarks: args.bookmarks,
        mergeCells: args.mergeCells,
        open: args.open,
      });
      results.push({ ...r, ok: true });
    } catch (e) {
      // 单个文件失败不中断整体（批量场景），标记失败
      results.push({ input: file, ok: false, error: e.message });
      if (args.files.length === 1) {
        fail(e.message, 1);
      }
    }
  }

  const anyFailed = results.some((r) => !r.ok);
  const durationMs = Date.now() - start;

  // 记录本次成功导出使用的预设（供 --preset last 沿用；'last'/'list' 自身不记录）
  if (!anyFailed && args.preset && args.preset !== 'last') {
    const used = results.find((r) => r.ok && r.preset);
    if (used) saveLastPreset(used.preset);
  }

  // ---------- 输出 ----------
  if (args.json) {
    const out = {
      ok: !anyFailed,
      tool: 'mpe-export',
      version: VERSION,
      durationMs,
      files: results,
      // 说明书入口：agent 在任何成功/失败输出里都能看到下一步去哪查
      manual: '使用说明书: mpe-export --help（分主题: options / presets / pagination / agent）',
    };
    // 机器可读的后续建议：agent 解析结果时能看到，可主动告知用户还能换风格
    if (!anyFailed && !args.preset) {
      out.hint =
        '本次使用默认简洁样式（未指定预设）。可选排版预设: claude（亮色主题风）/ claude-dark（暗色）/ onepage（Obsidian OnePage 暖白纸张）/ onepage-dark（暖棕·冷锚）/ phycat（讲义 A4）/ phycat-cherry 等 11 个 Phycat 主题配色变体（8 亮 3 暗，霞鹜文楷正文）；详情: mpe-export --preset list。若用户在意样式，建议下次询问偏好后加 --preset <name> 重导。';
    }
    // PDF 且未用任何分页开关时，提示分页能力存在（agent 可按用户意图追加）
    const usedPagination =
      args.pagination ||
      args.footer ||
      args.paginationLevel ||
      args.toc ||
      args.tocLevel ||
      args.cover;
    if (!anyFailed && (args.format === 'pdf' || args.format === 'both') && !usedPagination) {
      out.paginationHint =
        '本次 PDF 为 Chrome 原生分页（代码块/引用块可能被换页切断）。可选: --pagination（整块不断页）/ --pagination-level h2|h3（章节标题换页，父章节内第一个不换页）/ --footer（页脚+页码+章节面包屑，蕴含分页）/ --toc（正文前插入带真实页码的目录页，蕴含分页）。用户若抱怨切断、要章节换页、要页码或要目录页，追加对应开关重导即可。';
    }
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  } else {
    for (const r of results) {
      if (!r.ok) {
        console.error(`\u2716 ${r.input}: ${r.error}`);
        continue;
      }
      for (const [fmt, dest] of Object.entries(r.outputs)) {
        console.log(`\u2714 [${fmt.toUpperCase()}] ${dest}`);
      }
    }
    if (!anyFailed) hintAfterSuccess();
  }

  process.exit(anyFailed ? 1 : 0);
}

main().catch((e) => fail(e.message || String(e), 1));
