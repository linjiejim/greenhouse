/**
 * The optional browser environment of one chat turn — the ambient page context
 * and the Client Actions a POST /api/chat body advertises — admitted here.
 *
 * Kept out of the route so the browser-extension contract test runs the exact
 * rule a real turn does (tests/browser/chat-contract.test.ts). A client that
 * stops meeting it loses its actions without any error, which is how the
 * extension went months without its browser tools.
 */

import { AMBIENT_CONTEXT_LIMITS, type AmbientContextEnvelope } from '@greenhouse/types/agent-context';
import type { ChatRequestBody, ClientActionDescriptor } from '@greenhouse/types/api';
import { sanitizeForPrompt } from '../security/security.js';
import { sanitizeClientActions } from '../tools/client-actions.js';
import { sanitizeAmbientContext } from './ambient-context.js';

export interface TurnEnvironment {
  ambientContext: AmbientContextEnvelope | undefined;
  clientActions: ClientActionDescriptor[];
  clientActionScopeId: string | undefined;
  /** True when the advertised actions become tools for this turn. */
  usesClientActions: boolean;
}

export function admitTurnEnvironment(
  body: Pick<ChatRequestBody, 'ambient_context' | 'client_actions' | 'client_action_scope_id'>,
  sessionId: string | undefined,
): TurnEnvironment {
  const ambientContext = sanitizeAmbientContext(body.ambient_context);
  const clientActions = sanitizeClientActions(body.client_actions);
  const clientActionScopeId =
    typeof body.client_action_scope_id === 'string'
      ? sanitizeForPrompt(body.client_action_scope_id).trim().slice(0, AMBIENT_CONTEXT_LIMITS.scopeId)
      : undefined;
  // A persisted session id is part of the result correlation key. Stateless
  // turns therefore ignore advertised actions instead of prompting the model
  // to call tools that were never registered.
  // When ambient context is present its scope and the actions must describe
  // the same page snapshot; a mismatched browser payload fails closed.
  const scopeMatchesAmbient = !ambientContext || ambientContext.scope_id === clientActionScopeId;
  const usesClientActions =
    Boolean(sessionId) && Boolean(clientActionScopeId) && scopeMatchesAmbient && clientActions.length > 0;
  return { ambientContext, clientActions, clientActionScopeId, usesClientActions };
}
