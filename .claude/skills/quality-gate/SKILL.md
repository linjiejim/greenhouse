---
name: quality-gate
description: >-
  提交前跑 greenhouse 的完整质量门禁：typecheck → lint → test 三件套，再对本次改动做
  项目规范合规扫描（后端 logger / 前端语义色 / import 规范 / helper 复用 / 文档同步），
  最后出一张状态表。用户说跑一下门禁、检查代码质量、提交前自检、quality gate 时使用。
---

# 质量门禁

> 规则事实源：根 [AGENTS.md](../../../AGENTS.md) 的 Rules / Code quality / Testing 三节，
> 以及各模块的 AGENTS.md。本技能是执行清单。

## 步骤 1：三件套

```bash
pnpm typecheck     # tsc --noEmit --incremental
pnpm lint          # eslint + prettier --check（apps/ 与 packages/）
pnpm test          # 三层测试：unit / db / db-commit
```

- lint 失败先试 `pnpm lint:fix`，再重跑 `pnpm lint` 确认
- 迭代期想要快反馈：`pnpm test:unit`（纯逻辑）、`pnpm test:db`（真库）；
  **落地前必须跑完整 `pnpm test`**——不要为了省时间从默认命令里裁掉真实测试
- 动过鉴权 / 权限 / 跨用户隔离：补跑 `pnpm test:e2e:ci`（真 HTTP + 死 LLM 端点，确定性且免费）
- 动过前端交互：补跑 `pnpm test:e2e:ui`（Playwright）

## 步骤 2：规范合规扫描（只看本次改动的文件）

### 2.1 后端（`apps/api/`）

```bash
# 结构化日志：业务代码禁止 console.*（cli/ 是面向终端的输出，豁免）
grep -rn "console\.\(log\|warn\|error\)" apps/api/src/ --include="*.ts" \
  | grep -v "\.test\." | grep -v "^apps/api/src/cli/"
```

还要人工确认：

- 数据库操作经 `getDb().<域>.<方法>()`，**没有裸 SQL**
- 路由是**链式定义**（`new Hono<AppEnv>().get(...).post(...)`），工厂无 `: Hono` 返回注解
- 响应对象里**没有 `any`**（会让整条路由推导塌成 `never`）
- 传给 LLM 的用户输入过了 `sanitizeForPrompt()`
- 错误文案**指路**，且插值动态值**加引号**（`(ID: "${id}")`）

### 2.2 前端（`apps/web/`）

```bash
# 硬编码颜色（必须用语义 token）
grep -rn "bg-white\|text-gray-\|border-gray-\|bg-gray-\|bg-red-\|text-red-" \
  apps/web/src/ --include="*.tsx" --include="*.ts"

# 原生表单元素（应使用 ui.tsx 组件；ui.tsx 与 components/form/ 自身豁免）
grep -rn "<input \|<select \|<textarea " apps/web/src/ --include="*.tsx" \
  | grep -v "components/ui.tsx" | grep -v "components/form/"

# 原生弹窗
grep -rn "window\.confirm(\|[^.]alert(" apps/web/src/ --include="*.tsx" --include="*.ts"
```

还要人工确认：

- 常规页面根节点是 `<ModulePage>`，没有自建 header / padding / `max-w-*` / 滚动容器
- 图标来自 `lib/icons.ts`，**没有 emoji 当图标**
- 没有 `!important` 覆盖组件样式；没有 `dark:` 前缀（暗色靠 CSS 变量自动切）
- API 走 `lib/api/` + `rpc`，**没有用 `as` 压掉 hc 的类型漂移告警**
- `truncate` 旁边有 `title={value}`；移动端 ≥375px 可用

### 2.3 Import 规范

```bash
# 跨包必须用包名，不能走相对路径
grep -rn "from '\.\./\.\./\.\./packages\|from '\.\./\.\./\.\./apps" \
  apps/ packages/ --include="*.ts" --include="*.tsx" | grep -v node_modules

# 包内相对路径必须带 .js 扩展名（Node ESM）——粗筛，需人工确认
grep -rn "from '\.\{1,2\}/[^']*'" apps/api/src/ packages/*/src/ --include="*.ts" \
  | grep -v "\.js'" | grep -v "\.json'" | grep -v "\.test\."
```

### 2.4 别重复造轮子

改动里若出现自己写的工具函数，先查现成的（根 AGENTS.md 硬要求）：

- `@greenhouse/utils` 子路径：`date`（`nowIso()`）、`json`、`concurrency`（`runWithConcurrency()`）、
  `crypto`、`error`、`logger`、`prompts`、`semver`、`html`、`brand`
- 前端：`lib/utils.ts`
- 组件：先翻 `components/` 与设计预览页 `pages/design.tsx`

### 2.5 防熵增（anti-entropy）

- **删除要同步文档**：移除模块 / 页面 / 端点 / 表后，更新或删掉所有引用它的文档
- **删除要级联查孤儿**：grep 依赖方（组件、helper、类型、i18n key、导航项），
  删掉刚失去最后一个消费者的东西
- **加"第二个实现"必须在相关 AGENTS.md 登记理由**，否则不接受
- **不要预留抽象**：没有第二消费者的接口层 / 多后端抽象 / "将来用"的列
- **能力声明必须真实**：工具描述、UI 选项、文档不得声称未实现的能力；
  未配置路径要显式报错，不能假装

## 步骤 3：文档同步检查

| 改了什么 | 必须更新 |
| --- | --- |
| 表 / schema | `packages/db/src/db-schema.md` + `packages/db/src/AGENTS.md` |
| Agent profile | `apps/api/src/profiles/agent-profiles.md` |
| 后端约定 | `apps/api/src/AGENTS.md` |
| 前端组件 / 约定 | `apps/web/src/AGENTS.md` |
| Settings / Administration | `apps/web/src/pages/settings/AGENTS.md` |
| 扩展缝契约 | `EXTENDING.md` + `example` 扩展 + seam 测试 |
| 项目结构 / 跨域约定 | 根 `AGENTS.md` |
| 对人的行为变化 | `README.md` |
| 可见 UI 变化 | 重跑 `node scripts/capture-screens.mjs` |

## 步骤 4：汇报

```
## 质量检查报告

| 检查项 | 状态 | 备注 |
|--------|------|------|
| typecheck | ✅/❌ | |
| lint | ✅/❌ | |
| test | ✅/❌ | N passed, M failed |
| e2e（如触及） | ✅/❌/— | |
| 后端 console.* | ✅/❌ | |
| 前端硬编码颜色 | ✅/❌ | |
| 原生表单 / 弹窗 | ✅/❌ | |
| Import 规范 | ✅/❌ | |
| helper 复用 | ✅/❌ | |
| 防熵增（删除级联 / 无预留抽象） | ✅/❌ | |
| 文档同步 | ✅/❌ | |
```

失败项如实报红，不要为了让表好看而跳过或弱化检查。
