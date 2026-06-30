/**
 * Sessions API — session CRUD, message editing, regeneration,
 * shareable users and per-session shares.
 */

import type { Session, Message, SessionUsage, ShareInfo, ShareableUser, ShareItem } from '@greenhouse/types/api';
import { rpc } from './client';

export async function createSession(
  title?: string,
  profileId?: string,
  context?: SessionContextData | null,
): Promise<Session> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet).
  const args = { json: { title, profile_id: profileId, ...(context ? { context } : {}) } };
  const res = await rpc.api.sessions.$post(args);
  if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
  return res.json();
}

export async function listSessions(status?: string, includeEval = true): Promise<Session[]> {
  const query: Record<string, string> = { limit: '500' };
  if (status && status !== 'all') query.status = status;
  if (includeEval) query.include_eval = '1';
  try {
    const res = await rpc.api.sessions.$get({ query });
    if (!res.ok) return [];
    return (await res.json()).sessions ?? [];
  } catch {
    return [];
  }
}

export async function getSession(
  id: string,
): Promise<{ session: Session; messages: Message[]; usage: SessionUsage; share_info?: ShareInfo }> {
  const res = await rpc.api.sessions[':id'].$get({ param: { id } });
  if (!res.ok) throw new Error(`getSession failed: ${res.status}`);
  return res.json();
}

export async function updateSession(
  id: string,
  updates: Partial<Pick<Session, 'status' | 'rating' | 'comment' | 'title' | 'feedback'>>,
): Promise<Session> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param/response typing.
  const args = { param: { id }, json: updates };
  const res = await rpc.api.sessions[':id'].$patch(args);
  if (!res.ok) {
    throw new Error(`Failed to update session: ${res.status}`);
  }
  return res.json();
}

export async function deleteSession(id: string): Promise<void> {
  const res = await rpc.api.sessions[':id'].$delete({ param: { id } });
  if (!res.ok) throw new Error(`deleteSession failed: ${res.status}`);
}

// ─── Group / Pin membership (per-user organization) ──────

/** File a session into a custom folder, or pass null to remove it from its folder. */
export async function setSessionGroup(sessionId: string, groupId: number | null): Promise<void> {
  const args = { param: { id: sessionId }, json: { group_id: groupId } };
  const res = await rpc.api.sessions[':id'].group.$put(args);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed' }));
    throw new Error(('error' in err && err.error) || `Failed: ${res.status}`);
  }
}

export async function pinSession(sessionId: string): Promise<void> {
  const res = await rpc.api.sessions[':id'].pin.$post({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`Pin failed: ${res.status}`);
}

export async function unpinSession(sessionId: string): Promise<void> {
  const res = await rpc.api.sessions[':id'].pin.$delete({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`Unpin failed: ${res.status}`);
}

export async function regenerateTitle(sessionId: string): Promise<string> {
  const res = await rpc.api.sessions[':id']['generate-title'].$post({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`Failed to regenerate title: ${res.status}`);
  const data = await res.json();
  return data.title;
}

// ─── Message Editing ─────────────────────────────────────

export async function editMessage(sessionId: string, messageId: string, content: string): Promise<void> {
  const args = { param: { id: sessionId, msgId: messageId }, json: { content } };
  const res = await rpc.api.sessions[':id'].messages[':msgId'].$patch(args);
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || `Edit failed: ${res.status}`);
  }
}

// ─── Regenerate API ──────────────────────────────────────

export async function regenerateResponse(sessionId: string): Promise<{ ok: boolean; lastUserMessage: string }> {
  const res = await rpc.api.sessions[':id'].regenerate.$post({ param: { id: sessionId } });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || `Regenerate failed: ${res.status}`);
  }
  return res.json();
}

// ─── Shareable Users ─────────────────────────────────────

export async function fetchShareableUsers(): Promise<ShareableUser[]> {
  try {
    const res = await rpc.api.sessions['shareable-users'].$get();
    if (!res.ok) return [];
    return (await res.json()).users ?? [];
  } catch {
    return [];
  }
}

// ─── Per-session Shares ──────────────────────────────────

export async function getSessionShares(sessionId: string): Promise<ShareItem[]> {
  try {
    const res = await rpc.api.sessions[':id'].shares.$get({ param: { id: sessionId } });
    if (!res.ok) return [];
    return (await res.json()).shares ?? [];
  } catch {
    return [];
  }
}

export async function unshareSession(sessionId: string): Promise<void> {
  const res = await rpc.api.sessions[':id'].shares.$delete({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`unshareSession failed: ${res.status}`);
}

export async function deleteOneShare(sessionId: string, shareId: number): Promise<void> {
  const res = await rpc.api.sessions[':id'].shares[':shareId'].$delete({
    param: { id: sessionId, shareId: String(shareId) },
  });
  if (!res.ok) throw new Error(`deleteOneShare failed: ${res.status}`);
}

// ─── Session Context ─────────────────────────────────────

/** Structured per-session context (mirrors api/src/session-context.ts schema). */
export interface SessionContextData {
  role?: string;
  locale?: string;
  timezone?: string;
  notes?: string;
  attributes?: Record<string, string>;
  _meta?: { source: 'app' | 'admin'; updated_at: string };
}

export async function getSessionContext(sessionId: string): Promise<SessionContextData | null> {
  const res = await rpc.api.sessions[':id'].context.$get({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`getSessionContext failed: ${res.status}`);
  const data = (await res.json()) as { context: SessionContextData | null };
  return data.context;
}

/** Set (or clear, with null) the structured session context. */
export async function putSessionContext(
  sessionId: string,
  context: SessionContextData | null,
): Promise<SessionContextData | null> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet);
  // the indirection passes the body while keeping param typing.
  const args = { param: { id: sessionId }, json: { context } };
  const res = await rpc.api.sessions[':id'].context.$put(args);
  const data = (await res.json()) as { context?: SessionContextData | null; error?: string };
  if (!res.ok) throw new Error(data.error || `putSessionContext failed: ${res.status}`);
  return data.context ?? null;
}
