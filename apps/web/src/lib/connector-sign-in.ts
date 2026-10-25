/**
 * Sign in to an OAuth connector in a popup.
 *
 * The window is opened synchronously inside the click handler (a popup opened
 * after an await is blocked), then pointed at the provider once the server has
 * built the authorization URL. The provider comes back through the public
 * callback to `#/connectors/oauth-finish` in that popup, which finishes the
 * sign-in as the logged-in member, posts `{ type, connector_id, ok }` here and
 * closes. Only a same-origin message from the popup we opened counts; closing
 * the popup by hand resolves as `closed`.
 */

import { CONNECTOR_CONNECT_MESSAGE_TYPE, type ConnectorConnectMessage } from '@greenhouse/types/connectors';

export type ConnectorSignInOutcome = 'connected' | 'failed' | 'closed';

export async function signInInPopup(name: string, start: () => Promise<string>): Promise<ConnectorSignInOutcome> {
  const popup = window.open('', `greenhouse-connector-${name}`, 'popup,width=560,height=720');
  let url: string;
  try {
    url = await start();
  } catch (err) {
    popup?.close();
    throw err;
  }
  if (!popup) {
    // Pop-ups blocked: sign in in this tab; the finish page returns to Settings → Connections.
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
      if (event.source !== popup || event.origin !== window.location.origin) return;
      const data = event.data as Partial<ConnectorConnectMessage> | null;
      if (data?.type !== CONNECTOR_CONNECT_MESSAGE_TYPE) return;
      finish(data.ok ? 'connected' : 'failed');
    };
    window.addEventListener('message', onMessage);
    const watch = window.setInterval(() => {
      if (popup.closed) finish('closed');
    }, 500);
  });
}
