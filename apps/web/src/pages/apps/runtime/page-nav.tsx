/**
 * An app's pages as the spec lays them out (`nav.layout`): tabs under the
 * header, or a page list beside the content. Under 768px both become one
 * scrolling row of tabs — a side list would take half a phone.
 */

import type { AppPage } from '@greenhouse/types/apps';
import { useT } from '../../../lib/i18n';
import { appIcon } from '../../../lib/icons';

interface AppPageNavProps {
  pages: readonly AppPage[];
  currentPageId: string | undefined;
  hrefFor: (pageId: string) => string;
}

export function AppPageTabs({
  pages,
  currentPageId,
  hrefFor,
  className = '',
}: AppPageNavProps & { className?: string }) {
  const t = useT();
  if (pages.length < 2) return null;
  return (
    <nav
      aria-label={t('apps.runtime.pagesTitle')}
      className={`-mb-px mt-2 flex gap-1 overflow-x-auto scrollbar-hide ${className}`}
      data-testid="app-page-tabs"
    >
      {pages.map((entry) => {
        const active = entry.id === currentPageId;
        const Icon = appIcon(entry.icon);
        return (
          <a
            key={entry.id}
            href={hrefFor(entry.id)}
            aria-current={active ? 'page' : undefined}
            className={`inline-flex min-h-11 flex-shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium transition-colors md:min-h-9 ${
              active ? 'border-primary-500 text-fg' : 'border-transparent text-fg-muted hover:text-fg'
            }`}
          >
            <Icon size={13} aria-hidden="true" />
            {entry.title}
          </a>
        );
      })}
    </nav>
  );
}

export function AppPageSidebar({ pages, currentPageId, hrefFor }: AppPageNavProps) {
  const t = useT();
  if (pages.length < 2) return null;
  return (
    <nav
      aria-label={t('apps.runtime.pagesTitle')}
      className="hidden w-52 flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge bg-surface-raised p-2 md:flex"
      data-testid="app-page-sidebar"
    >
      {pages.map((entry) => {
        const active = entry.id === currentPageId;
        const Icon = appIcon(entry.icon);
        return (
          <a
            key={entry.id}
            href={hrefFor(entry.id)}
            aria-current={active ? 'page' : undefined}
            className={`flex min-h-9 items-center gap-2 rounded-lg px-2.5 text-sm transition-colors ${
              active
                ? 'sidebar-active-item font-semibold text-fg'
                : 'text-fg-secondary hover:bg-surface-muted hover:text-fg'
            }`}
          >
            <Icon size={14} aria-hidden="true" className="flex-shrink-0" />
            <span className="min-w-0 truncate" title={entry.title}>
              {entry.title}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
