/**
 * Issues & requests for members' agents, on the real tables: filing a request
 * or a friction over the recorded-write path names the member and the agent's
 * client, and the plain read only returns the member's own requests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import type { ToolRegistry } from '../../agent.js';
import { governProxyWrite, type WriteCaller } from '../../agent-access/governed-write.js';
import { createFeatureRequestTool } from '../feature-request.js';
import { createLogFrictionTool } from '../log-friction.js';
import { createFeedbackQueryTool } from '../feedback-query.js';

let db: DatabaseProvider;
let alice: UserRow;
let bob: UserRow;
let admin: UserRow;
let caller: WriteCaller;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type Exec = { execute: (input: unknown, options: unknown) => Promise<Record<string, unknown>> };
const run = (tool: unknown, input: unknown) => (tool as Exec).execute(input, {});

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  alice = await createInternalTestUser(db, { email: `${unique('fb-alice')}@test.local` });
  bob = await createInternalTestUser(db, { email: `${unique('fb-bob')}@test.local` });
  admin = await createInternalTestUser(db, { email: `${unique('fb-admin')}@test.local`, role: 'super' });
  const client = await db.platformOAuth.registerClient({
    id: unique('client'),
    client_name: 'Codex',
    redirect_uris: [],
    created_by: alice.id,
  });
  caller = { userId: alice.id, clientId: client.id, clientName: 'Codex', authMethod: 'oauth' };
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

describe('feedback over MCP', () => {
  it('files a feature request as a recorded write in the member’s name, with the client', async () => {
    const registry = {
      feature_request: createFeatureRequestTool(db, { userId: alice.id, userRole: 'team' }),
    } as unknown as ToolRegistry;
    const title = unique('Export to PDF');
    const written = await governProxyWrite({
      db,
      caller,
      toolId: 'feature_request',
      input: { action: 'submit', title, description: 'From my agent' },
      registry,
      allowedToolIds: ['feature_request'],
      baseRisk: 'r1',
      confirmed: false,
    });
    expect(written.status).toBe('executed');
    if (written.status !== 'executed') return;
    expect(written.view).toMatchObject({ client_name: 'Codex', tool_id: 'feature_request', action: 'submit' });

    const requests = await db.featureRequests.list({ submitted_by: alice.id });
    expect(requests.map((request) => request.title)).toContain(title);
  });

  it('logs a friction as a recorded write', async () => {
    const registry = { log_friction: createLogFrictionTool(db, {}) } as unknown as ToolRegistry;
    const written = await governProxyWrite({
      db,
      caller,
      toolId: 'log_friction',
      input: { kind: 'detour', summary: `files_query.list needs ${unique('x')} first`, tool_id: 'files_query' },
      registry,
      allowedToolIds: ['log_friction'],
      baseRisk: 'r1',
      confirmed: false,
    });
    expect(written.status).toBe('executed');
    if (written.status === 'executed') expect(written.view.output).toMatchObject({ logged: true });
  });

  it('reads back only the member’s own requests; a super may read everyone’s', async () => {
    const mine = await db.featureRequests.create({ title: unique('mine'), description: 'a', submitted_by: alice.id });
    const theirs = await db.featureRequests.create({ title: unique('theirs'), description: 'b', submitted_by: bob.id });

    const aliceTool = createFeedbackQueryTool(db, { userId: alice.id, userRole: 'team' });
    const listed = await run(aliceTool, { action: 'requests.list' });
    const ids = (listed.requests as Array<{ id: number }>).map((request) => request.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    expect(await run(aliceTool, { action: 'requests.get', id: theirs.id })).toMatchObject({
      error: expect.any(String),
    });
    expect(await run(aliceTool, { action: 'requests.list', everyone: true })).toMatchObject({
      error: expect.any(String),
    });

    const adminTool = createFeedbackQueryTool(db, { userId: admin.id, userRole: 'super' });
    const all = await run(adminTool, { action: 'requests.list', everyone: true, limit: 50 });
    expect((all.requests as Array<{ id: number }>).map((request) => request.id)).toEqual(
      expect.arrayContaining([mine.id, theirs.id]),
    );
  });
});
