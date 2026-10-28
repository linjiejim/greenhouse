/** `/admin` and `/admin/<section>`: a core section. */
import React, { Suspense, lazy } from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useStationManifest } from '../plugins/store';
import { useT, type TranslationKey } from '../lib/i18n';
import { AdminPage, SectionState } from './kit.web';
import { DEFAULT_SECTION, isCoreSection, type CoreSectionId } from './sections';

// Each section is its own chunk in the hosted browser export, fetched when it is opened.
const SECTIONS: Record<CoreSectionId, React.LazyExoticComponent<React.ComponentType>> = {
  users: lazy(() => import('./users.web')),
  services: lazy(() => import('./services.web')),
  usage: lazy(() => import('./usage.web')),
  plugins: lazy(() => import('./plugins.web')),
  'runtime-config': lazy(() => import('./runtime-config.web')),
  'mcp-keys': lazy(() => import('./mcp-keys.web')),
  connectors: lazy(() => import('./connectors.web')),
  activity: lazy(() => import('./activity.web')),
  'team-context': lazy(() => import('./team-context.web')),
  branding: lazy(() => import('./branding.web')),
};

export default function AdminSectionScreen() {
  const t = useT();
  const { section = DEFAULT_SECTION } = useLocalSearchParams<{ section?: string }>();
  const status = useStationManifest((s) => s.status);
  if (isCoreSection(section)) {
    const Section = SECTIONS[section];
    return (
      <Suspense
        fallback={
          <AdminPage title={t(`admin.sections.${section}` as TranslationKey)}>
            <SectionState loading />
          </AdminPage>
        }
      >
        <Section key={section} />
      </Suspense>
    );
  }
  return (
    <AdminPage title={t('admin.title')}>
      <SectionState
        loading={status === 'loading' || status === 'idle'}
        icon="shieldCheck"
        title={t('admin.missing')}
        message={t('admin.missingHint')}
      />
    </AdminPage>
  );
}
