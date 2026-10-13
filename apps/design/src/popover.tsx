/**
 * Floating layers: the "⋯" menu, the right-click menu and the panel that Select and
 * DatePicker open (docs/design-system/components.md, Menu and ContextMenu).
 * Panels are `position: fixed`, kept inside the product window, and close on an outside
 * pointer, an outside scroll, Escape or Tab.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Check, MoreHorizontal } from 'lucide-react';

export type MenuItem = {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  /** A toggle: shows a check mark when on. */
  checked?: boolean;
};
/** `'-'` draws a separator. Danger items go last, after a separator. */
export type MenuEntry = MenuItem | '-';

type Placement = { rect: () => DOMRect | null; align?: 'start' | 'end'; matchWidth?: boolean };

/** Places a fixed panel under (or above) an anchor rectangle, inside the product window. */
export function useFloating(open: boolean, placement: Placement) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(placement);
  latest.current = placement;
  const [style, setStyle] = useState<CSSProperties>({ position: 'fixed', left: -9999, top: -9999 });
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const { rect: anchor, align = 'start', matchWidth = false } = latest.current;
      const rect = anchor();
      const element = panel.current;
      if (!rect || !element) return;
      if (matchWidth) element.style.minWidth = `${rect.width}px`;
      const frame = (element.closest('.product-window') ?? document.documentElement).getBoundingClientRect();
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      const margin = 8;
      const gap = rect.height ? 4 : 0;
      const left = Math.min(
        Math.max(align === 'end' ? rect.right - width : rect.left, frame.left + margin),
        frame.right - margin - width,
      );
      let top = rect.bottom + gap;
      if (top + height > frame.bottom - margin && rect.top - gap - height >= frame.top + margin)
        top = rect.top - gap - height;
      top = Math.max(Math.min(top, frame.bottom - margin - height), frame.top + margin);
      setStyle({ position: 'fixed', left, top, minWidth: matchWidth ? rect.width : undefined });
    };
    place();
    const resize = new ResizeObserver(place);
    if (panel.current) resize.observe(panel.current);
    window.addEventListener('resize', place);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open]);
  return { panel, style };
}

/** Closes a floating layer on a pointer or scroll outside the given elements. */
export function useDismiss(open: boolean, close: () => void, inside: RefObject<HTMLElement | null>[]) {
  const latest = useRef({ close, inside });
  latest.current = { close, inside };
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (latest.current.inside.some((ref) => ref.current?.contains(event.target as Node))) return;
      latest.current.close();
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('scroll', outside, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('scroll', outside, true);
    };
  }, [open]);
}

/** Arrow keys, Home and End move between the enabled items of a list. */
export function moveFocus(container: HTMLElement | null, selector: string, key: string) {
  const items = Array.from(container?.querySelectorAll<HTMLElement>(selector) ?? []);
  if (!items.length) return;
  const index = items.indexOf(document.activeElement as HTMLElement);
  const next =
    key === 'Home'
      ? 0
      : key === 'End'
        ? items.length - 1
        : key === 'ArrowDown'
          ? (index + 1) % items.length
          : (index - 1 + items.length) % items.length;
  items[next].focus();
}

const ITEM = '[role^="menuitem"]:not(:disabled)';

function MenuPanel({
  label,
  items,
  keyboard,
  placement,
  onClose,
  inside,
}: {
  label: string;
  items: MenuEntry[];
  keyboard: boolean;
  placement: Placement;
  onClose: (restoreFocus: boolean) => void;
  inside?: RefObject<HTMLElement | null>;
}) {
  const { panel, style } = useFloating(true, placement);
  useDismiss(true, () => onClose(false), inside ? [panel, inside] : [panel]);
  useEffect(() => {
    const first = panel.current?.querySelector<HTMLElement>(ITEM);
    if (keyboard && first) first.focus({ preventScroll: true });
    else panel.current?.focus({ preventScroll: true });
  }, [keyboard, panel]);
  const icons = items.some((item) => item !== '-' && (item.icon || item.checked !== undefined));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveFocus(panel.current, ITEM, event.key);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key.length === 1) {
      const match = Array.from(panel.current?.querySelectorAll<HTMLElement>(ITEM) ?? []).find((item) =>
        item.textContent?.trim().toLowerCase().startsWith(event.key.toLowerCase()),
      );
      match?.focus();
    }
  };
  return (
    <div
      ref={panel}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      className="menu-panel"
      style={style}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === '-' ? (
          <div key={`separator-${index}`} role="separator" className="menu-separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            tabIndex={-1}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={`menu-item ${item.danger ? 'danger' : ''}`}
            onClick={() => {
              onClose(true);
              item.onClick();
            }}
          >
            {icons && <span className="menu-item-icon">{item.checked ? <Check size={15} /> : item.icon}</span>}
            <span className="menu-item-label">{item.label}</span>
            {item.shortcut && <kbd className="menu-item-shortcut">{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

/** A "⋯" (or custom) trigger that opens a menu below it. */
export function Menu({
  label = '更多',
  items,
  trigger,
  className = '',
  align = 'end',
}: {
  label?: string;
  items: MenuEntry[];
  /** Custom trigger content; defaults to "⋯". */
  trigger?: ReactNode;
  className?: string;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState<'pointer' | 'keyboard' | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span className={`menu ${className}`}>
      <button
        ref={button}
        type="button"
        className="menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={!!open}
        onClick={(event) => setOpen(open ? null : event.detail === 0 ? 'keyboard' : 'pointer')}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen('keyboard');
          }
        }}
      >
        {trigger ?? <MoreHorizontal size={18} />}
      </button>
      {open && (
        <MenuPanel
          label={label}
          items={items}
          keyboard={open === 'keyboard'}
          inside={button}
          placement={{ rect: () => button.current?.getBoundingClientRect() ?? null, align }}
          onClose={(restore) => {
            setOpen(null);
            if (restore) button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </span>
  );
}

/**
 * Right-click, Shift F10 / the context-menu key, or a long press on touch.
 * Spread `handlers` on the row and render `menu` next to it. The same actions must
 * also be reachable from the item's own "⋯" (in its page header).
 */
export function useContextMenu(items: MenuEntry[] | (() => MenuEntry[]), label = '操作') {
  const [at, setAt] = useState<{ x: number; y: number; keyboard: boolean; origin: HTMLElement } | null>(null);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressed = useRef(false);
  const cancelPress = () => {
    if (press.current) clearTimeout(press.current);
    press.current = null;
  };
  useEffect(() => cancelPress, []);
  const handlers = {
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      event.preventDefault();
      cancelPress();
      setAt({ x: event.clientX, y: event.clientY, keyboard: false, origin: event.currentTarget });
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        setAt({ x: rect.left + 16, y: rect.bottom, keyboard: true, origin: event.currentTarget });
      }
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      pressed.current = false;
      if (event.pointerType !== 'touch') return;
      const { clientX, clientY, currentTarget } = event;
      press.current = setTimeout(() => {
        pressed.current = true;
        setAt({ x: clientX, y: clientY, keyboard: false, origin: currentTarget });
      }, 500);
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    // A long press opened the menu: the click that ends it must not also open the row.
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!pressed.current) return;
      pressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
  const menu = at && (
    <MenuPanel
      label={label}
      items={typeof items === 'function' ? items() : items}
      keyboard={at.keyboard}
      placement={{ rect: () => new DOMRect(at.x, at.y, 0, 0) }}
      onClose={(restore) => {
        const origin = at.origin;
        setAt(null);
        if (restore && origin.isConnected) origin.focus({ preventScroll: true });
      }}
    />
  );
  return { handlers, menu, open: !!at };
}
