import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { auditEvents, getDb, members, workspace } from '@greenhouse/db';
import { createTestApp } from '../../../testing.js';

it('merges simultaneous switch changes from two replicas without losing either patch', async () => {
  const app = createTestApp();
  const replica = createTestApp();
  const admin = await app.member('admin');
  const [before] = await getDb().select().from(workspace).where(eq(workspace.id, 'default'));
  try {
    await app.services.operations.update(admin.id, { disable_computers: false, disable_outbound_mail: false });
    await Promise.all([
      app.services.operations.update(admin.id, { disable_computers: true }),
      replica.services.operations.update(admin.id, { disable_outbound_mail: true }),
    ]);
    expect(await app.services.operations.get(admin.id)).toMatchObject({
      disable_computers: true,
      disable_outbound_mail: true,
    });
  } finally {
    if (before)
      await getDb()
        .update(workspace)
        .set({ settings: before.settings, updatedBy: before.updatedBy, updatedAt: before.updatedAt })
        .where(eq(workspace.id, 'default'));
    else await getDb().delete(workspace).where(eq(workspace.id, 'default'));
    await getDb().delete(auditEvents).where(eq(auditEvents.actorId, admin.id));
    await getDb().delete(members).where(eq(members.id, admin.id));
  }
});
