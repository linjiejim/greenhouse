/**
 * The rule editor's pure model: stored rule → draft → payload keeps action ids,
 * turns tokens and literals back into values, never sends a webhook secret it
 * was not given, and names the first problem before a round trip.
 */

import { describe, expect, it } from 'vitest';
import type { TableAutomation, TableField } from '../../../lib/api/tables';
import { draftToInput, newActionDraft, newRuleDraft, ruleToDraft, type RuleDraft } from './rule-draft';

const stamp = '2026-10-11T00:00:00.000Z';

function field(id: number, name: string, type: TableField['type'], tableId = 7): TableField {
  return {
    id,
    table_id: tableId,
    name,
    type,
    required: false,
    is_primary: id === 1,
    config: '{}',
    position: id,
    created_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    archived_at: null,
  };
}

const fields = [
  field(1, 'Name', 'text'),
  field(2, 'Amount', 'number'),
  field(3, 'When', 'datetime'),
  field(4, 'Owner', 'user'),
];
const fieldsByTable = new Map([
  [7, fields],
  [8, [field(10, 'Title', 'text', 8)]],
]);

function rule(overrides: Partial<TableAutomation> = {}): TableAutomation {
  return {
    id: 5,
    base_id: 3,
    table_id: 7,
    name: 'Approve',
    status: 'enabled',
    trigger: 'record_updated',
    config: {
      version: 1,
      watchFieldIds: [2],
      actions: [
        {
          id: 'a1',
          type: 'update_record',
          values: [
            { fieldId: 2, value: 42 },
            { fieldId: 3, value: '$now' },
            { fieldId: 4, value: '$actor' },
          ],
        },
        { id: 'a2', type: 'create_record', tableId: 8, values: [{ fieldId: 10, value: 'From {{field:1}}' }] },
        { id: 'a7', type: 'webhook', url: 'https://hooks.example.com/in', hasSecret: true },
        { id: 'a8', type: 'delay', minutes: 30 },
      ],
    },
    execution_user_id: 'u1',
    revision: 4,
    next_fire_at: null,
    swept_until: null,
    created_by: 'u1',
    updated_by: 'u1',
    created_at: stamp,
    updated_at: stamp,
    ...overrides,
  };
}

function input(draft: RuleDraft) {
  const result = draftToInput(draft, fieldsByTable);
  if (!result.ok) throw new Error(`unexpected problem ${result.problem.key}`);
  return result.input;
}

describe('rule drafts', () => {
  it('round-trips a stored rule without changing what it does', () => {
    const draft = ruleToDraft(rule(), fieldsByTable, 'Asia/Shanghai');
    expect(input(draft)).toEqual({
      name: 'Approve',
      tableId: 7,
      trigger: 'record_updated',
      status: 'enabled',
      config: {
        version: 1,
        watchFieldIds: [2],
        actions: [
          {
            id: 'a1',
            type: 'update_record',
            values: [
              { fieldId: 2, value: 42 },
              { fieldId: 3, value: '$now' },
              { fieldId: 4, value: '$actor' },
            ],
          },
          { id: 'a2', type: 'create_record', tableId: 8, values: [{ fieldId: 10, value: 'From {{field:1}}' }] },
          // The stored secret is kept by saying nothing about it.
          { id: 'a7', type: 'webhook', url: 'https://hooks.example.com/in' },
          { id: 'a8', type: 'delay', minutes: 30 },
        ],
      },
    });
  });

  it('sends a new secret, a cleared one as null, and refuses a short one', () => {
    const draft = ruleToDraft(rule(), fieldsByTable, 'UTC');
    const webhook = draft.actions[2]!;
    if (webhook.type !== 'webhook') throw new Error('expected a webhook');
    expect(webhook.hasSecret).toBe(true);
    const withSecret = (secretAction: 'set' | 'clear', secret = '') => ({
      ...draft,
      actions: draft.actions.map((action, index) => (index === 2 ? { ...webhook, secretAction, secret } : action)),
    });
    expect(input(withSecret('set', 's'.repeat(20))).config.actions[2]).toMatchObject({ secret: 's'.repeat(20) });
    expect(input(withSecret('clear')).config.actions[2]).toMatchObject({ secret: null });
    expect(draftToInput(withSecret('set', 'short'), fieldsByTable)).toEqual({
      ok: false,
      problem: { key: 'tables.automations.problem.secret', step: 3 },
    });
  });

  it('names the first problem, step by step', () => {
    const fresh = newRuleDraft({ tableId: 7, timezone: 'UTC' });
    expect(draftToInput(fresh, fieldsByTable)).toMatchObject({
      ok: false,
      problem: { key: 'tables.automations.problem.name' },
    });
    const named = { ...fresh, name: 'Rule' };
    expect(draftToInput(named, fieldsByTable)).toMatchObject({
      ok: false,
      problem: { key: 'tables.automations.problem.recipients', step: 1 },
    });
    expect(draftToInput({ ...named, trigger: 'record_matched' }, fieldsByTable)).toMatchObject({
      ok: false,
      problem: { key: 'tables.automations.problem.condition' },
    });
    expect(
      draftToInput({ ...named, actions: [{ key: 'k1', type: 'delay', minutes: '2000' }] }, fieldsByTable),
    ).toMatchObject({ ok: false, problem: { key: 'tables.automations.problem.delay', step: 1 } });
  });

  it('drops record-only settings when the schedule runs once', () => {
    const draft: RuleDraft = {
      ...newRuleDraft({ tableId: 7, timezone: 'Asia/Shanghai' }),
      name: 'Daily digest',
      trigger: 'schedule',
      cron: '0 9 * * *',
      scope: 'once',
      condition: { combinator: 'and', clauses: [{ fieldId: 2, operator: 'gt', value: 1 }] },
      actions: [
        {
          ...newActionDraft('notify', 7),
          type: 'notify',
          recipients: { userIds: ['u1'], groupIds: [], userFieldIds: [4], creator: true, actor: true },
          title: 'Digest',
          message: 'Morning',
          im: true,
          email: false,
        },
      ],
    };
    expect(input(draft).config).toEqual({
      version: 1,
      schedule: { cron: '0 9 * * *', timezone: 'Asia/Shanghai', scope: 'once' },
      actions: [
        {
          type: 'notify',
          recipients: { userIds: ['u1'] },
          title: 'Digest',
          message: 'Morning',
          channels: ['inbox', 'im'],
        },
      ],
    });
  });
});
