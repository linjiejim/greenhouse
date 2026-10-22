/**
 * Unit tests for the body-artifact matcher — the heart of the trace-vs-artifact
 * split. These pure functions decide which tool calls render as rich cards in the
 * message body (ask_user form, page diffs, generated images) vs. as rows in
 * the collapsible tool-call trace block.
 */

import { describe, it, expect } from 'vitest';
import { isArtifactCall, partitionCalls, replacesTraceRow, splitArtifactsByPlacement } from './body-artifacts';

describe('isArtifactCall', () => {
  it('renders a retired tool (eval_message, removed in v1.4) from old transcripts as a trace row', () => {
    expect(isArtifactCall({ name: 'eval_message', output: { score_final: 8, scores: {} } })).toBe(false);
    expect(isArtifactCall({ name: 'eval_message' })).toBe(false);
  });

  it('treats the ask_user FORM shape as an artifact regardless of which tool produced it', () => {
    const out = { type: 'ask_user', questions: [{ id: 'q', label: 'L', type: 'text' }] };
    expect(isArtifactCall({ name: 'ask_user', output: out })).toBe(true);
    // Other tools can emit the same shape for confirmations.
    expect(isArtifactCall({ name: 'custom_confirmation_tool', output: out })).toBe(true);
  });

  it('treats a finished and in-flight generated image as an artifact', () => {
    expect(isArtifactCall({ name: 'generate_image', output: { success: true, url: 'http://x/y.png' } })).toBe(true);
    expect(isArtifactCall({ name: 'generate_image' })).toBe(true);
  });

  it('treats a completed file output from any tool as a body artifact', () => {
    const output = {
      type: 'file',
      file_id: 'file-1',
      name: 'customers.xlsx',
      download_url: '/api/chat-files/file-1/content',
    };
    expect(isArtifactCall({ name: 'export_data', output })).toBe(true);
    expect(replacesTraceRow({ name: 'export_data', output })).toBe(true);
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
      { name: 'spawn_session', output: { child_session_id: 'abc' } },
      { name: 'external_search', output: { results: [] } },
      { name: 'generate_image', output: { success: true, url: 'http://x/y.png' } },
    ];
    const { trace, artifacts } = partitionCalls(calls);
    // generate_image appears in BOTH: the artifact is only the picture (and renders
    // nothing when the URL is already in the prose), so the trace row is the sole
    // record that the call happened — and the only place its cost/duration shows.
    expect(trace.map((c) => c.name)).toEqual(['knowledge_query', 'external_search', 'generate_image']);
    expect(artifacts.map((c) => c.name)).toEqual(['spawn_session', 'generate_image']);
  });

  it('returns empty arrays for an empty run', () => {
    expect(partitionCalls([])).toEqual({ trace: [], artifacts: [] });
  });
});

describe('splitArtifactsByPlacement', () => {
  it('sends the confirm-gate cards below the prose, everything else above', () => {
    const calls = [
      { name: 'spawn_session' },
      { name: 'mission_dispatch' },
      { name: 'generate_image' },
      { name: 'workflow_plan' },
      { name: 'tables_schema_plan' },
    ];
    const { above, below } = splitArtifactsByPlacement(calls);
    expect(above.map((c) => c.name)).toEqual(['spawn_session', 'generate_image']);
    // These are cards the prose introduces ("here is what I'd change — confirm?"),
    // so the button follows the explanation instead of preceding it.
    expect(below.map((c) => c.name)).toEqual(['mission_dispatch', 'workflow_plan', 'tables_schema_plan']);
  });
});

describe('replacesTraceRow', () => {
  it.each([
    ['spawn_session', { child_session_id: 'abc' }],
    ['ask_user', { type: 'ask_user', questions: [{ id: 'q', label: 'L', type: 'text' }] }],
  ])('drops the %s row — its card restates the whole call', (name, output) => {
    expect(replacesTraceRow({ name, output })).toBe(true);
  });

  it('keeps the generate_image row, completed or in flight', () => {
    expect(replacesTraceRow({ name: 'generate_image', output: { success: true, url: '/api/upload/a.png' } })).toBe(
      false,
    );
    expect(replacesTraceRow({ name: 'generate_image' })).toBe(false);
  });

  it('keeps ordinary process tools', () => {
    expect(replacesTraceRow({ name: 'knowledge_query', output: { found: 1 } })).toBe(false);
  });
});
