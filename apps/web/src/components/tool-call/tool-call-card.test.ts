import { describe, expect, it } from 'vitest';
import { getToolIcon, Plug } from '../../lib/icons';
import { summarizeToolInput, summarizeToolOutput, toolDisplayName } from './tool-call-card';

describe('tool call summaries', () => {
  it('turns saved-workbench calls into a quiet human summary instead of raw JSON', () => {
    const summary = summarizeToolInput('workbench_query', { action: 'get', widget_id: 'w_1' });
    expect(summary).toBe('Get');
    expect(summary).not.toContain('{');
  });

  it('keeps a search query recognizable while hiding its transport shape', () => {
    expect(summarizeToolInput('external_search', { query: 'greenhouse trends', maxResults: 8 })).toBe(
      '"greenhouse trends" max=8',
    );
    expect(toolDisplayName('external_search')).toBe('Web search');
  });

  it('names the external MCP tool a call reached', () => {
    expect(toolDisplayName('mcp_call')).toBe('External tools');
    expect(
      summarizeToolInput('mcp_call', { action: 'call', server: 'orders', tool: 'lookup_order', arguments: { id: 1 } }),
    ).toBe('Call · orders/lookup_order');
    expect(summarizeToolInput('mcp_call', { action: 'list' })).toBe('List');
    expect(getToolIcon('mcp_call')).toBe(Plug);
  });

  it('only surfaces a useful count or error from generic output', () => {
    expect(summarizeToolOutput('project_query', { projects: [{ id: 1 }], total: 12 })).toBe('12');
    expect(summarizeToolOutput('project_query', { projects: [{ id: 1 }], debug: 'internal' })).toBe('');
    expect(summarizeToolOutput('project_query', { error: 'Not allowed' })).toBe('Not allowed');
  });
});
