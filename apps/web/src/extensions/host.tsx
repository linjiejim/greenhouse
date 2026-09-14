/**
 * Renders an extension page (or its sidebar panel) for `#/<route>` once the
 * API has confirmed the extension is active; otherwise a calm "not enabled"
 * state — never a blank screen, never a crash.
 */
import React, { Suspense } from 'react';
import { Spinner } from '../components/ui';
import { useT } from '../lib/i18n';
import { useExtensionsStore } from '../stores/extensions-store';
import { findExtensionPage } from './index';

export function ExtensionPageHost({
  route,
  subPath,
  params,
}: {
  route: string;
  subPath: string;
  params: URLSearchParams;
}) {
  const t = useT();
  const loaded = useExtensionsStore((s) => s.loaded);
  const active = useExtensionsStore((s) => s.extensions.some((e) => e.id === findExtensionPage(route)?.extension.id));
  const match = findExtensionPage(route);

  if (!match || (loaded && !active)) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fg-faint">
        {t('app.extensionUnavailable')}
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  }
  const Page = match.page.component;
  return (
    <Suspense
      fallback={
        <div className="flex h-full items-center justify-center">
          <Spinner className="h-6 w-6 text-fg-faint" />
        </div>
      }
    >
      <Page subPath={subPath} params={params} />
    </Suspense>
  );
}

export function ExtensionSidebarPanel({
  route,
  subPath,
  onNavigate,
}: {
  route: string;
  subPath: string;
  onNavigate?: () => void;
}) {
  const match = findExtensionPage(route);
  const active = useExtensionsStore((s) => s.extensions.some((e) => e.id === match?.extension.id));
  if (!match?.page.sidebarPanel || !active) return null;
  const Panel = match.page.sidebarPanel;
  return <Panel subPath={subPath} onNavigate={onNavigate} />;
}
