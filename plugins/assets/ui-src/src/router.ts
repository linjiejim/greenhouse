import { useEffect, useState } from 'react';

export type Route =
  | { view: 'library'; asset?: string }
  | { view: 'collections' }
  | { view: 'collection'; id: string; asset?: string }
  | { view: 'manage'; tab: 'facets' | 'duplicates' | 'bin' };

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');
  let m = /^\/asset\/([^/?#]+)/.exec(path);
  if (m) return { view: 'library', asset: decodeURIComponent(m[1]) };
  m = /^\/collection\/([^/?#]+)(?:\/asset\/([^/?#]+))?/.exec(path);
  if (m) return { view: 'collection', id: decodeURIComponent(m[1]), asset: m[2] ? decodeURIComponent(m[2]) : undefined };
  if (path.startsWith('/collections')) return { view: 'collections' };
  m = /^\/manage(?:\/(facets|duplicates|bin))?/.exec(path);
  if (m) return { view: 'manage', tab: (m[1] as 'facets' | 'duplicates' | 'bin') ?? 'facets' };
  return { view: 'library' };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (hash: string) => {
  window.location.hash = hash;
};
