---
name: add-agent-tool
description: >-
  在 greenhouse 新增一个 Agent 可调用的工具：defineTool 把 meta 与实现写在同一个文件 →
  registry.ts 显式 import 进 CORE_TOOL_MODULES → surface 决定 proxy/MCP 暴露 →
  权限归属 feature point → 测试。用户说加个工具、新增 agent tool、让模型能调用 xx、
  加个 function calling 时使用。核心红线：没有 tools/index.ts；元数据必须与实现同文件；
  非全局工具必须恰好属于一个功能点。
---

# 新增 Agent 工具

> 规范事实源：[apps/api/src/tools/define.ts](../../../apps/api/src/tools/define.ts) 的头注释
> （字段语义最权威）、[apps/api/src/AGENTS.md](../../../apps/api/src/AGENTS.md)、
> [apps/api/src/profiles/AGENTS.md](../../../apps/api/src/profiles/AGENTS.md)。

## 前置判断

1. **core 还是 extension？** 私有 / 可选模块的工具走扩展缝：
   `defineExtension({ tools: [...] })`，见 [EXTENDING.md](../../../EXTENDING.md) 与
   `apps/api/src/extensions/example/tool.ts`。扩展工具的 `meta.surface` 与 core 工具语义完全一致。
2. **能不能不加工具？** 先看现有工具能否扩一个 action（多数工具是 `action` 枚举式的
   query / mutation 对）。根 AGENTS.md 的 anti-entropy 要求登记"为什么不能复用"。
3. 工具数量会稀释注意力——一个 profile 装配 4–9 个是舒适区。

## 步骤 1：实现 + 元数据（同一个文件）

在 `apps/api/src/tools/` 下建文件（复杂工具建子目录，如 `compute/`、`external-search/`、`skills/`）。
**`meta` 与实现必须写在同一个文件里**，用 `defineTool` 聚合：

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { defineTool, type ToolMeta } from './define.js';

// ─── Metadata (co-located with the implementation) ───────
const meta: ToolMeta = {
  id: 'my_tool',              // 全局唯一，snake_case
  name: 'My Tool',            // 前端显示名
  brief: '一行摘要',            // 目录 / 权限 UI 用，**永不注入 prompt**
  description: `完整使用说明…`,  // 作为 AI SDK tool({ description }) 下发给模型
  category: 'team',           // 'core' | 'team' | 'admin'
  is_global: false,           // true = 内部用户默认可用，无需分配
  icon: 'Wrench',             // Lucide 图标名
  sort_order: 15,
};

const mySchema = z.object({
  action: z.enum(['list', 'get']).describe('操作类型'),
  id: z.string().optional().describe('资源 ID'),
});

export function createMyTool() {
  return tool({
    description: meta.description,   // 引用 meta，不要另写一份
    inputSchema: mySchema,
    execute: async ({ action, id }) => {
      // …
    },
  });
}

export const myTool = defineTool({ meta, create: createMyTool });
```

- 参数用 Zod schema，每个字段加 `.describe()`
- `description` 就用 `meta.description`（单一来源，与 `inputSchema` / `execute` 同处）
- 需要 user / session / db 上下文的工具用 lazy 形态（`createLazy(ctx)`），不要在 core 里加 per-tool 特判

## 步骤 2：注册进 registry

在 `apps/api/src/tools/registry.ts`：显式 `import { myTool } from './my-tool.js';`
并加进 `CORE_TOOL_MODULES` 数组。

**没有 `tools/index.ts`。** registry 从这一个数组派生全部聚合视图（元数据列表、全局 id、
已知工具名、静态工厂），刻意不用 glob / 副作用自注册——那样会静默丢工具。

## 步骤 3：`surface`——决定能不能被 proxy / MCP 调到

`meta.surface` 是 proxy / MCP 暴露的**唯一声明式来源**，registry 从中派生
`READONLY_PROXY_ALLOWLIST` / `MUTATING_PROXY_ALLOWLIST` / `MCP_EXPOSED_TOOL_IDS`：

| 写法 | 含义 |
| --- | --- |
| 不写 / `proxy: 'none'` | 只在 chat 等装配面可用，`/api/agent`、`/api/mcp` 够不着 |
| `proxy: 'read'` | 进只读 proxy 白名单，无确认门 |
| `proxy: 'write'` | 进写入 proxy 白名单，**每次调用需 `confirm: true`** |
| `mcp: '<group>'` | 额外经 `/api/mcp` 暴露，且**必须同时有 proxy 层级** |
| `workbench: true` | 可被 Home 工作台卡片绑定（比只读 proxy 更窄） |

MCP 的 group 就是用户实际同意的东西（OAuth 授权带 `mcp:<group>` scope）。
**读写混装、或确认门对它没有意义的工具，刻意不给 `surface`**——标成 read 等于让无状态调用方绕过确认门写数据。

## 步骤 4：权限归属

- `is_global: true` 的工具对内部用户默认可用，不需要分配
- **非全局工具必须恰好属于一个 feature point**（注册表在
  [apps/api/src/platform/feature-points.ts](../../../apps/api/src/platform/feature-points.ts)，
  用户面是 Administration → Users → 权限弹框）。不属于任何点的工具没人分配得到
- 无人值守上下文（定时任务 / workflow 节点 / headless 子会话）另有 fail-closed 白名单与
  denylist，见 `agent-runtime/tool-resolution.ts`；需要真人按确认的工具不要指望在那里可用

## 步骤 5：工具描述与错误文案的写法

工具的 description 和错误分支**都是 prompt 的一部分**，按 prompt 的标准写：

- **能力声明必须真实**：未配置 / 未实现的路径要显式报错，不能假装
- **失败提示不许指向调用方没有的工具**，也不许指向一个到了也办不成的地方——
  没有出口比假出口好
- **错误文案要指路**，不只是判定："not found" 会让模型再猜一个 id；
  写清下一步（"改用 search 找 id"）模型下一轮就自愈
- **插值的动态值一律加引号**：写 `(ID: "${id}", Name: "${name}")`。
  不加引号会逃逸 friction 归一化，同一个坑被排成很多条偶发噪声
- **检索类工具要把"库是空的"与"这个词没命中"分开说**——两者下一步相反
- ⚠️ 工具描述里插值的常量要住**零 import 叶子模块**（如 `llm/memory-limits.ts` 的写法）：
  `registry.ts` 导入全部工具模块，常量若藏在会连到 db/security 的模块后面，一旦成环就是 TDZ，
  **单测全绿但 API 起不来**

## 步骤 6：Profile 关联（多数情况**不需要**）

系统 profile 的 YAML `tools:` 列表在运行时**不被读取**（chat、fork、定时任务同口径），
所以新增工具**不需要**去改 `sprouty.yaml`。装配由 `resolveEffectiveTools` 按
用户权限 ∪ 全局工具计算。custom Agent 可以用自己的 `tools` 数组**收窄**（只能收窄，不能放大）。

## 步骤 7：测试

- 工具单测放 `tests/api/`（或工具目录下的 `__tests__/`），覆盖各 action、参数校验、权限
- ⚠️ **动态 `import()` 一个 CJS 包必须走 `default`，vitest 全绿不等于 Node 全绿**——
  vitest 的 interop 会合成具名绑定，真实 Node ESM 加载器不会。这类 bug 只有真 Node 进程抓得到：
  用 `tsx` 或 `node --input-type=module` 直接加载真实源文件验证

## 步骤 8：门禁

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## 检查清单

- [ ] 判断过 core vs extension，且登记过"为什么不能扩现有工具"
- [ ] `meta` 与实现同文件，经 `defineTool({ meta, create })` 导出
- [ ] `description` 引用 `meta.description`，无第二份副本
- [ ] Zod schema 每个字段有 `.describe()`
- [ ] `registry.ts` 显式 import + 加进 `CORE_TOOL_MODULES`
- [ ] `category` / `is_global` / `icon` / `sort_order` 填好
- [ ] `surface` 想清楚了（不给也是一种明确选择）；给了 `mcp` 的同时给了 `proxy`
- [ ] 非全局工具归属到恰好一个 feature point
- [ ] 错误文案指路 + 动态值加引号；能力声明真实
- [ ] 描述用的常量住零 import 叶子模块（无 import 环）
- [ ] 测试覆盖；涉及 CJS 动态 import 的用真 Node 验证过
- [ ] typecheck + lint + test 通过
