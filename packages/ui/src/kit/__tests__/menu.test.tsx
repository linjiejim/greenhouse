/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from 'vitest';
import { Menu, useContextMenu, type MenuEntry } from '../index';
import { act } from 'react';
import { active, byRole, click, key, render, setupKit } from './harness';

setupKit();

const items = (log: string[]): MenuEntry[] => [
  { label: '打开', onClick: () => log.push('打开') },
  { label: '复制', onClick: () => log.push('复制') },
  { label: '没有权限', disabled: true, onClick: () => log.push('没有权限') },
  { label: '置顶', checked: true, onClick: () => log.push('置顶') },
  '-',
  { label: '删除', danger: true, onClick: () => log.push('删除') },
];
const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
const focusedItem = () => active()?.textContent;

describe('Menu', () => {
  it('opens from the keyboard on the first item and moves with the arrows, skipping disabled items', () => {
    render(<Menu items={items([])} />);
    const trigger = byRole('button', '更多');
    trigger.focus();
    key(trigger, 'ArrowDown');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(menu()?.getAttribute('aria-label')).toBe('更多');
    expect(focusedItem()).toBe('打开');
    key(active()!, 'ArrowDown');
    expect(focusedItem()).toBe('复制');
    key(active()!, 'ArrowDown');
    expect(focusedItem()).toBe('置顶'); // 没有权限 is disabled
    key(active()!, 'End');
    expect(focusedItem()).toBe('删除');
    key(active()!, 'ArrowDown');
    expect(focusedItem()).toBe('打开'); // wraps
  });

  it('runs an item with Enter, closes and returns focus to the trigger', () => {
    const log: string[] = [];
    render(<Menu items={items(log)} />);
    const trigger = byRole('button', '更多');
    trigger.focus();
    key(trigger, 'ArrowDown');
    key(active()!, 'ArrowDown');
    key(active()!, 'Enter');
    expect(log).toEqual(['复制']);
    expect(menu()).toBeNull();
    expect(active()).toBe(trigger);
  });

  it('Escape closes without running anything, stops there, and returns focus', () => {
    const log: string[] = [];
    const outer = vi.fn();
    const drawer = (event: KeyboardEvent) => event.key === 'Escape' && outer();
    document.addEventListener('keydown', drawer);
    render(<Menu items={items(log)} />);
    const trigger = byRole('button', '更多');
    trigger.focus();
    key(trigger, 'ArrowDown');
    key(active()!, 'Escape');
    expect(menu()).toBeNull();
    expect(log).toEqual([]);
    expect(outer).not.toHaveBeenCalled();
    expect(active()).toBe(trigger);
    document.removeEventListener('keydown', drawer);
  });

  it('jumps to the item that starts with a typed letter', () => {
    render(
      <Menu
        items={[
          { label: 'Open', onClick: () => {} },
          { label: 'Copy link', onClick: () => {} },
          { label: 'Delete', onClick: () => {} },
        ]}
      />,
    );
    const trigger = byRole('button', '更多');
    key(trigger, 'ArrowDown');
    key(active()!, 'd');
    expect(focusedItem()).toBe('Delete');
  });

  it('marks toggles, danger items and separators', () => {
    render(<Menu items={items([])} label="会话操作" />);
    const trigger = byRole('button', '会话操作');
    click(trigger);
    expect(byRole('menuitemcheckbox', '置顶').getAttribute('aria-checked')).toBe('true');
    expect(byRole('menuitem', '删除').className).toContain('is-danger');
    expect(byRole('menuitem', '没有权限').hasAttribute('disabled')).toBe(true);
    expect(document.querySelectorAll('[role="separator"]')).toHaveLength(1);
    click(trigger);
    expect(menu()).toBeNull();
  });
});

function Row({ log }: { log: string[] }) {
  const context = useContextMenu(items(log), '客户反馈的操作');
  return (
    <>
      <button type="button" {...context.handlers} onClick={() => log.push('row')}>
        客户反馈
      </button>
      {context.menu}
    </>
  );
}

describe('useContextMenu', () => {
  it('Shift F10 opens the same panel on the first item; Escape returns focus to the row', () => {
    const log: string[] = [];
    render(<Row log={log} />);
    const row = byRole('button', '客户反馈');
    row.focus();
    key(row, 'F10', { shiftKey: true });
    expect(menu()?.getAttribute('aria-label')).toBe('客户反馈的操作');
    expect(focusedItem()).toBe('打开');
    key(active()!, 'Escape');
    expect(menu()).toBeNull();
    expect(active()).toBe(row);
    expect(log).toEqual([]);
  });

  it('the context-menu key opens it too, and an item runs once', () => {
    const log: string[] = [];
    render(<Row log={log} />);
    const row = byRole('button', '客户反馈');
    row.focus();
    key(row, 'ContextMenu');
    click(byRole('menuitem', '删除'));
    expect(log).toEqual(['删除']);
    expect(menu()).toBeNull();
  });
});

describe('dismissal on scroll', () => {
  it('stays open when something else scrolls, and closes when its anchor scrolls away', () => {
    render(
      <div>
        <div className="thread" style={{ overflow: 'auto' }}>
          <p>a thread that pins itself to the bottom</p>
        </div>
        <div className="toolbar" style={{ overflow: 'auto' }}>
          <Menu items={items([])} />
        </div>
      </div>,
    );
    const trigger = byRole('button', '更多');
    trigger.focus();
    key(trigger, 'ArrowDown');
    expect(menu()).not.toBeNull();
    act(() => {
      document.querySelector('.thread')!.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).not.toBeNull();
    act(() => {
      document.querySelector('.toolbar')!.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).toBeNull();

    key(trigger, 'ArrowDown');
    expect(menu()).not.toBeNull();
    act(() => {
      document.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).toBeNull();
  });

  it('stays open for a scroll that left its anchor in place (one reported late), and closes when it moves', () => {
    render(
      <div className="drawer" style={{ overflow: 'auto' }}>
        <Menu items={items([])} />
      </div>,
    );
    const trigger = byRole('button', '更多');
    let top = 300;
    trigger.getBoundingClientRect = () => new DOMRect(10, top, 32, 32);
    trigger.focus();
    key(trigger, 'ArrowDown');
    act(() => {
      document.querySelector('.drawer')!.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).not.toBeNull();
    top = 260;
    act(() => {
      document.querySelector('.drawer')!.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).toBeNull();
  });

  it('stays open when a scroll moves its anchor but keeps it in view (an option brought into view)', () => {
    render(
      <div className="drawer" style={{ overflow: 'auto' }}>
        <Menu items={items([])} />
      </div>,
    );
    const drawer = document.querySelector('.drawer')!;
    drawer.getBoundingClientRect = () => new DOMRect(0, 100, 400, 500);
    const trigger = byRole('button', '更多');
    let top = 300;
    trigger.getBoundingClientRect = () => new DOMRect(10, top, 32, 32);
    trigger.focus();
    key(trigger, 'ArrowDown');
    top = 200;
    act(() => {
      drawer.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).not.toBeNull();
    top = 40;
    act(() => {
      drawer.dispatchEvent(new Event('scroll'));
    });
    expect(menu()).toBeNull();
  });
});
