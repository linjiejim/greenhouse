/**
 * Home workbench card evaluation client.
 *
 * One batched round trip per refresh: the endpoint fans out server-side with a
 * concurrency cap and a short cache, so a dashboard with a dozen cards costs
 * one request rather than a dozen (and never touches the agent proxy's
 * per-call rate limit).
 */

import type { WorkbenchQueryRequest, WorkbenchQueryResult } from '@greenhouse/types/workbench';
import { authFetch } from '../auth';

export async function evaluateWorkbench(requests: WorkbenchQueryRequest[]): Promise<WorkbenchQueryResult[]> {
  if (requests.length === 0) return [];
  const response = await authFetch('/api/workbench/query', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (!response.ok) throw new Error('Unable to load workbench data');
  const body = (await response.json()) as { results?: WorkbenchQueryResult[] };
  return body.results ?? [];
}
