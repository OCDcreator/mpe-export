// 临时终测脚本：验证 pipeline 完整链路（title 修复 + 契约全过）
const { runScanPdfPipeline } = require('C:/Users/lt/Desktop/Write/custom-project/mpe-export/lib/pipeline');
const os = require('os');
const path = require('path');

const file = 'C:/Users/lt/Desktop/Write/custom-project/scan-PDF-print-HTML/product/2026-07-13-导数专题-ch10/source-transcript-第三节 飘带函数型.md';
const jobDir = path.join(os.homedir(), 'Desktop', 'mpe-export-test', 'job-final');

runScanPdfPipeline({
  file,
  format: 'pdf',
  check: true,
  screenshot: true,
  keepJob: true,
  jobDir,
  outDir: path.join(jobDir, 'out'),
})
  .then((r) => {
    console.log('OK checks:', JSON.stringify(r.checks));
    console.log('outputs:', Object.keys(r.outputs));
  })
  .catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
  });
