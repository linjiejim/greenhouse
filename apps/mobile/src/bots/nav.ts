/**
 * Every navigation to the home route (`/`) — a Bots thread (`?c=`), a chat
 * (`?id=`) or a new chat — goes through here, with all seven home params set
 * (an empty string clears one). `dismissTo` merges params into the existing
 * home route instead of replacing them (apps/mobile/AGENTS.md), so a key left
 * out would keep the previous surface's value: a stale `c` would reopen a
 * thread, a stale `request` would scroll to someone else's card. The home
 * screen renders a thread when `c` is non-empty, else the conversation screen.
 *
 * How to get there: `replace` from inside the drawer (the 200 ms cross-fade,
 * no back stack); `dismissTo` from a sheet, a deep link or settings (pops back
 * to the one home under them — never stack a second one).
 */

import type { useRouter } from 'expo-router';

export type AppRouter = ReturnType<typeof useRouter>;

export interface HomeParams {
  /** A chat session. */
  id: string;
  /** A Bots conversation (session id): non-empty = the thread surface. */
  c: string;
  /** Placeholder title while the surface loads. */
  title: string;
  /** '1' = a read-only chat (shared with the member, a task's full record). */
  ro: '0' | '1';
  /** '1' = focus the composer (the widget's "New Chat", `?compose=1` links). */
  compose: '' | '1';
  /** A card to scroll to and highlight in the thread (deep links). */
  request: string;
  /** A new chat with this Bot (`bot:<id>` / `sprouty`) — that chat only, never saved to prefs. */
  profile: string;
}

/** All seven home params: the given ones, every other cleared. */
export function homeParams(p: Partial<HomeParams> = {}): HomeParams {
  return {
    id: p.id ?? '',
    c: p.c ?? '',
    title: p.title ?? '',
    ro: p.ro ?? '0',
    compose: p.compose ?? '',
    request: p.request ?? '',
    profile: p.profile ?? '',
  };
}

export type NavHow = 'replace' | 'dismissTo';

function goHome(router: AppRouter, params: HomeParams, how: NavHow): void {
  // Spread into a fresh object literal: router params want an index signature.
  const href = { pathname: '/' as const, params: { ...params } };
  if (how === 'dismissTo') router.dismissTo(href);
  else router.replace(href);
}

/** A Bots thread; `request` scrolls to (and highlights) a card, `compose` focuses the composer. */
export function openThread(
  router: AppRouter,
  t: { c: string; title?: string; request?: string; compose?: boolean },
  how: NavHow = 'replace',
): void {
  goHome(router, homeParams({ c: t.c, title: t.title, request: t.request, compose: t.compose ? '1' : '' }), how);
}

/** A new chat — with a given Bot (`profile`, this chat only) and/or the composer focused. */
export function openNewChat(
  router: AppRouter,
  o: { profile?: string; compose?: boolean } = {},
  how: NavHow = 'replace',
): void {
  goHome(router, homeParams({ profile: o.profile, compose: o.compose ? '1' : '' }), how);
}

/** An existing chat session (`ro` = read-only). */
export function openChat(
  router: AppRouter,
  s: { id: string; title?: string; ro?: boolean },
  how: NavHow = 'replace',
): void {
  goHome(router, homeParams({ id: s.id, title: s.title, ro: s.ro ? '1' : '0' }), how);
}
