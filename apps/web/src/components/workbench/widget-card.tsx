/**
 * One workbench card: shell, per-kind body, and the three ways a card can fail.
 *
 * Rendering rule inherited from the rich-output blocks: validation happens
 * before render and a bad shape degrades to a placeholder. A card whose data
 * arrived in an unexpected form must not throw — that unmounts the whole page,
 * which is exactly the accident this codebase already had once with chat
 * messages.
 */

import { useMemo } from 'react';
import {
  isDataWidget,
  isNavWidget,
  isTextWidget,
  readPath,
  type WidgetColumn,
  type WorkbenchNavResolution,
  type WorkbenchQueryFailure,
  type WorkbenchWidget,
} from '@greenhouse/types/workbench';
import type { ChartData, DataTableColumn } from '@greenhouse/types/rich-output';
import { ChartBlock } from '../blocks/chart-block';
import { DataTableBlock } from '../blocks/datatable-block';
import { Markdown } from '../markdown';
import { Spinner, IconButton } from '../ui';
import { WIDGET_DRAG_HANDLE_CLASS } from './widget-grid';
import { AlertTriangle, GripVertical, Lock, Pencil, RefreshCw, Trash2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { resolveNavTarget } from '../../lib/workbench/nav-targets';
import type { PlatformApplication } from '../../platform/catalog';

export interface WidgetState {
  loading?: boolean;
  data?: unknown;
  nav?: WorkbenchNavResolution;
  error?: WorkbenchQueryFailure;
}

interface WidgetCardProps {
  widget: WorkbenchWidget;
  state: WidgetState;
  applications: readonly PlatformApplication[];
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
  onRefresh: () => void;
}

function rowsFrom(data: unknown, path: string | undefined): Record<string, unknown>[] {
  const value = path ? readPath(data, path) : data;
  if (!Array.isArray(value)) return [];
  return value.filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null);
}

function formatKpi(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(value);
  }
  // Aggregates arrive as numeric strings from raw SQL often enough to be worth handling.
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return formatKpi(Number(value));
  }
  return null;
}

/** Column labels default to a humanized field name when the recipe omits one. */
function humanize(key: string): string {
  const tail = key.split('.').pop() ?? key;
  return tail.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export function WidgetCard({ widget, state, applications, editing, onEdit, onRemove, onRefresh }: WidgetCardProps) {
  const t = useT();

  const body = useMemo(() => {
    if (isTextWidget(widget)) {
      return (
        <div className="h-full overflow-y-auto">
          <Markdown content={widget.markdown} compact />
        </div>
      );
    }

    if (isNavWidget(widget)) {
      const { href, icon: Icon } = resolveNavTarget(widget.target, applications);
      const unavailable = href === null || state.nav?.exists === false || state.nav?.allowed === false;
      if (unavailable) {
        return (
          <PlaceholderBody
            icon={state.nav?.allowed === false ? Lock : AlertTriangle}
            text={state.nav?.allowed === false ? t('home.card.noAccess') : t('home.card.targetGone')}
          />
        );
      }
      return (
        <a
          href={href}
          className="flex h-full items-center gap-3 rounded-md px-1 text-left transition-colors hover:bg-surface-muted"
        >
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-muted text-fg-secondary">
            <Icon size={18} />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-fg" title={state.nav?.title ?? widget.title}>
              {state.nav?.title ?? widget.title}
            </span>
            <span className="block text-xs text-fg-faint">{t('home.card.openTarget')}</span>
          </span>
        </a>
      );
    }

    if (!isDataWidget(widget)) return null;

    if (state.loading && state.data === undefined) {
      return (
        <div className="flex h-full items-center justify-center">
          <Spinner className="h-5 w-5 text-fg-faint" />
        </div>
      );
    }

    if (state.error) {
      const isForbidden = state.error === 'forbidden';
      return (
        <PlaceholderBody
          icon={isForbidden ? Lock : AlertTriangle}
          text={
            isForbidden
              ? t('home.card.noAccess')
              : state.error === 'not_found'
                ? t('home.card.targetGone')
                : state.error === 'invalid'
                  ? t('home.card.invalidConfig')
                  : t('home.card.loadFailed')
          }
          action={
            isForbidden ? undefined : (
              <button type="button" onClick={onRefresh} className="text-xs text-primary-600 hover:underline">
                {t('common.retry')}
              </button>
            )
          }
        />
      );
    }

    if (state.data === undefined) return null;

    if (widget.display === 'kpi') {
      const formatted = formatKpi(readPath(state.data, widget.map?.value));
      if (formatted === null) return <PlaceholderBody icon={AlertTriangle} text={t('home.card.shapeMismatch')} />;
      return (
        <div className="flex h-full flex-col justify-end">
          {/* KPI is rendered inline rather than via the Dashboard's StatCard:
              that component draws its own bordered card, which would nest a
              card inside this one and break the flat-surface rule. */}
          <div className="text-3xl font-semibold leading-none text-fg">{formatted}</div>
        </div>
      );
    }

    const rows = rowsFrom(state.data, widget.map?.rows);
    if (rows.length === 0) {
      return <PlaceholderBody icon={AlertTriangle} text={t('home.card.noRows')} />;
    }

    if (widget.display === 'chart') {
      const labelKey = widget.map?.x;
      const seriesKeys = widget.map?.y ?? [];
      if (!labelKey || seriesKeys.length === 0) {
        return <PlaceholderBody icon={AlertTriangle} text={t('home.card.invalidConfig')} />;
      }
      const chart: ChartData = {
        type: widget.chartType ?? 'bar',
        labels: rows.map((row) => String(readPath(row, labelKey) ?? '')),
        datasets: seriesKeys.map((key) => ({
          label: humanize(key),
          data: rows.map((row) => Number(readPath(row, key) ?? 0)),
        })),
      };
      return (
        <div className="h-full">
          <ChartBlock data={chart} compact fill />
        </div>
      );
    }

    // table / list — both render through the shared data table; a list is just
    // a table the recipe gave fewer columns.
    const declared: WidgetColumn[] =
      widget.map?.columns ??
      Object.keys(rows[0])
        .slice(0, 6)
        .map((key) => ({ key }));
    // DataTableBlock looks columns up flatly (`row[key]`), so a dot path like
    // `values.12` — how Tables records address their fields — has to be
    // resolved here. Projecting first also means the block's own sorting and
    // search operate on the values the user actually sees.
    const columns: DataTableColumn[] = declared.map((column, index) => ({
      key: `c${index}`,
      label: column.label ?? humanize(column.key),
      ...(column.type ? { type: column.type } : {}),
    }));
    const projected = rows.map((row) =>
      Object.fromEntries(declared.map((column, index) => [`c${index}`, readPath(row, column.key)])),
    );
    return (
      <div className="h-full overflow-auto">
        <DataTableBlock data={{ columns, rows: projected }} compact />
      </div>
    );
  }, [applications, onRefresh, state, t, widget]);

  return (
    <div className="group flex h-full flex-col rounded-lg border border-edge bg-surface-card">
      <div
        className={`flex flex-shrink-0 items-center gap-1.5 border-b border-edge px-3 py-1 ${
          editing ? `${WIDGET_DRAG_HANDLE_CLASS} cursor-move` : ''
        }`}
      >
        {editing && <GripVertical size={12} className="flex-shrink-0 text-fg-faint" />}
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg-secondary" title={widget.title}>
          {widget.title}
        </span>
        {state.loading && state.data !== undefined && <Spinner className="h-3 w-3 text-fg-faint" />}
        {editing ? (
          <>
            <IconButton label={t('common.edit')} onClick={onEdit} tooltipMode="portal" size="compact">
              <Pencil size={12} />
            </IconButton>
            <IconButton label={t('common.remove')} onClick={onRemove} tooltipMode="portal" size="compact">
              <Trash2 size={12} />
            </IconButton>
          </>
        ) : (
          isDataWidget(widget) && (
            <span className="opacity-0 transition-opacity group-hover:opacity-100 touch-visible">
              <IconButton label={t('common.refresh')} onClick={onRefresh} tooltipMode="portal" size="compact">
                <RefreshCw size={12} />
              </IconButton>
            </span>
          )
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden rounded-b-lg px-3 py-2.5">{body}</div>
    </div>
  );
}

function PlaceholderBody({
  icon: Icon,
  text,
  action,
}: {
  icon: typeof AlertTriangle;
  text: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
      <Icon size={16} className="text-fg-faint" />
      <span className="text-xs text-fg-faint">{text}</span>
      {action}
    </div>
  );
}
