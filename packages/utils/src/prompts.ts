/**
 * Shared agent prompt fragments.
 *
 * Used by the API profile loader so every profile that opts in shares the same
 * rich-output rendering rules, and by the Bots engine (rich output + reply style).
 */

// ─── Reply style ─────────────────────────────────────────

/**
 * How a member-facing assistant writes: concise but proactive. One wording for
 * both conversation modes — the Bots engine's shared rules (S1) embed it, and
 * the Sprouty preset's `## Communication` repeats it verbatim (YAML cannot
 * import; `tests/api/profile.test.ts` keeps the two equal).
 */
export const REPLY_STYLE_RULE =
  'Lead with the answer or the result. No preamble, no restating the question, no closing recap or "let me know if you need anything". Short paragraphs; lists only for genuinely parallel items; progress updates in one line. Be proactive: when the next step is obvious, safe and within what was asked, just do it instead of asking; otherwise end with at most one concrete next-step offer (e.g. "Want it as a .docx?").';

// ─── Rich output rendering rules ─────────────────────────
//
// One section per block, composed per request: a client is taught only the
// blocks it declared it can draw (`rich_blocks` on POST /api/chat, spec
// docs/specs/20261008-rich-output-foundation.md). The keys mirror `ModelFence`
// in @greenhouse/types/rich-output (this package does not depend on types; a
// test holds the two lists together). Composition order is fixed so the
// default set reproduces the pre-capability guide byte for byte
// (__fixtures__/rich-output-guide.default.txt).

const RICH_INTRO_HEADING = `
## 富文本输出格式`;

/**
 * The opening line names only what this screen can actually draw: a screen
 * that declared `['mermaid']` (or nothing) must not be told charts and tables
 * work. With both chart and datatable taught it is the pre-capability wording,
 * which the golden fixture pins.
 */
function richIntro(taught: ReadonlySet<string>): string {
  if (taught.has('chart') && taught.has('datatable')) {
    return `${RICH_INTRO_HEADING}

前端支持在 Markdown 中嵌入特殊 code block 来渲染图表和数据表格。当内容适合可视化或交互呈现时，优先使用这些格式而非纯文本。`;
  }
  if (!Object.keys(RICH_BLOCK_GUIDES).some((block) => taught.has(block))) return RICH_INTRO_HEADING;
  return `${RICH_INTRO_HEADING}

前端支持在 Markdown 中嵌入下列特殊 code block 来渲染富内容。当内容适合可视化或交互呈现时，优先使用这些格式而非纯文本。`;
}

/** The how-to for each model-authored block, keyed by fence name. */
export const RICH_BLOCK_GUIDES: Readonly<Record<string, string>> = {
  chart: `### 图表（chart）
在回复中使用以下格式嵌入图表：
\`\`\`chart
{"type":"bar","title":"标题","labels":["A","B"],"datasets":[{"label":"系列","data":[10,20]}]}
\`\`\`
支持的图表类型：bar（柱状图）、line（折线图）、pie（饼图）、doughnut（环形图）、radar（雷达图）。`,
  datatable: `### 数据表格（datatable）
需要展示结构化数据时，使用 datatable 格式（支持排序和搜索）：
\`\`\`datatable
{"title":"标题","columns":[{"key":"name","label":"名称","type":"text"}],"rows":[{"name":"值"}]}
\`\`\`
列类型：text、number、currency、percent、boolean、badge。

使用场景：对比表格、搜索结果汇总、数据分析结果、统计报表。
纯文字说明不需要用这些格式，保持普通 Markdown 即可。`,
  stats: `### 指标卡（stats）
需要并列展示 2–8 个关键数字（概况、汇总、与上期对比）时用：
\`\`\`stats
{"title":"10 月概览","items":[{"label":"新增客户","value":128,"unit":"家","delta":"+12%","trend":"up","tone":"positive","hint":"较 9 月"}]}
\`\`\`
- value 是数字或很短的文字；delta 是变化量（如 "+12%"）；hint 是一句很短的注脚。
- trend（up / down / flat）只决定箭头方向；tone（positive / negative / neutral）决定颜色——
  涨不一定是好事（成本上涨是 negative），拿不准就不写 tone。
- 只有一个数字就直接写在正文里；按月、按周的时间序列用 chart。`,
  cards: `### 记录卡片（cards）
列出 3 条以上、每条都有状态或几个字段值得扫一眼的记录（项目、客户、文档、任务……）时用：
\`\`\`cards
{"title":"需要关注的项目","items":[{"title":"官网改版","url":"#/projects/42","subtitle":"负责人 张三","badges":[{"label":"延期 3 天","tone":"danger"}],"fields":[{"label":"截止","value":"10-15"}]}]}
\`\`\`
- url 只能用工具返回的原值（站内链接或 https 外链），没有就不写——绝不自己拼接或猜测。
- badges 最多 3 个（tone：neutral / primary / success / warning / danger / info），fields 最多 4 个，都是纯文本。
- 一两条记录、或者每条只有名字时，用普通列表。`,
  steps: `### 步骤 / 时间线（steps）
计划、进度汇报、按时间排列的历史（如跟进记录）用：
\`\`\`steps
{"title":"官网改版上线计划","items":[{"title":"需求评审","status":"done","time":"10-02","detail":"已确认范围"},{"title":"开发","status":"active","detail":"前端 60%"},{"title":"验收","status":"pending"}]}
\`\`\`
- status 只能是 done / active / pending / blocked / skipped；time 原样显示；detail 是一两句纯文本。
- 没有状态之分的操作说明，用普通有序列表。`,
  mermaid: `### 图示（mermaid）

需要表达**结构或流程**（而非数值）时，用 mermaid 代码块，前端会渲染成矢量图：
\`\`\`mermaid
flowchart LR
  A[下单] --> B{库存充足?}
  B -->|是| C[出库]
  B -->|否| D[补货]
\`\`\`
适用：流程图（flowchart）、时序图（sequenceDiagram）、状态机（stateDiagram-v2）、
类图/ER 图、甘特图。数值对比仍然用 chart，别用图示画柱状图。

- **节点控制在 20 个以内。** 再多就挤成一团，改用分层文字大纲或拆成几张图。
- 中文标签写在 \`[]\` / \`()\` 里即可；标签中若含 \`()\`、\`[]\`、引号等符号，用双引号包起来
  （\`A["下单(线上)"]\`），否则语法会被解析坏。
- 前端禁用了 mermaid 的点击/超链接指令（\`click\`、\`href\`），写了也不会生效，不要用。`,
  'html-preview': `### 网页预览（html-preview）

用户要「做个页面/原型/可交互的小工具」时，用 \`html-preview\` 代码块给出**完整单文件 HTML**，
前端会在右侧栏的隔离沙箱里渲染出来：
\`\`\`html-preview
<!doctype html><html><head><title>报价计算器</title><style>…</style></head>
<body>…<script>…</script></body></html>
\`\`\`

- **必须自包含**：CSS 与 JS 全部内联。页面被禁止访问外部 CDN，外链的样式/脚本一定加载不出来。
- **fence 名是 \`html-preview\`，不是 \`html\`。** 用户只是想看一段 HTML 源码时，
  照常用普通的 \`\`\`html 代码块——那不会变成预览卡。
- 沙箱里拿不到登录态，所以不要在页面里调用本站 API、读 cookie 或 localStorage；
  需要真实数据就把数据直接写进页面。
- 要改动时**整块重写**，不要发一个"补丁片段"让用户自己拼。`,
  confirm: `### 确认操作（confirm）
需要用户确认某个操作时，嵌入确认按钮：
\`\`\`confirm
{"text":"确认要执行此操作？","actions":[{"label":"确认","value":"confirm","variant":"primary"},{"label":"取消","value":"cancel","variant":"secondary"}]}
\`\`\`
仅在需要用户明确授权的操作前使用（如修改 Wiki、删除数据）。`,
};

/** Buttons under stats / cards / steps — taught once, when any of them is. */
const RICH_BLOCK_ACTIONS = `### 块按钮（actions）
stats、cards、steps 的 JSON 里可以带一个 \`actions\` 字段，和 \`items\` 并列（最多 4 个），显示在块的底部：
\`{"items":[…],"actions":[{"label":"按行业拆开","value":"把 10 月新增客户按行业拆开看"}]}\`
用户点了，value 会作为他的下一条消息原样发出。
- actions 只能写在块自己的 JSON 里；不要另开一个 actions 代码块——那只会显示成一段代码。
- value 写成用户会说的一句完整的话，不要写 "yes"、"confirm" 这种代号——它会出现在对话记录里。
- 只放真正可能的下一步，不要为了凑数加按钮。按钮不会直接执行任何操作，后续改动照常走工具与确认。
- stats / cards / steps 至少要有一项；没有内容就不要开块，绝不在答案末尾留一个空块。`;

/** Taught after html-preview when the screen declares `html-preview-bridge`. */
const RICH_HTML_BRIDGE = `### 网页预览里的回传按钮
这个界面上的网页预览可以调用 \`window.greenhouse?.sendPrompt(文字)\`，把一段文字放进用户的输入框——
用户确认后才会发送，页面自己不能替用户发消息：
- 用在「算完 / 选完还要继续问」的场景，比如报价计算器的「用这组参数生成报价单」；按钮文案写清楚是「放进输入框」。
- 传回的文字写成用户会说的一句完整请求（如「按以下参数生成报价单：3 台 × ¥4,200，含税」）。
- 一定写成 \`window.greenhouse?.sendPrompt(...)\`（带 \`?.\`）：下载到本地打开的文件里没有这个对象，页面照样要能用。`;

/** Rules that hold whatever the client can draw. */
const RICH_TASK_VARIABLES = `### 未填的任务变量

用户消息里如果出现 \`{{某个名字}}\` 这种双花括号占位符，那是一个**没填的任务变量**——
不要照字面理解，也不要自己编一个值。先用 \`ask_user\`（没有该工具时就直接提问）
把这些值问清楚，再开始执行任务。`;

const RICH_ENTITY_LINKS = `### 站内实体引用（链接）

提到具体记录（客户、联系人、商机、项目、知识库文档）时，用工具返回的 \`url\` 把它写成
Markdown 链接：\`[深圳某某科技](#/crm/companies/42)\`。用户点击后会就地浮出该记录的详情。

- **只能使用工具返回的 \`url\` 原值，绝不自己拼接或猜测链接。** 没拿到 url 就正常写名字——
  编造的链接和真链接长得一模一样，直到有人点开为止。
- 同一条记录在一段回答里链接一次即可（首次提到时），不要每次出现都重复链接。
- 链接是行文的一部分，不要在末尾另起一段罗列裸 URL。`;

/** Only meaningful when a JSON block (data written in one go) is taught. */
const RICH_BLOCK_DISCIPLINE = `### 富块写作纪律（硬约束）

这些 block 里放的是**一次写成的完整数据**，不是可以边写边改的草稿。前端逐块解析，
写坏的半成品会原样留在界面上：

- **数据没齐就不要开 fence。** 先把行查完、算完、数清楚，再开 \`\`\`datatable。
  只有 title 和 columns、没有 rows 的表格，用户看到的就是一张空表。
  chart 同理：datasets 没定下来就不要先写 labels。
- **开了就必须一次写完。** rows / datasets / actions 必须当场写全并闭合 fence。
  绝不允许写到一半改主意、留下一个空块，再另起一段用 Markdown 表格重答一遍——
  那样用户会在真正的答案上方多看到一张空表。
- **数据与预想不符就整块重写。** 发现条数、维度和计划的不一样时，不要在已经开头的块上
  打补丁或追加说明；把这张表完整地写一次，正文里只留最终版本。
- **拿不准就用普通 Markdown 表格。** 它永远是安全的。datatable 是给需要排序/搜索的
  成规模数据用的；三五行的对照、边说明边列举的场合，普通表格更合适。`;

/** Blocks whose payload is JSON written in one go — the discipline section applies to them. */
const JSON_BLOCKS = new Set(['chart', 'datatable', 'stats', 'cards', 'steps', 'confirm']);

/** Blocks that can carry buttons. */
const ACTION_BLOCKS = new Set(['stats', 'cards', 'steps']);

/**
 * Prompt order. Data blocks come first, then diagrams and pages; confirm is
 * last because it is about acting, not presenting.
 */
const GUIDE_ORDER = ['chart', 'datatable', 'stats', 'cards', 'steps', 'mermaid', 'html-preview'] as const;

/**
 * Compose the rich-output guide for the blocks a client can draw. Unknown names
 * are ignored; pass the server's admitted list (defaults applied by the caller).
 */
export function composeRichOutput(opts: { blocks: readonly string[] }): string {
  const taught = new Set(opts.blocks);
  const sections = [richIntro(taught)];
  for (const block of GUIDE_ORDER) {
    if (taught.has(block)) sections.push(RICH_BLOCK_GUIDES[block]!);
    if (block === 'steps' && [...taught].some((name) => ACTION_BLOCKS.has(name))) sections.push(RICH_BLOCK_ACTIONS);
    if (block === 'html-preview' && taught.has('html-preview') && taught.has('html-preview-bridge')) {
      sections.push(RICH_HTML_BRIDGE);
    }
  }
  sections.push(RICH_TASK_VARIABLES, RICH_ENTITY_LINKS);
  if ([...taught].some((block) => JSON_BLOCKS.has(block))) sections.push(RICH_BLOCK_DISCIPLINE);
  if (taught.has('confirm')) sections.push(RICH_BLOCK_GUIDES.confirm!);
  return sections.join('\n\n');
}
