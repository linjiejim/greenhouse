/** `/admin` and `/admin/<section>`: a core section, or a classic key a plugin section took over. */
import React from 'react';
import { Redirect, useLocalSearchParams } from 'expo-router';
import { useStationManifest } from '../plugins/store';
import { useT } from '../lib/i18n';
import { AdminPage, SectionState } from './kit.web';
import { DEFAULT_SECTION, isCoreSection, sectionForLegacyKey, type CoreSectionId } from './sections';
import { useAdminSections } from './layout.web';
import UsersSection from './users.web';
import ServicesSection from './stub.web';
import UsageSection from './stub.web';
import PluginsSection from './stub.web';
import RuntimeConfigSection from './stub.web';
import McpKeysSection from './stub.web';
import ConnectorsSection from './stub.web';
import ActivitySection from './stub.web';
import TeamContextSection from './stub.web';
import BrandingSection from './stub.web';

const SECTIONS: Record<CoreSectionId, React.ComponentType> = {
  users: UsersSection,
  services: ServicesSection,
  usage: UsageSection,
  plugins: PluginsSection,
  'runtime-config': RuntimeConfigSection,
  'mcp-keys': McpKeysSection,
  connectors: ConnectorsSection,
  activity: ActivitySection,
  'team-context': TeamContextSection,
  branding: BrandingSection,
};

export default function AdminSectionScreen() {
  const t = useT();
  const { section = DEFAULT_SECTION, view } = useLocalSearchParams<{ section?: string; view?: string }>();
  const plugins = useAdminSections();
  const status = useStationManifest((s) => s.status);
  if (isCoreSection(section)) {
    const Section = SECTIONS[section];
    return <Section key={section} />;
  }
  const taken = sectionForLegacyKey(section, plugins);
  if (taken) return <Redirect href={(view ? `${taken.href}?view=${encodeURIComponent(view)}` : taken.href) as never} />;
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
