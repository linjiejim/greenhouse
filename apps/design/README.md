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
- 组件 #components：8 个分区，「基础」直接读取 tokens；每个组件的状态都能操作。

顶部可以切换页面、桌面或手机、深色或浅色，也可以重置全部示例。浏览器窗口很窄时自动用手机布局：抽屉加底部模块栏，与原生 App 一致。

## 模拟范围

- 修改只保存在当前页面的内存里；刷新或点「重置」后恢复。
- 回复由定时器生成，不调用模型。停止、重置、离开页面都会清理计时器。
- 语音输入是模拟识别，结果只填进输入框，不会自动发送；「朗读」用浏览器自带的 speechSynthesis。
- 附件只在本地显示文件名、大小和图片预览，不上传。周报下载的是真实的 Markdown 文件；网页产物在没有同源权限的 sandbox iframe 里预览。
- 登录只校验本地演示账号（super@greenhouse.local 或 team@greenhouse.local，密码 greenhouse）。服务、连接、电脑、定时只演示状态。

## 代码

- data.ts：模块定义、样本数据、纯状态规则。
- shell.tsx：全局栏、模块目录、右键菜单的内容、手机模块栏。
- popover.tsx：浮层定位、菜单、右键菜单。
- pickers.tsx：Select、MultiSelect、DatePicker、DateRangePicker。
- components.tsx：按钮、输入、「?」、页框、弹层、ChatCard 与「需要你」卡片、记录编辑。
- details.tsx：抽屉内容与登录页。
- chat.tsx：对话页与回复卡片。
- pages.tsx：各模块页面。lab.tsx：组件页。App.tsx：路由、预览外壳与共享状态。styles.css：布局与组件样式。

颜色、字体、间距、圆角、阴影、动效都来自 @greenhouse/ui/tokens/haven.css，它由 packages/ui/src/tokens/haven.ts 生成。品牌标志与植物头像复用 @greenhouse/ui。
