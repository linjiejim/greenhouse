/**
 * Entry links: the addresses a station sends a browser to (src/shared/client-routes.ts, the
 * station's own table) and where they land. React-free (./entry-links.test.ts).
 *
 * A secret in a fragment (`/activate#token=`, `/login#feishu_code=`, `/connectors/oauth-finish#code=`)
 * is read once at startup, before routing, held in memory for its page and removed from the
 * address bar, so it never stays in history, a bookmark or a Referer. Only its page reads it.
 * The consent request (`/oauth-consent?…`) is held as the browser parsed it too (it stays in
 * the address): the router's own query parsing must not touch its scopes or PKCE values.
 */

import { CLIENT_ROUTES, FRAGMENT_ROUTES, type ClientRoute } from '../shared/client-routes';

let held: { route: ClientRoute; params: URLSearchParams } | null = null;

/**
 * An address in the app (`/path?query#fragment`) → the address to show, holding back the
 * fragment of an entry route (and the consent request). Other addresses come back unchanged.
 */
export function captureEntry(address: string): string {
  const at = address.indexOf('#');
  const visible = at < 0 ? address : address.slice(0, at);
  const [path, query = ''] = visible.split('?', 2) as [string, string?];
  if (path === CLIENT_ROUTES.oauthConsent) {
    held = { route: CLIENT_ROUTES.oauthConsent, params: new URLSearchParams(query) };
    return visible;
  }
  const route = at < 0 ? undefined : FRAGMENT_ROUTES.find((candidate) => candidate === path);
  if (!route) return address;
  held = { route, params: new URLSearchParams(address.slice(at + 1)) };
  return visible;
}

/** The fragment parameters held for this route, if its page has not let them go. */
export function heldEntryParams(route: ClientRoute): URLSearchParams | null {
  return held?.route === route ? new URLSearchParams(held.params) : null;
}

/** The page used them (or saw they were not for it): nothing is held any more. */
export function releaseEntryParams(route: ClientRoute): void {
  if (held?.route === route) held = null;
}

const STANDALONE: readonly string[] = [
  CLIENT_ROUTES.activate,
  CLIENT_ROUTES.oauthConsent,
  CLIENT_ROUTES.connectorFinish,
  CLIENT_ROUTES.bindings,
];

/** Pages a browser lands on from outside the app: they draw alone, without the rail. */
export function isStandaloneEntry(pathname: string): boolean {
  return STANDALONE.includes(pathname);
}

// Activation finished: the root gate sends the new member home (it alone navigates on sign-in).
let activated = false;
export function markActivated(): void {
  activated = true;
}
export function takeActivated(): boolean {
  const was = activated;
  activated = false;
  return was;
}
