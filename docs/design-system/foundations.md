# 基础

数值都在 packages/ui/src/tokens/haven.ts，CSS 变量前缀是 --gh-（例如 --gh-accent、--gh-type-body、--gh-space-4）。本文只写怎么用。

## 颜色

- 表面从里到外：canvas 工作区；chrome 模块目录与工具区；rail 全局栏；surface 输入框与卡片；raised 菜单、浮层、对话框、抽屉。
- fill 是控件底和弱填充；hover、pressed 只用于交互态；selection 是当前项的底色。
- 文字三档：text 正文；secondary 次要信息（4.5:1）；tertiary 给占位文字、「?」与元信息；浅色在 canvas、chrome、surface 上至少 4.5:1。
- 线：line 分隔区域，浅色在 canvas 上至少 1.45:1；controlLine 是输入框等控件的边（3:1）。
- accent 只用于主操作、当前项和焦点；accentText 用于链接和文字按钮；onAccent 是强调底上的文字。
- 状态色 success、warning、danger、info 各有前景与浅底一对。黄色只表示需要你，红色只表示失败或危险。danger 另有悬停深一级的 dangerHover、dangerFillHover，和实红底上的文字 onDanger。
- 品牌标志用 brandMark（房子）和 brandSeed（种子），不随工作区主色变化；种子是装饰色，浅色背景上不到 3:1。
- 分类色（gray 到 pink）给用户自定义的标签和选项；图表按 chart-1 到 chart-8 的顺序取色，第一色是 accent。
- 组件里不写死颜色。深浅色由 data-theme 切换；跟随系统时由媒体查询决定。

## 字体

- Nunito 加中文回退；代码用等宽字族。
- 字号阶梯：caption 元信息；label 字段标签与按钮；bodySm 紧凑正文与表格；body 正文；bodyLg 回复正文；titleSm 区块与卡片标题；title 抽屉、对话框、目录标题；titleLg 页面标题；display 只用于登录页这类场合；code 代码。
- 任何文字不小于 12px。数字列用等宽数字。

## 间距与圆角

- 间距用 4 的倍数（另有 2 用于极小的间隙）。控件内边距 12，字段之间 16，区块之间 32。
- 圆角：xs 复选框；sm 徽标与菜单项；md 按钮、输入框、目录行；lg 卡片、菜单、浮层；xl 对话框；2xl 输入框（对话）；sheet 手机底部 Sheet；full 圆形。
- 线宽：hairline 分隔线和控件边；control 复选框与单选框；strong 选中的下划线和焦点框。

## 尺寸

- 控件三档高度：sm 28 用于表格内和紧凑工具栏；md 36 是默认；lg 44 用于触摸设备和登录这类主要入口。同一行的按钮和输入框等高。
- 行高：数据行 44，紧凑 36；目录行 32，主 Agent 行 52；手机上可点的行至少 44。
- 头像：sm 20 目录行；md 28 页头和卡片；lg 36 主 Agent；xl 72 空对话。
- 全局栏、目录、页头、抽屉和内容宽度见 layout.md。

## 阴影与层级

- 阴影两档：1 给浮起的小元素（分段控件的选中项、Tooltip）；2 给菜单、浮层、对话框、抽屉、Toast。卡片不加阴影。
- 层级从低到高：吸顶、页头、下拉、遮罩、抽屉、对话框、菜单与浮层、提示、Toast。弹层里打开的菜单仍在最上层。

## 动效

- fast 用于悬停和小元素，base 用于展开和淡入，slow 用于抽屉和 Sheet 进入，exit 用于退出。进入用 enter 曲线，退出用 exit 曲线，不做弹跳。
- 尊重「减少动态效果」：去掉位移和循环动画，只留必要的透明度变化。

## 图标

- Lucide，线宽 1.75；14 用于行内和「?」，16 用于按钮、菜单和目录，20 用于全局栏和标题。
- 只有图标的按钮必须有文字标签（aria-label 和悬停提示）。

## 焦点

- 键盘焦点是 2px accent 外框（stroke.strong），偏移 3px（stroke.focusOffset）。输入框、选择器改为边框变色加浅色外光，不叠外框。
- 菜单项、日历格子这类密集元素用贴边的焦点样式，不压到相邻元素。

## 主题与品牌

- 主题：浅色、深色、跟随系统。
- 品牌只开放名称、Logo 和一个主色。主色在 OKLCH 里派生悬停、按下和深色模式的值，必须通过对比度测试；不开放其他 token 覆盖。

## 浅色层次与对比度（#70，U1）

工作区用轻微灰绿的 canvas，目录用 chrome，全局栏用 rail；卡片、网格单元格、日历、输入框用白色 surface，抽屉与菜单用 raised。不要把 canvas 当成白色内容表面。层次同时依靠底色、边线与浮层阴影，不单靠阴影。深色 token 保持原值。

以下是 WCAG 相对亮度比，取自 haven.ts 的不透明颜色，由 haven.test.ts 守护；层次比不等同于文字的无障碍合格线。

| 配对 | 浅色比值 | 要求 |
| --- | --- | --- |
| surface / canvas | 1.10:1 | 底色可分辨，卡片另加 line |
| line / canvas | 1.55:1 | ≥1.45:1 |
| tertiary / canvas | 7.13:1 | ≥4.5:1 |
| tertiary / chrome | 6.65:1 | ≥4.5:1 |
| tertiary / surface | 7.88:1 | ≥4.5:1 |
| selection / chrome | 1.43:1 | ≥1.4:1，选中另有文字或标记 |
| hover / chrome | 1.16:1 | 悬停可辨，按下再深一级 |
| focus / canvas | 6.93:1 | ≥3:1，2px 外框，偏移 3px |

原生浅色使用同一组工作区、内容表面、分隔线和可读文字。iOS 的深色保留系统颜色，只有原来过淡的 tertiaryLabel 与 placeholder 调整为可读的不透明色；Android 的辅助文字统一使用 onSurfaceVariant。系统菜单、表单、导航和 sheet 继续由原生组件提供。
