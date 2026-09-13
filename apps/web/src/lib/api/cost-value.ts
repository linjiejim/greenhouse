/** Super-only cost/value operating report. */

import { rpc } from './client';

export async function fetchCostValueReport(input: { since: string; until: string; runLimit?: number }) {
  const query = {
    since: input.since,
    until: input.until,
    ...(input.runLimit ? { run_limit: String(input.runLimit) } : {}),
  };
  const response = await rpc.api.admin.operations['cost-value'].$get({ query });
  if (!response.ok) {
    const body = await response.json();
    throw new Error('error' in body ? body.error : `Failed to load operating report (${response.status})`);
  }
  return response.json();
}

export type CostValueReport = Awaited<ReturnType<typeof fetchCostValueReport>>;
