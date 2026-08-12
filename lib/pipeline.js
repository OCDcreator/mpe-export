/**
 * 技能流水线调度器（pipeline mode）
 *
 * 不是复制 scan-pdf-to-print-html 流水线，而是把技能现成的 Python 流水线
 * 变成可机器调用的单命令：mpe-export <file.md> --format pdf --pipeline
 *
 * 内部自动完成:
 *   1. 创建/复用 job 目录（一个章节 = 一个 job）
 *   2. 复制源 md 为 source-transcript.md（技能 canonical 约定）
 *   3. 自动携带封面: 源目录的 concept-map.png/.svg 复制进 job → postprocess 自动注入
 *   4. build_faithful_handout_html.py  （markdown → handout.html）
 *   5. postprocess_handout_for_contract.py（注入分页 JS、例题样式、KaTeX、封面）
 *   6. render_html_to_pdf.py            （Playwright 渲染，等分页 JS 完成后打印 A4）
 *   7. 可选 --check: 跑两个 fidelity 门禁 validator 并报告 pass/fail
 *   8. 产物归位到 --out / --out-name，--json 统一报告
 *
 * 环境依赖（全部自动探测）:
 *   - Python（py -3 / python / python3）+ Playwright
 *   - 技能脚本目录（默认 my-skills/custom/scan-pdf-to-print-html/scripts，
 *     可用 --config '{"skillScripts":"..."}' 或环境变量 MPE_SCAN_SKILL_SCRIPTS 覆盖）
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

/** 默认技能脚本目录（用户环境） */
const DEFAULT_SKILL_SCRIPTS =
  process.env.MPE_SCAN_SKILL_SCRIPTS ||
  'C:/Users/lt/Desktop/Write/custom-project/my-skills/custom/scan-pdf-to-print-html/scripts';

/** 探测 Python 命令（数组形式） */
function detectPython(custom) {
  if (custom) return String(custom).split(/\s+/);
  const candidates = [
    ['py', '-3'],
    ['python'],
    ['python3'],
  ];
  return candidates[0];
}

/** 执行外部命令，返回 { code, stdout, stderr } */
function run(cmd, args, cwd, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`命令超时(${timeoutMs / 1000}s): ${cmd} ${args.join(' ')}`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** 校验技能脚本目录存在 */
function assertSkillScripts(dir) {
  const needed = [
    'build_faithful_handout_html.py',
    'postprocess_handout_for_contract.py',
    'render_html_to_pdf.py',
  ];
  for (const f of needed) {
    if (!fs.existsSync(path.join(dir, f))) {
      throw new Error(`技能脚本缺失: ${path.join(dir, f)}（用 --config '{"skillScripts":"..."}' 指定）`);
    }
  }
}

/**
 * doc2x 转录格式 → 技能期望格式 的前置规范化（作用于 job 副本，不改源文件）:
 *
 * 1. 纯加粗短标签行（加粗的 解析/详解/解答 等）→ #### 标题。
 *    doc2x 把解析标题转成加粗文本，技能只把它当 lead-tag 小标签，
 *    用户期望它是有层级的标题。仅匹配纯短标签整行，
 *    不会误伤 **综合可得：$f(x)<0$...** 这类加粗长句结论。
 * 2. callout 块（> [!question] 例题1 (2025·...)\n> 设函数...）题号行后
 *    插入空引用行，使题号+来源独占第一段（markdown 无空行会把两行
 *    并成同一段，导致题干跑到第一行）。
 */
function normalizeTranscript(md) {
  // 1. **解析** 类纯加粗短标签 → #### 标题（h4 不触发分页，安全）
  md = md.replace(
    /^\*\*(解析|详解|解答|答案|证明|分析|点拨|提示|归纳|总结|方法|技巧|变式|练习|巩固|拓展|引申)[：:]*\*\*[ \t]*\r?$/gm,
    '#### $1',
  );
  // 2. callout 题号行后插入空引用行（下一行为引用行且非 callout 且非空行时）
  md = md.replace(
    /^([ \t]*>[^\n]*\[!\w+\][^\n]*)\r?\n(?=[ \t]*>(?![ \t]*\[!)[^\n]*\S)/gm,
    '$1\n>\n',
  );
  // 3. 文档无 # 一级标题时，把第一个标题行提升为 #。
  //    build 脚本提取 <title> 的兜底是"第一行非特殊正文"，doc2x 转录首行常是
  //    h2 章节名，导致第一个正文公式行被当标题塞进 <title>（body 外的公式
  //    永远不会被 KaTeX 渲染，fidelity 契约 raw-math 检查失败）。
  if (!/^#[^#]/m.test(md)) {
    md = md.replace(/^(#{1,6})\s+(.+)$/m, '# $2');
  }
  return md;
}

/**
 * 扫描 markdown 中的本地资源引用（![](...) 与 <img src>），
 * 复制到 job 目录保持相对结构（避免临时目录下 ERR_FILE_NOT_FOUND）。
 */
function copyLocalAssets(mdFile, srcDir, jobDir) {
  const raw = fs.readFileSync(mdFile, 'utf8');
  const re = /(?:![\[[^\]]*\]\(|<img[^>]*\ssrc=)["']?([^"')>\s]+)["']?/g;
  const seen = new Set();
  let m;
  while ((m = re.exec(raw))) {
    const ref = (m[1] || '').split(/[?#]/)[0];
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    if (/^(https?:|data:|file:|\/)/i.test(ref)) continue; // 远程/data/绝对路径跳过
    const srcPath = path.resolve(srcDir, ref);
    if (!fs.existsSync(srcPath)) continue;
    const dest = path.join(jobDir, ref);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(srcPath, dest);
    } catch {
      /* ignore single asset failure */
    }
  }
}

/**
 * KaTeX 离线化：把 handout.html 里的 CDN 引用（cdn.jsdelivr.net / unpkg）
 * 改写为 job 目录内本地文件（从 mpe-export 的 node_modules/katex 复制）。
 * 中国网络下 jsdelivr 经常 ERR_CONNECTION_CLOSED，离线化后渲染 100% 稳定。
 * 返回是否成功改写。
 */
function localizeKatex(jobDir, handoutHtml) {
  const katexSrc = path.join(__dirname, '..', 'node_modules', 'katex', 'dist');
  const need = ['katex.min.js', 'katex.min.css', 'contrib/auto-render.min.js'];
  if (need.some((f) => !fs.existsSync(path.join(katexSrc, f)))) return false;
  const dest = path.join(jobDir, 'katex');
  fs.mkdirSync(dest, { recursive: true });
  for (const f of ['katex.min.js', 'katex.min.css', 'contrib']) {
    fs.cpSync(path.join(katexSrc, f), path.join(dest, f), { recursive: true });
  }
  fs.cpSync(path.join(katexSrc, 'fonts'), path.join(dest, 'fonts'), { recursive: true });
  let html = fs.readFileSync(handoutHtml, 'utf8');
  const before = (html.match(/https?:\/\/cdn\.jsdelivr\.net/g) || []).length;
  html = html.replace(/https?:\/\/cdn\.jsdelivr\.net\/npm\/katex@[^"' )]*\/dist\//g, 'katex/');
  html = html.replace(/https?:\/\/unpkg\.com\/katex@[^"' )]*\/dist\//g, 'katex/');
  fs.writeFileSync(handoutHtml, html);
  return before > 0;
}

/**
 * 运行 scan-pdf 技能流水线，导出单个 markdown
 * @param {object} opts
 * @param {string} opts.file        源 markdown
 * @param {string} opts.format      pdf | html | png | both
 * @param {string} [opts.outDir]    输出目录（默认源文件目录）
 * @param {string} [opts.outName]   输出文件名（不含扩展名）
 * @param {boolean} [opts.check]    跑 fidelity 门禁 validator
 * @param {boolean} [opts.screenshot] 同时产出整页截图 PNG
 * @param {boolean} [opts.keepJob]  保留 job 目录（默认临时目录用完删除）
 * @param {string}  [opts.jobDir]   显式指定 job 目录（implies keepJob）
 * @param {string}  [opts.pythonCmd] Python 命令（默认 py -3）
 * @param {string}  [opts.skillScripts] 技能脚本目录
 * @returns {Promise<{input: string, outputs: object, checks?: object, jobDir: string}>}
 */
async function runScanPdfPipeline(opts) {
  const file = path.resolve(opts.file);
  if (!fs.existsSync(file)) throw new Error(`文件不存在: ${file}`);
  const skillScripts = path.resolve(opts.skillScripts || DEFAULT_SKILL_SCRIPTS);
  assertSkillScripts(skillScripts);
  const py = detectPython(opts.pythonCmd);

  const srcDir = path.dirname(file);
  const srcBase = path.basename(file, path.extname(file));
  const format = String(opts.format || 'pdf').toLowerCase();
  const wantPdf = format === 'pdf' || format === 'both' || format === 'png';
  const wantHtml = format === 'html' || format === 'both';

  // ---------- job 目录 ----------
  const keepJob = opts.keepJob || !!opts.jobDir;
  const jobDir = opts.jobDir
    ? path.resolve(opts.jobDir)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-skill-'));
  fs.mkdirSync(jobDir, { recursive: true });
  const cleanup = () => {
    if (!keepJob) {
      try {
        fs.rmSync(jobDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };

  const steps = [];
  const step = (name, msg) => steps.push({ name, message: msg });

  try {
    // ---------- 1. canonical transcript + 封面 + 本地资源 ----------
    const rawMd = fs.readFileSync(file, 'utf8');
    const canonical = opts.normalize !== false ? normalizeTranscript(rawMd) : rawMd;
    fs.writeFileSync(path.join(jobDir, 'source-transcript.md'), canonical);
    for (const cover of ['concept-map.png', 'concept-map.svg']) {
      const src = path.join(srcDir, cover);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(jobDir, cover));
    }
    copyLocalAssets(file, srcDir, jobDir);
    step('prepare', '复制 canonical 源 + 封面检测 + 本地图片资源');

    const handoutHtml = path.join(jobDir, 'handout.html');

    // ---------- 2. build ----------
    if (wantHtml || wantPdf) {
      const r = await run(py[0], [...py.slice(1), path.join(skillScripts, 'build_faithful_handout_html.py'),
        '--md', 'source-transcript.md', '--out-html', 'handout.html'], jobDir);
      if (r.code !== 0) throw new Error(`build_faithful_handout_html 失败:\n${r.stderr || r.stdout}`);
      step('build', 'build_faithful_handout_html.py');

      // ---------- 3. postprocess（分页 JS 注入等） ----------
      const p = await run(py[0], [...py.slice(1), path.join(skillScripts, 'postprocess_handout_for_contract.py'),
        '--html', 'handout.html'], jobDir);
      if (p.code !== 0) throw new Error(`postprocess_handout_for_contract 失败:\n${p.stderr || p.stdout}`);
      step('postprocess', 'postprocess_handout_for_contract.py（分页 JS + 封面 + KaTeX）');

      // KaTeX 离线化（默认开，--no-katex-local 关闭）
      if (opts.katexLocal !== false) {
        if (localizeKatex(jobDir, handoutHtml)) {
          step('localize', 'KaTeX 本地化（离线渲染，无 CDN 依赖）');
        }
      }
    }

    // ---------- 4. render（Playwright，等分页完成） ----------
    const outputs = {};
    const outDir = path.resolve(opts.outDir || srcDir);
    fs.mkdirSync(outDir, { recursive: true });
    const outName = opts.outName || srcBase;

    if (wantPdf || (wantHtml && opts.screenshot)) {
      const pdfPath = path.join(jobDir, 'handout.pdf');
      const args = [path.join(skillScripts, 'render_html_to_pdf.py'),
        '--html', 'handout.html', '--pdf', 'handout.pdf'];
      if (opts.screenshot) args.push('--screenshot', 'handout-screenshot.png');
      const r = await run(py[0], [...py.slice(1), ...args], jobDir);
      if (r.code !== 0) throw new Error(`render_html_to_pdf 失败:\n${r.stderr || r.stdout}`);
      step('render', 'render_html_to_pdf.py（Playwright A4 渲染）');
      if (wantPdf) {
        const dest = path.join(outDir, outName + '.pdf');
        fs.copyFileSync(pdfPath, dest);
        outputs.pdf = dest;
      }
      if (opts.screenshot) {
        const png = path.join(jobDir, 'handout-screenshot.png');
        if (fs.existsSync(png)) {
          const dest = path.join(outDir, outName + '.png');
          fs.copyFileSync(png, dest);
          outputs.png = dest;
        }
      }
    }
    if (wantHtml) {
      const dest = path.join(outDir, outName + '.html');
      fs.copyFileSync(handoutHtml, dest);
      outputs.html = dest;
    }

    // ---------- 5. 可选门禁 ----------
    const checks = {};
    if (opts.check && fs.existsSync(handoutHtml)) {
      const validators = [
        {
          name: 'rendered_contract',
          script: 'validate_rendered_handout_contract.py',
          args: ['--html', 'handout.html', '--require-katex', '--disallow-mathjax'],
        },
        {
          name: 'sheet_bottom_margin',
          script: 'validate_sheet_bottom_margin.py',
          args: ['--html', 'handout.html'],
        },
      ];
      for (const v of validators) {
        const sp = path.join(skillScripts, v.script);
        if (!fs.existsSync(sp)) continue;
        const r = await run(py[0], [...py.slice(1), sp, ...v.args], jobDir);
        checks[v.name] = r.code === 0 ? 'pass' : 'fail';
        if (r.code !== 0) checks[v.name + '_hint'] = (r.stderr || r.stdout).trim().slice(0, 400);
      }
      step('check', 'fidelity 门禁（rendered_contract + sheet_bottom_margin）');
    }

    return { input: file, outputs, checks, jobDir, steps };
  } catch (e) {
    cleanup();
    throw e;
  }
}

module.exports = { runScanPdfPipeline, DEFAULT_SKILL_SCRIPTS, detectPython };
