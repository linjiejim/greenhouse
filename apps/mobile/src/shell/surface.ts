/**
 * What is on screen, for the push presenter: the notification whose detail page is showing, if
 * any (its push stays quiet in the foreground). The detail page publishes and clears it.
 */

import { create } from 'zustand';

export const useSurface = create<{ notification: string | null }>(() => ({ notification: null }));

export const visibleNotification = (): string | null => useSurface.getState().notification;
