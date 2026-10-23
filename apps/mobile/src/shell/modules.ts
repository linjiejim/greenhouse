/**
 * The team hub's places, in drawer order. React-free (./modules.test.ts): the drawer, the
 * placeholders and the tests read the same list. `ready: false` places show "Coming soon" until
 * their phase lands (projects and tables come next).
 */

import type { TranslationKey } from '../lib/i18n';

export type ModuleId = 'home' | 'knowledge' | 'files' | 'projects' | 'tables';

export interface HubModule {
  id: ModuleId;
  /** The route the drawer opens (`/` is the drawer's own screen). */
  href: '/' | '/knowledge' | '/files' | '/module/projects' | '/module/tables';
  icon: 'bell' | 'book' | 'folder' | 'checkCircle' | 'table';
  title: TranslationKey;
  ready: boolean;
}

export const HUB_MODULES: readonly HubModule[] = [
  { id: 'home', href: '/', icon: 'bell', title: 'nav.home', ready: true },
  { id: 'knowledge', href: '/knowledge', icon: 'book', title: 'nav.knowledge', ready: true },
  { id: 'files', href: '/files', icon: 'folder', title: 'nav.files', ready: true },
  { id: 'projects', href: '/module/projects', icon: 'checkCircle', title: 'nav.projects', ready: false },
  { id: 'tables', href: '/module/tables', icon: 'table', title: 'nav.tables', ready: false },
];

/** A module id from a route param, or null when it is not one of ours. */
export function moduleOf(id: unknown): HubModule | null {
  return HUB_MODULES.find((module) => module.id === id && module.href.startsWith('/module/')) ?? null;
}
