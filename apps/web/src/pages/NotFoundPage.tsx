import { Compass } from 'lucide-react';
import { Button, Empty } from '@greenhouse/ui/kit';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { Page, PageHeader } from '../shell/Page';

export function NotFoundPage() {
  const t = useT();
  return (
    <Page header={<PageHeader title={t('common.notFound')} />}>
      <Empty
        icon={<Compass />}
        title={t('common.notFound')}
        action={<Button onClick={() => navigate('#/c/main')}>{t('common.backHome')}</Button>}
      />
    </Page>
  );
}
