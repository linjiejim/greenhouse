/**
 * The one way to open anything: `useOpenObject()(ref)` and `useOpenHref()(href)`.
 *
 * Objects open as native form sheets over what is on screen, stacked up to three deep (the
 * fourth replaces the top one; rules in ./object-ref.ts). A conversation is a full page: open
 * sheets are dismissed first, because a page pushed over a sheet would land inside the sheet's
 * own presentation. A link to a place (a tab, a table, My Agents) goes there the same way; other
 * station pages open in the in-app Safari view, other sites in Safari.
 *
 * A screen can name itself as the origin of what opens from it (`OpenOrigin`; the conversation
 * does): sheets then carry `from` and say where they came from above their title, so a stack of
 * sheets keeps its context.
 */

import { createContext, useCallback, useContext } from 'react';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { linkTarget, webUrl, type AppTarget } from '../lib/deep-links';
import { openLink } from '../lib/links';
import { getApiBase } from '../store/stations';
import { useTheme } from '../theme';
import { openingOf, refOfTarget, sheetDepth, sheetMove, type ObjectRef, type Place, type StackRoute } from './object-ref';

type Router = ReturnType<typeof useRouter>;
type ContainerRef = ReturnType<typeof useNavigationContainerRef>;

interface NavState {
  routes: (StackRoute & { state?: NavState })[];
}

/** The routes of the root stack (the one that holds the tabs and the sheets). */
function rootRoutes(container: ContainerRef): StackRoute[] {
  let state = container.getRootState() as NavState | undefined;
  for (let depth = 0; state && depth < 4; depth += 1) {
    if (state.routes.some((route) => route.name === '(drawer)' || route.name === 'login')) return state.routes;
    state = state.routes[state.routes.length - 1]?.state;
  }
  return [];
}

/** Close every sheet and page over the tabs, then run `then`. */
function leavePresented(router: Router, routes: readonly StackRoute[], then: () => void): void {
  if (routes.length > 1 && router.canDismiss()) {
    router.dismissAll();
    setTimeout(then, 0);
  } else then();
}

/** The title of the screen things open from (a conversation); sheets show it as their origin. */
export const OpenOrigin = createContext<string | null>(null);

export function openObject(router: Router, container: ContainerRef, ref: ObjectRef, from?: string | null): void {
  const opening = openingOf(ref);
  const routes = rootRoutes(container);
  if (opening.via === 'page') {
    leavePresented(router, routes, () => router.push({ pathname: opening.pathname, params: opening.params }));
    return;
  }
  const params = from ? { ...opening.params, from: from.slice(0, 120) } : opening.params;
  const href = { pathname: opening.pathname, params };
  if (sheetMove(sheetDepth(routes)) === 'replace') router.replace(href);
  else router.push(href);
}

export function openPlace(router: Router, container: ContainerRef, place: Place, accent?: string, from?: string | null): void {
  const routes = rootRoutes(container);
  switch (place.kind) {
    case 'tab':
      leavePresented(router, routes, () => router.navigate(place.href));
      return;
    case 'drive':
      if (place.folderId) {
        openObject(router, container, { kind: 'folder', scope: 'drive', shelf: place.shelf, id: place.folderId }, from);
        return;
      }
      leavePresented(router, routes, () => router.navigate({ pathname: '/drive', params: { shelf: place.shelf } }));
      return;
    case 'tables':
      leavePresented(router, routes, () => {
        if (place.tableId) router.navigate({ pathname: '/drive/table', params: { id: String(place.tableId) } });
        else if (place.baseId) router.navigate({ pathname: '/drive/base', params: { id: String(place.baseId) } });
        else router.navigate({ pathname: '/drive', params: { view: 'tables' } });
      });
      return;
    case 'agents':
      router.push('/me/agents');
      return;
    case 'web':
      void openLink(webUrl(getApiBase(), place.hash), accent);
      return;
    case 'external':
      void openLink(place.url, accent);
  }
}

/** Open an object (see ./object-ref.ts). */
export function useOpenObject(): (ref: ObjectRef) => void {
  const router = useRouter();
  const container = useNavigationContainerRef();
  const from = useContext(OpenOrigin);
  return useCallback((ref: ObjectRef) => openObject(router, container, ref, from), [router, container, from]);
}

/**
 * A new conversation with the assistant, its composer filled with `draft` and the keyboard up
 * (the conversation-first way to make things: "帮我创建一个定时任务：…"). Open sheets close first.
 */
export function useStartChat(): (draft: string) => void {
  const router = useRouter();
  const container = useNavigationContainerRef();
  return useCallback(
    (draft: string) => {
      leavePresented(router, rootRoutes(container), () => router.push({ pathname: '/chat', params: { draft } }));
    },
    [router, container],
  );
}

/** Open a link target (src/lib/deep-links.ts): one object, or a place. */
export function openTarget(router: Router, container: ContainerRef, target: AppTarget, accent?: string, from?: string | null): void {
  const next = refOfTarget(target);
  if ('ref' in next) openObject(router, container, next.ref, from);
  else openPlace(router, container, next.place, accent, from);
}

export function useOpenTarget(): (target: AppTarget) => void {
  const router = useRouter();
  const container = useNavigationContainerRef();
  const { hex } = useTheme();
  const from = useContext(OpenOrigin);
  return useCallback((target: AppTarget) => openTarget(router, container, target, hex.accent, from), [router, container, hex.accent, from]);
}

/** A link as written in content; false when it goes nowhere the app can open. */
export function useOpenHref(): (href: string) => boolean {
  const router = useRouter();
  const container = useNavigationContainerRef();
  const { hex } = useTheme();
  const from = useContext(OpenOrigin);
  return useCallback(
    (href: string) => {
      const value = href.trim();
      if (/^(mailto|tel):/i.test(value)) {
        void openLink(value);
        return true;
      }
      const target = linkTarget(value, getApiBase());
      if (!target) return false;
      openTarget(router, container, target, hex.accent, from);
      return true;
    },
    [router, container, hex.accent, from],
  );
}
