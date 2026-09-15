/**
 * What the global shortcuts actually do.
 *
 * The shell only registers key combinations and emits an event; every behaviour
 * below lives in the web layer, so it ships through hot updates. Changing what
 * ⌘⇧2 does is a web change, not a new app release.
 */

import { publishAttachment } from './attach';
import { invokeDesktop, isDesktop, isMainWindow, onDesktopEvent } from './bridge';
import { captureToFile } from './capture';
import { handOffToMain } from './handoff';
import { DESKTOP_EVENT, type ShortcutId } from './types';
import { getStoredLocale, translate } from '../i18n';

async function handleScreenshot(): Promise<void> {
  const file = await captureToFile('interactive');
  if (!file) return; // cancelled
  // Focus first: the user was dragging over another app, and the composer they're
  // about to type into is behind it.
  await invokeDesktop('desktop_focus_main_window');
  publishAttachment({ files: [file], draft: translate(getStoredLocale(), 'contextActions.screenshotPrompt') });
}

async function handleSelection(): Promise<void> {
  const selection = await invokeDesktop('desktop_read_selection');
  if (!selection?.text) return;
  await handOffToMain({ draft: selection.text });
}

export async function handleShortcut(id: ShortcutId): Promise<void> {
  switch (id) {
    case 'focus_main':
      await invokeDesktop('desktop_focus_main_window');
      break;
    case 'quick_capture':
      await invokeDesktop('desktop_toggle_quick_window');
      break;
    case 'screenshot':
      await handleScreenshot();
      break;
    case 'selection':
      await handleSelection();
      break;
  }
}

/** Wire up shortcut handling for this window. Returns an unsubscribe function. */
export async function initShortcuts(): Promise<() => void> {
  if (!isDesktop()) return () => {};

  return onDesktopEvent<{ id: ShortcutId }>(DESKTOP_EVENT.shortcut, (payload) => {
    void (async () => {
      if (!(await isMainWindow())) return;
      try {
        await handleShortcut(payload.id);
      } catch (err) {
        // A shortcut is fire-and-forget; there's no call site to surface this to.
        console.error(`[desktop] shortcut ${payload.id} failed`, err);
      }
    })();
  });
}
