/** @vitest-environment happy-dom */

/**
 * The calendar body under real pointer gestures: records sit on the local day
 * of their date and span to the end date, dragging one to another day is one
 * write that moves start and end together (a datetime keeps its time of day),
 * a day's "+" creates a record on that day, and the month controls ask the
 * container for another window.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CalendarViewBody, dayValue, shiftDateValue } from './calendar';
import { bodyProps, dragTo, fixtureField, fixtureRecord, mountBody, type MountedBody } from './view-test-fixtures';
import { dayStart } from './view-query';

const primary = fixtureField(1, 'Name', 'text');
const due = fixtureField(2, 'Due', 'date');
const ends = fixtureField(3, 'Ends', 'date');
const meeting = fixtureField(4, 'Meeting', 'datetime');

let mounted: MountedBody | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

const day = (value: string) => mounted!.container.querySelector(`[data-testid="calendar-day-${value}"]`)!;
const chips = (value: string) =>
  [...day(value).querySelectorAll('[data-testid^="calendar-record-"]')].map((chip) => chip.textContent);

describe('CalendarViewBody', () => {
  it('places records on their days, spanning to the end date', async () => {
    const props = bodyProps({
      config: { calendar: { startFieldId: due.id, endFieldId: ends.id } },
      schemaFields: [primary, due, ends],
      records: [
        fixtureRecord(5, { '1': 'Launch', '2': '2026-10-14', '3': '2026-10-16' }),
        fixtureRecord(6, { '1': 'Review', '2': '2026-10-14' }),
        fixtureRecord(7, { '1': 'No date' }),
      ],
    });
    mounted = await mountBody(CalendarViewBody, props);

    expect(mounted.container.querySelector('[data-testid="calendar-month"]')?.textContent).toBe('October 2026');
    expect(chips('2026-10-14')).toEqual(['Launch', 'Review']);
    expect(chips('2026-10-15')).toEqual(['Launch']);
    expect(chips('2026-10-16')).toEqual(['Launch']);
    expect(chips('2026-10-17')).toEqual([]);
    expect(mounted.container.textContent).not.toContain('No date');
  });

  it('moves a record to another day with one write that keeps its duration', async () => {
    const launch = fixtureRecord(5, { '1': 'Launch', '2': '2026-10-14', '3': '2026-10-16' }, { revision: 4 });
    const props = bodyProps({
      config: { calendar: { startFieldId: due.id, endFieldId: ends.id } },
      schemaFields: [primary, due, ends],
      records: [launch],
    });
    mounted = await mountBody(CalendarViewBody, props);

    const chip = day('2026-10-14').querySelector('[data-testid="calendar-record-5"]')!;
    await dragTo(chip, day('2026-10-20'));

    expect(props.onCommitValues).toHaveBeenCalledTimes(1);
    expect(props.onCommitValues).toHaveBeenCalledWith(launch, { '2': '2026-10-20', '3': '2026-10-22' });
    expect(props.onOpenRecord).not.toHaveBeenCalled();
  });

  it('keeps a datetime’s time of day and drags only with edit rights', async () => {
    const at = dayStart('2026-10-14');
    at.setHours(15, 30);
    const call = fixtureRecord(8, { '1': 'Call', '4': at.toISOString() });
    const props = bodyProps({
      config: { calendar: { startFieldId: meeting.id } },
      schemaFields: [primary, meeting],
      records: [call],
    });
    mounted = await mountBody(CalendarViewBody, props);
    await dragTo(day('2026-10-14').querySelector('[data-testid="calendar-record-8"]')!, day('2026-10-12'));
    const moved = new Date(dayStart('2026-10-12'));
    moved.setHours(15, 30);
    expect(props.onCommitValues).toHaveBeenCalledWith(call, { '4': moved.toISOString() });

    const readOnly = bodyProps({
      ...props,
      onCommitValues: vi.fn(async () => undefined),
      permissions: { canEdit: false, canCreate: false, canBuild: false, canChangeView: false },
    });
    await mounted.rerender(readOnly);
    await dragTo(day('2026-10-14').querySelector('[data-testid="calendar-record-8"]')!, day('2026-10-13'));
    expect(readOnly.onCommitValues).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('button[aria-label^="New record on"]')).toBeNull();
  });

  it('follows a custom role’s field rights: no drag without the start and end, no "+" without the start', async () => {
    const launch = fixtureRecord(5, { '1': 'Launch', '2': '2026-10-14', '3': '2026-10-16' });
    const rights = (writable: number[]) => ({
      canEdit: true,
      canCreate: true,
      canBuild: false,
      canChangeView: false,
      canEditField: (fieldId: number) => writable.includes(fieldId),
    });
    const props = bodyProps({
      config: { calendar: { startFieldId: due.id, endFieldId: ends.id } },
      schemaFields: [primary, due, ends],
      records: [launch],
      permissions: rights([primary.id, due.id]),
    });
    mounted = await mountBody(CalendarViewBody, props);
    // The end is read-only: moving would change the duration or be refused.
    await dragTo(day('2026-10-14').querySelector('[data-testid="calendar-record-5"]')!, day('2026-10-20'));
    expect(props.onCommitValues).not.toHaveBeenCalled();
    expect(mounted.container.querySelector('button[aria-label^="New record on"]')).not.toBeNull();

    const noStart = bodyProps({ ...props, permissions: rights([primary.id, ends.id]) });
    await mounted.rerender(noStart);
    expect(mounted.container.querySelector('button[aria-label^="New record on"]')).toBeNull();
  });

  it('creates a record on a day and pages by month', async () => {
    const props = bodyProps({
      config: { calendar: { startFieldId: due.id } },
      schemaFields: [primary, due],
      records: [],
    });
    mounted = await mountBody(CalendarViewBody, props);

    await act(async () =>
      (day('2026-10-09').querySelector('button[aria-label="New record on October 9"]') as HTMLButtonElement).click(),
    );
    expect(props.onCreateRecord).toHaveBeenCalledWith({ '2': '2026-10-09' });

    await act(async () =>
      (mounted!.container.querySelector('button[aria-label="Next month"]') as HTMLButtonElement).click(),
    );
    expect(props.onCalendarMonthChange).toHaveBeenCalledWith('2026-11');
  });

  it('shifts stored values by local days', () => {
    expect(shiftDateValue('2026-10-31', 'date', 1)).toBe('2026-11-01');
    expect(shiftDateValue('', 'date', 1)).toBeNull();
    expect(dayValue('2026-10-09', 'date')).toBe('2026-10-09');
    expect(dayValue('2026-10-09', 'datetime')).toBe(dayStart('2026-10-09').toISOString());
  });
});
