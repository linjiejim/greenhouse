/**
 * ⓘ beside a title, a label or a figure (DESIGN.md Copy): what the page should not say all the time,
 * such as what a page is for or how a number is counted. Pointing at it opens it after a moment
 * (90 ms; leaving closes it after 180 ms, so the pointer can cross into the panel); a click, a tap or
 * Enter pins it open until a click elsewhere or Escape. Not a tooltip: touch screens have no hover.
 * Text only, so focus stays on the ⓘ and the open text is its description.
 */
import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './core.web';
import { useT } from '../lib/i18n';

const OPEN_MS = 90;
const CLOSE_MS = 180;

export function Info({
  children,
  label,
  className = 'gh-info',
  iconSize = 14,
}: {
  children: React.ReactNode;
  /** The ⓘ's accessible name; defaults to 说明 (common.about). */
  label?: string;
  /** `gh-info` is the 20 inline ⓘ (44 to a finger); a bar passes `gh-icon-button`. */
  className?: string;
  iconSize?: number;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // opened by a click, a tap or Enter: the pointer leaving does not close it
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const textId = useId();
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);

  const hover = (e: React.PointerEvent, on: boolean) => {
    if (e.pointerType !== 'mouse' || pinned.current) return;
    cancel();
    timer.current = setTimeout(() => setOpen(on), on ? OPEN_MS : CLOSE_MS);
  };

  // under the ⓘ (above it when there is no room), inside the window, measured as rendered
  useLayoutEffect(() => {
    const root = panel.current;
    const anchor = button.current?.getBoundingClientRect();
    if (!open || !root || !anchor) return;
    const box = root.getBoundingClientRect();
    root.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - box.width - 8))}px`;
    const below = anchor.bottom + 4;
    root.style.top = `${below + box.height + 8 > innerHeight ? Math.max(8, anchor.top - box.height - 4) : below}px`;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = () => {
      cancel();
      pinned.current = false;
      setOpen(false);
    };
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target)) close();
    };
    // on the window, ahead of a dialog's own Escape (overlay.web.tsx listens on the document): one
    // Escape closes one layer
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    // the panel is placed once; a scroll or resize would leave it behind
    const away = (e: Event) => {
      if (!(e.target instanceof Node && panel.current?.contains(e.target))) close();
    };
    window.addEventListener('keydown', key, true);
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', away, true);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', away, true);
      window.removeEventListener('resize', away);
    };
  }, [open]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={className}
        aria-label={label ?? t('common.about')}
        aria-expanded={open}
        // the text is portaled away from the ⓘ: it describes the ⓘ while open
        aria-describedby={open ? textId : undefined}
        onPointerEnter={(e) => hover(e, true)}
        onPointerLeave={(e) => hover(e, false)}
        onClick={() => {
          cancel();
          // a click on an ⓘ opened by pointing pins it; a click on a pinned one closes it
          const close = open && pinned.current;
          pinned.current = !close;
          setOpen(!close);
        }}
      >
        <Icon name="info" size={iconSize} />
      </button>
      {open && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={panel}
              id={textId}
              className="gh-info-panel"
              data-testid="info-panel"
              onPointerEnter={(e) => hover(e, true)}
              onPointerLeave={(e) => hover(e, false)}
            >
              {children}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
