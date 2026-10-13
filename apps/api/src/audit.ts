/**
 * Admin and member actions on shared settings, recorded in audit_events: who did what to
 * which object. Summaries name fields, never values: no content and no secrets.
 */

import { auditEvents, getDb } from '@greenhouse/db';

export interface AuditEntry {
  actorId: string;
  /** `<resource>.<verb>`, e.g. `provider.create`. */
  action: string;
  resourceType: string;
  resourceId: string;
  summary?: string;
}

/** Joins the open transaction, so the record commits or rolls back with the change. */
export async function audit(entry: AuditEntry): Promise<void> {
  await getDb()
    .insert(auditEvents)
    .values({
      actorType: 'member',
      actorId: entry.actorId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId,
      result: 'success',
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
