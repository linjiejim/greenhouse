/**
 * Shared agent prompt fragments.
 *
 * Used by the API profile loader so every profile that opts in shares the same
 * rich-output rendering rules, narrowed to the blocks the requesting screen draws.
 */

// ─── Rich output rendering rules ─────────────────────────

// One section per block. A screen only draws some of them: a chat request names them in
// `rich_blocks` (packages/types rich-output `admitRichBlocks`; absent = DEFAULT_CLIENT_BLOCKS),
// and the guide offers the model exactly those — a block taught but not drawn would reach the
// member as a wall of JSON. The keys mirror `ModelFence` (this package does not depend on
// @greenhouse/types; a test holds the two lists together).

const RICH_INTRO = `
## 富文本输出格式

前端支持在 Markdown 中嵌入下列特殊 code block 来渲染富内容。当内容适合可视化或交互呈现时，优先使用这些格式而非纯文本。
下面列出的就是这块屏幕能画的全部富块；没列出的 fence 在这里只会显示成一段代码，不要用。`;

/** The how-to for each model-authored block, keyed by fence name, in prompt order. */
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
列出 3 条以上、每条都有状态或几个字段值得扫一眼的记录（项目、文档、任务……）时用：
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
  confirm: `### 确认操作（confirm）
需要用户确认某个操作时，嵌入确认按钮：
\`\`\`confirm
{"text":"确认要执行此操作？","actions":[{"label":"确认","value":"confirm","variant":"primary"},{"label":"取消","value":"cancel","variant":"secondary"}]}
\`\`\`
仅在需要用户明确授权的操作前使用（如修改 Wiki、删除数据）。`,
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
};

/** Buttons under stats / cards / steps — only when one of the three is offered. */
const RICH_BLOCK_ACTIONS = `### 块按钮（actions）
stats、cards、steps 的 JSON 里可以带一个 \`actions\` 字段，和 \`items\` 并列（最多 4 个），显示在块的底部：
\`{"items":[…],"actions":[{"label":"按行业拆开","value":"把 10 月新增客户按行业拆开看"}]}\`
用户点了，value 会作为他的下一条消息原样发出。
- actions 只能写在块自己的 JSON 里；不要另开一个 actions 代码块——那只会显示成一段代码。
- value 写成用户会说的一句完整的话，不要写 "yes"、"confirm" 这种代号——它会出现在对话记录里。
- 只放真正可能的下一步，不要为了凑数加按钮。按钮不会直接执行任何操作，后续改动照常走工具与确认。
- stats / cards / steps 至少要有一项；没有内容就不要开块，绝不在答案末尾留一个空块。`;

/** Rules that hold whatever the screen can draw. */
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

/** For the blocks whose data is JSON written in one go. */
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

/** When the screen draws no block at all: say so, so the model writes plain Markdown. */
const RICH_NONE = `
## 输出格式

这块屏幕只显示普通 Markdown（标题、列表、表格、链接、代码块），不渲染任何富块。数据就用 Markdown 表格。`;

/** Every block the guide can teach, in prompt order. */
export const RICH_GUIDE_BLOCKS: readonly string[] = Object.keys(RICH_BLOCK_GUIDES);

/** The blocks a request that declares nothing draws (mirrors DEFAULT_CLIENT_BLOCKS). */
const DEFAULT_GUIDE_BLOCKS: readonly string[] = ['chart', 'datatable', 'confirm', 'mermaid', 'html-preview'];

/**
 * Compose the rich-output guide for one screen.
 *
 * - `blocks`: the fences this screen draws (absent → the five every client drew before
 *   capabilities existed). Only these are taught.
 * - `confirm: false` drops the confirm block even when the screen could draw it (profiles that
 *   never ask before acting).
 */
export function composeRichOutput(opts: { confirm?: boolean; blocks?: readonly string[] } = {}): string {
  const drawn = new Set(opts.blocks ?? DEFAULT_GUIDE_BLOCKS);
  if (!opts.confirm) drawn.delete('confirm');
  const offered = RICH_GUIDE_BLOCKS.filter((name) => drawn.has(name));
  const shared = [RICH_TASK_VARIABLES, RICH_ENTITY_LINKS];
  if (offered.length === 0) return [RICH_NONE, ...shared].join('\n\n');
  // The button rules follow the last of stats / cards / steps on offer.
  const lastWithActions = offered.filter((name) => name === 'stats' || name === 'cards' || name === 'steps').pop();
  const parts = [RICH_INTRO];
  for (const name of offered) {
    parts.push(RICH_BLOCK_GUIDES[name]!);
    if (name === lastWithActions) parts.push(RICH_BLOCK_ACTIONS);
  }
  parts.push(...shared);
  if (offered.some((name) => name !== 'mermaid' && name !== 'html-preview')) parts.push(RICH_BLOCK_DISCIPLINE);
  return parts.join('\n\n');
}

/** The full guide (every block, confirm included) — what the web chat is taught. */
export const RICH_OUTPUT_GUIDE = composeRichOutput({ confirm: true, blocks: RICH_GUIDE_BLOCKS });
