import { useEffect, useState } from 'react';
import { bridge } from './embed';

export type Route =
  | { view: 'library'; asset?: string }
  | { view: 'collections' }
  | { view: 'collection'; id: string; asset?: string }
  | { view: 'manage'; tab: 'facets' | 'duplicates' | 'bin'; asset?: string };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '').split('?')[0];
  let m = /^\/asset\/([^/?#]+)/.exec(path);
  if (m) return { view: 'library', asset: decodeURIComponent(m[1]) };
  m = /^\/collection\/([^/?#]+)(?:\/asset\/([^/?#]+))?/.exec(path);
  if (m) return { view: 'collection', id: decodeURIComponent(m[1]), asset: m[2] ? decodeURIComponent(m[2]) : undefined };
  if (path.startsWith('/collections')) return { view: 'collections' };
  m = /^\/manage(?:\/(facets|duplicates|bin))?(?:\/asset\/([^/?#]+))?/.exec(path);
  if (m)
    return {
      view: 'manage',
      tab: (m[1] as 'facets' | 'duplicates' | 'bin') ?? 'facets',
      asset: m[2] ? decodeURIComponent(m[2]) : undefined,
    };
  return { view: 'library' };
}

/** The host keeps this frame's view in its own address, so a filtered view reloads and shares. */
function tellHost() {
  bridge.route(window.location.hash || '#/');
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute(window.location.hash));
      tellHost();
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

/** Open a view; the list's filters stay in the query of the list it came from. */
export const go = (hash: string) => {
  window.location.hash = hash;
};

/** The filters in the address (`#/collection/x?q=…&kind=image`). */
export function readQuery(): URLSearchParams {
  return new URLSearchParams(window.location.hash.split('?')[1] ?? '');
}

/** Replace the address's filters without a history entry. */
export function writeQuery(params: URLSearchParams) {
  const [path] = (window.location.hash || '#/').split('?');
  const query = params.toString();
  const next = query ? `${path}?${query}` : path;
  if (next === window.location.hash) return;
  history.replaceState(null, '', next);
  tellHost();
}

/** The current list address with its filters, to come back to after closing an asset. */
export function listHash(base: string): string {
  const query = window.location.hash.split('?')[1];
  return query ? `${base}?${query}` : base;
}
