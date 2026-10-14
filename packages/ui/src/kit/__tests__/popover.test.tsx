/**
 * @vitest-environment happy-dom
 */

import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DatePicker, Popover, Select } from '../index';
import { active, byRole, click, key, render, setupKit } from './harness';

setupKit();

const panel = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('Popover', () => {
  it('opens a panel, moves focus into it, and closes with Escape back to the trigger', () => {
    render(
      <Popover label="筛选" trigger="筛选">
        <input aria-label="值" />
      </Popover>,
    );
    const trigger = byRole('button', '筛选');
    click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(panel()?.getAttribute('aria-label')).toBe('筛选');
    expect(active()?.getAttribute('aria-label')).toBe('值');
    key(active()!, 'Escape');
    expect(panel()).toBeNull();
    expect(active()).toBe(trigger);
  });

  it('closes on a press outside and from inside through the close function', () => {
    render(
      <Popover label="排序" trigger="排序">
        {(close) => (
          <button type="button" onClick={close}>
            完成
          </button>
        )}
      </Popover>,
    );
    click(byRole('button', '排序'));
    click(byRole('button', '完成'));
    expect(panel()).toBeNull();
    click(byRole('button', '排序'));
    expect(panel()).not.toBeNull();
    act(() => {
      document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  it('lets a picker inside it take Escape first', () => {
    function Inner() {
      const [value, setValue] = useState('a');
      return <Select label="字段" value={value} options={['a', 'b']} onChange={setValue} />;
    }
    render(
      <Popover label="分组" trigger="分组">
        <Inner />
      </Popover>,
    );
    click(byRole('button', '分组'));
    const select = byRole('combobox', '字段');
    key(select, 'ArrowDown');
    expect(select.getAttribute('aria-expanded')).toBe('true');
    key(select, 'Escape');
    expect(select.getAttribute('aria-expanded')).toBe('false');
    expect(panel()).not.toBeNull();
  });
});

describe('pickers opened in place', () => {
  it('opens a Select on mount with its trigger focused, and says when it closed', () => {
    const onClose = vi.fn();
    const onChange = vi.fn();
    render(<Select label="状态" value="b" options={['a', 'b']} onChange={onChange} defaultOpen onClose={onClose} />);
    const trigger = byRole('combobox', '状态');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(active()).toBe(trigger);
    key(trigger, 'ArrowUp');
    key(trigger, 'Enter');
    expect(onChange).toHaveBeenCalledWith('a');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens a DatePicker on mount and says when it closed', () => {
    const onClose = vi.fn();
    render(<DatePicker label="截止" value="2026-10-16" onChange={() => {}} defaultOpen onClose={onClose} />);
    expect(document.querySelector('[role="dialog"][aria-label="截止"]')).not.toBeNull();
    key(document.activeElement ?? document.body, 'Escape');
    expect(onClose).toHaveBeenCalled();
  });
});
