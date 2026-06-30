/**
 * UI Store (Zustand) — global UI state.
 *
 * Manages sidebar, navigation drawer, profile panel, preferences dialog etc.
 * Replaces prop-drilled useState from App → AppShell.
 */

import { create } from 'zustand';

export const SIDEBAR_MIN_WIDTH = 248;
export const SIDEBAR_MAX_WIDTH = 420;

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function getInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_MIN_WIDTH;

  const storedValue = localStorage.getItem('sidebar-width');
  const parsed = storedValue ? Number(storedValue) : NaN;
  const width = clampSidebarWidth(Number.isFinite(parsed) ? parsed : SIDEBAR_MIN_WIDTH);

  if (storedValue !== String(width)) {
    localStorage.setItem('sidebar-width', String(width));
  }

  return width;
}

interface UIStore {
  navOpen: boolean;
  myProfileOpen: boolean;
  preferencesOpen: boolean;

  // Sidebar state
  sidebarCollapsed: boolean;
  sidebarWidth: number;

  // Current session info (for TopBar display)
  currentSessionTitle: string;
  currentSessionProfileId: string;
  currentSessionTags: Array<{ id: number; name: string; color: string }>;
  // Current chat session ID (synced from ChatPage for sidebar highlight)
  currentChatSessionId: string | null;
  // Share affordance synced from ChatPage so the TopBar can render the Share
  // button next to the session tags (null = not shareable / hidden).
  chatShare: { shareCount: number; onOpen: () => void } | null;
  // Version counter — incremented when a new session is created (triggers sidebar refresh)
  sessionListVersion: number;

  setNavOpen: (open: boolean) => void;
  setMyProfileOpen: (open: boolean) => void;
  setPreferencesOpen: (open: boolean) => void;
  closeAll: () => void;

  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setCurrentSessionInfo: (
    title: string,
    profileId: string,
    tags?: Array<{ id: number; name: string; color: string }>,
  ) => void;
  setCurrentChatSessionId: (id: string | null) => void;
  setChatShare: (v: { shareCount: number; onOpen: () => void } | null) => void;
  bumpSessionListVersion: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  navOpen: false,
  myProfileOpen: false,
  preferencesOpen: false,

  sidebarCollapsed: typeof window !== 'undefined' ? localStorage.getItem('sidebar-collapsed') === 'true' : false,
  sidebarWidth: getInitialSidebarWidth(),

  currentSessionTitle: '',
  currentSessionProfileId: 'default',
  currentSessionTags: [],
  currentChatSessionId: null,
  chatShare: null,
  sessionListVersion: 0,

  setNavOpen: (navOpen) => set({ navOpen }),
  setMyProfileOpen: (myProfileOpen) => set({ myProfileOpen }),
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
  closeAll: () => set({ navOpen: false, myProfileOpen: false, preferencesOpen: false }),

  setSidebarCollapsed: (sidebarCollapsed) => {
    localStorage.setItem('sidebar-collapsed', String(sidebarCollapsed));
    set({ sidebarCollapsed });
  },
  setSidebarWidth: (sidebarWidth) => {
    const clamped = clampSidebarWidth(sidebarWidth);
    localStorage.setItem('sidebar-width', String(clamped));
    set({ sidebarWidth: clamped });
  },
  setCurrentSessionInfo: (currentSessionTitle, currentSessionProfileId, currentSessionTags) =>
    set({ currentSessionTitle, currentSessionProfileId, currentSessionTags: currentSessionTags || [] }),
  setCurrentChatSessionId: (currentChatSessionId) => set({ currentChatSessionId }),
  setChatShare: (chatShare) => set({ chatShare }),
  bumpSessionListVersion: () => set((state) => ({ sessionListVersion: state.sessionListVersion + 1 })),
}));
