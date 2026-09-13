# E2E Security Tests

端到端安全测试套件，针对运行中的服务器实例验证安全边界。

## 与单元测试的区别

| | 单元测试 (`pnpm test`) | E2E 安全测试 (`pnpm test:e2e:ci`) |
|---|---|---|
| 运行方式 | 自动/CI | **自动/CI**（quality-gate 的 `e2e` job）+ 可本地 |
| 依赖 | 无外部依赖 | 脚本自起 API（死 LLM 端点 + 本地存储，零外呼） |
| 速度 | 快 (~1.5s) | ~3min（死 LLM 的重试退避占大头） |
| 覆盖 | 函数级别逻辑 | 真实 HTTP 请求端到端 |
| 配置 | `vitest.config.ts` | `vitest.e2e.config.ts` |

## 一条命令跑（CI 同款）

```bash
# 需要一个已 migrate 的 Postgres（一次性容器示例见 scripts/e2e-ci.sh 头部注释）
DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test pnpm test:e2e:ci
```

脚本先在隔离库中通过正式 DB service 创建一个一次性、active 的 `super` 用户，将其
真实 UUID 注入 token fixture；随后启动 API、把 LLM 指向必然拒连端点、清空 COS
凭据强制走本地存储，跑完自动拆服务并级联删除该用户。测试不使用 synthetic uid，
也不绕过生产鉴权。
在写入 fixture 前，脚本会强制检查 `DATABASE_URL`：默认只接受 loopback 主机且库名含
`test` 或 `e2e` 的一次性数据库，并把测试 API 绑定在 `127.0.0.1`。不要把此套件指向
共享 dev/prod 数据库。
套件断言与内部角色模型 `super > team` 对齐；`external`、`member`、`admin`
等历史角色只作为「旧 token 必须 fail closed」的守卫用例保留。

## 手动两终端方式（调试单个用例）

### 1. 创建一次性身份并启动测试服务器（终端 1）

```bash
export DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test
export E2E_SUPER_USER_ID="$(./node_modules/.bin/tsx tests/e2e/seed-users.ts seed)"
echo "$E2E_SUPER_USER_ID" # 复制给终端 2
API_HOST=127.0.0.1 API_PORT=3999 TOKEN_SIGNING_KEY=6666666666666666666666666666666666666666666666666666666666666666 pnpm api
```

### 2. 运行 E2E 测试（终端 2）

```bash
DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test \
  E2E_SUPER_USER_ID=复制终端1输出的UUID \
  API_PORT=3999 TOKEN_SIGNING_KEY=6666666666666666666666666666666666666666666666666666666666666666 pnpm test:e2e
```

### 运行特定测试文件

```bash
DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test \
  E2E_SUPER_USER_ID=复制终端1输出的UUID \
  API_PORT=3999 TOKEN_SIGNING_KEY=6666666666666666666666666666666666666666666666666666666666666666 \
  pnpm vitest run tests/e2e/auth-security.e2e.test.ts --config vitest.e2e.config.ts
```

调试结束后停止 API，并从任一终端清理 fixture：

```bash
DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test \
  ./node_modules/.bin/tsx tests/e2e/seed-users.ts cleanup "$E2E_SUPER_USER_ID"
```

## 测试套件

| 文件 | 覆盖范围 |
|------|---------|
| `auth-security.e2e.test.ts` | 认证令牌、内部账号状态、已删除入口、公开路径与授权访问控制 |
| `injection-security.e2e.test.ts` | 路径穿越、SQL/FTS 注入、Prompt 注入、XSS、请求体滥用 |
| `data-isolation.e2e.test.ts` | Profile 兼容映射、Session 数据隔离、信息泄露 |
| `ratelimit-upload.e2e.test.ts` | 速率限制、文件上传安全、响应头安全 |
| `tool-access-control.e2e.test.ts` | 用户-工具权限边界、工具分配 API |
| `profile-access-control.e2e.test.ts` | 内部 Profile 访问控制与旧 ID 映射 |
| `role-escalation.e2e.test.ts` | 角色提权防护、禁用用户隔离 |
| `user-management.e2e.test.ts` | 用户 CRUD、角色权限、密码重置、配额、禁用用户 |
| `session-crud.e2e.test.ts` | Session CRUD、跨用户隔离、未认证访问拒绝 |
| `session-shared-list.e2e.test.ts` | Session 分享列表与所有权标志 |
| `agent-proxy.e2e.test.ts` | 内部 Agent 工具代理认证、清单与写工具确认门 |
| `eval-system.e2e.test.ts` | 评测题库 CRUD、运行列表、权限控制 |
| `oauth-machine-clients.e2e.test.ts` | OAuth 机器客户端：创建/轮换/禁用、client_credentials 换 token、scope 收窄与审计 |

## 注意事项

- 本地手动运行时，少数 Chat 用例可能触发配置的 LLM；CI 脚本把模型地址固定到本机死端点，不会外呼
- `E2E_SUPER_USER_ID` 必须对应隔离测试库中的 active `super` 行；推荐始终使用 `pnpm test:e2e:ci` 自动管理
- E2E 会写入并删除大量 fixture；安全门默认拒绝非 loopback 或名称不含 `test/e2e` 的数据库
- 某些测试创建 sessions 后会自动清理，但如果测试中断可能留下孤儿数据
- 速率限制测试可能需要等待限速窗口重置才能重复运行
- 超时设置为 60 秒/测试（LLM 响应时间）

## 添加新测试

创建 `tests/e2e/your-test.e2e.test.ts`，遵循现有文件的结构模式：

```typescript
import { describe, it, expect, beforeAll } from "vitest";
import { BASE_URL } from "./helpers.js";

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
