import type { SettingsSection } from '../../lib/router';
import { useI18n } from '../../lib/i18n';
import { SETTINGS } from '../../shell/Directory';
import { Page, PageHeader } from '../../shell/Page';
import { NotFoundPage } from '../NotFoundPage';
import { AccountSection } from './AccountSection';
import { MyServicesSection } from './MyServicesSection';
import { VaultSection } from './VaultSection';

/** 设置 (PRD §6.3): the sections this build has. */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const { t } = useI18n();
  if (!SETTINGS.some((item) => item.id === section)) return <NotFoundPage />;
  return (
    <Page
      width="form"
      header={
        <PageHeader title={t(`settings.${section}`)} help={section === 'services' ? t('myServices.help') : undefined} />
      }
    >
      {section === 'account' && <AccountSection />}
      {section === 'services' && <MyServicesSection />}
      {section === 'vault' && <VaultSection />}
    </Page>
  );
}
