import { createContext, useContext } from 'react';

export interface ShellState {
  /** Below 768: one column, the directory is a drawer and details open as sheets. */
  narrow: boolean;
  /** The directory is not on screen (collapsed, or a drawer that is closed). */
  directoryHidden: boolean;
  openDirectory(): void;
  openPalette(): void;
}

export const ShellContext = createContext<ShellState>({
  narrow: false,
  directoryHidden: false,
  openDirectory: () => undefined,
  openPalette: () => undefined,
});

export const useShell = () => useContext(ShellContext);
