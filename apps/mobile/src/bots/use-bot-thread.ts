/**
 * `useBotThread(sessionId)` — a Bots thread's state for the screen: the
 * engine (./thread/engine.ts `ThreadEngine`, one per thread on screen) read
 * through `useSyncExternalStore`, plus its controller for sends, stops,
 * decisions and paging (contract: ./contract.ts).
 *
 * All this hook adds is the lifecycle: one engine per `sessionId` (the screen
 * is keyed by it, so another thread = a new engine), opened by its first
 * subscriber, disposed on unmount — which only lets go locally; a run goes on
 * server-side. Visibility (focused AND foreground — a sheet on top does not
 * count) drives read receipts and polling; the app state drives the
 * foreground checks (a dead socket after the background, what happened
 * meanwhile).
 */

import { useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from 'expo-router';
import * as botsApi from '../api/bots';
import * as chatApi from '../api/chat';
import { realtime } from '../realtime';
import type { ThreadController, ThreadDeps, ThreadSnapshot } from './contract';
import { useBots } from './store';
import { ThreadEngine } from './thread/engine';

const liveDeps: ThreadDeps = {
  api: {
    getConversation: botsApi.getConversation,
    markConversationRead: botsApi.markConversationRead,
    openBotsChat: chatApi.openBotsChat,
    interruptChatRun: chatApi.interruptChatRun,
    getChatRun: chatApi.getChatRun,
    streamChatRun: chatApi.streamChatRun,
    stopChatRun: chatApi.stopChatRun,
  },
  realtime,
  store: { getState: useBots.getState, subscribe: (listener) => useBots.subscribe(listener) },
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
};

export function useBotThread(sessionId: string): { snap: ThreadSnapshot; ctl: ThreadController } {
  const [engine, setEngine] = useState(() => new ThreadEngine(sessionId, liveDeps));
  // Another thread in the same instance (the screen is normally keyed by it): a new engine.
  const current = engine.sessionId === sessionId ? engine : null;
  if (!current) setEngine(new ThreadEngine(sessionId, liveDeps));
  const active = current ?? engine;

  useEffect(() => {
    // Disposed by an earlier effect pass (a dev double-mount): start over with a fresh one.
    if (active.isDisposed) {
      setEngine(new ThreadEngine(sessionId, liveDeps));
      return;
    }
    return () => active.dispose();
  }, [active, sessionId]);

  const snap = useSyncExternalStore(active.subscribe, active.getSnapshot);

  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => sub.remove();
  }, []);

  useEffect(() => {
    active.setForeground(appActive);
  }, [active, appActive]);

  useEffect(() => {
    active.setVisible(focused && appActive);
  }, [active, focused, appActive]);

  return { snap, ctl: active };
}
