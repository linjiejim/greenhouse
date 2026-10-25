/**
 * My conversations (the first page of `/api/sessions`, newest first, pinned ones included), shared
 * by home's recent five and the all-conversations sheet. Cache first: the copy saved on this phone
 * shows at once, offline too, and the station's answer replaces it (rules in ../data/home.ts).
 * Pinning, renaming and deleting are optimistic and come back on failure. Resets on any station or member
 * change; late answers for another identity are dropped.
 */

import { create } from 'zustand';
import { deleteSession, listSessions, pinSession, renameSession } from '../api/assistant';
import { captureIdentity } from '../data/identity';
import { orderConversations, parseSessions, withPinned } from '../data/home';
import { t } from '../lib/i18n';
import type { ChatSession } from '../shared/greenhouse-types';
import { alertError } from '../ui/dialogs';
import { useAuth } from './auth';
import { readOffline, writeOffline } from './offline';
import { useStations } from './stations';

const KIND = 'sessions';

interface Sessions {
  items: ChatSession[];
  status: 'empty' | 'cached' | 'ready' | 'error';
  /** The last refresh did not reach the station (the copy stays). */
  offline: boolean;
  refresh: () => Promise<void>;
  pin: (id: string, pinned: boolean) => Promise<void>;
  rename: (id: string, title: string) => Promise<void>;
  /** Delete a conversation; true once the station has (or it was gone already). */
  remove: (id: string) => Promise<boolean>;
}

export const useSessions = create<Sessions>((set, get) => ({
  items: [],
  status: 'empty',
  offline: false,
  refresh: async () => {
    const current = captureIdentity();
    if (get().status === 'empty') {
      const saved = parseSessions(await readOffline(KIND));
      if (!current()) return;
      if (saved && get().status === 'empty') set({ items: orderConversations(saved), status: 'cached' });
    }
    const result = await listSessions(0);
    if (!current()) return;
    if (!result.ok) {
      set({ offline: result.status === 0, status: get().items.length ? get().status : 'error' });
      return;
    }
    const items = orderConversations(result.data.sessions);
    set({ items, status: 'ready', offline: false });
    writeOffline(KIND, items);
  },
  pin: async (id, pinned) => {
    const before = get().items;
    set({ items: orderConversations(withPinned(before, id, pinned)) });
    const current = captureIdentity();
    const result = await pinSession(id, pinned);
    if (!current()) return;
    if (!result.ok) {
      set({ items: before });
      alertError(t('home.pinFailed'), result.message || undefined);
      return;
    }
    writeOffline(KIND, get().items);
  },
  rename: async (id, title) => {
    const before = get().items;
    set({ items: before.map((s) => (s.id === id ? { ...s, title } : s)) });
    const current = captureIdentity();
    const result = await renameSession(id, title);
    if (!current()) return;
    if (!result.ok) {
      set({ items: before });
      alertError(t('home.renameFailed'), result.message || undefined);
      return;
    }
    writeOffline(KIND, get().items);
  },
  remove: async (id) => {
    const before = get().items;
    set({ items: before.filter((s) => s.id !== id) });
    const current = captureIdentity();
    const result = await deleteSession(id);
    if (!current()) return false;
    if (!result.ok && result.status !== 404) {
      set({ items: before });
      alertError(t('conversation.deleteFailed'), result.message || undefined);
      return false;
    }
    writeOffline(KIND, get().items);
    return true;
  },
}));

let identity = '';
const follow = () => {
  const next = `${useStations.getState().activeId ?? ''}:${useAuth.getState().user?.id ?? ''}`;
  if (next === identity) return;
  identity = next;
  useSessions.setState({ items: [], status: 'empty', offline: false });
};
useAuth.subscribe(follow);
useStations.subscribe(follow);
