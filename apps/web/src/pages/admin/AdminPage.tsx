import type { AdminSection } from '../../lib/router';
import { useI18n } from '../../lib/i18n';
import { ADMIN } from '../../shell/Directory';
import { Page, PageHeader } from '../../shell/Page';
import { NotFoundPage } from '../NotFoundPage';
import { BrandingSection } from './BrandingSection';
import { MembersSection } from './MembersSection';
import { PublicAgentsSection } from './PublicAgentsSection';
import { ServicesSection } from './ServicesSection';
import { UsageSection } from './UsageSection';

/** 管理 (PRD §6.3): the sections this build has. */
export function AdminPage({ section }: { section: AdminSection }) {
  const { t } = useI18n();
  if (!ADMIN.some((item) => item.id === section)) return <NotFoundPage />;
  return (
    <Page
      width={section === 'members' || section === 'usage' || section === 'public-agents' ? 'list' : 'form'}
      header={
        <PageHeader title={t(`admin.${section}`)} help={section === 'services' ? t('provider.help') : undefined} />
      }
    >
      {section === 'members' && <MembersSection />}
      {section === 'services' && <ServicesSection />}
      {section === 'usage' && <UsageSection />}
      {section === 'public-agents' && <PublicAgentsSection />}
      {section === 'branding' && <BrandingSection />}
    </Page>
  );
}
