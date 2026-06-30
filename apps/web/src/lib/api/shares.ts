/**
 * Shares API — session share inbox (share, list, unread count, read marks).
 */

import type { ShareItem } from '@greenhouse/types/api';
import { rpc } from './client';

export async function shareSession(
  sessionId: string,
  input: {
    user_ids?: string[];
    team?: boolean;
    message?: string;
  },
): Promise<void> {
  const res = await rpc.api.shares.$post({ json: { session_id: sessionId, ...input } });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(('error' in data && data.error) || `Failed to share: ${res.status}`);
  }
}

export async function fetchShares(opts?: { limit?: number; offset?: number }): Promise<ShareItem[]> {
  const query: Record<string, string> = {};
  if (opts?.limit) query.limit = String(opts.limit);
  if (opts?.offset) query.offset = String(opts.offset);
  try {
    const res = await rpc.api.shares.$get({ query });
    if (!res.ok) return [];
    return (await res.json()).shares ?? [];
  } catch {
    return [];
  }
}

export async function fetchShareCount(): Promise<number> {
  try {
    const res = await rpc.api.shares.count.$get();
    if (!res.ok) return 0;
    return (await res.json()).count ?? 0;
  } catch {
    return 0;
  }
}

export async function markShareRead(id: number): Promise<void> {
  const res = await rpc.api.shares[':id'].read.$patch({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`markShareRead failed: ${res.status}`);
}

export async function markAllSharesRead(): Promise<void> {
  const res = await rpc.api.shares['read-all'].$post();
  if (!res.ok) throw new Error(`markAllSharesRead failed: ${res.status}`);
}

export async function markSharesReadInSession(sessionId: string): Promise<void> {
  const res = await rpc.api.shares['read-session'].$post({ json: { session_id: sessionId } });
  if (!res.ok) throw new Error(`markSharesReadInSession failed: ${res.status}`);
}
