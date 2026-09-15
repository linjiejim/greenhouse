/**
 * Hot-updatable display policy for selections captured outside Greenhouse.
 *
 * Native code observes the OS and reports coordinates. Only this web layer decides
 * whether that should become UI; native code is called again solely to position the
 * always-on-top satellite window.
 */

import { invokeDesktop, onDesktopEvent } from './bridge';
import { DESKTOP_EVENT, type Selection } from './types';

export async function presentCapturedSelection(selection: Selection): Promise<void> {
  if (selection.x == null || selection.y == null) return;
  // Greenhouse assistant messages already have their own quote popover. Suppress
  // the global bar while our main window is focused so the two never stack.
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  if (await getCurrentWindow().isFocused()) return;
  await invokeDesktop('desktop_show_selection_bar', { x: selection.x, y: selection.y });
}

export function initSelectionPolicy(): Promise<() => void> {
  return onDesktopEvent<Selection>(DESKTOP_EVENT.selection, (selection) => {
    void presentCapturedSelection(selection).catch((err) => {
      console.error('[desktop] could not present the selection bar', err);
    });
  });
}
