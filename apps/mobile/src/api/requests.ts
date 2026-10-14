/**
 * 「需要你」 on API v2 (`/api/requests`): what waits for the member — approvals, sign-ins,
 * take-overs, questions and proposals — and the decisions on them. A card is decided once:
 * deciding one already decided or expired answers 409 (`conflict`).
 * Every call answers an `ApiResult` (./client.ts), never throws.
 */

import type { NeedsYou, Page } from '../shared/contract';
import { get, post, seg } from './client';

const base = (id: string) => `/api/requests/${seg(id)}`;

/** Pending ones by default; `all` with a conversation gives its decided cards too. */
export const listRequests = (
  query: { state?: 'pending' | 'all'; conversation_id?: string; cursor?: string; limit?: number } = {},
) => get<Page<NeedsYou>>('/api/requests', query);

export const approveRequest = (id: string) => post<NeedsYou>(`${base(id)}/approve`);

export const rejectRequest = (id: string, reason?: string) =>
  post<NeedsYou>(`${base(id)}/reject`, reason ? { reason } : {});

export const answerRequest = (id: string, answers: Record<string, string>) =>
  post<NeedsYou>(`${base(id)}/answer`, { answers });

/** Hands the computer back after a take-over or a sign-in; the note is for the Agent. */
export const handBack = (id: string, note?: string) => post<NeedsYou>(`${base(id)}/handback`, note ? { note } : {});
