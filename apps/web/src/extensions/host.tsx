import { useQuery } from '@tanstack/react-query';
import { ErrorBox, Skeleton } from '@greenhouse/ui/kit';
import { useMe } from '../app/session';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import type { Route } from '../lib/router';
import { Page, PageHeader } from '../shell/Page';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { NotFoundPage } from '../pages/NotFoundPage';
import { WEB_EXTENSIONS } from './registry';

export function useExtensions() {
  const query = useQuery({ queryKey: ['extensions'], queryFn: () => api.extensions(), staleTime: Infinity });
  return {
    ...query,
    items: WEB_EXTENSIONS.filter((extension) => query.data?.items.some((info) => info.id === extension.id)).map(
      (extension) => ({ ...extension, info: query.data!.items.find((info) => info.id === extension.id)! }),
    ),
  };
}

export function ExtensionPage({ route }: { route: Extract<Route, { page: 'extension' | 'extension-section' }> }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const extensions = useExtensions();
  if (extensions.isPending) return <Skeleton lines={3} />;
  if (extensions.isError) return <ErrorBox onRetry={() => void extensions.refetch()}>{t('common.error')}</ErrorBox>;
  const extension = extensions.items.find((item) => item.id === route.extension);
  if (!extension || (route.page === 'extension-section' && route.parent === 'admin' && me.role !== 'admin'))
    return <NotFoundPage />;
  if (route.page === 'extension') {
    const page = extension.pages?.find((page) => page.id === route.view && extension.info.pages.includes(page.id));
    if (!page) return <NotFoundPage />;
    const Component = page.component;
    return (
      <Page width="list" header={<PageHeader title={page.label[locale]} />}>
        <Component path={route.path} params={new URLSearchParams(route.query)} />
      </Page>
    );
  }
  const surfaces = route.parent === 'admin' ? extension.adminSections : extension.settingsSections;
  const allowed = route.parent === 'admin' ? extension.info.admin_sections : extension.info.settings_sections;
  const section = surfaces?.find((item) => item.id === route.section && allowed.includes(item.id));
  if (!section) return <NotFoundPage />;
  const Component = section.component;
  return (
    <Page width="form" header={<PageHeader title={section.label[locale]} />}>
      <Component />
    </Page>
  );
}

export function ExtensionPanels({
  entity,
  id,
}: {
  entity: 'doc' | 'agent' | 'record' | 'app' | 'skill' | 'run' | `ext:${string}`;
  id: string;
}) {
  const { t, locale } = useI18n();
  const extensions = useExtensions();
  return (
    <>
      {extensions.items.flatMap((extension) =>
        (extension.entityPanels ?? [])
          .filter(
            (panel) =>
              panel.entity === entity &&
              extension.info.entity_panels.some((entry) => entry.id === panel.id && entry.entity === entity),
          )
          .map((panel) => {
            const Component = panel.component;
            return (
              <section
                key={`${extension.id}:${panel.id}:${id}`}
                className="app-section"
                aria-label={panel.label[locale]}
              >
                <h2 className="app-section-title">{panel.label[locale]}</h2>
                <ErrorBoundary fallback={(retry) => <ErrorBox onRetry={retry}>{t('common.error')}</ErrorBox>}>
                  <Component id={id} />
                </ErrorBoundary>
              </section>
            );
          }),
      )}
    </>
  );
}
