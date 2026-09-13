/** Parse the immutable provenance line stored ahead of operator Eval notes. */

const TRACE_PREFIX = '[runtime-trace:v1] ';

export interface EvalTraceProvenance {
  runtime_run_id: string;
  runtime_kind: string;
  source_kind: string;
  source_id: string;
}

export function parseEvalTraceNotes(notes: string | null): {
  notes: string;
  provenance: EvalTraceProvenance | null;
} {
  if (!notes?.startsWith(TRACE_PREFIX)) return { notes: notes ?? '', provenance: null };
  const separator = notes.indexOf('\n\n');
  const firstLine = separator >= 0 ? notes.slice(0, separator) : notes;
  const operatorNotes = separator >= 0 ? notes.slice(separator + 2) : '';
  try {
    const value = JSON.parse(firstLine.slice(TRACE_PREFIX.length)) as Record<string, unknown>;
    if (
      typeof value.runtime_run_id !== 'string' ||
      typeof value.runtime_kind !== 'string' ||
      typeof value.source_kind !== 'string' ||
      typeof value.source_id !== 'string'
    ) {
      return { notes, provenance: null };
    }
    return {
      notes: operatorNotes,
      provenance: {
        runtime_run_id: value.runtime_run_id,
        runtime_kind: value.runtime_kind,
        source_kind: value.source_kind,
        source_id: value.source_id,
      },
    };
  } catch {
    return { notes, provenance: null };
  }
}
