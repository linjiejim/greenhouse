import { beforeEach, describe, expect, it } from 'vitest';
import { initDatabase, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { _resetDiscriminators, registerDiscriminators } from '@greenhouse/types/discriminators';
let db: DatabaseProvider;
beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});
describe('active persisted discriminator writes', () => {
  it('rejects unknown audit apps, accepts a registered fixture, and preserves historical reads', async () => {
    const event = {
      orgId: 'default',
      actorId: 'fixture',
      actorType: 'system' as const,
      requestId: 'fixture-registry-audit',
      resource: { appId: 'ext:fixture:audit' },
      actionId: 'fixture',
      capability: 'fixture.read',
      result: 'success' as const,
    };
    await expect(db.platform.recordAudit(event)).rejects.toThrow('Unregistered auditApps');
    registerDiscriminators({ auditApps: ['ext:fixture:audit'] });
    const row = await db.platform.recordAudit(event);
    _resetDiscriminators();
    expect((await db.platform.listAuditEvents('default')).some((item) => item.id === row.id)).toBe(true);
  });
  it('creates runs and receipts only for registered plugin kinds', async () => {
    const user = await db.users.create({
      email: 'registry-fixture@test.local',
      nickname: 'Fixture',
      password_hash: 'h',
      role: 'team',
    });
    const input = {
      kind: 'ext:fixture:sync',
      owner_user_id: user.id,
      initiated_by_user_id: user.id,
      source_kind: 'fixture',
      source_id: 'fixture',
      input: {},
    };
    await expect(db.runtime.createRun(input)).rejects.toThrow('Unregistered runKinds');
    registerDiscriminators({ runKinds: ['ext:fixture:sync'] });
    expect(await db.runtime.createRun(input)).toMatchObject({ kind: 'ext:fixture:sync' });
    const session = await db.sessions.create('Fixture', 'sprouty', user.id);
    const receipt = {
      id: 'fixture-receipt',
      session_id: session.id,
      user_id: user.id,
      kind: 'ext:fixture:card',
      request_hash: 'fixture',
    };
    await expect(db.chatArtifactReceipts.claim(receipt)).rejects.toThrow('Unregistered artifactKinds');
    registerDiscriminators({ artifactKinds: ['ext:fixture:card'] });
    expect(await db.chatArtifactReceipts.claim(receipt)).toMatchObject({ claimed: true });
  });
  it('validates registered folder placement and leaves rows readable after disabling their scope', async () => {
    const input = { scope: 'fixture-cabinet', owner_key: 'record-1', name: 'Fixture' };
    await expect(db.drive.createFolder(input)).rejects.toThrow('Unregistered folderScopes');
    registerDiscriminators({ folderScopes: ['fixture-cabinet'] });
    await expect(db.drive.createFolder({ ...input, owner_key: null })).rejects.toThrow('Invalid placement');
    const row = await db.drive.createFolder(input);
    _resetDiscriminators();
    await expect(db.drive.createFolder(input)).rejects.toThrow('Unregistered folderScopes');
    expect(await db.drive.getFolder(row.id)).toMatchObject({ name: 'Fixture', scope: 'fixture-cabinet' });
  });
});
