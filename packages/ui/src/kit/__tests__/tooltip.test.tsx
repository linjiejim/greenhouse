/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from 'vitest';
import { HelpHint, IconButton, Tooltip } from '../index';
import { TOOLTIP_DELAY } from '../tooltip';
import { advance, byRole, click, focus, key, pointer, render, setupKit } from './harness';

setupKit();

const tooltip = () => document.querySelector<HTMLElement>('.gh-tooltip');

describe('Tooltip on an IconButton', () => {
  it('replaces the native title: the label shows after 500 ms of hover and leaves with the pointer', () => {
    vi.useFakeTimers();
    render(<IconButton label="关闭详情">×</IconButton>);
    const button = byRole('button', '关闭详情');
    expect(button.hasAttribute('title')).toBe(false);
    pointer(button, 'pointerover');
    advance(TOOLTIP_DELAY - 1);
    expect(tooltip()).toBeNull();
    advance(1);
    expect(tooltip()?.textContent).toBe('关闭详情');
    expect(tooltip()?.getAttribute('role')).toBe('tooltip');
    // It repeats the accessible name, so it stays out of the accessibility tree.
    expect(tooltip()?.getAttribute('aria-hidden')).toBe('true');
    pointer(button, 'pointerout');
    expect(tooltip()).toBeNull();
  });

  it('shows at once on keyboard focus and Escape hides it without reaching what is behind', () => {
    const behind = vi.fn();
    const drawer = (event: KeyboardEvent) => event.key === 'Escape' && behind();
    document.addEventListener('keydown', drawer);
    render(<IconButton label="电脑">□</IconButton>);
    const button = byRole('button', '电脑');
    focus(button);
    expect(tooltip()?.textContent).toBe('电脑');
    key(button, 'Escape');
    expect(tooltip()).toBeNull();
    expect(behind).not.toHaveBeenCalled();
    // With nothing showing, Escape goes through as usual.
    key(button, 'Escape');
    expect(behind).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', drawer);
  });

  it('never shows for touch, and a press hides it until the pointer leaves', () => {
    vi.useFakeTimers();
    render(<IconButton label="附件">+</IconButton>);
    const button = byRole('button', '附件');
    pointer(button, 'pointerover', 'touch');
    advance(TOOLTIP_DELAY * 2);
    expect(tooltip()).toBeNull();
    pointer(button, 'pointerdown', 'touch');
    focus(button);
    expect(tooltip()).toBeNull();
    pointer(button, 'pointerout', 'touch');
    pointer(button, 'pointerover');
    advance(TOOLTIP_DELAY);
    expect(tooltip()).not.toBeNull();
    pointer(button, 'pointerdown');
    expect(tooltip()).toBeNull();
  });

  it('a disabled reason keeps the button focusable and becomes its description', () => {
    const onClick = vi.fn();
    render(
      <IconButton label="上传" disabled disabledReason="只有拥有者可以上传" onClick={onClick}>
        ↑
      </IconButton>,
    );
    const button = byRole('button', '上传');
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    focus(button);
    expect(tooltip()?.textContent).toBe('上传 · 只有拥有者可以上传');
    expect(button.getAttribute('aria-describedby')).toBe(tooltip()?.id);
    click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('Tooltip around any trigger', () => {
  it('describes a trigger whose name differs and keeps the trigger’s own handlers', () => {
    const onFocus = vi.fn();
    render(
      <Tooltip label="回到主线" side="right">
        <button type="button" aria-label="Greenhouse" onFocus={onFocus}>
          ◆
        </button>
      </Tooltip>,
    );
    const button = byRole('button', 'Greenhouse');
    focus(button);
    expect(onFocus).toHaveBeenCalledTimes(1);
    expect(tooltip()?.textContent).toBe('回到主线');
    expect(button.getAttribute('aria-describedby')).toBe(tooltip()?.id);
  });
});

describe('HelpHint', () => {
  it('opens on a click, names itself 说明：…, and Escape closes it', () => {
    render(<HelpHint label="服务">每种能力都可以换成任意服务商。</HelpHint>);
    const button = byRole('button', '说明：服务');
    click(button);
    expect(document.querySelector('.gh-help-hint-bubble')?.textContent).toBe('每种能力都可以换成任意服务商。');
    expect(button.getAttribute('aria-expanded')).toBe('true');
    key(button, 'Escape');
    expect(document.querySelector('.gh-help-hint-bubble')).toBeNull();
  });
});
