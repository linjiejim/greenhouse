/**
 * 知识库 (`#/knowledge`): the docs I can read, the latest change first, and a search over the whole
 * knowledge base (KNOW-13: titles, summaries and text of docs and files, Chinese and English).
 */

import { useEffect, useState } from 'react';
import { BookOpen, FilePlus, Search } from 'lucide-react';
import { Button, Empty, ErrorBox, SearchInput, Segmented, Skeleton } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { KnowledgeScope } from '@greenhouse/contract';
import { useMe } from '../../app/session';
import { useKnowledgeSearch, useRecentDocs } from '../../data/knowledge';
import { usePeople } from '../../data/people';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { Page, PageHeader } from '../../shell/Page';
import { useOpenOverlay } from '../../shell/overlays';
import { routeOf, scopeOf } from './helpers';
import { ItemIcon, useSpaceName } from './parts';
import { useKnowledgeScope } from './scope';

type Where = 'all' | KnowledgeScope;

export function KnowledgeHome() {
  const { t, locale } = useI18n();
  const me = useMe();
  const openOverlay = useOpenOverlay();
  const spaceName = useSpaceName();
  const { memberById } = usePeople();
  const scope = useKnowledgeScope();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [where, setWhere] = useState<Where>('all');
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);
  const recent = useRecentDocs();
  const search = useKnowledgeSearch(debounced, where === 'all' ? {} : { space: where });

  return (
    <Page
      width="reading"
      header={
        <PageHeader
          title={t('nav.knowledge')}
          help={t('knowledge.homeHelp')}
          primary={
            <Button
              kind="primary"
              onClick={() =>
                openOverlay({
                  type: 'new-knowledge',
                  kind: 'doc',
                  target: { space: scope === 'team' ? 'team' : 'personal' },
                })
              }
            >
              <FilePlus size={icon.md} strokeWidth={icon.stroke} />
              {t('knowledge.newDoc')}
            </Button>
          }
        />
      }
    >
      <div className="app-toolbar">
        <SearchInput
          label={t('knowledge.searchAll')}
          placeholder={t('knowledge.searchAll')}
          value={q}
          onChange={setQ}
        />
      </div>
      {debounced ? (
        <>
          <Segmented
            label={t('knowledge.searchWhere')}
            items={[
              { value: 'all', label: t('knowledge.everywhere') },
              { value: 'team', label: spaceName('team') },
              { value: 'personal', label: spaceName('personal') },
              { value: 'shared', label: spaceName('shared') },
            ]}
            value={where}
            onChange={(value) => setWhere(value as Where)}
          />
          {search.isPending ? (
            <Skeleton lines={5} />
          ) : search.isError ? (
            <ErrorBox onRetry={() => void search.refetch()}>{errorText(search.error, t)}</ErrorBox>
          ) : search.items.length ? (
            <ul className="app-list" aria-label={t('knowledge.results')}>
              {search.items.map((hit) => (
                <li key={`${hit.type}:${hit.id}`}>
                  <a
                    className="app-list-row"
                    href={href(routeOf({ type: hit.type, id: hit.id, folder_id: hit.folder_id, space: hit.space }))}
                  >
                    <span className="app-knowledge-icon">
                      <ItemIcon item={{ type: hit.type, agent_id: null, content_type: null, is_template: false }} />
                    </span>
                    <span className="app-list-main">
                      <span className="app-list-title">{hit.title}</span>
                      <span className="app-list-meta">
                        {[
                          spaceName(hit.space === 'team' ? 'team' : 'personal'),
                          ...hit.path.map((entry) => entry.name),
                        ].join(' / ')}
                      </span>
                      {hit.snippet && <span className="app-list-meta app-knowledge-snippet">{hit.snippet}</span>}
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <Empty
              icon={<Search />}
              title={t('knowledge.noMatch', { query: debounced })}
              action={<Button onClick={() => setQ('')}>{t('knowledge.clearSearch')}</Button>}
            />
          )}
        </>
      ) : recent.isPending ? (
        <Skeleton lines={6} />
      ) : recent.isError ? (
        <ErrorBox onRetry={() => void recent.refetch()}>{errorText(recent.error, t)}</ErrorBox>
      ) : !recent.items.length ? (
        <Empty
          icon={<BookOpen />}
          title={t('knowledge.noDocs')}
          action={
            <Button onClick={() => openOverlay({ type: 'new-knowledge', kind: 'doc', target: { space: 'team' } })}>
              {t('knowledge.newDoc')}
            </Button>
          }
        />
      ) : (
        <section aria-label={t('knowledge.recent')}>
          <h2 className="app-section-title">{t('knowledge.recent')}</h2>
          <ul className="app-list">
            {recent.items.map((item) => (
              <li key={item.id}>
                <a className="app-list-row" href={href(routeOf(item))}>
                  <span className="app-knowledge-icon">
                    <ItemIcon item={item} />
                  </span>
                  <span className="app-list-main">
                    <span className="app-list-title">{item.name}</span>
                    <span className="app-list-meta">
                      {[
                        spaceName(scopeOf(item, me.id)),
                        item.space === 'personal' && item.owner_id !== me.id
                          ? memberById.get(item.owner_id ?? '')?.name
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <time className="app-list-time" dateTime={item.updated_at}>
                    {relativeTime(item.updated_at, { locale, timeZone: me.timezone })}
                  </time>
                </a>
              </li>
            ))}
            {recent.hasNextPage && (
              <li>
                <Button kind="ghost" loading={recent.isFetchingNextPage} onClick={() => void recent.fetchNextPage()}>
                  {t('common.more')}
                </Button>
              </li>
            )}
          </ul>
        </section>
      )}
    </Page>
  );
}
