/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it } from 'vitest';
import {
  DatePicker,
  Empty,
  Field,
  HelpHint,
  Input,
  KitProvider,
  Menu,
  MultiSelect,
  Overlay,
  SearchInput,
  Select,
  Skeleton,
} from '../index';
import { kitStrings } from '../strings';
import { byRole, click, get, render, setupKit } from './harness';

setupKit();

describe('KitProvider', () => {
  it('speaks zh without a provider', () => {
    render(<Menu items={[]} />);
    expect(byRole('button', '更多')).not.toBeNull();
  });

  it('switches every built-in word to en', () => {
    render(
      <KitProvider locale="en">
        <Menu items={[{ label: 'Open', onClick: () => {} }]} />
        <Select label="Status" value="" options={['Draft']} onChange={() => {}} />
        <MultiSelect label="Members" value={['Ann']} options={['Ann', 'Bo']} onChange={() => {}} />
        <SearchInput value="x" onChange={() => {}} />
        <Field label="Title" required>
          <Input />
        </Field>
        <HelpHint label="Services">Any provider.</HelpHint>
        <Empty />
        <Skeleton />
      </KitProvider>,
    );
    expect(byRole('button', 'More')).not.toBeNull();
    expect(byRole('combobox', 'Status').textContent).toBe('Choose');
    expect(get('input[aria-label="Search"]').getAttribute('placeholder')).toBe('Search');
    expect(byRole('button', 'Clear search')).not.toBeNull();
    expect(get('.gh-field-label-text').textContent).toBe('Title · Required');
    expect(byRole('button', 'About Services')).not.toBeNull();
    expect(get('.gh-empty-title').textContent).toBe('Nothing here yet');
    expect(get('[role="status"]').getAttribute('aria-label')).toBe('Loading');
    click(byRole('combobox', 'Members'));
    expect(get('.gh-picker-footer-note').textContent).toBe('1 selected');
    expect(byRole('button', 'Clear')).not.toBeNull();
  });

  it('writes dates, months and weekdays in en', () => {
    render(
      <KitProvider locale="en">
        <DatePicker label="Due date" value="2025-10-03" onChange={() => {}} />
      </KitProvider>,
    );
    const trigger = get('.gh-date-trigger .gh-picker-trigger');
    expect(trigger.getAttribute('aria-label')).toBe('Due date: Oct 3, 2025');
    click(trigger as HTMLElement);
    expect(get('.gh-calendar-header strong').textContent).toBe('October 2025');
    expect(Array.from(document.querySelectorAll('.gh-calendar-weekday')).map((cell) => cell.textContent)).toEqual([
      'Mo',
      'Tu',
      'We',
      'Th',
      'Fr',
      'Sa',
      'Su',
    ]);
    expect(get('[data-date="2025-10-03"]').getAttribute('aria-label')).toBe('Friday, October 3');
    expect(byRole('button', 'Previous month')).not.toBeNull();
    expect(byRole('button', 'Today')).not.toBeNull();
  });

  it('names the overlay controls in en', () => {
    render(
      <KitProvider locale="en">
        <Overlay title="Record" onClose={() => {}}>
          <p>Body</p>
        </Overlay>
      </KitProvider>,
    );
    expect(byRole('button', 'Close details')).not.toBeNull();
    expect(get('.gh-sheet-handle').getAttribute('aria-label')).toBe('Drag down to close');
  });

  it('has the same words in both languages', () => {
    expect(Object.keys(kitStrings.en).sort()).toEqual(Object.keys(kitStrings.zh).sort());
    expect(kitStrings.en.weekdays).toHaveLength(7);
  });
});
