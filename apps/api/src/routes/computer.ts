/**
 * 云电脑 — the member's own cloud computer, and the admins' view of every
 * running one (v1.6; lifecycle and billing in computer/service.ts).
 *
 * Member (/api/computer, internal users):
 *   GET  /        — switch / key state, per-minute price, my computer, minutes this month
 *   POST /start   — start my computer (refused while the switch is off, the key is missing or the workspace is full)
 *   POST /stop    — stop my computer
 *
 * Admin (/api/admin/computers, super only — behind /api/admin/*'s requireSuper):
 *   GET  /          — the switch, the limit and every computer holding a slot
 *   POST /:id/stop  — stop one; recorded in the platform audit (`stopMemberComputer`)
 *
 * The switch itself is the workspace setting `computer.enabled`, written through
 * PUT /api/admin/settings like every other setting (audited there).
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { humanActor } from '../platform/actor.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { findBudgetRefusal } from '../usage/budget-errors.js';
import { meteringClientForRequest } from '../usage/metering.js';
import {
  ComputerUnavailableError,
  adminComputersReport,
  computerView,
  ensureComputer,
  myComputerReport,
  stopComputer,
  stopMemberComputer,
} from '../computer/service.js';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';

export const computerRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = getAuthUser(c);
    return c.json(await myComputerReport(getDb(), user.id));
  })
  .post('/start', async (c) => {
    const user = getAuthUser(c);
    try {
      const computer = await ensureComputer({
        db: getDb(),
        userId: user.id,
        scope: { userId: user.id, client: meteringClientForRequest(c) },
      });
      return c.json({ computer: computerView(computer.row), started: computer.started });
    } catch (error) {
      if (error instanceof ComputerUnavailableError) {
        return c.json({ error: error.message, code: error.code }, error.status);
      }
      const refusal = findBudgetRefusal(error);
      if (refusal) return c.json({ error: refusal.message, code: 'usage_budget_exceeded' }, 429);
      logger.warn('[computer] start failed', { user: user.id, error: toErrorMessage(error) });
      return c.json({ error: 'The cloud computer could not be started. Try again later.' }, 502);
    }
  })
  .post('/stop', async (c) => {
    const user = getAuthUser(c);
    const stopped = await stopMemberComputer(getDb(), user.id, 'user');
    return c.json({ computer: stopped ? computerView(stopped) : null });
  });

export const adminComputerRoutes = new Hono<AppEnv>()
  .get('/', async (c) => c.json(await adminComputersReport(getDb())))
  .post('/:id/stop', async (c) => {
    const admin = getAuthUser(c);
    const db = getDb();
    const row = await db.memberComputers.get(c.req.param('id'));
    if (!row) return c.json({ error: 'Not found' }, 404);
    if (row.status !== 'running') return c.json({ error: `The computer is ${row.status}` }, 409);
    const stopped = await stopComputer(db, row, 'admin');
    if (!stopped) return c.json({ error: 'The computer is already stopping' }, 409);
    await db.platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: admin.id,
      actorType: 'human',
      requestId: humanActor(admin, c).requestId,
      resource: { appId: 'platform', moduleId: 'settings', entityId: 'memberComputer', recordId: row.id },
      actionId: 'stopMemberComputer',
      capability: 'platform.settings.manage',
      result: 'success',
      summary: { detail: `stopped the cloud computer of ${row.user_id}`, user_id: row.user_id },
    });
    return c.json({ computer: computerView(stopped) });
  });
