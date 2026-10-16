/**
 * 日历 (TBL-03): a month, Monday first, with each record on every day from its start to its end.
 * Editors drag a record to another day (its start and end move together) and add one on a day.
 * Narrow screens list the month's days that have records instead.
 */

import '../../styles/tables-boards.css';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { Button, Empty, IconButton, Popover, formatDate } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { isComputedType, type Field, type TableRecord } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { CellValue, shortDay } from './cells';
import { tablesError } from './errors';
import { ViewNeeds } from './Kanban';
import { dayNumber, monthGrid, titleOf, todayIn } from './model';
import {
  CHIP_TYPES,
  DAY_CHIPS,
  agendaDays,
  calendarFields,
  cardFields,
  firstDateField,
  hasValue,
  monthOf,
  moveByDays,
  newOnDay,
  placeRecords,
  shiftMonth,
  timeOfDay,
  type Placed,
} from './boards-model';
import type { ViewProps } from './types';

export function CalendarView(props: ViewProps) {
  const { t } = useI18n();
  const dates = calendarFields(props.fields, props.config);
  if (dates) return <Month {...props} start={dates.start} end={dates.end} />;
  const candidate = firstDateField(props.fields);
  return (
    <ViewNeeds
      glyph={<CalendarDays strokeWidth={icon.stroke} />}
      title={t('tables.viewNeeds.calendar')}
      canBuild={props.canBuild}
      onSetUp={
        candidate &&
        (() => props.onConfig({ ...props.config, calendar: { ...props.config.calendar, start: candidate.id } }))
      }
      onAddField={() => props.onEditField()}
    />
  );
}

function Month(props: ViewProps & { start: Field; end?: Field }) {
  const { start, end, fields, config, data, lookups, narrow, onOpen, onChange, onCreate } = props;
  const canEdit = props.canEdit && !isComputedType(start.type) && !(end && isComputedType(end.type));
  const { t, locale } = useI18n();
  const notify = useNotify();
  const timeZone = lookups.timeZone;
  const today = todayIn(timeZone) || new Date().toISOString().slice(0, 10);
  const [month, setMonth] = useState(() => monthOf(today));
  const days = useMemo(() => monthGrid(month).flat(), [month]);
  const placed = useMemo(
    () => placeRecords(data.items, start, end, timeZone, days),
    [data.items, start, end, timeZone, days],
  );
  const chipFields = useMemo(() => cardFields(fields, config, [], { limit: 2, types: CHIP_TYPES }), [fields, config]);
  const [creating, setCreating] = useState<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drag = useRef<{ id: string; from: string } | null>(null);

  /** A record as a chip on a day: its title, and its time on the day it starts. */
  const describe = ({ record, span }: Placed, day: string) => {
    const title = titleOf(fields, record);
    return {
      title,
      name: title || t('tables.record.untitled'),
      time: span.start === day ? timeOfDay(start, record.values[start.id], timeZone) : '',
    };
  };

  const create = async (day: string) => {
    setCreating(day);
    try {
      const made = await onCreate(newOnDay(start, day, timeZone));
      if (made) onOpen(made.id);
    } finally {
      setCreating(null);
    }
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(null);
    setOver(null);
  };
  const startDrag = (event: DragEvent<HTMLElement>, record: TableRecord, from: string, name: string) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', name);
    drag.current = { id: record.id, from };
    // After the browser has taken the drag image, so the image is not the faded chip.
    requestAnimationFrame(() => {
      if (drag.current?.id === record.id) setDragging(record.id);
    });
  };
  const dropTarget = (day: string) =>
    canEdit
      ? {
          onDragOver(event: DragEvent<HTMLElement>) {
            if (!drag.current || drag.current.from === day) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            setOver(day);
          },
          onDragLeave(event: DragEvent<HTMLElement>) {
            if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
            setOver((current) => (current === day ? null : current));
          },
          onDrop(event: DragEvent<HTMLElement>) {
            const moving = drag.current;
            endDrag();
            if (!moving || moving.from === day) return;
            event.preventDefault();
            const record = data.items.find((item) => item.id === moving.id);
            const values = record && moveByDays(record, start, end, dayNumber(day) - dayNumber(moving.from), timeZone);
            // A conflict is handled by the page; the record goes back to its day on any failure.
            if (record && values) onChange(record, values).catch((error: unknown) => notify(tablesError(error, t)));
          },
        }
      : {};

  const [year, number] = month.split('-').map(Number) as [number, number];
  // English names the month ("October 2026"); Chinese numbers it.
  const name = new Date(Date.UTC(year, number - 1, 1)).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
  const bar = (
    <div className="app-tb-cal-bar">
      <h2 className="app-tb-cal-title" aria-live="polite">
        {t('tables.calendar.month', { year, month: number, name })}
      </h2>
      <Button size="sm" onClick={() => setMonth(monthOf(today))}>
        {t('tables.calendar.today')}
      </Button>
      <IconButton size="sm" label={t('tables.calendar.prev')} onClick={() => setMonth((at) => shiftMonth(at, -1))}>
        <ChevronLeft size={icon.md} strokeWidth={icon.stroke} />
      </IconButton>
      <IconButton size="sm" label={t('tables.calendar.next')} onClick={() => setMonth((at) => shiftMonth(at, 1))}>
        <ChevronRight size={icon.md} strokeWidth={icon.stroke} />
      </IconButton>
    </div>
  );

  if (narrow) {
    const list = agendaDays(placed, days, month);
    return (
      <div className="app-tb-cal is-agenda" role="group" aria-label={t('tables.calendar.label')}>
        {bar}
        {list.length ? (
          <div className="app-tb-cal-agenda">
            {list.map((day) => (
              <section key={day} className="app-tb-cal-agenda-day">
                <h3 className={cx('app-tb-cal-agenda-date', day === today && 'is-today')}>{formatDate(day, locale)}</h3>
                <ul className="app-tb-cal-agenda-list">
                  {(placed.get(day) ?? []).map((entry) => {
                    const { title, name, time } = describe(entry, day);
                    const values = entry.record.values;
                    return (
                      <li key={entry.record.id}>
                        <button type="button" className="app-tb-cal-row" onClick={() => onOpen(entry.record.id)}>
                          {time && <span className="app-tb-cal-time">{time}</span>}
                          <span className={cx('app-tb-cal-row-title', !title && 'is-untitled')}>{name}</span>
                          <span className="app-tb-cal-row-chips">
                            {chipFields
                              .filter((field) => hasValue(field, values[field.id]))
                              .map((field) => (
                                <CellValue key={field.id} field={field} value={values[field.id]} lookups={lookups} />
                              ))}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <Empty icon={<CalendarDays strokeWidth={icon.stroke} />} title={t('tables.calendar.noneThisMonth')} />
        )}
      </div>
    );
  }

  const chip = (entry: Placed, day: string) => {
    const { record, span } = entry;
    const { title, name, time } = describe(entry, day);
    return (
      <div
        key={record.id}
        role="button"
        tabIndex={0}
        className={cx(
          'app-tb-cal-chip',
          span.start < day && 'is-continued',
          span.end > day && 'is-continuing',
          !title && 'is-untitled',
          dragging === record.id && 'is-dragging',
        )}
        draggable={canEdit}
        onClick={() => onOpen(record.id)}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen(record.id);
        }}
        onDragStart={(event) => (canEdit ? startDrag(event, record, day, name) : event.preventDefault())}
        onDragEnd={endDrag}
      >
        {time && <span className="app-tb-cal-time">{time}</span>}
        <span className="app-tb-cal-chip-title">{name}</span>
      </div>
    );
  };

  return (
    <div className="app-tb-cal" role="group" aria-label={t('tables.calendar.label')}>
      {bar}
      <div className="app-tb-cal-month">
        <div className="app-tb-cal-weekdays" aria-hidden>
          {t('tables.calendar.weekdays')
            .split(',')
            .map((name) => (
              <span key={name} className="app-tb-cal-weekday">
                {name}
              </span>
            ))}
        </div>
        <div className="app-tb-cal-grid">
          {days.map((day) => {
            const entries = placed.get(day) ?? [];
            const label = shortDay(day, locale);
            const isToday = day === today;
            return (
              <div
                key={day}
                role="group"
                aria-label={label}
                className={cx(
                  'app-tb-cal-day',
                  monthOf(day) !== month && 'is-outside',
                  isToday && 'is-today',
                  over === day && 'is-over',
                )}
                {...dropTarget(day)}
              >
                <div className="app-tb-cal-day-head">
                  <span className="app-tb-cal-date" aria-current={isToday ? 'date' : undefined}>
                    {day.endsWith('-01') ? label : Number(day.slice(8))}
                  </span>
                  {canEdit && (
                    <IconButton
                      size="sm"
                      className="app-tb-cal-add"
                      label={t('tables.calendar.add', { date: label })}
                      loading={creating === day}
                      onClick={() => void create(day)}
                    >
                      <Plus size={icon.sm} strokeWidth={icon.stroke} />
                    </IconButton>
                  )}
                </div>
                <div className="app-tb-cal-chips">
                  {entries.slice(0, DAY_CHIPS).map((entry) => chip(entry, day))}
                  {entries.length > DAY_CHIPS && (
                    <Popover
                      className="app-tb-cal-more"
                      size="sm"
                      label={t('tables.calendar.dayRecords', { date: formatDate(day, locale) })}
                      trigger={t('tables.calendar.more', { count: entries.length - DAY_CHIPS })}
                    >
                      {(close) => (
                        <div className="app-tb-cal-pop">
                          <span className="app-tb-cal-pop-title">{formatDate(day, locale)}</span>
                          {entries.map((entry) => {
                            const { title, name, time } = describe(entry, day);
                            return (
                              <button
                                key={entry.record.id}
                                type="button"
                                className={cx('app-tb-cal-chip', !title && 'is-untitled')}
                                onClick={() => {
                                  close();
                                  onOpen(entry.record.id);
                                }}
                              >
                                {time && <span className="app-tb-cal-time">{time}</span>}
                                <span className="app-tb-cal-chip-title">{name}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </Popover>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
