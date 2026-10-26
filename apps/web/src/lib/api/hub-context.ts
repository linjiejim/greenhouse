/**
 * Agent hub context (v1.7) — Administration › Team context, the retro button on
 * Issues & requests and the data catalog page. See
 * apps/api/src/routes/admin-team-context.ts and routes/data-catalog.ts.
 */

import type { DataCatalog, TeamContextSettingsInput, TeamContextSettingsView } from '@greenhouse/types/hub-context';
import { rpc } from './client';

async function errorOf(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new Error(typeof data?.error === 'string' ? data.error : fallback);
}

export async function fetchTeamContextSettings(): Promise<TeamContextSettingsView> {
  const res = await rpc.api.admin['team-context'].$get();
  if (!res.ok) throw await errorOf(res, `Failed to load team context: ${res.status}`);
  return res.json();
}

export async function saveTeamContextSettings(input: TeamContextSettingsInput): Promise<TeamContextSettingsView> {
  const args = { json: input };
  const res = await rpc.api.admin['team-context'].$put(args);
  if (!res.ok) throw await errorOf(res, `Failed to save team context: ${res.status}`);
  return (await res.json()) as TeamContextSettingsView;
}

export async function fetchDataCatalog(): Promise<DataCatalog> {
  const res = await rpc.api['data-catalog'].$get();
  if (!res.ok) throw await errorOf(res, `Failed to load the data catalog: ${res.status}`);
  return res.json();
}
