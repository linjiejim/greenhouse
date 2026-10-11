/**
 * Pure pieces of Tables automations: template rendering per reader, value
 * tokens, webhook field maps, schedule validation and the 24 h catch-up rule.
 */

import { describe, expect, it } from 'vitest';
import type { TableFieldRow } from '@greenhouse/db';
import { renderTemplate, resolveActionValues, webhookFields, type RenderContext } from '../automation-render.js';
import { dueOccurrence, nextOccurrence, validateTablesSchedule } from '../automation-schedule.js';

function field(
  id: number,
  name: string,
  type: TableFieldRow['type'],
  config: Record<string, unknown> = {},
): TableFieldRow {
  return { id, name, type, config: JSON.stringify(config) } as unknown as TableFieldRow;
}

const fields = [
  field(1, 'Title', 'text'),
  field(2, 'Amount', 'number'),
  field(3, 'Status', 'single_select', { options: [{ id: 'open', label: 'Open' }] }),
  field(4, 'Owner', 'user'),
  field(5, 'Paid', 'boolean'),
  field(6, 'When', 'datetime'),
  field(7, 'Total', 'formula'),
  field(8, 'Due', 'date'),
  field(9, 'Assignees', 'multi_user'),
];
const record = {
  values: { '1': 'Contract', '2': 9000, '3': 'open', '4': 'u1', '5': false, '6': '2026-10-11T01:30:00.000Z' },
  computed_values: { '7': 18000 },
};

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  return {
    fields: new Map(fields.map((entry) => [entry.id, entry])),
    record,
    usersById: new Map([['u1', { id: 'u1', nickname: 'Lin', email: 'lin@example.test' }]]),
    locale: 'en',
    timeZone: 'Asia/Shanghai',
    readable: null,
    ...overrides,
  };
}

describe('renderTemplate', () => {
  it('renders display text for every field type', () => {
    expect(
      renderTemplate(
        '{{field:1}} · {{field:2}} · {{field:3}} · {{field:4}} · {{field:5}} · {{field:6}} · {{field:7}} · {{field:8}}',
        context(),
      ),
    ).toBe('Contract · 9000 · Open · Lin · No · 2026-10-11 09:30 · 18000 · —');
    expect(renderTemplate('{{field:5}}', context({ locale: 'zh' }))).toBe('否');
  });

  it('writes "—" for anything the reader may not see, and without a record', () => {
    expect(renderTemplate('{{field:1}} {{field:2}} {{field:99}}', context({ readable: new Set([1]) }))).toBe(
      'Contract — —',
    );
    expect(renderTemplate('{{field:1}}', context({ record: null }))).toBe('—');
  });
});

describe('resolveActionValues', () => {
  const now = new Date('2026-10-11T17:30:00.000Z'); // 01:30 on the 12th in Shanghai
  const resolve = (value: unknown, fieldId: number, actor = { id: 'u2', nickname: 'Ann', email: 'ann@example.test' }) =>
    resolveActionValues([{ fieldId, value }], {
      targetFields: new Map(fields.map((entry) => [entry.id, entry])),
      source: context(),
      actor,
      now,
    })[String(fieldId)];

  it('expands $now / $today in the rule zone and $actor per field type', () => {
    expect(resolve('$now', 6)).toBe('2026-10-11T17:30:00.000Z');
    expect(resolve('$now', 8)).toBe('2026-10-12');
    expect(resolve('$today', 8)).toBe('2026-10-12');
    expect(resolve('$now', 1)).toBe('2026-10-12 01:30');
    expect(resolve('$actor', 4)).toBe('u2');
    expect(resolve('$actor', 9)).toEqual(['u2']);
    expect(resolve('$actor', 1)).toBe('Ann');
  });

  it('fills {{field}} templates from the triggering record and keeps literals', () => {
    expect(resolve('Re: {{field:1}} ({{field:3}})', 1)).toBe('Re: Contract (Open)');
    expect(resolve(42, 2)).toBe(42);
  });
});

describe('webhookFields', () => {
  it('maps names to raw values, limited to the chosen fields', () => {
    expect(webhookFields(fields, record, [1, 7])).toEqual({ Title: 'Contract', Total: 18000 });
    expect(Object.keys(webhookFields(fields, record, undefined))).toHaveLength(fields.length);
    expect(webhookFields(fields, null, undefined)).toEqual({});
  });
});

describe('schedules', () => {
  it('accepts every-15-minutes and slower, refuses faster and nonsense', () => {
    expect(validateTablesSchedule({ cron: '*/15 * * * *', timezone: 'UTC' })).toBeNull();
    expect(validateTablesSchedule({ cron: '0 9 * * 1-5', timezone: 'Asia/Shanghai' })).toBeNull();
    expect(validateTablesSchedule({ cron: '*/5 * * * *', timezone: 'UTC' })).toMatch(/15 minutes/);
    expect(validateTablesSchedule({ cron: '0,10 9 * * *', timezone: 'UTC' })).toMatch(/15 minutes/);
    expect(validateTablesSchedule({ cron: 'whenever', timezone: 'UTC' })).toMatch(/Invalid cron/);
  });

  it('computes occurrences in the schedule zone', () => {
    const daily = { cron: '0 9 * * *', timezone: 'Asia/Shanghai', scope: 'once' as const };
    expect(nextOccurrence(daily, new Date('2026-10-11T00:30:00.000Z'))?.toISOString()).toBe('2026-10-11T01:00:00.000Z');
  });

  it('runs only the latest missed occurrence within 24 hours', () => {
    const hourly = { cron: '0 * * * *', timezone: 'UTC', scope: 'once' as const };
    expect(dueOccurrence(hourly, new Date('2026-10-11T05:00:00Z'), new Date('2026-10-11T08:20:00Z'))).toEqual({
      occurrence: new Date('2026-10-11T08:00:00Z'),
      next: new Date('2026-10-11T09:00:00Z'),
    });
    // Down for three days: only the occurrence just before now, none of the older ones.
    expect(
      dueOccurrence(hourly, new Date('2026-10-08T05:00:00Z'), new Date('2026-10-11T08:20:00Z')).occurrence,
    ).toEqual(new Date('2026-10-11T08:00:00Z'));
    const weekly = { cron: '0 9 * * 1', timezone: 'UTC', scope: 'once' as const };
    // Missed by more than a day: skipped, the next one is scheduled.
    expect(dueOccurrence(weekly, new Date('2026-10-05T09:00:00Z'), new Date('2026-10-07T10:00:00Z'))).toEqual({
      occurrence: null,
      next: new Date('2026-10-12T09:00:00Z'),
    });
  });
});
