/** `/admin` and `/admin/<section>`: a core section. */
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { useStationManifest } from '../plugins/store';
import { useT } from '../lib/i18n';
import { AdminPage, SectionState } from './kit.web';
import { DEFAULT_SECTION, isCoreSection, type CoreSectionId } from './sections';
import UsersSection from './users.web';
import ServicesSection from './services.web';
import UsageSection from './usage.web';
import PluginsSection from './plugins.web';
import RuntimeConfigSection from './runtime-config.web';
import McpKeysSection from './mcp-keys.web';
import ConnectorsSection from './connectors.web';
import ActivitySection from './activity.web';
import TeamContextSection from './team-context.web';
import BrandingSection from './branding.web';

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
  const { section = DEFAULT_SECTION } = useLocalSearchParams<{ section?: string }>();
  const status = useStationManifest((s) => s.status);
  if (isCoreSection(section)) {
    const Section = SECTIONS[section];
    return <Section key={section} />;
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
