/**
 * Short labels and the "?" (docs/design-system/components.md, 说明).
 *
 * Tooltip: an inverted label after 500 ms of hover, at once on keyboard focus, never on touch.
 * A press hides it until the pointer leaves; Escape hides it without closing what is behind it.
 * HelpHint: the light "?" for extra explanation; hover 300 ms or focus shows it, a click pins it,
 * Escape or an outside click closes it however it was opened.
 */

import {
  cloneElement,
  useEffect,
  useId,
  useRef,
  useState,
  type FocusEvent,
  type HTMLAttributes,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { CircleHelp } from 'lucide-react';
import { icon } from '../tokens/haven';
import { useFloating } from './floating';
import { useKitStrings } from './provider';

/** Hover delay before a tooltip shows. */
export const TOOLTIP_DELAY = 500;
/** Hover delay before the "?" bubble shows. */
const HINT_DELAY = 300;
/** Lets the pointer cross the gap between the "?" and its bubble. */
const HINT_GRACE = 150;

type Trigger = HTMLAttributes<HTMLElement>;

const focusVisible = (element: Element) => {
  try {
    return element.matches(':focus-visible');
  } catch {
    return true;
  }
};

export interface TooltipOptions {
  side?: 'bottom' | 'right';
  /** Make the tooltip the trigger's description. Leave off when it only repeats the trigger's name. */
  describe?: boolean;
  /** Nothing shows while false. */
  enabled?: boolean;
}

/**
 * Tooltip behaviour for any trigger: spread `bind(props)` on it and render `tooltip` next to it.
 * The trigger keeps its own handlers; the tooltip's run after them.
 */
export function useTooltip(label: string, { side = 'bottom', describe = false, enabled = true }: TooltipOptions = {}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** A pointer press keeps it hidden until the pointer leaves or focus moves on. */
  const pressed = useRef(false);
  const id = useId();
  const active = enabled && label !== '';
  const { panel, style } = useFloating<HTMLSpanElement>(open && active, {
    rect: () => anchor.current?.getBoundingClientRect() ?? null,
    side,
    align: 'center',
  });
  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = () => {
    cancel();
    setOpen(false);
  };
  useEffect(() => cancel, []);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    const scroll = () => setOpen(false);
    document.addEventListener('keydown', escape, true);
    document.addEventListener('scroll', scroll, true);
    return () => {
      document.removeEventListener('keydown', escape, true);
      document.removeEventListener('scroll', scroll, true);
    };
  }, [open]);

  const handlers = {
    onPointerEnter: (event: PointerEvent<HTMLElement>) => {
      if (!active || event.pointerType === 'touch' || pressed.current) return;
      anchor.current = event.currentTarget;
      cancel();
      timer.current = setTimeout(() => setOpen(true), TOOLTIP_DELAY);
    },
    onPointerLeave: () => {
      pressed.current = false;
      hide();
    },
    onPointerDown: () => {
      pressed.current = true;
      hide();
    },
    onFocus: (event: FocusEvent<HTMLElement>) => {
      if (!active || pressed.current || !focusVisible(event.currentTarget)) return;
      anchor.current = event.currentTarget;
      cancel();
      setOpen(true);
    },
    onBlur: () => {
      pressed.current = false;
      hide();
    },
    // A keyboard press activates the trigger the way a click does.
    onClick: hide,
  };
  const showing = open && active;
  const describedBy = describe && showing ? id : undefined;

  /** The trigger's props with the tooltip's handlers chained after its own. */
  const bind = <P extends Trigger>(props: P): P => {
    const chained = { ...props } as Trigger;
    for (const [name, handler] of Object.entries(handlers) as [keyof typeof handlers, (event: never) => void][]) {
      const own = props[name] as ((event: never) => void) | undefined;
      (chained as Record<string, unknown>)[name] = (event: never) => {
        own?.(event);
        handler(event);
      };
    }
    const describedByAll = [props['aria-describedby'], describedBy].filter(Boolean).join(' ');
    chained['aria-describedby'] = describedByAll || undefined;
    return chained as P;
  };

  const tooltip = showing ? (
    <span
      ref={panel}
      role="tooltip"
      id={id}
      className="gh-tooltip"
      style={style}
      aria-hidden={describe ? undefined : true}
    >
      {label}
    </span>
  ) : null;
  return { bind, tooltip, open: showing };
}

/** Wraps one trigger element. Use it for icon-only controls that are not an IconButton. */
export function Tooltip({
  label,
  side,
  children,
}: {
  label: string;
  side?: 'bottom' | 'right';
  children: ReactElement<Trigger>;
}) {
  const tip = useTooltip(label, { side, describe: children.props['aria-label'] !== label });
  return (
    <>
      {cloneElement(children, tip.bind(children.props))}
      {tip.tooltip}
    </>
  );
}

/**
 * The light "?" that keeps supplementary explanation off the page. Never for errors, required
 * fields, irreversible consequences or permission reasons.
 */
export function HelpHint({ label, children }: { label: string; children: ReactNode }) {
  const t = useKitStrings();
  const [pinned, setPinned] = useState(false);
  const [peek, setPeek] = useState(false);
  const id = useId();
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const open = pinned || peek;
  const { panel, style } = useFloating<HTMLSpanElement>(open, {
    rect: () => button.current?.getBoundingClientRect() ?? null,
  });
  const wait = (next: boolean, ms: number) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setPeek(next), ms);
  };
  // Escape dismisses it however it was opened — hover, focus or click (WCAG 1.4.13).
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setPinned(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setPinned(false);
      setPeek(false);
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape, true);
    };
  }, [open]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  return (
    <span
      className="gh-help-hint"
      ref={root}
      onMouseEnter={() => wait(true, HINT_DELAY)}
      onMouseLeave={() => wait(false, HINT_GRACE)}
    >
      <button
        ref={button}
        type="button"
        className="gh-help-hint-button"
        aria-label={t.help(label)}
        aria-expanded={pinned}
        aria-describedby={open ? id : undefined}
        onClick={() => setPinned(!pinned)}
        onFocus={() => setPeek(true)}
        onBlur={() => setPeek(false)}
      >
        <CircleHelp size={icon.sm} strokeWidth={icon.stroke} />
      </button>
      {open && (
        <span ref={panel} role="tooltip" id={id} className="gh-help-hint-bubble" style={style}>
          {children}
        </span>
      )}
    </span>
  );
}
