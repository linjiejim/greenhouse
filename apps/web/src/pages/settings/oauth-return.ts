/**
 * A connector sign-in comes back through the API's public callback, which changes nothing and
 * sends the browser to `#/settings/connections` with what the provider said: `oauth_state` and
 * `oauth_code` to finish with the member's own session, or `oauth_error`. `connector` names it
 * when the state could be read.
 */

import { useSyncExternalStore } from 'react';

export type OAuthReturn =
  | { kind: 'finish'; connector: string | null; state: string; code: string }
  | { kind: 'failed'; connector: string | null; error: string; description: string | null };

export function readOAuthReturn(hash: string): OAuthReturn | null {
  const at = hash.indexOf('?');
  if (at < 0) return null;
  const query = new URLSearchParams(hash.slice(at + 1));
  const connector = query.get('connector') || null;
  const error = query.get('oauth_error');
  if (error) return { kind: 'failed', connector, error, description: query.get('oauth_error_description') || null };
  const state = query.get('oauth_state');
  const code = query.get('oauth_code');
  return state && code ? { kind: 'finish', connector, state, code } : null;
}

/** What became of the last sign-in: still finishing, or why it stopped. */
export interface SignInOutcome {
  connector: string | null;
  finishing: boolean;
  /** Starting or finishing it failed with this. */
  error?: unknown;
  /** The provider sent this back instead of a code. */
  back?: OAuthReturn & { kind: 'failed' };
}

/**
 * Kept outside the page: the workspace remounts on every change of address, the one that clears
 * the sign-in from it included, so the page would forget what it was doing.
 */
let outcome: SignInOutcome | null = null;
const watchers = new Set<() => void>();

export function setSignInOutcome(next: SignInOutcome | null) {
  outcome = next;
  for (const watch of watchers) watch();
}

const watch = (onChange: () => void) => {
  watchers.add(onChange);
  return () => void watchers.delete(onChange);
};
const current = () => outcome;

export function useSignInOutcome(): SignInOutcome | null {
  return useSyncExternalStore(watch, current, current);
}
