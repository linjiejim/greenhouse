import { describe, expect, it } from 'vitest';
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

  it('only surfaces a useful count or error from generic output', () => {
    expect(summarizeToolOutput('project_query', { projects: [{ id: 1 }], total: 12 })).toBe('12');
    expect(summarizeToolOutput('project_query', { projects: [{ id: 1 }], debug: 'internal' })).toBe('');
    expect(summarizeToolOutput('project_query', { error: 'Not allowed' })).toBe('Not allowed');
  });
});
