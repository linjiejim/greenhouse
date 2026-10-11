/**
 * Kanban, calendar and gallery cards: the Phase 0 view bodies themselves
 * (`pages/tables/views/*`), fed through a small adapter instead of a fork.
 * The adapter turns the card into a view config, the gateway's rows into
 * Tables records, and the body's gestures into host calls:
 *
 * - opening a card opens the record's detail (when the card declares one);
 * - a kanban drag between lanes is `$move` (only when the card declares
 *   `move` for this role and the lane field is writable);
 * - card faces carry the declared actions the gateway offers on each record
 *   (`TableViewHost.cardFooter`); a calendar's chips are too small, so its
 *   actions live in the record's detail;
 * - nothing reads `/api/tables` or Drive: lane counts come from the loaded
 *   records (`aggregate: null`) and covers through the app's file route;
 * - a calendar loads the six weeks on screen (`range`), like the Tables
 *   calendar view: moving to another month re-queries through the host.
 *
 * Creating, editing structure, sorting and pasting are not offered here.
 */

import { useMemo, useState } from 'react';
import { useI18n } from '../../lib/i18n';
import type { TableViewConfig } from '@greenhouse/types/tables';
import { viewBodyFor, type TableViewHost, type TableViewPermissions } from '../../pages/tables/views';
import { monthOf, weekStartFor } from '../../pages/tables/views/view-query';
import { brokenActionIds, calendarCardRange, editableFieldIds, offeredActions, appTableDefinition } from './model';
import { AppRecordActionButtons } from './record-actions';
import { useAppRecordsResult } from './records-data';
import type { AppCardRendererProps } from './types';

type ViewCardKind = 'kanban' | 'calendar' | 'gallery';

const noop = () => undefined;
const asyncNoop = async () => undefined;

function viewConfig(card: AppCardRendererProps<ViewCardKind>['card']): TableViewConfig {
  const base: TableViewConfig = { fieldIds: card.fieldIds };
  switch (card.kind) {
    case 'kanban':
      return { ...base, kanban: { groupFieldId: card.groupFieldId, coverFieldId: card.coverFieldId } };
    case 'calendar':
      return { ...base, calendar: { startFieldId: card.startFieldId, endFieldId: card.endFieldId } };
    case 'gallery':
      return { ...base, gallery: { coverFieldId: card.coverFieldId } };
  }
}

export function AppViewCard({ card, host, state }: AppCardRendererProps<ViewCardKind>) {
  const { locale } = useI18n();
  const data = useAppRecordsResult(card, host, state);
  const [calendarMonth, setCalendarMonth] = useState(() => monthOf(new Date()));
  // A calendar loads only the weeks on screen (the host starts on this month): another month asks again.
  const changeMonth = (month: string) => {
    setCalendarMonth(month);
    if (card.kind === 'calendar') host.setParams(card, { range: calendarCardRange(month, weekStartFor(locale)) });
  };
  const Body = viewBodyFor(card.kind);
  const config = useMemo(() => viewConfig(card), [card]);
  const editable = useMemo(() => editableFieldIds(data.table), [data.table]);
  const broken = useMemo(() => brokenActionIds(host.view.issues, host.pageId, card.id), [card.id, host]);

  const permissions: TableViewPermissions = {
    canEdit: card.kind === 'kanban' && card.move !== undefined,
    canCreate: false,
    canBuild: false,
    canChangeView: false,
    canDelete: false,
    canEditField: (fieldId) => editable.has(fieldId),
  };

  const viewHost: TableViewHost = {
    aggregate: null,
    fileUrl: (fileId, record, fieldId) => host.fileUrl(card, record.id, fieldId, fileId),
    cardFooter:
      card.kind === 'calendar'
        ? undefined
        : (record) => {
            const row = data.rowsById.get(record.id);
            if (!row) return null;
            return (
              <AppRecordActionButtons
                actions={offeredActions(card.actions, row, broken)}
                onRun={(action) => host.runAction(card, action, row)}
                testIdPrefix={`app-action-${record.id}`}
                className="pt-1"
              />
            );
          },
  };

  if (!data.table) return null;
  return (
    <div className="h-full min-h-0" data-testid={`app-view-card-${card.id}`}>
      <Body
        table={appTableDefinition(host.view, data.table)}
        view={null}
        config={config}
        fields={data.columns}
        schemaFields={data.fields}
        records={data.records}
        total={data.total}
        query={{}}
        loading={!data.loaded}
        users={data.users}
        usersById={data.usersById}
        sort={undefined}
        permissions={permissions}
        calendarMonth={calendarMonth}
        onCalendarMonthChange={changeMonth}
        onToggleSort={noop}
        onOpenRecord={(record) => {
          const row = data.rowsById.get(record.id);
          if (row && card.detail) host.openRecord(card, row);
        }}
        onEditRecord={noop}
        onDeleteRecord={noop}
        onCreateRecord={noop}
        onCommitValue={async (record, field, value) => {
          const row = data.rowsById.get(record.id);
          if (card.kind !== 'kanban' || !row) return;
          await host.move(card, row, field.id, value);
        }}
        onCommitValues={asyncNoop}
        onPaste={noop}
        onEditField={noop}
        onUpdateViewConfig={asyncNoop}
        onConfigureView={noop}
        host={viewHost}
      />
    </div>
  );
}
