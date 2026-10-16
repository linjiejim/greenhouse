/**
 * The "⋯" menu and the right-click menu share one panel (docs/design-system/components.md, 菜单):
 * raised surface, radius lg, shadow 2, kept inside the boundary. Arrows move, Enter runs an item,
 * Escape closes and returns focus to the trigger, a letter jumps to the item that starts with it.
 */

import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { icon } from '../tokens/haven';
import { moveFocus, useDismiss, useFloating, type Placement } from './floating';
import { cx, useKitStrings } from './provider';
import { useTooltip } from './tooltip';

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

/** How long a touch press takes to open the right-click menu. */
const LONG_PRESS = 500;
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
  const withIcons = items.some((item) => item !== '-' && (item.icon || item.checked !== undefined));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      moveFocus(panel.current, ITEM, event.key);
    } else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    } else if (event.key === 'Enter' || event.key === ' ') {
      const item = document.activeElement as HTMLElement | null;
      if (!item?.matches(ITEM) || !panel.current?.contains(item)) return;
      event.preventDefault();
      item.click();
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
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
      className="gh-menu-panel"
      style={style}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === '-' ? (
          <div key={`separator-${index}`} role="separator" className="gh-menu-separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            tabIndex={-1}
            role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={item.checked}
            disabled={item.disabled}
            className={cx('gh-menu-item', item.danger && 'is-danger')}
            onClick={() => {
              onClose(true);
              item.onClick();
            }}
          >
            {withIcons && (
              <span className="gh-menu-item-icon">
                {item.checked ? <Check size={icon.md} strokeWidth={icon.stroke} /> : item.icon}
              </span>
            )}
            <span className="gh-menu-item-label">{item.label}</span>
            {item.shortcut && <kbd className="gh-menu-item-shortcut">{item.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

/** A "⋯" (or custom) trigger that opens a menu below it. The trigger's name is also its tooltip. */
export function Menu({
  label,
  items,
  trigger,
  className,
  align = 'end',
}: {
  /** Defaults to 更多 / More. */
  label?: string;
  items: MenuEntry[];
  /** Custom trigger content; defaults to "⋯". */
  trigger?: ReactNode;
  className?: string;
  align?: 'start' | 'end';
}) {
  const t = useKitStrings();
  const name = label ?? t.more;
  const [open, setOpen] = useState<'pointer' | 'keyboard' | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const tip = useTooltip(name, { enabled: !open });
  return (
    <span className={cx('gh-menu', className)}>
      <button
        ref={button}
        type="button"
        className="gh-button gh-button-ghost gh-icon-button gh-menu-trigger"
        aria-label={name}
        aria-haspopup="menu"
        aria-expanded={!!open}
        {...tip.bind({
          onClick: (event: MouseEvent<HTMLButtonElement>) =>
            setOpen(open ? null : event.detail === 0 ? 'keyboard' : 'pointer'),
          onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen('keyboard');
            }
          },
        })}
      >
        {trigger ?? <MoreHorizontal size={icon.md} strokeWidth={icon.stroke} />}
      </button>
      {tip.tooltip}
      {open && (
        <MenuPanel
          label={name}
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
 * Right-click, Shift F10 or the context-menu key, or a 500 ms touch press. Spread `handlers` on
 * the row and render `menu` next to it; the same actions must also sit in the object's own "⋯".
 * A long press that opened the menu does not also activate the row.
 */
export function useContextMenu(items: MenuEntry[] | (() => MenuEntry[]), label?: string) {
  const t = useKitStrings();
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
        setAt({ x: rect.left + rect.height / 2, y: rect.bottom, keyboard: true, origin: event.currentTarget });
      }
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      pressed.current = false;
      if (event.pointerType !== 'touch') return;
      const { clientX, clientY, currentTarget } = event;
      press.current = setTimeout(() => {
        pressed.current = true;
        setAt({ x: clientX, y: clientY, keyboard: false, origin: currentTarget });
      }, LONG_PRESS);
    },
    onPointerUp: cancelPress,
    onPointerCancel: cancelPress,
    onPointerLeave: cancelPress,
    onClickCapture: (event: MouseEvent<HTMLElement>) => {
      if (!pressed.current) return;
      pressed.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
  const menu = at && (
    <MenuPanel
      label={label ?? t.actions}
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
