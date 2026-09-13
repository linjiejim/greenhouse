import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { AgentRunRow, DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import type { AppEnv } from '../../app-env.js';
import { _setCloudAgentController } from '../../cloud-agent/index.js';
import type { CloudAgentController } from '../../cloud-agent/controller.js';
import { createCloudAgentRoutes } from '../cloud-agent.js';

let db: DatabaseProvider;
let owner: UserRow;
let run: AgentRunRow;

describe('Cloud Agent user approval route', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `approval-owner-${Date.now()}-${Math.random()}@test.local` });
    const workspace = await db.agentRuns.createWorkspace({ user_id: owner.id, name: 'approval' });
    run = await db.agentRuns.createRun({
      user_id: owner.id,
      workspace_id: workspace.id,
      title: 'approval',
      prompt: 'approval',
      model: 'pro',
    });
    run = (await db.agentRuns.transitionRun(run.id, ['queued'], { status: 'running' }))!;
    _setCloudAgentController({} as CloudAgentController);
  });

  afterEach(async () => {
    _setCloudAgentController(null);
    await db.close();
    _resetProvider();
  });

  it('lets only the run owner decide a pending approval', async () => {
    const approval = await db.agentRuns.requestApproval({
      run_id: run.id,
      user_id: owner.id,
      tool_id: 'crm_mutation',
      action: 'update_company',
      input_hash: 'owner-only',
      input_json: '{"action":"update_company"}',
      ttl_ms: 60_000,
    });
    const stranger = await createInternalTestUser(db, { email: `approval-other-${Date.now()}@test.local` });
    let requestUser = stranger;
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: requestUser.id, role: requestUser.role });
        await next();
      })
      .route('/', createCloudAgentRoutes());
    const decide = () =>
      app.request(`/runs/${run.id}/approvals/${approval.id}/decision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      });

    expect((await decide()).status).toBe(404);
    requestUser = owner;
    expect((await decide()).status).toBe(200);
    expect((await db.agentRuns.getApprovalById(approval.id))?.status).toBe('approved');
    expect((await decide()).status).toBe(409);
  });

  it('fails closed before writing a decision when Mission is unavailable', async () => {
    const approval = await db.agentRuns.requestApproval({
      run_id: run.id,
      user_id: owner.id,
      tool_id: 'crm_mutation',
      action: 'update_company',
      input_hash: 'runtime-closed',
      input_json: '{}',
      ttl_ms: 60_000,
    });
    _setCloudAgentController(null);
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: owner.id, role: owner.role });
        await next();
      })
      .route('/', createCloudAgentRoutes());

    const response = await app.request(`/runs/${run.id}/approvals/${approval.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });

    expect(response.status).toBe(503);
    expect((await db.agentRuns.getApprovalById(approval.id))?.status).toBe('pending');
  });

  it('does not approve work after its run is terminal', async () => {
    const approval = await db.agentRuns.requestApproval({
      run_id: run.id,
      user_id: owner.id,
      tool_id: 'crm_mutation',
      action: 'update_company',
      input_hash: 'terminal-run',
      input_json: '{}',
      ttl_ms: 60_000,
    });
    await db.agentRuns.transitionRun(run.id, ['running'], { status: 'failed' });
    const app = new Hono<AppEnv>()
      .use('*', async (c, next) => {
        c.set('user', { id: owner.id, role: owner.role });
        await next();
      })
      .route('/', createCloudAgentRoutes());

    const response = await app.request(`/runs/${run.id}/approvals/${approval.id}/decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'deny' }),
    });

    expect(response.status).toBe(409);
    expect((await db.agentRuns.getApprovalById(approval.id))?.status).toBe('pending');
  });
});
