import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppsQueryTool } from '../apps-query.js';
import { createAppsActionTool } from '../apps-action.js';
import { createTablesQueryTool } from '../tables-query.js';
import { dispatchTablesAgentAction } from '../../platform/tables/agent-adapter.js';
import type { AppRuntimeView } from '@greenhouse/types/apps';

vi.mock('../../platform/tables/agent-adapter.js', () => ({ dispatchTablesAgentAction: vi.fn() }));
vi.mock('../../auth/features.js', () => ({ activeUserHasFeature: vi.fn(async () => true) }));
vi.mock('@greenhouse/db', async (original) => ({
  ...(await original<object>()),
  getDb: () => ({ tables: { getTable: async (id: number) => ({ base_id: id === 1 ? 10 : 20 }) } }),
}));
const dispatch = vi.mocked(dispatchTablesAgentAction);
const input = { app_id: 1, page_id: 'home', card_id: 'tickets', action_id: 'close', record_id: 3, revision: 4 };
let version = 1;
const calls = { toolCallId: 'test', messages: [] };
// Tool execute return type also allows an async iterable; these tools always resolve one result.
async function call(tool: unknown, value: unknown): Promise<unknown> {
  return (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(value, calls);
}
beforeEach(() => {
  version = 1;
  dispatch.mockReset();
  dispatch.mockImplementation(async (_ctx, action) => {
    if (action === 'getApp')
      return {
        ok: true,
        data: {
          app: { id: 1, name: 'Tickets' },
          version,
          specToken: `published:${version}`,
          spec: {
            pages: [
              {
                id: 'home',
                title: 'Home',
                cards: [
                  {
                    id: 'tickets',
                    kind: 'records',
                    actions: [
                      {
                        id: 'close',
                        label: 'Close ticket',
                        do: { type: 'set_fields', values: [{ fieldId: 5, value: 'closed' }] },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      };
    if (action === 'getAppRecord')
      return { ok: true, data: { record: { id: 3, revision: 4, actionIds: ['close'], values: { 5: 'open' } } } };
    return { ok: true, data: { outcome: 'updated' } };
  });
});
describe('Apps tools', () => {
  it('queries through the role-scoped gateway including custom bindings', async () => {
    await call(createAppsQueryTool({ userId: 'member' }), { action: 'record', ...input, binding_id: 'rows' });
    expect(dispatch).toHaveBeenCalledWith(
      { userId: 'member' },
      'getAppRecord',
      expect.objectContaining({ bindingId: 'rows', recordId: 3 }),
      { appId: 1 },
    );
  });
  it('chat requires confirmation on every call and shows the stored effect', async () => {
    const tool = createAppsActionTool({ userId: 'member' });
    expect(await call(tool, input)).toMatchObject({ needs_confirmation: true, summary: 'Tickets: Close ticket' });
    expect(dispatch.mock.calls.some((c) => c[1] === 'runAppAction')).toBe(false);
    await call(tool, { ...input, user_confirmed: true });
    expect(dispatch.mock.calls.filter((c) => c[1] === 'runAppAction')).toHaveLength(1);
    expect(await call(tool, input)).toMatchObject({ needs_confirmation: true });
  });
  it('Bots ignore model confirmation and use server-resolved approval details', async () => {
    const approve = vi.fn(async () => false);
    await call(createAppsActionTool({ userId: 'member', approve }), {
      ...input,
      user_confirmed: true,
      label: 'Harmless',
    });
    expect(approve).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: 'Tickets: Close ticket',
        details: expect.arrayContaining([
          { label: 'Effect', value: JSON.stringify({ type: 'set_fields', values: [{ fieldId: 5, value: 'closed' }] }) },
        ]),
      }),
    );
    expect(dispatch.mock.calls.some((c) => c[1] === 'runAppAction')).toBe(false);
  });
  it('a changed app invalidates a pending Bot approval', async () => {
    const approve = async () => {
      version++;
      return true;
    };
    expect(await call(createAppsActionTool({ userId: 'member', approve }), input)).toMatchObject({
      error: 'App changed; approval is no longer valid',
    });
    expect(dispatch.mock.calls.some((c) => c[1] === 'runAppAction')).toBe(false);
  });
  it('an approved action pins the server spec token and still uses the gateway', async () => {
    expect(await call(createAppsActionTool({ userId: 'member', approve: async () => true }), input)).toEqual({
      outcome: 'updated',
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'member' }),
      'runAppAction',
      expect.objectContaining({ expectedSpecToken: 'published:1', actionId: 'close', recordId: 3, revision: 4 }),
      { appId: 1 },
    );
  });
  it('resolves an action declared only in the record detail before asking for approval', async () => {
    const original = dispatch.getMockImplementation()!;
    dispatch.mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === 'getApp' && result.ok) {
        const card = (result.data as AppRuntimeView).spec.pages[0]!.cards[0]!;
        if (card.kind === 'records') {
          card.detail = { fieldIds: [5], actions: card.actions };
          delete card.actions;
        }
      }
      return result;
    });
    const approve = vi.fn(async () => true);
    expect(await call(createAppsActionTool({ userId: 'member', approve }), input)).toEqual({ outcome: 'updated' });
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({ summary: 'Tickets: Close ticket' }));
  });
  it('rejects a record whose fresh action list no longer includes the action', async () => {
    dispatch.mockImplementation(async (_ctx, action) =>
      action === 'getApp'
        ? {
            ok: true,
            data: {
              app: { id: 1, name: 'Tickets' },
              spec: {
                pages: [
                  { id: 'home', cards: [{ id: 'tickets', kind: 'records', actions: [{ id: 'close', do: {} }] }] },
                ],
              },
            },
          }
        : { ok: true, data: { record: { revision: 4, actionIds: [] } } },
    );
    const approve = vi.fn(async () => true);
    expect(await call(createAppsActionTool({ userId: 'member', approve }), input)).toMatchObject({
      error: 'Action no longer applies',
    });
    expect(approve).not.toHaveBeenCalled();
    expect(dispatch.mock.calls.some((c) => c[1] === 'runAppAction')).toBe(false);
  });
  it('same_base_read rejects unrelated Base ids and all non-record read actions', async () => {
    const tool = createTablesQueryTool({ userId: 'member', onlyBaseId: 10 });
    expect(await call(tool, { action: 'records.query', table_id: 2 })).toHaveProperty('error');
    expect(await call(tool, { action: 'directory.search' })).toHaveProperty('error');
    expect(dispatch).not.toHaveBeenCalled();
    await call(tool, { action: 'records.query', table_id: 1 });
    expect(dispatch).toHaveBeenCalledWith(
      { userId: 'member' },
      'queryRecords',
      { tableId: 1, query: {} },
      { tableId: 1 },
    );
  });
});
