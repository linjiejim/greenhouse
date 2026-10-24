import { afterEach, describe, expect, it, vi } from 'vitest';

const carryFrom1x = vi.fn();
vi.mock('@greenhouse/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@greenhouse/db')>()),
  carryFrom1x: (...args: unknown[]) => carryFrom1x(...args),
}));

const { CarryError, CarryFailedError } = await import('@greenhouse/db');
const { run } = await import('../migrate-from-1x.js');

const ARGS = ['--from', 'postgresql://u@127.0.0.1:1/a', '--to', 'postgresql://u@127.0.0.1:1/b', '--json'];

describe('migrate-from-1x exit codes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    carryFrom1x.mockReset();
  });

  it('a refusal (nothing written) exits 2 with "Refusing:"', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    carryFrom1x.mockRejectedValue(new CarryError('same database'));
    expect(await run(ARGS)).toBe(2);
    expect(error.mock.calls[0]?.join(' ')).toContain('Refusing:');
  });

  it('a failure after writing started exits 3 with "Carry failed:"', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    carryFrom1x.mockRejectedValue(new CarryFailedError('Writing tasks failed'));
    expect(await run(ARGS)).toBe(3);
    const line = error.mock.calls[0]?.join(' ') ?? '';
    expect(line).toContain('Carry failed:');
    expect(line).not.toContain('Refusing:');
  });
});
