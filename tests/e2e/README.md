# E2E Security Tests

端到端安全测试套件，针对运行中的服务器实例验证安全边界。

## 与单元测试的区别

| | 单元测试 (`pnpm test`) | E2E 安全测试 (`pnpm test:e2e`) |
|---|---|---|
| 运行方式 | 自动/CI（in-process） | 自动/CI（live server，`test:e2e:ci`）+ 手动 |
| 依赖 | 无外部依赖 | 需要运行中的 API 服务 |
| 速度 | 快 (~1.5s) | 慢 (~2min，逐条真实 HTTP) |
| 覆盖 | 函数级别逻辑 | 真实 HTTP 请求端到端 |
| 配置 | `vitest.config.ts` | `vitest.e2e.config.ts` |

## 运行方法

### 方式 A：一条命令（CI 用的就是这个）

`scripts/e2e-ci.sh` 会自动起 API（指向一个必失败的 LLM 端点，无真实调用/费用）、等待
`/health`、跑套件、结束后关服务器。需要一个已 migrate 的 Postgres（默认 `greenhouse_test`）。

```bash
pnpm test:e2e:ci
```

`E2E_NO_LLM=1` 会跳过 `v1-api` 里两个需要真实模型回答内容的断言。要跑这两个，用下面方式 B
带真实 LLM key 启动服务器。

### 方式 B：手动两个终端

#### 1. 启动测试服务器（终端 1）

```bash
API_PORT=3999 ACCESS_PASSWORD=test-secret TOKEN_SIGNING_KEY=test-secret pnpm api
```

#### 2. 运行 E2E 测试（终端 2）

```bash
API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm test:e2e
```

### 运行特定测试文件

```bash
API_PORT=3999 ACCESS_PASSWORD=test-secret pnpm vitest run tests/e2e/auth-security.e2e.test.ts --config vitest.e2e.config.ts
```

## 测试套件

| 文件 | 覆盖范围 |
|------|---------|
| `auth-security.e2e.test.ts` | 认证令牌验证、密码暴力破解、公开路径、授权访问控制 |
| `injection-security.e2e.test.ts` | 路径穿越、SQL/FTS 注入、Prompt 注入、XSS、请求体滥用 |
| `data-isolation.e2e.test.ts` | Profile 工具边界、Session 数据隔离、知识库写保护、信息泄露 |
| `ratelimit-upload.e2e.test.ts` | 速率限制、文件上传安全、响应头安全 |
| `tool-access-control.e2e.test.ts` | 用户-工具权限边界、工具分配 API |
| `profile-access-control.e2e.test.ts` | Profile 访问控制、角色过滤 |
| `role-escalation.e2e.test.ts` | 角色提权防护、禁用用户隔离 |
| `v1-api.e2e.test.ts` | V1 外部 API 认证、会话隔离、Profile 限制、禁用客户端 |
| `user-management.e2e.test.ts` | 用户 CRUD、角色权限、密码重置、配额、禁用用户 |
| `session-crud.e2e.test.ts` | Session CRUD、跨用户隔离、外部用户限制 |
| `session-shared-list.e2e.test.ts` | 共享 Session 在列表中的可见性与标记 |
| `agent-proxy.e2e.test.ts` | Agent 代理认证、运行时 manifest、工具调用、写操作 confirm 门控、default profile |
| `api-clients.e2e.test.ts` | API 客户端 CRUD、Key 轮换、用量审计 |

## 注意事项

- Prompt 注入测试会触发真实 LLM 调用（使用 `default` profile），会产生少量 API 费用
- 某些测试创建 sessions 后会自动清理，但如果测试中断可能留下孤儿数据
- 速率限制测试可能需要等待限速窗口重置才能重复运行
- 超时设置为 60 秒/测试（LLM 响应时间）

## 添加新测试

创建 `tests/e2e/your-test.e2e.test.ts`，遵循现有文件的结构模式：

```typescript
import { describe, it, expect, beforeAll } from "vitest";

const BASE_URL = `http://localhost:${process.env.API_PORT || 3999}`;
const PASSWORD = process.env.ACCESS_PASSWORD || "test-secret";

beforeAll(async () => {
  // Verify server is running
  const res = await fetch(`${BASE_URL}/health`);
  if (!res.ok) throw new Error(`Server not running at ${BASE_URL}`);
});

describe("E2E: Your Test Suite", () => {
  it("test case", async () => {
    // ...
  });
});
```
