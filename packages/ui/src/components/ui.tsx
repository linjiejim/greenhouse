/**
 * shadcn-inspired UI primitives with Tailwind — light theme.
 */

import React from 'react';
import { X, Star as StarIcon, Search as SearchIcon, User as UserIcon } from '../lib/icons';
import type { LucideIcon } from '../lib/icons';
import type { TagTone } from '../lib/utils';

export type { TagTone };

// ─── Button ──────────────────────────────────────────────

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

export function Button({ variant = 'default', size = 'md', className = '', children, ...props }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center font-medium rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50 disabled:cursor-not-allowed';
  const variants: Record<string, string> = {
    default: 'bg-primary-600 text-white hover:bg-primary-700',
    secondary: 'bg-surface-muted text-fg-secondary hover:bg-surface-muted',
    ghost: 'text-fg-muted hover:text-fg hover:bg-surface-muted',
    destructive: 'bg-destructive text-white hover:bg-destructive-hover',
    outline: 'border border-edge-strong text-fg-secondary hover:bg-surface-sunken',
  };
  const sizes: Record<string, string> = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
    icon: 'p-2 text-base',
  };

  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
}

// ─── Badge ───────────────────────────────────────────────

interface BadgeProps {
  variant?: 'default' | 'secondary' | 'success' | 'warning' | 'destructive';
  children: React.ReactNode;
  className?: string;
  /** Truncate with ellipsis instead of growing — for tight containers / table cells. */
  truncate?: boolean;
  /** Max width when truncate is on (Tailwind class). Default max-w-[160px]. */
  maxW?: string;
  /** Hover tooltip; auto-filled from children when truncate + string child. */
  title?: string;
}

const BADGE_VARIANTS: Record<string, string> = {
  default: 'bg-primary-subtle text-primary-fg-strong border-primary-edge',
  secondary: 'bg-surface-muted text-fg-secondary border-edge',
  success: 'bg-success-subtle text-success border-success',
  warning: 'bg-warning-subtle text-warning border-warning',
  destructive: 'bg-danger-subtle text-danger border-danger',
};

export function Badge({
  variant = 'default',
  children,
  className = '',
  truncate = false,
  maxW = 'max-w-[160px]',
  title,
}: BadgeProps) {
  const autoTitle = title ?? (truncate && typeof children === 'string' ? children : undefined);
  return (
    <span
      title={autoTitle}
      className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 text-xs font-medium rounded-full border ${BADGE_VARIANTS[variant]} ${truncate ? maxW : ''} ${className}`}
    >
      {truncate ? <span className="truncate">{children}</span> : children}
    </span>
  );
}

// ─── Tag ─────────────────────────────────────────────────
// Compact, single-line pill for table cells & dense metadata. ALWAYS
// `whitespace-nowrap` — replaces hand-rolled `text-[10px] px-1.5 py-0.5 rounded`
// spans that wrapped char-by-char when columns were squeezed. Pass `truncate`
// inside constrained cells so long values ellipsize instead of overflowing.

const TAG_TONES: Record<TagTone, string> = {
  neutral: 'bg-surface-muted text-fg-muted border-edge',
  primary: 'bg-primary-subtle text-primary-fg border-primary-edge',
  success: 'bg-success-subtle text-success border-success',
  warning: 'bg-warning-subtle text-warning border-warning',
  danger: 'bg-danger-subtle text-danger border-danger',
  info: 'bg-info-subtle text-info border-info',
};

interface TagProps {
  tone?: TagTone;
  size?: 'xs' | 'sm';
  truncate?: boolean;
  maxW?: string;
  title?: string;
  icon?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}

export function Tag({
  tone = 'neutral',
  size = 'xs',
  truncate = false,
  maxW = 'max-w-[120px]',
  title,
  icon,
  className = '',
  children,
}: TagProps) {
  const sizeCls = size === 'xs' ? 'text-[10px] px-1.5 py-0.5 gap-0.5' : 'text-xs px-2 py-0.5 gap-1';
  const autoTitle = title ?? (truncate && typeof children === 'string' ? children : undefined);
  return (
    <span
      title={autoTitle}
      className={`inline-flex items-center whitespace-nowrap rounded border font-medium ${sizeCls} ${TAG_TONES[tone]} ${truncate ? maxW : ''} ${className}`}
    >
      {icon}
      {truncate ? <span className="truncate">{children}</span> : children}
    </span>
  );
}

// ─── TagList ─────────────────────────────────────────────
// Single-line list of tags for table cells: renders up to `max`, then `+N`.
// Never wraps (no flex-wrap) — use in tables where vertical growth is unwanted.

interface TagListProps {
  items: Array<string | number>;
  max?: number;
  tone?: TagTone;
  className?: string;
}

export function TagList({ items, max = 3, tone = 'neutral', className = '' }: TagListProps) {
  if (!items || items.length === 0) return <span className="text-xs text-fg-faint">—</span>;
  const shown = items.slice(0, max);
  const rest = items.length - shown.length;
  return (
    <div className={`flex items-center gap-1 min-w-0 ${className}`} title={items.join(', ')}>
      {shown.map((t, i) => (
        <Tag key={i} tone={tone} truncate>
          {String(t)}
        </Tag>
      ))}
      {rest > 0 && <span className="text-[10px] text-fg-faint flex-shrink-0">+{rest}</span>}
    </div>
  );
}

// ─── Pagination ──────────────────────────────────────────
// Unified list-footer pagination: range text + page-size selector + prev/next
// + jump-to-page input. Pair with usePersistedPageSize. `page` is 0-based.

interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [20, 50, 100],
  className = '',
}: PaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const clampedPage = Math.min(page, totalPages - 1);
  const from = total === 0 ? 0 : clampedPage * pageSize + 1;
  const to = Math.min((clampedPage + 1) * pageSize, total);
  const [jump, setJump] = React.useState('');

  const go = (p: number) => onPageChange(Math.max(0, Math.min(totalPages - 1, p)));
  const commitJump = () => {
    const n = parseInt(jump, 10);
    if (!isNaN(n)) go(n - 1);
    setJump('');
  };

  if (total === 0) return null;

  return (
    <div
      className={`flex-shrink-0 border-t border-edge bg-surface-raised px-4 py-2 flex items-center justify-between gap-2 ${className}`}
    >
      <span className="text-xs text-fg-faint whitespace-nowrap">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        {onPageSizeChange && (
          <Select
            size="sm"
            inline
            value={String(pageSize)}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="hidden sm:block"
            aria-label="Rows per page"
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </Select>
        )}
        <button
          type="button"
          onClick={() => go(clampedPage - 1)}
          disabled={clampedPage === 0}
          className="px-2 py-1 text-xs rounded border border-edge text-fg-secondary hover:bg-surface-sunken disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Prev
        </button>
        <span className="px-1 text-xs text-fg-muted whitespace-nowrap">
          {clampedPage + 1} / {totalPages}
        </span>
        <button
          type="button"
          onClick={() => go(clampedPage + 1)}
          disabled={clampedPage >= totalPages - 1}
          className="px-2 py-1 text-xs rounded border border-edge text-fg-secondary hover:bg-surface-sunken disabled:opacity-30 disabled:cursor-not-allowed"
        >
          Next
        </button>
        {totalPages > 1 && (
          <div className="hidden sm:block w-12">
            <Input
              size="sm"
              type="number"
              min={1}
              max={totalPages}
              value={jump}
              onChange={(e) => setJump(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  commitJump();
                }
              }}
              onBlur={() => jump && commitJump()}
              placeholder="Go"
              className="text-center"
              aria-label="Jump to page"
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────

export function Card({ children, className = '', ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`bg-surface-raised border border-edge rounded-lg shadow-sm ${className}`} {...props}>
      {children}
    </div>
  );
}

// ─── Tooltip ─────────────────────────────────────────────
// Lightweight CSS-only hover/focus tooltip: wraps a trigger, reveals a bubble
// on hover or keyboard focus. No portal / JS positioning — meant for short help
// text on inline triggers (e.g. an info icon). Content wraps up to `w-56`.

interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactNode;
  side?: 'top' | 'bottom';
  className?: string;
}

export function Tooltip({ content, children, side = 'top', className = '' }: TooltipProps) {
  const pos = side === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
  return (
    <span className={`group/tt relative inline-flex ${className}`} tabIndex={0}>
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-50 -translate-x-1/2 ${pos} w-56 max-w-[16rem] rounded-lg border border-edge bg-surface-raised px-2.5 py-1.5 text-left text-xs font-normal leading-relaxed text-fg-secondary opacity-0 shadow-md transition-opacity duration-150 group-hover/tt:opacity-100 group-focus/tt:opacity-100`}
      >
        {content}
      </span>
    </span>
  );
}

// ─── Input ───────────────────────────────────────────────

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
}

export function Input({ size = 'md', className = '', ...props }: InputProps) {
  const sizes: Record<string, string> = {
    xs: 'px-1 py-0.5 text-[11px]',
    sm: 'px-2 py-1.5 text-xs',
    md: 'px-3 py-2 text-sm',
    lg: 'px-4 py-3 text-sm rounded-xl',
  };
  return (
    <input
      className={`w-full bg-surface-raised border border-edge-strong rounded-md text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// ─── Tabs ────────────────────────────────────────────────

interface TabsProps {
  tabs: Array<{ key: string; label: React.ReactNode; count?: number }>;
  active: string;
  onChange: (key: string) => void;
}

export function Tabs({ tabs, active, onChange }: TabsProps) {
  return (
    <div className="flex gap-1 bg-surface-muted p-1 rounded-lg">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={`px-3 py-1.5 text-sm rounded-md transition-colors ${
            active === tab.key
              ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm border border-edge'
              : 'text-fg-muted hover:text-fg-secondary border border-transparent'
          }`}
        >
          {tab.label}
          {tab.count != null && <span className="ml-1.5 text-xs text-fg-faint">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ─── Dialog ──────────────────────────────────────────────

interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | '80' | 'full';
  noPadding?: boolean;
  /** Stable hook for e2e/automation. Applied to the dialog panel (which also carries role="dialog"). */
  testId?: string;
}

export function Dialog({ open, onClose, title, children, size = 'lg', noPadding, testId }: DialogProps) {
  const [isClosing, setIsClosing] = React.useState(false);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;

  const handleClose = React.useCallback(() => {
    setIsClosing(true);
    setTimeout(() => {
      setIsClosing(false);
      onCloseRef.current();
    }, 150);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        handleClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, handleClose]);

  if (!open) return null;
  const sizeClasses: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-3xl',
    xl: 'max-w-5xl',
    '80': 'w-[80%]',
    full: 'max-w-[calc(100vw-2rem)]',
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className={`absolute inset-0 bg-black/30 dark:bg-black/55 backdrop-blur-sm ${isClosing ? 'animate-toast-out' : 'animate-fade-in'}`}
        onClick={handleClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className={`relative bg-surface-raised border border-edge rounded-xl shadow-xl ${noPadding ? '' : 'p-6'} w-full ${sizeClasses[size]} max-h-[90vh] flex flex-col ${isClosing ? 'animate-toast-out' : 'animate-fade-in'} mx-4`}
      >
        <div
          className={`flex items-center justify-between ${noPadding ? 'px-6 py-4 border-b border-edge' : 'mb-4'} flex-shrink-0`}
        >
          <h3 className="text-lg font-semibold text-fg">{title}</h3>
          <button
            onClick={handleClose}
            className="text-fg-faint hover:text-fg-secondary p-0.5 rounded hover:bg-surface-muted transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

// ─── EmptyState ──────────────────────────────────────────

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  /** Lucide icon only — never an emoji string (see AGENTS.md design system). */
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional primary CTA rendered below the description (e.g. a Create button). */
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-4">
        <Icon size={36} className="text-primary-400" />
      </div>
      <h3 className="text-lg font-medium text-fg-secondary mb-1">{title}</h3>
      {description && <p className="text-sm text-fg-muted max-w-sm">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ─── ListToolbar ─────────────────────────────────────────

/**
 * Standard header row for settings list pages: muted hint on the left,
 * an optional inline filter cluster, a flexible spacer, a result count,
 * and right-aligned actions (put the primary "Create" button last).
 *
 * Keeps the primary action in a single, consistent place (top-right) across
 * every list page — don't hand-roll `flex items-center` + spacer per page.
 */
export function ListToolbar({
  hint,
  count,
  children,
  actions,
  className = '',
}: {
  /** Muted hint/description text on the left. */
  hint?: React.ReactNode;
  /** Result count, shown right-aligned before the actions. */
  count?: React.ReactNode;
  /** Left-cluster content after the hint (e.g. inline filters). */
  children?: React.ReactNode;
  /** Right-aligned actions; the primary Create button goes last. */
  actions?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex items-center gap-2 flex-wrap ${className}`}>
      {hint != null && <div className="text-xs text-fg-muted min-w-0">{hint}</div>}
      {children}
      <div className="flex-1" />
      {count != null && <span className="text-xs text-fg-faint whitespace-nowrap">{count}</span>}
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

// ─── Spinner ─────────────────────────────────────────────

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <svg className={`animate-spin h-4 w-4 ${className}`} viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

// ─── StarRating ──────────────────────────────────────────

export function StarRating({
  value,
  onChange,
  readonly = false,
}: {
  value: number;
  onChange?: (v: number) => void;
  readonly?: boolean;
}) {
  return (
    <div className="flex gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <button
          key={i}
          type="button"
          onClick={() => !readonly && onChange?.(value === i ? 0 : i)}
          disabled={readonly}
          className={`transition-all ${readonly ? 'cursor-default' : 'cursor-pointer hover:scale-110'}`}
        >
          <StarIcon size={16} className={i <= value ? 'text-yellow-400 fill-yellow-400' : 'text-fg-faint'} />
        </button>
      ))}
    </div>
  );
}

// ─── Select ──────────────────────────────────────────────

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  size?: 'xs' | 'sm' | 'md' | 'lg';
  inline?: boolean;
}

export function Select({ size = 'md', inline = false, className = '', ...props }: SelectProps) {
  const sizes: Record<string, string> = {
    xs: 'px-1 py-0.5 text-[11px]',
    sm: 'px-2 py-1.5 text-xs',
    md: 'px-3 py-2 text-sm',
    lg: 'px-4 py-3 text-sm rounded-xl',
  };
  return (
    <select
      className={`${inline ? 'w-auto' : 'w-full'} bg-surface-raised border border-edge-strong rounded-md text-fg focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// ─── Textarea ────────────────────────────────────────────

export function Textarea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full bg-surface-raised border border-edge-strong rounded-md px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:border-primary-500 resize-none ${className}`}
      {...props}
    />
  );
}

// ─── ConfirmDialog ───────────────────────────────────────

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  confirmVariant?: 'default' | 'destructive';
  /** Stable hook for e2e/automation; defaults to "confirm-dialog". */
  testId?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  confirmVariant = 'default',
  testId = 'confirm-dialog',
}: ConfirmDialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid={testId}
        className="relative bg-surface-raised border border-edge rounded-xl shadow-xl p-5 w-full max-w-xs animate-fade-in"
      >
        <p className="text-sm text-fg-secondary mb-1 font-medium">{title}</p>
        {description && <p className="text-xs text-fg-muted mb-4">{description}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="confirm-dialog-cancel">
            Cancel
          </Button>
          <Button
            variant={confirmVariant === 'destructive' ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── Drawer ──────────────────────────────────────────────

interface DrawerProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  side?: 'left' | 'right';
  width?: number | string;
}

export function Drawer({ open, onClose, children, side = 'left', width }: DrawerProps) {
  const [mounted, setMounted] = React.useState(false);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      // Enter uses keyframe animations (always play on mount);
      // `visible` only drives the exit transition.
      setMounted(true);
      setVisible(true);
    } else {
      setVisible(false);
      const timer = setTimeout(() => setMounted(false), 200);
      return () => clearTimeout(timer);
    }
  }, [open]);

  if (!mounted) return null;
  const widthStyle = width
    ? typeof width === 'number'
      ? { width: `${width}px`, maxWidth: 'calc(100vw - 2rem)' }
      : { width, maxWidth: 'calc(100vw - 2rem)' }
    : undefined;
  return (
    <div className={`fixed inset-0 z-50 flex ${visible ? '' : 'pointer-events-none'}`}>
      {/* Dim only, no backdrop blur — drawers keep the page context readable */}
      <div
        className={`absolute inset-0 bg-black/30 dark:bg-black/55 ${visible ? 'animate-fade-in' : 'animate-toast-out'}`}
        onClick={onClose}
      />
      <div
        className={`relative bg-surface-raised h-full shadow-xl flex flex-col overflow-y-auto ${
          !width ? 'w-64 max-w-[80vw]' : ''
        } ${side === 'right' ? 'ml-auto' : ''} ${
          visible
            ? side === 'right'
              ? 'animate-slide-in-right'
              : 'animate-slide-in-left'
            : side === 'right'
              ? 'animate-slide-out-right'
              : 'animate-slide-out-left'
        }`}
        style={widthStyle}
      >
        {children}
      </div>
    </div>
  );
}

// ─── Toast Notification System ──────────────────────────────

interface ToastItem {
  id: number;
  message: string;
  variant: 'success' | 'error' | 'info' | 'warning';
  exiting?: boolean;
  onUndo?: () => void;
  action?: { label: string; onClick: () => void };
}

let toastIdCounter = 0;
let toastSetState: React.Dispatch<React.SetStateAction<ToastItem[]>> | null = null;

/** Show a toast notification. Call from anywhere.
 *  Pass `options.onUndo` to show an Undo button.
 *  Pass `options.action` to show a custom labelled button.
 *  Pass `options.duration` (ms) to override the default 3s auto-dismiss. */
export function toast(
  message: string,
  variant: ToastItem['variant'] = 'info',
  options?: { onUndo?: () => void; action?: { label: string; onClick: () => void }; duration?: number },
) {
  const id = ++toastIdCounter;
  const duration = options?.duration ?? (options?.onUndo || options?.action ? 5000 : 3000);
  toastSetState?.((prev) => [
    ...prev.slice(-4),
    { id, message, variant, onUndo: options?.onUndo, action: options?.action },
  ]);
  setTimeout(() => {
    toastSetState?.((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
    setTimeout(() => {
      toastSetState?.((prev) => prev.filter((t) => t.id !== id));
    }, 200);
  }, duration);
}

function dismissToast(id: number) {
  toastSetState?.((prev) => prev.map((t) => (t.id === id ? { ...t, exiting: true } : t)));
  setTimeout(() => {
    toastSetState?.((prev) => prev.filter((t) => t.id !== id));
  }, 200);
}

/** Mount this once at the app root */
export function ToastContainer() {
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  React.useEffect(() => {
    toastSetState = setToasts;
    return () => {
      toastSetState = null;
    };
  }, []);

  if (toasts.length === 0) return null;

  const variantStyles: Record<string, string> = {
    success: 'bg-success-subtle border-success text-success-fg',
    error: 'bg-danger-subtle border-danger text-danger-fg',
    info: 'bg-info-subtle border-info text-info-fg',
    warning: 'bg-warning-subtle border-warning text-warning-fg',
  };

  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto px-4 py-2.5 rounded-lg border shadow-lg text-sm font-medium flex items-center gap-3 ${
            variantStyles[t.variant]
          } ${t.exiting ? 'animate-toast-out' : 'animate-toast-in'}`}
        >
          <span>{t.message}</span>
          {t.onUndo && (
            <button
              onClick={() => {
                t.onUndo!();
                dismissToast(t.id);
              }}
              className="text-xs font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity flex-shrink-0"
            >
              Undo
            </button>
          )}
          {t.action && (
            <button
              onClick={() => {
                t.action!.onClick();
                dismissToast(t.id);
              }}
              className="text-xs font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity flex-shrink-0"
            >
              {t.action.label}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Skeleton ──────────────────────────────────────────

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`bg-surface-muted rounded animate-skeleton ${className}`} />;
}

/** Pre-built skeleton row for tables */
export function SkeletonRow({ cols = 4 }: { cols?: number }) {
  return (
    <tr>
      {Array.from({ length: cols }).map((_, i) => (
        <td key={i} className="px-3 py-3">
          <Skeleton className={`h-4 ${i === 0 ? 'w-32' : 'w-20'}`} />
        </td>
      ))}
    </tr>
  );
}

/** Pre-built skeleton card */
export function SkeletonCard() {
  return (
    <div className="bg-surface-raised border border-edge rounded-lg p-4 space-y-3">
      <Skeleton className="h-4 w-3/4" />
      <Skeleton className="h-3 w-1/2" />
      <Skeleton className="h-3 w-2/3" />
    </div>
  );
}

// ─── ErrorBoundary ──────────────────────────────────────

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback?: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="flex flex-col items-center justify-center h-full py-16 text-center">
          <div className="text-4xl mb-4">⚠️</div>
          <h3 className="text-lg font-medium text-fg-secondary mb-2">Something went wrong</h3>
          <p className="text-sm text-fg-muted max-w-sm mb-4">{this.state.error?.message}</p>
          <Button size="sm" onClick={() => this.setState({ hasError: false, error: null })}>
            Try Again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── SearchInput ─────────────────────────────────────────

interface SearchInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'onChange' | 'size'> {
  value: string;
  onChange: (value: string) => void;
  size?: 'sm' | 'md';
}

export function SearchInput({ value, onChange, size = 'sm', className = '', ...props }: SearchInputProps) {
  const iconSize = size === 'sm' ? 12 : 14;
  const paddingLeft = size === 'sm' ? 'pl-7' : 'pl-9';
  const iconOffset = size === 'sm' ? 'left-2' : 'left-3';
  return (
    <div className={`relative ${className}`}>
      <SearchIcon size={iconSize} className={`absolute ${iconOffset} top-1/2 -translate-y-1/2 text-fg-faint`} />
      <Input
        type="text"
        size={size}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={paddingLeft}
        {...props}
      />
    </div>
  );
}

// ─── Toggle ──────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
}

export function Toggle({ checked, onChange, size = 'md', disabled = false, className = '' }: ToggleProps) {
  const trackSize = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const thumbSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const thumbTranslate = size === 'sm' ? 'translate-x-4' : 'translate-x-6';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
      className={`relative inline-flex ${trackSize} items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-primary-600' : 'bg-surface-muted border border-edge-strong'
      } ${className}`}
    >
      <span
        className={`inline-block ${thumbSize} transform rounded-full bg-surface-raised shadow transition-transform ${
          checked ? thumbTranslate : 'translate-x-1'
        }`}
      />
    </button>
  );
}

// ─── StatusDot ───────────────────────────────────────────

interface StatusDotProps {
  color?: 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'muted';
  size?: 'sm' | 'md';
  pulse?: boolean;
  className?: string;
}

export function StatusDot({ color = 'muted', size = 'md', pulse = false, className = '' }: StatusDotProps) {
  const dotSize = size === 'sm' ? 'w-1.5 h-1.5' : 'w-2 h-2';
  const colors: Record<string, string> = {
    success: 'bg-success',
    warning: 'bg-warning',
    danger: 'bg-danger',
    info: 'bg-info',
    primary: 'bg-primary-500',
    muted: 'bg-fg-faint',
  };
  return (
    <span
      className={`inline-block ${dotSize} rounded-full flex-shrink-0 ${colors[color]} ${pulse ? 'animate-pulse' : ''} ${className}`}
    />
  );
}

// ─── Checkbox ────────────────────────────────────────────

interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label?: React.ReactNode;
}

export function Checkbox({ label, className = '', ...props }: CheckboxProps) {
  const input = (
    <input
      type="checkbox"
      className={`rounded border-edge-strong text-primary-600 focus:ring-primary-500 focus:ring-offset-0 ${className}`}
      {...props}
    />
  );
  if (!label) return input;
  return (
    <label
      className={`flex items-center gap-2 text-sm text-fg-secondary cursor-pointer ${props.disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
      {input}
      {label}
    </label>
  );
}

// ─── Avatar ──────────────────────────────────────────────

interface AvatarProps {
  name?: string;
  icon?: LucideIcon;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'default' | 'primary';
  className?: string;
}

export function Avatar({ name, icon, size = 'md', variant = 'default', className = '' }: AvatarProps) {
  const sizeMap: Record<string, { box: string; text: string; icon: number }> = {
    xs: { box: 'w-5 h-5', text: 'text-[10px]', icon: 10 },
    sm: { box: 'w-7 h-7', text: 'text-xs', icon: 13 },
    md: { box: 'w-8 h-8', text: 'text-sm', icon: 14 },
    lg: { box: 'w-14 h-14', text: 'text-2xl', icon: 24 },
  };
  const variantMap: Record<string, string> = {
    default: 'bg-surface-muted text-fg-muted',
    primary: 'bg-primary-subtle-hover text-primary-fg-strong',
  };
  const s = sizeMap[size];
  const IconComp = icon || UserIcon;
  const initial = name?.charAt(0).toUpperCase();
  return (
    <span
      className={`${s.box} rounded-full flex items-center justify-center font-semibold flex-shrink-0 ${variantMap[variant]} ${className}`}
    >
      {initial ? <span className={s.text}>{initial}</span> : <IconComp size={s.icon} />}
    </span>
  );
}

// ─── DateRangeInput ──────────────────────────────────────

interface DateRangeInputProps {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
  type?: 'date' | 'datetime-local';
  size?: 'sm' | 'md';
  className?: string;
}

export function DateRangeInput({
  from,
  to,
  onChange,
  type = 'date',
  size = 'sm',
  className = '',
}: DateRangeInputProps) {
  const width = type === 'datetime-local' ? 'w-[180px]' : 'w-[130px]';
  const inputSize = size === 'sm' ? ('xs' as const) : ('sm' as const);
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className="text-[10px] text-fg-faint flex-shrink-0">From</span>
      <Input
        type={type}
        size={inputSize}
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className={width}
      />
      <span className="text-[10px] text-fg-faint flex-shrink-0">To</span>
      <Input
        type={type}
        size={inputSize}
        value={to}
        onChange={(e) => onChange(from, e.target.value)}
        className={width}
      />
    </div>
  );
}
