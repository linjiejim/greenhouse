import { describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
const hook = vi.hoisted(() => vi.fn());
vi.mock('../index.js', () => ({
  EXTENSIONS: [{ id: 'health-fixture', name: 'Fixture', onBoot: hook }],
  fromExtensions: () => [],
}));
import { runExtensionBootHooks } from '../boot.js';
import { extensionBootFact } from '../health.js';
describe('plugin boot diagnostics', () => {
  it('records ready state after hooks finish and preserves fail-fast errors', async () => {
    const db = {} as DatabaseProvider;
    expect(extensionBootFact('health-fixture').state).toBe('not-run');
    await runExtensionBootHooks(db);
    expect(extensionBootFact('health-fixture')).toEqual({ state: 'ready', errors: [] });
    hook.mockRejectedValueOnce(new Error('boot configuration invalid'));
    await expect(runExtensionBootHooks(db)).rejects.toThrow('boot configuration invalid');
    expect(extensionBootFact('health-fixture')).toEqual({ state: 'error', errors: ['boot configuration invalid'] });
  });
});
