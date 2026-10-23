/**
 * Activity log API — see apps/api/src/routes/activity.ts.
 */

import type { ActivityItem, ActivityPage, ActivitySource } from '@greenhouse/types/activity';
import { downloadAuthenticatedFile } from '../file-download';
import { rpc } from './client';

export interface ActivityFilters {
  source?: ActivitySource | null;
  module?: string | null;
  /** Super only; members always get their own. */
  userId?: string | null;
  /** ISO dates. */
  from?: string | null;
  to?: string | null;
}

function queryOf(filters: ActivityFilters, extra: Record<string, string> = {}): Record<string, string> {
  const query: Record<string, string> = { ...extra };
  if (filters.source) query.source = filters.source;
  if (filters.module) query.module = filters.module;
  if (filters.userId) query.user_id = filters.userId;
  if (filters.from) query.from = filters.from;
  if (filters.to) query.to = filters.to;
  return query;
}

function errorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== 'object' || !('error' in value)) return fallback;
  return typeof value.error === 'string' ? value.error : fallback;
}

export async function fetchActivity(
  filters: ActivityFilters,
  page: { cursor?: string | null; limit?: number } = {},
): Promise<ActivityPage> {
  const extra: Record<string, string> = {};
  if (page.cursor) extra.cursor = page.cursor;
  if (page.limit) extra.limit = String(page.limit);
  const args = { query: queryOf(filters, extra) };
  const response = await rpc.api.activity.$get(args);
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load activity (${response.status})`));
  // The route hands back the shared ActivityPage shape (packages/types/src/activity.ts).
  return data as ActivityPage;
}

export function activityExportUrl(filters: ActivityFilters): string {
  return `/api/activity/export?${new URLSearchParams(queryOf(filters)).toString()}`;
}

export async function exportActivityCsv(filters: ActivityFilters): Promise<void> {
  await downloadAuthenticatedFile(activityExportUrl(filters), 'activity.csv');
}

/** Home "recent changes": the team's latest changes the viewer may read. */
export async function fetchRecentChanges(limit = 12): Promise<ActivityItem[]> {
  const args = { query: { limit: String(limit) } };
  const response = await rpc.api.activity.recent.$get(args);
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(data, `Unable to load recent changes (${response.status})`));
  // The route hands back the shared ActivityItem shape (packages/types/src/activity.ts).
  return (data as { items: ActivityItem[] }).items;
}
