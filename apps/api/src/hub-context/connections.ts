/**
 * The connect wizard's "检查连接" — which of the member's connected agents
 * reached the MCP server, and when. Read from the member's own active OAuth
 * grants and the last use of their access tokens (touched on every MCP
 * request, including initialize and tools/list); nothing about the calls.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { AgentClientKind, AgentConnectionsCheck } from '@greenhouse/types/hub-context';

/** Which wizard client a registered OAuth client name belongs to. */
export function agentClientKind(clientName: string): AgentClientKind {
  const name = clientName.toLowerCase();
  if (name.includes('codex')) return 'codex';
  if (name.includes('claude')) return 'claude-code';
  if (name.includes('cursor')) return 'cursor';
  return 'other';
}

export async function checkAgentConnections(
  db: DatabaseProvider,
  userId: string,
  now: Date = new Date(),
): Promise<AgentConnectionsCheck> {
  const rows = await db.platformOAuth.listUserGrantActivity(userId);
  return {
    now: now.toISOString(),
    connections: rows
      .map((row) => ({
        client_id: row.client_id,
        client_name: row.client_name,
        kind: agentClientKind(row.client_name),
        last_seen_at: row.last_used_at,
        connected_at: row.connected_at,
      }))
      .sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? '')),
  };
}
