import React from 'react';
import { localize } from '@greenhouse/types/plugins';
import { useExtensionsStore } from '../stores/extensions-store';
import { useAuthStore } from '../stores/auth-store';
import { useI18n } from '../lib/i18n';
import { Spinner } from '../components/ui';
import { WorkspaceSettingsForm } from '../pages/administration/runtime-config';
import { EntityPage } from './entity-page';
import { EmbedPage } from './embed-page';

export function ManifestPageHost({ subPath, params }: { subPath: string; params: URLSearchParams }) {
  const { locale, t } = useI18n();
  const plugins = useExtensionsStore((s) => s.plugins),
    loaded = useExtensionsStore((s) => s.loaded);
  const user = useAuthStore((s) => s.currentUser);
  const [pluginId, pageId, ...tail] = subPath.split('/');
  const plugin = plugins.find((p) => p.id === pluginId);
  const linkedEntity = plugin?.entities.find((entity) => entity.id.split('.').at(-1) === pageId);
  const page =
    plugin?.pages.find((p) => p.id === pageId) ??
    plugin?.pages.find(
      (p) =>
        p.kind === (tail.length ? 'entity-detail' : 'entity-list') && 'entity' in p && p.entity === linkedEntity?.id,
    );
  if (!loaded) return <Spinner />;
  if (!plugin || !page || (page.requireRole === 'super' && user?.role !== 'super'))
    return <p>{t('app.extensionUnavailable')}</p>;
  let recordId: string | undefined;
  try {
    recordId = tail.length ? decodeURIComponent(tail.join('/')) : (params.get('id') ?? undefined);
  } catch {
    return <p>{t('app.extensionUnavailable')}</p>;
  }
  const title = localize(page.title, locale);
  if (page.kind === 'embed')
    return <EmbedPage key={`${pluginId}/${pageId}/${user?.id}`} plugin={pluginId} page={page} route={tail.join('/')} />;
  let body: React.ReactNode;
  if (page.kind === 'entity-list' || page.kind === 'entity-detail') {
    const entity = plugin.entities.find((e) => e.id === page.entity);
    body = entity ? (
      <EntityPage
        key={`${pluginId}/${pageId}`}
        plugin={plugin}
        entity={entity}
        viewId={page.kind === 'entity-list' ? page.view : undefined}
        recordId={recordId}
      />
    ) : (
      <p>{t('app.extensionUnavailable')}</p>
    );
  } else if (page.kind === 'settings-form') {
    body =
      user?.role === 'super' ? (
        <WorkspaceSettingsForm key={`${pluginId}/${pageId}`} settingKeys={page.settings} />
      ) : (
        <p>{t('app.extensionUnavailable')}</p>
      );
  } else {
    body = page.fallback_url ? (
      <a href={page.fallback_url}>{t('app.openInBrowser')}</a>
    ) : (
      <p>{t('app.extensionUnavailable')}</p>
    );
  }
  return (
    <section className="h-full overflow-y-auto p-4 md:p-6" data-testid="extension-manifest-page">
      <h1 className="mb-4 text-lg font-semibold">{title}</h1>
      {body}
    </section>
  );
}
