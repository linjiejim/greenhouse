/**
 * In-memory stand-ins for the services USD metering touches
 * (`usageBudget.ensureAccount` / `reserve`, `metering.*`), for unit tests that
 * fake the DatabaseProvider by hand. Accounts start empty, limits come from
 * whatever the metering layer resolved (env / defaults: no admin rows).
 */

import { vi } from 'vitest';

interface FakeAccount {
  id: string;
  scope_type: string;
  scope_id: string;
  unit: string;
  limit_units: number;
  spent_units: number;
  reserved_units: number;
}

export function fakeMeteringServices() {
  const accounts = new Map<string, FakeAccount>();
  const ensureAccount = vi.fn(
    async (input: { scope_type: string; scope_id: string; unit?: string; limit_units?: number }) => {
      const id = `${input.scope_type}:${input.scope_id}:${input.unit ?? 'tokens'}`;
      const row = accounts.get(id) ?? {
        id,
        scope_type: input.scope_type,
        scope_id: input.scope_id,
        unit: input.unit ?? 'tokens',
        limit_units: input.limit_units ?? 0,
        spent_units: 0,
        reserved_units: 0,
      };
      row.limit_units = input.limit_units ?? row.limit_units;
      accounts.set(id, row);
      return row;
    },
  );
  const reserve = vi.fn(async () => []);
  const metering = {
    getLimits: vi.fn(async () => []),
    getAccounts: vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => accounts.get(id)).filter((row): row is FakeAccount => Boolean(row)),
    ),
    recordService: vi.fn(async (input: Record<string, unknown>) => ({ id: 'svu_test', ...input })),
  };
  return { accounts, ensureAccount, reserve, metering };
}
