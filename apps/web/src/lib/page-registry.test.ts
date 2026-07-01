/**
 * GUARD + BEHAVIOR TEST — the web app-shell fork extension points (S5 nav / S8).
 *
 * Upstream ships every registry EMPTY (no fork pages, settings sections, or
 * settings panels). The behavior tests prove a registered page routes and opts
 * into the main nav without editing app.tsx / app-sidebar.tsx.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { EXTRA_PAGES, getExtraPage, extraPageKeys, extraNavItems, type ExtraPage } from './page-registry';
import { EXTENSION_SETTINGS_SECTIONS } from './nav-registry.extensions';
import { EXTENSION_SETTINGS_PANELS } from '../pages/settings/panels.extensions';
import type { LucideIcon } from './icons';

const fakeIcon = (() => null) as unknown as LucideIcon;

afterEach(() => {
  EXTRA_PAGES.length = 0;
});

describe('web fork extension seams — empty upstream (OSS invariant)', () => {
  it('ships no fork pages / settings sections / settings panels', () => {
    expect(EXTRA_PAGES).toHaveLength(0);
    expect(extraPageKeys()).toEqual([]);
    expect(EXTENSION_SETTINGS_SECTIONS).toHaveLength(0);
    expect(EXTENSION_SETTINGS_PANELS).toHaveLength(0);
  });
});

describe('page-registry behavior', () => {
  it('a registered page routes and (opt-in) appears in the nav', () => {
    const page: ExtraPage = { key: 'crm', navLabel: 'CRM', navIcon: fakeIcon, showInNav: true, render: () => null };
    EXTRA_PAGES.push(page);
    expect(extraPageKeys()).toEqual(['crm']);
    expect(getExtraPage('crm')).toBe(page);

    const nav = extraNavItems({ isExternal: false, userRole: 'super' });
    expect(nav.map((n) => n.key)).toEqual(['crm']);
    expect(nav[0].visible).toBe(true);
    // Default navVisible hides the entry from external users.
    expect(extraNavItems({ isExternal: true, userRole: 'external' })[0].visible).toBe(false);
  });

  it('a page without showInNav routes but is not in the nav', () => {
    EXTRA_PAGES.push({ key: 'hidden', render: () => null });
    expect(getExtraPage('hidden')).toBeDefined();
    expect(extraNavItems({ isExternal: false, userRole: 'super' })).toHaveLength(0);
  });
});
