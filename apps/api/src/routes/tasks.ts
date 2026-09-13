/**
 * Scheduled Tasks routes — /api/tasks
 *
 * GET    /api/tasks          — 列出定时任务（super 可见全部）
 * POST   /api/tasks          — 创建定时任务
 * GET    /api/tasks/:id      — 任务详情 + 最近执行会话
 * GET    /api/tasks/:id/runs — 执行历史（会话 + Runtime run 状态/错误/时长）
 * PUT    /api/tasks/:id      — 更新定时任务
 * DELETE /api/tasks/:id      — 删除定时任务（保留历史会话）
 * POST   /api/tasks/:id/run  — 手动触发一次执行
 *
 * Permission: internal+ (team, super).
 *
 * Thin protocol adapter — validation, quota, the hidden-profile gate and the
 * scheduler coupling all live in scheduler/task-center.ts, shared with the
 * automation_query / automation_mutation agent tools. Scope 'any' is what makes
 * this the admin surface: a super may reach other users' tasks here, never
 * through the tools.
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import {
  createTask,
  deleteTask,
  getTask,
  listTaskRuns,
  listTasks,
  runTaskNow,
  updateTask,
  type TaskActor,
  type TaskErrorCode,
} from '../scheduler/task-center.js';
import type { AuthUser } from '../auth/token.js';
import type { AppEnv } from '../app-env.js';
import { withOwnerNicknames } from '../user-display.js';

/** Center error codes → HTTP statuses. */
const STATUS_BY_CODE = {
  invalid: 400,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 500,
  internal: 500,
} as const satisfies Record<TaskErrorCode, 400 | 403 | 404 | 409 | 500>;

function statusFor(code: TaskErrorCode): 400 | 403 | 404 | 409 | 500 {
  return STATUS_BY_CODE[code];
}

/**
 * The console reaches every user's tasks for a super; tools never do.
 *
 * It is also the ONLY caller allowed to set `unattended_tools` — this request
 * carries the user's own Bearer and the value came from checkboxes in the
 * Automation form. `automation_mutation` pins `canGrantTools` off, so a chat
 * model cannot grant an unattended write tool to itself.
 */
function consoleActor(user: AuthUser): TaskActor {
  return { userId: user.id, role: user.role, scope: 'any', canGrantTools: true };
}

// ─── Route Factory ───────────────────────────────────────

export function createTasksRoute() {
  return (
    new Hono<AppEnv>()
      /**
       * GET /api/tasks — List scheduled tasks (own; super sees all).
       */
      .get('/', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const result = await listTasks(getDb(), consoleActor(user));
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({ tasks: await withOwnerNicknames(getDb(), result.tasks, user.id) });
      })
      /**
       * POST /api/tasks — Create a scheduled task.
       */
      .post('/', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const body = await c.req.json();
        const result = await createTask(getDb(), consoleActor(user), body);
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({ task: result.task }, 201);
      })
      /**
       * GET /api/tasks/:id — Get task detail + recent execution history.
       */
      .get('/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const result = await getTask(getDb(), consoleActor(user), parseInt(c.req.param('id'), 10));
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({ task: result.task, recent_runs: result.recent_runs });
      })
      /**
       * GET /api/tasks/:id/runs — Execution history: every task session, with
       * the durable Runtime run (status / error / timing) joined on where one
       * exists. Legacy pre-Runtime runs appear with `run: null`.
       */
      .get('/:id/runs', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const result = await listTaskRuns(getDb(), consoleActor(user), parseInt(c.req.param('id'), 10));
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({ task: result.task, entries: result.entries });
      })
      /**
       * PUT /api/tasks/:id — Update a scheduled task.
       */
      .put('/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const body = await c.req.json();
        const result = await updateTask(getDb(), consoleActor(user), parseInt(c.req.param('id'), 10), body);
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({ task: result.task });
      })
      /**
       * DELETE /api/tasks/:id — Delete a task (keeps historical sessions).
       */
      .delete('/:id', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const result = await deleteTask(getDb(), consoleActor(user), parseInt(c.req.param('id'), 10));
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({ ok: true });
      })
      /**
       * POST /api/tasks/:id/run — Manually trigger a task execution.
       * Creates session immediately and returns. Agent runs in background.
       */
      .post('/:id/run', async (c) => {
        const user = (c.get as (key: string) => AuthUser | undefined)('user');
        if (!user) return c.json({ error: 'Authentication required' }, 401);

        const result = await runTaskNow(getDb(), consoleActor(user), parseInt(c.req.param('id'), 10));
        if (!result.ok) return c.json({ error: result.error }, statusFor(result.code));

        return c.json({
          ok: true,
          session_id: result.session_id,
          message: `Task "${result.name}" started`,
        });
      })
  );
}
