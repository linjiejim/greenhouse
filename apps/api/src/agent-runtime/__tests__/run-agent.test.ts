/**
 * Tests for the headless runner's pipeline extraction.
 *
 * Regression guard for the spawn_session "empty tool results" bug: a child (or
 * scheduled) session persists its tool calls via extractPipelineAndReferences,
 * and the chat UI renders straight from that persisted `output`. Two ways it
 * silently went blank:
 *   1. it read the AI SDK v4 step fields (`args`/`result`) while the project is
 *      on v6 (`input`/`output`) → every output came through as `{}`;
 *   2. its local summarizeOutput collapsed non-whitelisted tools to
 *      `{ keys: [...] }`, dropping the real payload the UI needs.
 * Both are fixed by reading the v6 fields and reusing the canonical
 * summarizeOutput (whose default returns the full output).
 */

import { describe, it, expect } from 'vitest';
import { extractPipelineAndReferences } from '../run-agent.js';

/** A single AI SDK v6 step with one tool call + its result. */
function v6Step(toolName: string, input: unknown, output: unknown) {
  return {
    toolCalls: [{ toolCallId: 'call_1', toolName, input }],
    toolResults: [{ toolCallId: 'call_1', toolName, output }],
  };
}

describe('extractPipelineAndReferences', () => {
  it('keeps the FULL output of a non-whitelisted tool (v6 input/output fields)', () => {
    const output = { query: 'shenzhen weather', resultCount: 5, provider: 'tavily', results: [{ title: 'x' }] };
    const { pipeline } = extractPipelineAndReferences([
      v6Step('external_search', { query: 'shenzhen weather' }, output),
    ]);

    expect(pipeline).toHaveLength(1);
    expect(pipeline[0].tool).toBe('external_search');
    // The bug surfaced as output:{} (v4 field read) or output:{keys:[]} (lossy default).
    expect(pipeline[0].output).toEqual(output);
    expect(pipeline[0].input).toEqual({ query: 'shenzhen weather' });
  });

  it('still compacts whitelisted knowledge tools and extracts references', () => {
    const out = { action: 'get', doc_id: 'led-spectrum', title: 'LED Spectrum', content: 'abc', category: 'guide' };
    const { pipeline, references } = extractPipelineAndReferences([
      v6Step('knowledge_query', { action: 'get', doc_id: 'led-spectrum' }, out),
    ]);

    expect(pipeline[0].output).toEqual({ action: 'get', doc_id: 'led-spectrum', title: 'LED Spectrum', chars: 3 });
    expect(references).toEqual([
      { slug: 'led-spectrum', doc_id: 'led-spectrum', title: 'LED Spectrum', type: 'wiki', category: 'guide' },
    ]);
  });
});
