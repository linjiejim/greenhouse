/**
 * @vitest-environment happy-dom
 */

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DatePicker, DateRangePicker, formatDate, toISO } from '../index';
import { active, byRole, click, get, key, render, setupKit } from './harness';

setupKit();

const thisYear = new Date().getFullYear();
const iso = (month: number, day: number, year = thisYear) => toISO(new Date(year, month - 1, day));

describe('formatDate', () => {
  it('writes this year with the weekday and other years with the year (content.md)', () => {
    const friday = new Date(thisYear, 9, 16);
    const weekday = '日一二三四五六'[friday.getDay()];
    expect(formatDate(iso(10, 16))).toBe(`10 月 16 日 周${weekday}`);
    expect(formatDate('2025-10-03')).toBe('2025 年 10 月 3 日');
    expect(formatDate('')).toBe('');
  });

  it('speaks English when asked', () => {
    expect(formatDate('2025-10-03', 'en')).toBe('Oct 3, 2025');
    const date = new Date(thisYear, 9, 16);
    const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getDay()];
    expect(formatDate(iso(10, 16), 'en')).toBe(`${weekday}, Oct 16`);
  });
});

function Due({ initial, min, onChange }: { initial: string; min?: string; onChange?: (value: string) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DatePicker
      label="截止日期"
      value={value}
      min={min}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}
const trigger = () => get<HTMLButtonElement>('.gh-date-trigger .gh-picker-trigger');
const calendar = () => document.querySelector('[role="dialog"][aria-label="截止日期"]');

describe('DatePicker', () => {
  it('names the trigger with its value and opens on the selected day', () => {
    render(<Due initial={iso(10, 16)} />);
    expect(trigger().getAttribute('aria-label')).toBe(`截止日期：${formatDate(iso(10, 16))}`);
    click(trigger());
    expect(calendar()).not.toBeNull();
    expect(get('.gh-calendar-header strong').textContent).toBe(`${thisYear} 年 10 月`);
    expect(active()?.getAttribute('data-date')).toBe(iso(10, 16));
    expect(get('[data-date].is-selected').getAttribute('data-date')).toBe(iso(10, 16));
    expect(Array.from(document.querySelectorAll('.gh-calendar-weekday')).map((cell) => cell.textContent)).toEqual([
      '一',
      '二',
      '三',
      '四',
      '五',
      '六',
      '日',
    ]);
  });

  it('moves by day, week and month from the keyboard and picks with Enter', () => {
    const onChange = vi.fn();
    render(<Due initial={iso(10, 16)} onChange={onChange} />);
    click(trigger());
    const grid = get('[role="grid"]');
    key(grid, 'ArrowRight');
    expect(active()?.getAttribute('data-date')).toBe(iso(10, 17));
    key(grid, 'ArrowDown');
    expect(active()?.getAttribute('data-date')).toBe(iso(10, 24));
    key(grid, 'PageDown');
    expect(active()?.getAttribute('data-date')).toBe(iso(11, 24));
    expect(get('.gh-calendar-header strong').textContent).toBe(`${thisYear} 年 11 月`);
    key(grid, 'PageUp');
    key(grid, 'ArrowLeft');
    key(grid, 'Enter');
    expect(onChange).toHaveBeenLastCalledWith(iso(10, 23));
    expect(calendar()).toBeNull();
    expect(active()).toBe(trigger());
  });

  it('Home and End go to the ends of the week (Monday first)', () => {
    render(<Due initial={iso(10, 16)} />);
    click(trigger());
    const grid = get('[role="grid"]');
    key(grid, 'Home');
    expect(new Date(`${active()?.getAttribute('data-date')}T00:00`).getDay()).toBe(1);
    key(grid, 'End');
    expect(new Date(`${active()?.getAttribute('data-date')}T00:00`).getDay()).toBe(0);
  });

  it('strikes out days before min and Enter on one does nothing', () => {
    const onChange = vi.fn();
    render(<Due initial={iso(10, 16)} min={iso(10, 12)} onChange={onChange} />);
    click(trigger());
    const before = get<HTMLButtonElement>(`[data-date="${iso(10, 11)}"]`);
    expect(before.getAttribute('aria-disabled')).toBe('true');
    click(before);
    expect(onChange).not.toHaveBeenCalled();
    const grid = get('[role="grid"]');
    for (let step = 0; step < 5; step++) key(grid, 'ArrowLeft');
    expect(active()?.getAttribute('data-date')).toBe(iso(10, 11));
    key(grid, 'Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape closes only the calendar; 今天 and 清除 sit in the footer', () => {
    const onChange = vi.fn();
    render(<Due initial={iso(10, 16)} onChange={onChange} />);
    click(trigger());
    key(get('[role="grid"]'), 'Escape');
    expect(calendar()).toBeNull();
    expect(active()).toBe(trigger());
    click(trigger());
    click(byRole('button', '今天'));
    expect(onChange).toHaveBeenLastCalledWith(toISO(new Date()));
    click(trigger());
    click(byRole('button', '清除'));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect(trigger().getAttribute('aria-label')).toBe('截止日期');
  });
});

describe('DateRangePicker', () => {
  it('takes the start, then the end, in either order', () => {
    const onChange = vi.fn();
    render(<DateRangePicker label="起止日期" start={iso(10, 12)} end={iso(10, 16)} onChange={onChange} />);
    click(get('.gh-date-trigger .gh-picker-trigger'));
    expect(get('.gh-picker-footer-note').textContent).toBe('先选开始日期');
    click(get(`[data-date="${iso(10, 20)}"]`));
    expect(get('.gh-picker-footer-note').textContent).toBe('再选结束日期');
    click(get(`[data-date="${iso(10, 14)}"]`));
    expect(onChange).toHaveBeenCalledWith(iso(10, 14), iso(10, 20));
  });
});
