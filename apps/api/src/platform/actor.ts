/**
 * Transport adapters for Kernel ActorContext.
 */

import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import type { ActorContext, AuthMethod } from '@greenhouse/platform-kernel';
import type { AuthUser } from '../auth/middleware.js';
import { PLATFORM_ORG_ID } from './runtime.js';
import { currentAgentScope } from './agent-scope.js';

function requestId(c?: Context): string {
  return c?.req.header('x-request-id')?.trim() || randomUUID();
}

export function humanActor(user: Pick<AuthUser, 'id'>, c?: Context): ActorContext {
  return {
    actorId: user.id,
    actorType: 'human',
    orgId: PLATFORM_ORG_ID,
    requestId: requestId(c),
    authMethod: 'bearer',
  };
}

/**
 * An agent acting for `userId` with that member's permissions. Inside an Agent turn
 * (`runInAgentScope`) the member's own Agent is the actor (`bot:<id>`, with `agentId` and the
 * conversation) — unless an external client (OAuth / MCP) is named, which then stays the actor.
 */
export function delegatedAgentActor(input: {
  userId: string;
  requestId?: string;
  clientId?: string;
  authMethod?: AuthMethod;
}): ActorContext {
  const scope = input.clientId ? undefined : currentAgentScope();
  return {
    actorId: input.clientId ?? (scope ? `bot:${scope.botId}` : `agent:${input.userId}`),
    actorType: 'agent',
    orgId: PLATFORM_ORG_ID,
    requestId: input.requestId ?? randomUUID(),
    authMethod: input.authMethod ?? 'internal',
    onBehalfOfUserId: input.userId,
    clientId: input.clientId,
    ...(scope ? { agentId: scope.botId } : {}),
    ...(scope?.sessionId ? { sessionId: scope.sessionId } : {}),
  };
}
