/**
 * Admin API — per-user tool/profile assignment, feature requests, usage summary.
 */

import type { FeatureRequest, UserUsageSummary } from '@greenhouse/types/api';
import { rpc } from './client';

// ─── Tool / Profile Assignment ─────────────────────────

/** Fetch assigned tool IDs for a specific user (admin only). */
export async function fetchUserTools(userId: string): Promise<{ assigned: string[]; available: string[] }> {
  const res = await rpc.api.admin.users[':id'].tools.$get({ param: { id: userId } });
  if (!res.ok) throw new Error(`fetchUserTools failed: ${res.status}`);
  return res.json();
}

/** Set assigned tools for a user (admin only, full replace). */
export async function setUserTools(userId: string, toolIds: string[]): Promise<void> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: userId }, json: { tools: toolIds } };
  const res = await rpc.api.admin.users[':id'].tools.$put(args);
  if (!res.ok) throw new Error(`setUserTools failed: ${res.status}`);
}

/** Fetch assigned profile IDs for a specific user (admin only). */
export async function fetchUserProfiles(userId: string): Promise<{ assigned: string[]; available: string[] }> {
  const res = await rpc.api.admin.users[':id'].profiles.$get({ param: { id: userId } });
  if (!res.ok) throw new Error(`fetchUserProfiles failed: ${res.status}`);
  return res.json();
}

/** Set assigned profiles for a user (admin only, full replace). */
export async function setUserProfiles(userId: string, profileIds: string[]): Promise<void> {
  const args = { param: { id: userId }, json: { profiles: profileIds } };
  const res = await rpc.api.admin.users[':id'].profiles.$put(args);
  if (!res.ok) throw new Error(`setUserProfiles failed: ${res.status}`);
}

// ─── Feature Requests ──────────────────────────────────

export async function fetchFeatureRequests(
  status?: string,
  limit?: number,
): Promise<{ total: number; requests: FeatureRequest[] }> {
  const query: { status?: string; limit?: string } = {};
  if (status) query.status = status;
  if (limit !== undefined) query.limit = String(limit);
  const res = await rpc.api.admin['feature-requests'].$get({ query });
  if (!res.ok) throw new Error(`Failed to fetch feature requests: ${res.status}`);
  return res.json();
}

export async function updateFeatureRequest(
  id: number,
  updates: { status?: string; priority?: string; admin_note?: string },
): Promise<{ request: FeatureRequest }> {
  const args = { param: { id: String(id) }, json: updates };
  const res = await rpc.api.admin['feature-requests'][':id'].$patch(args);
  if (!res.ok) throw new Error(`Failed to update feature request: ${res.status}`);
  return res.json();
}

// ─── User Usage Summary ────────────────────────────────

export async function fetchUserUsageSummary(since?: string): Promise<{ by_user: UserUsageSummary[] }> {
  const res = await rpc.api.admin.usage.summary.$get({
    query: since ? { since } : {},
  });
  if (!res.ok) throw new Error(`Failed to fetch user usage: ${res.status}`);
  return res.json();
}
