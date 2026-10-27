/**
 * The member's places and apps on this station, in rail order — one list for the wide rail, the
 * ⌘K palette's "go to" commands and the desktop Go menu. Core places come first (gated by the
 * station manifest); apps are plugin entries, primary placements first, under a divider.
 */
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStationManifest } from '../plugins/store';
import { pluginNavigation } from '../plugins/manifest';
import { nativeVisible, pluginHref } from '../plugins/navigation';
import { pluginIcon } from '../plugins/icons';
import { localize } from '../shared/plugins';
import type { IconName } from '../ui/core';
import { hasTables } from './modules';

export interface PlaceEntry {
  id: string;
  label: string;
  /** A shorter label for the 72-wide rail. */
  rail?: string;
  icon: IconName;
  href: string;
}

const OFFICIAL_PLACES = ['knowledge', 'tables', 'projects'];

export function usePlaces(): { places: PlaceEntry[]; apps: (PlaceEntry & { navId: string })[] } {
  const t = useT();
  const user = useAuth((s) => s.user);
  const lang = usePrefs((s) => s.lang);
  const manifest = useStationManifest((s) => s.data);
  const places: PlaceEntry[] = [
    { id: 'chat', label: t('client.conversations'), rail: t('client.railChat'), icon: 'msg', href: '/' },
    ...(nativeVisible(manifest, 'knowledge')
      ? [{ id: 'knowledge', label: t('nav.knowledge'), icon: 'book' as const, href: '/knowledge' }]
      : []),
    { id: 'drive', label: t('nav.files'), icon: 'folder', href: '/drive' },
    ...(nativeVisible(manifest, 'tables', hasTables(user))
      ? [{ id: 'tables', label: t('nav.tables'), icon: 'table' as const, href: '/drive?view=tables' }]
      : []),
    ...(nativeVisible(manifest, 'projects')
      ? [{ id: 'projects', label: t('nav.projects'), icon: 'checklist' as const, href: '/projects' }]
      : []),
    {
      id: 'automations',
      label: t('nav.automations'),
      rail: t('client.railAutomations'),
      icon: 'clock',
      href: '/automations',
    },
  ];
  const apps = [
    ...pluginNavigation(manifest, 'primary').filter(
      (n) => !OFFICIAL_PLACES.includes(n.page.kind === 'native' ? n.page.screen : ''),
    ),
    ...pluginNavigation(manifest, 'more'),
  ].map((n) => ({
    id: `${n.plugin.id}/${n.page.id}`,
    navId: n.nav.id,
    label: localize(n.nav.label, lang),
    icon: pluginIcon(n.nav, n.page),
    href: pluginHref(n.plugin.id, n.page),
  }));
  return { places, apps };
}
