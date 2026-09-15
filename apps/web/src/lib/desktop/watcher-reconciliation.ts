import type { DesktopCapabilities, DesktopSettings } from './types';

/** True when desired/configured state says on but the native watcher is not alive. */
export function shouldReconcileSelectionWatcher(
  settings: Pick<DesktopSettings, 'selectionWatch'>,
  capabilities: Pick<DesktopCapabilities, 'selection' | 'selectionWatch'>,
  pendingEnable: boolean,
): boolean {
  return (
    (settings.selectionWatch || pendingEnable) &&
    capabilities.selection.state === 'available' &&
    !capabilities.selectionWatch
  );
}
