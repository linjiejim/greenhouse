/**
 * Conversations shared with me (`/api/shares`, apps/api/src/routes/shares.ts; the web's inbox
 * "Shared with me"): newest first, with the conversation's title and who shared it; a share opened
 * is marked read. A shared conversation opens read-only on its page (it is not mine to write in).
 * Every call answers an `ApiResult`, never throws.
 */

import { get, patch, seg, type ApiResult } from './client';

export interface SharedConversation {
  id: string;
  session_id: string;
  shared_by: string;
  /** A member id, or `__team__` for a share with the whole team. */
  shared_with: string;
  message: string | null;
  read_at: string | null;
  created_at: string;
  session_title: string;
  shared_by_nickname: string;
}

export const listShares = async (): Promise<ApiResult<SharedConversation[]>> => {
  const result = await get<{ shares: SharedConversation[] }>('/api/shares', { limit: 100 });
  return result.ok ? { ok: true, data: result.data.shares ?? [] } : result;
};

export const markShareRead = (id: string) => patch<unknown>(`/api/shares/${seg(id)}/read`, {});
