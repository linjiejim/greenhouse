import { describe, expect, it } from 'vitest';
import { requestTargetKey } from '../target.js';

const target = (tool: string, input: Record<string, unknown>) => requestTargetKey('tool_write', { tool, input });

describe('request execution targets', () => {
  it('ignores write values and translations, and separates documents and folders', () => {
    expect(target('knowledge_mutation', { doc_id: 'a', content: 'old' })).toBe(
      target('knowledge_mutation', { doc_id: 'a', content: 'new' }),
    );
    expect(target('knowledge_mutation', { doc_id: 'a' })).not.toBe(target('knowledge_mutation', { doc_id: 'b' }));
    expect(target('knowledge_mutation', { folder_id: 'a' })).not.toBe(target('knowledge_mutation', { doc_id: 'a' }));
  });
  it('separates tables, records, schema bases, app actions and mail drafts', () => {
    for (const [tool, a, b] of [
      ['table_mutation', { table_id: 'a' }, { table_id: 'b' }],
      ['table_mutation', { table_id: 'a', record_id: '1' }, { table_id: 'a', record_id: '2' }],
      ['table_schema_plan', { base_id: 'a' }, { base_id: 'b' }],
      ['apps_action', { app_id: 'a', card: 'save' }, { app_id: 'a', card: 'delete' }],
      ['mail', { id: 'a' }, { id: 'b' }],
      ['mail', { to: ['a@example.org'], subject: 'Draft' }, { to: ['b@example.org'], subject: 'Draft' }],
      ['schedule', { schedule_id: 'a' }, { schedule_id: 'b' }],
      ['agent_edit', { agent_id: 'a' }, { agent_id: 'b' }],
    ] as const) {
      expect(target(tool, a)).not.toBeNull();
      expect(target(tool, a)).not.toBe(target(tool, b));
    }
  });
  it('normalizes record sets, repeated new rows and different actions on the same tool target', () => {
    expect(target('table_mutation', { table_id: 'a', record_id: '1' })).toBe(
      target('table_mutation', { table_id: 'a', items: [{ id: '1' }] }),
    );
    expect(
      target('table_mutation', { table_id: 'a', items: [{ values: { name: 'A' } }, { values: { name: 'B' } }] }),
    ).toBe(target('table_mutation', { table_id: 'a', values: { name: 'Replacement' } }));
    expect(target('agent_edit', { agent_id: 'a', action: 'update' })).toBe(
      target('agent_edit', { agent_id: 'a', action: 'archive' }),
    );
  });
  it('includes connector and remote tool identity, and refuses unknown targets', () => {
    const call = { connector: 'mailbox', tool: 'send', arguments: { id: 'a', body: 'old' } };
    expect(target('mcp_call', call)).toBe(target('mcp_call', { ...call, arguments: { id: 'a', body: 'new' } }));
    expect(target('mcp_call', call)).not.toBe(target('mcp_call', { ...call, tool: 'delete' }));
    expect(target('mcp_call', call)).not.toBe(target('mcp_call', { ...call, connector: 'other' }));
    expect(target('unknown', { text: 'a' })).toBeNull();
  });
  it('compares complete batch targets and question keys without depending on order', () => {
    const a = { tool: 'knowledge_mutation', input: { doc_id: 'a' } };
    const b = { tool: 'knowledge_mutation', input: { doc_id: 'b' } };
    expect(requestTargetKey('tool_write', { calls: [a, b] })).toBe(requestTargetKey('tool_write', { calls: [b, a] }));
    expect(requestTargetKey('tool_write', { calls: [a, b] })).not.toBe(requestTargetKey('tool_write', a));
    expect(requestTargetKey('ask_user', { fields: [{ key: 'city' }], question: 'Old' })).toBe(
      requestTargetKey('ask_user', { fields: [{ key: 'city' }], question: 'New' }),
    );
    expect(requestTargetKey('ask_user', { fields: [{ key: 'city' }] })).not.toBe(
      requestTargetKey('ask_user', { fields: [{ key: 'date' }] }),
    );
    expect(requestTargetKey('instructions_update', { instructions: 'Old' })).toBe(
      requestTargetKey('instructions_update', { instructions: 'New' }),
    );
  });
});
