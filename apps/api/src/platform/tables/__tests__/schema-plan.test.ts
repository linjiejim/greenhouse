/**
 * Contract tests for the schema-plan analyzer, ref tokens and applier.
 *
 * All three are pure of the database: the analyzer decides shape, the token
 * rewriter is a JSON walk, and the applier is driven by an injected dispatch,
 * so these tests pin the sequencing and ref-resolution rules without a
 * Platform runtime. Authorization is NOT tested here on purpose — it belongs to
 * the runtime actions, and the route test covers it end to end.
 */

import { describe, it, expect, vi } from 'vitest';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { analyzeSchemaPlan, applySchemaPlan, type SchemaPlanDispatch } from '../schema-plan.js';
import { collectRefTokens, resolveRefTokens } from '../schema-plan-refs.js';

const ok = (data: unknown): PlatformActionResult => ({ ok: true, data });
const fail = (message: string): PlatformActionResult => ({ ok: false, code: 'CONFLICT', message });

describe('ref tokens', () => {
  const ids: Record<string, number> = { status: 41, owner: 42, deals: 7, board: 90, sales: 3 };
  const lookup = ({ ref }: { ref: string }) => ids[ref];

  it('rewrites automation values, including the field-keyed entries and templates', () => {
    const config = {
      actions: [
        { type: 'update_record', values: [{ fieldId: '$field:status', value: 'done' }] },
        { type: 'notify', recipients: { userFieldIds: ['$field:owner'] }, title: 'Done: {{field:$field:status}}' },
        { type: 'create_record', tableId: '$table:deals', values: { '$field:status': 'new' } },
      ],
    };
    expect(resolveRefTokens(config, lookup)).toEqual({
      actions: [
        { type: 'update_record', values: [{ fieldId: 41, value: 'done' }] },
        { type: 'notify', recipients: { userFieldIds: [42] }, title: 'Done: {{field:41}}' },
        { type: 'create_record', tableId: 7, values: { '41': 'new' } },
      ],
    });
  });

  it('rewrites form defaults and view widths keys', () => {
    expect(
      resolveRefTokens({ fieldIds: ['$field:owner'], defaults: [{ fieldId: '$field:status', value: '$me' }] }, lookup),
    ).toEqual({ fieldIds: [42], defaults: [{ fieldId: 41, value: '$me' }] });
    expect(resolveRefTokens({ widths: { '$field:status': 160, created_at: 120 } }, lookup)).toEqual({
      widths: { '41': 160, created_at: 120 },
    });
  });

  it('rewrites a widget card source and a role rule', () => {
    expect(
      resolveRefTokens(
        {
          kind: 'kpi',
          source: { tableId: '$table:deals' },
          aggregate: { operation: 'sum', valueFieldId: '$field:owner' },
        },
        lookup,
      ),
    ).toEqual({ kind: 'kpi', source: { tableId: 7 }, aggregate: { operation: 'sum', valueFieldId: 42 } });
    expect(
      resolveRefTokens(
        {
          version: 1,
          dashboards: 'all',
          tables: [
            {
              tableId: '$table:deals',
              access: 'read',
              rows: { type: 'related', creator: false, fieldIds: ['$field:owner'] },
              fields: [{ fieldId: '$field:status', access: 'hidden' }],
              fieldDefault: 'visible',
            },
          ],
        },
        lookup,
      ),
    ).toMatchObject({
      tables: [{ tableId: 7, rows: { fieldIds: [42] }, fields: [{ fieldId: 41, access: 'hidden' }] }],
    });
  });

  it('leaves ordinary text alone and refuses a ref with no id', () => {
    expect(resolveRefTokens({ value: 'cost $field: none', other: '$fields:x' }, lookup)).toEqual({
      value: 'cost $field: none',
      other: '$fields:x',
    });
    expect(() => resolveRefTokens({ fieldId: '$field:missing' }, lookup)).toThrow(/\$field:missing/);
  });

  it('collects every token once, from keys, values and templates', () => {
    expect(collectRefTokens({ a: '$field:x', b: { '$field:y': 1 }, c: ['{{field:$field:x}}', '$view:v'] })).toEqual([
      { kind: 'field', ref: 'x' },
      { kind: 'field', ref: 'y' },
      { kind: 'view', ref: 'v' },
    ]);
  });
});

describe('analyzeSchemaPlan', () => {
  it('accepts a plan that creates a Base, its table and fields', () => {
    const result = analyzeSchemaPlan([
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't', defaultTableName: 'Leads' },
      { op: 'field.create', tableRef: 't', name: 'Stage', type: 'text' },
      { op: 'table.create', ref: 't2', baseRef: 'b', name: 'Contacts' },
      { op: 'field.create', tableRef: 't2', name: 'Email', type: 'email' },
    ]);
    if ('error' in result) throw new Error(result.error);
    expect(result.declared.get('t')).toEqual({ kind: 'table', index: 0 });
    expect(result.needs[3]).toEqual([{ kind: 'table', ref: 't2' }]);
  });

  it('rejects a ref used before it is created', () => {
    const result = analyzeSchemaPlan([
      { op: 'field.create', tableRef: 't', name: 'Stage', type: 'text' },
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't' },
    ]);
    expect(result).toEqual({ error: expect.stringContaining('no table with ref "t"') });
  });

  it('rejects a duplicate ref, and a token of the wrong kind', () => {
    expect(
      analyzeSchemaPlan([
        { op: 'base.create', ref: 'x', name: 'A' },
        { op: 'table.create', ref: 'x', baseRef: 'x', name: 'B' },
      ]),
    ).toEqual({ error: expect.stringContaining('already used') });
    expect(
      analyzeSchemaPlan([
        { op: 'base.create', ref: 'b', name: 'A', defaultTableRef: 't' },
        {
          op: 'view.create',
          tableRef: 't',
          name: 'Board',
          type: 'kanban',
          config: { kanban: { groupFieldId: '$field:t' } },
        },
      ]),
    ).toEqual({ error: expect.stringContaining('ref "t" is a table, not a field') });
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
    expect(analyzeSchemaPlan([{ op: 'widget.create', title: 'KPI', card: { kind: 'text' } }])).toEqual({
      error: expect.stringContaining('exactly one of dashboardRef or dashboardId'),
    });
  });

  it('records which refs an operation needs, from top-level refs and config tokens', () => {
    const result = analyzeSchemaPlan([
      { op: 'base.create', ref: 'b', name: 'A', defaultTableRef: 't' },
      { op: 'field.create', ref: 'status', tableRef: 't', name: 'Status', type: 'single_select' },
      { op: 'role.create', ref: 'r', baseRef: 'b', name: 'Reader', rules: { tables: [{ tableId: '$table:t' }] } },
      { op: 'view.create', tableRef: 't', name: 'Board', config: { kanban: { groupFieldId: '$field:status' } } },
    ]);
    if ('error' in result) throw new Error(result.error);
    expect(result.needs[2]).toEqual([
      { kind: 'base', ref: 'b' },
      { kind: 'table', ref: 't' },
    ]);
    expect(result.needs[3]).toEqual([
      { kind: 'table', ref: 't' },
      { kind: 'field', ref: 'status' },
    ]);
  });

  it('never lets a group be builder, and names a custom role only with role custom', () => {
    expect(
      analyzeSchemaPlan([{ op: 'member.set', baseId: 1, principal: 'group', groupId: 3, role: 'builder' }]),
    ).toEqual({ error: expect.stringContaining('builder is granted to people only') });
    expect(
      analyzeSchemaPlan([{ op: 'member.set', baseId: 1, principal: 'user', userId: 'u1', role: 'custom' }]),
    ).toEqual({ error: expect.stringContaining('exactly one of roleRef or customRoleId') });
    expect(
      analyzeSchemaPlan([
        { op: 'member.set', baseId: 1, principal: 'user', userId: 'u1', role: 'editor', customRoleId: 4 },
      ]),
    ).toEqual({ error: expect.stringContaining('only with role "custom"') });
    expect(
      analyzeSchemaPlan([{ op: 'member.set', baseId: 1, principal: 'group', userId: 'u1', role: 'viewer' }]),
    ).toEqual({ error: expect.stringContaining('names groupId') });
  });

  it('refuses a plan-created role granted on another Base', () => {
    expect(
      analyzeSchemaPlan([
        { op: 'role.create', ref: 'r', baseId: 1, name: 'R', rules: {} },
        { op: 'member.set', baseId: 2, principal: 'user', userId: 'u1', role: 'custom', roleRef: 'r' },
      ]),
    ).toEqual({ error: expect.stringContaining('belongs to another Base') });
  });

  it('refuses webhooks, secrets and an executor in automations (D16, D17)', () => {
    const webhook = { type: 'webhook', url: 'https://hooks.example.com/x' };
    expect(
      analyzeSchemaPlan([
        { op: 'automation.create', tableId: 1, name: 'Out', trigger: 'record_created', config: { actions: [webhook] } },
      ]),
    ).toEqual({ error: expect.stringContaining('webhook actions can only be added or changed in the Tables editor') });
    // An update may carry a webhook the rule already has (id kept) — the draft check compares it to the stored one.
    expect(
      'error' in
        analyzeSchemaPlan([
          {
            op: 'automation.update',
            tableId: 1,
            automationId: 2,
            revision: 3,
            config: { actions: [{ ...webhook, id: 'a1' }] },
          },
        ]),
    ).toBe(false);
    expect(
      analyzeSchemaPlan([
        {
          op: 'automation.update',
          tableId: 1,
          automationId: 2,
          revision: 3,
          config: { actions: [{ ...webhook, id: 'a1', secret: 'shh-secret-value' }] },
        },
      ]),
    ).toEqual({ error: expect.stringContaining('webhook') });
    expect(
      analyzeSchemaPlan([
        {
          op: 'automation.create',
          tableId: 1,
          name: 'As someone else',
          trigger: 'record_created',
          config: { executionUserId: 'u_owner', actions: [] },
        },
      ]),
    ).toEqual({ error: expect.stringContaining('executor') });
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
    expect(result.refs).toEqual({
      b: { kind: 'base', id: 1 },
      t: { kind: 'table', id: 10 },
      t2: { kind: 'table', id: 11 },
    });
    expect(result.attempts).toBe(1);
    // The Base's own table is addressable, so its fields land there rather than
    // beside an orphan "Table 1".
    expect(dispatch).toHaveBeenNthCalledWith(2, 'createField', expect.objectContaining({ tableId: 10 }), {
      tableId: 10,
    });
    expect(dispatch).toHaveBeenNthCalledWith(4, 'createField', expect.objectContaining({ tableId: 11 }), {
      tableId: 11,
    });
  });

  it('rewrites config tokens to the ids created earlier in the plan', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId) => {
      if (actionId === 'createField') return ok({ field: { id: 55 } });
      if (actionId === 'createView') return ok({ view: { id: 9 } });
      if (actionId === 'getSchema') return ok({ table: { id: 4, base_id: 2 } });
      if (actionId === 'createAutomation') return ok({ automation: { id: 12 } });
      return ok({});
    });
    await applySchemaPlan(
      [
        { op: 'field.create', ref: 'status', tableId: 4, name: 'Status', type: 'single_select' },
        {
          op: 'view.create',
          tableId: 4,
          name: 'Board',
          type: 'kanban',
          config: { kanban: { groupFieldId: '$field:status' }, widths: { '$field:status': 200 } },
        },
        {
          op: 'automation.create',
          tableId: 4,
          name: 'Close',
          trigger: 'record_created',
          config: { actions: [{ type: 'update_record', values: [{ fieldId: '$field:status', value: 'open' }] }] },
        },
      ],
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith(
      'createView',
      expect.objectContaining({ scope: 'shared', config: { kanban: { groupFieldId: 55 }, widths: { '55': 200 } } }),
      { tableId: 4 },
    );
    // The automation's Base is read from the table, because the handler needs both.
    expect(dispatch).toHaveBeenCalledWith(
      'createAutomation',
      expect.objectContaining({
        baseId: 2,
        tableId: 4,
        status: 'disabled',
        config: { actions: [{ type: 'update_record', values: [{ fieldId: 55, value: 'open' }] }] },
      }),
      { baseId: 2 },
    );
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

  it('skips an operation whose config token points at a failed creation', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId) =>
      actionId === 'createField' ? fail('bad options') : ok({ view: { id: 3 } }),
    );
    const result = await applySchemaPlan(
      [
        { op: 'field.create', ref: 'status', tableId: 4, name: 'Status', type: 'single_select' },
        {
          op: 'view.create',
          tableId: 4,
          name: 'Board',
          type: 'kanban',
          config: { kanban: { groupFieldId: '$field:status' } },
        },
      ],
      dispatch,
    );
    expect(result.results.map((entry) => entry.status)).toEqual(['failed', 'skipped']);
    expect(result.results[1]?.message).toContain('bad options');
    expect(dispatch).not.toHaveBeenCalledWith('createView', expect.anything(), expect.anything());
  });

  it('retries only what did not apply, reusing the ids it already created', async () => {
    let roleFails = true;
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId) => {
      if (actionId === 'createBase') return ok({ base: { id: 1 }, schema: { table: { id: 10 } } });
      if (actionId === 'createRole') return roleFails ? fail('role name taken') : ok({ role: { id: 6 } });
      return ok({ success: true });
    });
    const operations: SchemaPlanOperation[] = [
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't' },
      { op: 'role.create', ref: 'r', baseRef: 'b', name: 'Reader', rules: { version: 1 } },
      { op: 'member.set', baseRef: 'b', principal: 'group', groupId: 3, role: 'custom', roleRef: 'r' },
    ];
    const first = await applySchemaPlan(operations, dispatch);
    expect(first.results.map((entry) => entry.status)).toEqual(['applied', 'failed', 'skipped']);

    roleFails = false;
    dispatch.mockClear();
    const second = await applySchemaPlan(operations, dispatch, first);
    expect(second.results.map((entry) => entry.status)).toEqual(['applied', 'applied', 'applied']);
    expect(second.attempts).toBe(2);
    expect(dispatch).not.toHaveBeenCalledWith('createBase', expect.anything(), expect.anything());
    expect(dispatch).toHaveBeenCalledWith(
      'manageMembers',
      { baseId: 1, principal: 'group', groupId: 3, role: 'custom', customRoleId: 6 },
      { baseId: 1 },
    );
    expect(second.refs).toMatchObject({ b: { id: 1 }, r: { kind: 'role', id: 6 } });
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

  it('removes a grant with role none, and names a widget card table', async () => {
    const dispatch = vi.fn<SchemaPlanDispatch>(async () => ok({ widget: { id: 8 } }));
    await applySchemaPlan(
      [
        { op: 'member.set', baseId: 1, principal: 'user', userId: 'u1', role: 'none' },
        {
          op: 'widget.create',
          dashboardId: 2,
          title: 'Count',
          card: { kind: 'kpi', source: { tableId: 4 } },
          layout: { x: 0, y: 0, w: 4, h: 3 },
        },
      ],
      dispatch,
    );
    expect(dispatch).toHaveBeenCalledWith(
      'manageMembers',
      { baseId: 1, principal: 'user', userId: 'u1', operation: 'remove' },
      { baseId: 1 },
    );
    expect(dispatch).toHaveBeenCalledWith(
      'createDashboardWidget',
      {
        dashboardId: 2,
        title: 'Count',
        config: { version: 2, card: { kind: 'kpi', source: { tableId: 4 } } },
        layout: { version: 1, x: 0, y: 0, w: 4, h: 3 },
        tableId: 4,
      },
      { dashboardId: 2 },
    );
  });

  it('restores a kept webhook’s stored URL on apply and refuses a new one there too (D16)', async () => {
    const stored = { id: 'a1', type: 'webhook', url: 'https://hooks.example.com/in?token=t0p', hasSecret: true };
    const dispatch = vi.fn<SchemaPlanDispatch>(async (actionId) => {
      if (actionId === 'getSchema') return ok({ table: { id: 4, base_id: 2 } });
      if (actionId === 'listAutomations') return ok({ automations: [{ id: 9, config: { actions: [stored] } }] });
      return ok({ automation: { id: 9 } });
    });
    const update = (url: string): SchemaPlanOperation => ({
      op: 'automation.update',
      tableId: 4,
      automationId: 9,
      revision: 1,
      config: {
        actions: [
          { id: 'a1', type: 'webhook', url },
          { type: 'delay', minutes: 5 },
        ],
      },
    });
    const kept = await applySchemaPlan([update('https://hooks.example.com/…')], dispatch);
    expect(kept.results[0]?.status).toBe('applied');
    expect(dispatch).toHaveBeenCalledWith(
      'updateAutomation',
      expect.objectContaining({
        config: {
          actions: [
            { id: 'a1', type: 'webhook', url: 'https://hooks.example.com/in?token=t0p' },
            { type: 'delay', minutes: 5 },
          ],
        },
      }),
      { automationId: 9 },
    );

    dispatch.mockClear();
    const changed = await applySchemaPlan([update('https://elsewhere.example.com/in')], dispatch);
    expect(changed.results[0]).toMatchObject({ status: 'failed', message: expect.stringContaining('Tables editor') });
    expect(dispatch).not.toHaveBeenCalledWith('updateAutomation', expect.anything(), expect.anything());
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
