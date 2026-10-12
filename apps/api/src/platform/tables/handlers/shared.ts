/**
 * What every Tables handler module shares: the handler type, result helpers,
 * payload readers and the record write meta. Access lives in `../access.ts`.
 */

import {
  effectiveUserId,
  type ActorContext,
  type PlatformActionHandler,
  type PlatformActionResult,
} from '@greenhouse/platform-kernel';
import type { TableRecordWriteMeta } from '@greenhouse/types/tables';
import type { TablesActionId } from '../../manifests/tables.js';
import type { PlatformHandlerContext } from '../../runtime.js';

export type Handler = PlatformActionHandler<PlatformHandlerContext>;
export type HandlerRequest = Parameters<Handler>[0];

/** One domain's slice of the registration map; `application.ts` composes them and the compiler checks completeness. */
export type TablesHandlers = Partial<Record<TablesActionId, Handler>>;

export type FailureCode = 'INVALID_INPUT' | 'NOT_FOUND' | 'CONFLICT' | 'FORBIDDEN' | 'INTERNAL_ERROR';

export function ok<T>(data: T): PlatformActionResult<T> {
  return { ok: true, data };
}

export function fail(code: FailureCode, message: string, details?: Record<string, unknown>): PlatformActionResult {
  return { ok: false, code, message, ...(details ? { details } : {}) };
}

export function payloadOf(request: HandlerRequest): Record<string, unknown> {
  return request.payload && typeof request.payload === 'object' && !Array.isArray(request.payload)
    ? (request.payload as Record<string, unknown>)
    : {};
}

export function positiveInt(payload: Record<string, unknown>, key: string): number | undefined {
  const value = payload[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function stringValue(payload: Record<string, unknown>, key: string): string | undefined {
  return typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
}

export function objectValue<T extends object>(payload: Record<string, unknown>, key: string): T | undefined {
  const value = payload[key];
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : undefined;
}

/** `null` clears, a string sets, anything else leaves the description alone. */
export function nullableString(payload: Record<string, unknown>, key: string): string | null | undefined {
  const value = payload[key];
  return value === null || typeof value === 'string' ? value : undefined;
}

export function optionalNumber(payload: Record<string, unknown>, key: string): number | undefined {
  return typeof payload[key] === 'number' ? (payload[key] as number) : undefined;
}

/**
 * The write meta of a member's own write: `user` for a person, `agent` for a
 * delegated agent (chat / MCP), `system` for anything else.
 */
export function writeMeta(actor: ActorContext, extra: Partial<TableRecordWriteMeta> = {}): TableRecordWriteMeta {
  return {
    actorId: effectiveUserId(actor),
    actorKind: actor.actorType === 'human' ? 'user' : actor.actorType === 'agent' ? 'agent' : 'system',
    enqueueAutomations: true,
    ...extra,
  };
}
