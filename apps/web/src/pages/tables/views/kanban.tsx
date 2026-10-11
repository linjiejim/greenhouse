/**
 * Kanban view body: one lane per option of a single-select (in option order)
 * or per person of a person field (the people present), plus "no value".
 *
 * - The container loads at most `VIEW_RECORD_LIMIT` records; beyond that a
 *   notice asks for a filter. Lane counts come from an aggregate, so they are
 *   exact even when the board is capped.
 * - Dragging a card to another lane is one revision-checked single-field write
 *   (`onCommitValue` → the container's replaying update). The card moves at
 *   once and snaps back if the write fails.
 * - Lanes can be hidden (`kanban.hiddenGroups`); the cover is the first image
 *   of `kanban.coverFieldId`.
 */

import { useId, useMemo, useState } from 'react';
import { Button, Card, EmptyState, IconButton, Tag, toast } from '../../../components/ui';
import { isComputedField } from '../../../components/tables/field-types';
import { recordFieldValue } from '../../../components/tables/field-value';
import { useDropZoneDrag } from '../../../hooks/use-drop-zone-drag';
import { EyeOff, Kanban, Plus, Eye } from '../../../lib/icons';
import type { TableField, TableRecord } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { RecordCover } from './record-cover';
import { cardFields, primaryField, RecordCardFields, RecordTitle } from './record-card';
import type { TableViewBodyProps } from './types';
import { useGroupCounts } from './use-group-counts';
import {
  fieldById,
  kanbanLanes,
  NO_VALUE_GROUP,
  recordLaneKey,
  VIEW_RECORD_LIMIT,
  type KanbanLane,
} from './view-query';

function laneFieldOf(fields: readonly TableField[], fieldId: number | undefined): TableField | undefined {
  const field = fieldById(fields, fieldId);
  return field && (field.type === 'single_select' || field.type === 'user') ? field : undefined;
}

export function KanbanViewBody({
  table,
  config,
  fields,
  schemaFields,
  records,
  total,
  query,
  usersById,
  permissions,
  onOpenRecord,
  onCreateRecord,
  onCommitValue,
  onUpdateViewConfig,
  onConfigureView,
}: TableViewBodyProps) {
  const t = useT();
  /** Each card is named by its title element (screen readers hear the record, not "Record #12"). */
  const cardIdPrefix = useId();
  const kanban = config.kanban;
  const laneField = laneFieldOf(schemaFields, kanban?.groupFieldId);
  const coverField = fieldById(schemaFields, kanban?.coverFieldId);
  const counts = useGroupCounts(table.id, laneField ? { fieldId: laneField.id } : undefined, laneField, query, records);
  /** Cards moved by a drag whose write is still in flight: record id → lane key. */
  const [moves, setMoves] = useState<ReadonlyMap<number, string>>(new Map());

  const lanes = useMemo(
    () => (laneField ? kanbanLanes(laneField, records, counts, usersById) : []),
    [laneField, records, counts, usersById],
  );
  const hidden = new Set(kanban?.hiddenGroups ?? []);
  // A drag writes the lane field and a lane's "+" prefills it: both need that field writable
  // (a custom role may edit some fields only; the record dialog leaves the rest out).
  const laneWritable =
    Boolean(laneField) && !isComputedField(laneField!) && (permissions.canEditField?.(laneField!.id) ?? true);
  const canDrag = laneWritable && permissions.canEdit;
  const canCreateInLane = laneWritable && permissions.canCreate;

  const laneOf = (record: TableRecord) => moves.get(record.id) ?? recordLaneKey(record, laneField!, lanes);

  const move = async (record: TableRecord, laneKey: string) => {
    const lane = lanes.find((entry) => entry.key === laneKey);
    if (!laneField || !lane || laneOf(record) === laneKey) return;
    setMoves((current) => new Map(current).set(record.id, laneKey));
    try {
      await onCommitValue(record, laneField, lane.value);
    } catch (error) {
      toast(error instanceof Error && error.message ? error.message : t('tables.views.moveFailed'), 'error');
    } finally {
      setMoves((current) => {
        const next = new Map(current);
        next.delete(record.id);
        return next;
      });
    }
  };

  const drag = useDropZoneDrag<TableRecord>((record, zone) => void move(record, zone));

  if (!laneField) {
    return (
      <EmptyState
        icon={Kanban}
        title={t('tables.views.kanbanNeedsLanesTitle')}
        description={t('tables.views.kanbanNeedsLanesDescription')}
        action={
          permissions.canChangeView ? (
            <Button size="sm" onClick={onConfigureView}>
              {t('tables.views.chooseField')}
            </Button>
          ) : undefined
        }
      />
    );
  }

  const primary = primaryField(schemaFields);
  const shownFields = cardFields(fields, schemaFields, config, primary);
  const systemFields = config.systemFields ?? [];
  const setHidden = (keys: string[]) =>
    void onUpdateViewConfig({ kanban: { ...kanban!, hiddenGroups: keys.length > 0 ? keys : undefined } });
  const laneLabel = (lane: KanbanLane) =>
    lane.key === NO_VALUE_GROUP ? (
      <span className="text-fg-muted">{t('tables.views.noValue')}</span>
    ) : laneField.type === 'single_select' ? (
      <Tag tone="info" size="sm" truncate maxW="max-w-[11rem]">
        {lane.label}
      </Tag>
    ) : (
      <span className="truncate" title={lane.label}>
        {lane.label}
      </span>
    );

  const visibleLanes = lanes.filter((lane) => !hidden.has(lane.key));
  const hiddenLanes = lanes.filter((lane) => hidden.has(lane.key));
  const capped = total > records.length;
  const ghost = drag.dragging && drag.pointer ? drag.dragging : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {capped && (
        <p className="flex-shrink-0 border-b border-edge bg-info-subtle px-4 py-2 text-xs text-info">
          {t('tables.views.limitNotice', { limit: VIEW_RECORD_LIMIT, total })}
        </p>
      )}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3" data-testid="kanban-board">
        {visibleLanes.map((lane) => {
          const cards = records.filter((record) => laneOf(record) === lane.key);
          const count = counts?.get(lane.key) ?? cards.length;
          const isOver = drag.dragging !== null && drag.over === lane.key;
          return (
            <section
              key={lane.key || '∅'}
              {...drag.zoneProps(lane.key)}
              data-testid={`kanban-lane-${lane.key || 'none'}`}
              aria-label={lane.key === NO_VALUE_GROUP ? t('tables.views.noValue') : lane.label}
              className={`flex w-72 flex-shrink-0 flex-col rounded-xl border bg-surface-sunken ${
                isOver ? 'border-primary-edge bg-primary-subtle' : 'border-edge'
              }`}
            >
              <header className="flex items-center gap-2 px-3 pb-1 pt-2 text-xs font-medium text-fg-secondary">
                <span className="flex min-w-0 flex-1 items-center gap-2">{laneLabel(lane)}</span>
                <span className="text-fg-faint" data-testid="kanban-lane-count">
                  {count}
                </span>
                {permissions.canChangeView && (
                  <IconButton
                    label={t('tables.views.hideLane')}
                    tooltip="top"
                    tooltipMode="portal"
                    size="compact"
                    onClick={() => setHidden([...hidden, lane.key])}
                  >
                    <EyeOff size={12} />
                  </IconButton>
                )}
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {cards.map((record) => (
                  <Card
                    key={record.id}
                    role="button"
                    tabIndex={0}
                    data-testid={`kanban-card-${record.id}`}
                    aria-labelledby={`${cardIdPrefix}-${record.id}`}
                    onPointerDown={canDrag ? (event) => drag.start(event, record) : undefined}
                    onClick={() => {
                      if (drag.didDrag()) return;
                      onOpenRecord(record);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return;
                      event.preventDefault();
                      onOpenRecord(record);
                    }}
                    className={`cursor-pointer select-none overflow-hidden transition-opacity hover:border-edge-strong ${
                      drag.dragging?.id === record.id ? 'opacity-40' : ''
                    } ${moves.has(record.id) ? 'animate-pulse' : ''}`}
                  >
                    {coverField && (
                      <RecordCover value={recordFieldValue(record, coverField.id)} alt="" className="h-32" />
                    )}
                    <div className="space-y-2 p-3">
                      <p id={`${cardIdPrefix}-${record.id}`} className="truncate text-sm font-medium text-fg">
                        <RecordTitle record={record} primary={primary} usersById={usersById} />
                      </p>
                      <RecordCardFields
                        record={record}
                        fields={shownFields}
                        systemFields={systemFields}
                        usersById={usersById}
                      />
                    </div>
                  </Card>
                ))}
                {cards.length === 0 && (
                  <p className="px-1 py-3 text-center text-[11px] text-fg-faint">{t('tables.views.emptyLane')}</p>
                )}
              </div>
              {canCreateInLane && (
                <div className="flex-shrink-0 px-2 pb-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start gap-1.5"
                    onClick={() => onCreateRecord(lane.value === null ? {} : { [String(laneField.id)]: lane.value })}
                  >
                    <Plus size={14} />
                    {t('tables.views.newRecordInLane')}
                  </Button>
                </div>
              )}
            </section>
          );
        })}
        {hiddenLanes.length > 0 && (
          <aside className="w-56 flex-shrink-0 self-start rounded-xl border border-dashed border-edge p-3">
            <p className="mb-2 text-xs font-medium text-fg-muted">{t('tables.views.hiddenLanes')}</p>
            <ul className="space-y-1">
              {hiddenLanes.map((lane) => (
                <li key={lane.key || '∅'} className="flex items-center gap-2 text-xs text-fg-secondary">
                  <span className="flex min-w-0 flex-1 items-center gap-2">{laneLabel(lane)}</span>
                  <span className="text-fg-faint">{counts?.get(lane.key) ?? 0}</span>
                  {permissions.canChangeView && (
                    <IconButton
                      label={t('tables.views.showLane')}
                      tooltip="top"
                      tooltipMode="portal"
                      size="compact"
                      onClick={() => setHidden([...hidden].filter((key) => key !== lane.key))}
                    >
                      <Eye size={12} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>
      {ghost && drag.pointer && (
        <div
          className="pointer-events-none fixed z-50 w-64 rotate-2 rounded-lg border border-primary-edge bg-surface-raised px-3 py-2 text-sm font-medium text-fg shadow-lg"
          style={{ left: drag.pointer.x + 12, top: drag.pointer.y + 12 }}
          aria-hidden="true"
        >
          <span className="block truncate">
            <RecordTitle record={ghost} primary={primary} usersById={usersById} />
          </span>
        </div>
      )}
    </div>
  );
}
