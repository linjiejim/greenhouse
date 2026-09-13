/** Super-only Trace → Eval Dataset client used by Execution Center. */

import type {
  RuntimeDatasetCreateInput,
  RuntimeDatasetCreateResult,
  RuntimeDatasetPreview,
} from '@greenhouse/types/eval';
import { fetchJson } from '../http';

/**
 * This deeply chained Eval branch makes hc exceed TypeScript's recursion
 * limit (TS2589), as does the neighboring Runtime client. Keep request and
 * response types on the shared wire contract while retaining the repository's
 * authenticated/error-normalizing HTTP helper.
 */
export function previewRuntimeDataset(runId: string): Promise<RuntimeDatasetPreview> {
  return fetchJson<RuntimeDatasetPreview>(`/api/eval/datasets/from-runtime/${encodeURIComponent(runId)}/preview`);
}

export function createRuntimeDataset(
  runId: string,
  input: RuntimeDatasetCreateInput,
): Promise<RuntimeDatasetCreateResult> {
  return fetchJson<RuntimeDatasetCreateResult>(`/api/eval/datasets/from-runtime/${encodeURIComponent(runId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}
