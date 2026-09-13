/**
 * Admin API — per-user tool assignment, feature requests, usage summary.
 */

import type { FeatureRequest, UserUsageSummary } from '@greenhouse/types/api';
import { rpc } from './client';

async function responseError(response: Response, fallback: string): Promise<Error> {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => ({}));
  const message =
    body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : fallback;
  return new Error(message);
}

// ─── Internal user account lifecycle ───────────────────

export async function fetchManagedUsers() {
  const res = await rpc.api.admin.users.$get();
  if (!res.ok) throw await responseError(res, `fetchManagedUsers failed: ${res.status}`);
  return res.json();
}

export async function createManagedUser(input: {
  email: string;
  nickname: string;
  role: 'team';
  monthly_token_limit: number;
  credential_mode: 'email_link' | 'direct_password';
  password?: string;
}) {
  const args = { json: input };
  const res = await rpc.api.admin.users.$post(args);
  if (!res.ok) throw await responseError(res, `createManagedUser failed: ${res.status}`);
  return res.json();
}

export async function resetManagedUserPassword(
  userId: string,
  input: { mode: 'email_link' } | { mode: 'direct_password'; password: string },
) {
  const args = { param: { id: userId }, json: input };
  const res = await rpc.api.admin.users[':id']['reset-password'].$post(args);
  if (!res.ok) throw await responseError(res, `resetManagedUserPassword failed: ${res.status}`);
  return res.json();
}

export type ManagedUsersResponse = Awaited<ReturnType<typeof fetchManagedUsers>>;
export type ManagedUser = ManagedUsersResponse['users'][number];
export type PasswordLinkCapability = ManagedUsersResponse['password_link_capability'];

export async function resendManagedUserPasswordLink(userId: string) {
  const res = await rpc.api.admin.users[':id']['password-link'].resend.$post({ param: { id: userId } });
  if (!res.ok) throw await responseError(res, `resendManagedUserPasswordLink failed: ${res.status}`);
  return res.json();
}

export async function revokeManagedUserPasswordLink(userId: string): Promise<void> {
  const res = await rpc.api.admin.users[':id']['password-link'].revoke.$post({ param: { id: userId } });
  if (!res.ok) throw await responseError(res, `revokeManagedUserPasswordLink failed: ${res.status}`);
}

// ─── Tool Assignment ───────────────────────────────────

/** Fetch assigned tool IDs for a specific user (super only). */
export async function fetchUserTools(userId: string): Promise<{ assigned: string[]; available: string[] }> {
  const res = await rpc.api.admin.users[':id'].tools.$get({ param: { id: userId } });
  if (!res.ok) throw new Error(`fetchUserTools failed: ${res.status}`);
  return res.json();
}

/** Set assigned tools for a user (super only, full replace). */
export async function setUserTools(userId: string, toolIds: string[]): Promise<void> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id: userId }, json: { tools: toolIds } };
  const res = await rpc.api.admin.users[':id'].tools.$put(args);
  if (!res.ok) throw new Error(`setUserTools failed: ${res.status}`);
}

// ─── Unified access view (feature-point aggregate) ─────

/**
 * Composed per-user access view for the unified permission modal — feature flags,
 * platform capabilities/entity policies, and tool grants organized by feature point.
 */
export async function fetchUserAccess(userId: string) {
  const res = await rpc.api.admin.users[':id'].access.$get({ param: { id: userId } });
  if (!res.ok) throw new Error(`fetchUserAccess failed: ${res.status}`);
  return res.json();
}

export type UserAccessView = Awaited<ReturnType<typeof fetchUserAccess>>;
export type AccessFeaturePoint = UserAccessView['featurePoints'][number];

// ─── Feature Requests ──────────────────────────────────

export async function fetchFeatureRequests(status?: string): Promise<{ total: number; requests: FeatureRequest[] }> {
  const res = await rpc.api.admin['feature-requests'].$get({
    query: status ? { status } : {},
  });
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
