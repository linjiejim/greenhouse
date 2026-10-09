/**
 * Eval type definitions — shared across DB and API layers.
 *
 * DB row types and input contracts for the evaluation system, plus the one
 * reader/writer of `ground_truth` (parseGroundTruth / serializeGroundTruth).
 * Moved here from api/eval.ts to eliminate the upward dependency (db/ → api/).
 */

import type {
  RuntimeArtifact,
  RuntimeEvent,
  RuntimeInterrupt,
  RuntimeRun,
  RuntimeStep,
  RuntimeToolCall,
} from './runtime.js';
import type { MessageRow } from './session.js';

// ─── Dataset ─────────────────────────────────────────────

export interface EvalDataset {
  id: number;
  category: string;
  difficulty: string;
  question: string;
  ground_truth: string;
  expected_behavior: string | null;
  tags: string;
  language: string;
  is_negative: number;
  enabled: number;
  created_by: string | null;
  updated_by: string | null;
  source: string;
  source_session_id: string | null;
  status: string;
  notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DatasetInput {
  category: string;
  difficulty?: string;
  question: string;
  /** JSON array of the facts the answer must contain; create/import store a plain string as one fact. */
  ground_truth: string;
  expected_behavior?: string;
  tags?: string[];
  language?: string;
  is_negative?: boolean;
  enabled?: boolean;
  created_by?: string;
  updated_by?: string;
  source?: string;
  source_session_id?: string;
  status?: string;
  notes?: string;
}

export type DatasetStatus = 'active' | 'archived' | 'deprecated';
export type DatasetSource = 'manual' | 'agent' | 'import' | 'seed';

// ─── Ground truth ────────────────────────────────────────

/**
 * Read `eval_datasets.ground_truth` as the list of facts an answer must contain.
 *
 * The stored form is a JSON array of strings. Older rows (the first starter seed,
 * hand-written imports) hold one plain sentence instead: that is one fact, never
 * an error. Items are trimmed and empty ones dropped.
 */
export function parseGroundTruth(raw: unknown): string[] {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return groundTruthFacts([raw]);
    }
    // A bare JSON number, object or null someone typed is still the fact they wrote.
    if (!Array.isArray(value) && typeof value !== 'string') return groundTruthFacts([raw]);
  }
  return groundTruthFacts(Array.isArray(value) ? value : [value]);
}

/** The stored form of {@link parseGroundTruth}: always a JSON array of strings. */
export function serializeGroundTruth(raw: unknown): string {
  return JSON.stringify(parseGroundTruth(raw));
}

function groundTruthFacts(items: readonly unknown[]): string[] {
  return items
    .map((item) =>
      typeof item === 'string' ? item : typeof item === 'number' || typeof item === 'boolean' ? String(item) : '',
    )
    .map((fact) => fact.trim())
    .filter(Boolean);
}

// ─── Trace → Dataset ────────────────────────────────────

/** Editable fields proposed from durable Runtime evidence. */
export interface RuntimeDatasetDraft {
  category: string;
  difficulty: string;
  question: string;
  ground_truth: string;
  expected_behavior: string;
  tags: string[];
  language: string;
  is_negative: boolean;
  enabled: boolean;
  notes: string;
}

export interface RuntimeDatasetTraceSource {
  runtime_run_id: string;
  runtime_kind: RuntimeRun['kind'];
  runtime_status: RuntimeRun['status'];
  source_kind: string;
  source_id: string;
  session_id: string | null;
}

export interface RuntimeDatasetPreviewWarning {
  code: 'sensitive_content' | 'ground_truth_review';
  message: string;
  /** JSON-style paths into `evidence`; values remain complete and unredacted. */
  paths: string[];
}

/**
 * Full, unredacted evidence shown only to super users before explicit capture.
 * Previewing this object never creates or mutates an Eval Dataset.
 */
export interface RuntimeDatasetEvidence {
  run: RuntimeRun;
  events: RuntimeEvent[];
  steps: RuntimeStep[];
  tool_calls: RuntimeToolCall[];
  artifacts: RuntimeArtifact[];
  interrupts: RuntimeInterrupt[];
  eval_results: EvalResultWithQuestion[];
  session_messages: MessageRow[];
}

export interface RuntimeDatasetPreview {
  source: RuntimeDatasetTraceSource;
  draft: RuntimeDatasetDraft;
  evidence: RuntimeDatasetEvidence;
  warnings: RuntimeDatasetPreviewWarning[];
}

export interface RuntimeDatasetCreateInput {
  idempotency_key: string;
  dataset: RuntimeDatasetDraft;
}

export interface RuntimeDatasetCreateResult {
  dataset: EvalDataset;
  created: boolean;
  source: RuntimeDatasetTraceSource;
}

// ─── Runs ────────────────────────────────────────────────

export interface EvalRun {
  id: string;
  name: string | null;
  status: string;
  total: number;
  completed: number;
  passed: number;
  failed: number;
  avg_score: number | null;
  avg_accuracy: number | null;
  avg_completeness: number | null;
  avg_relevance: number | null;
  avg_speed: number | null;
  model: string | null;
  profile_id: string;
  config: string;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  error?: string;
}

// ─── Results ─────────────────────────────────────────────

export interface EvalResult {
  id: number;
  run_id: string;
  dataset_id: number;
  session_id: string | null;
  answer: string | null;
  references_used: string;
  duration_ms: number | null;
  score_accuracy: number | null;
  score_completeness: number | null;
  score_relevance: number | null;
  score_speed: number | null;
  score_final: number | null;
  ttfb_ms: number | null;
  answer_length: number | null;
  judge_reasoning: string | null;
  status: string;
  error: string | null;
  created_at: string;
}

export interface EvalResultWithQuestion extends EvalResult {
  question: string;
  category: string;
  difficulty: string;
  ground_truth: string;
  is_negative: number;
  tags: string;
  language: string;
  // Token usage from session messages
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_tokens?: number | null;
  reasoning_tokens?: number | null;
  pipeline?: string | null;
}
