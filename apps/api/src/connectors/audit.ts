/**
 * The audit trail of connector use: one `audit_events` row per remote call
 * (who, which connector and tool, how long, how many bytes, how it ended) and
 * per admin / member configuration change. Never the arguments or the content
 * — those stay with the remote system (and, for writes, on the connector_write
 * run the member can see). App id `connectors`; the Activity log does not list
 * these rows.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';

export const CONNECTORS_AUDIT_APP_ID = 'connectors';

export type ConnectorCallOutcome =
  | 'ok'
  | 'tool_error'
  | 'failed'
  | 'needs_connection'
  | 'needs_confirmation'
  | 'refused';

export interface ConnectorCallAudit {
  userId: string;
  connectorId: string;
  connector: string;
  tool: string;
  origin: 'chat' | 'automation' | 'mcp';
  durationMs: number;
  bytes: number;
  outcome: ConnectorCallOutcome;
  /** The external agent's OAuth client (mcp origin). */
  clientId?: string | null;
  writeRunId?: string | null;
}

/** Record one remote call. Never throws, never blocks the answer on failure. */
export async function auditConnectorCall(db: DatabaseProvider, entry: ConnectorCallAudit): Promise<void> {
  try {
    await db.platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: entry.userId,
      actorType: 'agent',
      onBehalfOfUserId: entry.userId,
      ...(entry.clientId ? { clientId: entry.clientId } : {}),
      requestId: `mcc_call_${randomUUID()}`,
      resource: {
        appId: CONNECTORS_AUDIT_APP_ID,
        moduleId: 'calls',
        entityId: 'connector',
        recordId: entry.connectorId,
      },
      actionId: 'callConnectorTool',
      capability: 'connectors.call',
      result: entry.outcome === 'refused' ? 'denied' : entry.outcome === 'failed' ? 'error' : 'success',
      summary: {
        connector: entry.connector,
        tool: entry.tool,
        origin: entry.origin,
        duration_ms: entry.durationMs,
        bytes: entry.bytes,
        outcome: entry.outcome,
        ...(entry.writeRunId ? { write_run_id: entry.writeRunId } : {}),
      },
    });
  } catch (err) {
    logger.warn('[connectors] could not audit a call', { connector: entry.connectorId, error: toErrorMessage(err) });
  }
}

/** Record a configuration change (create / update / delete / connect / disconnect). */
export async function auditConnectorChange(
  db: DatabaseProvider,
  entry: { userId: string; connectorId: string; action: string; summary?: Record<string, unknown> },
): Promise<void> {
  try {
    await db.platform.recordAudit({
      orgId: PLATFORM_ORG_ID,
      actorId: entry.userId,
      actorType: 'human',
      requestId: `mcc_change_${randomUUID()}`,
      resource: {
        appId: CONNECTORS_AUDIT_APP_ID,
        moduleId: 'config',
        entityId: 'connector',
        recordId: entry.connectorId,
      },
      actionId: entry.action,
      capability: 'connectors.manage',
      result: 'success',
      summary: entry.summary ?? {},
    });
  } catch (err) {
    logger.warn('[connectors] could not audit a change', { connector: entry.connectorId, error: toErrorMessage(err) });
  }
}
