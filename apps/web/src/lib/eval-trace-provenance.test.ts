import { describe, expect, it } from 'vitest';
import { parseEvalTraceNotes } from './eval-trace-provenance';

describe('parseEvalTraceNotes', () => {
  it('separates immutable Runtime provenance from editable operator notes', () => {
    const provenance = {
      runtime_run_id: 'rtr-1',
      runtime_kind: 'mission',
      source_kind: 'agent_run',
      source_id: 'mission-1',
    };
    expect(parseEvalTraceNotes(`[runtime-trace:v1] ${JSON.stringify(provenance)}\n\nHuman note`)).toEqual({
      notes: 'Human note',
      provenance,
    });
  });

  it('leaves ordinary or malformed notes untouched', () => {
    expect(parseEvalTraceNotes('Ordinary note')).toEqual({ notes: 'Ordinary note', provenance: null });
    expect(parseEvalTraceNotes('[runtime-trace:v1] not-json')).toEqual({
      notes: '[runtime-trace:v1] not-json',
      provenance: null,
    });
  });
});
