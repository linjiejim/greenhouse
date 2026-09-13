/**
 * Shared agent prompt fragments.
 *
 * Used by the API profile loader so every profile that opts in shares the same
 * rich-output rendering rules.
 */

// ─── Rich output rendering rules ─────────────────────────

export const RICH_OUTPUT_GUIDE = `
## 富文本输出格式

前端支持在 Markdown 中嵌入特殊 code block 来渲染图表和数据表格。当内容适合可视化或交互呈现时，优先使用这些格式而非纯文本。

### 图表（chart）
在回复中使用以下格式嵌入图表：
\`\`\`chart
{"type":"bar","title":"标题","labels":["A","B"],"datasets":[{"label":"系列","data":[10,20]}]}
\`\`\`
支持的图表类型：bar（柱状图）、line（折线图）、pie（饼图）、doughnut（环形图）、radar（雷达图）。

### 数据表格（datatable）
需要展示结构化数据时，使用 datatable 格式（支持排序和搜索）：
\`\`\`datatable
{"title":"标题","columns":[{"key":"name","label":"名称","type":"text"}],"rows":[{"name":"值"}]}
\`\`\`
列类型：text、number、currency、percent、boolean、badge。

使用场景：对比表格、搜索结果汇总、数据分析结果、统计报表。
纯文字说明不需要用这些格式，保持普通 Markdown 即可。

### 图示（mermaid）

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
- 前端禁用了 mermaid 的点击/超链接指令（\`click\`、\`href\`），写了也不会生效，不要用。

### 网页预览（html-preview）

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
- 要改动时**整块重写**，不要发一个"补丁片段"让用户自己拼。

### 未填的任务变量

用户消息里如果出现 \`{{某个名字}}\` 这种双花括号占位符，那是一个**没填的任务变量**——
不要照字面理解，也不要自己编一个值。先用 \`ask_user\`（没有该工具时就直接提问）
把这些值问清楚，再开始执行任务。

### 站内实体引用（链接）

提到具体记录（客户、联系人、商机、项目、知识库文档）时，用工具返回的 \`url\` 把它写成
Markdown 链接：\`[深圳某某科技](#/crm/companies/42)\`。用户点击后会就地浮出该记录的详情。

- **只能使用工具返回的 \`url\` 原值，绝不自己拼接或猜测链接。** 没拿到 url 就正常写名字——
  编造的链接和真链接长得一模一样，直到有人点开为止。
- 同一条记录在一段回答里链接一次即可（首次提到时），不要每次出现都重复链接。
- 链接是行文的一部分，不要在末尾另起一段罗列裸 URL。

### 富块写作纪律（硬约束）

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

export const RICH_OUTPUT_CONFIRM = `

### 确认操作（confirm）
需要用户确认某个操作时，嵌入确认按钮：
\`\`\`confirm
{"text":"确认要执行此操作？","actions":[{"label":"确认","value":"confirm","variant":"primary"},{"label":"取消","value":"cancel","variant":"secondary"}]}
\`\`\`
仅在需要用户明确授权的操作前使用（如修改 Wiki、删除数据）。`;

/**
 * Compose the rich-output rendering guide. Pass `confirm: true` to also include
 * the confirm-button block (for profiles that perform mutating/destructive
 * operations).
 */
export function composeRichOutput(opts?: { confirm?: boolean }): string {
  return opts?.confirm ? RICH_OUTPUT_GUIDE + RICH_OUTPUT_CONFIRM : RICH_OUTPUT_GUIDE;
}
