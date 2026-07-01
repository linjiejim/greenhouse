/**
 * Fork extension point for settings panels — the ONLY settings file a downstream
 * fork edits to mount a private settings panel component.
 *
 * Upstream ships this EMPTY. `settings/index.tsx` consults findSettingsPanel()
 * after its core panel switch, so a fork's panel renders for its module key
 * WITHOUT editing settings/index.tsx. Pair with the nav seam
 * (nav-registry.extensions.ts) so the module also gets a sidebar entry + route.
 *
 * Fork example (in the fork's copy of this file):
 *   import { CrmPanel } from './crm';
 *   export const EXTENSION_SETTINGS_PANELS: SettingsPanel[] = [
 *     { key: 'crm', render: () => <CrmPanel /> },
 *   ];
 */

import type { ReactNode } from 'react';

export interface SettingsPanel {
  /** Settings module key — the last segment of the NavModule id/path, e.g. 'crm'. */
  key: string;
  render: () => ReactNode;
}

/** Private settings panels contributed by a downstream fork. Empty upstream. */
export const EXTENSION_SETTINGS_PANELS: SettingsPanel[] = [];

export function findSettingsPanel(key: string): SettingsPanel | undefined {
  return EXTENSION_SETTINGS_PANELS.find((p) => p.key === key);
}
