/**
 * Official plugin Admin sections (browser). Each plugin folder owns its screen
 * (`src/plugins/<id>/admin.web.tsx`, keyed by the manifest page's `screen`); this file only
 * indexes them. The Admin place lists a section only when the station manifest declares it.
 */
import type { IconName } from '../ui/core';
import type { AdminScreenEntry } from './admin-types';

const entries: AdminScreenEntry[] = [];

export const adminScreens: Readonly<Record<string, AdminScreenEntry>> = Object.fromEntries(
  entries.map((entry) => [entry.screen, entry]),
);
export const adminScreenIcons: Readonly<Record<string, IconName>> = Object.fromEntries(
  entries.map((entry) => [entry.screen, entry.icon]),
);
