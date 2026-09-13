import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `cli tables` is the ONLY way back from an archived Base or table — the web UI
 * deliberately offers none (spec D2). So the wiring is the promise: if a
 * subcommand misroutes, or a guard reports success without restoring anything,
 * "an administrator can restore it" stops being true. The service calls beneath
 * are covered in tables-platform.db.test.ts; this pins the command layer.
 */

const tables = vi.hoisted(() => ({
  listArchivedBases: vi.fn(),
  listArchivedTables: vi.fn(),
  getBase: vi.fn(),
  getTable: vi.fn(),
  restoreBase: vi.fn(),
  restoreTable: vi.fn(),
}));

vi.mock('./shared.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./shared.js')>()),
  openDb: vi.fn(async () => ({ tables, users: { list: vi.fn(async () => []) } })),
}));

const { run } = await import('./tables.js');

let out: string[];
let errors: string[];

beforeEach(() => {
  out = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => void out.push(args.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...args) => void errors.push(args.join(' ')));
  tables.listArchivedBases.mockResolvedValue([]);
  tables.listArchivedTables.mockResolvedValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of Object.values(tables)) fn.mockReset();
});

describe('cli tables — dispatch', () => {
  it('lists archived structure when no subcommand is given', async () => {
    expect(await run([])).toBe(0);
    expect(tables.listArchivedBases).toHaveBeenCalled();
  });

  it('rejects an unknown subcommand with usage instead of silently listing', async () => {
    expect(await run(['restore'])).toBe(1);
    expect(errors.join('\n')).toContain('Unknown tables subcommand: restore');
    expect(out.join('\n')).toContain('restore-base <id>');
    expect(tables.restoreBase).not.toHaveBeenCalled();
  });

  it.each([
    ['restore-base', 'restoreBase'],
    ['restore-table', 'restoreTable'],
  ] as const)('refuses %s without a usable id and touches nothing', async (sub, method) => {
    expect(await run([sub, 'seven'])).toBe(1);
    expect(await run([sub])).toBe(1);
    expect(tables[method]).not.toHaveBeenCalled();
  });
});

describe('cli tables — restore guards', () => {
  it('reports a missing Base rather than restoring by id blindly', async () => {
    tables.getBase.mockResolvedValue(undefined);
    expect(await run(['restore-base', '4'])).toBe(1);
    expect(errors.join('\n')).toContain('Base not found: 4');
    expect(tables.restoreBase).not.toHaveBeenCalled();
  });

  it('treats a live Base as a no-op instead of writing a pointless restore', async () => {
    tables.getBase.mockResolvedValue({ id: 4, name: 'Ops', archived_at: null });
    expect(await run(['restore-base', '4'])).toBe(0);
    expect(out.join('\n')).toContain('not archived');
    expect(tables.restoreBase).not.toHaveBeenCalled();
  });

  it('warns that tables inside a restored Base stay hidden', async () => {
    tables.getBase.mockResolvedValue({ id: 4, name: 'Ops', archived_at: '2026-08-01T00:00:00Z' });
    tables.restoreBase.mockResolvedValue({ id: 4, name: 'Ops' });
    tables.listArchivedTables.mockResolvedValue([{ id: 9, name: 'Leads', base_id: 4 }]);

    expect(await run(['restore-base', '4'])).toBe(0);
    expect(tables.restoreBase).toHaveBeenCalledWith(4);
    expect(out.join('\n')).toContain('#9 Leads');
  });

  it('warns that a restored table stays hidden while its Base is archived', async () => {
    // Silence here would read as success — the table is back but nobody can see it.
    tables.getTable.mockResolvedValue({ id: 9, name: 'Leads', base_id: 4, archived_at: '2026-08-01T00:00:00Z' });
    tables.restoreTable.mockResolvedValue({ id: 9, name: 'Leads' });
    tables.getBase.mockResolvedValue({ id: 4, name: 'Ops', archived_at: '2026-08-01T00:00:00Z' });

    expect(await run(['restore-table', '9'])).toBe(0);
    expect(tables.restoreTable).toHaveBeenCalledWith(9);
    expect(out.join('\n')).toContain('restore-base 4');
  });

  it('stays quiet about the Base when the restored table is actually visible', async () => {
    tables.getTable.mockResolvedValue({ id: 9, name: 'Leads', base_id: 4, archived_at: '2026-08-01T00:00:00Z' });
    tables.restoreTable.mockResolvedValue({ id: 9, name: 'Leads' });
    tables.getBase.mockResolvedValue({ id: 4, name: 'Ops', archived_at: null });

    expect(await run(['restore-table', '9'])).toBe(0);
    expect(out.join('\n')).not.toContain('restore-base');
  });
});
