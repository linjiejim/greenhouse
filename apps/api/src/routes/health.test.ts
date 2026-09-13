import { describe, expect, it } from 'vitest';

import { missionHealthView } from './health.js';

describe('Mission health posture', () => {
  it('reports the isolation facts when admission is ready', () => {
    expect(
      missionHealthView({
        state: 'ready',
        runtime: 'runsc',
        rootFilesystem: 'read-only',
        maxConcurrent: 3,
        workspaceQuota: {
          mode: 'kernel-enforced',
          mechanism: 'xfs-project',
          inodeLimit: 25_000,
          verification: 'per-user-on-admission',
        },
      }),
    ).toEqual({
      state: 'ready',
      isolation: {
        runtime: 'runsc',
        root_filesystem: 'read-only',
        workspace_quota: {
          mode: 'kernel-enforced',
          mechanism: 'xfs-project',
          inodeLimit: 25_000,
          verification: 'per-user-on-admission',
        },
      },
    });
  });

  it('does not expose a failed preflight reason publicly', () => {
    expect(
      missionHealthView({ state: 'unavailable', reason: 'secret host detail', containment: 'unconfirmed' }),
    ).toEqual({ state: 'unavailable', containment: 'unconfirmed' });
  });

  it('keeps admission visibly closed during boot reconciliation', () => {
    expect(missionHealthView({ state: 'reconciling' })).toEqual({ state: 'reconciling' });
  });
});
