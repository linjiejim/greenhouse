/**
 * 已归档 (KNOW-11): what was archived in the team space or mine, topmost only (a folder takes
 * what was archived with it). Each comes back with 恢复; an archived folder opens to show the rest.
 */

import { Archive } from 'lucide-react';
import { Button, Empty, ErrorBox, Menu, Skeleton, useContextMenu } from '@greenhouse/ui/kit';
import type { KnowledgeItem, KnowledgeSpace } from '@greenhouse/contract';
import { useMe } from '../../app/session';
import { useArchived } from '../../data/knowledge';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { Page, PageHeader } from '../../shell/Page';
import { useItemMenu } from './actions';
import { canArchive, routeOf } from './helpers';
import { ItemIcon, useSpaceName } from './parts';

function ArchivedRow({ item }: { item: KnowledgeItem }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const { menuFor, restore } = useItemMenu();
  const menu = menuFor(item, { open: true });
  const context = useContextMenu(menu, t('row.actionsFor', { name: item.name }));
  return (
    <li className="app-list-row is-static app-knowledge-row" {...context.handlers}>
      <a className="app-knowledge-open" href={href(routeOf(item))}>
        <span className="app-knowledge-icon">
          <ItemIcon item={item} />
        </span>
        <span className="app-list-main">
          <span className="app-list-title">{item.name}</span>
          <span className="app-list-meta">
            {t('knowledge.archivedAt', {
              time: relativeTime(item.archived_at ?? item.updated_at, { locale, timeZone: me.timezone }),
            })}
          </span>
        </span>
      </a>
      {canArchive(item) && (
        <Button size="sm" onClick={() => void restore(item)}>
          {t('knowledge.restore')}
        </Button>
      )}
      <Menu label={t('row.actionsFor', { name: item.name })} items={menu} />
      {context.menu}
    </li>
  );
}

export function ArchivedPage({ space }: { space: KnowledgeSpace }) {
  const { t } = useI18n();
  const spaceName = useSpaceName();
  const archived = useArchived(space);
  return (
    <Page
      width="list"
      header={
        <PageHeader title={t('knowledge.archivedIn', { space: spaceName(space) })} help={t('knowledge.archivedHelp')} />
      }
    >
      {archived.isPending ? (
        <Skeleton lines={5} />
      ) : archived.isError ? (
        <ErrorBox onRetry={() => void archived.refetch()}>{errorText(archived.error, t)}</ErrorBox>
      ) : !archived.items.length ? (
        <Empty icon={<Archive />} title={t('knowledge.noneArchived')} />
      ) : (
        <>
          <ul className="app-list" aria-label={t('directory.archived')}>
            {archived.items.map((item) => (
              <ArchivedRow key={`${item.type}:${item.id}`} item={item} />
            ))}
          </ul>
          {archived.hasNextPage && (
            <div className="app-knowledge-more">
              <Button kind="ghost" loading={archived.isFetchingNextPage} onClick={() => void archived.fetchNextPage()}>
                {t('knowledge.showMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
