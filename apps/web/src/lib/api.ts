import { createApiClient } from '@greenhouse/contract/client';
import { desktopApiBase } from './desktop/shell';
import { browserTokens } from './tokens';

const signedOut = new Set<() => void>();

/** The one client; the session provider listens for the end of the session. */
export const api = createApiClient({
  // Same origin in a browser; the configured server inside the desktop app.
  baseUrl: desktopApiBase(),
  tokens: browserTokens,
  client: 'web',
  onSignedOut: () => signedOut.forEach((listener) => listener()),
});

export function onSignedOut(listener: () => void) {
  signedOut.add(listener);
  return () => void signedOut.delete(listener);
}
