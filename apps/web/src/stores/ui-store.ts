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

export type ChatWorkspaceView = 'conversation' | 'automations' | 'prompts' | 'agents';

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
  desktopPreferencesOpen: boolean;

  // Chat right-side workspace selected from the sidebar quick navigation.
  chatWorkspaceView: ChatWorkspaceView;

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
  // Session-level response feedback belongs with the other conversation
  // actions in the TopBar, not in the composer chrome.
  chatFeedback: {
    sessionId: string;
    initialRating: number | null;
    initialComment: string | null;
    readonly: boolean;
  } | null;
  // The mounted full Chat pane owns session mutations; this callback lets the
  // global TopBar edit the title without creating a second session state.
  chatTitleEdit: { readonly: boolean; onRename: (title: string) => Promise<void> } | null;
  // Home workbench controls, registered by the panel while it is on screen so
  // the TopBar can host Customize next to the session title. Null means
  // no workbench is mounted — which is also how the TopBar knows not to draw
  // them (rather than re-deriving "is this an empty new conversation").
  homeWorkbench: { editing: boolean; onToggleEdit: () => void } | null;
  // Version counter — incremented when a new session is created (triggers sidebar refresh)
  sessionListVersion: number;

  // Active workspace (for Dashboard proxy requests)
  activeWorkspace: string;

  setNavOpen: (open: boolean) => void;
  setMyProfileOpen: (open: boolean) => void;
  setPreferencesOpen: (open: boolean) => void;
  setChatWorkspaceView: (view: ChatWorkspaceView) => void;
  setDesktopPreferencesOpen: (open: boolean) => void;
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
  setChatFeedback: (v: UIStore['chatFeedback']) => void;
  setChatTitleEdit: (v: UIStore['chatTitleEdit']) => void;
  setHomeWorkbench: (v: { editing: boolean; onToggleEdit: () => void } | null) => void;
  bumpSessionListVersion: () => void;
  setActiveWorkspace: (ws: string) => void;
}

export const useUIStore = create<UIStore>((set) => ({
  navOpen: false,
  myProfileOpen: false,
  preferencesOpen: false,
  chatWorkspaceView: 'conversation',
  desktopPreferencesOpen: false,

  sidebarCollapsed: typeof window !== 'undefined' ? localStorage.getItem('sidebar-collapsed') === 'true' : false,
  sidebarWidth: getInitialSidebarWidth(),

  currentSessionTitle: '',
  currentSessionProfileId: 'team',
  currentSessionTags: [],
  currentChatSessionId: null,
  chatShare: null,
  chatFeedback: null,
  chatTitleEdit: null,
  homeWorkbench: null,
  sessionListVersion: 0,

  activeWorkspace: typeof window !== 'undefined' ? localStorage.getItem('active-workspace') || '' : '',

  setNavOpen: (navOpen) => set({ navOpen }),
  setMyProfileOpen: (myProfileOpen) => set({ myProfileOpen }),
  setPreferencesOpen: (preferencesOpen) => set({ preferencesOpen }),
  setChatWorkspaceView: (chatWorkspaceView) => set({ chatWorkspaceView }),
  setDesktopPreferencesOpen: (desktopPreferencesOpen) => set({ desktopPreferencesOpen }),
  closeAll: () => set({ navOpen: false, myProfileOpen: false, preferencesOpen: false, desktopPreferencesOpen: false }),

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
  setChatFeedback: (chatFeedback) => set({ chatFeedback }),
  setChatTitleEdit: (chatTitleEdit) => set({ chatTitleEdit }),
  setHomeWorkbench: (homeWorkbench) => set({ homeWorkbench }),
  bumpSessionListVersion: () => set((state) => ({ sessionListVersion: state.sessionListVersion + 1 })),
  setActiveWorkspace: (activeWorkspace) => {
    localStorage.setItem('active-workspace', activeWorkspace);
    set({ activeWorkspace });
  },
}));
