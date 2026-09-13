/** Persistent workspace accounting and archive/restore round trip. */

import { access, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../helpers/internal-user.js';
import type { CloudAgentConfig } from '../../apps/api/src/cloud-agent/config.js';
import {
  archiveWorkspace,
  measureWorkspaceBytes,
  restoreWorkspaceIfArchived,
} from '../../apps/api/src/cloud-agent/workspace-lifecycle.js';
import { prepareRunDirs } from '../../apps/api/src/cloud-agent/workspace.js';
import { deleteObjectAtKey } from '../../apps/api/src/storage/uploads.js';

let db: DatabaseProvider;
let dataRoot: string;
let config: CloudAgentConfig;
let archiveObjectKey: string | null = null;

describe('Cloud Agent workspace lifecycle', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    dataRoot = await mkdtemp(join(tmpdir(), 'cloud-agent-archive-test-'));
    config = {
      dataRoot,
      image: 'test',
      apiBase: 'http://api',
      maxConcurrent: 1,
      network: 'test',
      skillsDir: null,
      memory: '1g',
      cpus: '1',
      dockerRuntime: null,
      requireHardenedRuntime: false,
      userDiskQuotaBytes: 1024 * 1024,
      userInodeQuota: 25_000,
      hardQuotaMarkerPath: join(dataRoot, 'quota-marker.json'),
      quotaAttestCommand: '/usr/local/sbin/greenhouse-sandbox-runner-quota',
      archiveAfterDays: 14,
      defaultModel: 'pro',
      fallbackModel: 'pro',
    };
  });

  afterEach(async () => {
    if (archiveObjectKey) await deleteObjectAtKey(archiveObjectKey).catch(() => {});
    await rm(dataRoot, { recursive: true, force: true });
    await db.close();
    _resetProvider();
  });

  it('measures without following symlinks, archives durably, and restores files', async () => {
    const user = await createInternalTestUser(db, { email: `archive-${Date.now()}@test.local` });
    const workspace = await db.agentRuns.createWorkspace({ user_id: user.id, name: 'archive' });
    const dirs = await prepareRunDirs(dataRoot, user.id, workspace.id, 'car_archive', 'prompt');
    await writeFile(join(dirs.workspaceDir, 'keep.txt'), 'keep me', 'utf8');
    await symlink('/etc', join(dirs.workspaceDir, 'outside'));
    const bytes = await measureWorkspaceBytes(config, workspace);
    expect(bytes).toBeGreaterThanOrEqual(Buffer.byteLength('keep me'));
    expect(bytes).toBeLessThan(100_000);

    await archiveWorkspace(db, config, workspace);
    const archived = (await db.agentRuns.getWorkspaceById(workspace.id))!;
    expect(archived.status).toBe('archived');
    expect(archived.cos_archive_key).toContain(`/ws-${workspace.id}.tar.gz`);
    archiveObjectKey = archived.cos_archive_key;
    await expect(access(dirs.workspaceDir)).rejects.toThrow();

    const restored = await restoreWorkspaceIfArchived(db, config, archived);
    expect(restored.status).toBe('active');
    expect(restored.cos_archive_key).toBeNull();
    expect(await readFile(join(dirs.workspaceDir, 'keep.txt'), 'utf8')).toBe('keep me');
  });
});
