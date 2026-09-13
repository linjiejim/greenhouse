/**
 * DataTableBlock — sortable, filterable data table rendered from custom code fence.
 *
 * Features:
 * - Click column headers to sort (asc → desc → none)
 * - Search box for full-text filtering
 * - Column type-aware formatting (number, currency, percent, boolean, badge)
 */

import React, { useState, useMemo } from 'react';
import { Button, SearchInput, Skeleton, Tag } from '../ui';
import type { DataTableData } from './index';
import { useT } from '../../lib/i18n';
import { BADGE_PALETTE } from '../../lib/utils';
import type { TagTone } from '../../lib/utils';
import { ArrowDown, ArrowUp, ArrowUpDown, Download } from '../../lib/icons';
import { RichBlockShell } from './rich-block-shell';
import { downloadCsv, safeCsvFilename, serializeCsv } from '../../lib/csv-export';

// ─── Colors for badges ──────────────────────────────────
// Deterministically map each distinct value to a color from the shared
// BADGE_PALETTE (single source of truth — see lib/utils.ts).

function getBadgeTone(value: string): TagTone {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return BADGE_PALETTE[Math.abs(hash) % BADGE_PALETTE.length];
}

// ─── Cell Formatting ─────────────────────────────────────

function formatCell(
  value: unknown,
  type: string | undefined,
  booleanLabels: { yes: string; no: string },
): React.ReactNode {
  if (value == null) return <span className="text-fg-faint">—</span>;

  switch (type) {
    case 'number':
      return typeof value === 'number' ? value.toLocaleString() : String(value);

    case 'currency':
      return typeof value === 'number'
        ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
        : String(value);

    case 'percent': {
      const num = typeof value === 'number' ? value : parseFloat(String(value));
      if (isNaN(num)) return String(value);
      const pct = (num * 100).toFixed(1);
      const isPositive = num > 0;
      const isNegative = num < 0;
      return (
        <span className={isPositive ? 'text-success' : isNegative ? 'text-danger' : 'text-fg-secondary'}>
          {isPositive ? '+' : ''}
          {pct}%
        </span>
      );
    }

    case 'boolean':
      return value ? (
        <span className="text-success font-medium">{booleanLabels.yes}</span>
      ) : (
        <span className="text-fg-faint">{booleanLabels.no}</span>
      );

    case 'badge': {
      const str = String(value);
      return (
        <Tag tone={getBadgeTone(str)} size="sm" truncate>
          {str}
        </Tag>
      );
    }

    default:
      return String(value);
  }
}

// ─── Sort helpers ────────────────────────────────────────

type SortDir = 'asc' | 'desc' | null;

function getSortValue(value: unknown, type?: string): number | string {
  if (value == null) return '';
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
      return typeof value === 'number' ? value : parseFloat(String(value)) || 0;
    case 'boolean':
      return value ? 1 : 0;
    default:
      return String(value).toLowerCase();
  }
}

// ─── Component ───────────────────────────────────────────

export function DataTableBlock({ data, compact = false }: { data: DataTableData; compact?: boolean }) {
  const t = useT();
  const booleanLabels = { yes: t('common.yes'), no: t('common.no') };
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [search, setSearch] = useState('');

  const handleSort = (key: string) => {
    if (sortKey === key) {
      // Cycle: asc → desc → none
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') {
        setSortKey(null);
        setSortDir(null);
      }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const filteredRows = useMemo(() => {
    let rows = data.rows;

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((row) =>
        data.columns.some((col) => {
          const val = row[col.key];
          return val != null && String(val).toLowerCase().includes(q);
        }),
      );
    }

    // Sort
    if (sortKey && sortDir) {
      const col = data.columns.find((c) => c.key === sortKey);
      rows = [...rows].sort((a, b) => {
        const va = getSortValue(a[sortKey], col?.type);
        const vb = getSortValue(b[sortKey], col?.type);
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [data.rows, data.columns, search, sortKey, sortDir]);

  const sortIndicator = (key: string) => {
    if (sortKey !== key) return <ArrowUpDown size={12} className="ml-1 inline text-fg-faint" aria-hidden="true" />;
    const SortIcon = sortDir === 'asc' ? ArrowUp : ArrowDown;
    return <SortIcon size={12} className="ml-1 inline text-primary-600" aria-hidden="true" />;
  };

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 items-baseline gap-2">
        {data.title && <span className="truncate text-xs font-semibold text-fg">{data.title}</span>}
        <span className="whitespace-nowrap text-[10px] text-fg-faint">
          {t('common.rows', { rows: filteredRows.length })}
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="px-2"
          onClick={() =>
            downloadCsv(
              safeCsvFilename(data.title),
              serializeCsv(
                data.columns.map((column) => ({ key: column.key, label: column.label })),
                filteredRows,
              ),
            )
          }
        >
          <Download size={13} className="mr-1" aria-hidden="true" />
          {t('common.exportCsv')}
        </Button>
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={t('common.search')}
          size="sm"
          className={compact ? 'w-28' : 'w-32'}
        />
      </div>
    </div>
  );

  return (
    <RichBlockShell compact={compact} header={header}>
      {/* Table */}
      <div className="overflow-x-auto">
        <table className={`w-full ${compact ? 'text-xs' : 'text-[13px]'}`}>
          <thead>
            <tr className="bg-surface-muted">
              {data.columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className={`cursor-pointer select-none whitespace-nowrap text-left font-semibold text-fg transition-colors hover:bg-surface-sunken ${
                    compact ? 'px-2.5 py-1.5' : 'px-3 py-2'
                  }`}
                >
                  {col.label}
                  {sortIndicator(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {filteredRows.map((row, i) => (
              <tr key={i} className="transition-colors hover:bg-surface-sunken">
                {data.columns.map((col) => (
                  <td
                    key={col.key}
                    className={`whitespace-nowrap text-fg-secondary ${compact ? 'px-2.5 py-1.5' : 'px-3 py-2'}`}
                  >
                    {formatCell(row[col.key], col.type, booleanLabels)}
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td
                  colSpan={data.columns.length}
                  className={`${compact ? 'px-3 py-4' : 'px-3 py-6'} text-center text-fg-faint`}
                >
                  {search ? t('common.noMatchingRows') : t('common.noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </RichBlockShell>
  );
}

/** Stable placeholder used while a streaming datatable fence is still open. */
export function DataTablePendingBlock({ compact = false }: { compact?: boolean }) {
  const t = useT();

  return (
    <RichBlockShell
      compact={compact}
      header={
        <div className="flex items-center justify-between gap-3" aria-label={t('common.loading')}>
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-7 w-24" />
        </div>
      }
    >
      <div className={compact ? 'p-2.5' : 'p-3'}>
        <div className="grid grid-cols-3 gap-3 border-b border-edge pb-2">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 w-14" />
        </div>
        {Array.from({ length: compact ? 3 : 4 }).map((_, index) => (
          <div key={index} className="grid grid-cols-3 gap-3 border-b border-edge py-2 last:border-b-0">
            <Skeleton className="h-3 w-24 max-w-full" />
            <Skeleton className="h-3 w-20 max-w-full" />
            <Skeleton className="h-3 w-16 max-w-full" />
          </div>
        ))}
      </div>
    </RichBlockShell>
  );
}
