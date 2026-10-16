import { OperationsSection } from './OperationsSection';
import type { MessageKey } from '../../i18n/zh';
import type { AdminSection } from '../../lib/router';
import { useI18n } from '../../lib/i18n';
import { ADMIN } from '../../shell/Directory';
import { Page, PageHeader } from '../../shell/Page';
import { NotFoundPage } from '../NotFoundPage';
import { BrandingSection } from './BrandingSection';
import { ClientsSection } from './ClientsSection';
import { ConnectorsSection } from './ConnectorsSection';
import { MembersSection } from './MembersSection';
import { PublicAgentsSection } from './PublicAgentsSection';
import { ServicesSection } from './ServicesSection';
import { UsageSection } from './UsageSection';

const HELP: Partial<Record<AdminSection, MessageKey>> = {
  services: 'provider.help',
  connectors: 'connectors.help',
  access: 'clients.help',
};
const LIST: AdminSection[] = ['members', 'usage', 'connectors', 'access', 'public-agents'];

/** 管理 (PRD §6.3): the sections this build has. */
export function AdminPage({ section }: { section: AdminSection }) {
  const { t } = useI18n();
  if (!ADMIN.some((item) => item.id === section)) return <NotFoundPage />;
  const help = HELP[section];
  return (
    <Page
      width={LIST.includes(section) ? 'list' : 'form'}
      header={<PageHeader title={t(`admin.${section}`)} help={help && t(help)} />}
    >
      {section === 'operations' && <OperationsSection />}
      {section === 'members' && <MembersSection />}
      {section === 'services' && <ServicesSection />}
      {section === 'usage' && <UsageSection />}
      {section === 'connectors' && <ConnectorsSection />}
      {section === 'access' && <ClientsSection />}
      {section === 'public-agents' && <PublicAgentsSection />}
      {section === 'branding' && <BrandingSection />}
    </Page>
  );
}
