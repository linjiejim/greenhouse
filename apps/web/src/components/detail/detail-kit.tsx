/**
 * Detail kit — shared primitives for record detail (view) and edit screens.
 *
 * One visual language for every detail page, whether it renders as a full-page
 * view or inside a Drawer (dashboard CrudDetail):
 *
 * - <DetailHeader>  — icon/avatar + title + meta (id/timestamps) + status badges
 *                     + right-aligned actions, with optional Back link.
 * - <DetailSection> — FLAT titled block (border-b heading, no card-on-card),
 *                     per the "扁平内容布局" convention. Only real data containers
 *                     get a single <Card>.
 * - <FieldGrid>     — responsive grid of fields (label above value).
 * - <Field>         — one labelled field; renders "—" for empty (or hides it
 *                     with `hideEmpty`).
 *
 * Edit forms reuse <FieldGrid>/<Field> for layout parity with the view; keep the
 * form header Cancel-left / Save-right.
 */

import React from 'react';
import { ArrowLeft } from '../../lib/icons';

// ─── DetailHeader ────────────────────────────────────────

export interface DetailHeaderProps {
  /** Pre-rendered icon or avatar box (left of the title). */
  icon?: React.ReactNode;
  /** Small text/element rendered inline before the title (e.g. a record number). */
  titlePrefix?: React.ReactNode;
  title: React.ReactNode;
  /** Inline element after the title (e.g. an edit pencil button). */
  titleSuffix?: React.ReactNode;
  /** Small muted line under the title — id, created/updated timestamps. */
  meta?: React.ReactNode;
  /** Inline detail row under the meta (domain, location, status badges…). */
  subtitle?: React.ReactNode;
  /** Tag cloud — allowed to wrap (this is a display area, not a table cell). */
  badges?: React.ReactNode;
  /** Right-aligned action buttons (Edit / Refresh / Close…). */
  actions?: React.ReactNode;
  /** Renders a Back link above the header when provided. */
  onBack?: () => void;
  backLabel?: string;
  className?: string;
}

export function DetailHeader({
  icon,
  titlePrefix,
  title,
  titleSuffix,
  meta,
  subtitle,
  badges,
  actions,
  onBack,
  backLabel = 'Back',
  className = '',
}: DetailHeaderProps) {
  return (
    <div className={className}>
      {onBack && (
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg-secondary transition-colors mb-4"
        >
          <ArrowLeft size={12} />
          <span>{backLabel}</span>
        </button>
      )}
      <div className="flex items-start gap-4">
        {icon}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {titlePrefix}
            {typeof title === 'string' ? <h1 className="text-xl font-bold text-fg truncate">{title}</h1> : title}
            {titleSuffix}
          </div>
          {meta && <div className="flex items-center gap-3 mt-1 text-[10px] text-fg-faint">{meta}</div>}
          {subtitle && <div className="flex items-center gap-3 mt-1 flex-wrap">{subtitle}</div>}
          {badges && <div className="flex items-center gap-1 mt-2 flex-wrap">{badges}</div>}
        </div>
        {actions && <div className="flex items-center gap-2 flex-shrink-0 ml-3">{actions}</div>}
      </div>
    </div>
  );
}

// ─── DetailSection ───────────────────────────────────────

export interface DetailSectionProps {
  /** Section title — string renders the standard heading; node renders verbatim. */
  title?: React.ReactNode;
  /** Right-aligned action (e.g. an "Add" button). */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}

export function DetailSection({ title, action, children, className = '' }: DetailSectionProps) {
  return (
    <section className={`space-y-3 ${className}`}>
      {(title || action) && (
        <div className="flex items-center justify-between border-b border-edge pb-1.5">
          {typeof title === 'string' ? <h2 className="text-sm font-semibold text-fg">{title}</h2> : title}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

// ─── FieldGrid + Field ───────────────────────────────────

export interface FieldGridProps {
  /** Columns at the widest breakpoint (1–4). Default 2. */
  cols?: 1 | 2 | 3 | 4;
  children: React.ReactNode;
  className?: string;
}

const GRID_COLS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4',
};

export function FieldGrid({ cols = 2, children, className = '' }: FieldGridProps) {
  return <div className={`grid ${GRID_COLS[cols]} gap-x-6 gap-y-3 ${className}`}>{children}</div>;
}

export interface FieldProps {
  label: React.ReactNode;
  /** Value to display. Ignored when `children` is provided. */
  value?: React.ReactNode;
  children?: React.ReactNode;
  /** Skip rendering entirely when the value is empty (null/undefined/''). */
  hideEmpty?: boolean;
  /** Column span — 'full' stretches across the grid. */
  span?: 1 | 2 | 'full';
  className?: string;
}

function isEmpty(v: React.ReactNode): boolean {
  return v === null || v === undefined || v === '';
}

export function Field({ label, value, children, hideEmpty = false, span, className = '' }: FieldProps) {
  const empty = children === undefined && isEmpty(value);
  if (hideEmpty && empty) return null;

  const spanClass = span === 'full' ? 'col-span-full' : span === 2 ? 'sm:col-span-2' : '';
  const content = children ?? (empty ? <span className="text-fg-faint">—</span> : value);

  return (
    <div className={`${spanClass} ${className}`}>
      <div className="text-[11px] font-medium text-fg-faint mb-1">{label}</div>
      <div className="text-sm text-fg-secondary break-words">{content}</div>
    </div>
  );
}
