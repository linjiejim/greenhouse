/** Opt-in real Docker + real storage backup/restore, including the browser home. */
import { afterAll, describe, expect, it } from 'vitest';
import { runDocker } from '@greenhouse/providers';
import { runToEnd } from '../streams.js';
import { createTestApp } from '../../../testing.js';
const names: string[] = [];
afterAll(async () => {
  for (const name of names) {
    await runDocker(['rm', '-f', name]);
    await runDocker(['volume', 'rm', '-f', `${name}-home`]);
  }
});
describe.skipIf(process.env.GREENHOUSE_LIVE_DOCKER !== '1')('encrypted home backup on Docker', () => {
  it('restores files from both homes after an on-demand and a stop backup', async () => {
    const app = createTestApp({
      SANDBOX_PROVIDER: 'docker',
      SANDBOX_IMAGE: 'greenhouse/bot-computer:latest',
      SANDBOX_DOCKER_RUNTIME: 'runc',
      STORAGE_PROVIDER: 'local',
      STORAGE_ROOT: `${process.cwd()}/node_modules/.cache/t12-live-backups`,
    });
    const admin = await app.member('admin');
    const member = await app.member();
    const agent = (await app.call('GET', '/api/agents/main', { token: member.token })).body;
    const name = `gh-cmp-${agent.id.toLowerCase()}`;
    names.push(name);
    const { row, client } = await app.services.computers.ensure(member.id, agent.id);
    await app.services.computers.shell(member.id, agent.id, "printf 'original agent home' > ~/backup-check.txt");
    const marker = await runToEnd(
      client.stream(name, {
        user: 'browser',
        argv: ['sh', '-c', 'printf browser-original > /home/browser/backup-check.txt'],
      }),
      null,
      { timeoutMs: 10_000, maxOutputBytes: 4096 },
    );
    expect(marker.code).toBe(0);
    await app.services.computers.adminBackup(admin.id, row.id);
    const first = (await app.services.computers.adminList(admin.id)).items[0]!.backups[0]!;
    await app.services.computers.shell(
      member.id,
      agent.id,
      'printf changed > ~/backup-check.txt; touch ~/new-file.txt',
    );
    await app.services.computers.adminStop(admin.id, row.id);
    expect((await app.services.computers.adminList(admin.id)).items[0]!.backups).toHaveLength(2);
    await app.services.computers.adminRestore(admin.id, row.id, first.id);
    const restored = await app.services.computers.shell(
      member.id,
      agent.id,
      'cat ~/backup-check.txt; test ! -e ~/new-file.txt',
    );
    expect(restored).toMatchObject({ exit_code: 0 });
    expect(restored.output).toContain('original agent home');
    const browser = await runToEnd(
      client.stream(name, { user: 'browser', argv: ['cat', '/home/browser/backup-check.txt'] }),
      null,
      { timeoutMs: 10_000, maxOutputBytes: 4096 },
    );
    expect(browser.stdout).toBe('browser-original');
    await client.remove(name, { keepHome: false });
    const recovered = await app.services.computers.shell(member.id, agent.id, 'cat ~/backup-check.txt');
    expect(recovered.output).toBe('changed');
    await app.services.computers.adminReset(admin.id, row.id);
  }, 120_000);
});
