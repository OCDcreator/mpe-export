/**
 * 冒烟测试：node test/smoke.js
 * 验证 --help / --version / 导出 HTML+PDF / --json 输出 / 错误场景
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const BIN = path.join(__dirname, '..', 'bin', 'mpe-export.js');
const EXAMPLE = path.join(__dirname, '..', 'examples', 'example.md');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mpe-test-'));

function run(args) {
  return execFileSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
  });
}

let pass = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2714 ${name}`);
    pass++;
  } catch (e) {
    console.error(`  \u2716 ${name}\n    ${e.message}`);
    process.exitCode = 1;
  }
}

console.log('== mpe-export 冒烟测试 ==');

check('--help 输出帮助', () => {
  const out = run(['--help']);
  if (!out.includes('mpe-export')) throw new Error('帮助文本缺少工具名');
  if (!out.includes('--json')) throw new Error('帮助文本缺少 --json 说明');
});

check('--version 输出版本', () => {
  const out = run(['--version']).trim();
  if (!/^\d+\.\d+\.\d+$/.test(out)) throw new Error('版本格式错误: ' + out);
});

check('导出 HTML + PDF (both)', () => {
  const out = run([EXAMPLE, '--format', 'both', '--out', tmp]);
  if (!out.includes('[HTML]') || !out.includes('[PDF]')) throw new Error(out);
  if (!fs.existsSync(path.join(tmp, 'example.html'))) throw new Error('缺少 example.html');
  if (!fs.existsSync(path.join(tmp, 'example.pdf'))) throw new Error('缺少 example.pdf');
});

check('--json 输出可解析', () => {
  const out = run([EXAMPLE, '--format', 'pdf', '--out', tmp, '--json']);
  const data = JSON.parse(out);
  if (!data.ok) throw new Error(JSON.stringify(data));
  if (!data.files[0].outputs.pdf) throw new Error('缺少 outputs.pdf');
  if (typeof data.durationMs !== 'number') throw new Error('缺少 durationMs');
});

check('--offline HTML 导出', () => {
  const out = run([EXAMPLE, '--format', 'html', '--offline', '--out', tmp, '--out-name', 'offline_demo']);
  const html = fs.readFileSync(path.join(tmp, 'offline_demo.html'), 'utf8');
  if (!html.includes('</html>')) throw new Error('HTML 不完整');
});

check('--pdf-json 参数注入', () => {
  const out = run([
    EXAMPLE,
    '--format', 'pdf',
    '--pdf-json', '{"format":"Letter","displayHeaderFooter":true}',
    '--out', tmp,
    '--out-name', 'letter_demo',
  ]);
  const src = fs.readFileSync(EXAMPLE, 'utf8'); // 源文件不应被修改
  if (!src.includes('format: A4')) throw new Error('源文件被修改了!');
  if (!fs.existsSync(path.join(tmp, 'letter_demo.pdf'))) throw new Error('缺少 letter_demo.pdf');
});

check('批量多文件导出', () => {
  const b = path.join(tmp, 'batch-b.md');
  fs.writeFileSync(b, '# Batch B\n\nhello');
  const out = run([EXAMPLE, b, '--format', 'html']);
  if (!out.includes('batch-b.html')) throw new Error(out);
});

check('文件不存在 → 非零退出码', () => {
  try {
    run(['nope.md']);
    throw new Error('应失败却没有失败');
  } catch (e) {
    if (e.status === 0) throw new Error('退出码应为非零');
  }
});

console.log(`\n完成: ${pass} 项通过`);
