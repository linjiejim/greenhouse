/**
 * The hash router: which hash the app shows, with retired hashes resolved to
 * their canonical pages BEFORE anything renders.
 *
 * Redirects used to happen inside route parsing, during render, by assigning
 * `window.location.hash` — a side effect in render that pushed an extra history
 * entry (Back bounced straight into the redirect again) and left the rendered
 * route and the address bar briefly describing different pages. Here a retired
 * hash is replaced in place (`history.replaceState`, which fires no
 * `hashchange`) and the state the shell renders from is always the canonical
 * hash, so every consumer — the page, the sidebar's active item, the top bar —
 * reads one value.
 *
 * The leave guard: a hash change cannot be cancelled — by the time `hashchange`
 * fires the URL has already moved. So when a screen has unsaved work we simply
 * do NOT commit the new hash: the app keeps rendering the current screen while
 * the caller asks the user. Confirming commits it; cancelling puts the URL back
 * (which fires another `hashchange` that matches what we are already rendering,
 * and is ignored).
 */

import { useCallback, useEffect, useState } from 'react';
import { legacyExecutionRedirect } from './execution-route';
import { navigationBlocked } from './navigation-guard';
import { retiredWorkspaceRedirect } from './workspace-routes';

/** The landing page: Home, which is the new-conversation screen. */
export const DEFAULT_HASH = '#/home';

/** A fresh new conversation on Home; the timestamp forces a new one even when Home is already open. */
export function newChatHash(now: number = Date.now()): string {
  return `#/home?new=${now}`;
}

/** Top-level hashes core owns; an extension alias can never take one over. */
export const CORE_ROUTES: ReadonlySet<string> = new Set([
  'home',
  'chat',
  'automations',
  'settings',
  'administration',
  'projects',
  'design',
  'knowledge',
  'tables',
  'files',
  'skillhub',
  'activity',
]);

function redirectOnce(hash: string, aliases: ReadonlyMap<string, string>): string | null {
  const executionRedirect = legacyExecutionRedirect(hash);
  if (executionRedirect) return executionRedirect;

  const cleaned = hash.replace(/^#\/?/, '');
  const queryIndex = cleaned.indexOf('?');
  const path = queryIndex >= 0 ? cleaned.slice(0, queryIndex) : cleaned;
  const query = queryIndex >= 0 ? cleaned.slice(queryIndex + 1) : '';
  const segments = path.split('/');
  const topLevel = segments[0] || 'home';

  // Retired workspace pages (My prompts → SkillHub tab, My Agents → Automations
  // tab) and the legacy `#/chat?view=…` switches.
  const workspaceRedirect = retiredWorkspaceRedirect(topLevel, new URLSearchParams(query).get('view'));
  if (workspaceRedirect) return workspaceRedirect;

  // The retired Apps / workbench page lands on Home.
  if (topLevel === 'workbench') return DEFAULT_HASH;
  // The old full-page inbox became the bell dialog; history became the History
  // dialog; dashboard / inquiry were earlier product areas.
  if (['history', 'inbox', 'dashboard', 'inquiry'].includes(topLevel)) return DEFAULT_HASH;
  // `#/chat` only opens an existing conversation; a new one is Home. `?new=`
  // rides along so it still forces a fresh conversation.
  if (topLevel === 'chat') {
    const params = new URLSearchParams(query);
    if (!params.get('session')) {
      const fresh = params.get('new');
      return fresh ? `${DEFAULT_HASH}?new=${encodeURIComponent(fresh)}` : DEFAULT_HASH;
    }
  }

  // Legacy hashes an extension claims (`pages[].aliases`) redirect into the
  // extension, tail and query intact. A core route can never be aliased away.
  const alias = CORE_ROUTES.has(topLevel) ? undefined : aliases.get(topLevel);
  if (alias) {
    const tail = segments.slice(1).filter(Boolean).join('/');
    return `#/${alias}${tail ? `/${tail}` : ''}${query ? `?${query}` : ''}`;
  }
  return null;
}

/** The hash a raw hash resolves to once every retired-route redirect has been applied. */
export function canonicalHash(raw: string, aliases: ReadonlyMap<string, string> = new Map()): string {
  let hash = raw || DEFAULT_HASH;
  // Redirect chains are short (an alias into a page that is itself current);
  // the bound only guards against a misconfigured alias cycle.
  for (let hop = 0; hop < 5; hop++) {
    const next = redirectOnce(hash, aliases);
    if (!next || next === hash) break;
    hash = next;
  }
  return hash;
}

/** Read the address bar, replacing a retired hash with its canonical one in place. */
function currentCanonicalHash(aliases: ReadonlyMap<string, string>): string {
  const raw = window.location.hash;
  const hash = canonicalHash(raw, aliases);
  if (hash !== raw) {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${hash}`,
    );
  }
  return hash;
}

export function useHashRouter(aliases: ReadonlyMap<string, string> = new Map()): {
  hash: string;
  pending: string | null;
  confirmLeave: () => void;
  cancelLeave: () => void;
} {
  const [hash, setHash] = useState(() => currentCanonicalHash(aliases));
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    const handler = () => {
      const next = currentCanonicalHash(aliases);
      if (next === hash) {
        setPending(null);
        return;
      }
      if (navigationBlocked()) {
        setPending(next);
        return;
      }
      setHash(next);
    };
    window.addEventListener('hashchange', handler);
    return () => window.removeEventListener('hashchange', handler);
  }, [aliases, hash]);

  const confirmLeave = useCallback(() => {
    setPending((target) => {
      if (target) setHash(target);
      return null;
    });
  }, []);
  const cancelLeave = useCallback(() => {
    setPending(null);
    // Back to where we still are. Same-value assignment fires no event, which is
    // exactly right — nothing to re-render.
    window.location.hash = hash;
  }, [hash]);

  return { hash, pending, confirmLeave, cancelLeave };
}
