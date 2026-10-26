import { authFetch } from '@greenhouse/web/extension-kit';
import type { FeatureRequest } from '@greenhouse/types/api';
export type { FeatureRequest } from '@greenhouse/types/api';
// ─── Feature Requests ──────────────────────────────────

export async function fetchFeatureRequests(status?: string): Promise<{ total: number; requests: FeatureRequest[] }> {
  const res = await authFetch('/api/admin/feature-requests' + (status ? '?status=' + encodeURIComponent(status) : ''));
  if (!res.ok) throw new Error(`Failed to fetch feature requests: ${res.status}`);
  return res.json();
}

export async function updateFeatureRequest(
  id: string,
  updates: { status?: string; priority?: string; admin_note?: string },
): Promise<{ request: FeatureRequest }> {
  const res = await authFetch(`/api/admin/feature-requests/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error(`Failed to update feature request: ${res.status}`);
  return res.json();
}
