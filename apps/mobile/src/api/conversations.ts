/**
 * Conversations on API v2 (`/api/conversations`): the main thread, Agent threads, chats and
 * rooms; their messages, sending, stop, edit and regenerate, 👍 / 👎, read state and people.
 * Shapes: ../shared/contract.ts. Every call answers an `ApiResult` (./client.ts), never throws.
 */

import { MOBILE_RICH_BLOCKS } from '../chat/markdown/rich';
import type {
  ConversationDetail,
  ConversationMembers,
  Conversation,
  CreateConversationInput,
  EditMessageResult,
  Feedback,
  FeedbackInput,
  MessageItem,
  Page,
  RegenerateResult,
  SendMessageInput,
  SendMessageResult,
  UpdateConversationInput,
} from '../shared/contract';
import { api, del, get, networkMiss, patch, post, put, seg, type ApiResult } from './client';

const base = (id: string) => `/api/conversations/${seg(id)}`;

/** Newest activity first; archived ones only when asked. */
export const listConversations = (
  query: { kind?: Conversation['kind']; q?: string; archived?: boolean; cursor?: string; limit?: number } = {},
) => get<Page<Conversation>>('/api/conversations', { ...query, archived: query.archived ? 'true' : undefined });

export const getConversation = (id: string) => get<ConversationDetail>(base(id));

/** A chat or a room, or the one Agent thread with an Agent (the existing one when there is one). */
export const createConversation = (input: CreateConversationInput) =>
  post<ConversationDetail>('/api/conversations', input);

/** Rename, pin, mute, archive or pick a chat's model. */
export const updateConversation = (id: string, input: UpdateConversationInput) =>
  patch<ConversationDetail>(base(id), input);

export const deleteConversation = (id: string) => del(base(id));

/** Newest first, a page at a time; `after` catches up from a sequence number. */
export const listMessages = (id: string, query: { cursor?: string; after?: number; limit?: number } = {}) =>
  get<Page<MessageItem>>(`${base(id)}/messages`, query);

/** Sends a message, saying which rich blocks this app draws so replies may use them. */
export const sendMessage = (id: string, input: SendMessageInput) =>
  post<SendMessageResult>(`${base(id)}/messages`, { ...input, rich_blocks: [...MOBILE_RICH_BLOCKS] });

/** My last message, new text; the replies after it go and it is answered again. Stop the reply first. */
export const editMessage = (id: string, messageId: string, content: string) =>
  patch<EditMessageResult>(`${base(id)}/messages/${seg(messageId)}`, { content });

export const regenerateMessage = (id: string, messageId: string) =>
  post<RegenerateResult>(`${base(id)}/messages/${seg(messageId)}/regenerate`);

/** 👍 1, 👎 -1, 0 takes it back. */
export const rateMessage = (id: string, messageId: string, input: FeedbackInput) =>
  put<Feedback>(`${base(id)}/messages/${seg(messageId)}/feedback`, input);

export const stopConversation = (id: string) => post<void>(`${base(id)}/stop`);

/** Everything up to `seq` is read. */
export const markRead = (id: string, seq: number) => post<void>(`${base(id)}/read`, { seq });

export const conversationMembers = (id: string) => get<ConversationMembers>(`${base(id)}/members`);

/** Rooms only: people, and my own Agents (handles or ids). */
export const addMembers = (id: string, input: { member_ids?: string[]; agent_ids?: string[] }) =>
  post<ConversationMembers>(`${base(id)}/members`, { member_ids: input.member_ids ?? [], agent_ids: input.agent_ids ?? [] });

/** The owner removes someone; my own id leaves the room. */
export const removeMember = (id: string, memberId: string) => del(`${base(id)}/members/${seg(memberId)}`);

/** The conversation as a Markdown file: its name and text. */
export async function exportConversation(id: string): Promise<ApiResult<{ filename: string; markdown: string }>> {
  try {
    const res = await api(`${base(id)}/export`);
    if (!res.ok) return { ok: false, status: res.status, code: 'export_failed', message: '' };
    const header = res.headers.get('content-disposition');
    const encoded = header && /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
    let filename = (header && /filename="([^"]*)"/i.exec(header)?.[1]) || 'conversation.md';
    if (encoded) {
      try {
        filename = decodeURIComponent(encoded);
      } catch {
        // keep the plain name
      }
    }
    return { ok: true, data: { filename, markdown: await res.text() } };
  } catch (error) {
    return networkMiss(error);
  }
}
