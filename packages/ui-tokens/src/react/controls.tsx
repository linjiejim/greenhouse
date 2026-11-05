/**
 * Controls for plugin pages, to the host's specs (apps/client/DESIGN.md; jim-uiux components):
 * controls 32 tall (28 compact, 44 on touch), radius 8, text 14, labels 13, hints 12, weight ≤ 600.
 */
import {
  cloneElement,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { useLayer } from './layers.js';
import { useKitStrings } from './strings.js';

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

/* ── icons (inline so the kit needs nothing but React) ── */
type IconProps = { size?: number; className?: string };
const svg = (size: number, className: string | undefined, children: ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    {children}
  </svg>
);
export const CloseIcon = ({ size = 16, className }: IconProps) =>
  svg(size, className, <path d="M18 6 6 18M6 6l12 12" />);
export const ChevronDownIcon = ({ size = 16, className }: IconProps) => svg(size, className, <path d="m6 9 6 6 6-6" />);
export const CheckIcon = ({ size = 16, className }: IconProps) => svg(size, className, <path d="M20 6 9 17l-5-5" />);
export const AlertIcon = ({ size = 16, className }: IconProps) =>
  svg(
    size,
    className,
    <>
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v4M12 16h.01" />
    </>,
  );
export const LockIcon = ({ size = 16, className }: IconProps) =>
  svg(
    size,
    className,
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>,
  );
export const SearchIcon = ({ size = 16, className }: IconProps) =>
  svg(
    size,
    className,
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>,
  );
export const InboxIcon = ({ size = 16, className }: IconProps) =>
  svg(
    size,
    className,
    <>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </>,
  );

/* ── buttons ── */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';

const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** One `primary` per region; `danger` only for the last step of something irreversible. */
export function Button({
  variant = 'secondary',
  compact,
  busy,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; compact?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control px-3 text-body font-semibold whitespace-nowrap transition-colors pointer-coarse:h-11',
        compact ? 'h-7' : 'h-8',
        focusRing,
        variant === 'primary' &&
          'bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-muted disabled:text-faint-foreground',
        variant === 'secondary' &&
          'border border-border bg-card text-foreground hover:bg-hover active:bg-pressed disabled:text-faint-foreground',
        variant === 'ghost' &&
          'text-muted-foreground hover:bg-hover hover:text-foreground active:bg-pressed disabled:text-faint-foreground',
        variant === 'danger' &&
          'bg-destructive text-destructive-foreground hover:bg-destructive-hover disabled:bg-muted disabled:text-faint-foreground',
        className,
      )}
    >
      {busy ? <Spinner size={14} className="absolute" /> : null}
      <span className={cx('inline-flex items-center gap-1.5', busy && 'invisible')}>{children}</span>
    </button>
  );
}

/** An icon-only button: `label` is its accessible name and its tooltip. */
export function IconButton({
  label,
  compact,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; compact?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-control text-muted-foreground hover:bg-hover hover:text-foreground active:bg-pressed disabled:text-faint-foreground pointer-coarse:h-11 pointer-coarse:w-11',
        compact ? 'h-7 w-7' : 'h-8 w-8',
        focusRing,
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ── fields ── */
const fieldClass =
  'w-full rounded-control border border-input bg-card px-2.5 text-body text-foreground placeholder:text-faint-foreground focus:border-ring focus:outline-none focus:ring-3 focus:ring-ring/15 aria-invalid:border-destructive disabled:bg-sunken disabled:text-faint-foreground read-only:bg-sunken pointer-coarse:text-body-lg';

/**
 * Label above, then the control, then one line: the error (red, with an icon) or a short hint.
 * The control gets its id, aria-describedby, aria-invalid and aria-required.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactElement<Record<string, unknown>>;
}) {
  const id = useId();
  const note = `${id}-note`;
  const control = isValidElement(children)
    ? cloneElement(children, {
        id: (children.props.id as string | undefined) ?? id,
        'aria-describedby': error || hint ? note : undefined,
        'aria-invalid': error ? true : undefined,
        'aria-required': required || undefined,
      })
    : children;
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={(children.props.id as string | undefined) ?? id}
        className="text-label font-medium text-foreground"
      >
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </label>
      {control}
      {error ? (
        <span id={note} className="flex items-center gap-1 text-caption text-destructive">
          <AlertIcon size={12} />
          {error}
        </span>
      ) : hint ? (
        <span id={note} className="text-caption text-muted-foreground">
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Input({ compact, className, ...props }: InputHTMLAttributes<HTMLInputElement> & { compact?: boolean }) {
  return <input {...props} className={cx(fieldClass, compact ? 'h-7' : 'h-8', 'pointer-coarse:h-11', className)} />;
}

export function TextArea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={cx(fieldClass, 'py-1.5', className)} />;
}

/** A search box: Escape clears it. */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cx('relative', className)}>
      <SearchIcon
        size={14}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint-foreground"
      />
      <input
        type="search"
        aria-label={label}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        className={cx(fieldClass, 'h-8 pl-8 pointer-coarse:h-11')}
      />
    </div>
  );
}

/* ── select ── */
export interface SelectOption {
  value: string;
  label: string;
}

/**
 * Pick one of a few options (≤ 8; more → a searchable list). No "All" option: a filter clears with
 * its ✕. A popup on the stack: arrows move, Enter picks, Escape closes only the popup.
 */
export function Select({
  value,
  onChange,
  options,
  label,
  placeholder,
  compact,
  clearable,
  className,
  id,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  options: SelectOption[];
  /** The accessible name when the select has no visible Field label. */
  label?: string;
  placeholder?: string;
  compact?: boolean;
  /** A filter: an unset value draws dashed, a set one shows ✕ to clear it. */
  clearable?: boolean;
  className?: string;
  id?: string;
}) {
  const s = useKitStrings();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const chosen = options.find((o) => o.value === value);
  return (
    <div className={cx('relative inline-flex', className ?? 'w-full')}>
      <button
        ref={button}
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label ? `${label}${chosen ? `: ${chosen.label}` : ''}` : undefined}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className={cx(
          fieldClass,
          'inline-flex items-center justify-between gap-1.5 text-left',
          compact ? 'h-7' : 'h-8',
          'pointer-coarse:h-11',
          clearable && !chosen && 'border-dashed text-muted-foreground',
          clearable && chosen && 'border-ring bg-selected',
          clearable && chosen && 'pr-8',
        )}
      >
        <span className={cx('truncate', !chosen && !clearable && 'text-faint-foreground')}>
          {clearable && label
            ? chosen
              ? `${label}${s.labelSep}${chosen.label}`
              : label
            : (chosen?.label ?? placeholder ?? s.choose)}
        </span>
        {clearable && chosen ? null : <ChevronDownIcon size={14} className="shrink-0 text-faint-foreground" />}
      </button>
      {clearable && chosen ? (
        <IconButton
          label={s.clearFilters}
          compact
          className="absolute top-1/2 right-0.5 h-6 w-6 -translate-y-1/2"
          onClick={() => onChange(undefined)}
        >
          <CloseIcon size={12} />
        </IconButton>
      ) : null}
      {open ? (
        <Listbox
          options={options}
          value={value}
          empty={s.noOptions}
          onPick={(next) => {
            setOpen(false);
            onChange(next);
            button.current?.focus();
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function Listbox({
  options,
  value,
  empty,
  onPick,
  onClose,
}: {
  options: SelectOption[];
  value: string | undefined;
  empty: string;
  onPick: (value: string) => void;
  onClose: () => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value),
    ),
  );
  useLayer({ modal: false, onEscape: onClose, root: () => list.current });
  useEffect(() => {
    list.current?.focus();
    const away = (e: MouseEvent) => {
      if (!list.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [onClose]);
  return (
    <div
      ref={list}
      role="listbox"
      tabIndex={-1}
      aria-activedescendant={options[active] ? `opt-${active}` : undefined}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown') setActive((i) => Math.min(options.length - 1, i + 1));
        else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1));
        else if (e.key === 'Enter' || e.key === ' ') {
          const o = options[active];
          if (o) onPick(o.value);
        } else if (e.key === 'Tab') onClose();
        else return;
        e.preventDefault();
      }}
      className="absolute top-full left-0 z-50 mt-1 max-h-80 min-w-full overflow-y-auto rounded-menu border border-border bg-popover p-1 shadow-popover outline-none animate-fade-in"
    >
      {options.length ? (
        options.map((o, i) => (
          <div
            key={o.value}
            id={`opt-${i}`}
            role="option"
            aria-selected={o.value === value}
            onMouseEnter={() => setActive(i)}
            onClick={() => onPick(o.value)}
            className={cx(
              'flex h-8 cursor-pointer items-center justify-between gap-3 rounded-md px-2 text-body whitespace-nowrap pointer-coarse:h-11',
              i === active && 'bg-hover',
            )}
          >
            <span className="truncate">{o.label}</span>
            {o.value === value ? <CheckIcon size={14} className="text-primary" /> : null}
          </div>
        ))
      ) : (
        <div className="px-2 py-1.5 text-body text-muted-foreground">{empty}</div>
      )}
    </div>
  );
}

/* ── status ── */
type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center rounded-md px-1.5 text-caption font-medium',
        tone === 'neutral' && 'bg-muted text-muted-foreground',
        tone === 'accent' && 'bg-selected text-primary-fg',
        tone === 'success' && 'bg-success-subtle text-success-fg',
        tone === 'warning' && 'bg-warning-subtle text-warning-fg',
        tone === 'danger' && 'bg-danger-subtle text-danger-fg',
        tone === 'info' && 'bg-info-subtle text-info-fg',
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className={cx('animate-spin text-faint-foreground', className)}
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 1 1-6.22-8.56" strokeLinecap="round" />
    </svg>
  );
}

/** True after `delay` ms of `on`, then held for at least `hold` ms (no skeleton flashes). */
export function useDelayedFlag(on: boolean, delay = 300, hold = 600): boolean {
  const [shown, setShown] = useState(false);
  const since = useRef(0);
  useEffect(() => {
    if (on && !shown) {
      const timer = setTimeout(() => {
        since.current = Date.now();
        setShown(true);
      }, delay);
      return () => clearTimeout(timer);
    }
    if (!on && shown) {
      const timer = setTimeout(() => setShown(false), Math.max(0, hold - (Date.now() - since.current)));
      return () => clearTimeout(timer);
    }
  }, [on, shown, delay, hold]);
  return shown;
}

/** A static placeholder shaped like what is coming; no shimmer. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cx('rounded-md bg-muted', className)} />;
}

/**
 * Empty, no match, no permission, failed: an icon, one title, at most one line, at most one action.
 * Loading is never one of these (render a Skeleton), and a failure never looks empty.
 */
export function StateView({
  kind,
  title,
  hint,
  icon,
  action,
  onRetry,
  onClearFilters,
  size = 'md',
}: {
  kind: 'empty' | 'no-match' | 'no-permission' | 'error';
  title?: string;
  hint?: string;
  icon?: ReactNode;
  action?: ReactNode;
  onRetry?: () => void;
  onClearFilters?: () => void;
  size?: 'sm' | 'md';
}) {
  const s = useKitStrings();
  const words = {
    empty: { title: title ?? '', hint },
    'no-match': { title: title ?? s.noMatch, hint },
    'no-permission': { title: title ?? s.noPermission, hint: hint ?? s.noPermissionHint },
    error: { title: title ?? s.loadFailed, hint: hint ?? s.loadFailedHint },
  }[kind];
  const glyph =
    icon ??
    (kind === 'error' ? (
      <AlertIcon size={24} />
    ) : kind === 'no-permission' ? (
      <LockIcon size={24} />
    ) : kind === 'no-match' ? (
      <SearchIcon size={24} />
    ) : (
      <InboxIcon size={24} />
    ));
  return (
    <div
      role={kind === 'error' ? 'alert' : undefined}
      className={cx(
        'flex flex-col items-center justify-center gap-2 px-6 text-center',
        size === 'md' ? 'py-16' : 'py-8',
        kind === 'empty' && 'animate-fade-in',
      )}
    >
      <div className={kind === 'error' ? 'text-destructive' : 'text-faint-foreground'}>{glyph}</div>
      <div className="text-title-sm font-semibold text-foreground">{words.title}</div>
      {words.hint ? <div className="max-w-sm text-body-sm text-muted-foreground">{words.hint}</div> : null}
      {action ??
        (kind === 'error' && onRetry ? (
          <Button className="mt-2" onClick={onRetry}>
            {s.retry}
          </Button>
        ) : kind === 'no-match' && onClearFilters ? (
          <Button className="mt-2" onClick={onClearFilters}>
            {s.clearFilters}
          </Button>
        ) : null)}
    </div>
  );
}
