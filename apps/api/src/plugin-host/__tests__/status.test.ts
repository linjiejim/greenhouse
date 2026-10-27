import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
const state = vi.hoisted(() => ({ enabled: false }));
vi.mock('../index.js', () => ({
  COMPILED_EXTENSIONS: [
    {
      id: 'fixture',
      name: 'Fixture',
      sdk: 2,
      version: '1.2.3',
      migrations: { dir: '/missing/fixture' },
      resetTables: ['ext_fixture'],
    },
  ],
  get EXTENSIONS() {
    return state.enabled ? [{ id: 'fixture' }] : [];
  },
}));
vi.mock('../compiled.generated.js', () => ({
  COMPILED_PLUGIN_PACKAGES: [
    { id: 'fixture', packageName: '@greenhouse/plugin-fixture', manifest: { version: '1.2.3' } },
  ],
}));
import { listPlugins, pluginDropPlan, pluginStatus } from '../status.js';
import { recordExtensionBootError, recordExtensionBootReady } from '../health.js';

beforeEach(() => {
  state.enabled = false;
});
describe('plugin operator model', () => {
  it('lists compiled and disabled packages without opening a database', () => {
    expect(listPlugins()[0]).toMatchObject({
      id: 'fixture',
      packageName: '@greenhouse/plugin-fixture',
      compiled: true,
      enabled: false,
      sdk: 2,
      version: '1.2.3',
      dependsOn: [],
      bootState: 'disabled',
    });
  });
  it('reports pending and drifted migration states, plus boot errors', async () => {
    state.enabled = true;
    recordExtensionBootError('fixture', new Error('fixture boot failed'));
    const status = vi
      .fn()
      .mockResolvedValue([
        { name: '0001.sql', state: 'pending', applied: false, drifted: false, collidesWithCore: [] },
      ]);
    const db = { extensionMigrations: { status } } as unknown as DatabaseProvider;
    expect((await pluginStatus(db))[0]).toMatchObject({
      enabled: true,
      migrationState: 'pending',
      bootState: 'error',
      bootErrors: ['fixture boot failed'],
    });
    status.mockResolvedValue([
      { name: '0001.sql', state: 'applied', applied: true, drifted: true, collidesWithCore: [] },
    ]);
    expect((await pluginStatus(db))[0].migrationState).toBe('error');
    status.mockRejectedValue(new Error('database unavailable'));
    expect((await pluginStatus(db))[0]).toMatchObject({
      migrationState: 'error',
      migrationError: 'database unavailable',
    });
    recordExtensionBootReady('fixture');
    expect(listPlugins()[0]).toMatchObject({ bootState: 'ready', bootErrors: [] });
  });
  it('plans only known, disabled plugins', () => {
    expect(pluginDropPlan('fixture').tables).toEqual(['ext_fixture']);
    expect(() => pluginDropPlan('unknown')).toThrow(/Unknown compiled plugin/);
    state.enabled = true;
    expect(() => pluginDropPlan('fixture')).toThrow(/Disable plugin/);
  });
});
