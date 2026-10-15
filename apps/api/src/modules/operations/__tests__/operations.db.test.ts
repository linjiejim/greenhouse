import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditEvents, getDb, runs } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';
import { scriptedModel, text } from '../../../engine/__tests__/model.js';

it('requires an active admin, shares switches across replicas, merges patches and audits field names', async () => {
  const app = createTestApp({ DISABLE_OUTBOUND_MAIL: '1' });
  const admin = await app.member('admin');
  const member = await app.member();
  const replica = createTestApp();
  expect((await app.call('GET', '/api/admin/operations', { token: member.token })).status).toBe(403);
  await expect(app.services.operations.update(member.id, { disable_computers: true })).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect((await app.services.operations.get(admin.id)).disable_outbound_mail).toBe(true);
  await app.call('PATCH', '/api/admin/operations', { token: admin.token, body: { disable_computers: true } });
  await replica.services.operations.update(admin.id, { pause_background_runs: true });
  expect(await app.services.operations.get(admin.id)).toEqual({
    disable_computers: true,
    pause_background_runs: true,
    disable_outbound_mail: true,
  });
  expect(
    (await app.call('PATCH', '/api/admin/operations', { token: admin.token, body: { unknown: true } })).status,
  ).toBe(400);
  const audits = await getDb().select().from(auditEvents).where(eq(auditEvents.action, 'operations.update'));
  expect(audits.map((row) => row.summary)).toEqual(['disable_computers', 'pause_background_runs']);
});

describe('operational enforcement', () => {
  it('keeps background runs queued and picks them up after resuming', async () => {
    const model = scriptedModel([text('done')]);
    const app = createTestApp({ PAUSE_BACKGROUND_RUNS: '1' }, { languageModel: model.languageModel });
    const admin = await app.member('admin');
    const member = await app.member();
    const agent = await app.services.agents.own(member.id, 'main');
    const run = await app.services.engine.background.start({
      agentId: agent.id,
      ownerId: member.id,
      requestedBy: member.id,
      title: 'Check',
      brief: 'Check',
      source: 'conversation',
      conversationId: null,
    });
    await app.services.engine.idle();
    expect((await getDb().select().from(runs).where(eq(runs.id, run.id)))[0]!.status).toBe('queued');
    await app.services.operations.update(admin.id, { pause_background_runs: false });
    await app.services.engine.sweep();
    await app.services.engine.idle();
    expect((await getDb().select().from(runs).where(eq(runs.id, run.id)))[0]!.status).toBe('succeeded');
  });
  it('refuses computers before reaching the sandbox and blocks outbound mail with a stable error', async () => {
    const app = createTestApp({
      DISABLE_COMPUTERS: '1',
      DISABLE_OUTBOUND_MAIL: '1',
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_test_12345678',
      MAIL_FROM: 'noreply@example.com',
    });
    const member = await app.member();
    await expect(app.services.computers.start(member.id, 'main')).rejects.toMatchObject({ code: 'operation_disabled' });
    const mail = await app.services.providers.resolve('mail', { memberId: member.id });
    expect(mail).not.toBeNull();
    await expect(
      mail!.client.send({ to: [{ address: 'a@example.com' }], subject: 'Test', text: 'Test' }),
    ).rejects.toMatchObject({ code: 'operation_disabled' });
  });
});
