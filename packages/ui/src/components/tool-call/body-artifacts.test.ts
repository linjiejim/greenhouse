/**
 * Unit tests for the body-artifact matcher — the heart of the trace-vs-artifact
 * split. These pure functions decide which tool calls render as rich cards in the
 * message body (ask_user form, page diffs, generated images) vs. as rows in
 * the collapsible tool-call trace block.
 */

import { describe, it, expect } from 'vitest';
import { isArtifactCall, partitionCalls } from './body-artifacts';

describe('isArtifactCall', () => {
  it('treats the ask_user FORM shape as an artifact regardless of which tool produced it', () => {
    const out = { type: 'ask_user', questions: [{ id: 'q', label: 'L', type: 'text' }] };
    expect(isArtifactCall({ name: 'ask_user', output: out })).toBe(true);
    // email_manager (and others) can emit the same shape for confirmations.
    expect(isArtifactCall({ name: 'email_manager', output: out })).toBe(true);
  });

  it('treats a successful update_page as an artifact and a non-success one as trace', () => {
    expect(isArtifactCall({ name: 'update_page', output: { success: true, changes: [] } })).toBe(true);
    expect(isArtifactCall({ name: 'update_page', output: { error: 'conflict' } })).toBe(false);
  });

  it('treats a finished generated image (success+url) as an artifact, in-flight as trace', () => {
    expect(isArtifactCall({ name: 'generate_image', output: { success: true, url: 'http://x/y.png' } })).toBe(true);
    expect(isArtifactCall({ name: 'generate_image' })).toBe(false); // in-flight: no output yet
  });

  it('leaves ordinary process tools in the trace block', () => {
    expect(isArtifactCall({ name: 'knowledge_query', output: { found: 3 } })).toBe(false);
    expect(isArtifactCall({ name: 'external_search', output: { results: [] } })).toBe(false);
  });
});

describe('partitionCalls', () => {
  it('splits a mixed run into trace rows and body artifacts, preserving order within each', () => {
    const calls = [
      { name: 'knowledge_query', output: { found: 2 } },
      { name: 'update_page', output: { success: true, changes: [] } },
      { name: 'external_search', output: { results: [] } },
      { name: 'generate_image', output: { success: true, url: 'http://x/y.png' } },
    ];
    const { trace, artifacts } = partitionCalls(calls);
    expect(trace.map((c) => c.name)).toEqual(['knowledge_query', 'external_search']);
    expect(artifacts.map((c) => c.name)).toEqual(['update_page', 'generate_image']);
  });

  it('returns empty arrays for an empty run', () => {
    expect(partitionCalls([])).toEqual({ trace: [], artifacts: [] });
  });
});
