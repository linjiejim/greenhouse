import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ openDb: vi.fn(), list: vi.fn(), status: vi.fn(), plan: vi.fn(), drop: vi.fn() }));
vi.mock('../shared.js', async (original) => ({
  ...(await original<typeof import('../shared.js')>()),
  openDb: mocks.openDb,
}));
vi.mock('../../../extensions/status.js', () => ({
  listPlugins: mocks.list,
  pluginStatus: mocks.status,
  pluginDropPlan: mocks.plan,
}));
import { run } from '../plugins.js';
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.clearAllMocks();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.openDb.mockResolvedValue({ extensionMigrations: { drop: mocks.drop } });
});
afterEach(() => vi.restoreAllMocks());
describe('plugins CLI', () => {
  it('lists packages without database access and emits JSON', async () => {
    mocks.list.mockReturnValue([{ id: 'fixture', enabled: false }]);
    expect(await run(['list', '--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls[0][0]))).toEqual([{ id: 'fixture', enabled: false }]);
    expect(mocks.openDb).not.toHaveBeenCalled();
  });
  it('loads status using the shared database', async () => {
    mocks.status.mockResolvedValue([{ id: 'fixture', migrationState: 'pending' }]);
    expect(await run(['status', '--json'])).toBe(0);
    expect(mocks.status).toHaveBeenCalledWith(await mocks.openDb.mock.results[0].value);
  });
  it('prints a preview and requires --yes before opening the database', async () => {
    const plan = { source: { extensionId: 'fixture', dir: '/fixture' }, tables: ['ext_fixture'], resetTables: [] };
    mocks.plan.mockReturnValue(plan);
    expect(await run(['drop', 'fixture'])).toBe(1);
    expect(log.mock.calls[0][0]).toContain('ext_fixture');
    expect(mocks.openDb).not.toHaveBeenCalled();
    mocks.drop.mockResolvedValue(['ext_fixture']);
    expect(await run(['drop', 'fixture', '--yes'])).toBe(0);
    expect(mocks.drop).toHaveBeenCalledWith(plan.source, plan.resetTables);
  });
  it('refuses enabled or unknown plugins before touching the database', async () => {
    mocks.plan.mockImplementation(() => {
      throw new Error('Disable plugin first');
    });
    await expect(run(['drop', 'fixture', '--yes'])).rejects.toThrow(/Disable plugin/);
    expect(mocks.openDb).not.toHaveBeenCalled();
    expect(await run(['enable', 'fixture'])).toBe(1);
  });
});
