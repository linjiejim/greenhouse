import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { agentComputers, computerBackups, getDb, transaction } from '@greenhouse/db';
import { getAdapter, registerAdapter } from '@greenhouse/providers';
import { createTestApp } from '../../../testing.js';
import { fake, fakeSandboxEnv } from './fake-sandbox.js';

const objects = new Map<string, Uint8Array>();
if (!getAdapter('storage', 'backup-test'))
  registerAdapter({
    capability: 'storage',
    kind: 'backup-test',
    label: 'Test',
    configSchema: z.object({}).passthrough(),
    secretKeys: [],
    endpoints: () => null,
    create: () => ({
      put: async (key, data) => {
        objects.set(key, data);
      },
      get: async (key) => {
        const data = objects.get(key);
        return data
          ? {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(data);
                  c.close();
                },
              }),
            }
          : null;
      },
      head: async () => null,
      delete: async (key) => {
        objects.delete(key);
      },
    }),
  });
beforeEach(() => {
  objects.clear();
  fake.reset();
});

describe('computer backup lifecycle', () => {
  it('encrypts both homes, keeps three backups, authenticates before restore and restricts admins', async () => {
    const app = createTestApp(fakeSandboxEnv());
    const admin = await app.member('admin');
    const storage = await app.services.providers.create(admin.id, 'workspace', {
      capability: 'storage',
      kind: 'backup-test',
      name: 'Backup test',
      config: {},
      secrets: {},
    });
    await app.services.providers.setBinding(admin.id, 'storage', {
      instance_ids: [storage.id],
      defaults: {},
      policy: {},
    });
    const member = await app.member();
    fake.onStream = (stream) => {
      if (stream.argv.includes('tar')) stream.output.write(Buffer.from('private home bytes'));
    };
    await app.call('POST', '/api/agents/main/computer/start', { token: member.token });
    let list = await app.services.computers.adminList(admin.id);
    const id = list.items[0]!.id;
    expect((await app.call('POST', `/api/admin/computers/${id}/backups`, { token: member.token })).status).toBe(403);
    for (let i = 0; i < 4; i++) await app.services.computers.adminBackup(admin.id, id);
    list = await app.services.computers.adminList(admin.id);
    expect(list.items[0]!.backups).toHaveLength(3);
    expect(objects.size).toBe(3);
    for (const value of objects.values()) expect(Buffer.from(value).toString()).not.toContain('private home bytes');
    await app.services.computers.adminStop(admin.id, id);
    list = await app.services.computers.adminList(admin.id);
    const backup = list.items[0]!.backups[0]!;
    await app.services.computers.adminRestore(admin.id, id, backup.id);
    expect(fake.streams.filter((s) => s.argv.includes('python3'))).toHaveLength(4);
    const [row] = await getDb().select().from(computerBackups).where(eq(computerBackups.id, backup.id));
    const bytes = Buffer.from(objects.get(row!.objectKey)!);
    bytes[20] = bytes[20]! ^ 1;
    objects.set(row!.objectKey, bytes);
    const count = fake.streams.length;
    await expect(transaction(() => app.services.computers.adminRestore(admin.id, id, backup.id))).rejects.toMatchObject(
      { code: 'backup_invalid' },
    );
    expect(fake.streams).toHaveLength(count);
    await app.services.computers.adminReset(admin.id, id);
    expect(objects.size).toBe(0);
  });
  it('discards an interrupted archive and retries once, while bounding repeated disconnects', async () => {
    const app = createTestApp(fakeSandboxEnv());
    const admin = await app.member('admin');
    const storage = await app.services.providers.create(admin.id, 'workspace', {
      capability: 'storage',
      kind: 'backup-test',
      name: 'Backup retry',
      config: {},
      secrets: {},
    });
    await app.services.providers.setBinding(admin.id, 'storage', {
      instance_ids: [storage.id],
      defaults: {},
      policy: {},
    });
    await app.call('POST', '/api/agents/main/computer/start', { token: admin.token });
    const id = (await app.services.computers.adminList(admin.id)).items[0]!.id;
    let reads = 0;
    fake.onStream = (stream) => {
      if (!stream.argv.includes('tar')) return;
      reads++;
      if (reads === 1) {
        stream.output.write(Buffer.from('partial'));
        stream.exit(null);
      } else stream.output.write(Buffer.from('complete home'));
    };
    await app.services.computers.adminBackup(admin.id, id);
    expect(reads).toBe(3);
    expect((await app.services.computers.adminList(admin.id)).items[0]!.backups).toEqual([
      expect.objectContaining({ status: 'complete' }),
    ]);
    reads = 0;
    fake.onStream = (stream) => {
      if (!stream.argv.includes('tar')) return;
      reads++;
      stream.exit(null);
    };
    await expect(app.services.computers.adminBackup(admin.id, id)).rejects.toMatchObject({ code: 'backup_failed' });
    expect(reads).toBe(2);
    expect((await app.services.computers.adminList(admin.id)).items[0]!.backups.map((b) => b.status)).toEqual([
      'failed',
      'complete',
    ]);
  });

  it('keeps failure metadata and still allows a stop when the archive fails', async () => {
    const app = createTestApp(fakeSandboxEnv());
    const admin = await app.member('admin');
    const storage = await app.services.providers.create(admin.id, 'workspace', {
      capability: 'storage',
      kind: 'backup-test',
      name: 'Backup errors',
      config: {},
      secrets: {},
    });
    await app.services.providers.setBinding(admin.id, 'storage', {
      instance_ids: [storage.id],
      defaults: {},
      policy: {},
    });
    await app.call('POST', '/api/agents/main/computer/start', { token: admin.token });
    const id = (await app.services.computers.adminList(admin.id)).items[0]!.id;
    fake.onStream = (stream) => {
      if (stream.argv.includes('tar')) stream.exit(2);
    };
    await expect(app.services.computers.adminBackup(admin.id, id)).rejects.toMatchObject({ code: 'backup_failed' });
    expect((await app.services.computers.adminList(admin.id)).items[0]!.backups[0]!.status).toBe('failed');
    await app.services.computers.adminStop(admin.id, id);
    expect((await app.services.computers.adminList(admin.id)).items[0]!.state).toBe('stopped');
    for (let attempt = 0; attempt < 4; attempt++) {
      await app.services.computers.start(
        admin.id,
        (await app.services.computers.adminList(admin.id)).items[0]!.agent_id,
      );
      await app.services.computers.adminStop(admin.id, id);
    }
    expect((await app.services.computers.adminList(admin.id)).items[0]!.backups).toHaveLength(3);
    const computer = (await app.services.computers.adminList(admin.id)).items[0]!;
    await app.services.computers.start(admin.id, computer.agent_id);
    await getDb().update(agentComputers).set({ backgroundRunId: 'finished-run' }).where(eq(agentComputers.id, id));
    await app.services.computers.releaseBackground(admin.id, computer.agent_id, 'finished-run');
    const [released] = await getDb().select().from(agentComputers).where(eq(agentComputers.id, id));
    expect(released).toMatchObject({ state: 'stopped', backgroundRunId: null });
  });
});
