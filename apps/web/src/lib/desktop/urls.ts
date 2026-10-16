/**
 * In the desktop shell the page is served from greenhouse://localhost, so a relative
 * `/api/...` link (signed file links, pictures in Markdown, avatars) would resolve against
 * the app bundle instead of the server. The API client already takes a base; this covers
 * everything else: fetch with a relative API path, and src / href / poster attributes.
 * Call sites that hand a URL to a detached link or window.open use apiUrl directly.
 */

import { desktopApiBase } from './shell';

const API_PATH = /^\/(?:api|public)(?:[/?#]|$)|^\/health(?:[?#]|$)/;
const ATTRIBUTES = ['src', 'href', 'poster'];
const SELECTOR = ATTRIBUTES.map((name) => `[${name}]`).join(',');

/** A same-origin API path made absolute against `base`; anything else unchanged. */
export function resolveApiUrl(url: string, base: string, pageOrigin?: string): string {
  if (!base || !url) return url;
  let path = url;
  if (pageOrigin && url.startsWith(`${pageOrigin}/`)) path = url.slice(pageOrigin.length);
  return API_PATH.test(path) ? `${base}${path}` : url;
}

/** For URLs given to a detached link, window.open or a raw fetch. A no-op in a browser. */
export function apiUrl(url: string): string {
  return resolveApiUrl(url, desktopApiBase());
}

function fixElement(element: Element, base: string) {
  for (const name of ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const resolved = resolveApiUrl(value, base);
    if (resolved !== value) element.setAttribute(name, resolved);
  }
}

function fixTree(node: Node, base: string) {
  if (!(node instanceof Element)) return;
  fixElement(node, base);
  node.querySelectorAll(SELECTOR).forEach((element) => fixElement(element, base));
}

/** Rewrites API paths for the life of the page. Returns a function that undoes it (tests). */
export function installApiUrls(base: string, root: Document = document): () => void {
  if (!base) return () => undefined;
  const view = root.defaultView ?? window;
  const pageOrigin = view.location.origin;

  const originalFetch = view.fetch;
  const send = (input: RequestInfo | URL, init?: RequestInit) => originalFetch.call(view, input, init);
  view.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string') return send(resolveApiUrl(input, base, pageOrigin), init);
    if (input instanceof URL) return send(resolveApiUrl(input.href, base, pageOrigin), init);
    const resolved = resolveApiUrl(input.url, base, pageOrigin);
    return send(resolved === input.url ? input : new Request(resolved, input), init);
  };

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') fixElement(record.target as Element, base);
      else record.addedNodes.forEach((node) => fixTree(node, base));
    }
  });
  observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ATTRIBUTES });
  if (root.documentElement) fixTree(root.documentElement, base);

  return () => {
    observer.disconnect();
    view.fetch = originalFetch;
  };
}
