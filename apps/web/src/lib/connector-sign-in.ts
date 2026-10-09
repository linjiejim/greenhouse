/**
 * Sign in to an OAuth connector in a popup (spec 20261009-mcp-connectors D4).
 *
 * The window is opened synchronously inside the click handler (a popup opened
 * after an await is blocked), then pointed at the provider once the server has
 * built the authorization URL. The callback page posts `{ type, server_id, ok }`
 * to this window and closes itself; only a message from the popup we opened
 * counts. Closing the popup by hand resolves as `closed`.
 */

import { MCP_CONNECT_MESSAGE_TYPE, type McpConnectMessage } from '@greenhouse/types/mcp-servers';
import { startConnectorSignIn } from './api/connectors';

export type ConnectorSignInOutcome = 'connected' | 'failed' | 'closed';

export async function signInToConnector(serverId: number): Promise<ConnectorSignInOutcome> {
  const popup = window.open('', `greenhouse-connector-${serverId}`, 'popup,width=560,height=720');
  let url: string;
  try {
    url = await startConnectorSignIn(serverId);
  } catch (err) {
    popup?.close();
    throw err;
  }
  if (!popup) {
    // Pop-ups blocked: sign in in this tab; the callback page links back to Settings → Connectors.
    window.location.href = url;
    return 'closed';
  }
  popup.location.href = url;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: ConnectorSignInOutcome) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(watch);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup) return;
      const data = event.data as Partial<McpConnectMessage> | null;
      if (data?.type !== MCP_CONNECT_MESSAGE_TYPE) return;
      finish(data.ok ? 'connected' : 'failed');
    };
    window.addEventListener('message', onMessage);
    // The member may close the window instead (or the provider page may not
    // come back to us at all).
    const watch = window.setInterval(() => {
      if (popup.closed) finish('closed');
    }, 500);
  });
}
