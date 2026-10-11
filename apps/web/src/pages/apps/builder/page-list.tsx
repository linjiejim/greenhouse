/**
 * The app's pages, in tab order: pick one to edit it, add one, and from each
 * page's menu move it, make it the page people land on, or delete it. A page
 * that cannot be deleted yet says why (the last page; a role that sees only
 * it; a button elsewhere that opens it) — the builder never silently widens a
 * role or breaks a button.
 *
 * Desktop: a column. Below `lg`: a scrolling strip above the canvas.
 */

import { useState } from 'react';
import type { AppSpec, AppSpecError } from '@greenhouse/types/apps';
import { Button, ConfirmDialog, IconButton, Tag } from '../../../components/ui';
import { ContextMenu, useContextMenu } from '../../../components/app/context-menu';
import { useT } from '../../../lib/i18n';
import { appIcon, ArrowDown, ArrowUp, House, MoreHorizontal, Plus, Trash2 } from '../../../lib/icons';
import { pageErrorCount } from './spec-errors';
import { pageDeletionBlockers, type PageDeletionBlocker } from './spec-model';

export function PageList({
  spec,
  errors,
  selectedPageId,
  onSelect,
  onAdd,
  onMove,
  onSetHome,
  onDelete,
  layout,
}: {
  spec: AppSpec;
  errors: readonly AppSpecError[];
  selectedPageId: string;
  onSelect: (pageId: string) => void;
  onAdd: () => void;
  onMove: (pageId: string, toIndex: number) => void;
  onSetHome: (pageId: string) => void;
  onDelete: (pageId: string) => void;
  layout: 'column' | 'strip';
}) {
  const t = useT();
  const { menu, openMenu, closeMenu } = useContextMenu();
  const [deleting, setDeleting] = useState<string | null>(null);
  const home = spec.home ?? spec.pages[0]?.id;
  const deletingPage = spec.pages.find((page) => page.id === deleting);
  const blockers = deleting ? pageDeletionBlockers(spec, deleting) : [];

  const blockerText = (blocker: PageDeletionBlocker) => {
    if (blocker.kind === 'lastPage') return t('apps.builder.pages.blockedLast');
    if (blocker.kind === 'onlyPageOfRole') return t('apps.builder.pages.blockedRole', { role: blocker.roleName });
    return t('apps.builder.pages.blockedButton', { button: blocker.buttonLabel, page: blocker.pageTitle });
  };

  const rows = spec.pages.map((page, index) => {
    const Icon = appIcon(page.icon ?? 'app');
    const problems = pageErrorCount(errors, page.id);
    const selected = page.id === selectedPageId;
    return (
      <li key={page.id} className={layout === 'strip' ? 'flex-shrink-0' : ''}>
        <div
          className={`group flex items-center gap-1 rounded-lg border pr-1 transition-colors ${
            selected
              ? 'border-primary-edge bg-primary-subtle text-primary-fg-strong'
              : 'border-transparent text-fg-secondary hover:bg-surface-muted'
          }`}
        >
          <button
            type="button"
            aria-pressed={selected}
            onClick={() => onSelect(page.id)}
            className="flex min-h-11 min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5 text-left text-sm md:min-h-9"
            data-testid={`app-page-${page.id}`}
          >
            <Icon size={14} className="flex-shrink-0" />
            <span className={`min-w-0 truncate ${layout === 'strip' ? 'max-w-[10rem]' : 'flex-1'}`} title={page.title}>
              {page.title}
            </span>
            {page.id === home && (
              <span title={t('apps.builder.pages.homeHint')} className="flex-shrink-0">
                <House size={12} aria-label={t('apps.builder.pages.home')} />
              </span>
            )}
            {problems > 0 && <Tag tone="danger">{problems}</Tag>}
          </button>
          <IconButton
            label={t('apps.builder.pages.actionsFor', { title: page.title })}
            onClick={(event) =>
              openMenu(event, [
                ...(index > 0
                  ? [
                      {
                        label: t('apps.builder.pages.moveUp'),
                        icon: ArrowUp,
                        onClick: () => onMove(page.id, index - 1),
                      },
                    ]
                  : []),
                ...(index < spec.pages.length - 1
                  ? [
                      {
                        label: t('apps.builder.pages.moveDown'),
                        icon: ArrowDown,
                        onClick: () => onMove(page.id, index + 1),
                      },
                    ]
                  : []),
                ...(page.id !== home
                  ? [{ label: t('apps.builder.pages.setHome'), icon: House, onClick: () => onSetHome(page.id) }]
                  : []),
                {
                  label: t('apps.builder.pages.delete'),
                  icon: Trash2,
                  danger: true,
                  onClick: () => setDeleting(page.id),
                },
              ])
            }
          >
            <MoreHorizontal size={13} />
          </IconButton>
        </div>
      </li>
    );
  });

  return (
    <nav aria-label={t('apps.builder.pages.listLabel')} data-testid="app-page-list">
      {layout === 'column' ? (
        <div className="space-y-2">
          <ul className="space-y-1">{rows}</ul>
          <Button variant="outline" size="sm" className="w-full" onClick={onAdd} data-testid="app-add-page">
            <Plus size={13} className="mr-1.5" />
            {t('apps.builder.pages.add')}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <ul className="flex min-w-0 flex-1 gap-1 overflow-x-auto scrollbar-hide">{rows}</ul>
          <IconButton
            label={t('apps.builder.pages.add')}
            onClick={onAdd}
            className="flex-shrink-0 border border-edge"
            data-testid="app-add-page"
          >
            <Plus size={14} />
          </IconButton>
        </div>
      )}
      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting && blockers.length === 0) onDelete(deleting);
          setDeleting(null);
        }}
        title={t('apps.builder.pages.deleteTitle', { title: deletingPage?.title ?? '' })}
        description={
          blockers.length > 0
            ? [t('apps.builder.pages.blocked'), ...blockers.map(blockerText)].join(' ')
            : t('apps.builder.pages.deleteDescription')
        }
        confirmLabel={blockers.length > 0 ? t('common.close') : t('apps.builder.pages.delete')}
        confirmVariant={blockers.length > 0 ? 'default' : 'destructive'}
      />
    </nav>
  );
}
