/** The first chat send, including its retry ID. No React or native dependencies. */
import type { ApiMiss, ApiResult } from '../api/client';
import type { ConversationDetail, SendMessageInput, SendMessageResult } from '../shared/contract';

export interface NewChatSendState {
  sending: boolean;
  chats: Map<string, string>;
}

export const newChatSendState = (): NewChatSendState => ({ sending: false, chats: new Map() });

interface SendDependencies {
  /** The mounted page and workspace generation that started this action still own its draft. */
  current(): boolean;
  /** Focus has never left that page during this action, including leave then return. */
  active(): boolean;
  create(input: { kind: 'chat'; agent_id?: string }): Promise<ApiResult<ConversationDetail>>;
  send(id: string, input: SendMessageInput): Promise<ApiResult<SendMessageResult>>;
  read(id: string): Promise<ApiResult<ConversationDetail>>;
  remember(chat: ConversationDetail): void;
}

export type NewChatSendResult =
  | { status: 'sent'; conversationId: string }
  | { status: 'failed'; stage: 'create' | 'send'; error: ApiMiss }
  | { status: 'inactive' | 'busy' };

/** An explicit Agent ID is authoritative even while its directory entry is unavailable. */
export async function sendNewChat(
  state: NewChatSendState,
  agentId: string | null,
  input: SendMessageInput,
  deps: SendDependencies,
): Promise<NewChatSendResult> {
  // Claim synchronously, before the first await or React's next render.
  if (state.sending) return { status: 'busy' };
  if (!deps.current() || !deps.active()) return { status: 'inactive' };
  state.sending = true;
  try {
    const target = agentId ?? 'main';
    let id = state.chats.get(target);
    if (!id) {
      const chat = await deps.create({ kind: 'chat', ...(agentId ? { agent_id: agentId } : {}) });
      if (!deps.current()) return { status: 'inactive' };
      if (!chat.ok) return { status: 'failed', stage: 'create', error: chat };
      id = chat.data.id;
      // A blur may postpone sending. Keep this local ID for an explicit retry on the same page.
      state.chats.set(target, id);
      if (chat.data.agent_id) state.chats.set(chat.data.agent_id, id);
      if (!deps.active()) return { status: 'inactive' };
      deps.remember(chat.data);
    }
    if (!deps.active()) return { status: 'inactive' };
    const sent = await deps.send(id, input);
    if (!deps.current()) return { status: 'inactive' };
    // It was already sent before focus left. The still-locked draft can be consumed, but the
    // caller must check active() before navigation. Retrying it would send the same text twice.
    if (sent.ok) {
      // It is no longer pending. If the member left this page, their next new-chat draft
      // must not silently continue the successfully sent conversation's old context.
      for (const [key, pendingId] of state.chats) {
        if (pendingId === id) state.chats.delete(key);
      }
      return { status: 'sent', conversationId: id };
    }
    if (deps.active() && sent.status === 404 && sent.code === 'not_found') {
      const chat = await deps.read(id);
      if (!deps.current()) return { status: 'inactive' };
      if (!chat.ok && chat.status === 404 && chat.code === 'not_found') {
        for (const [key, pendingId] of state.chats) {
          if (pendingId === id) state.chats.delete(key);
        }
      }
    }
    return { status: 'failed', stage: 'send', error: sent };
  } finally {
    state.sending = false;
  }
}
