# Native Haven 交互原型

Greenhouse v2 的独立设计应用：用模拟数据，不需要后端。页面和组件页共用同一份组件。信息架构以 docs/product/prd.md §6 为准，界面规范以 docs/design-system 为准。

```bash
pnpm design:dev
```

开发地址是 http://127.0.0.1:4518。其他命令：`pnpm design:build` 输出到 apps/design/dist，`pnpm design:preview` 预览构建产物，`pnpm test:design-ui` 跑桌面和手机两套浏览器用例。4518 被别的检出占用时，用 `DESIGN_PORT=4528 pnpm test:design-ui` 验证本工作树。

dist 可以放在任意静态服务器的根目录或子目录下，资源都是相对路径；必须通过 HTTP 打开，不能用 file://。

## 页面

- 对话 #chat：Agent 区（Greeny 在最上方）、房间、会话；每一行和全局栏按钮都能右键。输入框支持 @、/、附件、语音输入；回复可以朗读；「体验状态」切换 11 种场景，包括全部五种「需要你」和图片、视频、音频结果。
- 知识库 #knowledge：范围切换、文件夹树、阅读页、在抽屉里编辑。
- 表格 #tables：产品计划（项目模板）的表格、看板、时间线；筛选、排序、分页、批量操作；记录先查看再就地编辑，下拉和日期都是自绘控件。
- 应用 #apps、技能 #skills、Agents #agents、运行 #runs、通知 #notifications。
- 设置 #settings、管理 #admin：其中「服务」是 8 类能力的 Provider 配置。
- 登录 #login：只有名称、两个字段和一个大号按钮。
- 多端 #surfaces：桌面 App 的菜单栏、通知、快捷启动、划词与截图；手机锁屏、小组件、分享、语音；手表只做看和说：表盘、一个语音大按钮、审批提示（第 2 档按住批准）、转到 iPhone、进度。通知预览只影响手机，默认关闭，锁屏不显示任务名；第 3 档通知只打开来源对话。
- 组件 #components：8 个分区，「基础」直接读取 tokens；每个组件的状态都能操作，包括悬停提示、有原因的禁用、确认框和英文词典。

顶部的「页面 / 组件 / 多端」切换原型区域；页面可以切换桌面、平板（820px）或手机、深色或浅色，也可以重置全部示例。平板保留全局栏，目录从页头浮层打开，详情用右侧抽屉，视图配置可编辑。手机上的字段与视图配置、应用搭建器、技能文件、管理服务只读，页头给「在电脑上继续」。浏览器窗口很窄时自动用手机布局：抽屉加底部模块栏，与原生 App 一致。

## 模拟范围

- 修改只保存在当前页面的内存里；刷新或点「重置」后恢复。对话、侧栏与多端场景共用「需要你」请求和运行状态；在任何地方决定后，其他场景立即更新，Toast 的「下一件」打开下一个请求的来源对话。
- Face ID 是窗口内约 1 秒的模拟验证，不调用系统认证。手表批准要按住 0.8 秒（鼠标、触控，或按住空格 / 回车），提前松开会取消；第 3 档在手机来源对话里验证后批准。
- 系统通知、小组件、快捷键提示、分享、截图、听写与跨设备发送均为内存演示，不注册系统集成、不实际发送。快捷启动支持筛选资料、↑↓ 选择、回车提问、⌘↵ 打开、Tab 换 Agent、Esc 关闭；复制链接使用浏览器剪贴板。
- 回复由定时器生成，不调用模型。停止、重置、离开页面都会清理计时器。
- 语音输入是模拟识别，结果只填进输入框，不会自动发送；「朗读」用浏览器自带的 speechSynthesis。
- 附件只在本地显示文件名、大小和图片预览，不上传。周报下载的是真实的 Markdown 文件；网页产物在没有同源权限的 sandbox iframe 里预览。
- 登录只校验本地演示账号（super@greenhouse.local 或 team@greenhouse.local，密码 greenhouse）。服务、连接、电脑、定时只演示状态。

## 代码

组件来自 packages/ui 的组件库 @greenhouse/ui/kit：按钮、输入、Select 与日期、菜单与右键菜单、「?」与 Tooltip、弹层与 ConfirmDialog、Toast、ChatCard 等。原型只保留自己的页面、外壳和模拟数据：

- data.ts：模块定义、样本数据、共享请求及纯状态规则。
- shell.tsx：全局栏、模块目录、右键菜单的内容、手机模块栏。
- components.tsx：页框、「需要你」卡片、记录编辑、图表与步骤，以及预览工具栏用的 NativeSelect。
- details.tsx：抽屉内容与登录页。
- chat.tsx：对话页与回复卡片的内容。
- surfaces.tsx：多端场景与模拟系统交互。
- pages.tsx：各模块页面。lab.tsx：组件页。App.tsx：路由、预览外壳、共享状态与确认框。styles.css：页面与外壳的布局。

颜色、字体、间距、圆角、线宽、阴影、动效都来自 @greenhouse/ui/tokens/haven.css，它由 packages/ui/src/tokens/haven.ts 生成。品牌标志（@greenhouse/ui/styles/brand.css）与植物头像复用 @greenhouse/ui。产品窗口带 data-theme、data-narrow（手机布局）和 data-floating-boundary，组件库据此切换主题、Sheet 和浮层的边界。
