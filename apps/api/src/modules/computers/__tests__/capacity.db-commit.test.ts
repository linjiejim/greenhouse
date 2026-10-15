import { inArray } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { getDb, members, agentComputers } from '@greenhouse/db';
import { createTestApp, createTestServices } from '../../../testing.js';
import { fakeSandboxEnv } from './fake-sandbox.js';
const created: string[] = [];
afterAll(async () => {
  await getDb().delete(agentComputers).where(inArray(agentComputers.ownerId, created));
  await getDb().delete(members).where(inArray(members.id, created));
});
describe('durable computer capacity across processes', () => {
  it('never exceeds capacity on simultaneous starts and drains in FIFO order after a process change', async () => {
    const env = fakeSandboxEnv();
    const app = createTestApp(env);
    const admin = await app.member('admin');
    const people = await Promise.all(Array.from({ length: 4 }, () => app.member()));
    created.push(admin.id, ...people.map((p) => p.id));
    await app.services.computers.setCapacity(admin.id, { max_running: 1, idle_minutes: 30 });
    const agents = await Promise.all(
      people.map((p) => app.call('GET', '/api/agents/main', { token: p.token }).then((r) => r.body)),
    );
    await Promise.all(people.map((p, i) => app.services.computers.start(p.id, agents[i]!.id)));
    const list = await app.services.computers.adminList(admin.id);
    expect(list.running).toBe(1);
    const queue = list.items.filter((c) => c.state === 'queued').sort((a, b) => a.queue_position! - b.queue_position!);
    expect(queue.map((c) => c.queue_position)).toEqual([1, 2, 3]);
    const other = createTestServices(env);
    const running = list.items.find((c) => c.state === 'running')!;
    await other.computers.adminStop(admin.id, running.id);
    expect((await other.computers.view(queue[0]!.owner_id, queue[0]!.agent_id)).state).toBe('running');
    const next = await other.computers.view(queue[1]!.owner_id, queue[1]!.agent_id);
    expect(next).toMatchObject({ state: 'queued', queue_position: 1 });
    await other.computers.stop(queue[1]!.owner_id, queue[1]!.agent_id);
    expect((await other.computers.view(queue[1]!.owner_id, queue[1]!.agent_id)).state).toBe('stopped');
    await app.services.computers.setCapacity(admin.id, { max_running: 0, idle_minutes: 30 });
  });
});
