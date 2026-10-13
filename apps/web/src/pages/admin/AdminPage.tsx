import type { AdminSection } from '../../lib/router';
import { useT } from '../../lib/i18n';
import { Page, PageHeader } from '../../shell/Page';

/** Admin sections (M1.5). */
export function AdminPage({ section }: { section: AdminSection }) {
  const t = useT();
  return (
    <Page width="form" header={<PageHeader title={t(`admin.${section}`)} />}>
      {null}
    </Page>
  );
}
