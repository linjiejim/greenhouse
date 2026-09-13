## 前端规则

### 设计系统

**图标：Lucide React**
- 所有图标来自 [Lucide React](https://lucide.dev/)——**禁止用 emoji 当图标**
- 从 `lib/icons.ts` 统一导入（集中管理）
- 辅助函数：`getCategoryIcon()`、`getToolIcon()`、`getContextIcon()`
- 标准尺寸：`size={12}` 行内、`size={14}` 按钮、`size={16}` 导航、`size={20}` 标题

**Logo**
- 使用 `components/ui.tsx` 中的 `<AppLogo />`
- Logo 统一走 `AppLogo`（`components/ui.tsx`）：默认 `public/favicon.svg`，工作区品牌（Administration → Branding Studio）可覆盖产品名与 logo（`getRuntimeProductName()` / `getRuntimeLogo()`）；侧边栏展开态显示产品名 + 小字标语（`navigation.brandTagline`），收起态只显示 logo

> **CRUD 页面**统一用 `@greenhouse/crud`（`defineCrud` + `CrudPage`），约定见 [settings AGENTS](./pages/settings/AGENTS.md)。曾经并存的第二套只读 CRUD 框架 `components/dashboard/` 已随 dashboard UI 一起删除（2026-08-14）。

### UI 组件 (`components/ui.tsx`)
- 基础组件：Button、IconButton、ResizeHandle、Badge、Tag、TagList、Card、Input、Select、Textarea、Tabs、Dialog、ConfirmDialog、Drawer、Pagination、Spinner、Skeleton、SkeletonRow、SkeletonCard、StarRating、EmptyState、ErrorBoundary、AppLogo、ToastContainer、`toast()`
- 新增原子组件：SearchInput、Toggle、StatusDot、Checkbox、Avatar、DateRangeInput
- 表单布局组件 (`components/form/`)：`FormField`、`FormGrid`、`FormGroup`、`FormSection`、`FormActions`、`FormError`。业务表单只组合字段与领域值，不再各写 label/help/error/footer 间距；`FormField` 负责 `htmlFor`、`aria-describedby`、`aria-invalid`。
- Settings 分区 (`components/settings/`)：`SettingsPanel`（统一 `space-y-4`）与 `SettingsSection`（标题/说明/图标/操作/内容）；Settings 子页不得再各造卡片头与外层节奏。
- 模块页框 (`components/app/module-page.tsx`)：`ModulePageShell` 只拥有模块导航/viewport；所有非 Chat 的常规总览、集合与列表页由 `ModulePage` 从导航注册表派生身份，并统一 `actions → notice → tabs → toolbar → content`、`form/list/canvas` 宽度与滚动。当前覆盖 Settings/Administration、Tasks、Automation、My Agents、Tables 首页、Projects、Execution Center、SkillHub 入口、CRM 总览/列表和 Knowledge 三个公开集合；这些页面不得再自建外层 header、padding、max-width 或滚动容器。记录详情、整页编辑器、Project/Tables 数据工作区、SkillHub 技能详情等沉浸式页面继续使用 Detail/Canvas 专用结构，禁止为了形式统一套第二层页头。标题为紧凑单行，说明必须 `truncate + title`，避免操作区被长文案挤出。
- 详情页组件 (`components/detail/`)：`<DetailHeader>`、`<DetailSection>`、`<FieldGrid>`、`<Field>`——见下方「详情页规范」
- 列表分页：`<Pagination>` + `usePersistedPageSize`——见下方「列表分页规范」
- 标签：`<Tag>`（方角紧凑、单行）/`<TagList>`（多标签单行 +N）——见下方「标签 Tag 规范」
- **始终使用这些组件**，不要用原生 HTML + 内联 Tailwind
- 弹窗 → `<Dialog>` / `<ConfirmDialog>`，不要手写 `fixed inset-0`
- **Dialog vs Drawer 交互约定**：
  - 当前列表上下文内的创建/编辑 **CRUD 表单** → 居中 `<Dialog>`；中等字段量用 `size="lg"`，简单确认/单字段用 `sm`/`md`
  - 需要编辑、版本对比或呈现大量信息的密集型弹框 → `size="workspace"`，桌面默认占视口宽度 80%；移动端仍按安全边距满宽显示。历史、权限、批量编辑等场景不要退回 `md`/`lg` 挤压内容
  - 长文档、复杂多步骤或需要独立 URL/大量工作区的创建编辑 → 整页视图；这类页面不因“也是表单”而硬塞进 Dialog
  - 浏览类**详情/辅助面板**（任务详情、成员列表、活动流、只读预览、CRUD 工作区抽屉）→ 右侧 `<Drawer>`
  - Drawer 内触发创建/编辑时打开居中 Dialog，Drawer 保留为只读上下文；禁止把整套编辑表单直接切换进 Drawer（Project Task 是基准实现）
  - Drawer 背景只压暗**不加 backdrop-blur**（保持页面上下文可读）；Dialog 背景保留 blur
  - 定时排程不要让用户裸写 cron——用频率+时间的可视化构建器（见 `pages/settings/automations.tsx` 的 buildCron/parseCron），cron 表达式仅作高级逃生口
- **弹层底座 `<OverlayFrame>`（`components/overlay-frame.tsx`）是安全区、高度上限、遮罩、Escape/滚动锁/焦点恢复、关闭动画的唯一实现**。`Dialog`/`ConfirmDialog`/`ActionConfirmDialog` 都是它的 variant（`center`/`alert`），调用方用的仍是原来的组件签名。新增弹层一律经底座接入，**不要**再手写 `fixed inset-0` + backdrop + `env(safe-area-inset-*)` + 高度上限那一套；需要新形态就给底座加 variant。`Drawer`/`OverlayPanel` 是第二批（当前行为正确，等第一批在 dev 跑过一个版本再切，见 [spec](../../../docs/specs/20260801-overlay-foundation-and-history-modal-split.md) D2）
- 浮层面板 → `<OverlayPanel>`（`components/app/overlay-panel.tsx`），不要手写 backdrop + fixed inset-0
  - `variant="side"`（右侧面板）或 `variant="bottom"`（底部抽屉）
- 表单输入 → `<Input>`、`<Select>`、`<Textarea>`，不要用原生 `<input>`、`<select>`、`<textarea>`
- 搜索框 → `<SearchInput>`，不要手写 Search icon + Input 组合
- 纯图标操作 → `<IconButton label="…">`，移动端自动提供 44px 命中区与可访问名称
- 可拖拽分栏 → `<ResizeHandle>`，不要手写 mousemove/mouseup；统一支持 Pointer Events、方向键、Home/End 与双击复位
- 复选框 → `<Checkbox>`，不要用原生 `<input type="checkbox">`
- 开关 → `<Toggle>`，不要手写 role="switch" + translate-x 动画
- 日期范围 → `<DateRangeInput>`，不要手写 From/To 两个 date input
- 用户头像 → `<Avatar>`，不要手写 rounded-full + 首字母 + flex center
- 状态指示点 → `<StatusDot>`，不要手写 w-2 h-2 rounded-full bg-xxx
- 通知 → `toast(message, variant)`——禁止 `alert()` 或 `window.confirm()`
- 确认 → `<ConfirmDialog>` 配合 state——禁止 `window.confirm()`
- 加载 → `<Skeleton>` / `<SkeletonRow>` / `<SkeletonCard>` 用于布局占位；`<Spinner>` 用于行内指示
- 错误边界 → `<ErrorBoundary>` 包裹可能出错的子树
- `<AppLogo>` 支持 `size`（`sm|md|lg|xl`）、`showVersion`、`showAttribution`、`logoOnly` prop——禁止在业务组件直接引用 Logo 文件
- `<Input>` / `<Select>` 支持 `size` prop（`xs` | `sm` | `md` | `lg`），**禁止用 `!important` 覆盖 padding/font-size**

- `<Select>` 支持 `inline` prop（`w-auto` 而非 `w-full`），用于行内筛选器场景

### 缺省状态规范

- 有“图标 + 标题 + 说明 + 下一步”语义的状态统一使用 `<EmptyState>`，禁止在页面外层手写 `flex + justify-center + py-*` 复制结构。
- `variant="section"`（默认）用于列表/搜索/主要内容区，视觉基线是 Automations；`page` 仅用于路由级 not-found/unavailable/Error Boundary；`compact` 用于 Dialog、Drawer 与密集卡片。
- 图标必须来自 `lib/icons.ts`，`EmptyState` 不接受 string/emoji；普通为空用 `primary`，筛选/弹层用 `neutral`，没有待办/已最新用 `success`，不可用/失败用 `danger`。
- action 是可选的唯一下一步：页头/工具栏已有常驻主操作时不要在空状态重复；只有唯一入口或返回/重试恢复动作才传 `action`。禁止 `<EmptyState />` 后另拼居中 `<Button>`。
- 表格单元格、KPI 子卡、侧栏树、下拉项、表单“暂无可选项”保留 `—` 或一行弱提示；这些是密集占位，不扩成大块缺省态。
- 首次加载用 Skeleton/Spinner；失败不能伪装成空数据；筛选无匹配使用 `neutral` 并告诉用户如何调整。完整决策见 [空状态收敛 spec](../../../docs/specs/20260812-empty-state-convergence.md)。

### 数据展示组件 (`components/blocks/`)
- `<DataTableBlock>` — 可排序、可搜索、可把当前筛选/排序后的可见行导出 CSV 的数据表格，支持 text/number/currency/percent/boolean/badge 列类型
- `<ChartBlock>` — 聊天富块默认保留固定阅读高度；工作台/仪表盘等已有明确父容器高度的场景传 `fill`，让 canvas 随卡片缩放，禁止在外层再用固定 px 高度覆盖。
- `<FileAttachmentCard>` — 文件附件统一展示；EditorJS attachment 与 Chat file artifact 共用，鉴权下载统一走 `lib/file-download.ts`
- `<ConfirmBlock>` — 行内确认按钮组，用于 Agent 交互
- `<HtmlPreviewBlock>` — ```html-preview fence 的消息流卡片（标题 + 「打开预览」+ 可折叠源码），真正渲染在右侧分栏的 `side-pane/html-preview.tsx`。**fence 名是 `html-preview` 不是 `html`**：后者是所有人展示 HTML 源码时写的，抢了它就会把「给我一段能复制的代码」变成不可复制的预览卡。**沙箱口径是承重的**：`<iframe srcdoc sandbox="allow-scripts">` 且**绝不加 `allow-same-origin`**——两者同时给等于完全没有 sandbox，文档就能读本页 localStorage 里的 token。不用 `blob:` URL、不给「新窗口打开」，理由与 `attachments-block.tsx` 拒绝预览 HTML 的注释完全一样（blob 继承本页 origin）。回归护栏 `side-pane/html-preview.render.test.tsx` 逐条断言这些属性
- `<MermaidBlock>` — ```mermaid fence 渲染成矢量图（流程/时序/状态/ER/甘特）。三条硬约束：**`mermaid` 只在首个图示出现时 `import('mermaid')`**（它是全仓最重的前端依赖，主 bundle 不为没用到的人付费，形状同 ChartBlock 的 chart.js）；**`securityLevel: 'strict'`**——图源是模型输出即不可信输入，strict 关掉 `click`/`href` 指令，图不会变成导航或脚本面；**解析失败回退成普通代码块**而不是空卡片——模型确实会写错语法，让用户看到它想画什么比看到一片空白强。主题色从 `--t-*` CSS 变量读进 `themeVariables`，`data-theme` 变化时**重渲染**（SVG 里的颜色是烤死的，改样式没用）。数值对比仍走 `<ChartBlock>`，别用图示画柱状图
- `<MissionArtifactsBlock>` — Mission 产物文件卡（```mission-artifacts fence，服务端写入的交付清单）；复用 `<FileAttachmentCard>`，下载走 canonical `/api/missions/.../download` 鉴权端点（旧 `/api/cloud-agent` 仅兼容）
- `<AttachmentsBlock>` — 用户**输入**附件药丸（```attachments fence；```mission-attachments 是历史名，只读不再写）。刻意比产物卡轻：输入是「用户问了什么」的上下文，产物才是交付物，所以药丸渲染在用户气泡内、正文与时间戳之间。用户消息**不过 `parseSegments`**，只用 `splitAttachments()` 摘出这一种 fence。两种 handle：`id`=`chat_files` 行、`key`=mission 暂存 blob，各自走对应鉴权下载端点。图片/PDF 预览必须同时满足扩展名与响应 MIME allowlist（图片不含 SVG，PDF 仅 `application/pdf`）；文件名伪装成 png/pdf 但响应是 `text/html` 时拒绝预览。其它类型只下载。
- 以上组件可独立使用，也可通过 `<RichMarkdown>` 自动解析 code fence 渲染

### Markdown 渲染
- `<Markdown>` (`components/markdown.tsx`) — 基础 Markdown 渲染，支持 `compact` prop
  - 默认使用 `prose-base` 样式（宽松，适用于 wiki/文档）
  - `compact` 时使用 `prose-compact` 样式（紧凑，适用于聊天/Agent 消息）
- `<RichMarkdown>` (`components/rich-markdown.tsx`) — `<Markdown>` 的组合增强层，自动解析 chart/datatable/confirm/mermaid/mission-artifacts code fence 为交互组件；普通 Markdown 仍由 `<Markdown>` 渲染。外层始终是 `.rich-markdown`，`className` 始终落在该外层；`compact` 必须同时控制 prose、富块外壳和块间距，禁止只压缩文本。
- 流式内容一旦识别到未闭合的 `datatable` fence，必须立即隐藏原始 JSON 并渲染稳定表格占位；闭合且解析成功后原位替换成 `<DataTableBlock>`，禁止先泄露整段 code block 再跳变。
- **富块的数据是模型写的，「能 JSON.parse」不等于「能渲染」**：`blocks/index.ts` 的 `parseBlockData()` 是唯一的把关处，逐块校验必备字段（datatable 要求 columns 是带 string `key` 的对象数组、`rows` 缺失/非数组一律归一成 `[]`；chart 要求 type 在白名单内且 datasets 都带 `data` 数组；confirm 要求 text 是字符串且 actions 非空），不合格的整块退回普通 code block。**不要把校验挪进组件**——组件里抛异常发生在 render 阶段，会连带卸载整条消息树：20260730 一个「模型写了 columns 就改主意、没写 rows」的回答让会话 c0b6bf83 直接打不开（`rows.length` 抛 TypeError）。`rich-markdown.tsx` 里每个富块还各自套一层 `<ErrorBoundary>`，兜住没预料到的形状（chart.js 构造抛错等），代价是那一块显示 `common.blockRenderFailed`、其余照常。渲染端只保证「不崩」——空表仍然会挂在真答案上方，所以**写作侧的规则同样是必需的**：「行数据没齐不开 fence、开了必须一次写完」写在共享的 `RICH_OUTPUT_GUIDE`（`packages/utils/src/prompts.ts`，见 `apps/api/src/profiles/agent-profiles.md` 的富文本输出一节）。两边都要有，别指望单靠一侧。
- Chart/DataTable/Confirm 共用 `blocks/rich-block-shell.tsx` 的边框、表面、标题栏和 base/compact 密度；各块只保留画布、排序筛选、确认状态等自身行为，不得各写一套外壳或 `my-*` 外边距。
- 聊天/Agent 场景用 `<RichMarkdown compact />`，wiki/详情页用 `<Markdown>`
- **正文里的链接分三类，判据全在 `sanitizeMarkdownNode`**：① **实体引用**（`parseEntityUrl` 认得的记录深链，如 `#/projects/42`）→ 打 `entity-link` class + `data-entity-kind`/`data-entity-label`，点击被 `handleClick` 拦成 peek 浮层、**不导航**；② `user:<id>` mention → 既有 `kb-mention` 惰性 chip；③ 其余普通链接 → 按 `linkTarget` 决定原位导航还是新窗口。**`href` 是「这是哪条记录」的唯一真源**，data 属性只做标记和显示标签——别改成从属性里读 id，那是第二份事实。模型偶尔会漏掉 `#`（写成 `/projects/42`），renderer 会补回来；不补的话它会被当外链新开一个 hash router 不认识的地址。
- **`linkTarget="new-window"` 是聊天面的规则，不是组件默认值**：聊天记录是「用户所在的地方」，跟个链接就把会话弄丢了。所有聊天渲染点（`chat/message.tsx` 两处、`streaming-message-bubble`、`user-message-content`、`ask-user-card`）都显式传它；知识库正文等其它面保持原位导航。新增聊天渲染点忘了传只是退化成原位导航，不是 bug——但记得传。
- **Chat 右侧分栏（`components/side-pane/`）与实体 peek 是两件事，刻意并存**（[spec](../../../docs/specs/20260808-chat-side-pane.md) D2）：peek 是 `Drawer`（`fixed inset-0` 遮罩），打开就没法继续对话；分栏是**文档流内**的第二列，composer 一直活着——「边聊边改」只有后者做得到。所以 Chat 页点实体链接开分栏，**其它页面照旧开 peek**。判据是 `isSidePaneAvailable()`（store 里的 `hostMounted`），不是路由——同一个 markdown 点击委托因此对两种宿主都成立，且 Assistant overlay（没有分栏宿主）不会打开一个没人渲染的 pane。
  - **`<Drawer>` 不能当分栏底座**：它是 `fixed inset-0` 全屏遮罩层，不在文档流里。分栏用 `<ResizeHandle direction={-1}>` + `<aside>` 自己搭，宽度进 localStorage、`lg` 以下退化成全屏覆盖层。
  - **加一种预览能力 = `SidePaneEntry` 加一个成员 + `side-pane/registry.tsx` 加一个 case**，调用方（markdown 链接、artifact 卡、lightbox 按钮）只说「打开这个」。records 复用 entity-peek 的组件表，不是第二套详情组件。
  - **只有 entity 入栈，预览是替换**：「看另一张图」是切换不是下钻，一摞 HTML 预览的返回栈没人要。
  - **图片批注（`side-pane/image-annotator.tsx`）**：lightbox 的「批注修改」→ 分栏里画圈/框/箭头/自由笔/文字 → 合成 PNG 上传 → 经 `lib/composer-draft.ts` 把**双图 + 可编辑文案**填进 composer（原图在前作底、批注图在后作空间参考；只传批注图会把红圈烤进结果）。三条约束：**坐标全存图片自身像素**（overlay 按 pane 宽显示、导出按原分辨率，存屏幕坐标必错位）；**换算按 `object-contain` 的适配尺寸**而不是元素尺寸（否则整体偏移一个留白带的距离）；**`setPointerCapture` 必须 try/catch**（pointer 失效时它抛 `NotFoundError`，而它在 `pointerdown` 头部，异常会让整笔画根本不开始）。草稿**只填不发**——画错一个圈不该等于一次真金白银的生图。见 [spec](../../../docs/specs/20260808-image-annotation-editing.md)
  - **对话式编辑的实时刷新走 `lib/entity-sync.ts`**：SessionManager 在 `project_mutation`/`knowledge_mutation`/… 的 tool result 到达时按**域**广播（不是记录 id——mutation 工具不上报改了哪一行，在这里编一个 id 等于在最该刷新的时候静默失效），分栏把它折进 `bodyKey` 触发重挂载重取。形状抄 `onWorkbenchChanged`。
- **实体 peek（`components/entity-peek/`）**：右侧 Drawer + 栈（`stores/entity-peek-store.ts`），直接复用既有详情组件（CRM 三个 + Projects + KB 适配器），**不用 iframe**。URL 不变、不进浏览器历史——peek 是「看一眼」，要固定地址就按头部的「在完整页面打开」。详情组件里两处只在整页成立的行为（返回列表按钮、跨记录 `window.location.hash` 跳转）经 `useInEntityPeek()` / `useEntityNavigate()` 分流：在 peek 里前者隐藏、后者压栈。新增可 peek 的实体 = 在 `@greenhouse/types/entity-links` 加 kind + 在 `entity-peek/registry.tsx` 加一行，别在调用侧写 if。方案见 [spec](../../../docs/specs/20260804-entity-references-and-peek.md)。
- 两套 prose 的正文继承全站 `Nunito Sans`，标题沿用全局 display family，颜色只用语义 token：正文常规字重、强调/标题最高 `font-semibold`；`prose-base` 用文档级层级与宽松行距，`prose-compact` 保持 `text-sm` 与紧凑节奏。Markdown 表格必须保留原生 table layout，由 `.md-table-shell > .md-table-scroll` 负责工具栏与横向滚动，禁止再给 `<table>` 本身加 `display:block`；工具栏的 CSV 导出、全屏与复制统一为 icon-only + tooltip，复制为可直接粘贴到 Sheets/Excel 的 TSV。CSV/TSV 都收敛在共享 `lib/csv-export.ts`，不得各写一套表格序列化。
- **图片**：任何 prose 里的 `<img>` 点击都开 lightbox（`markdown.tsx` 上的委托点击，故 CSS 给了 `cursor: zoom-in`）。`compact` 时额外跑 `groupImageRuns()`：连续的「只含图片的段落」合并成一个 `div.md-image-row` flex 行，缩略图**固定 260px 宽**——1:1 的生成图原来会撑满整条消息列。marked 开了 `breaks: true`，所以「空行分隔」得到多个 `<p>`、「单换行分隔」得到一个带 `<br>` 的 `<p>`，两种都要归并（否则 DOM 形状取决于作者怎么敲空行）。**只在 compact 生效**，文档页要的是全宽阅读尺寸；CSS 也必须整段挂在 `.prose-compact` 下。
- `generate_image` 进入 calling 且尚无 output 时，`BodyArtifacts` 立即渲染与最终缩略图同宽的 1:1 Skeleton；成功后原位换成图片，失败仍回到工具轨迹展示错误。不要用只有文字/Spinner 的等待态——高耗时生图需要稳定占住最终布局。
- ⚠️ 宽度上限必须挂在 **`.prose-compact img` 自己**身上，不能只挂在 `.md-image-row` 上：流式过程中 `breaks: true` 会把 `![img](url)\n**文字**` 先解析成**一个**段落（img + `<br>` + 文字），要等第二个换行到达才拆开——那一刻它不是「只含图片的段落」，进不了 image-row。宽度若只由行容器给，图片会先按 `max-w-full` 撑到 ~890px 再跳回 260px，每次生图都闪一下（20260728 实测复现）。行容器现在只管布局。

### 设计系统预览页
- 访问路径：`#/design`（不在导航栏显示，仅直接 URL 访问）
- 文件：`pages/design.tsx`（lazy-loaded，不影响主包体积）
- 覆盖所有共享组件：颜色 token、字体、间距、Button、Badge、Tag、TagList、Pagination、Input、FormField/FormGrid/FormActions、SettingsSection、ModulePage、Card、Tabs、Dialog、Drawer、详情 kit（DetailHeader/DetailSection/FieldGrid/Field）、Toast、Spinner、Skeleton、EmptyState、StarRating、DataTableBlock、ChartBlock、ConfirmBlock、Markdown、RichMarkdown、ErrorBoundary、AppLogo
- 新增共享组件时同步更新此页面

### 组件目录 (`components/`)
```
components/
├── ui.tsx              # 原子级基础组件（全项目复用）
├── form/               # 可访问表单结构：字段、网格、分组、区段、操作、错误
├── settings/           # Settings 页面统一 Panel / Section
├── blocks/             # 数据展示：DataTableBlock、ChartBlock、ConfirmBlock
├── app/                # 应用外壳与模块页框：LoginScreen、AppSidebar、TopBar、ModulePageShell、ModulePage
├── project/            # 项目管理：TaskTree、BoardColumn、GanttView、TaskDrawer、CreateTaskDialog
├── agent-panel/        # Agent 助手面板
├── chat/               # 聊天：消息气泡、输入框、profile 选择器、流式消息、标注
├── agent-context.tsx   # 全局上下文 Provider
├── markdown.tsx        # 共享 Markdown 渲染器
├── rich-markdown.tsx   # 增强版 Markdown（解析 chart/datatable/confirm code fence）
└── pdf-export.tsx      # PDF 导出工具

stores/
├── index.ts            # Barrel export
├── auth-store.ts       # 认证状态 (Zustand)
├── platform-store.ts   # 权限感知应用 Catalog 与工作台偏好
└── ui-store.ts         # UI 状态 (Zustand)
```
- 新功能？在 `components/` 下创建子目录并配 barrel `index.ts`
- 每个组件文件保持专注（建议 < 300 行）

### 共享工具函数 (`lib/utils.ts`)
- `safeParse(json, fallback)`、`relativeTime()`、`timeAgo()`、`formatDate()`、`formatDay()`、`formatTokens()`
- 日期粒度：带时刻的时间戳用 `formatDate()`；**日历粒度字段**（注册日、出库日、跟进到期日、表格里的创建日）用 `formatDay()`——`formatDate()` 会拖出一串 "12:00 AM" 噪音并占掉表格列宽
- `roleBadgeStyles`——角色徽章样式，禁止在组件中重复定义
- `CHART_PALETTE` / `BADGE_PALETTE`——数据可视化配色，禁止在组件中硬编码色板；图表默认使用克制的品牌 品牌绿阶，不恢复彩虹式特殊色板
- **禁止在组件文件中重复实现**

### 服务端下发文案的本地化 (`lib/i18n`)

- 所有用户可见的固定文案（包括 JSX 文本、placeholder/title/aria-label、toast、空状态和确认框）必须走
  `useT()`；禁止在组件里直接写死英文或中文。React 外的原生桥接、注册表与命令式反馈使用
  `translate(locale, key)`，locale 从调用上下文或 `getStoredLocale()` 取得。
- 导航注册表保存稳定的英文元数据供非 UI 消费；渲染和面包屑统一通过 `localizeNavModule()` / `resolveSubModule(..., t)`
  取当前语言，不能在各侧边栏另建翻译表。
- `lib/i18n/localized.test.ts` 是语言包结构门禁：所有 locale 必须键集合一致、插值占位符一致且没有空翻译。
- `lib/i18n/visible-copy.test.ts` 是源码门禁：production TSX 新增固定英文 JSX、placeholder/title/aria-label/label 会直接失败；只豁免品牌名、协议/单位与明确示例值。不要扩大正则豁免来掩盖真实 UI 文案。
- 界面固定文案走 `useT()` + `en.ts`/`zh.ts`；**服务端下发的展示文案**（系统 profile 的 `name`/`description`）
  走另一条路：后端同时下发扁平字段和 `*_i18n` 语言映射，前端用 `useLocalized()` / `pickLocalized()` 取值，
  回退链 **当前 locale → `zh` → 扁平字段**。
- **不要直接渲染 `profile.name` / `profile.description`**——那永远是中文源语言值。渲染前过一次 `localized()`，
  `title` tooltip 也要用同一个结果。
- 用户自建的自定义 profile 没有语言映射（是用户自己填的自由文本），回退链会自动落到扁平字段——这是刻意的，
  不要为了"补全"去翻译用户内容。
- 新增服务端文案字段时，i18n 映射由 profile YAML 声明，约定见
  [agent-profiles.md](../../api/src/profiles/agent-profiles.md)。

### 全局状态管理 (Zustand)
- 全局状态统一使用 Zustand store，存放在 `stores/` 目录
- `useAuthStore` — 认证状态、当前用户、登录/登出
- `useUIStore` — 导航抽屉、个人资料面板、偏好设置弹窗
- `usePlatformStore` / `usePlatformCatalog` — 服务端可见应用 Catalog、工作台偏好和派生导航；只能缓存/展示，不能在前端扩大权限
- 页面级/功能级状态可以用 `useState`/`useReducer`
- **禁止为全局状态新建 React Context**——统一用 Zustand store
- 现有 Context（`AgentContext`、`SessionManagerContext`、`I18nContext`）保留使用，但新功能优先用 store

### Platform 应用导航

- `platform/catalog.ts` 只放类型、排序/筛选和显式 host route/icon 映射，不发请求、不持有 React 状态。
- 桌面侧栏、移动导航抽屉和首页工作台的导航卡必须消费 `usePlatformCatalog()`；服务端 Catalog 仍是应用可见性的唯一真源。
- 左侧栏 Logo 行依次承载全局搜索、Global Agent 与折叠控制；折叠控制必须使用明确的侧栏开/关图标，禁止使用会被误认成页面返回的裸 Chevron。普通应用不再显示冗余 Back，直接用常驻 `Chat`/`New Chat` 返回；Settings / Administration 作为专用覆盖工作区，仍保留返回进入前页面的语义。移动导航抽屉同步遵循这一规则。
- 常驻主导航位于侧栏 `New Chat` 下方，顺序 `Chat → Knowledge → Projects → Tables → More`，桌面/移动端统一由 `platform/navigation.ts` + `components/app/sidebar-global-navigation.tsx` 构建。Automation、`My Prompts`、`My Agents`、SkillHub 与超出常驻集的应用收进 `More`：桌面悬浮或点击后向右展开，移动端点击后原位展开。Automation、Prompt Tasks、My Agents 分别使用独立地址 `#/automations`、`#/tasks`、`#/agents`；历史 `#/chat?view=...` 只作重定向兼容。Chat 是 Mission 等工作的主要发起面；账户浮层中紧跟 Inbox 的「执行中心」是唯一持久执行入口，使用 `#/executions` / `#/executions/:kind/:id` 聚合 Mission / Workflow / Automation / Subagent，并默认展示进行中。Mission 不再拥有独立列表页或 More 入口；旧 `#/missions`、`#/cloud-agent`、`#/task-center` 和 Runtime `#/tasks/:kind/:id` 只作重定向兼容。Mission 详情继续读取领域事实，Runtime 诊断作为二级视图，避免异步镜像短暂延迟造成假 404。**没有 Home tab**——首页就是 Chat 新会话空态（个人工作台在那里渲染），`#/workbench` 与 `#/home` 都重写到 `#/chat`。右侧不再渲染独立一级 Tab 条，只保留页面/会话上下文 `TopBar`。
- 执行中心详情的「复制为评测用例」仅 super 可见：先拉完整 Runtime/Eval/会话证据预览，敏感路径只提示不静默改写，问题、ground truth、预期行为、标签和备注均可编辑；只有显式提交才创建 Dataset，提交期间禁用按钮并复用同一个 idempotency key，成功统一深链 `#/administration/eval/datasets`。
- 只有拥有专用 Web 页面且已显式登记 host route 的应用生成浏览器链接；其余应用显示为 Agent/MCP-only。
- 直接访问应用 URL 时也要等待 Catalog 并 fail closed；后端 Registry/Entity Policy 仍是安全边界。

### 构建与开发模式（Vite，2026-06 起）

- **构建工具 = Vite**（`apps/web/vite.config.ts`）：`@vitejs/plugin-react`（Fast Refresh）+ `@tailwindcss/vite`。入口 HTML 是 `apps/web/index.html`（Vite root），`<script src="/src/app.tsx">`；CSS 由 `app.tsx` 里 `import './app.css'` 引入，**不要**在 index.html 写 `<link>`。
- **Dev**：`pnpm dev` = Vite dev server `:3100`（HMR）+ api `:3101`。Vite 把 `/api`(含 ws)、`/public`、`/health` 代理到 api，浏览器视角同源——**dev 打开 `:3100`**。改 `.tsx` 即时热更新，无需手动重建（对比旧 esbuild --watch 的痛点）。后端改动仍要重启（api 无 --watch）。
- **生产**：`pnpm web:build` = `vite build` → hash 产物进**仓库根 `public/`**，由 API 在 `/` 和 `/assets/*` 提供。关键约束：
  - `base: './'`——产物使用相对资源路径，保持静态托管与 hash router 兼容。
  - `emptyOutDir: false` + 构建前运行 `scripts/clean-web-output.mjs`——清空仓库根 `public/` 里上一次构建的产物（该目录不入库；静态资源来自 `apps/web/public/`）
  - source map 默认关闭；只有明确需要受控调试时才以 `WEB_BUILD_SOURCEMAP=true pnpm web:build` 临时启用，公开 `/assets` 不应常态暴露源码。
  - 新增/重命名 bundle 资产路径（`/assets/*`）后，必须同步 `apps/api/src/auth/middleware.ts` 的 `isPublicPath` 放行 + `apps/api/src/index.ts` 的 serveStatic 映射，否则资产被 auth 拦成 401。
- **运行时静态资产**（logo 等，非 bundle）：统一用 `lib/api-base.ts` 的 `publicAssetUrl('xxx.jpg')`，不要在组件里硬编码 `/public/...`。

### 代码分割 (Code Splitting)
- 使用 `React.lazy` + `Suspense` 对路由页面做懒加载
- `ChatPage` 为即时加载（高频访问），其他页面均为懒加载
- Vite 自动按动态 `import()` 切分 chunk，输出 hash 文件名到 `public/assets/`
- 新增路由页面必须使用 `lazy(() => import('./pages/xxx'))` 模式
- `#/activate?token=...` 是唯一登录前业务页：token 从 fragment 捕获到组件内存后必须立即 `history.replaceState` 清除，再用公共 POST inspect；只有 complete 成功才保存正常会话并去 `#/chat`。不得把 token 放进 query-based HTTP API、localStorage/sessionStorage、日志或分析事件，也不得把它扩成 Magic Link/公共忘记密码。

### API 调用
- **首选 hc 类型化调用**（2026-06 起）：领域模块在 `lib/api/<domain>.ts`，统一经 `lib/api/client.ts` 的 `rpc`（`hc<AppType>` over authFetch，自动 Bearer + 401 刷新）。响应类型由服务端实现推导，与声明类型的冲突=编译期漂移告警，**禁止用 `as` 压掉**
- hc 约定（详见 `lib/api/client.ts` 头注释 + `lib/api/profiles.ts` 示范）：无 validator 路由传 json/query 用**变量间接**（`const args = {param, json}; rpc...$put(args)`）；param 值含 `/` 或 `%` 时显式 `encodeURIComponent`（hc 不编码）；流式（NDJSON）与 FormData 端点保持 raw `authFetch`（`lib/api/chat.ts`、`lib/api/upload.ts`）
- 旧直连写法仅限流式/上传：`lib/auth.ts` 的 `authFetch()`——自动处理 token 和 401 跳转
- 历史遗留 `lib/*-api.ts` 模块用 `lib/http.ts` 的 `fetchJson<T>()`——新代码不要再用，迁到 `lib/api/` + rpc
- 复制操作必须 `await navigator.clipboard.writeText()` 并处理失败；需反馈时使用 `toast()`。

### 流式事件处理 (`lib/stream-events.ts` + `lib/stream-utils.ts`)
- NDJSON 流解析统一使用 `readNdjsonStream<T>()`——不要手写 `reader.read()` + `TextDecoder` 循环
- Chat 在通用 NDJSON 解析外必须再经过 `requireChatStreamFinish()`：只有显式收到 `finish` 才算成功；EOF 或 `error` 一律进入失败态。失败响应关闭后先重载服务端已持久化的安全部分消息，再清流式 overlay，禁止把半截 DataTable 当成功或刷新后整轮消失。
- **Chat 流消费只有一个入口**：`SessionManager` 的 `runStream()`——POST 起流与 `GET /api/chat/runs/:id/stream` 重连共用同一事件处理体。传输层断流（非 AbortError、非服务端 `error` 事件）先探测 run 再按 `lastSeq` 自动续连（最多 5 次退避），不许把网络抖动直接判成失败；`replayed:true` 的 `local-tool-request` 不重放执行。刷新/多标签的流恢复由 provider 级 `remoteStreamingSessions`（`/api/chat/runs` 种子 + WS `chat:run`）∩ 可见 viewport 自动 attach 驱动，别在页面组件里另写探测逻辑；"停止"必须走服务端 `stopChatRun`（本地 abort 只是无 run 时的回退）。
- 流事件类型定义使用 `StreamingEvent` 联合类型（discriminated union）
- 消费端使用 `handleStreamEvent(event, callbacks)` 分发——不要写 `switch(event.type)`
- 新增流事件类型时更新 `stream-events.ts` 中的 `StreamingEvent` 联合和 `handleStreamEvent` 分发

### 页面上下文注入
- `components/conversation/conversation-pane.tsx` 是 full Chat 与右上角 Assistant overlay 的唯一会话 UI/控制器；新增 split-pane host 必须复用它，不得复制发送、上传、流恢复或消息 reconcile。
- Surface 差异集中在 `components/conversation/surface-policy.ts`，只隐藏分享、评分、Profile 管理、翻译/引用等外围 affordance；附件、工具卡、ask_user、confirm、编辑/重试与错误恢复不得因 Surface 缩减。Workflow 是唯一额外的角色 rollout 门：当前仅 super 渲染计划卡、工具轨迹与 Task Dock，team 也不得发 workflow 查询；这不是 Surface 差异，开放时须按 [rollout spec](../../../docs/specs/20260812-workflow-super-only-rollout.md) 三层一起撤销。
- **Thinking 与普通工具轨迹默认折叠且分层展示**：动态摘要只属于进行中状态——Thinking 在下一段开始后才把上一段首行提升为摘要，工具只显示当前 calling 项；完成后右侧摘要清空，Thinking 文案切成无省略号的完成态。初始等待只画绿色状态点，不在消息流重复 Sprouty 头像。禁止把原始 JSON 横铺在消息里；Thinking 展开看完整推理，单条工具点击开右侧 Drawer，以占满剩余高度的克制树形视图看 input/output 与耗时。artifact/确认卡仍按各自产品形态渲染，不塞进这套技术详情。
- **附件按「文件类型」分流，不按会话类型**：picker / 粘贴 / 拖拽三个入口都走 `conversation-pane.tsx` 的同一个 `handleFileSelect`——图片进内联图片盘（模型直接看得见），其余进附件药丸并在发送时上传成 `chat_files`。**唯一的例外是 mission composer**（没有内联图片通路，全部进附件）。别在 `ChatInput` 里再分一次流：它只负责把文件交给宿主。
- **模型选择器与 Profile 选择器互斥占用 Composer 同一槽位**：默认 `sprouty` 是隐式身份，不渲染 ProfileSelector，只显示 `chat/model-selector.tsx` 供每轮选引擎；经 `@` 选择任一非默认 Agent 后，隐藏模型选择器、显示该 Agent（其 `model_id` 随选择同步），避免同时出现两个相互约束的选项。模型偏好仍记在**用户**维度（`greenhouse_last_model:<userId>`），列表由 `GET /api/profiles` 的 `models` 下发，`models.length < 2` 时控件不渲染。选项显示裸 id（`flash`/`pro`/`kimi-k3`）+ 目录 `name` 作副标题。`ProfileSelector` 对默认 Sprouty 在新旧会话都返回空——不要为了“完整”把默认身份标签补回来。
- **仪表进 Dock，交付留消息流**：`components/conversation/task-dock.tsx` 挂在 `ChatInput.aboveSlot`，无外 padding，用极淡中性边界和浅灰底与正文分层，轻微向下叠进 Composer 后方但必须让折叠头完整可见，层级低于输入框；一类后台任务一行——workflow 行（当前只对 super 启用查询与渲染）展开是既有 `WorkflowRunBody`（DAG + Inspector + gate），mission 头不重复 prompt/title，也不放状态 tag，只显示 `Mission + 当前 tool/已执行步数 + 用时`（run 没有预先计划的总步数，不伪造 `x/y`）。Mission 展开区是独立的有界滚动列表，新事件自动滚底；每行只留灰色序号、一个按状态着色的类型 icon、摘要与时间（当天只显示钟点），行间用浅分割线，不画卡片边框、不重复成功/失败 icon，也不展开原始 tool output 或承载 `message.assistant` 正文。Mission 运行中的可读 `message.assistant` 事件临时渲染在 Chat 消息流；settle 后 outcome 仍是独立持久消息（幂等投递、刷新/分享/审计事实不变），但有 `dispatch_id` 的首轮任务在 Web 上按该稳定 id 归组到原 `mission_dispatch` assistant turn 尾部，不再画成一轮新的回复；无 dispatch 的 follow-up outcome 保持独立，禁止用 prompt/title 猜归属。「追加指令」只把下方真 Composer 切到一个紧凑的 Mission 路由 chip（不是已排队消息），用户点击发送后才直接 enqueue follow-up run、**不经 chat agent 转发**，接收成功的指令作为 user message 留在上方 Chat。需要通读的产物（workflow 计划卡、mission 任务卡、交付/失败的 assistant 消息、`mission-artifacts` 产物卡）恒在消息流。**不要**把进度卡再塞回消息流——`MissionRunCard` 就是因此删掉的（20260731）。数据源在客户端组合两个既有 hook（`workflow/use-workflow-run` + `conversation/use-mission-run`），没有、也不要加服务端聚合端点。
- **聊天动作卡 = 一套协议，业务状态各自落地**：`ask_user`、`workflow_plan`、`mission_dispatch`、`tables_schema_plan`、`task_capture` 都复用 `chat/artifact-card.tsx` 的 icon/title/meta/status/body/footer 骨架与密度；四种 confirm/launch 卡都在 `BELOW_PROSE_TOOLS`（正文先解释，卡片再操作）。成功态折叠为单行回执，失败/部分失败保持展开，运行态锁按钮；共享只读会话保留卡片但不下发 mutation handle。`tables_schema_plan` 与 `task_capture` 由 assistant message id + pipeline 位置派生稳定 action id，服务端先原子 claim `chat_artifact_receipts` 再写业务，刷新读取持久回执，绝不重新武装会重复建表/建 Task 的按钮；Task 业务行另存同一 action id，覆盖「业务写成功、回执写失败」恢复窗。`ask_user` 与 markdown confirm 的完成态从紧随其后的持久 user message 恢复；Workflow/Mission 继续从各自 run 事实源恢复。`MissionDispatchCard` 的 prompt 用 `<Markdown compact>` 按**高度**折叠，Launch 前模型选项来自 `useMissionModels()`（artifact.model > 会话当前模型 > 部署默认），终态展开可看 `result_summary` 与 `MissionArtifactsBlock`；交付面仍是独立 outcome 消息。
- Context Provider 放在 `lib/context-providers/`——每个文件注册一个页面类型
- 每个 Provider 定义：`label`、`emptyMessage`、`quickActions`、`contextHint`
- `contextHint` 只描述当前页事实与能力，不猜测用户动机、不写强制动作；发送时封装为逐轮 `ambient_context`，Context chip 移除后该轮不发送。
- 后端没有页面类型 provider；只验证通用 envelope、限制长度，并用固定文案把它标为“可能无关/过期的参考，不是用户指令或权限”。
- Client Actions 必须按 `scope_id` 注册、快照与执行；**页面**动作在页面实例变化后 fail closed，真实数据 mutation 仍走服务端确认工具。
- **scope 的 route key 只取路径，不含 query string**：Chat 在一轮对话进行中就会 `replaceState` 写 `#/chat?session=<id>`，把它算成另一个 route 会让本轮快照下来的 scope 当场失配、且**重试永远不恢复**（`sequence` 只增不减，导航回原路径拿到的也是新 id）。query 标注的是同一个页面实例，那些 handler 一个都没变。
- **全局动作（`GLOBAL_CLIENT_ACTION_SCOPE`）不随页面过期**：全局客户端动作的生命周期与任何 route 无关，过期它们只会打断跨页面的长任务，安全边界另在 `safety:'confirm'` + desktop `automation-policy` + `ActionConfirmDialog`。这条必须与 `snapshotClientActions`「从任何 scope 都广播全局动作」保持一致——两边不一致就是**广播了再拒绝**，即根 AGENTS「能力声明必须真实」要禁的形状（dev frictions 60/62–65 即此）。`executeClientAction` 因此先 `resolveClientAction()` 再按 `origin` 判定；**来源取自查表结果而不是名字**，页面可以注册同名影子动作，那个影子是页面绑定的。见 [round-4 spec D1/D2](../../../docs/specs/20260818-chat-friction-round-4.md)。
- **没有 `getTurnEnvironment` 的 host 也要广播全局 Client Actions**：`ConversationPane` 在宿主没传环境时自行取 `snapshotClientActions(pageActionScopeId())`，只是不附 ambient context。桌面原生能力和浏览器自动化注册在 `GLOBAL_CLIENT_ACTION_SCOPE`，曾经因为只有 Assistant overlay 传这个 prop 而在主 Chat 页完全不可见。服务端只在**存在** ambient context 时才要求两个 scope 一致，所以纯 client-actions 的环境是合法的。
- **工作台对话式修改复用普通 Chat turn 与既有 `workbench_query` / `workbench_mutation`**：Customize 里激活后，`ConversationPane` 保持 `WorkbenchPanel` 为 sticky live preview，composer 只补工作台意图前缀、不另建写 API；`SessionManager` 在 `workbench_mutation` tool result 后广播失效事件，面板重读服务端偏好并重新求值。面板挂载、window focus/pageshow 与重新可见时也必须重读，不能把 Zustand projection 当长期事实。
- 新页面在 `lib/context-providers/` 添加 provider 文件并在 `index.ts` 中导入
- 页面组件使用 `enrichPageContext()` 添加 URL 之外的数据（如 title、email）

### 样式规范
- **Tailwind v4（编译模式）**——CSS 入口：`app.css`（由 `app.tsx` import），经 `@tailwindcss/vite` 插件构建，打进 `public/assets/index-*.css`
- **语义化颜色 token**——使用自动适配明暗主题的语义 class：
  - 表面：`bg-surface-canvas`（页面/阅读画布）、`bg-surface-chrome`（侧栏与 Composer）、`bg-surface-card`（数据卡片）、`bg-surface-raised`（输入框/顶栏/弹窗）、`bg-surface-muted`（高亮区域）、`bg-surface-sunken`（内嵌低层区域）。Light 下页面必须是白色，卡片用轻微浅绿，侧栏使用更明显的浅绿 chrome；禁止再把 `surface-sunken` 当整页底色
  - 文字：`text-fg`（主要）、`text-fg-secondary`（正文）、`text-fg-muted`（标签）、`text-fg-faint`（提示）
  - 边框：`border-edge`（普通）、`border-edge-strong`（输入框）、`divide-edge`
  - 状态：`text-danger`/`bg-danger-subtle`、`text-success`/`bg-success-subtle`、`text-warning`/`bg-warning-subtle`、`text-info`/`bg-info-subtle`
  - 破坏性操作：`bg-destructive`/`bg-destructive-hover`——禁止直接用 `bg-red-*`
  - 星级评分：`text-star`/`text-star-hover`——禁止直接用 `text-amber-*`
  - **禁止使用 `bg-white`、`text-gray-*`、`border-gray-*`、`bg-gray-*`、`bg-red-*`、`text-red-*`**——始终用上述语义 token
  - 开关/Toggle 圆点用 `bg-surface-raised` 替代 `bg-white`
- 主色：基于 CSS 变量的 `primary-*` 品牌色板（如 `primary-500`、`primary-600`）
  - 主题定义在 `lib/theme.ts`，通过 CSS 自定义属性应用；固定锚点为品牌绿 `#2E8B3D`、深绿 `#1F6B34`、青柠 `#8CC63F`
  - **禁止硬编码颜色名**（如 `teal-500`、`emerald-500`）——始终用 `primary-*` 或语义 token（`text-success`、`bg-success-subtle`）
  - 用户主题偏好为 `Follow System` / `Light` / `Dark`；`Follow System` 只动态解析到既有 Light/Dark，不是第三套皮肤。两种实际模式共享同一品牌主色，只切换 surface/text/edge/status 语义 token。新增皮肤或换品牌主色前必须先更新品牌规范，不得恢复多皮肤选择器
- **选中态分两种形状，别混用**——判据是「这个元素本来有没有边界」：
  - **行状**（侧栏导航、`More` 悬浮项、Chat 历史行、下拉菜单项）= **只有底色**。用 `.sidebar-active-item`（底色 + `primary-fg-strong` + 字重 + `aria-current`），**不加内描边、不加左侧竖条**。一行横跨整个容器、左右没有可比对象，底色本身就没有歧义；再叠描边会让导航读成一个被框起来的控件。
  - **有界控件**（chip / tag / badge / 分段控件）= 底色 + `border-primary-edge`。它**本来就有一圈 `border-edge`**，把这圈改成主色是修改既有元素、不新增视觉层；而且它是一排相同兄弟里的一个，5 个并排时只靠底色不够。
  - 反例记录：2026-08-25 把 token 调强之后没有回头撤掉行状那两层补偿，侧栏一行同时有底色 + 实心绿内描边 + 3px 竖条，明显过度。那两层当初存在的唯一理由是「底色只差 0.7 L\*」，而调完是 6.6（Dark 8.2）——**根因修好，补偿就该跟着退役**。
- **有界控件的承重线索是描边，不是填充**（`bg-primary-subtle` + `border-primary-edge`）。Light 的七个 surface 全挤在 L\* 95.8–100 的品牌绿洗色带里，而浅色填充**在物理上**无法既对相邻的近白表面拿到 WCAG 2.2 SC 1.4.11 要的 3:1、又还能承载深绿文字（最好的候选也只到 1.26:1）。所以 `--t-primary-edge` 在 Light 下是**实心 primary-500**，对填充/hover 填充/canvas/sunken 四个相邻面都 ≥3:1；填充只是辅助台阶。
  - 这三个 token 曾经取自同一条洗色（`primary-50/100/200`），于是 `--t-primary-subtle` 与 `--t-surface` **逐字节相同**、`--t-primary-subtle-hover` 与 `--t-surface-muted` 逐字节相同，选中与未选中的填充差 **1.01:1**——lint / typecheck / render test 全绿，因为每个调用点都"正确"地用了语义 token。护栏是 `lib/theme-contrast.test.ts`，它断言的是**相邻颜色之间的关系**而不是 token 是否重复：两个 token 相同但永不相邻是无害的。
  - **正文里的品牌底色用 `var(--t-primary-wash)`，不要用 `bg-primary-subtle`**。行内代码、`@` 提及、`entity-link:hover` 三处住在连续文本里，选中强度的填充会把半段话刷成高亮；wash 就是它们专用的旧洗色值，只有这三个消费者。
  - Dark 不受此约束也**刻意没动**：它的 subtle 是半透明绿压在近黑上，选中/未选中天然差 1.30:1。Dark 的 `--t-primary-edge` 对自身填充只有 1.18:1，这是已知的更弱线索，要改属于独立的视觉决策。
  - **`text-primary-fg` 在这个填充上只有 4.4:1**，达不到小字的 AA。任何坐在 `bg-primary-subtle` 上的**文字**用 `text-primary-fg-strong`（5.38:1）；`primary-fg` 只留给图标（非文本，3:1 即可）。
  - **选中态不能只靠颜色**：自造的 chip 组必须带 `aria-pressed`（`role="radio"` 只在真的实现了方向键 roving 时才写，否则是虚假承诺）。`Tabs` 已经是 `role="tab"` + `aria-selected`，不要重复包一层。
- **焦点环由 `:root …:focus-visible` 统一提供**，颜色取 `--t-focus-ring`（Light `primary-600` 5.36:1 / Dark `primary-400`）。那条规则里的 `:root` 是承重的——它把特异性抬到 (0,2,1) 才压得住 Tailwind 的 `.focus\:outline-none:focus` (0,1,1)，去掉就会打平并输给后出现的规则。组件自己的 `focus:ring-primary-500/30` 在白底只有 1.47:1，只能当装饰，不要当作已经有焦点指示。
- 暗色模式：通过 CSS 变量自动切换——不需要 `dark:` 前缀。切换主题 = 切换 `--t-*` 变量值
- 主题过渡：bg/border/color 平滑 0.2s；`theme-loading` class 在首次渲染时抑制动画
- 侧栏一级导航、`More` 当前项与 Chat 历史当前会话统一使用 `.sidebar-active-item`：**主色背景 + 强前景 + 字重**，并暴露 `aria-current="page"`。禁止再加内描边或左右指示条（见上方「选中态分两种形状」）。Chat 历史的批量勾选行用更浅的 `bg-primary-subtle` 与当前会话区分，勾选语义由 checkbox 承担。
- 动画：`animate-fade-in`、`animate-slide-up`、`animate-slide-in-left/right`、`animate-toast-in/out`、`animate-skeleton`
- 间距：`px-3 md:px-4` 区块、`p-3` 卡片、`gap-2` flex
- 圆角：`rounded-md` 小、`rounded-lg` 卡片、`rounded-xl` 弹窗、`rounded-full` 徽章
- z-index：`z-10` sticky、`z-20` dropdown、`z-40` backdrop、`z-50` modal、`z-[60]` 嵌套弹窗
- 字号：`text-[10px]` 时间戳、`text-xs` 标签、`text-sm` 正文、`text-base` 标题、`text-lg` 大标题
- 文本截断：`truncate` 旁边始终加 `title={value}`，悬停显示完整内容
- 扁平内容布局：详情/文章类视图（如知识库文档、设置子面板）正文**直接平铺**，不套 `<Card>` 凸显；元信息（标题/标签/时间）与操作（编辑/归档/历史）放在顶栏 `border-b border-edge bg-surface-raised` 行内；侧栏目录用 `border-r border-edge` 竖线分隔，**不加** `bg-surface-raised` 背景，可折叠。只有真正的数据容器才用单层 Card。
- 复杂内容/多步骤的新建编辑使用**整页视图**（顶栏 Back/Cancel 在左、Save 在右上角），表单字段组件抽出复用（如知识库的 `EditorInline`/`EditorView`）；列表内的常规 CRUD 仍按上方约定使用 Dialog。
- 列表分类筛选：用搜索框右侧的 `<Select size="sm" inline>` 下拉（默认"全部"+计数），不要单独的左侧分类栏/移动端 Drawer。

### 全局搜索（⌘P）

侧栏 Logo 行右侧的一对 icon-only 按钮：**搜索**（`components/search/search-nav-button.tsx`）在左，**Assistant** 在右，随后才是侧栏折叠；两者都用 `<IconButton tooltip="bottom">`——它们是同一类「从任何地方够到任何东西」的全局操作，一个带文字标签一个不带会读成两类东西。折叠侧栏隐藏 Logo，搜索与 Assistant 改为展开控制下方的纵向图标，但必须继续可达。

- **弹框是 `OverlayFrame` 的 `palette` variant**（顶部锚定 `sm:pt-[10vh]`）。**不要改成居中**：palette 高度随结果数变化，居中会让输入框在打字过程中上下滑动。同理**分类 pill 恒定渲染全集**，不按有无命中增减——会跳的筛选行同样难用。
- **All 与单类是同一份响应的两种视图**：All 每类最多 5 条分节展示、节标题带「还有 N 条」切到该类；选中某个 pill 则该类 20 条平铺。因此 pill **不显示计数徽章**——服务端返的是 `hasMore` 布尔而不是真实总数（见 [spec](../../../docs/specs/20260804-entity-references-and-peek.md) D16）。
- **会话历史是独立 `session` 分组**：只搜当前用户的 web 会话标题，点击直接进入 `#/chat?session=…`；它不是 `EntityRef`、不走 entity peek，也不得出现在工作台 nav 卡的实体选择器里。
- **键盘在跨节的扁平索引上走**（All 视图下 ↑↓ 连续穿过所有分组）：`↵` 开 peek（与点实体链接**同一条路径** `openEntityPeek`），`⌘↵` 直接开完整页，`esc` 关闭，鼠标悬浮同步高亮。
- **用户看不到的分类要从 pill 里去掉**（当前按 `canUseFeature(user,'tables')`）：服务端本就返回空组，但一个永远搜不出东西的筛选项会被读成搜索坏了。
- 文档行的副标题只用作者写的 summary，缺就留空——`lib/search-summary.ts` 的既定约定，**不要拿正文 snippet 冒充摘要**（那会把原始 Markdown 连同链接语法显示出来）。

### 快捷键
- `Cmd+K` / `Ctrl+K`——切换 Assistant 浮层
- `Cmd+P` / `Ctrl+P`——全局搜索（判定与文案在 `components/search/shortcut.ts`，注册在 `agent-context.tsx` 的全局处理器里，与其它全局快捷键同处；**刻意不抢 `Cmd+K`**）
- `Cmd+N` / `Ctrl+N`——新建聊天
- `Cmd+Escape`——关闭 Assistant 浮层
- `Escape`（无修饰键，输入框外）——关闭 Assistant 浮层（如已打开）
- 弹窗：Escape 关闭（由共享 `useOverlayBehavior` 统一处理）
- Popover（@提及/斜杠命令）：`↑↓` 导航、`Enter/Tab` 选中、`Escape` 关闭

### 聊天输入框（Composer）
- 输入框是纯 `<textarea>` + 结构化选中项，**不要**改成 contenteditable 富文本。
- 聚焦态属于最外层 composer：外壳用 `focus-within` 统一画 border/ring，textarea 自己不得再画 outline（dark 全局 focus 规则显式排除 `.chat-composer-textarea`），保证 Light/Dark 都是一块完整输入面。
- `@` 只触发 [mention-popover.tsx](./components/chat/mention-popover.tsx) 的 Agent Profile 选择：候选与 `/ Task` 一样保持单行、明确高亮、`aria-selected` 和 `↑↓`/Enter/Tab 键盘选择；左侧名称，右侧用紧凑 Tag 标明 System / Shared / Personal，不渲染描述。选择会切换新会话 profile 并驱动 `selectedProfileId`；Chat Composer 不提供成员 mention，成员协作走会话 Share。
- `/` 触发 [command-menu-popover.tsx](./components/chat/command-menu-popover.tsx) 的两段式选择：**Tasks** 段在前（团队/个人子组不变），**Skills** 段在后（`Sparkles` 段头 + 行首小 icon + `Mission` Tag 区分执行去向），`↑↓` 在一条扁平索引上跨段连续走。候选行保持单行：左侧标题、右侧 `/shortcut`（技能为 `/name`），不渲染描述或正文；`↑↓` 的当前项必须有明确高亮并用 `aria-selected` 暴露，Enter/Tab 确认。选中带变量 Task 后焦点直接进入第一个变量，Tab 由 `TaskVariableForm` 确定性地依次移到其余变量、最后进入正文 textarea（不能只依赖 WebView 的默认焦点推进）；Task 正文仍只在发送时展开。
- **Skills 段只对能起 mission 的用户渲染**（`canUseFeature(user,'cloud-agent')` 门控加载）。`mission_ready` 只表示沙箱可安全挂载；Chat `/` 必须消费服务端派生的 `slash_selectable`，当前仅仓库 `branding/business` 第一方组为真，菜单按 `source_group` 分节且 POST direct launch 同谓词重校验，浏览器不得用 tag 复刻。选中技能 = composer 挂一枚技能药丸（可移除，正文允许为空），**发送即直接 `POST /api/cloud-agent/runs`**（带 `skill` + `write_user_turn`，不经 chat agent 转发——用户亲手选技能又亲手按发送就是人工确认），run 进 Task Dock、终态交付走既有 outcome 消息。技能草稿没有内联图片通路（`handleFileSelect` 把所有文件路由到附件、经 `chat_file_ids` 零复制进沙箱 `inputs/`）；选技能前已入盘的图片在发送时用 toast 拦下让用户处置，不静默丢。
- 选中的 profile 以药丸形式渲染在 [composer-chips.tsx](./components/chat/composer-chips.tsx)（textarea 上方），可整体移除。
- 触发检测复用 [use-trigger-popup.ts](./components/chat/use-trigger-popup.ts)（`insertSelection('')` 删 token、`insertSelection(text)` 展开）。
- `ChatInput` 被 ChatPage 与 AgentPanel 共用，新增 props 一律 optional。
- 桌面 placeholder 只声明当前真的可用的入口（`@ Agent` / `/ Task`），移动端只保留「输入消息」短文案；不能让已有会话显示不可用的 `@` 能力。移动端 Composer 的发送/停止按钮固定在 textarea 右下角，底部工具条把宽度优先留给 ProfileSelector。语音输入能力已完整移除，任何 Surface 都不得重新声明或渲染该入口。
- 移动软键盘不得通过缩短整个 `app-viewport` 推挤 TopBar 与正文：`useMobileKeyboardViewport` 在 `App` 根部保持键盘前的壳层高度；Chat 用 `.mobile-keyboard-lift` 只上推 Composer，共享 `OverlayFrame` / `Drawer` / `OverlayPanel` 用 `.mobile-visual-viewport` 缩进当前可视区。不要在页面、单个弹框或 Mobile 壳里再加第二套 keyboard padding / resize 逻辑。

### 移动端适配

所有新 UI 必须支持移动端（≥ 375px 宽度），遵循以下模式：

**断点：** `sm:`（640px）、`md:`（768px）、`lg:`（1024px）。以 `md:` 作为移动/桌面的主分界点。

**侧边栏：**
- 所有应用路由共用同一份侧边栏宽度偏好，默认 248px、最小 200px、最大 420px；切换 Knowledge 等一级入口只替换内容，禁止切换外壳宽度或另存模块专属宽度。侧边栏内部必须依赖 `app-sidebar` container query，不要用 viewport 断点猜测可用宽度
- 带搜索和多个操作的侧栏头部使用 `<SidebarToolbar>`；219px 以下自动把次要操作收入菜单
- `<FilterPills wrap>` 用于必须始终直接可见的可清空标签组，超出宽度自然换行；Knowledge scope 与 Chat scope 都是恒有一项选中的范围切换，必须使用 `variant="segment" fill`。只有低优先级的密集筛选才用 `collapseInSidebar` 在窄侧栏切换成 Select。次要行信息可用 `.sidebar-secondary-meta` 在窄侧栏收起
- **`FilterPills` 的 `variant` 按语义选，不按好看选**：`pill`（默认，全圆角、无轨道）= 可选可清空的筛选（标签）；`segment`（4px 圆角、坐在 `surface-sunken` 轨道里）= 恒有一项选中的互斥开关（Chat 的 scope、History 的 status）。两种行为长同一个样子时，上下相邻的两行会被读成一条筛选带——Chat 侧栏的 scope tabs 与标签筛选就是这个位置关系
- Chat 历史的日期分组与置顶/文件夹使用同一套折叠交互，折叠状态按浏览器持久化；当前正在查看的 session 必须立即清除未读且不显示未读点，流结束时也不得重新标未读。
- Chat 历史顶部是 **scope tabs**（`FilterPills variant="segment" fill`，与 Knowledge 同一个组件）：`我的`（默认，所有角色）/ `分享给我` / `Team`（仅 super 渲染），在移动 Drawer 中均分可用横向空间。**扩大范围不持久化**：每次重新进入 Chat 都回到 `mine`，super 也不能因为上次看过 Team 而在下次无意中继续浏览团队会话。**筛选在服务端**（`listSessions(..., scope)`），不是前端过滤——侧边栏一次只拉 500 条，super 的「我的」如果靠前端过滤，永远会被别人的会话挤出窗口，等于没修。**pinned/文件夹分区只在 `mine` 下渲染**，`shared`/`team` 是纯日期分桶平铺：那两档下别再从日期桶里剔除 pinned/已归档的行，否则一个被 pin 过的别人的会话会哪个分区都进不去、彻底消失。「分享给我」的角标直接读 `useWsStore().shareCount`（服务端推的同一个数，与收件箱同源），不要在这里另算一份。
- 历史弹框（View All）的归属筛选与 scope tabs 共用同一套语义，默认也是「我的」；`team` 档的谓词是 `is_owner === false && !shared`——**只有 super 的列表里才有这种行**，此前它既不匹配 `mine` 也不匹配 `shared`，只能从「全部」里翻。`countHiddenFilters` 按「与默认值不同」计数而不是「不等于 all」，否则默认的归属筛选会让 More 徽章长亮。
- **历史弹框的筛选按「决定集合」与「在集合内细化」分层**：主行放 status（segment）+ 归属 + 搜索——这两个轴决定「有哪些对话存在」；`More` 里按 `<FilterSection>` 分成 **Organize**（分组 / Agent / 标签，怎么归档的）与 **Review**（好评差评 / 星级，别人怎么评价的）两条带标题的带，外加只在有生效筛选时出现的「清除筛选」。**别退回一行平铺四个 Select 加一个星级控件**——那样没有任何线索说明哪个是哪类。星级筛选点同一颗星要能清空，否则唯一的退出口是清除按钮。
- **历史列表行是只读的**：评分与好评差评在这里只显示不可写（`★ N` 文本 + 徽章）。会话 TopBar 的唯一评价入口是 Star，点开同一 Dialog 后选 1–5 星和备注（不再平铺赞/踩）；Tag/Star/Share/右侧 Pane 全部与 TopBar 其他动作一样用等大 icon-only + tooltip。会话标题左侧保持单行，有写权时由 Pencil 原位切换为 Input（Enter/失焦保存，Escape 取消）。侧栏的重要标记另写 `feedback:'starred'`。历史行保留的三个独有动作是 Admin Comment、归档/恢复、删除。
- History 行不重复显示当前 status，也不把普通 `profile_id` 做成标签；status 已由顶部互斥筛选表达，普通 Agent Profile 对浏览历史没有额外辨识价值。历史 Cloud Mission / Workflow 会话只复用侧栏的 `SessionTypeIcon`，确保两处符号语义一致。顶部不再重复显示 results 数量，唯一总数留在分页 footer。
- Chat 历史支持**多选批量操作**（打标签/移动分组/归档/删除）：入口三选——`SidebarToolbar` 的 `Select` 切换、行长按（touch，450ms）、`Ctrl/Cmd+Click`；进入后单击=勾选、`Shift`=可见区间、`Cmd/Ctrl`=追加单行，`Escape`/空白处/底部「完成」退出。可见渲染顺序（pinned→folders→date buckets、排除折叠段）是区间选择的单一真源，抽在 `sidebar-panels/selection.ts`（纯函数 + 单测），底部栏在 `sidebar-panels/batch-action-bar.tsx`。批量动作对现有 per-session API（`updateSession`/`setSessionGroup`/`addTagToSession`）经 `runWithConcurrency(_,5,_)` 逐条调用 + 乐观更新，失败统一 `loadSessions()` 回滚并 toast 失败数——**不新增批量后端端点**。**登记（防第二套实现）**：批量标签用薄组件 `session-tags/batch-tag-selector.tsx`（复用 `TagBadge`/`TAG_COLORS`/`createSessionTag`），不改造单会话 `TagSelector` 成双模态——单会话 popover 立即 mutation 的语义与批量「先收集、再对 N 条应用」不同；批量分组则**扩展** `GroupSelector` 的可选 `onPick`（不平行造第二套）。
- 移动端替代 → 横向可滚动标签栏（`md:hidden overflow-x-auto scrollbar-hide`）或由按钮触发的 `<Drawer>`
- 移动导航 Drawer 的导航区独立滚动，账号区始终固定在抽屉底部。Chat 路由在一级导航下直接复用 `ChatHistoryPanel`，选中会话后关闭 Drawer；Global Agent 只留在桌面品牌行，不占移动首行空间。
- 参考：Settings（`pages/settings/index.tsx`）、Knowledge（`pages/knowledge.tsx`）、聊天历史（`components/app/sidebar-panels/chat-history-panel.tsx`）

**表格：**
- `<table>` 始终包在 `overflow-x-auto` 容器中
- 表格设置 `min-w-[600px]` 等，防止列压缩
- 移动端隐藏非核心列：`hidden md:table-cell`、`hidden lg:table-cell`
- 参考：Tables Grid（`components/tables/`）

**筛选/工具栏：**
- 使用 `flex flex-wrap gap-2` 允许窄屏换行
- 筛选输入：`flex-1 min-w-[100px] sm:flex-none sm:w-[140px]` 模式
- 复杂工具栏：移动端隐藏次要控件（`hidden sm:flex`）
- 参考：项目详情工具栏（`pages/project-detail.tsx`）

**触摸交互：**
- 移动端主要按钮与纯图标操作的实际命中区至少 44×44px；视觉图标可以保持 14–20px
- Markdown 图片与用户消息缩略图都必须走共享 `MediaPreviewDialog`，禁止手写无标题栏/关闭按钮的全屏 lightbox，也禁止把移动 WebView 直接导航到 raw image；媒体翻页、下载与关闭在移动端都要保持至少 44×44px 命中区。
- **禁止仅依赖 hover 显示关键操作。** 配合 `group-hover:opacity-100` 使用 `.touch-visible` CSS 辅助类，确保触屏设备上按钮可见：
  ```tsx
  className="opacity-0 group-hover:opacity-100 touch-visible"
  ```
- `touch-visible` 类定义在 `index.html`，通过 `@media (hover: none)` 设置 `opacity: 1`
- Assistant 消息底部的耗时与复制/重试等操作栏保留固定高度，桌面端仅在整条消息 hover 或键盘 focus-within 时显示，触屏端恒显；正文代码块使用扁平浅底与细边框，禁止 `shadow-*` 悬浮卡片效果。

**iOS 安全区域：**
- 应用头部使用 `pt-[max(0.5rem,env(safe-area-inset-top))]`
- 底部输入区域使用 `pb-[max(0.75rem,env(safe-area-inset-bottom))]`
- viewport meta 标签已设置 `viewport-fit=cover`
- **弹层高度上限必须跟着 safe-area 走，禁止写死 `calc(100dvh - <常数>)`。** 写死常数会在刘海机上
  算漏 `env()`（实测 62 + 34px），弹框比可用空间高出约 80px，移动端 `items-end` 会把溢出部分从顶部
  顶出屏幕，**标题栏连同关闭按钮一起消失、弹框再也关不掉**（2026-08-01 修复）。
- **对话框族不需要你自己回答「padding 挂哪」——`<OverlayFrame>` 已经替你答了**：safe-area padding
  挂最外层容器、弹层只写 `max-h-full`（百分比相对容器 content box，安全区已被扣除，容器 padding
  变化时上限自动跟随）。`Dialog`/`ConfirmDialog`/`ActionConfirmDialog` 都走底座，回归测试在
  `overlay-frame.render.test.tsx` + `ui-responsive-primitives.render.test.tsx`。
- `Drawer`/`OverlayPanel` 的 safe-area 仍由 `.safe-area-panel` 挂在元素自身（border-box 已含 padding）；
  但键盘几何必须与 `OverlayFrame` 一样统一消费 `.mobile-visual-viewport`，禁止调用方自行写 viewport 高度补偿。

**弹出/下拉宽度：**
- 固定宽度弹出框必须添加 `max-w-[calc(100vw-2rem)]` 防止溢出视口
- **但 `max-w` 只在视口本身够窄时才救得了你**：绝对定位浮层若从触发点向"外"展开（如 `left-0` 挂在
  靠右元素上），照样穿出边界。会越界的浮层改用共享 `<Dialog>`（Chat 评价面板即此例）；
  朝安全方向展开的（`right-0` / `right-full`）保持轻量浮层，不为统一而统一。

**Hover 触发的可交互浮层：**
- 菜单、工具预览、目录预览等「悬浮打开后鼠标还要进入面板操作」的浮层，一律使用
  `hooks/use-hover-flyout.ts` 的 `useHoverFlyout()`；默认 320ms 离开缓冲。禁止在调用方再写
  `onMouseLeave={() => setOpen(false)}` 或复制 100–200ms 的局部 timer——按钮与面板间哪怕只有 1px
  空洞，都会在鼠标进入面板前卸载它。
- 视觉间距必须用**绝对定位外壳的 padding 做 hover bridge**：上弹用 `pb-*`、右弹用 `pl-*`，边框/背景/
  shadow 放内层面板；禁止用 `mb-*` / `ml-*` 在 trigger 与 panel 命中区之间制造空洞。delay 只兜底手抖与
  斜向移动，不替代连续命中区。
- Hover 事件使用 `onMouseEnter` / `onMouseLeave`；触屏仍由 click 开关，不能用 Pointer Events 合成一套
  粘住的 hover。键盘须可由 focus/click 打开并以 blur/Escape 关闭；outside click 是否需要由宿主决定。
- 非交互 tooltip（`pointer-events-none`）、图表 hover、星级预览等不使用本 hook；它们没有「跨到浮层里操作」
  的路径问题。完整决策见 [spec](../../../docs/specs/20260811-hover-flyout-interaction.md)。

**选择与手势策略（全局，`app.css`）：**
- **外壳不可选，内容可选**：`button` / `a` / `label` / `summary` / `nav` / `th` /
  `[role=button|tab|menuitem|option|switch|separator]` 一律 `user-select: none` +
  `-webkit-touch-callout: none`，避免触屏长按拖出系统选择手柄与「拷贝」气泡。
  **禁止全局 `user-select: none`**——复制模型回复、摘抄文档是核心操作。
- `input` / `textarea` / `[contenteditable]` 与 `.prose-base` / `.prose-compact` / `.rich-markdown` /
  `.markdown-body` 显式恢复可选；外壳里需要被复制的文本（会话 ID 等）加 `.selectable`。
- 缩放两层禁用，各管一头：viewport meta 的 `maximum-scale=1, user-scalable=no` 管双指
  （**iOS Safari 自 iOS 10 起忽略它**，实际只对 Android 等生效），`html { touch-action: manipulation }`
  管双击且全平台有效。iOS 上仍能双指缩放是 Safari 既定行为，不是配置失效。
- 移动端输入控件字号 ≥ 16px（`@media (max-width: 767px)` 已全局设置），否则 iOS 聚焦时自动放大页面。

**视图默认值：**
- 复杂视图（Gantt 图）在移动端应默认使用更简单的替代方案：
  ```tsx
  const [view, setView] = useState(() => window.innerWidth < 768 ? 'list' : 'gantt');
  ```

### 列表筛选栏规范

所有列表页的顶部筛选栏必须遵循统一规范：**紧凑单行布局 + 可展开更多筛选**。

**核心原则：**
- 所有筛选控件放在**一行**内（`flex items-center gap-2 flex-wrap`）
- 常用筛选直接显示，不常用的收进 **"More ▼"** 可展开区域
- 每行右侧放操作按钮和结果计数，中间用 `<div className="flex-1" />` 撑开

**标准结构：**
```tsx
{/* Row 1: 主要筛选（始终可见） */}
<div className="flex items-center gap-2 flex-wrap">
  {/* 搜索 */}
  <SearchInput size="sm" className="flex-1 min-w-[120px] sm:flex-none sm:w-[180px]" />
  {/* 1-3 个高频筛选 Select */}
  <Select size="sm" inline> ... </Select>
  {/* More 展开按钮 */}
  <button className="text-xs ..."><Filter size={12} /> More ▼</button>
  <div className="flex-1" />
  {/* 结果计数 + 操作 */}
  <span className="text-xs text-fg-faint">{total} results</span>
</div>

{/* Row 2: 次要筛选（可折叠） */}
{showMoreFilters && (
  <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-edge">
    {/* 低频筛选控件 */}
  </div>
)}
```

**具体规则：**
| 规则 | 说明 |
|------|------|
| 搜索框 | 使用 `<SearchInput>` 组件，禁止手动拼 Search icon + Input |
| Select 筛选 | 使用 `<Select size="sm" inline>`（`inline` = `w-auto`） |
| Input 筛选 | 使用 `<Input size="sm" className="w-[120px]">` |
| 容器 | `border-b border-edge bg-surface-raised px-4 py-2.5` |
| 更多按钮 | 有次要筛选时显示，使用 `<Filter>` icon + "More ▼" / "Less ▲" |
| 日期范围 | 使用 `<DateRangeInput>` 组件 |
| 展开区域 | `pt-1 border-t border-edge`，与主行保持相同 flex 模式 |

**"More" 分界原则（哪些放主行 vs 展开区）：**
- 主行（始终可见）：搜索框、状态/类型等最高频 1-3 个筛选
- 展开区：日期范围、ID 搜索、评分、来源渠道等低频筛选

**固定宽度筛选控件的实现细节：**
- 每个筛选控件包裹在 `<div className="flex-shrink-0 w-[xxxpx]">` 容器内
- `<Input>` / `<Select>` 默认 `w-full`，填充容器宽度，避免 Tailwind 类冲突
- **禁止**直接在 Input/Select 的 `className` 上写宽度类——会被组件内部 `w-full` 覆盖

**参考实现：**
- 声明式 schema 驱动：`@greenhouse/crud` 的 `CrudPage`（settings 列表页）

### 列表表格规范（sticky / nowrap / tooltip）

所有列表 `<table>` 统一遵循：

- **表头 sticky**：`<thead className="sticky top-0 z-10 bg-<opaque> [&_th]:whitespace-nowrap">`，下滑时表头始终可见。bg 用不透明色（`bg-surface-sunken` 或 `bg-surface-muted`）。
- **关键陷阱**：sticky 只相对**最近的滚动祖先**生效。**禁止**把 `<table>` 再包一层 `<div className="overflow-x-auto">` 放进 `flex-1 overflow-auto` 里——`overflow-x-auto` 会让该 div 成为滚动容器（CSS 规范：一轴非 visible 另一轴自动算 auto），导致 thead sticky 失效。正确做法：**`<table>` 直接作为单个 `flex-1 overflow-auto` 容器的子元素**（横向滚动由外层 `overflow-auto` 一并处理，配合 `min-w-[Npx]`）。
- **表头不换行**：用 `[&_th]:whitespace-nowrap`（一个类作用于所有 `<th>`），不要让表头标签换行。
- **单元格默认单行**：表格加 `[&_td]:whitespace-nowrap`（一个类作用于所有 `<td>`），**所有单元格默认不换行、单行显示**。
- **单元格截断 + tooltip**：长自由文本列用**内层** `<span className="block max-w-[…] truncate" title={value}>`（auto-layout 表 `max-width` 必须放在内层块元素上，放 `<td>` 上不生效）超出省略；`title` 必须带，悬停看全文。`<Tag truncate>` / `<Badge truncate>` 已自动写 `title`。
- 非整页滚动的列表（页面级滚动、卡片内小表）可只做 nowrap + tooltip，sticky 视容器而定。
- **横向滚动的宽表必须钉住两端**：身份列（名称/单号）`sticky left-0`、行操作列 `sticky right-0`，class 组合与 z 层级取自 `lib/sticky-columns.ts`（`STICKY_LEFT_HEADER` / `STICKY_RIGHT_CELL` / …），不要各页手写。**钉住的单元格必须自带不透明背景 + 行 hover 背景**（`STICKY_CELL_SURFACE`）——透明背景会让滚动过去的列直接透过来；对应地，行 `<tr>` 需要 `group` class，否则 hover 态跟不上。表面色留给调用方（Tables 坐在 `surface-raised` 上，CRM 行 hover 到 `surface-muted`），模块只管定位与层级。
- **单元格内联编辑：单击查看、悬浮出铅笔、点铅笔才进编辑**（`components/tables/inline-edit-cell.tsx`，Tables Grid 共用）。**不要退回双击**——双击必须靠吞掉单击或加定时器才能与"点开这一行"区分，而当初正是那次吞没让整站的表格点击静默失效（2026-08-03 修）。铅笔按钮带 `touch-visible`：触屏没有 hover，那是它唯一的入口；键盘 Enter/F2 保留。行点击的归宿由宿主决定（Tables 开记录抽屉、项目跳详情页），所以**行操作列要自己 `stopPropagation`**，否则点删除会顺带把详情打开。

### 列表分页规范

所有分页列表统一用共享 `<Pagination>`（`components/ui.tsx`）+ `usePersistedPageSize`（`hooks/use-persisted-page-size.ts`）。

- **禁止**再手写 `Prev/Next`/Chevron 页脚，或在页面里定义 `const PAGE_SIZE = 20`。
- `<Pagination page pageSize total onPageChange onPageSizeChange />`——`page` 为 **0-based**；自带左侧区间文案、每页数量下拉（默认 `[20,50,100]`）、Prev/Next、`X / Y` 和跳页输入框；`total===0` 时自渲染为空。
- 每页数量用 `const [pageSize, setPageSize] = usePersistedPageSize('<scope>', 20)` 持久化到 localStorage（key 如 `projects.list`、`tables.records`）；**改变 pageSize 时调用方负责把 `page` 重置为 0**。
- 数据加载的 `limit/offset`（或 `page_size`）一律取自 `pageSize`，并把 `pageSize` 加入 `loadData` 依赖。
- 1-based 的旧页码（如 `eval/datasets`）在调用处做 `page={page-1}` / `onPageChange={(p)=>setPage(p+1)}` 适配，不改内部约定。
- 参考：`packages/crud/src/client/`、`pages/settings/users.tsx`。

### 标签 Tag 规范

表格单元格 / 紧凑容器里的彩色标签**一律单行，宁可省略不换行**。

- 状态/结果/类型等单个标签 → `<Tag tone truncate>`（`components/ui.tsx`）。`tone` 取 `neutral|primary|success|warning|danger|info`，内置 `whitespace-nowrap`；在受限列里加 `truncate`（自动写 `title`，可用 `maxW` 调宽度）。
- 多标签单元格 → `<TagList items max>`，单行展示前 `max` 个再 `+N`，**不要** `flex-wrap`。
- **禁止**再手写 `text-[10px] px-1.5 py-0.5 rounded border ...` 的 pill `<span>`，也**禁止**在表格里用 `flex flex-wrap` 堆叠多个 Badge/Tag。
- 域值→tone 的映射集中在 `lib/utils.ts`（`INQUIRY_STATUS_TONE` / `INQUIRY_RESULT_TONE` / `DEAL_STAGE_TONE`）——新增枚举改这里，各页 import，不要在页面里重复 `XXX_BADGE_VARIANT` 字典。
- `<Badge>` 也支持 `truncate` / `maxW`；圆角 pill 风格用 Badge，方角紧凑风格用 Tag。
- 例外：**详情页头部的标签云**（`<DetailHeader badges>`）是展示区，允许 `flex-wrap`；只有**表格/紧凑容器**强制单行。

### 详情页规范（查看 / 编辑）

所有记录详情页统一用 detail kit（`components/detail/`），查看与编辑共用同一套视觉原语。

- `<DetailHeader>` — 图标/头像 + 标题 + meta（id/时间戳）+ 状态标签（单行）+ 右侧操作（Edit/Refresh/Close/Back）。
- `<DetailSection title action>` — **扁平**区块（`border-b` 标题行），遵循「扁平内容布局」，**不 card-on-card**；只有真正的数据容器（如带边框的表格、进度条）才在 Section 内套单层 `<Card>`。
- `<FieldGrid cols>` + `<Field label value hideEmpty span>` — 字段统一 **label 在上、value 在下**；空值显示 `—`，`hideEmpty` 可整条隐藏；长文本用 `span="full"`。
- **禁止**再在页面里手写 `Section`/`InfoRow`（label 左 value 右）局部组件，或 `<Card><h3 uppercase>` 区块标题——统一走上述组件。
- 编辑表单：字段沿用 `<FieldGrid>`/`<Field>` 布局与查看态一致；头部 / 底部按钮 **Cancel 在左、Save 在右**。
- 参考：`pages/project-detail.tsx`。

**带关联记录的详情页（主记录 + 多个子列表）用「吸顶头 + tab 主体」，不要一路平铺：**

- 结构固定为 `h-full flex flex-col` → 头部块 `flex-shrink-0`（Back + `<DetailHeader>` + `<Tabs>`）+ 主体 `flex-1 overflow-y-auto`。**只有主体滚动**，无论翻到第几页都看得见当前记录是谁。
- 关联记录一律**一个 tab 一类**，tab 标题必须带 `(数量)`——用 i18n 的 `xxxTab: 'Xxx ({count})'` 模板，让「这个客户到底有没有跟进/文件/出库单」不用点进去就能回答。
- **数量取服务端总数**，不要 `items.length`：详情接口的子列表是截断的（项目详情的 tasks/comments 各 100），前端拿 `counts` 字段；列表被截断时用 `common.showingFirst` 之类的提示行显式说明，禁止静默只显示一部分。
- 子列表用**紧凑表格 + `<Pagination>`**，不要不封顶的卡片流（客户详情曾经用 45 张卡片堆出 4500px）。
- `<EmptyState>` 只用于**整个 tab 为空**；tab 内的小区块（如出库单里的寄样记录）用一行 `text-xs text-fg-faint` 说明，别再塞 `py-16` 的大空状态。
- **变更历史 tab 不带数量**：它的 payload 是服务端截断的一段（20 条）且不回总数，写 `(20)` 会读成"一共就 20 条"。取而代之，条数顶到上限时用一行 `crm.activityCapped` 提示说明只显示了最近 N 条。

### 拖拽交互：用指针事件，不要 HTML5 DnD

**传感器只有一份**：`hooks/use-drag-gesture.ts`（鼠标 5px 距离 / 触摸 400ms 长按 + 8px 容差 / 边缘自动滚动 / `data-no-drag` 豁免 / Escape 取消 / 拖完吞掉那一次 click）。上面长出两个语义层，**新增拖拽先从这两个里挑，不要再写第三套**：

| 用它 | 什么时候 |
|------|----------|
| `hooks/use-list-reorder.ts` | 扁平列表/网格重排。语义刻意最简：**被拖项占据指针下那一项的位置**，拖动中实时预览新顺序，松手才提交（顺序没变不发请求）。已接：侧栏 Pinned 网格、会话标签管理、会话分组管理 |
| `sidebar-panels/use-tree-drag.ts` | 只有知识库树。树多一层语义——一行既可以是「邻居」也可以是「容器」（上下 32% 插入线 / 中间移入），扁平列表没有这回事 |

没有插入线、没有 before/after 的原因：那需要一根轴，而 Pinned 是会换行的网格，「上面/下面」无意义。

**两个只在共享层里踩得到的坑**（都有回归测试钉住，`hooks/use-list-reorder.test.tsx`）：
- **`onDrop` 必须排在 `onEnd` 前面**——调用方在 `onEnd` 里清空已解析的落点，先 finish 再 drop 等于把空落点交给它，拖拽静默失效。
- **「吞掉拖完那一次 click」的标志必须会自己过期**。落在**别的**元素上时，浏览器把合成 click 派发给两者的共同祖先而不是这一行，于是没人来消费这个标志，它会留下来吃掉用户的**下一次**真实点击。现在 finish 时挂一个 0ms 定时器兜底（合成 click 一定先于它到达）。

两条不用 HTML5 DnD 的实打实教训：

- **HTML5 `draggable` 不会从 `<button>` 发起。** 表单控件吞掉 mousedown，浏览器根本不进入「开始拖拽」那一步——Chrome 与 Safari 一致。侧栏那些行本身就是 button，于是拖拽在真人手里完全没反应（没有拖影、没有落点、没有任何状态），而代码看起来完全正确。
- ⚠️ **CDP 的 drag API 证明不了拖拽可用。** 它走 `Input.dispatchDragEvent` 直接注入 dragover/drop，**跳过的正是浏览器拒绝的那一步**；手写合成 `DragEvent` 同理。所以自动化会一路绿而功能是死的（2026-08-11 就是这么发出去的）。指针事件没有这个问题：合成 `PointerEvent` 与真实事件走同一条代码路径，测试因此是诚实的。推广开说：**凡是依赖浏览器「发起」的能力（原生拖拽、文件选择、剪贴板写），注入事件都不算验证**。

**判据是拖拽源的标签名，不是「有没有写 draggable」**：`<div draggable>` 在浏览器里是能拖的，`<button draggable>` 不能。所以 2026-08-11 盘点时 `chat-history-panel`（会话行是 `div role=button`）和 `gantt-core`（任务行是 `div`）确实能用，而 `pinned-section` 的图标磁贴是 `<button>`、和知识库树一样从来没启动过——它已随本次收敛改到 `useListReorder`。收到「拖不动」的反馈时**先看拖拽源是不是 button**，别从 CSS 查起。

**仍未收敛的两处**：`chat-history-panel` 的会话重排与 `gantt-core` 的任务重排还在用 HTML5 DnD。它们**当前能用**，所以不为统一而统一；差别只在触屏拖不动。会话历史另有一个具体阻碍：那里的**长按已经被批量多选占用了**（450ms 进入选择模式），触屏长按拖拽会和它抢同一个手势，得先定夺哪个赢。等下次真要动这两处时再迁。

### 知识库模块布局规范

适用范围：`pages/knowledge.tsx` 以及 `components/knowledge/` 中由知识库路由承载的页面。

- **内部/个人文档只从侧栏树导航**（`components/app/sidebar-panels/knowledge-nav-panel.tsx` 的 `KnowledgeTree`：目录 + 文档同树、多级展开、拖拽移动、右键/`⋯` 菜单）。主区**不再渲染已发布文档列表**——未选中文档时给「从左侧选择」落地态 + 「已归档」货架；目录页 `#/knowledge/folder/<id>` 只放附件（`DriveBrowser`）。新增文档级操作（移动/分享/归档/复制链接…）加到树的菜单里，不要在主区复制第二套入口。方案见 [20260725-knowledge-tree-navigator](../../../docs/specs/20260725-knowledge-tree-navigator.md)。
- **知识集合页的身份只由 `ModulePage` 渲染一次**：团队 / 个人 / 共享知识集合使用注册表页头；其工具栏和列表不得再放同名 `<h1>`。文档详情、目录附件和编辑器不套集合页头，继续由 TopBar 面包屑与自身 Detail/Editor 结构表达上下文。
- **列表页顶部使用紧凑单行工具栏**（对外源列表仍适用）：搜索在左，结果计数和操作按钮在右；使用 `flex items-center gap-2 flex-wrap`，窄屏允许自然换行。
- **搜索框统一用 `<SearchInput size="sm" />`**，不要用普通 `<Input>` 或手写 Search icon。
- **详情页顶部工具条只放导航和操作**：如 `Back / Rewrite / Archive`；不要再展示 `内部知识库 / space / title` 这类路径文本，因为 TopBar 已有面包屑。正文中的文档标题属于内容标题，可以保留。
- **公开知识库分类筛选**：桌面端继续使用左侧分类栏，移动端使用分类抽屉；顶部工具栏仅保留分类入口、搜索和计数。
- **文档编辑表单只有三个「必答项」**：Title（50%）/ Visibility（25%）/ Status（25%）排一行，其余（Slug、标签、摘要）在**恒默认收起**的高级选项里，开关右侧标注哪几项已有值——收起不等于藏起来。**不要再加第四个首屏字段**；也不要恢复 `Space`：一级 `meta.space` 分组在目录树上线时就被取代，留着等于问「这篇放在哪」的第二个更弱的答案（服务端字段与 `internal/<space>/` URL 段刻意保留，文档按 slug 取、那段只是装饰，删了只会让历史链接失效）。见 [spec D3/D4/D5](../../../docs/specs/20260811-kb-editing-ergonomics.md)。
- **slug 是文档的链接身份，改标题不动它**：侧栏 Rename 只发 `PUT { title }`，编辑器里已保存的文档也不自动重算 slug——复制的链接、`[[ref]]`、导出文件名都指着它。只有**新文档**的 slug 跟随标题，且作者手改过就停止跟随；规则在零依赖叶子模块 `components/knowledge/doc-slug.ts`，不要在组件里重写（旧的 `slug || slugify(title)` 在第一个字符就冻结，新建文档全都拿到单字符永久链接）。
- ⚠️ **富文本编辑器外壳不能加 `overflow-hidden`**：它会让外壳成为滚动容器，里面的 sticky 工具栏于是只相对它定位、永远不动（改 `top`/`z-index` 都没用）。圆角挂在子元素上，宽内容用内层 `overflow-x-auto` 承接。
