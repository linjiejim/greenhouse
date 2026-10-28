import { describe, it, expect } from 'vitest';
import {
  entityQuery,
  entityColumns,
  fieldText,
  parseInstant,
  writableValues,
  embedMessage,
  embedUrl,
  safeEndpoint,
  normalizeNavigate,
} from './surface-model';
import type { PluginEntitySchema } from '../shared/plugins';
const entity: PluginEntitySchema = {
  id: 'crm.company',
  title: 'Company',
  title_field: 'name',
  kind: 'ext:crm:company',
  endpoint: '/api/ext/crm/entities/company',
  actions: ['read', 'update'],
  fields: [
    { key: 'name', title: 'Name', kind: 'text', writable: true, required: true, sortable: true },
    { key: 'status', title: 'Status', kind: 'enum', values: ['open'], filterable: true, writable: true },
    { key: 'amount', title: 'Amount', kind: 'money', writable: true },
    { key: 'secret', title: 'Secret', kind: 'text' },
  ],
  views: [
    {
      id: 'default',
      columns: ['name', 'amount', 'missing'],
      filters: ['status'],
      sort: { field: 'name', dir: 'desc' },
    },
  ],
};
describe('declarative surfaces', () => {
  it('builds the CRUD skip/limit/sort/filter protocol from permitted view fields', () => {
    const q = new URLSearchParams(entityQuery(entity, entity.views[0], 50, { status: 'open', secret: 'x' }));
    expect(q.get('skip')).toBe('50');
    expect(q.get('limit')).toBe('50');
    expect(JSON.parse(q.get('sort')!)).toEqual([{ key: 'name', order: 'desc' }]);
    expect(JSON.parse(q.get('filter')!)).toEqual([{ key: 'status', method: 'eq', value: ['open'] }]);
    expect(entityColumns(entity, entity.views[0]).map((f) => f.key)).toEqual(['name', 'amount']);
  });
  it('formats every field without coercing objects to object Object', () => {
    expect(fieldText({ key: 'x', title: 'X', kind: 'boolean' }, true, 'zh')).toBe('是');
    expect(fieldText({ key: 'x', title: 'X', kind: 'json' }, { a: 1 }, 'en')).toBe('{"a":1}');
    expect(fieldText(entity.fields[2], 1000, 'en')).toBe('1,000.00');
    expect(fieldText(entity.fields[0], null, 'en')).toBe('—');
    const owner = { key: 'owner', title: 'Owner', kind: 'user' as const };
    expect(fieldText(owner, 'usr_1', 'en', { usr_1: 'Ada' })).toBe('Ada');
    expect(fieldText(owner, 'usr_2', 'en', { usr_1: 'Ada' })).toBe('usr_2');
    expect(fieldText(entity.fields[2], 1000.236, 'zh')).toBe('1,000.24');
    expect(fieldText({ key: 'x', title: 'X', kind: 'date' }, '2026-10-22', 'en')).toBe(
      new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(new Date(2026, 9, 22)),
    );
    expect(fieldText({ key: 'x', title: 'X', kind: 'dateTime' }, 'invalid', 'en')).toBe('invalid');
    expect(fieldText({ key: 'x', title: 'X', kind: 'dateTime' }, '2026-10-27T09:54:24Z', 'en')).not.toMatch(/:24/);
  });
  it('writes only writable keys, parses numbers and rejects invalid input', () => {
    expect(writableValues(entity, { name: 'Acme', status: 'open', amount: '12', secret: 'no' })).toEqual({
      name: 'Acme',
      status: 'open',
      amount: 12,
    });
    expect(() => writableValues(entity, { name: '', amount: '2' })).toThrow('name');
    expect(() => writableValues(entity, { name: 'A', amount: 'oops' })).toThrow('amount');
  });
  it('patches only changed writable values, preserving untouched nulls and structured values', () => {
    const schema = {
      ...entity,
      fields: [
        ...entity.fields,
        { key: 'enabled', title: 'Enabled', kind: 'boolean' as const, writable: true },
        { key: 'json', title: 'JSON', kind: 'json' as const, writable: true },
        { key: 'createdAt', title: 'Created', kind: 'dateTime' as const, writable: false },
      ],
    };
    const initial = {
      name: 'Acme',
      status: null,
      amount: 12,
      enabled: false,
      json: { a: [1] },
      createdAt: '2026-10-26 22:50:11.703622+00',
    };
    const draft = {
      name: 'Acme',
      status: '',
      amount: '12.0',
      enabled: false,
      json: '{ "a": [1] }',
      createdAt: 'bad',
      secret: 'bad',
    };
    expect(writableValues(schema, draft, initial)).toEqual({});
    expect(writableValues(schema, { ...draft, name: 'Edited', enabled: true, json: '{"a":[2]}' }, initial)).toEqual({
      name: 'Edited',
      enabled: true,
      json: { a: [2] },
    });
    expect(writableValues(schema, { name: 'Edited' }, initial)).toEqual({ name: 'Edited' });
    expect(() => writableValues(schema, { name: '' }, initial)).toThrow('name');
    expect(writableValues(schema, { status: '' }, { ...initial, status: 'open' })).toEqual({ status: null });
  });
  it('accepts only the framed origin and protocol, including token refresh', () => {
    for (const type of ['greenhouse:ready', 'greenhouse:token-refresh'])
      expect(embedMessage({ type }, 'https://station.test', 'https://station.test')).toEqual({ type });
    expect(embedMessage({ type: 'greenhouse:title', title: 'CRM' }, 'null', 'https://station.test')).toBeNull();
    expect(
      embedMessage({ type: 'greenhouse:sendPrompt', text: 'Draft' }, 'https://evil.test', 'https://station.test'),
    ).toBeNull();
    expect(
      embedMessage(
        { type: 'greenhouse:navigate', href: 'javascript:alert(1)' },
        'https://station.test',
        'https://station.test',
      ),
    ).toBeNull();
    expect(
      embedMessage(
        { type: 'greenhouse:navigate', href: '//evil.test' },
        'https://station.test',
        'https://station.test',
      ),
    ).toBeNull();
    expect(embedMessage('bad', 'https://station.test', 'https://station.test')).toBeNull();
    expect(
      embedMessage({ type: 'greenhouse:sendPrompt', text: 'Draft' }, 'https://station.test', 'https://station.test'),
    ).toEqual({ type: 'greenhouse:sendPrompt', text: 'Draft' });
  });
  it('validates iframe and REST URLs', () => {
    expect(embedUrl('/ext/crm/ui/#/home', 'https://station.test', 'dark', 'zh')).toBe(
      'https://station.test/ext/crm/ui/?theme=dark&locale=zh#/home',
    );
    expect(embedUrl('javascript:x', 'https://station.test', 'light', 'en')).toBeNull();
    expect(safeEndpoint('//evil.test')).toBe(false);
    expect(normalizeNavigate('https://station.test/#/projects/3', 'https://station.test')).toBe('#/projects/3');
    expect(normalizeNavigate('https://evil.test/knowledge', 'https://station.test')).toBeNull();
    expect(safeEndpoint('/api/ext/crm/entities/company')).toBe(true);
  });
});

describe('parseInstant', () => {
  it('reads Postgres timestamp text the way an ISO string reads', () => {
    expect(parseInstant('2026-10-27 08:35:36.094111+00')).toBe(Date.parse('2026-10-27T08:35:36.094Z'));
    expect(parseInstant('2026-10-27 16:35:36+08:00')).toBe(Date.parse('2026-10-27T08:35:36Z'));
    expect(parseInstant('2026-10-27T08:35:36.5+0530')).toBe(Date.parse('2026-10-27T03:05:36.500Z'));
    expect(parseInstant('2026-10-27T08:35:36Z')).toBe(Date.parse('2026-10-27T08:35:36Z'));
    expect(Number.isNaN(parseInstant('yesterday'))).toBe(true);
  });
});
