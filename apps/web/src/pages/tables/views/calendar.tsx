/**
 * Calendar view body: a month grid with every record placed on the local day
 * of its start field (`calendar.startFieldId`), spanning to its end field when
 * the view has one.
 *
 * - The container queries only the six weeks on screen (`calendarMonth`) and
 *   at most `VIEW_RECORD_LIMIT` records; beyond that a notice asks for a filter.
 * - A day's "+" opens the new-record dialog with that day filled in.
 * - Dragging a record to another day is one revision-checked write that moves
 *   the start — and the end by the same number of days, so the duration holds.
 *   A datetime keeps its time of day.
 */

import { useMemo, useState } from 'react';
import { Button, EmptyState, IconButton, toast } from '../../../components/ui';
import { isComputedField } from '../../../components/tables/field-types';
import { recordFieldValue } from '../../../components/tables/field-value';
import { useDropZoneDrag } from '../../../hooks/use-drop-zone-drag';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from '../../../lib/icons';
import type { TableField, TableRecord } from '../../../lib/api/tables';
import { useI18n } from '../../../lib/i18n';
import { primaryField, RecordTitle } from './record-card';
import type { TableViewBodyProps } from './types';
import {
  addDays,
  dayOfValue,
  dayStart,
  daysBetween,
  fieldById,
  localDay,
  monthGridDays,
  monthOf,
  shiftMonth,
  VIEW_RECORD_LIMIT,
  weekStartFor,
} from './view-query';

/** A multi-day record is drawn on at most this many days. */
const MAX_SPAN_DAYS = 62;

function dateFieldOf(fields: readonly TableField[], fieldId: number | undefined): TableField | undefined {
  const field = fieldById(fields, fieldId);
  return field && (field.type === 'date' || field.type === 'datetime') ? field : undefined;
}

/** A stored date / datetime moved by whole local days (a datetime keeps its time of day). */
export function shiftDateValue(value: unknown, type: TableField['type'], days: number): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (type === 'date') return dayOfValue(value, 'date') ? addDays(value, days) : null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return null;
  date.setDate(date.getDate() + days);
  return date.toISOString();
}

/** What a new record created on `day` stores in a date / datetime field (local midnight for a datetime). */
export function dayValue(day: string, type: TableField['type']): string {
  return type === 'date' ? day : dayStart(day).toISOString();
}

export function CalendarViewBody({
  config,
  schemaFields,
  records,
  total,
  usersById,
  permissions,
  calendarMonth,
  onCalendarMonthChange,
  onOpenRecord,
  onCreateRecord,
  onCommitValues,
  onConfigureView,
}: TableViewBodyProps) {
  const { t, locale } = useI18n();
  const startField = dateFieldOf(schemaFields, config.calendar?.startFieldId);
  const endField = dateFieldOf(schemaFields, config.calendar?.endFieldId);
  const weekStart = weekStartFor(locale);
  const days = useMemo(() => monthGridDays(calendarMonth, weekStart), [calendarMonth, weekStart]);
  /** Records dragged to a day whose write is still in flight: record id → new start day. */
  const [moves, setMoves] = useState<ReadonlyMap<number, string>>(new Map());
  const today = localDay(new Date());
  const intlLocale = locale === 'zh' ? 'zh-CN' : 'en';

  const placed = useMemo(() => {
    const byDay = new Map<string, TableRecord[]>();
    if (!startField) return byDay;
    const visible = new Set(days);
    for (const record of records) {
      const stored = dayOfValue(recordFieldValue(record, startField.id), startField.type);
      const start = moves.get(record.id) ?? stored;
      if (!start) continue;
      let span = 1;
      const end = endField ? dayOfValue(recordFieldValue(record, endField.id), endField.type) : null;
      if (end && stored && end >= stored) span = Math.min(daysBetween(stored, end) + 1, MAX_SPAN_DAYS);
      for (let offset = 0; offset < span; offset += 1) {
        const day = addDays(start, offset);
        if (!visible.has(day)) continue;
        byDay.set(day, [...(byDay.get(day) ?? []), record]);
      }
    }
    return byDay;
  }, [days, endField, moves, records, startField]);

  const canDrag = Boolean(startField) && permissions.canEdit && !isComputedField(startField!);
  const canCreate = Boolean(startField) && permissions.canCreate && !isComputedField(startField!);

  const moveTo = async (record: TableRecord, day: string) => {
    if (!startField) return;
    const startValue = recordFieldValue(record, startField.id);
    const from = dayOfValue(startValue, startField.type);
    if (!from || from === day) return;
    const delta = daysBetween(from, day);
    const values: Record<string, unknown> = {
      [String(startField.id)]: shiftDateValue(startValue, startField.type, delta),
    };
    if (endField && !isComputedField(endField)) {
      const endValue = shiftDateValue(recordFieldValue(record, endField.id), endField.type, delta);
      if (endValue) values[String(endField.id)] = endValue;
    }
    setMoves((current) => new Map(current).set(record.id, day));
    try {
      await onCommitValues(record, values);
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

  const drag = useDropZoneDrag<TableRecord>((record, day) => void moveTo(record, day));

  if (!startField) {
    return (
      <EmptyState
        icon={CalendarDays}
        title={t('tables.views.calendarNeedsDateTitle')}
        description={t('tables.views.calendarNeedsDateDescription')}
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
  const monthLabel = new Intl.DateTimeFormat(intlLocale, { year: 'numeric', month: 'long' }).format(
    dayStart(`${calendarMonth}-01`),
  );
  const weekdayFormat = new Intl.DateTimeFormat(intlLocale, { weekday: 'short' });
  const dayLabelFormat = new Intl.DateTimeFormat(intlLocale, { month: 'long', day: 'numeric' });
  const ghost = drag.dragging && drag.pointer ? drag.dragging : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
        <IconButton
          label={t('tables.views.previousMonth')}
          size="compact"
          onClick={() => onCalendarMonthChange(shiftMonth(calendarMonth, -1))}
        >
          <ChevronLeft size={14} />
        </IconButton>
        <IconButton
          label={t('tables.views.nextMonth')}
          size="compact"
          onClick={() => onCalendarMonthChange(shiftMonth(calendarMonth, 1))}
        >
          <ChevronRight size={14} />
        </IconButton>
        <h3 className="text-sm font-semibold text-fg" data-testid="calendar-month">
          {monthLabel}
        </h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onCalendarMonthChange(monthOf(new Date()))}
          disabled={calendarMonth === monthOf(new Date())}
        >
          {t('tables.views.today')}
        </Button>
        {total > records.length && (
          <span className="ml-auto text-xs text-info">
            {t('tables.views.limitNotice', { limit: VIEW_RECORD_LIMIT, total })}
          </span>
        )}
      </div>
      <div className="grid flex-shrink-0 grid-cols-7 border-b border-edge bg-surface-sunken">
        {days.slice(0, 7).map((day) => (
          <div key={day} className="px-2 py-1 text-[11px] font-medium text-fg-muted">
            {weekdayFormat.format(dayStart(day))}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-7 overflow-y-auto" data-testid="calendar-grid">
        {days.map((day) => {
          const inMonth = day.startsWith(calendarMonth);
          const entries = placed.get(day) ?? [];
          const isOver = drag.dragging !== null && drag.over === day;
          const dayLabel = dayLabelFormat.format(dayStart(day));
          return (
            <div
              key={day}
              {...drag.zoneProps(day)}
              data-testid={`calendar-day-${day}`}
              aria-label={dayLabel}
              className={`group flex min-h-24 min-w-0 flex-col border-b border-r border-edge p-1 ${
                isOver ? 'bg-primary-subtle' : inMonth ? '' : 'bg-surface-sunken'
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[11px] ${
                    day === today
                      ? 'bg-primary-subtle font-semibold text-primary-fg-strong'
                      : inMonth
                        ? 'text-fg-secondary'
                        : 'text-fg-faint'
                  }`}
                >
                  {Number(day.slice(8))}
                </span>
                {canCreate && (
                  <IconButton
                    label={t('tables.views.newRecordOnDay', { date: dayLabel })}
                    size="compact"
                    tooltip="top"
                    tooltipMode="portal"
                    className="touch-visible opacity-0 group-hover:opacity-100 focus:opacity-100"
                    onClick={() => onCreateRecord({ [String(startField.id)]: dayValue(day, startField.type) })}
                  >
                    <Plus size={12} />
                  </IconButton>
                )}
              </div>
              <div className="mt-0.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto">
                {entries.map((record) => (
                  <div
                    key={record.id}
                    role="button"
                    tabIndex={0}
                    data-testid={`calendar-record-${record.id}`}
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
                    className={`cursor-pointer select-none truncate rounded bg-primary-subtle px-1.5 py-0.5 text-[11px] text-primary-fg-strong hover:bg-primary-subtle-hover ${
                      drag.dragging?.id === record.id ? 'opacity-40' : ''
                    } ${moves.has(record.id) ? 'animate-pulse' : ''}`}
                  >
                    <RecordTitle record={record} primary={primary} usersById={usersById} />
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {ghost && drag.pointer && (
        <div
          className="pointer-events-none fixed z-50 max-w-60 truncate rounded border border-primary-edge bg-surface-raised px-2 py-1 text-xs font-medium text-fg shadow-lg"
          style={{ left: drag.pointer.x + 12, top: drag.pointer.y + 12 }}
          aria-hidden="true"
        >
          <RecordTitle record={ghost} primary={primary} usersById={usersById} />
        </div>
      )}
    </div>
  );
}
