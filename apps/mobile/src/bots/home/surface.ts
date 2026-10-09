/**
 * What the home route is showing right now — published by the home screen
 * (app/(drawer)/(main)/index.tsx), read by the drawer (history highlight,
 * "New chat", the Bots rows).
 *
 * The drawer can't go by the route's params: a cold start draws the restored
 * Bots thread before `setParams` names it (and sometimes that never lands —
 * see ./initial-surface.ts), so `?c=` reads empty while a thread is on
 * screen. Going by the params, "New chat" thought it was already on one and
 * only closed the drawer, and the thread's row never lit up.
 */

import { create } from 'zustand';

export interface HomeSurface {
  /** The chat session on screen ('' = a new chat or a thread). */
  id: string;
  /** The Bots thread on screen (session id; '' = none). */
  c: string;
  /** A new chat with one Bot (`sprouty` / `bot:<id>`; '' = a plain one). */
  profile: string;
}

export const useHomeSurface = create<HomeSurface & { publish: (surface: HomeSurface) => void }>((set) => ({
  id: '',
  c: '',
  profile: '',
  publish: (surface) => set(surface),
}));
