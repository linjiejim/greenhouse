# Native Haven 设计系统

更新 2026-10-13。v2 新 Web 按本目录实现；移动端遵循同一语义，按平台习惯实现。产品范围见 ../product/prd.md。

安静的界面，清晰的工作：表面中性，Haven 绿只表示主操作、当前项和焦点，层级靠留白和字重拉开。

## 原则

1. 一个区域只有一个主操作。新建按钮在模块目录里，满宽，只出现一次。
2. 说明默认收起。页面标题下不写描述句；概念、范围、例子放进标题旁的浅色「?」。错误、后果、必填和权限原因始终可见。
3. 结果先于过程。先给结论和产物，步骤和推理折叠成一行。
4. 颜色只表达语义：绿是主操作、当前和焦点，黄是需要你，红是失败和危险。颜色之外总有文字或图标。
5. 卡片只包真实的分组。不放装饰数字和没有行动意义的统计。
6. 同一种语言，各自原生。Web 有悬停、右键和键盘；iOS 与 Android 用系统导航、Sheet 和菜单。语义、术语、颜色、头像各端一致。

## 来源

- tokens：packages/ui/src/tokens/haven.ts 是唯一来源。改完运行 pnpm tokens:build 生成 haven.css；单元测试检查文件是否最新和全部对比度。文档不抄写数值。
- 组件：packages/ui/src/kit 是实现（@greenhouse/ui/kit），新 Web 与原型共用；原型 apps/design 的组件页（pnpm design:dev，#components）演示每个状态。
- 画稿：design/greenhouse-v2/greenhouse-v2.pen（本地，不进 git）。只放关键页面的布局、设计系统和组件状态；变量与 tokens 同名同值。
- 原型、画稿、文档冲突时以文档为准，然后把另外两处改过来。

## 文件

- foundations.md：颜色、字体、间距、圆角、尺寸、阴影、层级、动效、图标、焦点、主题与品牌。
- layout.md：应用壳、目录行、页头、内容宽度、抽屉与 Sheet、窄屏。
- components.md：组件与状态。
- patterns.md：详情与编辑、保存、确认与撤销、右键菜单、数据视图、空与失败、搜索、通知、服务配置、登录。
- conversation.md：对话目录、对话页、回复卡片、需要你、输入框。
- motion.md：交互动效、时长与减少动态效果。
- content.md：文案、状态词、时间与数字。

## 维护

- 新组件或新状态：同时改 components.md、packages/ui/src/kit（含单元测试）、原型的组件页和画稿的组件板，检查浅色、深色和手机。
- 新 token：先确认现有角色表达不了，再只改 haven.ts。
- 本目录是目标规范。新 Web 落地前，v1 代码的旧约定只对旧代码有效（apps/web/src/AGENTS.md）。
