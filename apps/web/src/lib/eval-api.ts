/**
 * Eval API client for frontend.
 *
 * Types are re-exported from shared types/eval.ts — canonical definitions
 * that can be reused across platforms.
 */

import { authFetch } from './auth';

const BASE = '';

// ─── Types (re-exported from shared) ─────────────────────

export type {
  EvalDataset,
  EvalRun,
  EvalResultWithQuestion as EvalResult,
  DatasetInput,
  DatasetStatus,
  DatasetSource,
} from '@greenhouse/types/eval';

import type { EvalDataset, EvalRun, EvalResultWithQuestion as EvalResult, DatasetInput } from '@greenhouse/types/eval';

// ─── Dataset API ─────────────────────────────────────────

export async function listDatasets(filters?: {
  category?: string;
  difficulty?: string;
  language?: string;
  enabled?: string;
  search?: string;
  status?: string;
  source?: string;
  tags?: string;
  created_by?: string;
  created_after?: string;
  created_before?: string;
  page?: number;
  page_size?: number;
  sort_by?: string;
  sort_order?: string;
}): Promise<{ datasets: EvalDataset[]; total: number }> {
  const params = new URLSearchParams();
  if (filters?.category) params.set('category', filters.category);
  if (filters?.difficulty) params.set('difficulty', filters.difficulty);
  if (filters?.language) params.set('language', filters.language);
  if (filters?.enabled) params.set('enabled', filters.enabled);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.status) params.set('status', filters.status);
  if (filters?.source) params.set('source', filters.source);
  if (filters?.tags) params.set('tags', filters.tags);
  if (filters?.created_by) params.set('created_by', filters.created_by);
  if (filters?.created_after) params.set('created_after', filters.created_after);
  if (filters?.created_before) params.set('created_before', filters.created_before);
  if (filters?.page) params.set('page', String(filters.page));
  if (filters?.page_size) params.set('page_size', String(filters.page_size));
  if (filters?.sort_by) params.set('sort_by', filters.sort_by);
  if (filters?.sort_order) params.set('sort_order', filters.sort_order);
  const res = await authFetch(`${BASE}/api/eval/datasets?${params}`);
  const data = await res.json();
  return { datasets: data.datasets, total: data.total ?? data.datasets.length };
}

export async function createDataset(input: DatasetInput): Promise<EvalDataset> {
  const res = await authFetch(`${BASE}/api/eval/datasets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function updateDataset(id: number, input: Partial<DatasetInput>): Promise<EvalDataset> {
  const res = await authFetch(`${BASE}/api/eval/datasets/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  return res.json();
}

export async function deleteDataset(id: number): Promise<void> {
  await authFetch(`${BASE}/api/eval/datasets/${id}`, { method: 'DELETE' });
}

export async function seedDatasets(): Promise<{ seeded: number }> {
  const res = await authFetch(`${BASE}/api/eval/datasets/seed`, { method: 'POST' });
  return res.json();
}

export async function batchUpdateDatasets(
  action: string,
  ids: number[],
  tags?: string[],
): Promise<{ affected: number }> {
  const res = await authFetch(`${BASE}/api/eval/datasets/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ids, tags }),
  });
  return res.json();
}

// ─── Runs API ────────────────────────────────────────────

export async function listRuns(limit = 50, search?: string): Promise<EvalRun[]> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (search) params.set('search', search);
  const res = await authFetch(`${BASE}/api/eval/runs?${params}`);
  const data = await res.json();
  return data.runs;
}

export async function startRun(
  name?: string,
  concurrency?: number,
  profileId?: string,
  datasetIds?: number[],
): Promise<EvalRun> {
  const res = await authFetch(`${BASE}/api/eval/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, concurrency, profile_id: profileId, dataset_ids: datasetIds }),
  });
  return res.json();
}

export async function getRun(id: string): Promise<{ run: EvalRun; results: EvalResult[] }> {
  const res = await authFetch(`${BASE}/api/eval/runs/${id}`);
  return res.json();
}

export async function deleteRun(id: string): Promise<void> {
  await authFetch(`${BASE}/api/eval/runs/${id}`, { method: 'DELETE' });
}

export async function cancelRun(id: string): Promise<EvalRun> {
  const res = await authFetch(`${BASE}/api/eval/runs/${id}/cancel`, { method: 'POST' });
  return res.json();
}

export async function updateRun(id: string, updates: { name?: string }): Promise<EvalRun> {
  const res = await authFetch(`${BASE}/api/eval/runs/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  return res.json();
}

export async function compareRuns(
  runIds: string[],
): Promise<{ runs: EvalRun[]; results: Record<number, Record<string, EvalResult>> }> {
  const res = await authFetch(`${BASE}/api/eval/compare?run_ids=${runIds.join(',')}`);
  return res.json();
}
