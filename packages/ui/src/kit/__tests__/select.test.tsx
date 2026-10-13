/**
 * @vitest-environment happy-dom
 */

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { MultiSelect, Select, type SelectOption } from '../index';
import { active, byRole, click, get, key, render, setupKit } from './harness';

setupKit();

function Controlled({
  options,
  initial = '',
  onChange,
}: {
  options: SelectOption[];
  initial?: string;
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Select
      label="状态"
      value={value}
      options={options}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const STATUSES = ['待处理', '进行中', '已完成'];
const trigger = () => byRole('combobox', '状态');
const listbox = () => document.querySelector('[role="listbox"]');
const activeOption = () => document.getElementById(trigger().getAttribute('aria-activedescendant') ?? '');

describe('Select', () => {
  it('opens from the keyboard on the current value, moves, and picks with Enter', () => {
    const onChange = vi.fn();
    render(<Controlled options={STATUSES} initial="进行中" onChange={onChange} />);
    trigger().focus();
    key(trigger(), 'ArrowDown');
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
    expect(activeOption()?.textContent).toBe('进行中');
    key(trigger(), 'ArrowDown');
    expect(activeOption()?.textContent).toBe('已完成');
    key(trigger(), 'ArrowDown');
    expect(activeOption()?.textContent).toBe('待处理'); // wraps
    key(trigger(), 'End');
    key(trigger(), 'Enter');
    expect(onChange).toHaveBeenLastCalledWith('已完成');
    expect(listbox()).toBeNull();
    expect(trigger().textContent).toBe('已完成');
    expect(active()).toBe(trigger());
  });

  it('picks with Space and skips disabled options', () => {
    const onChange = vi.fn();
    render(
      <Controlled
        options={['草稿', { value: 'locked', label: '锁定', disabled: true }, '已发布']}
        initial="草稿"
        onChange={onChange}
      />,
    );
    key(trigger(), 'ArrowDown');
    key(trigger(), 'ArrowDown');
    expect(activeOption()?.textContent).toBe('已发布');
    key(trigger(), ' ');
    expect(onChange).toHaveBeenLastCalledWith('已发布');
  });

  it('Escape closes only the list: the event stops before an enclosing drawer sees it', () => {
    const outer = vi.fn();
    const drawer = (event: KeyboardEvent) => event.key === 'Escape' && outer();
    document.addEventListener('keydown', drawer);
    render(<Controlled options={STATUSES} initial="待处理" />);
    key(trigger(), 'ArrowDown');
    expect(listbox()).not.toBeNull();
    const escape = key(trigger(), 'Escape');
    expect(listbox()).toBeNull();
    expect(escape.defaultPrevented).toBe(true);
    expect(outer).not.toHaveBeenCalled();
    expect(active()).toBe(trigger());
    document.removeEventListener('keydown', drawer);
  });

  it('jumps to the next option starting with a typed letter while closed', () => {
    const onChange = vi.fn();
    render(<Controlled options={['Alpha', 'Beta', 'Bravo', 'Charlie']} initial="Alpha" onChange={onChange} />);
    key(trigger(), 'b');
    expect(onChange).toHaveBeenLastCalledWith('Beta');
    key(trigger(), 'b');
    expect(onChange).toHaveBeenLastCalledWith('Bravo');
    key(trigger(), 'b');
    expect(onChange).toHaveBeenLastCalledWith('Beta'); // wraps past the end
    expect(listbox()).toBeNull();
  });

  it('a pointer click opens it, marks the selected option and picks', () => {
    render(<Controlled options={STATUSES} initial="待处理" />);
    click(trigger());
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    click(options[2]);
    expect(trigger().textContent).toBe('已完成');
    expect(listbox()).toBeNull();
  });

  it('gets a search field past eight options and filters by label and description', () => {
    const options = Array.from({ length: 9 }, (_, index) => ({
      value: `m${index}`,
      label: `Model ${index}`,
      description: index === 4 ? 'reasoning' : 'fast',
    }));
    render(<Controlled options={options} initial="m0" />);
    click(trigger());
    const search = get<HTMLInputElement>('.gh-picker-search input');
    expect(active()).toBe(search);
    // React reads the native value setter, so set it through the prototype like a user would.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'reason');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(Array.from(document.querySelectorAll('[role="option"]')).map((option) => option.textContent)).toEqual([
      'Model 4reasoning',
    ]);
  });

  it('shows the placeholder and the invalid state', () => {
    render(<Select label="分组" value="" options={['产品组']} onChange={() => {}} aria-invalid />);
    const button = byRole('combobox', '分组');
    expect(button.getAttribute('aria-invalid')).toBe('true');
    expect(get('.gh-picker-value').className).toContain('is-placeholder');
    expect(get('.gh-picker-value').textContent).toBe('请选择');
  });
});

describe('MultiSelect', () => {
  function Members() {
    const [value, setValue] = useState(['陈晨', '周宁', '王芳']);
    return <MultiSelect label="成员" value={value} options={['林杰', '陈晨', '周宁', '王芳']} onChange={setValue} />;
  }
  const multi = () => byRole('combobox', '成员');
  const chips = () => Array.from(document.querySelectorAll('.gh-chip')).map((chip) => chip.textContent);

  it('shows the first two values and +N', () => {
    render(<Members />);
    expect(chips()).toEqual(['陈晨', '周宁', '+1']);
  });

  it('stays open while toggling with Enter, and Backspace in the empty search removes the last value', () => {
    render(<Members />);
    click(multi());
    const search = get<HTMLInputElement>('.gh-picker-search input');
    key(search, 'Enter'); // the first option, 林杰, on
    expect(listbox()).not.toBeNull();
    expect(chips()).toEqual(['林杰', '陈晨', '+2']); // chips follow the option order
    key(search, 'ArrowDown');
    key(search, 'Enter'); // 陈晨 off
    expect(chips()).toEqual(['林杰', '周宁', '+1']);
    key(search, 'Backspace'); // the last one added, 林杰
    expect(chips()).toEqual(['周宁', '王芳']);
    expect(get('.gh-picker-footer-note').textContent).toBe('已选 2');
  });

  it('clears everything from the footer and Escape returns to the trigger', () => {
    render(<Members />);
    click(multi());
    click(byRole('button', '清除'));
    expect(chips()).toEqual([]);
    expect(get('.gh-picker-value').textContent).toBe('请选择');
    key(get('.gh-picker-search input'), 'Escape');
    expect(listbox()).toBeNull();
    expect(active()).toBe(multi());
  });

  it('says when the list closes, with everything picked while it was open', () => {
    const closed: string[][] = [];
    function Saving() {
      const [value, setValue] = useState<string[]>([]);
      return (
        <MultiSelect
          label="成员"
          value={value}
          options={['林杰', '陈晨']}
          onChange={setValue}
          onClose={() => closed.push(value)}
        />
      );
    }
    render(<Saving />);
    click(multi());
    const search = get<HTMLInputElement>('.gh-picker-search input');
    key(search, 'Enter');
    key(search, 'ArrowDown');
    key(search, 'Enter');
    expect(closed).toEqual([]);
    key(search, 'Escape');
    expect(closed).toEqual([['林杰', '陈晨']]);
    click(multi());
    click(multi());
    expect(closed).toEqual([
      ['林杰', '陈晨'],
      ['林杰', '陈晨'],
    ]);
  });
});
