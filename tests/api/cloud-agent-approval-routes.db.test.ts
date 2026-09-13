/** Cloud task-token mutation approval lease at the real /api/agent boundary. */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { AgentRunRow, DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import { createToolRegistry } from '../../apps/api/src/agent.js';
import { createTaskToken } from '../../apps/api/src/auth/task-token.js';
import { createAgentRoutes, MAX_AGENT_TOOL_BODY_BYTES } from '../../apps/api/src/routes/agent-tools.js';
import { knowledgeRegistration } from '../../apps/api/src/platform/knowledge/registration.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../apps/api/src/platform/runtime.js';
import { _setCloudAgentController } from '../../apps/api/src/cloud-agent/index.js';
import type { CloudAgentController } from '../../apps/api/src/cloud-agent/controller.js';

let db: DatabaseProvider;
let user: UserRow;
let run: AgentRunRow;

describe('Cloud Agent approval lease route', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    // knowledge_mutation dispatches through the Platform runtime, so the lease
    // has a real write tool to consume rather than a stub.
    initializePlatformRuntime(db, [knowledgeRegistration]);
    user = await createInternalTestUser(db, { email: `approval-${Date.now()}-${Math.random()}@test.local` });
    await db.userTools.setTools(user.id, ['knowledge_mutation'], user.id);
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'approval' });
    run = await db.agentRuns.createRun({
      user_id: user.id,
      workspace_id: workspace.id,
      title: 'approval',
      prompt: 'approval',
      model: 'pro',
    });
    run = (await db.agentRuns.transitionRun(run.id, ['queued'], { status: 'running' }))!;
    _setCloudAgentController({} as CloudAgentController);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    _setCloudAgentController(null);
    await db.close();
    _resetProvider();
  });

  it('ignores runner confirm, validates first, binds exact input, and consumes once', async () => {
    const routes = createAgentRoutes(createToolRegistry(db));
    const token = createTaskToken(user.id, run.id, run.max_wall_ms);
    const call = (body: unknown) =>
      routes.request('/tools/knowledge_mutation/call', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

    const invalid = await call({ input: { title: 'no action' }, confirm: true });
    expect(invalid.status).toBe(400);
    expect(await db.agentRuns.listApprovals(run.id)).toHaveLength(0);

    const exactInput = { action: 'knowledge.create_doc', title: 'Title', content: 'test exact binding' };
    const required = await call({ input: exactInput, confirm: true });
    expect(required.status).toBe(428);
    const requiredBody = (await required.json()) as { approval: { id: string } };
    const approvalId = requiredBody.approval.id;

    const status = await routes.request(`/approvals/${approvalId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(status.status).toBe(200);
    expect(((await status.json()) as { approval: { status: string } }).approval.status).toBe('pending');

    expect((await db.agentRuns.decideApproval(approvalId, run.id, user.id, 'approve', user.id))?.status).toBe(
      'approved',
    );

    const changed = await call({
      input: { ...exactInput, title: 'Different after approval' },
      approval_id: approvalId,
    });
    expect(changed.status).toBe(403);
    expect((await db.agentRuns.getApprovalById(approvalId))?.status).toBe('approved');

    const executed = await call({ input: exactInput, approval_id: approvalId });
    expect(executed.status).toBe(200);
    expect((await db.agentRuns.getApprovalById(approvalId))?.status).toBe('consumed');

    const replay = await call({ input: exactInput, approval_id: approvalId });
    expect(replay.status).toBe(403);
  });

  it('rejects an oversized task-token tool body before JSON parsing or execution', async () => {
    const routes = createAgentRoutes(createToolRegistry(db));
    const token = createTaskToken(user.id, run.id, run.max_wall_ms);
    const response = await routes.request('/tools/knowledge_mutation/call', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: { content: 'x'.repeat(MAX_AGENT_TOOL_BODY_BYTES) } }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({
      error: { message: 'Request body is too large', type: 'invalid_request_error' },
    });
    expect(await db.agentRuns.listApprovals(run.id)).toHaveLength(0);
  });
});
