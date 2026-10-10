/**
 * After an admin write, subsystems that read their settings once at startup are told
 * (onWorkspaceConfigRefreshed) — the Bots computer runtime restarts on a new provider key.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@greenhouse/db', () => ({ getDb: vi.fn(), isDbInitialized: () => false }));
vi.mock('../../config/models.js', () => ({ reloadModelCatalog: vi.fn() }));

const { onWorkspaceConfigRefreshed, refreshWorkspaceConfig } = await import('../workspace-config.js');

describe('workspace config listeners', () => {
  it('calls every listener after a refresh — one that fails does not stop the others — until unsubscribed', async () => {
    const calls: string[] = [];
    const offA = onWorkspaceConfigRefreshed(() => {
      calls.push('a');
    });
    const offBroken = onWorkspaceConfigRefreshed(() => {
      throw new Error('boom');
    });
    const offB = onWorkspaceConfigRefreshed(async () => {
      calls.push('b');
    });
    await refreshWorkspaceConfig();
    expect(calls).toEqual(['a', 'b']);
    offA();
    offBroken();
    await refreshWorkspaceConfig();
    expect(calls).toEqual(['a', 'b', 'b']);
    offB();
  });
});
