/**
 * Official plugin Admin sections (browser). Each plugin folder owns its screen
 * (`src/plugins/<id>/admin.web.tsx`, keyed by the manifest page's `screen`); this file only
 * indexes them. The Admin place lists a section only when the station manifest declares it.
 */
import type { IconName } from '../ui/core';
import type { AdminScreenEntry } from './admin-types';
import { adminScreen as feedback } from './feedback/admin.web';
import { adminScreen as retro } from './retro/admin.web';
import { adminScreen as computer } from './computer/admin.web';

const entries: AdminScreenEntry[] = [feedback, retro, computer];

export const adminScreens: Readonly<Record<string, AdminScreenEntry>> = Object.fromEntries(
  entries.map((entry) => [entry.screen, entry]),
);
export const adminScreenIcons: Readonly<Record<string, IconName>> = Object.fromEntries(
  entries.map((entry) => [entry.screen, entry.icon]),
);
