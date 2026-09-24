/**
 * The POST /api/chat body the side panel sends, built here as plain data so
 * tests/browser/chat-contract.test.ts can hold it to the server's contract:
 * the shared `ChatRequestBody` type, the route's Client Action admission rule
 * and the ambient-context caps. No chrome.* references.
 *
 * There is deliberately no "don't give the model write tools" flag: the server
 * keys that on the session's `browser` channel (apps/api/src/chat/browser-channel.ts),
 * so it cannot be lost by a client that forgets to ask.
 */

import type { AmbientContextEnvelope } from '@greenhouse/types/agent-context';
import type { ChatRequestBody, ClientActionDescriptor } from '@greenhouse/types/api';
import { BROWSER_ACTION_DESCRIPTORS } from './browser-actions';
import { KNOWLEDGE_ACTION_DESCRIPTOR } from './knowledge-actions';

/** Every Client Action the panel executes: browser automation + the confirm-carded knowledge write-back. */
export const PANEL_CLIENT_ACTIONS: readonly ClientActionDescriptor[] = [
  ...BROWSER_ACTION_DESCRIPTORS,
  KNOWLEDGE_ACTION_DESCRIPTOR,
];

/**
 * A fresh scope per turn. The server registers the panel's actions under it,
 * requires the ambient context (when sent) to carry the same id, and echoes it
 * on every `local-tool-request`, so a request stamped with another scope is
 * refused instead of run.
 */
export function newTurnScopeId(): string {
  return `bridge-panel:${crypto.randomUUID()}`;
}

export function buildChatRequestBody(turn: {
  sessionId: string;
  message: string;
  scopeId: string;
  ambientContext?: AmbientContextEnvelope;
}): ChatRequestBody {
  return {
    session_id: turn.sessionId,
    messages: [{ role: 'user', content: turn.message }],
    ...(turn.ambientContext ? { ambient_context: turn.ambientContext } : {}),
    client_action_scope_id: turn.scopeId,
    client_actions: [...PANEL_CLIENT_ACTIONS],
  };
}
