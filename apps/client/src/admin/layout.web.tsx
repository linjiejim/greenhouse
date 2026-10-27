/**
 * The Admin place (super only, wide windows): the section list in the shell's secondary column,
 * the chosen section in the main column. Core sections are fixed (./sections.ts); plugin sections
 * come from the station manifest and render through the plugin-owned admin screens
 * (src/plugins/admin-screens.web.ts) or the shared settings form.
 */
import React, { useMemo, useState } from 'react';
import { Slot, usePathname, useRouter } from 'expo-router';
import { useWindowDimensions } from 'react-native';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { Place, PlaceEmpty, PlaceRow, PlaceSidebar } from '../ui/place.web';
import { useAuth } from '../store/auth';
import { usePrefs } from '../store/prefs';
import { useStationManifest } from '../plugins/store';
import { localize } from '../shared/plugins';
import { useT, type TranslationKey } from '../lib/i18n';
import { adminScreenIcons } from '../plugins/admin-screens.web';
import { CORE_SECTIONS, SECTION_GROUPS, activeSection, pluginSections } from './sections';
import './admin.css';
import { WIDE_MIN } from '../shell/wide-model';

export function useAdminSections() {
  const manifest = useStationManifest((s) => s.data);
  return useMemo(() => pluginSections(manifest, adminScreenIcons), [manifest]);
}

export default function AdminLayout() {
  const t = useT();
  const user = useAuth((s) => s.user);
  const { width } = useWindowDimensions();
  if (user?.role !== 'super')
    return (
      <Place title={t('admin.title')}>
        <PlaceEmpty icon="shieldCheck" title={t('admin.superOnly')} message={t('admin.superOnlyHint')} />
      </Place>
    );
  if (width < WIDE_MIN)
    return (
      <Place title={t('admin.title')}>
        <PlaceEmpty icon="shieldCheck" title={t('admin.wideOnly')} message={t('admin.wideOnlyHint')} />
      </Place>
    );
  return (
    <>
      <PlaceSecondary>
        <AdminSidebar />
      </PlaceSecondary>
      <Slot />
    </>
  );
}

function AdminSidebar() {
  const t = useT();
  const router = useRouter();
  const path = usePathname();
  const lang = usePrefs((s) => s.lang);
  const plugins = useAdminSections();
  const [query, setQuery] = useState('');
  const active = activeSection(path);
  const needle = query.trim().toLowerCase();
  const match = (label: string) => !needle || label.toLowerCase().includes(needle);
  const groups = [
    ...SECTION_GROUPS.map((group) => ({
      group,
      rows: CORE_SECTIONS.filter((s) => s.group === group).map((s) => ({
        key: s.id,
        title: t(`admin.sections.${s.id}` as TranslationKey),
        icon: s.icon,
        href: `/admin/${s.id}`,
        selected: !!active && 'core' in active && active.core === s.id,
      })),
    })),
    {
      group: 'plugins' as const,
      rows: plugins.map((s) => ({
        key: `${s.plugin}/${s.page}`,
        title: localize(s.title, lang),
        icon: s.icon,
        href: s.href,
        selected: !!active && 'plugin' in active && active.plugin === s.plugin && active.page === s.page,
      })),
    },
  ]
    .map((g) => ({ ...g, rows: g.rows.filter((row) => match(row.title)) }))
    .filter((g) => g.rows.length);
  return (
    <PlaceSidebar title={t('admin.title')} query={query} onQuery={setQuery}>
      <nav data-place-list aria-label={t('admin.title')} data-testid="admin-sections">
        {groups.map((g) => (
          <React.Fragment key={g.group}>
            <h3>{t(`admin.groups.${g.group}` as TranslationKey)}</h3>
            {g.rows.map((row) => (
              <PlaceRow
                key={row.key}
                title={row.title}
                icon={row.icon}
                selected={row.selected}
                onOpen={() => router.navigate(row.href as never)}
              />
            ))}
          </React.Fragment>
        ))}
        {!groups.length ? <PlaceEmpty /> : null}
      </nav>
    </PlaceSidebar>
  );
}
