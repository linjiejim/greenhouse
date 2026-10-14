/**
 * Every navigation to the home route (`/`) — a conversation (`?c=<id>`), the main thread (no
 * `c`) or a new chat (`?c=new`, optionally with an Agent) — goes through here, with all five
 * home params set (an empty string clears one). `dismissTo` merges params into the existing
 * home route instead of replacing them (apps/mobile/AGENTS.md), so a key left out would keep the
 * previous conversation's value: a stale `request` would scroll to someone else's card.
 *
 * How to get there: `replace` from inside the drawer (the 200 ms cross-fade, no back stack);
 * `dismissTo` from a sheet, a page, a deep link or settings (pops back to the one home under
 * them — never stack a second one).
 *
 * `openAppRoute` opens any of the app's places (a link in a reply, a push, a notification).
 */

import type { useRouter } from 'expo-router';
import type { AppRoute } from '../lib/app-links';

export type AppRouter = ReturnType<typeof useRouter>;

/** `c` for a new chat. */
export const NEW_CHAT = 'new';

export interface HomeParams {
  /** A conversation id, `new` for a new chat, '' for the main thread. */
  c: string;
  /** A new chat with this Agent (its id; '' = the main Agent). */
  agent: string;
  /** Placeholder title while the conversation loads. */
  title: string;
  /** '1' = focus the composer (the widget's "New Chat", `?compose=1` links). */
  compose: '' | '1';
  /** A 「需要你」 card to scroll to and highlight (pushes, deep links). */
  request: string;
}

/** All five home params: the given ones, every other cleared. */
export function homeParams(p: Partial<HomeParams> = {}): HomeParams {
  return {
    c: p.c ?? '',
    agent: p.agent ?? '',
    title: p.title ?? '',
    compose: p.compose ?? '',
    request: p.request ?? '',
  };
}

export type NavHow = 'replace' | 'dismissTo';

function goHome(router: AppRouter, params: HomeParams, how: NavHow): void {
  // Spread into a fresh object literal: router params want an index signature.
  const href = { pathname: '/' as const, params: { ...params } };
  if (how === 'dismissTo') router.dismissTo(href);
  else router.replace(href);
}

/** A conversation; `request` scrolls to (and highlights) a card, `compose` focuses the composer. */
export function openConversation(
  router: AppRouter,
  target: { id: string; title?: string; request?: string; compose?: boolean },
  how: NavHow = 'replace',
): void {
  goHome(
    router,
    homeParams({ c: target.id, title: target.title, request: target.request, compose: target.compose ? '1' : '' }),
    how,
  );
}

/** The main thread (the landing place). */
export function openMainThread(router: AppRouter, how: NavHow = 'replace'): void {
  goHome(router, homeParams(), how);
}

/** A new chat — with a given Agent (its id) and/or the composer focused. */
export function openNewChat(
  router: AppRouter,
  options: { agent?: string; compose?: boolean } = {},
  how: NavHow = 'replace',
): void {
  goHome(router, homeParams({ c: NEW_CHAT, agent: options.agent, compose: options.compose ? '1' : '' }), how);
}

/**
 * One of the app's places (src/lib/app-links.ts): the conversation surface through the helpers
 * above, the other places pushed over it. False for a web-only route (knowledge, tables, apps…):
 * the caller says it opens in the web app.
 */
export function openAppRoute(router: AppRouter, route: AppRoute, options: { request?: string; how?: NavHow } = {}): boolean {
  const how = options.how ?? 'dismissTo';
  switch (route.kind) {
    case 'main':
      openMainThread(router, how);
      return true;
    case 'new-chat':
      openNewChat(router, { compose: true }, how);
      return true;
    case 'conversation':
      openConversation(router, { id: route.id, request: options.request }, how);
      return true;
    case 'agents':
      router.push('/agents');
      return true;
    case 'agent':
      router.push({ pathname: '/agents/[id]', params: { id: route.id } });
      return true;
    case 'runs':
      router.push('/runs');
      return true;
    case 'run':
      router.push({ pathname: '/runs/[id]', params: { id: route.id } });
      return true;
    case 'notifications':
      router.push('/notifications');
      return true;
    case 'settings':
      router.push('/settings');
      return true;
    case 'web':
      return false;
  }
}
