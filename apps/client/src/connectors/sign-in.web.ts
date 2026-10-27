/**
 * A connector's OAuth sign-in in the browser: the provider's page opens in a popup; the station
 * returns it to `/connectors/oauth-finish` (app/connectors/oauth-finish.web.tsx), which finishes
 * the sign-in as this member, posts the outcome to this window (same origin, from that popup
 * only) and closes. A blocked popup sends this page itself to the provider; the finish page then
 * offers the way back to Me → Connections.
 */

import { startConnectorSignIn } from '../api/connectors';
import { CONNECTOR_CONNECT_MESSAGE_TYPE, type ConnectorConnectMessage } from '../shared/greenhouse-types';
import type { SignInOutcome } from './sign-in';

export type { SignInOutcome } from './sign-in';

function isConnectMessage(data: unknown): data is ConnectorConnectMessage {
  return !!data && typeof data === 'object' && (data as { type?: unknown }).type === CONNECTOR_CONNECT_MESSAGE_TYPE;
}

export async function signInToConnector(id: string, current: () => boolean): Promise<SignInOutcome> {
  const started = await startConnectorSignIn(id, 'web');
  if (!current()) return { kind: 'quiet' };
  if (!started.ok) return { kind: 'failed', message: started.message || undefined };
  const popup = window.open(started.data.authorize_url, 'greenhouse-connector', 'popup,width=520,height=720');
  if (!popup) {
    window.location.assign(started.data.authorize_url);
    return { kind: 'quiet' };
  }
  return new Promise<SignInOutcome>((resolve) => {
    const settle = (outcome: SignInOutcome) => {
      window.removeEventListener('message', onMessage);
      window.clearInterval(watch);
      resolve(current() ? outcome : { kind: 'quiet' });
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== window.location.origin || !isConnectMessage(event.data)) return;
      settle(event.data.ok ? { kind: 'connected' } : { kind: 'failed' });
    };
    window.addEventListener('message', onMessage);
    // closed without a word: the member gave up
    const watch = window.setInterval(() => {
      if (popup.closed) settle({ kind: 'quiet' });
    }, 500);
  });
}
