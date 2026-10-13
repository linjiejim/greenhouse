import type { SettingsSection } from '../../lib/router';
import { useT } from '../../lib/i18n';
import { Page, PageHeader } from '../../shell/Page';

/** Settings sections (M1.5). */
export function SettingsPage({ section }: { section: SettingsSection }) {
  const t = useT();
  return (
    <Page width="form" header={<PageHeader title={t(`settings.${section}`)} />}>
      {null}
    </Page>
  );
}
