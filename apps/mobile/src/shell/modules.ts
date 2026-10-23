/**
 * The team hub's places, in drawer order. React-free (./modules.test.ts): the drawer and the tests
 * read the same list. Tables shows only to members with the `tables` feature (supers always have
 * it), as the server's `requireFeature('tables')` decides.
 */

import type { TranslationKey } from '../lib/i18n';

export type ModuleId = 'home' | 'knowledge' | 'files' | 'projects' | 'tables' | 'agent' | 'assistant';

export interface HubModule {
  id: ModuleId;
  /** The route the drawer opens (`/` is the drawer's own screen). */
  href: '/' | '/knowledge' | '/files' | '/projects' | '/tables' | '/agent' | '/assistant';
  icon: 'bell' | 'book' | 'folder' | 'checkCircle' | 'table' | 'sparkle' | 'msgs';
  title: TranslationKey;
}

export const HUB_MODULES: readonly HubModule[] = [
  { id: 'home', href: '/', icon: 'bell', title: 'nav.home' },
  { id: 'knowledge', href: '/knowledge', icon: 'book', title: 'nav.knowledge' },
  { id: 'files', href: '/files', icon: 'folder', title: 'nav.files' },
  { id: 'projects', href: '/projects', icon: 'checkCircle', title: 'nav.projects' },
  { id: 'tables', href: '/tables', icon: 'table', title: 'nav.tables' },
  { id: 'agent', href: '/agent', icon: 'sparkle', title: 'nav.agent' },
  { id: 'assistant', href: '/assistant', icon: 'msgs', title: 'nav.assistant' },
];

/** Whether the member may use Tables (the server's feature gate; supers always pass). */
export function hasTables(user: { role: string; features?: Record<string, boolean> } | null | undefined): boolean {
  return !!user && (user.role === 'super' || user.features?.tables === true);
}

/** The places this member sees. */
export function visibleModules(user: { role: string; features?: Record<string, boolean> } | null | undefined): HubModule[] {
  return HUB_MODULES.filter((module) => module.id !== 'tables' || hasTables(user));
}
