/**
 * The in-app assistant (`/api/sessions`, `/api/chat`): my conversations a page at a time,
 * starting one (the default assistant, `sprouty`), a conversation's title, its messages newest
 * page first (`/messages`, each page in transcript order with a cursor for the page before), and
 * whether a reply is being written. Sending and following a reply stream NDJSON — see
 * src/chat/send.ts. Every call answers an `ApiResult`.
 */

import type { MessagePage } from '../data/transcript';
import type { ChatMessage, ChatSession, SearchGroup } from '../shared/greenhouse-types';
import { del, get, patch, post, seg } from './client';

export const SESSION_PAGE = 50;

/** One page of my conversations, newest first. */
export const listSessions = (offset: number) =>
  get<{ sessions: ChatSession[]; page?: { has_more: boolean; next_offset: number } }>('/api/sessions', {
    scope: 'mine',
    limit: SESSION_PAGE,
    offset,
    page_meta: 1,
  });

export const createSession = () => post<ChatSession>('/api/sessions', {});

/** The conversation without its messages (title, and 404 when it is gone or not mine). */
export const getSessionInfo = (id: string) =>
  get<{ session: ChatSession }>(`/api/sessions/${seg(id)}`, { include_messages: 0 });

/** The latest page of messages, or the page before `beforeSeq`. */
export const getMessages = (id: string, beforeSeq?: number) =>
  get<MessagePage<ChatMessage>>(`/api/sessions/${seg(id)}/messages`, { limit: 50, before_seq: beforeSeq });

/** Whether the session has a reply being written (generation outlives the request). */
export const chatRun = (sessionId: string) =>
  get<{ active: boolean; run?: { status: 'running' | 'completed' | 'error' } }>(`/api/chat/runs/${seg(sessionId)}`);

/** Pin a conversation to the top of my list, or take it off. */
export const pinSession = (id: string, pinned: boolean) =>
  pinned ? post<{ ok: true }>(`/api/sessions/${seg(id)}/pin`, {}) : del<{ ok: true }>(`/api/sessions/${seg(id)}/pin`);

export const renameSession = (id: string, title: string) => patch<ChatSession>(`/api/sessions/${seg(id)}`, { title });

/** Stop the reply being written. */
export const stopRun = (sessionId: string) => post<unknown>(`/api/chat/runs/${seg(sessionId)}/stop`, {});

/** Search across what I can read (`/api/search`); `kind` narrows it to one group. */
export const searchAll = (q: string, kind?: string) =>
  get<{ query: string; groups: SearchGroup[] }>('/api/search', { q: q.slice(0, 200), ...(kind ? { kind } : {}) });
