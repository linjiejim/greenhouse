import { and, eq, sql } from 'drizzle-orm';
import { expect, it, vi } from 'vitest';
import { getDb, jobs, members, messages, notifications, runs } from '@greenhouse/db';
import { createTestApp } from '../../testing.js';
import { gate, scriptedModel, text, toolCall } from './model.js';

it('commits a private-write receipt while a new member message waits for its conversation lock', async () => {
  const model = scriptedModel([
    toolCall('agent_mutation', { action: 'create', name: 'Mail helper', job: 'Summarize mail' }),
    text('Created.'),
    text('Understood.'),
  ]);
  const app = createTestApp({ GREENHOUSE_ROLE: 'api' }, { languageModel: model.languageModel });
  const member = await app.member();
  const main = await app.services.conversations.ensureMain(member.id);
  const entered = gate();
  const release = gate();
  const original = app.services.agents.create;
  const create = vi.spyOn(app.services.agents, 'create').mockImplementation(async (...args) => {
    entered.open();
    await release.promise;
    return original(...args);
  });
  try {
    const first = await app.services.engine.post(member.id, main.id, {
      content: 'Create a mail Agent',
      mentions: [],
      attachments: [],
    });
    await entered.promise;
    const second = app.services.engine.post(member.id, main.id, {
      content: 'Keep it brief',
      mentions: [],
      attachments: [],
    });
    await expect
      .poll(
        async () => {
          const result = await getDb().execute<{ waiting: boolean }>(sql`
        select exists (
          select 1 from pg_stat_activity
          where datname = current_database() and pid <> pg_backend_pid()
            and wait_event_type = 'Lock' and query like '%from "conversations"%'
        ) as waiting
      `);
          return result[0]?.waiting;
        },
        { timeout: 5000 },
      )
      .toBe(true);
    release.open();
    await second;
    await app.services.engine.idle();
    const receipts = await getDb()
      .select()
      .from(messages)
      .where(and(eq(messages.runId, first.run_id!), sql`${messages.event}->>'type' = 'write_receipt'`));
    expect(receipts).toHaveLength(1);
    expect(
      (await app.services.agents.list(member.id, 'mine')).filter((agent) => agent.name === 'Mail helper'),
    ).toHaveLength(1);
  } finally {
    release.open();
    create.mockRestore();
    await app.services.engine.shutdown({ graceMs: 0 });
    await getDb().delete(notifications).where(eq(notifications.memberId, member.id));
    await getDb().delete(runs).where(eq(runs.ownerId, member.id));
    await getDb().delete(members).where(eq(members.id, member.id));
    await getDb()
      .delete(jobs)
      .where(sql`${jobs.kind} in ('conversation_digest', 'engine_retention')`);
  }
});
