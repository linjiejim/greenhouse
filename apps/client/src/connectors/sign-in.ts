/**
 * A connector's OAuth sign-in on the phone: the provider's page in the system auth session,
 * which returns to `greenhouse://connectors/oauth-finish`, then the finish call as this member
 * (the server refuses a sign-in someone else started). The browser: ./sign-in.web.ts.
 */

import * as WebBrowser from 'expo-web-browser';
import { finishConnectorSignIn, startConnectorSignIn } from '../api/connectors';
import { CONNECTOR_APP_REDIRECT, parseConnectorReturn } from './model';

export type SignInOutcome =
  | { kind: 'connected' }
  /** Nothing to say: cancelled, the member changed, or the page left for the provider. */
  | { kind: 'quiet' }
  | { kind: 'failed'; message?: string; detail?: string };

export async function signInToConnector(id: string, current: () => boolean): Promise<SignInOutcome> {
  const started = await startConnectorSignIn(id, 'mobile');
  if (!current()) return { kind: 'quiet' };
  if (!started.ok) return { kind: 'failed', message: started.message || undefined };
  const session = await WebBrowser.openAuthSessionAsync(started.data.authorize_url, CONNECTOR_APP_REDIRECT);
  const back = parseConnectorReturn(session.type === 'success' ? session.url : null);
  if (back.kind === 'cancel' || !current()) return { kind: 'quiet' };
  if (back.kind === 'error') return { kind: 'failed', detail: back.reason };
  const finished = await finishConnectorSignIn(back.code, back.state);
  if (!current()) return { kind: 'quiet' };
  if (!finished.ok) return { kind: 'failed', message: finished.message || undefined };
  return { kind: 'connected' };
}
