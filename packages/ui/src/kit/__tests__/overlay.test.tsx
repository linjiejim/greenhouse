/**
 * @vitest-environment happy-dom
 */

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Button, ConfirmDialog, Input, Overlay, OverlayActions } from '../index';
import { active, advance, byRole, click, focus, get, key, render, setupKit } from './harness';

setupKit();

/** Exit animation before onClose (motion.durationExit). */
const EXIT = 180;

function Drawer({ onClose, beforeClose }: { onClose: () => void; beforeClose?: () => boolean }) {
  return (
    <Overlay title="完善成员邀请流程" onClose={onClose} beforeClose={beforeClose}>
      <Input aria-label="标题" data-autofocus defaultValue="完善成员邀请流程" />
      <OverlayActions>
        <Button>取消</Button>
        <Button kind="primary">保存</Button>
      </OverlayActions>
    </Overlay>
  );
}

function Page({ onClose = () => {}, beforeClose }: { onClose?: () => void; beforeClose?: () => boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        打开记录
      </button>
      {open && (
        <Drawer
          beforeClose={beforeClose}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      )}
    </>
  );
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('Overlay', () => {
  it('moves focus in, keeps the actions in the fixed footer, and returns focus to the opener', () => {
    vi.useFakeTimers();
    render(<Page />);
    const opener = byRole('button', '打开记录');
    focus(opener);
    click(opener);
    advance(0);
    expect(dialog()?.getAttribute('aria-modal')).toBe('true');
    expect(active()?.getAttribute('aria-label')).toBe('标题');
    const footer = get('.gh-overlay-footer');
    expect(Array.from(footer.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['取消', '保存']);
    expect(get('.gh-overlay-body').contains(footer)).toBe(false);
    expect(document.documentElement.style.overflow).toBe('hidden');
    key(active()!, 'Escape');
    advance(EXIT);
    expect(dialog()).toBeNull();
    expect(active()).toBe(opener);
    expect(document.documentElement.style.overflow).toBe('');
  });

  it('keeps Tab inside: past the last control it wraps to the first, and back', () => {
    vi.useFakeTimers();
    render(<Page />);
    click(byRole('button', '打开记录'));
    advance(0);
    const close = byRole('button', '关闭详情');
    const save = byRole('button', '保存');
    focus(save);
    const forward = key(save, 'Tab');
    expect(forward.defaultPrevented).toBe(true);
    expect(active()).toBe(close);
    const back = key(close, 'Tab', { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(active()).toBe(save);
    // Focus that escaped the panel is pulled back in.
    focus(byRole('button', '打开记录'));
    key(active()!, 'Tab');
    expect(dialog()?.contains(active())).toBe(true);
  });

  it('asks beforeClose first: Escape, the scrim and the close button all stay put when it says no', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const beforeClose = vi.fn(() => false);
    render(<Page onClose={onClose} beforeClose={beforeClose} />);
    click(byRole('button', '打开记录'));
    advance(0);
    key(active()!, 'Escape');
    click(get('.gh-scrim'));
    click(byRole('button', '关闭详情'));
    advance(EXIT);
    expect(beforeClose).toHaveBeenCalledTimes(3);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('stacks: Escape closes only the confirmation on top, and focus goes back into the drawer', () => {
    vi.useFakeTimers();
    function Stacked() {
      const [confirming, setConfirming] = useState(false);
      return (
        <>
          <Drawer onClose={() => {}} beforeClose={() => (setConfirming(true), false)} />
          {confirming && (
            <ConfirmDialog
              title="放弃修改？"
              cancelLabel="继续编辑"
              confirmLabel="放弃修改"
              danger
              onCancel={() => setConfirming(false)}
              onConfirm={() => setConfirming(false)}
            >
              未保存的内容会丢失。
            </ConfirmDialog>
          )}
        </>
      );
    }
    render(<Stacked />);
    advance(0);
    const title = active()!;
    expect(title.getAttribute('aria-label')).toBe('标题');
    key(title, 'Escape');
    advance(0);
    const confirm = document.querySelector('[role="alertdialog"]')!;
    expect(confirm).not.toBeNull();
    // The destructive confirmation is solid red; the first focus is on the safe choice.
    expect(byRole('button', '放弃修改').className).toContain('gh-button-solid');
    expect(active()?.textContent).toBe('继续编辑');
    key(active()!, 'Escape');
    advance(EXIT);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(dialog()).not.toBeNull();
    expect(active()).toBe(title);
  });

  it('opens as a dialog when asked, with a plain close label', () => {
    render(
      <Overlay title="信息" variant="dialog" onClose={() => {}}>
        <p>内容</p>
      </Overlay>,
    );
    expect(get('.gh-overlay').className).toContain('gh-overlay-dialog');
    expect(byRole('button', '关闭').getAttribute('aria-label')).toBe('关闭');
    expect(get('.gh-overlay-footer').childElementCount).toBe(0);
  });
});

describe('ConfirmDialog', () => {
  it('runs the action once from its button; an ordinary confirmation is primary and focused', () => {
    vi.useFakeTimers();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog title="把陈晨设为管理员？" confirmLabel="设为管理员" onConfirm={onConfirm} onCancel={() => {}}>
        管理员可以管理成员。
      </ConfirmDialog>,
    );
    advance(0);
    const confirm = byRole('button', '设为管理员');
    expect(confirm.className).toContain('gh-button-primary');
    expect(active()).toBe(confirm);
    click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(byRole('button', '取消')).not.toBeNull();
  });
});
