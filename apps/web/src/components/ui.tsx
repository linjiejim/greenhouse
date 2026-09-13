/**
 * shadcn-inspired UI primitives with Tailwind — light theme.
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X, Star as StarIcon, Search as SearchIcon, User as UserIcon } from '../lib/icons';
import type { LucideIcon } from '../lib/icons';
import { getRuntimeLogo, getRuntimeProductName } from '../lib/workspace-branding';
import { APP_VERSION } from '../lib/utils';
import type { TagTone } from '../lib/utils';
import { useOverlayBehavior } from '../hooks/use-overlay-behavior';
import { useT } from '../lib/i18n';
import { OverlayFrame } from './overlay-frame';

export type { TagTone };

// ─── Button ──────────────────────────────────────────────

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'secondary' | 'ghost' | 'destructive' | 'outline';
  size?: 'sm' | 'md' | 'lg' | 'icon';
}

export function Button({ variant = 'default', size = 'md', className = '', children, ...props }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center font-semibold rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40 focus:ring-offset-1 focus:ring-offset-surface-raised disabled:opacity-50 disabled:cursor-not-allowed';
  const variants: Record<string, string> = {
    default: 'bg-primary-600 text-white shadow-sm shadow-primary-900/10 hover:bg-primary-700',
    secondary: 'bg-surface-muted text-fg-secondary hover:bg-surface-muted',
    ghost: 'text-fg-muted hover:text-fg hover:bg-surface-muted',
    destructive: 'bg-destructive text-white hover:bg-destructive-hover',
    outline: 'border border-edge-strong text-fg-secondary hover:bg-surface-sunken',
  };
  const sizes: Record<string, string> = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
    icon: 'h-11 w-11 p-0 text-base sm:h-9 sm:w-9',
  };

  return (
    <button className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...props}>
      {children}
    </button>
  );
}

// ─── IconButton ──────────────────────────────────────────

interface IconButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'title'> {
  /** Names the action: shown on hover/focus and read out as the accessible name. */
  label: string;
  variant?: 'ghost' | 'destructive';
  /** Compact 28px control for dense sidebars; default remains a 44px mobile target. */
  size?: 'default' | 'compact';
  /** Preferred tooltip side. Header actions default down; low toolbars opt into top. */
  tooltip?: 'bottom' | 'top';
  /** Render above clipping/stacking contexts such as sticky data tables. */
  tooltipMode?: 'inline' | 'portal';
  /** Classes for the non-interactive wrapper (responsive visibility, positioning). */
  wrapperClassName?: string;
  children: React.ReactNode;
}

/**
 * Icon-only action with a label that appears on hover or keyboard focus.
 *
 * For toolbars where labelled buttons would crowd out the content. The tooltip is
 * CSS-only (no portal, no positioning library) — it needs a non-clipping ancestor,
 * which toolbar rows are. Prefer a labelled <Button> for the primary action of a
 * bar; an icon row full of equal-weight glyphs gives the reader nothing to aim at.
 */
export function IconButton({
  label,
  variant = 'ghost',
  size = 'default',
  tooltip = 'bottom',
  tooltipMode = 'inline',
  wrapperClassName = '',
  className = '',
  children,
  onMouseEnter,
  onMouseLeave,
  onFocus,
  onBlur,
  ...props
}: IconButtonProps) {
  const buttonRef = React.useRef<HTMLButtonElement>(null);
  const [portalPosition, setPortalPosition] = React.useState<{ left: number; top: number } | null>(null);
  const variants: Record<string, string> = {
    ghost: 'text-fg-muted hover:text-fg hover:bg-surface-muted',
    destructive: 'text-fg-muted hover:text-danger hover:bg-danger-subtle',
  };
  const dimensions = size === 'compact' ? 'h-7 w-7' : 'h-11 w-11 sm:h-9 sm:w-9';
  const place = tooltip === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5';
  const updatePortalPosition = React.useCallback(() => {
    if (tooltipMode !== 'portal') return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPortalPosition({
      left: rect.left + rect.width / 2,
      top: tooltip === 'top' ? rect.top - 6 : rect.bottom + 6,
    });
  }, [tooltip, tooltipMode]);

  React.useEffect(() => {
    if (!portalPosition) return;
    const close = () => setPortalPosition(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [portalPosition]);

  return (
    <span className={`relative inline-flex group ${wrapperClassName}`}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={label}
        className={`inline-flex ${dimensions} items-center justify-center rounded-md transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:opacity-50 disabled:cursor-not-allowed ${variants[variant]} ${className}`}
        onMouseEnter={(event) => {
          updatePortalPosition();
          onMouseEnter?.(event);
        }}
        onMouseLeave={(event) => {
          setPortalPosition(null);
          onMouseLeave?.(event);
        }}
        onFocus={(event) => {
          updatePortalPosition();
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setPortalPosition(null);
          onBlur?.(event);
        }}
        {...props}
      >
        {children}
      </button>
      {tooltipMode === 'inline' && (
        <span
          role="tooltip"
          className={`pointer-events-none absolute ${place} left-1/2 -translate-x-1/2 z-30 whitespace-nowrap rounded bg-fg px-1.5 py-0.5 text-[11px] text-surface-raised opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100`}
        >
          {label}
        </span>
      )}
      {tooltipMode === 'portal' &&
        portalPosition &&
        createPortal(
          <span
            role="tooltip"
            style={{ left: portalPosition.left, top: portalPosition.top }}
            className={`pointer-events-none fixed z-[70] -translate-x-1/2 whitespace-nowrap rounded bg-fg px-1.5 py-0.5 text-[11px] text-surface-raised shadow-sm ${
              tooltip === 'top' ? '-translate-y-full' : ''
            }`}
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}

// ─── ResizeHandle ────────────────────────────────────────

interface ResizeHandleProps {
  orientation: 'vertical' | 'horizontal';
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  onResizeStart?: () => void;
  onResizeEnd?: (value: number) => void;
  /** Collapse the owning pane after dragging this far past its minimum size. */
  onCollapse?: () => void;
  collapseThreshold?: number;
  defaultValue?: number;
  direction?: 1 | -1;
  step?: number;
  label: string;
  className?: string;
}

/**
 * Pointer, touch and keyboard accessible separator for resizable panes.
 *
 * Arrow keys change the value, Home/End jump to bounds, and double-click resets
 * to `defaultValue`. `direction=-1` is useful for the left/top edge of a panel
 * whose size grows opposite to pointer movement.
 */
export function ResizeHandle({
  orientation,
  value,
  min,
  max,
  onChange,
  onResizeStart,
  onResizeEnd,
  onCollapse,
  collapseThreshold = 24,
  defaultValue,
  direction = 1,
  step = 8,
  label,
  className = '',
}: ResizeHandleProps) {
  const [dragging, setDragging] = React.useState(false);
  const dragRef = React.useRef<{ pointerId: number; startPosition: number; startValue: number } | null>(null);
  const latestValueRef = React.useRef(value);
  latestValueRef.current = value;

  const clamp = React.useCallback((next: number) => Math.min(max, Math.max(min, Math.round(next))), [max, min]);
  const commit = React.useCallback(
    (next: number) => {
      const clamped = clamp(next);
      latestValueRef.current = clamped;
      onChange(clamped);
    },
    [clamp, onChange],
  );

  const restoreBody = React.useCallback(() => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
  }, []);

  React.useEffect(
    () => () => {
      restoreBody();
    },
    [restoreBody],
  );

  const finishDrag = (target: HTMLDivElement, pointerId: number) => {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    dragRef.current = null;
    setDragging(false);
    restoreBody();
    onResizeEnd?.(latestValueRef.current);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    const keyboardStep = event.shiftKey ? step * 3 : step;
    if (event.key === 'Home') next = min;
    if (event.key === 'End') next = max;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = value - keyboardStep;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = value + keyboardStep;
    if (next == null) return;
    event.preventDefault();
    commit(next);
    onResizeEnd?.(clamp(next));
  };

  const cursor = orientation === 'vertical' ? 'col-resize' : 'row-resize';
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={Math.round(value)}
      aria-valuetext={`${Math.round(value)} pixels`}
      title={`${label}. Use arrow keys to resize${defaultValue == null ? '' : '; double-click to reset'}${onCollapse == null ? '' : '; drag past the minimum to collapse'}.`}
      className={`group touch-none select-none focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500/50 ${
        orientation === 'vertical'
          ? 'flex w-2 cursor-col-resize items-stretch justify-center'
          : 'flex h-2 cursor-row-resize items-center'
      } ${className}`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizeStart?.();
        dragRef.current = {
          pointerId: event.pointerId,
          startPosition: orientation === 'vertical' ? event.clientX : event.clientY,
          startValue: value,
        };
        setDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = cursor;
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag || drag.pointerId !== event.pointerId) return;
        const pointerPosition = orientation === 'vertical' ? event.clientX : event.clientY;
        const next = drag.startValue + (pointerPosition - drag.startPosition) * direction;
        if (onCollapse && next <= min - collapseThreshold) {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
          setDragging(false);
          restoreBody();
          onCollapse();
          return;
        }
        commit(next);
      }}
      onPointerUp={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) finishDrag(event.currentTarget, event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (dragRef.current?.pointerId === event.pointerId) finishDrag(event.currentTarget, event.pointerId);
      }}
      onDoubleClick={() => {
        if (defaultValue == null) return;
        commit(defaultValue);
        onResizeEnd?.(clamp(defaultValue));
      }}
      onKeyDown={handleKeyDown}
    >
      <span
        aria-hidden="true"
        className={`pointer-events-none rounded-full transition-colors ${
          orientation === 'vertical' ? 'h-full w-px' : 'h-px w-full'
        } ${dragging ? 'bg-primary-400' : 'bg-transparent group-hover:bg-primary-300 group-focus:bg-primary-400'}`}
      />
    </div>
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
  // `primary-fg` lands at 4.4:1 on the selection-strength fill — under AA for a
  // 10px tag. `primary-fg-strong` is 5.4:1, and matches what Badge already uses.
  primary: 'bg-primary-subtle text-primary-fg-strong border-primary-edge',
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
  const t = useT();
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
      <span className="text-xs text-fg-faint whitespace-nowrap">{t('common.rangeOfTotal', { from, to, total })}</span>
      <div className="flex items-center gap-1.5">
        {onPageSizeChange && (
          <Select
            size="sm"
            inline
            value={String(pageSize)}
            onChange={(e) => onPageSizeChange(Number(e.target.value))}
            className="hidden sm:block"
            aria-label={t('common.rowsPerPage')}
          >
            {pageSizeOptions.map((n) => (
              <option key={n} value={n}>
                {t('common.perPage', { count: n })}
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
          {t('common.previous')}
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
          {t('common.next')}
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
              placeholder={t('common.goToPage')}
              className="text-center"
              aria-label={t('common.jumpToPage')}
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
    <div
      className={`bg-surface-card border border-edge rounded-xl shadow-sm shadow-primary-900/5 dark:shadow-black/20 ${className}`}
      {...props}
    >
      {children}
    </div>
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
      className={`w-full bg-surface-raised border border-edge-strong rounded-lg text-fg placeholder-fg-faint shadow-sm shadow-primary-900/5 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// ─── Tabs ────────────────────────────────────────────────

interface TabsProps {
  tabs: Array<{ key: string; label: React.ReactNode; count?: number }>;
  active: string;
  onChange: (key: string) => void;
  ariaLabel?: string;
}

export function Tabs({ tabs, active, onChange, ariaLabel }: TabsProps) {
  const tabRefs = React.useRef<Array<HTMLButtonElement | null>>([]);

  const selectTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onChange(tab.key);
    tabRefs.current[index]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className="flex max-w-full gap-1 overflow-x-auto scrollbar-hide bg-surface-muted p-1 rounded-xl border border-edge"
    >
      {tabs.map((tab, index) => (
        <button
          key={tab.key}
          ref={(node) => {
            tabRefs.current[index] = node;
          }}
          type="button"
          role="tab"
          aria-selected={active === tab.key}
          tabIndex={active === tab.key ? 0 : -1}
          onClick={() => onChange(tab.key)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') {
              event.preventDefault();
              selectTab((index + 1) % tabs.length);
            } else if (event.key === 'ArrowLeft') {
              event.preventDefault();
              selectTab((index - 1 + tabs.length) % tabs.length);
            } else if (event.key === 'Home') {
              event.preventDefault();
              selectTab(0);
            } else if (event.key === 'End') {
              event.preventDefault();
              selectTab(tabs.length - 1);
            }
          }}
          className={`flex-shrink-0 px-3 py-1.5 text-sm rounded-md whitespace-nowrap transition-colors ${
            active === tab.key
              ? 'bg-surface-raised text-primary-fg-strong font-semibold shadow-sm border border-edge'
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
  /** `workspace` is the standard 80vw canvas for dense editing, comparison, and information-heavy flows. */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'workspace' | 'wide' | 'full';
  noPadding?: boolean;
  /** Disable the shared body scroller when the dialog owns multiple independent scroll regions. */
  scrollBody?: boolean;
  /** Keeps the tab strip fixed and enables a viewport-bounded stable dialog height. */
  tabs?: React.ReactNode;
  /** Compact controls rendered beside the title, before the close button. */
  headerActions?: React.ReactNode;
}

export function Dialog({
  open,
  onClose,
  title,
  children,
  size = 'lg',
  noPadding,
  scrollBody = true,
  tabs,
  headerActions,
}: DialogProps) {
  const t = useT();
  const sizeClasses: Record<string, string> = {
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-3xl',
    xl: 'max-w-5xl',
    workspace: 'sm:w-[80vw] sm:max-w-[80vw]',
    wide: 'sm:w-[90vw] sm:max-w-[90vw]',
    full: 'sm:max-w-[calc(100vw-2rem)]',
  };
  return (
    <OverlayFrame
      open={open}
      onClose={onClose}
      variant="center"
      ariaLabel={title}
      closeDelayMs={150}
      surfaceClassName={`${sizeClasses[size]} ${tabs ? 'h-[min(44rem,100%)]' : ''}`}
    >
      {({ close }) => (
        <>
          <div
            className={`flex flex-shrink-0 items-center justify-between gap-3 px-4 sm:px-6 ${
              noPadding ? 'border-b border-edge py-3 sm:py-4' : 'pb-4 pt-4 sm:pt-6'
            }`}
          >
            <h3 className="min-w-0 truncate text-base sm:text-lg font-semibold text-fg" title={title}>
              {title}
            </h3>
            <div className="ml-auto flex flex-shrink-0 items-center gap-1">
              {headerActions}
              <button
                onClick={close}
                className="h-11 w-11 sm:h-9 sm:w-9 -my-2 -mr-2 flex-shrink-0 inline-flex items-center justify-center text-fg-faint hover:text-fg-secondary rounded-md hover:bg-surface-muted transition-colors"
                aria-label={t('common.close')}
              >
                <X size={18} />
              </button>
            </div>
          </div>
          {tabs && (
            <div className="flex-shrink-0 overflow-x-auto border-b border-edge px-4 scrollbar-hide sm:px-6">{tabs}</div>
          )}
          <div
            className={`min-h-0 flex-1 ${
              scrollBody
                ? 'overflow-y-auto overscroll-contain [scrollbar-gutter:stable]'
                : 'flex flex-col overflow-hidden'
            }`}
          >
            <div
              className={`${scrollBody ? '' : 'flex min-h-0 flex-1 flex-col'} ${noPadding ? '' : 'px-4 pb-4 sm:px-6 sm:pb-6'} ${tabs ? 'pt-3' : ''} ${
                tabs && !noPadding ? 'min-h-full' : ''
              }`}
            >
              {children}
            </div>
          </div>
        </>
      )}
    </OverlayFrame>
  );
}

// ─── EmptyState ──────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = 'section',
  tone = 'primary',
  className = '',
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** One contextual next step. Omit it when the page toolbar already exposes the primary action. */
  action?: React.ReactNode;
  /**
   * section: standard collection/search empty state (the Automations baseline)
   * page: route-level unavailable/not-found state with a stable reading height
   * compact: drawers, dialogs, and dense cards
   */
  variant?: 'section' | 'page' | 'compact';
  tone?: 'primary' | 'neutral' | 'success' | 'danger';
  className?: string;
}) {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const IconComp = icon;
  const variants = {
    section: 'px-4 py-14 sm:py-16',
    page: 'min-h-[min(28rem,55dvh)] px-4 py-16',
    compact: 'px-3 py-8',
  } as const;
  const tones = {
    primary: 'bg-primary-subtle text-primary-fg',
    neutral: 'bg-surface-muted text-fg-muted',
    success: 'bg-success-subtle text-success',
    danger: 'bg-danger-subtle text-danger',
  } as const;
  const iconSizes = {
    section: 24,
    page: 26,
    compact: 20,
  } as const;
  const iconShell = variant === 'compact' ? 'h-10 w-10 rounded-xl' : 'h-12 w-12 rounded-2xl';

  return (
    <section
      data-empty-state={variant}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      className={`flex w-full flex-col items-center justify-center text-center ${variants[variant]} ${className}`}
    >
      <div className={`mb-3 flex items-center justify-center ${iconShell} ${tones[tone]}`} aria-hidden="true">
        <IconComp size={iconSizes[variant]} strokeWidth={1.75} />
      </div>
      <h3 id={titleId} className={`${variant === 'compact' ? 'text-sm' : 'text-base'} font-semibold text-fg-secondary`}>
        {title}
      </h3>
      {description && (
        <p id={descriptionId} className="mt-1 max-w-md text-sm leading-5 text-fg-muted">
          {description}
        </p>
      )}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </section>
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
      className={`${inline ? 'w-auto' : 'w-full'} bg-surface-raised border border-edge-strong rounded-lg text-fg shadow-sm shadow-primary-900/5 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 ${sizes[size]} ${className}`}
      {...props}
    />
  );
}

// ─── Textarea ────────────────────────────────────────────

export function Textarea({ className = '', ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full bg-surface-raised border border-edge-strong rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-faint shadow-sm shadow-primary-900/5 focus:outline-none focus:ring-2 focus:ring-primary-500/30 focus:border-primary-500 resize-none ${className}`}
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
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  confirmVariant = 'default',
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <OverlayFrame
      open={open}
      onClose={onClose}
      variant="alert"
      ariaLabel={title}
      surfaceClassName="max-w-xs p-4 sm:p-5"
    >
      <div data-testid="confirm-dialog">
        <p className="text-sm text-fg-secondary mb-1 font-medium">{title}</p>
        {description && <p className="text-xs text-fg-muted mb-4">{description}</p>}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="confirm-dialog-cancel">
            {t('common.cancel')}
          </Button>
          <Button
            variant={confirmVariant === 'destructive' ? 'destructive' : 'default'}
            size="sm"
            onClick={onConfirm}
            data-testid="confirm-dialog-confirm"
          >
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </OverlayFrame>
  );
}

// ─── AppLogo ─────────────────────────────────────────────

// The product mark ships with the web bundle (apps/web/public/favicon.svg) and
// the product name follows PRODUCT_NAME at build time (vite.config.ts).
declare const __PRODUCT_NAME__: string | undefined;
export const PRODUCT_NAME: string =
  typeof __PRODUCT_NAME__ === 'string' && __PRODUCT_NAME__ ? __PRODUCT_NAME__ : 'Greenhouse';

export function AppLogo({
  size = 'md',
  showVersion = false,
  showAttribution = false,
  logoOnly = false,
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showVersion?: boolean;
  showAttribution?: boolean;
  logoOnly?: boolean;
}) {
  const t = useT();
  const sizeClasses = { sm: 'w-6 h-6', md: 'w-8 h-8', lg: 'w-10 h-10', xl: 'w-16 h-16' };
  const logoRounding = size === 'xl' ? 'rounded-2xl' : 'rounded-lg';
  // Workspace branding (Administration → Branding Studio) wins over the bundled mark.
  const productName = getRuntimeProductName();
  const logoSrc = getRuntimeLogo() ?? '/favicon.svg';
  if (logoOnly) {
    return <img src={logoSrc} alt={productName} className={`${sizeClasses[size]} ${logoRounding} object-contain`} />;
  }
  return (
    <div className="flex items-center gap-2">
      <img src={logoSrc} alt={productName} className={`${sizeClasses[size]} ${logoRounding} object-contain`} />
      <div className="flex flex-col">
        <span className="font-display font-bold text-fg text-sm leading-tight">{productName}</span>
        {showAttribution && (
          <span className="text-[9px] text-fg-faint leading-tight">{t('navigation.brandTagline')}</span>
        )}
        {showVersion && <span className="text-[9px] text-fg-faint font-mono leading-tight">v{APP_VERSION}</span>}
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
  ariaLabel?: string;
}

export function Drawer({ open, onClose, children, side = 'left', width, ariaLabel }: DrawerProps) {
  const t = useT();
  // Respect an initially-open drawer on the first render (including SSR/tests)
  // instead of waiting one effect tick and briefly exposing the page behind it.
  const [mounted, setMounted] = React.useState(open);
  const [visible, setVisible] = React.useState(open);

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

  useOverlayBehavior(open, onClose);

  if (!mounted) return null;
  const widthStyle = width
    ? typeof width === 'number'
      ? { width: `${width}px`, maxWidth: 'calc(100vw - 2rem)' }
      : { width, maxWidth: 'calc(100vw - 2rem)' }
    : undefined;
  return (
    <div className={`mobile-visual-viewport fixed inset-0 z-50 flex ${visible ? '' : 'pointer-events-none'}`}>
      {/* Dim only, no backdrop blur — drawers keep the page context readable */}
      <div
        className={`absolute inset-0 bg-black/30 dark:bg-black/55 ${visible ? 'animate-fade-in' : 'animate-toast-out'}`}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel ?? t('common.panel')}
        className={`relative bg-surface-raised h-full shadow-xl flex flex-col overflow-y-auto pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] ${
          !width ? 'w-72 max-w-[calc(100vw-2rem)]' : ''
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
  const translate = useT();
  const [toasts, setToasts] = React.useState<ToastItem[]>([]);
  React.useEffect(() => {
    toastSetState = setToasts;
    return () => {
      toastSetState = null;
    };
  }, []);

  if (toasts.length === 0) return null;

  const variantStyles: Record<string, string> = {
    success: 'bg-surface-raised border-success text-success-fg',
    error: 'bg-surface-raised border-danger text-danger-fg',
    info: 'bg-surface-raised border-info text-info-fg',
    warning: 'bg-surface-raised border-warning text-warning-fg',
  };

  return (
    <div className="fixed top-[max(1rem,env(safe-area-inset-top))] left-4 right-4 sm:left-auto sm:right-4 z-[100] flex flex-col gap-2 pointer-events-none sm:max-w-[calc(100vw-2rem)]">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`pointer-events-auto px-4 py-2.5 rounded-lg border shadow-lg text-sm font-medium flex items-center gap-3 ${
            variantStyles[t.variant]
          } ${t.exiting ? 'animate-toast-out' : 'animate-toast-in'}`}
        >
          <span className="min-w-0 break-words">{t.message}</span>
          {t.onUndo && (
            <button
              onClick={() => {
                t.onUndo!();
                dismissToast(t.id);
              }}
              className="text-xs font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity flex-shrink-0"
            >
              {translate('common.undo')}
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
    <div className="bg-surface-card border border-edge rounded-lg p-4 space-y-3">
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
        <DefaultErrorFallback
          error={this.state.error}
          onRetry={() => this.setState({ hasError: false, error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function DefaultErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const t = useT();
  return (
    <EmptyState
      icon={AlertTriangle}
      variant="page"
      tone="danger"
      title={t('common.somethingWentWrong')}
      description={error?.message}
      action={
        <Button size="sm" onClick={onRetry}>
          {t('common.tryAgain')}
        </Button>
      }
    />
  );
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

// ─── FilterPills ─────────────────────────────────────────

export interface FilterPillItem {
  key: string;
  label: string;
  /** Optional count badge shown after the label. */
  count?: number;
  /** Optional colour: drives a leading dot + a tinted active/hover state. */
  color?: string;
}

interface FilterPillsProps {
  items: FilterPillItem[];
  /** The selected key, or null for the leading "all" pill / no selection. */
  activeKey: string | null;
  onChange: (key: string | null) => void;
  /**
   * `pill` (default) = optional, toggleable filters — round, floating, no track.
   * `segment` = a mutually-exclusive switch where something is always chosen:
   * squarer corners inside a shared track, so it doesn't read as another row of
   * tag pills. Pick by semantics, not by looks: a scope/status switch is a
   * segment, a tag filter is a pill.
   */
  variant?: 'pill' | 'segment';
  /** Render a leading pill (mapping to `null`) with this label — a clear/all option. */
  allLabel?: string;
  /** Clicking the already-active item clears the selection to null. */
  toggle?: boolean;
  /** Keep every pill visible and wrap onto additional lines instead of scrolling. */
  wrap?: boolean;
  /** Stretch the track and distribute every option evenly across its width. */
  fill?: boolean;
  /** In a named app-sidebar container, replace pills with a select below 220px. */
  collapseInSidebar?: boolean;
  selectLabel?: string;
  className?: string;
}

/**
 * Horizontal, scrollable pill bar — a shared surface for tag filters (Chat) and
 * scope tabs (Knowledge). Colourless pills use the primary-subtle active style;
 * a per-item `color` switches to a tinted style with a leading dot.
 */
export function FilterPills({
  items,
  activeKey,
  onChange,
  variant = 'pill',
  allLabel,
  toggle = false,
  wrap = false,
  fill = false,
  collapseInSidebar = false,
  selectLabel = 'Filter',
  className = '',
}: FilterPillsProps) {
  const isSegment = variant === 'segment';
  const base = `${fill ? 'min-w-0 flex-1 justify-center' : 'flex-shrink-0'} inline-flex items-center gap-1 text-[11px] border transition-colors whitespace-nowrap ${
    isSegment ? 'rounded px-2 py-[3px]' : 'rounded-full px-2 py-0.5'
  }`;
  // A segment's unselected items sit flat on the track — borders on every one
  // would turn the group into a grid of boxes.
  const inactive = isSegment
    ? 'border-transparent text-fg-muted hover:bg-surface-muted hover:text-fg-secondary'
    : 'text-fg-muted border-edge hover:border-edge-strong hover:text-fg-secondary';
  const activeSurface = isSegment
    ? 'bg-surface-raised text-primary-fg-strong border-edge font-medium shadow-sm'
    : 'bg-primary-subtle text-primary-fg-strong border-primary-edge font-medium';

  const renderPill = (key: string | null, label: string, count?: number, color?: string) => {
    const isActive = activeKey === key;
    const onClick = () => {
      if (key === null) return onChange(null);
      onChange(toggle && isActive ? null : key);
    };
    const badge = count !== undefined ? <span className="text-[10px] tabular-nums opacity-70">{count}</span> : null;

    if (color) {
      return (
        <button
          key={key ?? '__all__'}
          onClick={onClick}
          aria-pressed={isActive}
          className={base}
          style={
            isActive
              ? { backgroundColor: `${color}20`, color, borderColor: `${color}60` }
              : { backgroundColor: 'transparent', color: undefined, borderColor: 'transparent' }
          }
          onMouseEnter={(e) => {
            if (!isActive) {
              (e.currentTarget as HTMLElement).style.borderColor = `${color}40`;
              (e.currentTarget as HTMLElement).style.color = color;
            }
          }}
          onMouseLeave={(e) => {
            if (!isActive) {
              (e.currentTarget as HTMLElement).style.borderColor = 'transparent';
              (e.currentTarget as HTMLElement).style.color = '';
            }
          }}
        >
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: color }} />
          {label}
          {badge}
        </button>
      );
    }
    return (
      <button
        key={key ?? '__all__'}
        onClick={onClick}
        aria-pressed={isActive}
        className={`${base} ${isActive ? activeSurface : inactive}`}
      >
        {label}
        {badge}
      </button>
    );
  };

  const selectValue = activeKey ?? '__all__';
  return (
    <>
      <div
        className={`flex items-center gap-1 ${
          isSegment ? 'gap-0.5 rounded-md border border-edge bg-surface-sunken p-0.5' : ''
        } ${wrap ? 'flex-wrap overflow-visible' : 'overflow-x-auto scrollbar-hide'} ${
          collapseInSidebar ? 'sidebar-filter-pills' : ''
        } ${fill ? 'w-full' : ''} ${className}`}
      >
        {allLabel !== undefined && renderPill(null, allLabel)}
        {items.map((it) => renderPill(it.key, it.label, it.count, it.color))}
      </div>
      {collapseInSidebar && (
        <Select
          size="sm"
          value={selectValue}
          aria-label={selectLabel}
          className="sidebar-filter-select"
          onChange={(event) => onChange(event.target.value === '__all__' ? null : event.target.value)}
        >
          {allLabel !== undefined && <option value="__all__">{allLabel}</option>}
          {items.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
              {item.count === undefined ? '' : ` (${item.count})`}
            </option>
          ))}
        </Select>
      )}
    </>
  );
}

// ─── Toggle ──────────────────────────────────────────────

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  size?: 'sm' | 'md';
  disabled?: boolean;
  className?: string;
  label?: string;
}

export function Toggle({ checked, onChange, size = 'md', disabled = false, className = '', label }: ToggleProps) {
  const trackSize = size === 'sm' ? 'h-5 w-9' : 'h-6 w-11';
  const thumbSize = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4 w-4';
  const thumbTranslate = size === 'sm' ? 'translate-x-4' : 'translate-x-6';
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
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
  const t = useT();
  const width = type === 'datetime-local' ? 'w-[180px]' : 'w-[130px]';
  const inputSize = size === 'sm' ? ('xs' as const) : ('sm' as const);
  return (
    <div className={`flex items-center gap-1.5 ${className}`}>
      <span className="text-[10px] text-fg-faint flex-shrink-0">{t('common.from')}</span>
      <Input
        type={type}
        size={inputSize}
        value={from}
        onChange={(e) => onChange(e.target.value, to)}
        className={width}
      />
      <span className="text-[10px] text-fg-faint flex-shrink-0">{t('common.to')}</span>
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
