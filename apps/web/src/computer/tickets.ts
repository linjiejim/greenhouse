/**
 * Sockets to an Agent's computer authenticate with a one-time ticket in the URL, because a
 * browser cannot put headers on a WebSocket. A ticket is asked for right before each connect.
 */

import { api } from '../lib/api';

export type TicketPurpose = 'view' | 'control' | 'terminal';

export async function socketUrl(agentId: string, purpose: TicketPurpose): Promise<string> {
  const { ticket } = await api.request<{ ticket: string; expires_at: string }>(
    'POST',
    `/api/agents/${encodeURIComponent(agentId)}/computer/ticket`,
    { purpose },
  );
  const url = new URL(purpose === 'terminal' ? '/api/ws/computer-terminal' : '/api/ws/computer', location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('ticket', ticket);
  return url.toString();
}
