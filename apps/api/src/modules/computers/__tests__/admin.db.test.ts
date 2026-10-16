/**
 * 管理 → 服务 · 沙箱 (ADM-06): admins see every computer and set the capacity; a start beyond
 * it is refused, and a reset removes a computer with its home.
 */

import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { agentComputers, auditEvents, getDb } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { fake, fakeSandboxEnv } from './fake-sandbox.js';

beforeEach(() => fake.reset());

describe('computers for admins', () => {
  it('lists every computer, sets the capacity, queues a start beyond it, stops and resets', async () => {
    const app = createTestApp(fakeSandboxEnv());
    const admin = await app.member('admin');
    const lin = await app.member();
    const mei = await app.member();
    expect((await app.call('POST', '/api/agents/main/computer/start', { token: lin.token })).status).toBe(200);

    expect((await app.call('GET', '/api/admin/computers', { token: lin.token })).status).toBe(403);
    const listed = await app.call('GET', '/api/admin/computers', { token: admin.token });
    expect(listed.body).toMatchObject({
      capacity: { idle_minutes: 30, max_running: 0 },
      running: 1,
      items: [{ agent_name: 'Greeny', owner_id: lin.id, state: 'running' }],
    });

    const capacity = await app.call('PUT', '/api/admin/computers/capacity', {
      token: admin.token,
      body: { idle_minutes: 15, max_running: 1 },
    });
    expect(capacity.body).toEqual({ idle_minutes: 15, max_running: 1 });
    expect(
      (
        await app.call('PUT', '/api/admin/computers/capacity', {
          token: admin.token,
          body: { idle_minutes: 1, max_running: 1 },
        })
      ).status,
    ).toBe(400);
    // The sandbox keeps its order: it still serves.
    const view = await app.call('GET', '/api/admin/providers', { token: admin.token });
    const sandbox = view.body.capabilities.find((entry: { capability: string }) => entry.capability === 'sandbox');
    expect(sandbox.effective.length).toBeGreaterThan(0);

    const refused = await app.call('POST', '/api/agents/main/computer/start', { token: mei.token });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({ state: 'queued', queue_position: 1 });

    const id = listed.body.items[0].id;
    expect((await app.call('POST', `/api/admin/computers/${id}/stop`, { token: admin.token })).status).toBe(204);
    const [stopped] = await getDb().select().from(agentComputers).where(eq(agentComputers.id, id));
    expect(stopped).toMatchObject({ state: 'stopped', stateReason: 'admin' });
    expect((await app.call('POST', '/api/agents/main/computer/start', { token: mei.token })).status).toBe(200);

    expect((await app.call('DELETE', `/api/admin/computers/${id}`, { token: admin.token })).status).toBe(204);
    expect(await getDb().select().from(agentComputers).where(eq(agentComputers.id, id))).toEqual([]);
    expect(fake.computers.has(stopped!.sandboxRef)).toBe(false);
    const actions = (await getDb().select({ action: auditEvents.action }).from(auditEvents)).map((row) => row.action);
    expect(actions).toEqual(expect.arrayContaining(['computer.capacity', 'computer.stop', 'computer.reset']));
  });
});
