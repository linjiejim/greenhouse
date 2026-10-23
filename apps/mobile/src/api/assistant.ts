/**
 * The in-app assistant (`/api/sessions`, `/api/chat`): my conversations, starting one (the default
 * assistant, `sprouty`), reading one, and whether a reply is still being written. Sending a
 * message streams NDJSON — see src/assistant/send.ts. Every call answers an `ApiResult`.
 */

import type { ChatMessage, ChatSession } from '../shared/greenhouse-types';
import { get, post, seg } from './client';

export const listSessions = () => get<{ sessions: ChatSession[] }>('/api/sessions', { scope: 'mine', limit: 50 });

export const createSession = () => post<ChatSession>('/api/sessions', {});

export const getSession = (id: string) =>
  get<{ session: ChatSession; messages: ChatMessage[] }>(`/api/sessions/${seg(id)}`);

/** Whether the session has a reply being written (generation outlives the request). */
export const chatRun = (sessionId: string) =>
  get<{ active: boolean; run?: { status: 'running' | 'completed' | 'error' } }>(`/api/chat/runs/${seg(sessionId)}`);
