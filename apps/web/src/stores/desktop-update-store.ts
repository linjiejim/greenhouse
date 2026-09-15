import { create } from 'zustand';
import type { WebReleaseNotes } from '../lib/desktop/types';

export interface PendingDesktopUpdate {
  version: string;
  releaseNotes: WebReleaseNotes | null;
}

interface DesktopUpdateStore {
  checking: boolean;
  pending: PendingDesktopUpdate | null;
  currentReleaseNotes: WebReleaseNotes | null;
  releaseNotesHistory: WebReleaseNotes[];
  requiredShellVersion: string | null;
  /**
   * A newer shell has already been downloaded in the background and installs on
   * the next restart — the app-line twin of `pending`.
   */
  shellReadyVersion: string | null;
  /** An in-app shell download/install is running (survives sidebar collapse). */
  shellInstalling: boolean;
  releaseNotesOpen: boolean;
  setChecking: (checking: boolean) => void;
  setPending: (pending: PendingDesktopUpdate | null) => void;
  setCurrentReleaseNotes: (notes: WebReleaseNotes | null) => void;
  setReleaseNotesHistory: (notes: WebReleaseNotes[]) => void;
  setRequiredShellVersion: (version: string | null) => void;
  setShellReadyVersion: (version: string | null) => void;
  setShellInstalling: (installing: boolean) => void;
  setReleaseNotesOpen: (open: boolean) => void;
}

export const useDesktopUpdateStore = create<DesktopUpdateStore>((set) => ({
  checking: false,
  pending: null,
  currentReleaseNotes: null,
  releaseNotesHistory: [],
  requiredShellVersion: null,
  shellReadyVersion: null,
  shellInstalling: false,
  releaseNotesOpen: false,
  setChecking: (checking) => set({ checking }),
  setPending: (pending) => set({ pending }),
  setCurrentReleaseNotes: (currentReleaseNotes) => set({ currentReleaseNotes }),
  setReleaseNotesHistory: (releaseNotesHistory) => set({ releaseNotesHistory }),
  setRequiredShellVersion: (requiredShellVersion) => set({ requiredShellVersion }),
  setShellReadyVersion: (shellReadyVersion) => set({ shellReadyVersion }),
  setShellInstalling: (shellInstalling) => set({ shellInstalling }),
  setReleaseNotesOpen: (releaseNotesOpen) => set({ releaseNotesOpen }),
}));
