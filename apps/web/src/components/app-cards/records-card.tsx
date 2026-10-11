/**
 * Records card (`kind: 'records'`): the role's rows of a table as a table
 * (the shared `RecordsTable`, the dashboard's records renderer) or a list,
 * with search, cursor paging and the card-face actions the gateway offers on
 * each row. A row opens its detail when the card declares one.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppRecordRow } from '@greenhouse/types/apps';
import { RecordsTable } from '../table-cards';
import { Button, SearchInput } from '../ui';
import type { TableRecord } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { ChevronLeft, ChevronRight } from '../../lib/icons';
import { cardFields, primaryField, RecordCardFields, RecordTitle } from '../../pages/tables/views/record-card';
import { brokenActionIds, offeredActions } from './model';
import { AppRecordActionButtons } from './record-actions';
import { useAppRecordsResult } from './records-data';
import type { AppCardRendererProps } from './types';

const SEARCH_DELAY_MS = 350;

interface PageMark {
  cursor?: string;
  offset: number;
}
const FIRST_PAGE: PageMark = { offset: 0 };

export function AppRecordsCard({ card, host, state }: AppCardRendererProps<'records'>) {
  const t = useT();
  const data = useAppRecordsResult(card, host, state);
  const [search, setSearch] = useState('');
  /** The pages we have been on (cursor + how many rows came before it); the last one is on screen. */
  const [pages, setPages] = useState<PageMark[]>([FIRST_PAGE]);
  const current = pages[pages.length - 1]!;
  /** The search the card was last evaluated with. */
  const searched = useRef('');

  // A new search starts over at the first page.
  useEffect(() => {
    const text = search.trim();
    if (text === searched.current) return;
    const timer = setTimeout(() => {
      searched.current = text;
      setPages([FIRST_PAGE]);
      host.setParams(card, text ? { search: text } : {});
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
    // Only the text drives this; `setParams` is the page's stable callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const goTo = (next: PageMark[]) => {
    const mark = next[next.length - 1]!;
    setPages(next);
    host.setParams(card, {
      ...(searched.current ? { search: searched.current } : {}),
      ...(mark.cursor ? { cursor: mark.cursor } : {}),
    });
  };

  const broken = useMemo(() => brokenActionIds(host.view.issues, host.pageId, card.id), [card.id, host]);
  const rowActions = (row: AppRecordRow | undefined) => (row ? offeredActions(card.actions, row, broken) : []);
  const withActions = data.rows.some((row) => rowActions(row).length > 0);
  const open = card.detail
    ? (record: TableRecord) => {
        const row = data.rowsById.get(record.id);
        if (row) host.openRecord(card, row);
      }
    : undefined;

  const from = data.rows.length === 0 ? 0 : current.offset + 1;
  const to = current.offset + data.rows.length;
  const primary = primaryField(data.fields);
  const listFields = cardFields(data.columns, data.fields, { fieldIds: card.fieldIds }, primary);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <SearchInput
        value={search}
        onChange={setSearch}
        placeholder={t('apps.runtime.cards.searchPlaceholder')}
        aria-label={t('apps.runtime.cards.search', { title: data.title })}
        className="w-full sm:w-56"
      />
      <div className="min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-surface-raised">
        {card.display === 'list' ? (
          <ul className="divide-y divide-edge" aria-label={data.title}>
            {data.records.map((record) => {
              const row = data.rowsById.get(record.id);
              return (
                <li key={record.id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    {open ? (
                      <button
                        type="button"
                        className="block max-w-full truncate text-left text-sm font-medium text-fg hover:text-primary-fg"
                        onClick={() => open(record)}
                        data-testid={`app-record-open-${record.id}`}
                      >
                        <RecordTitle record={record} primary={primary} usersById={data.usersById} />
                      </button>
                    ) : (
                      <p className="truncate text-sm font-medium text-fg">
                        <RecordTitle record={record} primary={primary} usersById={data.usersById} />
                      </p>
                    )}
                    <RecordCardFields
                      record={record}
                      fields={listFields}
                      systemFields={card.systemFields ?? []}
                      usersById={data.usersById}
                    />
                  </div>
                  <AppRecordActionButtons
                    actions={rowActions(row)}
                    onRun={(action) => row && host.runAction(card, action, row)}
                    testIdPrefix={`app-action-${record.id}`}
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="min-w-[480px]">
            <RecordsTable
              records={data.records}
              fields={data.fields}
              fieldIds={card.fieldIds}
              systemFields={card.systemFields}
              usersById={data.usersById}
              onOpenRecord={open}
              rowActions={
                withActions
                  ? {
                      label: t('apps.runtime.cards.rowActions'),
                      render: (record) => {
                        const row = data.rowsById.get(record.id);
                        return (
                          <AppRecordActionButtons
                            actions={rowActions(row)}
                            onRun={(action) => row && host.runAction(card, action, row)}
                            testIdPrefix={`app-action-${record.id}`}
                            className="justify-end"
                          />
                        );
                      },
                    }
                  : undefined
              }
            />
          </div>
        )}
        {data.loaded && data.records.length === 0 && (
          <p className="px-3 py-6 text-center text-xs text-fg-faint">
            {search.trim() ? t('apps.runtime.cards.noMatches') : t('apps.runtime.cards.noRecords')}
          </p>
        )}
      </div>
      {(pages.length > 1 || data.nextCursor) && (
        <div className="flex flex-shrink-0 items-center justify-between gap-2 text-xs text-fg-faint">
          <span>{t('common.rangeOfTotal', { from, to, total: data.total })}</span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-0"
              disabled={pages.length === 1}
              onClick={() => goTo(pages.slice(0, -1))}
            >
              <ChevronLeft size={14} aria-hidden="true" />
              <span className="sr-only sm:not-sr-only sm:ml-1">{t('common.previous')}</span>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-0"
              disabled={!data.nextCursor}
              onClick={() =>
                data.nextCursor &&
                goTo([...pages, { cursor: data.nextCursor, offset: current.offset + data.rows.length }])
              }
            >
              <span className="sr-only sm:not-sr-only sm:mr-1">{t('common.next')}</span>
              <ChevronRight size={14} aria-hidden="true" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
