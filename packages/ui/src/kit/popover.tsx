/**
 * A panel of controls opened from a button: a view's filter, sort, group and fields
 * (docs/design-system/components.md, 浮层面板). Same surface as menus: raised, radius lg,
 * shadow 2, kept inside the boundary. Focus moves into the panel; Escape closes it and returns
 * focus to the trigger; a press outside, a scroll that moves the trigger, or Tab out of it
 * closes it. Pickers inside it keep their own Escape.
 */

import { useEffect, useRef, useState, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button, type ButtonKind } from './controls';
import { useDismiss, useFloating } from './floating';
import { cx } from './provider';

const FOCUSABLE =
  'input:not(:disabled), textarea:not(:disabled), button:not(:disabled), [tabindex="0"], a[href], select:not(:disabled)';

export function Popover({
  label,
  trigger,
  children,
  kind = 'ghost',
  size = 'md',
  align = 'start',
  className,
  wide = false,
}: {
  /** The panel's accessible name; also the trigger's when its content is only an icon. */
  label: string;
  /** The trigger's content: an icon and a word, a count. */
  trigger: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  /** secondary when what it controls is on (a filter in force). */
  kind?: ButtonKind;
  size?: 'sm' | 'md';
  align?: 'start' | 'end';
  className?: string;
  /** Twice the menu width, for rows of controls (a filter clause). */
  wide?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const { panel, style } = useFloating(open, {
    rect: () => button.current?.getBoundingClientRect() ?? null,
    align,
  });
  const close = (restore = true) => {
    setOpen(false);
    if (restore) button.current?.focus({ preventScroll: true });
  };
  useDismiss(open, () => close(false), [panel, button]);
  useEffect(() => {
    if (!open) return;
    const element = panel.current;
    const first = element?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? element)?.focus({ preventScroll: true });
  }, [open, panel]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  // Tab out of the panel closes it, focus stays where Tab took it.
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || panel.current?.contains(next) || button.current?.contains(next)) return;
    close(false);
  };

  return (
    <span className={cx('gh-popover-anchor', className)}>
      <Button
        ref={button}
        kind={kind}
        size={size}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {trigger}
      </Button>
      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
          className={cx('gh-popover', wide && 'is-wide')}
          style={style}
          onKeyDown={onKeyDown}
          onBlur={onBlur}
        >
          {typeof children === 'function' ? children(() => close()) : children}
        </div>
      )}
    </span>
  );
}
