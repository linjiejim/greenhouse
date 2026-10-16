/**
 * What the home route shows right now — published by the home screen
 * (app/(drawer)/(main)/index.tsx), read by the drawer (the current row, "New chat") and the push
 * presenter (the conversation on screen stays quiet). The route's params lag a cold start (the
 * main thread is shown before its id is known), so these are the facts.
 */

import { create } from 'zustand';

export interface HomeSurface {
  /** The conversation on screen (its id; '' while none is known yet or a new chat is). */
  conversationId: string;
  /** A new chat is on screen. */
  newChat: boolean;
  /** The home route is the screen in front (no page or sheet over it) and the app is active. */
  visible: boolean;
}

export const useHomeSurface = create<HomeSurface & { publish: (surface: Partial<HomeSurface>) => void }>((set) => ({
  conversationId: '',
  newChat: false,
  visible: false,
  publish: (surface) => set(surface),
}));

/** The conversation the member is looking at right now, or null. */
export function visibleConversation(): string | null {
  const { conversationId, visible } = useHomeSurface.getState();
  return visible && conversationId ? conversationId : null;
}
