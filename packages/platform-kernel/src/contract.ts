/**
 * Platform kernel wire-neutral contracts.
 *
 * These types deliberately contain no Hono, database, React, or MCP concepts.
 * HTTP, UI, and agent adapters all translate into the same actor and action
 * envelopes before entering an application handler.
 */

export type ResourceId = string;

export type ActorType = 'human' | 'agent' | 'service' | 'system' | 'migration';

export type AuthMethod = 'session' | 'bearer' | 'oauth' | 'oauth-client' | 'api-key' | 'internal';

/**
 * Identity of the principal performing an operation.
 *
 * `actorId` is the authenticated principal. For a human it is the user ID. For
 * an agent/service it is the OAuth client or service principal ID, while
 * `onBehalfOfUserId` identifies the workspace user whose permissions are applied.
 */
export interface ActorContext {
  actorId: string;
  actorType: ActorType;
  orgId: string;
  requestId: string;
  authMethod: AuthMethod;
  onBehalfOfUserId?: string;
  clientId?: string;
}

/** Return the workspace user whose authorization policy should be evaluated. */
export function effectiveUserId(actor: ActorContext): string {
  return actor.onBehalfOfUserId ?? actor.actorId;
}

export interface ResourceRef {
  appId: string;
  moduleId?: string;
  entityId?: string;
  recordId?: ResourceId;
}

export interface PlatformActionRequest<TPayload = unknown> {
  actor: ActorContext;
  appId: string;
  actionId: string;
  payload: TPayload;
  resource?: ResourceRef;
  idempotencyKey?: string;
}

export type PlatformQueryRequest<TPayload = unknown> = PlatformActionRequest<TPayload>;

export type PlatformCommandRequest<TPayload = unknown> = PlatformActionRequest<TPayload> & {
  idempotencyKey?: string;
};

export type PlatformActionResult<TResult = unknown> =
  | { ok: true; data: TResult }
  | {
      ok: false;
      code: 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR';
      message: string;
      details?: Record<string, unknown>;
    };

export type AuditResult = 'success' | 'denied' | 'error';

export interface PlatformAuditEvent {
  id?: string;
  orgId: string;
  actorId: string;
  actorType: ActorType;
  onBehalfOfUserId?: string;
  clientId?: string;
  requestId: string;
  resource: ResourceRef;
  actionId: string;
  capability: string;
  result: AuditResult;
  summary?: Record<string, unknown>;
  createdAt?: string;
}
