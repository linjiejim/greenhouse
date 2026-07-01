/**
 * Fork extension point for settings navigation — the ONLY nav file a downstream
 * fork edits to add private settings sections/modules.
 *
 * Upstream ships this EMPTY. `nav-registry.ts` splices EXTENSION_SETTINGS_SECTIONS
 * into `settingsSections`, and everything derives from that (SETTINGS_ALL,
 * ALL_MODULES, MODULE_MAP, the query functions, `settingsAllModules`), so a fork
 * settings module appears in the sidebar nav + TopBar breadcrumb + settings
 * routing WITHOUT editing nav-registry.ts. Pair with the settings-panel seam
 * (settings/panels.extensions.tsx) to also mount the panel component.
 *
 * Fork example (in the fork's copy of this file):
 *   import { Users } from './icons';
 *   export const EXTENSION_SETTINGS_SECTIONS: SettingsNavSection[] = [
 *     { key: 'crm', label: 'CRM', requireRole: ['super'], items: [
 *       { id: 'settings.crm', label: 'CRM Sync', icon: Users, path: '#/settings/crm',
 *         parent: 'settings', implemented: true },
 *     ] },
 *   ];
 */

import type { SettingsNavSection } from './nav-registry';

/** Private settings sections contributed by a downstream fork. Empty upstream. */
export const EXTENSION_SETTINGS_SECTIONS: SettingsNavSection[] = [];
