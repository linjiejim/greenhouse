import type { MessageKey } from '../../i18n/zh';
import type { SettingsSection } from '../../lib/router';
import { useI18n } from '../../lib/i18n';
import { SETTINGS } from '../../shell/Directory';
import { Page, PageHeader } from '../../shell/Page';
import { NotFoundPage } from '../NotFoundPage';
import { AccessSection } from './AccessSection';
import { AccountSection } from './AccountSection';
import { ConnectionsSection } from './ConnectionsSection';
import { DesktopSection } from './DesktopSection';
import { MyServicesSection } from './MyServicesSection';
import { NotificationsSection } from './NotificationsSection';
import { VaultSection } from './VaultSection';

const HELP: Partial<Record<SettingsSection, MessageKey>> = {
  services: 'myServices.help',
  connections: 'connections.help',
  access: 'access.help',
};

/** 设置 (PRD §6.3): the sections this build has. */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const { t } = useI18n();
  if (!SETTINGS.some((item) => item.id === section)) return <NotFoundPage />;
  const help = HELP[section];
  return (
    <Page width="form" header={<PageHeader title={t(`settings.${section}`)} help={help && t(help)} />}>
      {section === 'account' && <AccountSection />}
      {section === 'connections' && <ConnectionsSection />}
      {section === 'services' && <MyServicesSection />}
      {section === 'notifications' && <NotificationsSection />}
      {section === 'vault' && <VaultSection />}
      {section === 'access' && <AccessSection />}
      {section === 'desktop' && <DesktopSection />}
    </Page>
  );
}
