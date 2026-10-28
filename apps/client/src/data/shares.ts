/**
 * Conversations shared with me as one list (src/api/shares.ts). React-free (./shares.test.ts):
 * a conversation shared twice (with me, and with the whole team) is one row, the newest share's,
 * unread while any of its shares is.
 */

export interface ShareLike {
  id: string;
  session_id: string;
  read_at: string | null;
  created_at: string;
}

export interface SharedRow<S extends ShareLike> {
  share: S;
  /** Every share of this conversation (all are marked read when it is opened). */
  ids: string[];
  unread: boolean;
}

export function sharedRows<S extends ShareLike>(shares: readonly S[]): SharedRow<S>[] {
  const bySession = new Map<string, SharedRow<S>>();
  const order: string[] = [];
  for (const share of shares) {
    const row = bySession.get(share.session_id);
    if (!row) {
      bySession.set(share.session_id, { share, ids: [share.id], unread: !share.read_at });
      order.push(share.session_id);
      continue;
    }
    row.ids.push(share.id);
    row.unread ||= !share.read_at;
    if (share.created_at > row.share.created_at) row.share = share;
  }
  return order
    .map((id) => bySession.get(id)!)
    .sort((a, b) => (a.share.created_at < b.share.created_at ? 1 : a.share.created_at > b.share.created_at ? -1 : 0));
}
