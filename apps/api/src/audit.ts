/**
 * Admin and member actions on shared settings, recorded in audit_events: who did what to
 * which object. Summaries name fields, never values: no content and no secrets.
 */

import { auditEvents, getDb } from '@greenhouse/db';

export interface AuditEntry {
  /** A member by default; `client` when an outside client acted on a member's behalf. */
  actorType?: 'member' | 'client' | 'system';
  actorId: string;
  onBehalfOf?: string;
  clientId?: string;
  result?: 'success' | 'denied' | 'error';
  /** `<resource>.<verb>`, e.g. `provider.create`. */
  action: string;
  resourceType: string;
  resourceId: string;
  /** Where it happened, e.g. the conversation a person was added to. */
  scopeType?: string;
  scopeId?: string;
  summary?: string;
}

/** Joins the open transaction, so the record commits or rolls back with the change. */
export async function audit(entry: AuditEntry): Promise<void> {
  await getDb()
    .insert(auditEvents)
    .values({
      actorType: entry.actorType ?? 'member',
      actorId: entry.actorId,
      onBehalfOf: entry.onBehalfOf ?? null,
      clientId: entry.clientId ?? null,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      scopeType: entry.scopeType ?? null,
      scopeId: entry.scopeId ?? null,
      result: entry.result ?? 'success',
      summary: entry.summary ?? '',
    });
}

/** The names of the fields an update sets, for an audit summary. */
export function changedFields(input: Record<string, unknown>): string {
  return Object.keys(input)
    .filter((field) => input[field] !== undefined)
    .sort()
    .join(', ');
}
