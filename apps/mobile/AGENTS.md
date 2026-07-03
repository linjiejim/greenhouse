# 移动端（@greenhouse/mobile）

Expo SDK 56 / React Native 0.85 / React 19 应用，从 letpot-greenhouse（本仓的下游 fork）的 apps/mobile 搬迁适配而来。功能：**对话（AI-first，流式 Agent 聊天 + 图片上传 + Agent Profile 切换）· 知识库（只读浏览）· 设置（主题/语言/账号）**。设计对齐 web 的 **Teal 设计系统**（light + dark 双色板，跟随系统）。

## 关键约束（容易踩坑）

- **不是 pnpm workspace 成员**。`pnpm-workspace.yaml` 用 `!apps/mobile` 显式排除——它的 React-19 / RN 依赖图若被 hoist 进共享 store 会污染 web/api 的 React 类型。
  - 安装：在本目录运行 `pnpm install --ignore-workspace`（或根目录 `pnpm mobile:install`），依赖全部落在 `apps/mobile/node_modules`，有自己的 `pnpm-lock.yaml`。
  - **不要用 `npx expo install` 装依赖**——它会绕过隔离、把 apps/mobile 作为 importer 写进**根** `pnpm-lock.yaml`（已踩过）。正确做法：手动在 package.json 里钉版本（SDK 56 的包一般是 `~56.x`），再 `pnpm install --ignore-workspace`。
  - 不要 `import '@greenhouse/types'` 等 workspace 包。需要的类型在 [src/shared/greenhouse-types.ts](./src/shared/greenhouse-types.ts) 里 **vendored**（复制子集，头注释指向 canonical 源 `packages/types/src/api.ts`）。服务端形状变了要同步改这里。
  - **TODO（待办）**：letpot 的 `packages/contract/src/mobile-parity.ts` 是现成模板，可加同款 CI 绊网把 vendored 类型与真相做可赋值断言，防漂移。
  - **Metro 也要隔离**：[metro.config.js](./metro.config.js) 用 `resolver.blockList` 屏蔽**仓库根** `node_modules`，否则 Metro 的逐层向上查找会捞到泄漏的重复依赖（曾致 `react-native-worklets` 原生/JS 版本不匹配）。新增原生模块若报 "version mismatch"，先查根 `node_modules` 泄漏。
- **原生工程不入库**。`/android`、`/ios` 由 `expo prebuild`（CNG）生成，已在 `.gitignore`。`expo prebuild --clean` 会清掉 `android/local.properties`，真机构建前需补 `sdk.dir`（或导出 `ANDROID_HOME`）。
- **Expo Go 跑不了**：`expo-secure-store` / `react-native-keyboard-controller` 需要 dev client（`pnpm mobile:ios` / `pnpm mobile:android` 构建）。开发期大部分 UI 可用 `pnpm mobile:web`（Expo web）验证。
- **`.env` 不入库**（`EXPO_PUBLIC_API_BASE_URL`）。默认 `http://localhost:3000`（见 [src/config.ts](./src/config.ts)）；Android 模拟器用 `10.0.2.2:3000`，真机用 Mac 的 LAN IP。
- **Expo web 开发要给 API 配 CORS**：API 的 CORS 是白名单制（`CORS_ALLOWED_ORIGINS` env）。本地跑 `pnpm mobile:web`（8081 端口）时启动 API 要带 `CORS_ALLOWED_ORIGINS=http://localhost:8081`。原生 app 无 Origin 头，不受影响。

## 约定

- 路由用 expo-router（文件即路由，`app/`）；根布局 [app/_layout.tsx](./app/_layout.tsx) 负责 auth 引导 + prefs 水合 + 路由门禁，并提供 `GestureHandlerRootView` + `KeyboardProvider` + `SafeAreaProvider` + `BottomSheetModalProvider`。每屏自绘 header，native stack `headerShown:false`。
- **对话即首页**：[app/index.tsx](./app/index.tsx) 是 AI hero（输入即开新会话，会话在创建时绑定 prefs 里选的 profile）。顶栏左上 **☰** 抽屉（账号 + 历史 + 设置 + 退出）；右侧 **[智能体][知识库]** 胶囊——智能体开 [src/chat/profile-sheet.tsx](./src/chat/profile-sheet.tsx)，知识库进 [app/knowledge/](./app/knowledge)。
- **主题**：[src/theme.ts](./src/theme.ts) 双色板（light/dark，值来自 web 的 `packages/ui/src/styles/tokens.css`，改 web 色板要同步）。组件样式一律 `const useStyles = makeStyles((c) => ({...}))` 工厂 + 组件内 `const { colors: c } = useTheme(); const styles = useStyles(c);`。**不要**在模块级引用色值。偏好 system/light/dark 存 prefs。
- **i18n**：[src/lib/i18n/](./src/lib/i18n)（本地 40 行实现，workspace 隔离导不了 @greenhouse/ui）。en.ts 是 key 真相源，key 命名对齐 web 的 `chat.*`/`settings.*`。组件内用 `useT()`，非组件（format.ts）用 `t()`。新增文案必须双语。已知缺口：format.ts 的 `TOOL_LABELS`/`CAT_LABELS` 仍是中文硬编码。
- **键盘避让**：不要用 RN 的 `KeyboardAvoidingView`。用 `react-native-keyboard-controller` 的封装 [src/lib/keyboard.ts](./src/lib/keyboard.ts)：`useBottomPadStyle`（根容器）+ `useCollapsingInsetStyle`（composer bar）。
- **两个真机踩坑**（继承自 letpot，都已修）：
  - **Hermes 日期解析**比浏览器严格：Postgres 时间戳 `"… 05:05:34.202+00"` 直接 `new Date()` 是 Invalid Date。一律走 [src/lib/format.ts](./src/lib/format.ts) 的 `parseMs()`。
  - **gorhom 列表不滚动**：`@gorhom/bottom-sheet` v5 内容滚动手势失灵，`Sheet` 的 `nativeScroll` 开关改用原生 `FlatList` 自己滚。长列表 sheet 都走这条。
- **UI kit 在 [src/ui/](./src/ui)**：`core`（Touchable/Icon/Spinner/Caret）、`sprouty`（**SproutyFace 吉祥物**，vendored 自 `packages/ui/.../sprouty-face-svg.ts` 的静态 SVG 子集：剥掉了 CSS 动画与 fx 层，呼吸动画用 Reanimated 包裹；web 吉祥物几何变了要同步）、`widgets`、`sheet`、`drawer`、`haptics`。
- **对话相关在 [src/chat/](./src/chat)**：`composer`（多行输入 + 附件缩略图条 + 全屏编辑）、`markdown`（富 markdown 渲染，knowledge 详情也复用）、`message`（AiMessage 工具管线/推理/引用/指标 + thinking 位 Sprouty、UserMessage 图片渲染）、`history-*`、`profile-sheet`。
- **API 层在 [src/api/](./src/api)**：`client.ts`（401 透明刷新）、`chat.ts`（`expo/fetch` 流式 NDJSON → `handleStreamEvent`，消息可带 `images`）、`sessions.ts`、`knowledge.ts`（只读）、`upload.ts`（图片 ≤1024px 压缩 → `POST /api/upload`，**仅图片**，服务端 5MB/魔数校验）、`token-storage.ts`（SecureStore/localStorage + 内存镜像，也承载 prefs 持久化）。
- 偏好（主题/语言/profile）在 [src/store/prefs.ts](./src/store/prefs.ts)（zustand + 持久化，`hydrate()` 在 _layout 调一次）。
- **范围边界（本期不做）**：项目管理、语音输入、非图片附件、知识库编辑、会话分享/重命名/导出（菜单占位 toast）、session channel 上报（记为 web）。
- 命令（根目录）：`pnpm mobile:install` / `pnpm mobile`（dev client）/ `pnpm mobile:web` / `pnpm mobile:ios` / `pnpm mobile:android` / `pnpm mobile:prebuild`；本目录 `pnpm typecheck`、`pnpm lint`。根仓的 lint/typecheck/prettier 均已排除本目录（eslint.config.js ignores、tsconfig exclude、.prettierignore）。
