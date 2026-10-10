/**
 * `#/forms/:id` — the submit page of a Tables form. Mounted by app.tsx outside
 * the Tables application gate: the people a form is distributed to need not use
 * Tables (spec D5). The old `#/tables/form/:id` redirects here.
 */

import { useT } from '../../lib/i18n';
import { TablesFormPage } from './form-page';

export function TablesFormRoute({ subPath }: { subPath: string }) {
  const t = useT();
  const formId = Number(subPath.split('/').filter(Boolean)[0]);
  if (!Number.isInteger(formId) || formId <= 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-faint">
        {t('tables.home.invalidFormRoute')}
      </div>
    );
  }
  return <TablesFormPage formId={formId} />;
}
