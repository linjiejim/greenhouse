/**
 * Sessions API — session CRUD, message editing, regeneration,
 * shareable users and per-session shares.
 */

import type {
  Session,
  Message,
  SessionUsage,
  ShareInfo,
  ShareableUser,
  ShareItem,
  SessionScope,
} from '@greenhouse/types/api';
import { rpc } from './client';

export async function createSession(title?: string, profileId?: string): Promise<Session> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet).
  const args = { json: { title, profile_id: profileId } };
  const res = await rpc.api.sessions.$post(args);
  if (!res.ok) throw new Error(`createSession failed: ${res.status}`);
  return res.json();
}

/**
 * Omitting `scope` asks for the legacy combined list (a super gets everyone's
 * conversations) — the history browser still wants that. The sidebar passes an
 * explicit scope.
 */
export async function listSessions(
  status?: string,
  includeEval = true,
  limit = 500,
  scope?: SessionScope,
): Promise<Session[]> {
  const query: Record<string, string> = { limit: String(limit) };
  if (status && status !== 'all') query.status = status;
  if (includeEval) query.include_eval = '1';
  if (scope) query.scope = scope;
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

export async function forkSession(id: string, messageId?: string): Promise<Session> {
  const args = { param: { id }, json: { message_id: messageId } };
  const res = await rpc.api.sessions[':id'].fork.$post(args);
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Failed to fork conversation' }));
    throw new Error(('error' in data && data.error) || `Fork failed: ${res.status}`);
  }
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

// ─── Pins (per-user organization) ───────────────────────

export async function pinSession(sessionId: string): Promise<void> {
  const res = await rpc.api.sessions[':id'].pin.$post({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`Pin failed: ${res.status}`);
}

export async function unpinSession(sessionId: string): Promise<void> {
  const res = await rpc.api.sessions[':id'].pin.$delete({ param: { id: sessionId } });
  if (!res.ok) throw new Error(`Unpin failed: ${res.status}`);
}

/** Persist the order of the caller's pinned sessions. */
export async function reorderPinnedSessions(updates: Array<{ session_id: string; sort_order: number }>): Promise<void> {
  // Non-literal arg: hc only types `json` for validator-backed routes (none yet).
  const args = { json: { updates } };
  const res = await rpc.api.sessions.pins.reorder.$post(args);
  if (!res.ok) throw new Error(`Reorder failed: ${res.status}`);
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

export interface RegenerateResponse {
  ok: true;
  last_user: {
    id: string;
    content: string;
    images: Array<{ id: string; url: string }>;
  } | null;
}

export async function regenerateResponse(sessionId: string, assistantMessageId: string): Promise<RegenerateResponse> {
  // Non-literal arg: hc only exposes `json` for validator-backed routes.
  const args = {
    param: { id: sessionId },
    json: { assistant_message_id: assistantMessageId },
  };
  const res = await rpc.api.sessions[':id'].regenerate.$post(args);
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
