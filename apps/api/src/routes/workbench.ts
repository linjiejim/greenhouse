/**
 * Home 工作台求值 — /api/workbench
 *
 * POST /api/workbench/query — 批量求值首页卡片（数据卡 + 导航卡 + 编辑器预览）
 *
 * 卡片配置只存"要问什么"（toolId + input），不存答案，所以每次渲染都在这里以
 * 当前用户身份重新执行一次——权限被收回时卡片变灰，而不是继续显示旧数据。
 *
 * 权限链与工具面的求值共用 `workbench/evaluate.ts` 一份实现（详见其头注释），
 * 这里只做协议适配：解析请求、按 widgetId 取已存配置、并发跑、逐卡回包。
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { runWithConcurrency } from '@greenhouse/utils/concurrency';
import { WORKBENCH_LIMITS, isDataWidget, isNavWidget, type WorkbenchQueryResult } from '@greenhouse/types/workbench';
import type { AppEnv } from '../app-env.js';
import type { ToolRegistry } from '../agent.js';
import { resolveUserTools } from '../agent.js';
import { getAuthUser } from '../auth/middleware.js';
import { buildLazyServerTools } from '../agent-runtime/tool-resolution.js';
import { WORKBENCH_READ_TOOL_IDS } from '../tools/registry.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { createWorkbenchEvaluator, type SourceOutcome } from '../workbench/evaluate.js';

/** Tool calls issued in parallel for one request. */
const QUERY_CONCURRENCY = 4;

export function createWorkbenchRoutes(toolRegistry: ToolRegistry) {
  return new Hono<AppEnv>().post('/query', async (c) => {
    const user = getAuthUser(c);
    const body = (await c.req.json().catch(() => null)) as { requests?: unknown } | null;
    const requests = Array.isArray(body?.requests) ? body.requests : null;
    if (!requests) return c.json({ error: 'requests must be an array' }, 400);
    if (requests.length > WORKBENCH_LIMITS.maxQueryRequests) {
      return c.json({ error: `At most ${WORKBENCH_LIMITS.maxQueryRequests} requests per call` }, 400);
    }
    if (requests.length === 0) return c.json({ results: [] as WorkbenchQueryResult[] });

    const db = getDb();
    const { allowedTools } = await resolveUserTools(user.id, user.role);
    const registry: ToolRegistry = {
      ...toolRegistry,
      ...buildLazyServerTools(db, allowedTools, {
        userId: user.id,
        userRole: user.role,
        workspaceId: c.req.header('X-Workspace') ?? null,
      }),
    };
    const evaluator = createWorkbenchEvaluator({
      userId: user.id,
      registry,
      readableToolIds: allowedTools.filter((id) => WORKBENCH_READ_TOOL_IDS.has(id)),
    });

    // Widget sources are read from the stored config, never from the request
    // body: accepting a client-supplied saved widget would defeat the whole
    // saved-intent model — anyone could ask for anything and call it their card.
    const stored = await db.platform.getUserWorkbenchPreferences(PLATFORM_ORG_ID, user.id);
    const widgetsById = new Map(stored.widgets.map((widget) => [widget.id, widget]));

    function toResult(index: number, outcome: SourceOutcome): WorkbenchQueryResult {
      return outcome.ok
        ? { index, ok: true, data: outcome.data }
        : { index, ok: false, error: outcome.error, ...(outcome.message ? { message: outcome.message } : {}) };
    }

    async function evaluateRequest(request: unknown, index: number): Promise<WorkbenchQueryResult> {
      const entry = request && typeof request === 'object' ? (request as Record<string, unknown>) : {};

      if (typeof entry.widgetId === 'string') {
        const widget = widgetsById.get(entry.widgetId);
        if (!widget) return { index, ok: false, error: 'not_found' };
        if (isDataWidget(widget)) return toResult(index, await evaluator.evaluateSource(widget.source));
        if (isNavWidget(widget)) return { index, ok: true, nav: await evaluator.evaluateNavTarget(widget.target) };
        // Text cards carry their own content and never reach the server.
        return { index, ok: false, error: 'invalid' };
      }

      // No inline variant: a source is only ever evaluated because it was saved
      // as one of this user's cards.
      return { index, ok: false, error: 'invalid' };
    }

    const results: WorkbenchQueryResult[] = [];
    await runWithConcurrency(
      requests.map((request, index) => ({ request, index })),
      QUERY_CONCURRENCY,
      async ({ request, index }) => {
        results.push(await evaluateRequest(request, index));
      },
    );
    results.sort((left, right) => left.index - right.index);
    return c.json({ results });
  });
}

export default createWorkbenchRoutes;
