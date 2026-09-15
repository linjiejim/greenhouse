/**
 * Native menu → hot-updatable Preferences dialog bridge.
 *
 * The shell only knows that the user selected Preferences. The web bundle owns the
 * dialog and its contents, so adding or rearranging options never needs a new shell.
 */

import { useUIStore } from '../../stores/ui-store';
import { onDesktopEvent } from './bridge';
import { DESKTOP_EVENT } from './types';

export function listenForDesktopPreferences(): Promise<() => void> {
  return onDesktopEvent<void>(DESKTOP_EVENT.openPreferences, () => {
    useUIStore.getState().setDesktopPreferencesOpen(true);
  });
}
