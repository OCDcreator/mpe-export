/**
 * 宽松的命令行参数解析器
 * - 支持 `--key value` 与 `--key=value` 两种写法（agent 常用 = 形式）
 * - 支持短参：-f -j -q -o -c -h -v
 * - 未知参数直接报错（agent 友好：早失败可诊断）
 * - 布尔参数允许显式赋值：--offline false
 */

const VALUE_OPTIONS = {
  '--format': 'format',
  '--out': 'outDir',
  '--out-name': 'outName',
  '--config': 'config',
  '--pdf-json': 'pdfJson',
  '--html-json': 'htmlJson',
  '--theme': 'theme',
  '--code-theme': 'codeTheme',
  '--math': 'math',
  '--chrome-path': 'chromePath',
  '--print-background': 'printBackground',
  '--preset': 'preset',
  '--footer-label': 'footerLabel',
  '--pagination-level': 'paginationLevel',
  '--toc-level': 'tocLevel',
  '--toc-title': 'tocTitle',
  '--cover': 'cover',
  '--job-dir': 'jobDir',
  '--python-cmd': 'pythonCmd',
  '--skill-scripts': 'skillScripts',
  '--no-normalize': 'normalize',
  '--no-katex-local': 'katexLocal',
};

const BOOL_OPTIONS = {
  '--offline': 'offline',
  '--footer': 'footer',
  '--pagination': 'pagination',
  '--toc': 'toc',
  '--bg-pattern': 'bgPattern',
  '--json': 'json',
  '--quiet': 'quiet',
  '--open': 'open',
  '--pipeline': 'pipeline',
  '--check': 'check',
  '--screenshot': 'screenshot',
  '--keep-job': 'keepJob',
  '--help': 'help',
  '--version': 'version',
  '--run-code-chunks': 'runCodeChunks',
  '--no-run-code-chunks': 'noRunCodeChunks',
  '--fix-md': 'fixMd',
  '--no-md-normalize': 'noMdNormalize',
  '--no-bookmarks': 'noBookmarks',
  '--no-merge-cells': 'noMergeCells',
};

const SHORT = {
  '-h': '--help',
  '-v': '--version',
  '-f': '--format',
  '-j': '--json',
  '-q': '--quiet',
  '-o': '--out',
  '-c': '--config',
};

/** @returns {import('./args-types').ParsedArgs} */
const HELP_TOPICS = ['options', 'presets', 'pagination', 'agent'];

function parseArgs(argv) {
  const result = {
    files: [],
    format: 'both',
    offline: false,
    footer: false,
    pagination: false,
    paginationLevel: null,
    toc: false,
    tocLevel: null,
    tocTitle: null,
    cover: null,
    bgPattern: false,
    outDir: null,
    outName: null,
    config: null,
    pdfJson: null,
    htmlJson: null,
    runCodeChunks: true,
    json: false,
    quiet: false,
    open: false,
    help: false,
    helpTopic: null,
    version: false,
    theme: null,
    codeTheme: null,
    math: null,
    chromePath: null,
    printBackground: null,
    preset: null,
    footerLabel: null,
    pipeline: false,
    check: false,
    screenshot: false,
    keepJob: false,
    jobDir: null,
    pythonCmd: null,
    skillScripts: null,
    normalize: true,
    katexLocal: true,
    fixMd: false,
    mdNormalize: true,
    noMdNormalize: false,
    bookmarks: true,
    noBookmarks: false,
    mergeCells: true,
    noMergeCells: false,
  };

  const errors = [];

  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inlineValue = null;

    // 展开 --key=value
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inlineValue = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }

    // 短参映射
    if (SHORT[arg]) arg = SHORT[arg];

    // --help [topic]：可带一个主题词（--help pagination / --help=pagination）
    if (arg === '--help') {
      let topic = inlineValue;
      if (topic === null && argv[i + 1] && !argv[i + 1].startsWith('-')) {
        topic = argv[++i];
      }
      result.help = true;
      result.helpTopic = topic ? topic.toLowerCase() : null;
      continue;
    }

    if (VALUE_OPTIONS[arg]) {
      let value = inlineValue;
      if (value === null) {
        value = argv[++i];
        if (value === undefined) {
          errors.push(`参数 ${arg} 缺少值`);
          continue;
        }
      }
      result[VALUE_OPTIONS[arg]] = value;
    } else if (BOOL_OPTIONS[arg]) {
      const key = BOOL_OPTIONS[arg];
      if (inlineValue !== null) {
        if (inlineValue === 'true' || inlineValue === '1') result[key] = true;
        else if (inlineValue === 'false' || inlineValue === '0') {
          result[key] = false;
          if (key === 'runCodeChunks') result.noRunCodeChunks = true;
        } else errors.push(`参数 ${arg} 需要 true/false 值`);
      } else {
        result[key] = true;
        if (key === 'noRunCodeChunks') result.runCodeChunks = false;
        if (key === 'runCodeChunks') result.noRunCodeChunks = false;
        if (key === 'noMdNormalize') result.mdNormalize = false;
        if (key === 'noBookmarks') result.bookmarks = false;
        if (key === 'noMergeCells') result.mergeCells = false;
      }
    } else if (arg.startsWith('-') && arg !== '-') {
      errors.push(`未知参数: ${arg}（用 --help 查看全部选项）`);
    } else {
      result.files.push(arg);
    }
  }

  if (result.printBackground !== null) {
    result.printBackground = result.printBackground === 'true';
  }
  // --no-run-code-chunks 优先级
  if (result.noRunCodeChunks) result.runCodeChunks = false;

  return { ...result, errors };
}

/** 分主题说明书。无主题 = 完整手册；未知主题 = 主题索引 */
const HELP_SECTIONS = {
  options: `
选项详解:
  -f, --format <type>     导出格式: pdf | html | png | jpeg | both (默认 both)
  -o, --out <dir>         输出目录 (默认: 源文件所在目录)
      --out-name <name>   输出文件名 (不含扩展名; 默认: 源文件名)
      --offline           HTML 导出为离线单文件 (资源全部内联)
  -c, --config <json>     NotebookConfig JSON 字符串，直接覆盖引擎配置
                          (如 {"previewTheme":"newsprint.css","mathRenderingOption":"MathJax"})
      --pdf-json <json>   PDF 参数 JSON，透传给 Chrome page.pdf()
                          (如 {"format":"A4","margin":{"top":"10mm"},"displayHeaderFooter":true})
      --html-json <json>  HTML 参数 JSON (如 {"embed_local_images":true,"embed_svg":true})
      --theme <name>      预览主题 (如 github-light.css, newsprint.css)
      --code-theme <name> 代码高亮主题 (如 github.css, monokai.css)
      --math <engine>     数学渲染: katex | mathjax | none
      --chrome-path <p>   Chrome/Edge 可执行文件路径 (默认自动探测)
      --print-background <true|false>  PDF 是否打印背景
      --no-run-code-chunks   不执行 markdown 中的代码块
      --fix-md            规范化源文档并写回（默认只在内存规范化: 公式块/代码块/
                          引用块/callout/HTML块/表格/分割线/标题/列表 前后缺空行时
                          自动补齐——紧贴正文的 $$ 块会被并进段落，= 行变 setext
                          标题、^ 被上标吃掉，Typora 也无法渲染。写回留 .bak 备份；
                          front-matter: fix-md: true）
      --no-md-normalize   关闭上述内存规范化（front-matter: md-normalize: false）
      --no-bookmarks      关闭 PDF 书签大纲（默认开: 按 h1-h6 标题层级生成书签，
                          阅读器侧栏可跳转；front-matter: bookmarks: false）
      --no-merge-cells   关闭表格单元格合并语法（默认开，与 MPE 插件一致：
                          单元格只含 ^ 向上合并 rowspan、只含 > 向右合并
                          colspan、空单元格向左合并；front-matter:
                          merge-cells: false）
      --open              导出后打开产物 (默认不打开)
      --preset <name>     内置排版预设（详见 --help presets）
      --bg-pattern        保留 phycat 预设的背景图案层（网格/圆点；默认剥离，
                          打印更干净；也可用 front-matter bg-pattern: true 开启）
      --footer-label <text>
                          页脚左侧面包屑文本（预设 phycat 生效；
                          默认自动提取 front-matter title / 首个标题 / 文件名）
      --pagination / --pagination-level / --footer / --toc
                          分页四开关（仅 PDF，详见 --help pagination）
      --toc-level <h1|h2|h3>
                          目录收录级别（默认 h3；单独使用即蕴含 --toc）
      --toc-title <text>  目录页标题（默认「目录」）
      --cover <file>      封面：html / png / jpg / svg / pdf（仅 PDF，蕴含分页）。
                          插在最前：封面 → 目录页 → 正文。html 用 iframe 铺满
                          整页（适合 concept-map.html）；图则铺满 sheet。封面
                          无页脚，但计入总页数。front-matter: cover: <path>
      --pipeline          机器化完整流水线: 调度 scan-pdf-to-print-html 技能
                          （build → postprocess 分页 → Playwright 渲染）全自动出稿，
                          含分页 JS、封面注入、KaTeX、A4 fidelity。
                          与 --format pdf|html|png|both 连用（默认 pdf）
      --check             与 --pipeline 连用: 跑 fidelity 门禁 validator 并报告
      --screenshot        与 --pipeline 连用: 同时产出整页截图 PNG
      --keep-job          保留 pipeline 的 job 目录（默认临时目录用完删除）
      --job-dir <dir>     显式指定 job 目录（隐含 --keep-job）
      --python-cmd <cmd>  Python 命令（默认 py -3）
      --skill-scripts <dir>
                          技能脚本目录（默认自动定位 scan-pdf-to-print-html）
      --no-normalize      关闭 doc2x 前置规范化（默认开: **解析**→标题、
                          callout 题号行分离）
      --no-katex-local    关闭 KaTeX 本地化（默认开: 复制本地 katex 资源
                          改写 CDN 引用，离线渲染稳定）
  -j, --json              输出机器可读 JSON (agent/LLM 调用推荐)
  -q, --quiet             抑制进度日志
  -h, --help [主题]       使用说明书（无主题=完整手册；主题: options/presets/pagination/agent）
  -v, --version           显示版本

示例:
  mpe-export report.md --format pdf
  mpe-export 笔记.md --format both --offline --json
  mpe-export a.md b.md -f pdf -o ./out
  mpe-export 报告.md --pdf-json '{"format":"A4","margin":{"top":"15mm"}}' --json`,

  presets: `
排版预设（--preset <name>）:
  phycat      讲义/试题 A4 排版（源自 scan-pdf-to-print-html 技能）
  claude      Claude 主题风格·亮色（Typora claude-theme v19.7 提炼）
  claude-dark Claude 主题风格·暗色
  phycat-cherry / phycat-caramel / phycat-forest / phycat-mint /
  phycat-sky / phycat-prussian / phycat-sakura / phycat-mauve
              Phycat 主题配色变体·亮色（霞鹜文楷正文，Typora typora-theme-phycat 提炼）
  phycat-vampire / phycat-radiation / phycat-abyss
              Phycat 主题配色变体·暗色（monokai 代码高亮 + mermaid dark）
  last        沿用上次成功导出使用的预设

  mpe-export --preset list   列出全部预设（JSON，含 lastUsed 与分页开关说明）
  CLI 显式参数优先于预设。不指定预设 = 默认简洁样式。

  背景图案: phycat 变体的网格/圆点背景层默认剥离（打印不友好），
  加 --bg-pattern（或 front-matter bg-pattern: true）可保留。底色层始终保留
  （暗色变体的深色底不受影响）。`,

  pagination: `
分页 / 标题换页 / 页脚 / 目录页（仅 PDF；与预设正交，可组合；front-matter 同名键等价）:

  --pagination（front-matter: pagination: true）
    sheet 自动分页，替代 Chrome 原生分页：代码块 / 图片 / 引用块 / callout /
    表格能放进一页就绝不从中间切断；超页容器按子节点拆分兜底，
    尾部留白回填，孤儿标题自动清扫。

  --pagination-level <h1|h2|h3>（front-matter: pagination-level: h2）
    标题换页，单独使用即蕴含 --pagination。规则：
    "每个父章节内第一个该级标题不换页，其余该级标题各自起新页"，
    更高级标题出现时重置"第一个"资格。例（h3）：
      # 标题（不换页）
      ## 章节A（第一个 h2，不换页）  ### 小节A1（跟着章节A）  ### 小节A2（换页）
      ## 章节B（换页）  ### 小节B1（跟着章节B）  ### 小节B2（换页）
    h2 = 只让二级标题按此规则换页。注意：不支持"含第一个在内的所有标题
    都换页"——用户要这个语义时请明说做不到，不要硬用。

  --footer（front-matter: footer: true）
    在分页之上叠加页脚（蕴含 --pagination）：每页识别章节位置，
    左侧面包屑（当前章节橙色高亮，含 KaTeX 公式渲染）、右侧页码；
    9px 灰字 + 分隔线，数字/西文 Georgia、中文思源宋体（子集化内联）。

  --toc（front-matter: toc: true）
    在正文前插入目录页（蕴含 --pagination）：先按 sheet 排完正文得到
    真实页码，再生成目录（标题 + 点线 + 页码），条目过多自动续页。
    --toc-level <h1|h2|h3>（front-matter: toc-level: h2，默认 h3）
    单独使用即蕴含 --toc，控制收录到哪一级标题。
    --toc-title <text>（front-matter: toc-title）改目录页标题（默认「目录」）。
    「目录」本身进 PDF 书签但不二次收录进目录。与 --footer 可叠加：
    目录页页脚显示「目录」，正文页码含目录页占用。

  --cover <file>（front-matter: cover: path/to/concept-map.html）
    封面页插在最前（蕴含 --pagination）：封面 → 目录页 → 正文。
    html 用 iframe 铺满整张 A4（适合独立封面稿 concept-map.html）；
    png/jpg/svg 用 img 铺满。封面不加页脚，但计入总页数与目录页码。

  限制: PNG/JPEG 不支持分页模式，始终走引擎默认分页。
    --toc / --cover 仅 PDF。`,

  agent: `
Agent 使用手册
==============

决策流程（用户只说"打印/导出这份文档"时）:
  1. mpe-export --preset list       # 查看可用排版预设（JSON，含分页开关说明）
  2. 用户未指定风格时，先询问偏好: claude 亮色主题 / claude-dark 暗色 / phycat 讲义 / 默认简洁
  3. mpe-export <file> --preset <name> --format both --json
  4. 依据退出码判断成败: 0 成功 / 1 导出失败 / 2 参数错误;
     失败时 error 字段含具体原因和修正建议（如"可用预设列表""建议用绝对路径"）

意图映射（用户提到这些需求时叠加对应开关，仅 PDF，可组合）:
  "代码块/图片/引用块/callout 不要被换页切断" → --pagination
  "每一章/每一节从新的一页开始"             → --pagination-level h2（章）或 h3（节）
     注意语义: 每个父章节内第一个该级标题【不】换页（跟着父标题），
     其余才各自起新页；第一个二级标题永远不换页。用户要"所有章节标题都换页
     （含第一个）"时不要用此开关，应说明该语义不支持
  "要页码/页脚/每页显示当前章节"            → --footer（蕴含 --pagination）
  "要目录页/目录/table of contents"        → --toc（蕴含 --pagination；PDF 带真实页码）
     默认收录 h1–h3；用户说"只到章"时加 --toc-level h2；
     目录页标题默认「目录」，--toc-title 可改
  "封面/概念图/concept-map 作首页"         → --cover <html|png>（封面→目录→正文）

源文档块间空行规范化（默认自动，内存生效，不改源文件）:
  公式块/代码块/引用块/callout/HTML块/表格/分割线/标题/列表紧贴正文时
  自动补齐前后空行——这类缺失会让 $$ 块并进段落（= 行变 setext 标题、
  ^ 被上标吃掉）并在 Typora 中渲染失败。结果字段 normalized 报告补了几处；
  用户要"顺手把源文件也修了"时追加 --fix-md（留 .bak 备份）。

JSON 输出协议（--json，stdout 纯净可解析，日志走 stderr）:
  ok             整体是否成功
  files[]        每个文件: input / outputs{pdf,html,...} / preset / ok / error
                 / normalized（补了几处块间空行，0=源文档无需修复）
                 / sourceFixed（--fix-md 是否已写回源文件）
  hint           未指定预设时的风格建议（可主动转告用户）
  paginationHint PDF 且未用分页开关时的能力提示（用户抱怨切断/要页码时按此重导）
  manual         说明书入口（分主题查阅命令）
  批量导出时单个文件失败不中断，results 内逐个标记 ok/error

分主题说明书（按阶段查阅，减少上下文占用）:
  mpe-export --help options     全部选项详解
  mpe-export --help presets     排版预设与选择指引
  mpe-export --help pagination  分页 / 标题换页 / 页脚 / 目录页语义
  mpe-export --help agent       本手册`,
};

const HELP_HEADER = `
mpe-export —— 无头 Markdown 导出工具（HTML / PDF / PNG / JPEG）
引擎: crossnote（Markdown Preview Enhanced 的底层引擎），无需打开 VS Code 预览。

用法:
  mpe-export <file.md> [<file2.md> ...] [选项]

必选:
  <file.md>               一个或多个 markdown 文件路径（绝对或相对路径）

退出码: 0 成功 | 1 导出失败 | 2 参数错误
参数优先级（高 -> 低）: CLI 选项 > 文件 front-matter > .crossnote/ 目录配置 > 脚本默认值

分主题说明书（agent 按阶段查阅，减少上下文占用）:
  mpe-export --help options     全部选项详解
  mpe-export --help presets     排版预设与选择指引
  mpe-export --help pagination  分页 / 标题换页 / 页脚 / 目录页（仅 PDF）
  mpe-export --help agent       Agent 使用手册（决策流程 / 意图映射 / JSON 协议）`;

/**
 * @param {string} [topic] options | presets | pagination | agent；空 = 完整手册
 * @returns {string} 帮助文本
 */
function helpText(topic) {
  if (!topic) {
    return (
      HELP_HEADER +
      '\n' +
      HELP_TOPICS.map((t) => HELP_SECTIONS[t]).join('\n')
    ).trim();
  }
  if (HELP_SECTIONS[topic]) return (HELP_HEADER + '\n' + HELP_SECTIONS[topic]).trim();
  return `未知帮助主题: ${topic}（可选: ${HELP_TOPICS.join(' / ')}）\n` + HELP_HEADER.trim();
}

module.exports = { parseArgs, helpText, HELP_TOPICS };
