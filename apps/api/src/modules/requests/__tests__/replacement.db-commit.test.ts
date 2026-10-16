import { and, eq, inArray } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { getDb, jobs, members, notifications, requests, runs } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { DECISION_JOB } from '../service.js';

it('serializes simultaneous replacements and a member decision on the same conversation', async () => {
  const app = createTestApp({ GREENHOUSE_ROLE: 'api' });
  const member = await app.member();
  const main = (await app.call('GET', '/api/conversations', { token: member.token })).body.items[0];
  const created: string[] = [];
  try {
    const raise = async () => {
      const card = await app.services.requests.create({
        memberId: member.id,
        conversationId: main.id,
        agentId: main.agent_id,
        kind: 'proposal',
        subject: 'instructions_update',
        title: 'A newer plan',
        payload: {},
      });
      created.push(card.id);
      return card;
    };
    await Promise.all([raise(), raise(), raise()]);
    const rows = await getDb().select().from(requests).where(inArray(requests.id, created));
    const pending = rows.filter((row) => row.status === 'pending');
    expect(pending).toHaveLength(1);
    expect(rows.filter((row) => row.status === 'superseded')).toHaveLength(2);
    expect(
      (await app.services.notifications.list(member.id, { unread: 'false', limit: 100 })).items.map(
        (row) => row.request_id,
      ),
    ).toEqual([pending[0]!.id]);
    const [decision] = await Promise.allSettled([
      app.services.requests.settle(member.id, pending[0]!.id, { status: 'approved', result: {} }),
      raise(),
    ]);
    const previous = await app.services.requests.get(member.id, pending[0]!.id);
    expect(previous.status).toBe(decision.status === 'fulfilled' ? 'approved' : 'superseded');
    expect((await app.services.notifications.list(member.id, { unread: 'false', limit: 100 })).items).toHaveLength(1);
    const final = await app.services.requests.list(member.id, { state: 'pending', limit: 100 });
    expect(final.items).toHaveLength(1);
    expect(
      await getDb()
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.kind, DECISION_JOB),
            inArray(
              jobs.dedupeKey,
              created.map((id) => `${DECISION_JOB}:${id}`),
            ),
          ),
        ),
    ).toHaveLength(created.length - 1);
  } finally {
    await app.services.engine.shutdown({ graceMs: 0 });
    await getDb()
      .delete(jobs)
      .where(
        inArray(
          jobs.dedupeKey,
          created.map((id) => `${DECISION_JOB}:${id}`),
        ),
      );
    await getDb().delete(notifications).where(eq(notifications.memberId, member.id));
    await getDb().delete(runs).where(eq(runs.ownerId, member.id));
    await getDb().delete(members).where(eq(members.id, member.id));
  }
});
