/**
 * "New chat" on the Agents engine (spec 20261011-agent-first-class §5a, D27).
 *
 * With Agents on, the new-chat page keeps its workbench and its composer, but
 * its first send no longer creates an ordinary chat session: it creates a
 * separate Agent chat (`kind: 'task'`, answered by the chosen Agent on the
 * chosen model), uploads the files against it, hands the message to the
 * conversation view it opens (`#/bots?c=`) — which sends it through the one
 * Bots send path — and switches there. Chats that already exist keep opening
 * in the chat engine; the Assistant overlay and the browser extension stay on
 * it too.
 */

import { createTaskChat } from '../../lib/api/bots';
import { updateSession } from '../../lib/api/sessions';
import type { ChatFileRef } from '../../lib/api/chat-files';
import { withAttachmentsFence } from '../bots/bots-composer';
import { useBotsStore } from '../bots/bots-store';
import { queueFirstSend } from '../bots/first-send';
import { openBotsConversation } from '../bots/navigation';

/** Which step failed: creating the chat (nothing was made) or uploading its files (the empty chat is removed). */
export class AgentChatStartError extends Error {
  constructor(
    readonly stage: 'create' | 'attachments',
    cause?: unknown,
  ) {
    super(cause instanceof Error ? cause.message : stage === 'create' ? 'Could not start the chat' : 'Upload failed');
    this.name = 'AgentChatStartError';
  }
}

export interface StartAgentChatInput {
  /** What is sent (annotations and a picked Task already composed in). */
  message: string;
  /** The text as typed — given back to the chat's composer if its first send fails. */
  draft: string;
  /** Already uploaded images. */
  images: Array<{ id: string; url: string }>;
  /** The Agent that answers there (default: the member's Sprouty). */
  botId?: string;
  /** The model picked for it (default: that Agent's). */
  modelId?: string | null;
  /**
   * Upload the composer's files against the new chat (chat files belong to a session, so this
   * can only happen once it exists). Resolves null when any upload failed.
   */
  uploadAttachments?: (sessionId: string) => Promise<ChatFileRef[] | null>;
}

/** Create the chat, queue its first message, open it. Resolves the new chat's session id. */
export async function startAgentChat(input: StartAgentChatInput): Promise<string> {
  let sessionId: string;
  try {
    const { conversation } = await createTaskChat({
      ...(input.botId ? { botId: input.botId } : {}),
      ...(input.modelId ? { modelId: input.modelId } : {}),
    });
    sessionId = conversation.session_id;
  } catch (err) {
    throw new AgentChatStartError('create', err);
  }

  let content = input.message;
  if (input.uploadAttachments) {
    const refs = await input.uploadAttachments(sessionId).catch(() => null);
    if (!refs) {
      // Nothing was said in it yet: don't leave an empty chat in the list.
      void updateSession(sessionId, { status: 'deleted' }).catch(() => {});
      throw new AgentChatStartError('attachments');
    }
    content = withAttachmentsFence(input.message, refs);
  }

  queueFirstSend(sessionId, { content, images: input.images, draft: input.draft });
  // An old `#/chat?session=` link to it redirects to its real address from now on.
  useBotsStore.getState().noteSession(sessionId);
  openBotsConversation(sessionId);
  return sessionId;
}
