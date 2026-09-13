import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SandboxRunnerConfig } from './config.js';
import { measureWorkspaceBytes, WorkspaceMeasurementLimitError } from './workspace-lifecycle.js';
import { workspaceDirsFor } from './workspace.js';

let root: string | null = null;

function config(dataRoot: string): SandboxRunnerConfig {
  return {
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
    userDiskQuotaBytes: 1_000_000,
    userInodeQuota: 25_000,
    hardQuotaMarkerPath: '/tmp/test-quota-marker.json',
    quotaAttestCommand: '/usr/local/sbin/greenhouse-sandbox-runner-quota',
    archiveAfterDays: 14,
    defaultModel: 'flash',
    fallbackModel: 'flash',
  };
}

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('bounded Mission workspace accounting', () => {
  it('stops an inode-heavy walk at the configured entry budget', async () => {
    root = await mkdtemp(join(tmpdir(), 'mission-measure-'));
    const dirs = workspaceDirsFor(root, 'user_1', 1);
    await mkdir(dirs.workspaceDir, { recursive: true });
    await writeFile(join(dirs.workspaceDir, 'a'), 'a');
    await writeFile(join(dirs.workspaceDir, 'b'), 'b');
    await writeFile(join(dirs.workspaceDir, 'c'), 'c');

    await expect(
      measureWorkspaceBytes(config(root), { id: 1, user_id: 'user_1' }, { maxEntries: 3, maxMs: 1_000 }),
    ).rejects.toBeInstanceOf(WorkspaceMeasurementLimitError);
  });
});
