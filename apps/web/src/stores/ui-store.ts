/**
 * UI Store (Zustand) — global UI state.
 *
 * Manages sidebar, navigation drawer, profile panel, preferences dialog etc.
 * Replaces prop-drilled useState from App → AppShell.
 */

import { create } from 'zustand';

const LEGACY_SIDEBAR_DEFAULT_WIDTHS = new Set([174, 200, 220]);
export const SIDEBAR_DEFAULT_WIDTH = 248;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 420;

export type ChatWorkspaceView = 'conversation' | 'automations';

/** The bell dialog's tabs. */
export type InboxTab = 'notifications' | 'shares' | 'activity';

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width));
}

function getInitialSidebarWidth(): number {
  if (typeof window === 'undefined') return SIDEBAR_DEFAULT_WIDTH;

  const storedValue = localStorage.getItem('sidebar-width');
  const parsed = storedValue ? Number(storedValue) : NaN;
  const storedWidth =
    Number.isFinite(parsed) && !LEGACY_SIDEBAR_DEFAULT_WIDTHS.has(parsed) ? parsed : SIDEBAR_DEFAULT_WIDTH;
  const width = clampSidebarWidth(storedWidth);

  if (storedValue !== String(width)) {
    localStorage.setItem('sidebar-width', String(width));
  }

  return width;
}

interface UIStore {
  navOpen: boolean;
  myProfileOpen: boolean;
  preferencesOpen: boolean;

  // Chat right-side workspace selected from the sidebar quick navigation.
  chatWorkspaceView: ChatWorkspaceView;

  // Sidebar state
  sidebarCollapsed: boolean;
  sidebarWidth: number;

  // Current session info (for TopBar display)
  currentSessionTitle: string;
  currentSessionProfileId: string;
  // Current chat session ID (synced from ChatPage for sidebar highlight)
  currentChatSessionId: string | null;
  // Share affordance synced from ChatPage so the TopBar can render the Share
  // button next to the session title (null = not shareable / hidden).
  chatShare: { shareCount: number; onOpen: () => void } | null;
  // The mounted full Chat pane owns session mutations; this callback lets the
  // global TopBar edit the title without creating a second session state.
  chatTitleEdit: { readonly: boolean; onRename: (title: string) => Promise<void> } | null;
  // The bell (inbox) dialog — one instance at the app root, opened from the
  // sidebar bell or Home's "waiting for you" line.
  inboxOpen: boolean;
  inboxTab: InboxTab;
  // Version counter — incremented when a new session is created (triggers sidebar refresh)
  sessionListVersion: number;

  // Active workspace (for Dashboard proxy requests)
  activeWorkspace: string;

  setNavOpen: (open: boolean) => void;
  setMyProfileOpen: (open: boolean) => void;
  setPreferencesOpen: (open: boolean) => void;
  setChatWorkspaceView: (view: ChatWorkspaceView) => void;
  closeAll: () => void;

  setSidebarCollapsed: (collapsed: boolean) => void;
  setSidebarWidth: (width: number) => void;
  setCurrentSessionInfo: (title: string, profileId: string) => void;
  setCurrentChatSessionId: (id: string | null) => void;
  setChatShare: (v: { shareCount: number; onOpen: () => void } | null) => void;
  setChatTitleEdit: (v: UIStore['chatTitleEdit']) => void;
  openInbox: (tab?: InboxTab) => void;
  closeInbox: () => void;
  setInboxTab: (tab: InboxTab) => void;
  bumpSessionListVersion: () => void;
  setActiveWorkspace: (ws: string) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  navOpen: false,
  myProfileOpen: false,
  preferencesOpen: false,
  chatWorkspaceView: 'conversation',

  sidebarCollapsed: typeof window !== 'undefined' ? localStorage.getItem('sidebar-collapsed') === 'true' : false,
  sidebarWidth: getInitialSidebarWidth(),

  currentSessionTitle: '',
  currentSessionProfileId: 'team',
  currentChatSessionId: null,
  chatShare: null,
  chatTitleEdit: null,
  inboxOpen: false,
  inboxTab: 'notifications',
  sessionListVersion: 0,

  activeWorkspace: typeof window !== 'undefined' ? localStorage.getItem('active-workspace') || '' : '',

  setNavOpen: (navOpen) => set({ navOpen }),
  setMyProfileOpen: (myProfileOpen) => set({ myProfileOpen }),
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
  setChatWorkspaceView: (chatWorkspaceView) => set({ chatWorkspaceView }),
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
  setCurrentSessionInfo: (currentSessionTitle, currentSessionProfileId) =>
    set({ currentSessionTitle, currentSessionProfileId }),
  setCurrentChatSessionId: (currentChatSessionId) => set({ currentChatSessionId }),
  setChatShare: (chatShare) => set({ chatShare }),
  setChatTitleEdit: (chatTitleEdit) => set({ chatTitleEdit }),
  openInbox: (tab) => set((state) => ({ inboxOpen: true, inboxTab: tab ?? state.inboxTab })),
  closeInbox: () => set({ inboxOpen: false }),
  setInboxTab: (inboxTab) => set({ inboxTab }),
  bumpSessionListVersion: () => set((state) => ({ sessionListVersion: state.sessionListVersion + 1 })),
  setActiveWorkspace: (activeWorkspace) => {
    localStorage.setItem('active-workspace', activeWorkspace);
    set({ activeWorkspace });
  },
}));
