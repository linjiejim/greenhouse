/**
 * Contract tests for the schema-plan analyzer and applier.
 *
 * Both are pure of the database: the analyzer decides shape, and the applier is
 * driven by an injected dispatch so these tests pin the sequencing and
 * ref-resolution rules without a Platform runtime. Authorization is NOT tested
 * here on purpose — it belongs to the runtime actions, and the route test
 * covers it end to end.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { analyzeSchemaPlan, applySchemaPlan, type SchemaPlanDispatch } from '../schema-plan.js';

const ok = (data: unknown): PlatformActionResult => ({ ok: true, data });
const fail = (message: string): PlatformActionResult => ({ ok: false, code: 'CONFLICT', message });

describe('analyzeSchemaPlan', () => {
  it('accepts a plan that creates a Base, its table and fields', () => {
    const result = analyzeSchemaPlan([
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't', defaultTableName: 'Leads' },
      { op: 'field.create', tableRef: 't', name: 'Stage', type: 'text' },
      { op: 'table.create', ref: 't2', baseRef: 'b', name: 'Contacts' },
      { op: 'field.create', tableRef: 't2', name: 'Email', type: 'email' },
    ]);
    expect('error' in result).toBe(false);
    if ('error' in result) return;
    // Nothing pre-existing is touched, so nothing needs a permission probe.
    expect(result.baseRequirements.size).toBe(0);
    expect(result.tableRequirements.size).toBe(0);
  });

  it('rejects a ref used before it is created', () => {
    const result = analyzeSchemaPlan([
      { op: 'field.create', tableRef: 't', name: 'Stage', type: 'text' },
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't' },
    ]);
    expect(result).toEqual({ error: expect.stringContaining('no table with ref "t"') });
  });

  it('rejects a duplicate ref', () => {
    const result = analyzeSchemaPlan([
      { op: 'base.create', ref: 'x', name: 'A' },
      { op: 'table.create', ref: 'x', baseRef: 'x', name: 'B' },
    ]);
    expect(result).toEqual({ error: expect.stringContaining('already used') });
  });

  it('rejects giving both a ref and an id, or neither', () => {
    expect(
      analyzeSchemaPlan([
        { op: 'base.create', ref: 'b', name: 'A' },
        { op: 'table.create', baseRef: 'b', baseId: 7, name: 'B' },
      ]),
    ).toEqual({ error: expect.stringContaining('exactly one of baseRef or baseId') });

    expect(analyzeSchemaPlan([{ op: 'field.create', name: 'Stage', type: 'text' }])).toEqual({
      error: expect.stringContaining('exactly one of tableRef or tableId'),
    });
  });

  it('requires owner for Base settings but only builder for structure', () => {
    const result = analyzeSchemaPlan([
      { op: 'table.create', baseId: 4, name: 'B' },
      { op: 'base.update', baseId: 4, name: 'Renamed' },
    ]);
    if ('error' in result) throw new Error(result.error);
    // The strictest requirement across the plan wins, so a plan that renames a
    // Base cannot slip through on builder alone.
    expect(result.baseRequirements.get(4)).toBe('owner');
  });

  it('collects field targets with their claimed table for the membership check', () => {
    const result = analyzeSchemaPlan([
      { op: 'field.archive', tableId: 9, fieldId: 12 },
      { op: 'field.update', tableId: 9, fieldId: 13, name: 'Renamed' },
    ]);
    if ('error' in result) throw new Error(result.error);
    expect(result.tableRequirements.get(9)).toBe('builder');
    expect(result.fieldTargets).toEqual([
      { tableId: 9, fieldId: 12 },
      { tableId: 9, fieldId: 13 },
    ]);
  });
});

describe('applySchemaPlan', () => {
  it('resolves refs forward, including the table created alongside a Base', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId) => {
      if (actionId === 'createBase') return ok({ base: { id: 1 }, schema: { table: { id: 10 } } });
      if (actionId === 'createTable') return ok({ table: { id: 11 } });
      return ok({ field: { id: 100 } });
    });

    const operations: SchemaPlanOperation[] = [
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't', defaultTableName: 'Leads' },
      { op: 'field.create', tableRef: 't', name: 'Stage', type: 'text' },
      { op: 'table.create', ref: 't2', baseRef: 'b', name: 'Contacts' },
      { op: 'field.create', tableRef: 't2', name: 'Email', type: 'email' },
    ];
    const result = await applySchemaPlan(operations, dispatch);

    expect(result.results.map((entry) => entry.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(result.baseId).toBe(1);
    // The Base's own table is addressable, so its fields land there rather than
    // beside an orphan "Table 1".
    expect(dispatch).toHaveBeenNthCalledWith(2, 'createField', expect.objectContaining({ tableId: 10 }), {
      tableId: 10,
    });
    expect(dispatch).toHaveBeenNthCalledWith(4, 'createField', expect.objectContaining({ tableId: 11 }), {
      tableId: 11,
    });
  });

  it('skips everything hanging off a failed creation, and keeps going elsewhere', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId, payload) => {
      if (actionId === 'createTable') {
        const named = payload as { name?: string };
        return named.name === 'Contacts' ? fail('A resource with this name already exists') : ok({ table: { id: 11 } });
      }
      return ok({ field: { id: 100 } });
    });

    const operations: SchemaPlanOperation[] = [
      { op: 'table.create', ref: 'bad', baseId: 1, name: 'Contacts' },
      { op: 'field.create', tableRef: 'bad', name: 'Email', type: 'email' },
      { op: 'table.create', ref: 'good', baseId: 1, name: 'Leads' },
      { op: 'field.create', tableRef: 'good', name: 'Stage', type: 'text' },
    ];
    const result = await applySchemaPlan(operations, dispatch);

    expect(result.results.map((entry) => entry.status)).toEqual(['failed', 'skipped', 'applied', 'applied']);
    // The skipped field says WHY, rather than vanishing or being applied to the wrong table.
    expect(result.results[1]?.message).toContain('already exists');
    // Independent work still ran: exactly one createField was suppressed.
    expect(dispatch.mock.calls.filter(([action]) => action === 'createField')).toHaveLength(1);
  });

  it('reports a failed operation without aborting the rest of the plan', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId) =>
      actionId === 'archiveField' ? fail('Primary or unavailable fields cannot be archived') : ok({ field: { id: 2 } }),
    );

    const result = await applySchemaPlan(
      [
        { op: 'field.archive', tableId: 5, fieldId: 1 },
        { op: 'field.create', tableId: 5, name: 'Notes', type: 'long_text' },
      ],
      dispatch,
    );

    expect(result.results.map((entry) => entry.status)).toEqual(['failed', 'applied']);
    expect(result.results[0]?.message).toContain('Primary');
  });

  it('offers no Base link when the plan spans several Bases', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async () => ok({ table: { id: 1 } }));
    const result = await applySchemaPlan(
      [
        { op: 'table.create', baseId: 1, name: 'A' },
        { op: 'table.create', baseId: 2, name: 'B' },
      ],
      dispatch,
    );
    expect(result.baseId).toBeUndefined();
  });
});
